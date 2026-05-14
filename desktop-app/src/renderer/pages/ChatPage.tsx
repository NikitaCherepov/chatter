import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import { useAuth } from '../lib/auth';
import * as api from '../lib/api';
import { generateDocxBlob, generateChatDocxBlob } from '../lib/markdownToDocx';
import { LinkTelegramModal } from '../components/LinkTelegramModal';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { AttachModal } from '../components/AttachModal';
import type { ImageItem } from '../components/AttachModal';
import { SettingsModal } from '../components/SettingsModal';
import { PixelAvatar, dispatchAvatarState, startAvatarLoop, stopAvatarLoop, getAvatarManifest } from '../components/PixelAvatar';
import type { SetDisplayStatePayload } from '../components/PixelAvatar';
import { ToolsPanel } from '../components/ToolsPanel';
import { openTool, handleDesktopAction } from '../lib/tools';
import s from './ChatPage.module.scss';

const ALLOWED_FORMATS: string[] = (() => {
  const raw = import.meta.env.VITE_ALLOWED_IMAGE_FORMATS || '';
  if (!raw.trim()) {
    return ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  }
  return raw.split(',').map((f: string) => f.trim()).filter(Boolean);
})();

const MAX_IMAGES_FREE = 0;
const MAX_IMAGES_STANDART = 5;
const MAX_IMAGES_PRO = 10;
const MAX_IMAGES_ADMIN = 20;

function getMaxImagesForPlan(plan: string, isAdmin: number): number {
  if (isAdmin === 1) return MAX_IMAGES_ADMIN;
  switch (plan) {
    case 'pro': return MAX_IMAGES_PRO;
    case 'standart': return MAX_IMAGES_STANDART;
    default: return MAX_IMAGES_FREE;
  }
}

export function ChatPage() {
  const { user, setUser, logout } = useAuth();
  const navigate = useNavigate();

  const [chats, setChats] = useState<api.ChatInfo[]>([]);
  const [activeChatId, setActiveChatId] = useState<number | null>(null);
  const [messages, setMessages] = useState<api.Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [isLinked, setIsLinked] = useState(false);
  const [showAttachModal, setShowAttachModal] = useState(false);
  const [attachedImages, setAttachedImages] = useState<ImageItem[]>([]);
  const [contextMenuChatId, setContextMenuChatId] = useState<number | null>(null);
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [msgMenuId, setMsgMenuId] = useState<number | null>(null);
  const [msgMenuPos, setMsgMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const msgMenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [renamingChatId, setRenamingChatId] = useState<number | null>(null);
  const [renamingTitle, setRenamingTitle] = useState('');
  const [deletingChatId, setDeletingChatId] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<api.ChatSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [viewerImageSrc, setViewerImageSrc] = useState<string | null>(null);

  const maxImages = user ? getMaxImagesForPlan(user.plan, user.is_admin) : 0;

  const checkLinkStatus = async () => {
    try {
      const status = await api.getLinkStatus();
      setIsLinked(status.linked);
    } catch {}
  };

  const loadChats = async () => {
    try {
      const res = await api.getChats();
      setChats(res.chats);
      if (res.active_chat_id) {
        setActiveChatId(res.active_chat_id);
      } else if (res.chats.length > 0) {
        selectChat(res.chats[0].id);
      }
    } catch (err) {
      console.error('Failed to load chats:', err);
    }
  };

  useEffect(() => { loadChats(); checkLinkStatus(); }, []);

  useEffect(() => {
    if (activeChatId) {
      prevMsgCountRef.current = 0;
      loadMessages(activeChatId);
    }
  }, [activeChatId]);

  const loadMessages = async (chatId: number) => {
    setLoadingMessages(true);
    try {
      const res = await api.getMessages(chatId, 100);
      setMessages(res.messages);
    } catch (err) {
      console.error('Failed to load messages:', err);
    } finally {
      setLoadingMessages(false);
    }
  };

  const selectChat = async (chatId: number) => {
    setActiveChatId(chatId);
    try { await api.activateChat(chatId); } catch {}
  };

  const handleCreateChat = async () => {
    try {
      const res = await api.createChat();
      await loadChats();
      selectChat(res.chat_id);
    } catch (err) {
      console.error('Failed to create chat:', err);
    }
  };

  const removeAttachedImage = useCallback((index: number) => {
    setAttachedImages((prev) => {
      const removed = prev[index];
      if (removed) URL.revokeObjectURL(removed.preview);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const clearAttachedImages = useCallback(() => {
    setAttachedImages((prev) => {
      prev.forEach((img) => URL.revokeObjectURL(img.preview));
      return [];
    });
  }, []);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    const hasImages = attachedImages.length > 0;
    if ((!text && !hasImages) || sending) return;
    setInput('');
    setSending(true);

    const imagesToSend = attachedImages.map((img) => ({
      base64: img.base64,
      mime_type: img.mime_type,
    }));

    // Clear attached images immediately
    setAttachedImages([]);

    const displayText = text || (hasImages ? '[Image]' : '');
    // Build temporary images for user message (preview URLs from attached files)
    const tempUserImages: api.MessageImage[] | undefined = hasImages
      ? attachedImages.map((img) => ({ url: img.preview, type: 'user_photo' as const }))
      : undefined;
    const tempUserMsg: api.Message = {
      id: -Date.now(), role: 'user', content: displayText, created_at: Math.floor(Date.now() / 1000),
      images: tempUserImages,
    };

    setMessages((prev) => [...prev, tempUserMsg]);

    // ID для временного сообщения ассистента — создаётся лениво при первом контенте
    let assistantMsgCreated = false;
    const tempAssistantId = -Date.now() - 1;

    const appendToAssistant = (text: string) => {
      if (!assistantMsgCreated) {
        assistantMsgCreated = true;
        setSending(false); // убираем три точки — заменяем на реальный баббл
        setMessages((prev) => [...prev, {
          id: tempAssistantId, role: 'assistant', content: text, created_at: Math.floor(Date.now() / 1000),
        }]);
      } else {
        setMessages((prev) => prev.map(m =>
          m.id === tempAssistantId
            ? { ...m, content: m.content + '\n\n' + text }
            : m
        ));
      }
    };

    await api.streamChatMessage(
      text || ' ',
      activeChatId ?? undefined,
      imagesToSend.length > 0 ? imagesToSend : undefined,
      getAvatarManifest(),
      {
        onIntermediate: (stepText) => {
          appendToAssistant(stepText);
        },
        onToolStatus: (statusText) => {
          appendToAssistant(`_${statusText}_`);
        },
        onDisplayState: (state) => {
          dispatchAvatarState(state);
        },
        onDesktopAction: (action) => {
          handleDesktopAction(action);
        },
        onDone: (res) => {
          // Build images array from generated_images
          const genImages: api.MessageImage[] | undefined = res.generated_images?.length
            ? res.generated_images.map(img => ({
                url: img.image_url
                  ? (img.image_url.startsWith('http') ? img.image_url : `${api.API_BASE}${img.image_url}`)
                  : `data:image/png;base64,${img.image_base64}`,
                type: 'generated' as const
              }))
            : undefined;

          if (assistantMsgCreated) {
            setMessages((prev) => prev.map(m =>
              m.id === tempAssistantId
                ? {
                    ...m,
                    id: res.message_id,
                    ...(res.reply_text ? { content: res.reply_text } : {}),
                    ...(genImages ? { images: genImages } : {})
                  }
                : m
            ));
          } else {
            // Ни одного промежуточного сообщения не было — добавляем финальный ответ
            setSending(false);
            setMessages((prev) => [...prev, {
              id: res.message_id, role: 'assistant', content: res.reply_text, created_at: Math.floor(Date.now() / 1000),
              images: genImages,
            }]);
          }
          if (res.display_state) dispatchAvatarState(res.display_state);
          if (!activeChatId || res.chat_id !== activeChatId) {
            setActiveChatId(res.chat_id);
            loadChats();
          }
        },
        onError: (err) => {
          console.error('Stream error:', err);
          if (assistantMsgCreated) {
            setMessages((prev) => prev.filter(m => m.id !== tempAssistantId && m.id !== tempUserMsg.id));
          } else {
            setMessages((prev) => prev.filter(m => m.id !== tempUserMsg.id));
          }
          setSending(false);
        }
      }
    );
  }, [input, sending, activeChatId, attachedImages]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  // Ctrl+V / paste handler for images
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.type.startsWith('image/')) continue;
      if (!ALLOWED_FORMATS.includes(item.type)) continue;

      const file = item.getAsFile();
      if (!file) continue;

      if (attachedImages.length >= maxImages) break;

      e.preventDefault();

      try {
        const base64Full = await fileToBase64(file);
        const base64 = base64Full.split(',')[1] || base64Full;
        const newItem: ImageItem = {
          file,
          preview: URL.createObjectURL(file),
          base64,
          mime_type: file.type,
        };
        setAttachedImages((prev) => [...prev, newItem]);
      } catch {
        console.error('Failed to read pasted image');
      }

      // Only handle first image from paste
      break;
    }
  }, [attachedImages.length, maxImages]);

  const handleAttachFromModal = useCallback((images: ImageItem[]) => {
    setAttachedImages((prev) => {
      const combined = [...prev, ...images];
      if (combined.length > maxImages) {
        // Trim to max
        const excess = combined.splice(maxImages);
        excess.forEach((img) => URL.revokeObjectURL(img.preview));
      }
      return combined;
    });
    setShowAttachModal(false);
  }, [maxImages]);

  const handleLogout = () => { logout(); navigate('/login', { replace: true }); };

  const closeMsgMenu = useCallback(() => {
    setMsgMenuId(null);
    if (msgMenuTimerRef.current) { clearTimeout(msgMenuTimerRef.current); msgMenuTimerRef.current = null; }
  }, []);

  // Close context menu on outside click
  useEffect(() => {
    const close = () => { setContextMenuChatId(null); closeMsgMenu(); };
    if (contextMenuChatId !== null || msgMenuId !== null) {
      document.addEventListener('click', close);
      return () => document.removeEventListener('click', close);
    }
  }, [contextMenuChatId, msgMenuId, closeMsgMenu]);

  const handleKebabClick = (e: React.MouseEvent, chatId: number) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setContextMenuPos({ x: rect.right, y: rect.bottom });
    setContextMenuChatId(chatId);
  };

  const handleStartRename = (chatId: number) => {
    const chat = chats.find(c => c.id === chatId);
    setRenamingChatId(chatId);
    setRenamingTitle(chat?.title || '');
    setContextMenuChatId(null);
  };

  const handleConfirmRename = async () => {
    const title = renamingTitle.trim();
    if (!title || !renamingChatId) return;
    try {
      await api.renameChat(renamingChatId, title);
      setChats(prev => prev.map(c => c.id === renamingChatId ? { ...c, title } : c));
    } catch (err) {
      console.error('Failed to rename chat:', err);
    }
    setRenamingChatId(null);
    setRenamingTitle('');
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); handleConfirmRename(); }
    if (e.key === 'Escape') { setRenamingChatId(null); setRenamingTitle(''); }
  };

  const handleStartDelete = (chatId: number) => {
    setDeletingChatId(chatId);
    setContextMenuChatId(null);
  };

  const handleConfirmDelete = async () => {
    if (!deletingChatId) return;
    try {
      await api.deleteChat(deletingChatId);
      if (activeChatId === deletingChatId) {
        setActiveChatId(null);
        setMessages([]);
      }
      setChats(prev => prev.filter(c => c.id !== deletingChatId));
    } catch (err) {
      console.error('Failed to delete chat:', err);
    }
    setDeletingChatId(null);
  };

  const handleExportChat = async (chatId: number) => {
    setContextMenuChatId(null);
    const chat = chats.find(c => c.id === chatId);
    const chatName = chat?.title || 'Чат';
    try {
      const res = await api.getMessages(chatId, 10000);
      if (res.messages.length === 0) {
        toast.error('Чат пуст');
        return;
      }
      const blob = await generateChatDocxBlob(res.messages, chatName);
      const buffer = await blob.arrayBuffer();
      const d = new Date();
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const safeName = chatName.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 60);
      const result = await window.electronAPI?.saveFile(`${safeName} ${dateStr}.docx`, buffer);
      if (result && !result.canceled) {
        toast.success('Чат сохранён');
      }
    } catch (err) {
      console.error('Failed to export chat:', err);
      toast.error('Не удалось экспортировать чат');
    }
  };

  const startMsgMenuTimer = useCallback(() => {
    if (msgMenuTimerRef.current) clearTimeout(msgMenuTimerRef.current);
    msgMenuTimerRef.current = setTimeout(() => setMsgMenuId(null), 1000);
  }, []);

  const resetMsgMenuTimer = useCallback(() => {
    if (msgMenuTimerRef.current) clearTimeout(msgMenuTimerRef.current);
  }, []);

  const handleMsgKebabClick = (e: React.MouseEvent, messageId: number) => {
    e.stopPropagation();
    if (msgMenuTimerRef.current) clearTimeout(msgMenuTimerRef.current);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMsgMenuPos({ x: rect.right + 4, y: rect.top });
    setMsgMenuId(messageId);
    msgMenuTimerRef.current = setTimeout(() => setMsgMenuId(null), 1000);
  };

  const handleDeleteMessage = async (messageId: number) => {
    if (!activeChatId) return;
    closeMsgMenu();
    const snapshot = [...messages];
    setMessages(prev => prev.filter(m => m.id !== messageId));
    try {
      await api.deleteMessage(activeChatId, messageId);
    } catch (err) {
      console.error('Failed to delete message:', err);
      setMessages(snapshot);
    }
  };

  const handleCopyMessage = (messageId: number) => {
    const msg = messages.find(m => m.id === messageId);
    if (!msg) return;
    navigator.clipboard.writeText(msg.content).then(
      () => toast.success('Скопировано'),
      () => toast.error('Не удалось скопировать'),
    );
    closeMsgMenu();
  };

  const handleDownloadDocx = async (messageId: number) => {
    const msg = messages.find(m => m.id === messageId);
    if (!msg) return;
    closeMsgMenu();
    try {
      const blob = await generateDocxBlob(msg.content);
      const buffer = await blob.arrayBuffer();
      const d = new Date();
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const result = await window.electronAPI?.saveFile(`message ${dateStr}.docx`, buffer);
      if (result && !result.canceled) {
        toast.success('Файл сохранён');
      }
    } catch (err) {
      console.error('Failed to export docx:', err);
      toast.error('Не удалось сохранить файл');
    }
  };

  const prevMsgCountRef = useRef(0);
  useEffect(() => {
    if (messages.length > prevMsgCountRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevMsgCountRef.current = messages.length;
  }, [messages]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px';
    }
  }, [input]);

  // ── PixelAvatar: system reactions + IPC bridge ────────────────────────────

  // Start looping "think" reaction while AI is generating, stop when response arrives
  useEffect(() => {
    if (sending) {
      startAvatarLoop('think');
    } else {
      stopAvatarLoop();
    }
  }, [sending]);

  // Listen for avatar state from Electron main process (IPC)
  useEffect(() => {
    const unsub = window.electronAPI?.onAvatarState?.((payload) => {
      dispatchAvatarState(payload as SetDisplayStatePayload);
    });
    return () => unsub?.();
  }, []);

  // Listen for external tool open requests (bot / IPC)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ toolId?: string }>).detail;
      openTool(detail?.toolId);
    };
    window.addEventListener('chatter:open-tool', handler);
    return () => window.removeEventListener('chatter:open-tool', handler);
  }, []);

  const formatTime = (ts: number) => {
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // ── Search ──────────────────────────────────────────────────────────────

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);

    if (value.trim().length < 3) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }

    setSearchLoading(true);
    searchDebounceRef.current = setTimeout(async () => {
      try {
        const res = await api.searchChats(value.trim());
        setSearchResults(res.results);
      } catch (err) {
        console.error('Search failed:', err);
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);
  }, []);

  const handleSearchClear = useCallback(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    setSearchQuery('');
    setSearchResults([]);
    setSearchLoading(false);
  }, []);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  const resolveImageUrl = (url: string) => url.startsWith('/') ? `${api.API_BASE}${url}` : url;

  const handleDownloadImage = async (src: string) => {
    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error('download failed');
      const blob = await response.blob();
      const buffer = await blob.arrayBuffer();
      const ext = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : blob.type.includes('gif') ? 'gif' : 'jpg';
      const d = new Date();
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const fileName = `image_${dateStr}.${ext}`;
      const result = await window.electronAPI?.saveFile(fileName, buffer);
      if (result && !result.canceled) {
        toast.success('Изображение сохранено');
      }
    } catch (err) {
      console.error('Failed to download image:', err);
      toast.error('Не удалось сохранить изображение');
    }
  };

  const renderSnippet = (snippet: string) => {
    const parts = snippet.split(/(<<|>>)/);
    const elements: React.ReactNode[] = [];
    let inHighlight = false;
    let key = 0;
    for (const part of parts) {
      if (part === '<<') { inHighlight = true; continue; }
      if (part === '>>') { inHighlight = false; continue; }
      if (inHighlight) {
        elements.push(<b key={key++} className={s.snippetHighlight}>{part}</b>);
      } else {
        elements.push(<span key={key++}>{part}</span>);
      }
    }
    return elements;
  };

  return (
    <div className={s.layout}>
      {/* SIDEBAR */}
      <motion.aside
        className={`${s.sidebar} ${sidebarCollapsed ? s.sidebarCollapsed : ''}`}
        animate={{ width: sidebarCollapsed ? 65 : 260 }}
        transition={{ duration: 0.2, ease: 'easeInOut' }}
      >
        <div className={s.sidebarHeader}>
          <button className={s.burgerBtn} onClick={() => setSidebarCollapsed(!sidebarCollapsed)} title={sidebarCollapsed ? 'Развернуть' : 'Свернуть'}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <motion.span
            className={s.sidebarTitle}
            animate={{ opacity: sidebarCollapsed ? 0 : 1 }}
            transition={{ duration: 0.15 }}
          >
            Чаты
          </motion.span>
          <motion.button
            className={s.newChatBtn}
            onClick={handleCreateChat}
            animate={{ opacity: sidebarCollapsed ? 0 : 1 }}
            transition={{ duration: 0.15 }}
            style={{ pointerEvents: sidebarCollapsed ? 'none' : 'auto' }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="7" y1="1" x2="7" y2="13" />
              <line x1="1" y1="7" x2="13" y2="7" />
            </svg>
          </motion.button>
        </div>

        {/* Search input */}
        <motion.div
          className={s.searchContainer}
          animate={{ opacity: sidebarCollapsed ? 0 : 1 }}
          transition={{ duration: 0.15 }}
          style={{ pointerEvents: sidebarCollapsed ? 'none' : 'auto' }}
        >
          <svg className={s.searchIcon} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            className={s.searchInput}
            type="text"
            placeholder="Поиск..."
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
          {searchQuery && (
            <button className={s.searchClearBtn} onClick={handleSearchClear}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </motion.div>

        <motion.div
          className={s.sidebarContentBody}
          animate={{ opacity: sidebarCollapsed ? 0 : 1 }}
          transition={{ duration: 0.15 }}
          style={{ pointerEvents: sidebarCollapsed ? 'none' : 'auto' }}
        >
          {searchQuery.trim().length >= 3 ? (
            <div className={s.chatList}>
              {searchLoading && (
                <div className={s.emptyChats}>Поиск...</div>
              )}
              {!searchLoading && searchResults.length === 0 && (
                <div className={s.emptyChats}>Ничего не найдено</div>
              )}
              {!searchLoading && searchResults.map((result) => (
                <div
                  key={result.chat_id}
                  className={`${s.chatItem} ${result.chat_id === activeChatId ? s.chatItemActive : ''}`}
                  onClick={() => {
                    selectChat(result.chat_id);
                    handleSearchClear();
                  }}
                >
                  <div className={s.chatItemRow}>
                    <div className={s.chatItemTitle}>{result.chat_title}</div>
                  </div>
                  <div className={s.searchSnippet}>{renderSnippet(result.snippet)}</div>
                </div>
              ))}
            </div>
          ) : (
          <div className={s.chatList}>
            {chats.map((chat) => (
              <div
                key={chat.id}
                className={`${s.chatItem} ${chat.id === activeChatId ? s.chatItemActive : ''}`}
                onClick={() => {
                  if (renamingChatId === chat.id) return;
                  selectChat(chat.id);
                }}
              >
                <div className={s.chatItemRow}>
                  {renamingChatId === chat.id ? (
                    <input
                      className={s.renameInput}
                      value={renamingTitle}
                      onChange={(e) => setRenamingTitle(e.target.value)}
                      onKeyDown={handleRenameKeyDown}
                      onBlur={handleConfirmRename}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <div className={s.chatItemTitle}>{chat.title || 'Новый чат'}</div>
                  )}
                  <button
                    className={s.kebabBtn}
                    onClick={(e) => handleKebabClick(e, chat.id)}
                    title="Действия"
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                      <circle cx="8" cy="3" r="1.5" />
                      <circle cx="8" cy="8" r="1.5" />
                      <circle cx="8" cy="13" r="1.5" />
                    </svg>
                  </button>
                </div>
                {renamingChatId !== chat.id && (
                  <div className={s.chatItemTime}>{formatTime(chat.created_at)}</div>
                )}
              </div>
            ))}
            {chats.length === 0 && (
              <div className={s.emptyChats}>Нет чатов</div>
            )}
          </div>
          )}
        </motion.div>

        {/* Context menu */}
        {contextMenuChatId !== null && !sidebarCollapsed && (
          <div
            className={s.contextMenu}
            style={{ top: contextMenuPos.y, left: contextMenuPos.x }}
            onClick={(e) => e.stopPropagation()}
          >
            <button className={s.contextMenuItem} onClick={() => handleStartRename(contextMenuChatId)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              Изменить название
            </button>
            <button className={s.contextMenuItem} onClick={() => handleExportChat(contextMenuChatId)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Скачать docx
            </button>
            <button className={`${s.contextMenuItem} ${s.contextMenuItemDanger}`} onClick={() => handleStartDelete(contextMenuChatId)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              Удалить
            </button>
          </div>
        )}

        <div className={s.sidebarFooter}>
          <div className={s.userInfo} style={{ cursor: 'pointer' }} onClick={() => setShowSettings(true)} title="Настройки">
            <div className={s.avatar}>
              {(user?.name || user?.username || 'U')[0].toUpperCase()}
            </div>
            <motion.span
              className={s.userName}
              animate={{ opacity: sidebarCollapsed ? 0 : 1 }}
              transition={{ duration: 0.15 }}
            >
              {user?.name || user?.username || 'User'}
            </motion.span>
          </div>
          <motion.div
            className={s.footerBtns}
            animate={{ opacity: sidebarCollapsed ? 0 : 1 }}
            transition={{ duration: 0.15 }}
            style={{ pointerEvents: sidebarCollapsed ? 'none' : 'auto' }}
          >
            {isLinked ? (
              <button className={s.iconBtn} onClick={async () => {
                try {
                  await api.unlinkTelegram();
                  setIsLinked(false);
                  const freshUser = await api.fetchMe();
                  setUser(freshUser);
                  localStorage.setItem('chatter_user', JSON.stringify(freshUser));
                } catch {}
              }} title="Отвязать Telegram">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6L6 18" />
                  <path d="M6 6l12 12" />
                </svg>
              </button>
            ) : (
              <button className={s.iconBtn} onClick={() => setShowLinkModal(true)} title="Привязать Telegram">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
              </button>
            )}
            <button className={s.iconBtn} onClick={handleLogout} title="Выйти">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
          </motion.div>
        </div>
      </motion.aside>

      {/* MAIN */}
      <main className={s.main}>
        {!activeChatId ? (
          <div className={s.emptyState}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon-placeholder)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <p className={s.emptyStateText}>Выберите чат или создайте новый</p>
          </div>
        ) : (
          <>
            <div className={s.messages}>
              {loadingMessages && (
                <div className={s.loadingRow}>Загрузка сообщений...</div>
              )}
              {messages.map((msg) => (
                <div key={msg.id} className={s.messageGroup}>
                  <div className={s.metaRow}>
                    {msg.role === 'user' ? 'You' : 'Chatter'} &bull; {formatTime(msg.created_at)}
                  </div>
                  <div className={s.bubbleWrap}>
                    <div className={msg.role === 'user' ? s.bubbleUser : s.bubble}>
                      {msg.images && msg.images.length > 0 && (
                        <div className={s.messageImages}>
                          {msg.images.map((img, i) => {
                            const src = resolveImageUrl(img.url);
                            return (
                              <div key={i} className={s.messageImageWrap}>
                                <img
                                  className={s.messageImage}
                                  src={src}
                                  alt={img.type === 'generated' ? 'Generated' : 'Photo'}
                                  loading="lazy"
                                  onClick={() => setViewerImageSrc(src)}
                                />
                                <button
                                  className={s.messageImageDownload}
                                  onClick={(e) => { e.stopPropagation(); handleDownloadImage(src); }}
                                  title="Скачать"
                                >
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                    <polyline points="7 10 12 15 17 10" />
                                    <line x1="12" y1="15" x2="12" y2="3" />
                                  </svg>
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {msg.role === 'assistant'
                        ? <div className={s.bubbleText}><MarkdownRenderer content={msg.content} /></div>
                        : <div className={s.bubbleTextPlain}>{msg.content}</div>
                      }
                    </div>
                    <button
                      className={s.msgKebabBtn}
                      onClick={(e) => handleMsgKebabClick(e, msg.id)}
                      title="Действия"
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                        <circle cx="8" cy="3" r="1.5" />
                        <circle cx="8" cy="8" r="1.5" />
                        <circle cx="8" cy="13" r="1.5" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
              {sending && (
                <div className={s.messageGroup}>
                  <div className={s.metaRow}>Chatter &bull; typing...</div>
                  <div className={s.bubble}>
                    <div className={s.typingDots}>
                      <span className={s.dot} />
                      <span className={s.dot} />
                      <span className={s.dot} />
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Message context menu */}
            {msgMenuId !== null && (
              <div
                className={s.contextMenu}
                style={{ top: msgMenuPos.y, left: msgMenuPos.x }}
                onClick={(e) => e.stopPropagation()}
                onMouseEnter={resetMsgMenuTimer}
                onMouseLeave={startMsgMenuTimer}
              >
                <button className={s.contextMenuItem} onClick={() => handleCopyMessage(msgMenuId)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  Копировать
                </button>
                <button className={s.contextMenuItem} onClick={() => handleDownloadDocx(msgMenuId)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Скачать docx
                </button>
                <button className={`${s.contextMenuItem} ${s.contextMenuItemDanger}`} onClick={() => handleDeleteMessage(msgMenuId)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                  Удалить
                </button>
              </div>
            )}

            {/* Image previews above input */}
            {attachedImages.length > 0 && (
              <div className={s.imagePreviews}>
                {attachedImages.map((img, i) => (
                  <div key={i} className={s.imagePreviewItem}>
                    <img className={s.imagePreviewImg} src={img.preview} alt="" />
                    <button className={s.imagePreviewRemove} onClick={() => removeAttachedImage(i)}>
                      &times;
                    </button>
                  </div>
                ))}
                <button className={s.imageClearAll} onClick={clearAttachedImages}>
                  Очистить
                </button>
              </div>
            )}

            <div className={s.inputArea}>
              {maxImages > 0 ? (
                <svg
                  className={s.inputIcon}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setShowAttachModal(true)}
                  viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon-light)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                >
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                </svg>
              ) : (
                <svg className={s.inputIcon} viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon-light)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.35 }}>
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                </svg>
              )}

              <textarea
                ref={textareaRef}
                className={s.textarea}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder="Введите сообщение..."
                rows={1}
                disabled={sending}
              />

              <svg
                className={sending || (!input.trim() && attachedImages.length === 0) ? s.sendIconDisabled : s.sendIcon}
                onClick={() => { if (!sending && (input.trim() || attachedImages.length > 0)) handleSend(); }}
                viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon-light)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              >
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>

              <PixelAvatar />
            </div>
          </>
        )}
      </main>

      {/* RIGHT TOOLS PANEL */}
      <ToolsPanel plan={user?.plan || 'free'} isAdmin={user?.is_admin || 0} />

      <AnimatePresence>
        {showSettings && (
          <SettingsModal
            key="settings-modal"
            onClose={() => setShowSettings(false)}
          />
        )}

        {showLinkModal && (
          <LinkTelegramModal
            key="link-modal"
            onClose={() => setShowLinkModal(false)}
            onLinked={async () => {
              setShowLinkModal(false);
              setIsLinked(true);
              loadChats();
              // Refresh user data so plan/limits update from the backend
              try {
                const freshUser = await api.fetchMe();
                setUser(freshUser);
                localStorage.setItem('chatter_user', JSON.stringify(freshUser));
              } catch {}
            }}
          />
        )}

        {showAttachModal && maxImages > 0 && (
          <AttachModal
            key="attach-modal"
            onClose={() => setShowAttachModal(false)}
            onAttach={handleAttachFromModal}
            currentCount={attachedImages.length}
            maxCount={maxImages}
          />
        )}

        {deletingChatId !== null && (
          <motion.div
            key="delete-confirm"
            className={s.overlay}
            onClick={() => setDeletingChatId(null)}
            variants={{
              hidden: { opacity: 0 },
              visible: { opacity: 1 },
              exit: { opacity: 0 },
            }}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <motion.div
              className={s.confirmDialog}
              onClick={(e) => e.stopPropagation()}
              variants={{
                hidden: { opacity: 0, y: 16 },
                visible: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' as const } },
                exit: { opacity: 0, y: 16, transition: { duration: 0.15 } },
              }}
              initial="hidden"
              animate="visible"
              exit="exit"
            >
              <div className={s.confirmTitle}>Удалить чат?</div>
              <div className={s.confirmText}>
                Это действие нельзя отменить. Все сообщения будут удалены безвозвратно.
              </div>
              <div className={s.confirmBtns}>
                <button className={s.confirmCancel} onClick={() => setDeletingChatId(null)}>Отмена</button>
                <button className={s.confirmDanger} onClick={handleConfirmDelete}>Удалить</button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {viewerImageSrc && (
          <motion.div
            key="image-viewer"
            className={s.imageViewerOverlay}
            onClick={() => setViewerImageSrc(null)}
            variants={{
              hidden: { opacity: 0 },
              visible: { opacity: 1 },
              exit: { opacity: 0 },
            }}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <button
              className={s.imageViewerDownload}
              onClick={(e) => { e.stopPropagation(); handleDownloadImage(viewerImageSrc); }}
              title="Скачать"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
            <button
              className={s.imageViewerClose}
              onClick={() => setViewerImageSrc(null)}
              title="Закрыть"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
            <img
              className={s.imageViewerImg}
              src={viewerImageSrc}
              alt=""
              onClick={(e) => e.stopPropagation()}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
