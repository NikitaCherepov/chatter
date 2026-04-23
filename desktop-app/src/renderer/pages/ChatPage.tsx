import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useAuth } from '../lib/auth';
import * as api from '../lib/api';
import { LinkTelegramModal } from '../components/LinkTelegramModal';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { AttachModal } from '../components/AttachModal';
import type { ImageItem } from '../components/AttachModal';
import { PixelAvatar, dispatchAvatarState } from '../components/PixelAvatar';
import type { SetDisplayStatePayload } from '../components/PixelAvatar';
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
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const [chats, setChats] = useState<api.ChatInfo[]>([]);
  const [activeChatId, setActiveChatId] = useState<number | null>(null);
  const [messages, setMessages] = useState<api.Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [showAttachModal, setShowAttachModal] = useState(false);
  const [attachedImages, setAttachedImages] = useState<ImageItem[]>([]);
  const [contextMenuChatId, setContextMenuChatId] = useState<number | null>(null);
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [renamingChatId, setRenamingChatId] = useState<number | null>(null);
  const [renamingTitle, setRenamingTitle] = useState('');
  const [deletingChatId, setDeletingChatId] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const maxImages = user ? getMaxImagesForPlan(user.plan, user.is_admin) : 0;

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

  useEffect(() => { loadChats(); }, []);

  useEffect(() => {
    if (activeChatId) loadMessages(activeChatId);
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
    const previewUrls = attachedImages.map((img) => img.preview);

    // Clear attached images immediately
    setAttachedImages([]);

    const displayText = text || (hasImages ? '[Image]' : '');
    const tempUserMsg: api.Message = {
      id: -Date.now(), role: 'user', content: displayText, created_at: Math.floor(Date.now() / 1000),
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    try {
      const res = await api.sendChatMessage(text || ' ', activeChatId ?? undefined, imagesToSend.length > 0 ? imagesToSend : undefined);
      const assistantMsg: api.Message = {
        id: res.message_id, role: 'assistant', content: res.reply_text, created_at: Math.floor(Date.now() / 1000),
      };
      setMessages((prev) => [...prev, assistantMsg]);
      if (!activeChatId || res.chat_id !== activeChatId) {
        setActiveChatId(res.chat_id);
        loadChats();
      }
    } catch (err) {
      console.error('Failed to send message:', err);
      setMessages((prev) => prev.filter((m) => m.id !== tempUserMsg.id));
    } finally {
      setSending(false);
    }
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

  // Close context menu on outside click
  useEffect(() => {
    const close = () => { setContextMenuChatId(null); };
    if (contextMenuChatId !== null) {
      document.addEventListener('click', close);
      return () => document.removeEventListener('click', close);
    }
  }, [contextMenuChatId]);

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

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px';
    }
  }, [input]);

  // ── PixelAvatar: system reactions + IPC bridge ────────────────────────────

  // Push "think" reaction while AI is generating
  useEffect(() => {
    if (sending) dispatchAvatarState({ reactions: ['think'] });
  }, [sending]);

  // Listen for avatar state from Electron main process (IPC)
  useEffect(() => {
    const unsub = window.electronAPI?.onAvatarState?.((payload) => {
      dispatchAvatarState(payload as SetDisplayStatePayload);
    });
    return () => unsub?.();
  }, []);

  const formatTime = (ts: number) => {
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

        <motion.div
          className={s.sidebarContentBody}
          animate={{ opacity: sidebarCollapsed ? 0 : 1 }}
          transition={{ duration: 0.15 }}
          style={{ pointerEvents: sidebarCollapsed ? 'none' : 'auto' }}
        >
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
          <div className={s.userInfo}>
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
            <button className={s.iconBtn} onClick={() => setShowLinkModal(true)} title="Привязать Telegram">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
            </button>
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
                  <div className={msg.role === 'user' ? s.bubbleUser : s.bubble}>
                    {msg.role === 'assistant'
                      ? <div className={s.bubbleText}><MarkdownRenderer content={msg.content} /></div>
                      : <div className={s.bubbleTextPlain}>{msg.content}</div>
                    }
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
            </div>
          </>
        )}
      </main>

      {/* PixelAvatar — replaces old FAB */}
      <div className={s.avatarFab}>
        <PixelAvatar />
      </div>

      <AnimatePresence>
        {showLinkModal && (
          <LinkTelegramModal
            key="link-modal"
            onClose={() => setShowLinkModal(false)}
            onLinked={() => { setShowLinkModal(false); loadChats(); }}
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
