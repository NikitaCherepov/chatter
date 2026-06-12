import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useAuth } from '../lib/auth';
import * as api from '../lib/api';
import { generateDocxBlob, generateChatDocxBlob } from '../lib/markdownToDocx';
import { LinkTelegramModal } from '../components/LinkTelegramModal';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { AttachModal } from '../components/AttachModal';
import type { ImageItem } from '../components/AttachModal';
import { Select } from '../components/Select';
import { SettingsModal } from '../components/SettingsModal';
import { PixelAvatar, dispatchAvatarState, startAvatarLoop, stopAvatarLoop, getAvatarManifest } from '../components/PixelAvatar';
import type { SetDisplayStatePayload } from '../components/PixelAvatar';
import { ToolsPanel } from '../components/ToolsPanel';
import { openTool, handleDesktopAction, dispatchMapData, emitSuggestMacro } from '../lib/tools';
import { createSpeechRecorder } from '../lib/speechRecorder';
import { ttsSpeak, ttsStop, ttsSubscribe, playSfx } from '../lib/tts';
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
const MESSAGE_PAGE_SIZE = 50;

const reasoningPanelVariants = {
  hidden: { opacity: 0, y: -16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' as const } },
  exit: { opacity: 0, y: -16, transition: { duration: 0.15 } },
};

const formatMessageTime = (ts: number) => {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

type MessageItemProps = {
  msg: api.Message;
  isLastAssistant: boolean;
  isTtsPlaying: boolean;
  isReasoningOpen: boolean;
  isToolCallsOpen: boolean;
  isRegenHintOpen: boolean;
  sending: boolean;
  regenHintText: string;
  resolveImageUrl: (url: string) => string;
  onSetMessages: React.Dispatch<React.SetStateAction<api.Message[]>>;
  onSetViewerImageSrc: (src: string) => void;
  onDownloadImage: (src: string) => void;
  onToggleReasoning: (messageId: number) => void;
  onToggleToolCalls: (messageId: number) => void;
  onRegenerate: (messageId: number) => void;
  onOpenRegenHint: (messageId: number) => void;
  onCloseRegenHint: () => void;
  onSetRegenHintText: (value: string) => void;
  onRegenerateWithHint: (messageId: number, hint: string) => void;
  onMsgKebabClick: (e: React.MouseEvent, messageId: number) => void;
};

const MessageItem = React.memo(function MessageItem({
  msg,
  isLastAssistant,
  isTtsPlaying,
  isReasoningOpen,
  isToolCallsOpen,
  isRegenHintOpen,
  sending,
  regenHintText,
  resolveImageUrl,
  onSetMessages,
  onSetViewerImageSrc,
  onDownloadImage,
  onToggleReasoning,
  onToggleToolCalls,
  onRegenerate,
  onOpenRegenHint,
  onCloseRegenHint,
  onSetRegenHintText,
  onRegenerateWithHint,
  onMsgKebabClick,
}: MessageItemProps) {
  const reasoningOpen = isReasoningOpen;
  const hasReasoning = msg.role === 'assistant' && Boolean(msg.reasoning_content?.trim());
  const hasToolCalls = msg.role === 'assistant' && Boolean(msg.tool_calls?.length);

  return (
    <div className={`${s.messageGroup} ${reasoningOpen || isToolCallsOpen ? s.messageGroupRaised : ''}`}>
      <div className={s.metaRow}>
        <span>{msg.role === 'user' ? 'You' : 'Chatter'} &bull; {formatMessageTime(msg.created_at)}</span>
        <button
          className={`${s.playBtn} ${isTtsPlaying ? s.playBtnPlaying : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            ttsSpeak(msg.id, msg.content, msg.audio, (id, audio) => {
              onSetMessages(prev => prev.map(m => m.id === id ? { ...m, audio } : m));
            });
          }}
          title={isTtsPlaying ? 'Остановить' : 'Озвучить'}
        >
          {isTtsPlaying ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          )}
        </button>
        {hasReasoning && (
          <button
            className={`${s.reasoningToggle} ${reasoningOpen ? s.reasoningToggleOpen : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleReasoning(msg.id);
            }}
            title={reasoningOpen ? 'Скрыть рассуждение' : 'Показать рассуждение'}
          >
            <span>Рассуждение</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        )}
        {hasToolCalls && (
          <button
            className={`${s.reasoningToggle} ${isToolCallsOpen ? s.reasoningToggleOpen : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleToolCalls(msg.id);
            }}
            title={isToolCallsOpen ? 'Скрыть инструменты' : 'Показать инструменты'}
          >
            <span>{msg.tool_calls!.length} {msg.tool_calls!.length === 1 ? 'инструмент' : msg.tool_calls!.length < 5 ? 'инструмента' : 'инструментов'}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        )}
        {isLastAssistant && (
          <>
            <button className={s.playBtn} onClick={(e) => { e.stopPropagation(); onRegenerate(msg.id); }} title="Перегенерировать" disabled={sending}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </button>
            {isRegenHintOpen ? (
              <>
                <div className={s.regenHintOverlay} onClick={onCloseRegenHint} />
                <div className={s.regenHintPopup}>
                  <input
                    className={s.regenHintInput}
                    autoFocus
                    placeholder="Инструкция для бота..."
                    value={regenHintText}
                    onChange={(e) => onSetRegenHintText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && regenHintText.trim()) onRegenerateWithHint(msg.id, regenHintText);
                      else if (e.key === 'Escape') onCloseRegenHint();
                    }}
                  />
                  <button
                    className={s.regenHintSend}
                    onClick={() => { if (regenHintText.trim()) onRegenerateWithHint(msg.id, regenHintText); }}
                    disabled={!regenHintText.trim() || sending}
                    title="Отправить"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                  </button>
                </div>
              </>
            ) : (
              <button
                className={s.playBtn}
                onClick={(e) => { e.stopPropagation(); onOpenRegenHint(msg.id); }}
                title="Перегенерировать с инструкцией"
                disabled={sending}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
            )}
          </>
        )}
      </div>
      <div className={s.bubbleWrap}>
        <div className={msg.role === 'user' ? s.bubbleUser : s.bubble}>
          {msg.images && msg.images.length > 0 && (
            <div className={s.messageImages}>
              {msg.images.map((img, i) => {
                const src = resolveImageUrl(img.url);
                return (
                  <div key={i} className={s.messageImageWrap}>
                    <img className={s.messageImage} src={src} alt={img.type === 'generated' ? 'Generated' : 'Photo'} loading="lazy" onClick={() => onSetViewerImageSrc(src)} />
                    <button className={s.messageImageDownload} onClick={(e) => { e.stopPropagation(); onDownloadImage(src); }} title="Скачать">
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
        <AnimatePresence>
          {hasReasoning && reasoningOpen && (
            <motion.div className={s.reasoningPanel} variants={reasoningPanelVariants} initial="hidden" animate="visible" exit="exit">
              <MarkdownRenderer content={msg.reasoning_content || ''} />
            </motion.div>
          )}
          {hasToolCalls && isToolCallsOpen && (
            <motion.div className={s.reasoningPanel} variants={reasoningPanelVariants} initial="hidden" animate="visible" exit="exit">
              {msg.tool_calls!.map((tc, i) => (
                <div key={tc.id || i} style={{ marginBottom: i < msg.tool_calls!.length - 1 ? '8px' : 0 }}>
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>{tc.name}</div>
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.8 }}>
                    {typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments, null, 2)}
                  </pre>
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
        <button className={s.msgKebabBtn} onClick={(e) => onMsgKebabClick(e, msg.id)} title="Действия">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="8" cy="3" r="1.5" />
            <circle cx="8" cy="8" r="1.5" />
            <circle cx="8" cy="13" r="1.5" />
          </svg>
        </button>
      </div>
    </div>
  );
});

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
  const [showTyping, setShowTyping] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [isLinked, setIsLinked] = useState(false);
  const [showAttachModal, setShowAttachModal] = useState(false);
  const [attachedImages, setAttachedImages] = useState<ImageItem[]>([]);
  const [contextMenuChatId, setContextMenuChatId] = useState<number | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [msgMenuId, setMsgMenuId] = useState<number | null>(null);
  const [msgMenuPos, setMsgMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const msgMenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [renamingChatId, setRenamingChatId] = useState<number | null>(null);
  const [renamingTitle, setRenamingTitle] = useState('');
  const [deletingChatId, setDeletingChatId] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const pendingPrependScrollRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<api.ChatSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [viewerImageSrc, setViewerImageSrc] = useState<string | null>(null);
  const [ttsPlayingId, setTtsPlayingId] = useState<number | null>(null);
  const [pendingMacros, setPendingMacros] = useState<Array<{ title: string; description?: string; commands: string[] }>>([]);
  const [devopsConfirmations, setDevopsConfirmations] = useState<Array<{ confirmation_id: string; server_name: string; server_id: number; host: string; command: string; needs_sudo_password?: boolean; sudo_password?: string; save_sudo_password?: boolean; needs_new_password?: boolean; new_password?: string; new_username?: string; _reviewing?: boolean; _verdict?: string }>>([]);
  const [pendingRunbooks, setPendingRunbooks] = useState<Array<{ title: string; content: string; commands: string[]; _reviewing?: boolean; _verdict?: string }>>([]);
  const [pendingCredsUpdates, setPendingCredsUpdates] = useState<Array<{ confirmation_id?: string; server_id: number; server_name: string; current_username: string; new_username: string; reason: string; use_ssh_key: boolean; remove_password: boolean }>>([]);
  const [pcCommandConfirmations, setPcCommandConfirmations] = useState<Array<{ confirmation_id: string; command: string; _reviewing?: boolean; _verdict?: string }>>([]);
  const [modelsCatalog, setModelsCatalog] = useState<api.ModelCatalogEntry[]>([]);
  const [preferredModel, setPreferredModel] = useState<string | null>(null);
  const [regenHintMsgId, setRegenHintMsgId] = useState<number | null>(null);
  const [regenHintText, setRegenHintText] = useState('');
  const [openReasoningId, setOpenReasoningId] = useState<number | null>(null);
  const [openToolCallsId, setOpenToolCallsId] = useState<number | null>(null);

  // Subscribe to TTS state
  useEffect(() => {
    return ttsSubscribe((id) => setTtsPlayingId(id));
  }, []);

  // Load models catalog
  useEffect(() => {
    (async () => {
      try {
        const res = await api.getModels();
        setModelsCatalog(res.models);
        setPreferredModel(res.preferred_model);
      } catch {}
    })();
  }, []);

  // Ref flag: when true, the next handleSend() call originated from voice input (wake word)
  const isVoiceInputRef = useRef(false);

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
      const res = await api.getMessages(chatId, MESSAGE_PAGE_SIZE);
      setMessages(res.messages);
      setHasMoreMessages(res.messages.length === MESSAGE_PAGE_SIZE);
    } catch (err) {
      console.error('Failed to load messages:', err);
    } finally {
      setLoadingMessages(false);
    }
  };

  const loadOlderMessages = useCallback(async () => {
    if (!activeChatId || loadingOlderMessages || !hasMoreMessages) return;
    const scroller = messagesScrollRef.current;
    pendingPrependScrollRef.current = scroller
      ? { scrollHeight: scroller.scrollHeight, scrollTop: scroller.scrollTop }
      : null;
    setLoadingOlderMessages(true);
    try {
      const res = await api.getMessages(activeChatId, MESSAGE_PAGE_SIZE, messages.length);
      setHasMoreMessages(res.messages.length === MESSAGE_PAGE_SIZE);
      if (res.messages.length > 0) {
        setMessages(prev => [...res.messages, ...prev]);
      } else {
        pendingPrependScrollRef.current = null;
      }
    } catch (err) {
      pendingPrependScrollRef.current = null;
      console.error('Failed to load older messages:', err);
    } finally {
      setLoadingOlderMessages(false);
    }
  }, [activeChatId, loadingOlderMessages, hasMoreMessages, messages.length]);

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

    const isVoice = isVoiceInputRef.current;
    isVoiceInputRef.current = false;

    setInput('');
    setSending(true);
    setShowTyping(true);

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
        setShowTyping(false);
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
          if (action.action === 'suggest_macro' && action.value) {
            const val = action.value as { title?: string; description?: string; commands?: string[] };
            if (val.title && val.commands?.length) {
              setPendingMacros(prev => [...prev, { title: val.title!, description: val.description, commands: val.commands! }]);
            }
          }
          if (action.action === 'devops_confirmation' && action.value) {
            const val = action.value as { confirmation_id?: string; server_name?: string; server_id?: number; host?: string; command?: string; needs_sudo_password?: boolean; needs_new_password?: boolean; new_username?: string };
            if (val.confirmation_id && val.command) {
              setDevopsConfirmations(prev => [...prev, {
                confirmation_id: val.confirmation_id!,
                server_name: val.server_name || 'Unknown',
                server_id: val.server_id || 0,
                host: val.host || '',
                command: val.command!,
                needs_sudo_password: Boolean(val.needs_sudo_password),
                needs_new_password: Boolean(val.needs_new_password),
                new_username: val.new_username,
              }]);
            }
          }
          if (action.action === 'suggest_devops_runbook' && action.value) {
            const val = action.value as { title?: string; content?: string; commands?: string[] };
            if (val.title && val.content) {
              setPendingRunbooks(prev => [...prev, { title: val.title!, content: val.content!, commands: val.commands || [] }]);
            }
          }
          if (action.action === 'suggest_server_creds_update' && action.value) {
            const val = action.value as { confirmation_id?: string; server_id?: number; server_name?: string; current_username?: string; new_username?: string; reason?: string; use_ssh_key?: boolean; remove_password?: boolean };
            if (val.server_id && val.new_username && val.reason) {
              setPendingCredsUpdates(prev => [...prev, {
                confirmation_id: val.confirmation_id,
                server_id: val.server_id!,
                server_name: val.server_name || '',
                current_username: val.current_username || '',
                new_username: val.new_username!,
                reason: val.reason!,
                use_ssh_key: val.use_ssh_key === true,
                remove_password: val.remove_password || false,
              }]);
            }
          }
          if (action.action === 'pc_command_confirmation' && action.value) {
            const val = action.value as { confirmation_id?: string; command?: string };
            if (val.confirmation_id && val.command) {
              setPcCommandConfirmations(prev => [...prev, {
                confirmation_id: val.confirmation_id!,
                command: val.command!,
              }]);
            }
          }
          if (action.action === 'chat_title_update' && action.value) {
            const val = action.value as { chat_id?: number; title?: string };
            if (val.chat_id && val.title) {
              setChats(prev => prev.map(c =>
                c.id === val.chat_id ? { ...c, title: val.title! } : c
              ));
            }
          }
          handleDesktopAction(action);
        },
        onMapUpdate: (data) => {
          openTool('map');
          dispatchMapData(data);
        },
        onDone: (res) => {
          // Если генерация была остановлена пользователем
          if (res.aborted) {
            if (assistantMsgCreated) {
              // Удаляем временный assistant message (если был промежуточный текст)
              setMessages((prev) => prev.filter(m => m.id !== tempAssistantId));
            }
            setShowTyping(false);
            setSending(false);
            return;
          }
          if (res.model_fallback_notice) {
            toast.warning(res.model_fallback_notice, { duration: 5000 });
          }
          // Build images array from generated_images
          const currentTokens = api.loadTokens();
          const genImages: api.MessageImage[] | undefined = res.generated_images?.length
            ? res.generated_images.map(img => ({
                url: img.image_url
                  ? (img.image_url.startsWith('http')
                      ? img.image_url
                      : `${api.API_BASE}${img.image_url}${currentTokens?.access_token ? `?token=${currentTokens.access_token}` : ''}`)
                  : `data:image/png;base64,${img.image_base64}`,
                type: 'generated' as const
              }))
            : undefined;

          if (assistantMsgCreated) {
            setMessages((prev) => prev.map(m => {
              if (m.id === tempAssistantId) {
                return {
                  ...m,
                  id: res.message_id,
                  ...(res.reply_text ? { content: res.reply_text } : {}),
                  reasoning_content: res.reasoning_content ?? null,
                  tool_calls: res.tool_calls ?? null,
                  ...(genImages ? { images: genImages } : {})
                };
              }
              // Replace temp user message id with real one from server
              if (res.user_message_id && m.id === tempUserMsg.id) {
                return { ...m, id: res.user_message_id };
              }
              return m;
            }));
          } else {
            // Ни одного промежуточного сообщения не было — добавляем финальный ответ
            setMessages((prev) => {
              const updated = res.user_message_id
                ? prev.map(m => m.id === tempUserMsg.id ? { ...m, id: res.user_message_id! } : m)
                : prev;
              return [...updated, {
                id: res.message_id, role: 'assistant', content: res.reply_text, created_at: Math.floor(Date.now() / 1000),
                reasoning_content: res.reasoning_content ?? null,
                tool_calls: res.tool_calls ?? null,
                images: genImages,
              }];
            });
          }
          setShowTyping(false);
          setSending(false);
          if (res.display_state) dispatchAvatarState(res.display_state);
          if (!activeChatId || res.chat_id !== activeChatId) {
            setActiveChatId(res.chat_id);
            loadChats();
          }

          // Auto-speak response when triggered by voice input
          if (isVoice && res.reply_text) {
            ttsSpeak(res.message_id, res.reply_text);
          }
        },
        onError: (err) => {
          console.error('Stream error:', err);
          if (assistantMsgCreated) {
            setMessages((prev) => prev.filter(m => m.id !== tempAssistantId && m.id !== tempUserMsg.id));
          } else {
            setMessages((prev) => prev.filter(m => m.id !== tempUserMsg.id));
          }
          setShowTyping(false);
          setSending(false);
        }
      },
      isVoice ? { isVoice: true, preferredModel: preferredModel } : { preferredModel: preferredModel }
    );
  }, [input, sending, activeChatId, attachedImages, preferredModel]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  // Keep handleSend in ref so wake word callback can call the latest version
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;

  // ── Voice recording ───────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        const arrayBuffer = await blob.arrayBuffer();

        setIsTranscribing(true);
        try {
          const text = await window.electronAPI.transcribeAudio(arrayBuffer);
          if (text) setInput((prev) => prev ? `${prev} ${text}` : text);
        } catch (err) {
          console.error('[voice] Transcription failed:', err);
          toast.error('Ошибка распознавания голоса');
        } finally {
          setIsTranscribing(false);
        }
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error('[voice] Microphone access denied:', err);
      toast.error('Нет доступа к микрофону');
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }, []);

  const toggleRecording = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

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

  const handleMsgKebabClick = useCallback((e: React.MouseEvent, messageId: number) => {
    e.stopPropagation();
    if (msgMenuTimerRef.current) clearTimeout(msgMenuTimerRef.current);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMsgMenuPos({ x: rect.right + 4, y: rect.top });
    setMsgMenuId(messageId);
    msgMenuTimerRef.current = setTimeout(() => setMsgMenuId(null), 1000);
  }, []);

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

  const handleRegenerate = useCallback(async (assistantMsgId: number) => {
    if (!activeChatId || sending) return;
    const idx = messages.findIndex(m => m.id === assistantMsgId);
    if (idx < 0) return;
    // Find last user message before this assistant message
    let userText = '';
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        userText = messages[i].content;
        break;
      }
    }
    if (!userText) return;

    // Remove the assistant message optimistically
    const snapshot = [...messages];
    setMessages(prev => prev.filter(m => m.id !== assistantMsgId));
    try {
      await api.deleteMessage(activeChatId, assistantMsgId);
    } catch {
      // If delete fails, still proceed — server may not have it
    }

    setSending(true);
    setShowTyping(true);

    let assistantMsgCreated = false;
    const tempAssistantId = -Date.now() - 1;
    const appendToAssistant = (text: string) => {
      if (!assistantMsgCreated) {
        assistantMsgCreated = true;
        setShowTyping(false);
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
      userText,
      activeChatId,
      undefined,
      getAvatarManifest(),
      {
        onIntermediate: (stepText) => appendToAssistant(stepText),
        onToolStatus: (statusText) => appendToAssistant(`_${statusText}_`),
        onDisplayState: (state) => dispatchAvatarState(state),
        onDesktopAction: (action) => handleDesktopAction(action),
        onMapUpdate: (data) => { openTool('map'); dispatchMapData(data); },
        onDone: (res) => {
          if (res.aborted) {
            if (assistantMsgCreated) {
              setMessages((prev) => prev.filter(m => m.id !== tempAssistantId));
            }
            setShowTyping(false);
            setSending(false);
            return;
          }
          if (res.model_fallback_notice) {
            toast.warning(res.model_fallback_notice, { duration: 5000 });
          }
          const currentTokens = api.loadTokens();
          const genImages: api.MessageImage[] | undefined = res.generated_images?.length
            ? res.generated_images.map(img => ({
                url: img.image_url
                  ? (img.image_url.startsWith('http')
                      ? img.image_url
                      : `${api.API_BASE}${img.image_url}${currentTokens?.access_token ? `?token=${currentTokens.access_token}` : ''}`)
                  : `data:image/png;base64,${img.image_base64}`,
                type: 'generated' as const
              }))
            : undefined;

          if (assistantMsgCreated) {
            setMessages((prev) => prev.map(m =>
              m.id === tempAssistantId
                ? { ...m, id: res.message_id, ...(res.reply_text ? { content: res.reply_text } : {}), reasoning_content: res.reasoning_content ?? null, tool_calls: res.tool_calls ?? null, ...(genImages ? { images: genImages } : {}) }
                : m
            ));
          } else {
            setMessages((prev) => [...prev, {
              id: res.message_id, role: 'assistant', content: res.reply_text, created_at: Math.floor(Date.now() / 1000),
              reasoning_content: res.reasoning_content ?? null,
              tool_calls: res.tool_calls ?? null,
              images: genImages,
            }]);
          }
          setShowTyping(false);
          setSending(false);
          if (res.display_state) dispatchAvatarState(res.display_state);
        },
        onError: (err) => {
          console.error('Regenerate error:', err);
          if (assistantMsgCreated) {
            setMessages((prev) => prev.filter(m => m.id !== tempAssistantId));
          }
          setShowTyping(false);
          setSending(false);
        },
      },
      { preferredModel: preferredModel, skip_user_history: true, regenerate_from_history: true }
    );
  }, [activeChatId, sending, messages, preferredModel]);

  const handleRegenerateWithHint = useCallback(async (assistantMsgId: number, hint: string) => {
    if (!activeChatId || sending || !hint.trim()) return;
    setRegenHintMsgId(null);
    setRegenHintText('');
    const idx = messages.findIndex(m => m.id === assistantMsgId);
    if (idx < 0) return;
    let userText = '';
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        userText = messages[i].content;
        break;
      }
    }
    if (!userText) return;

    const snapshot = [...messages];
    setMessages(prev => prev.filter(m => m.id !== assistantMsgId));
    try {
      await api.deleteMessage(activeChatId, assistantMsgId);
    } catch {
      // proceed anyway
    }

    setSending(true);
    setShowTyping(true);

    let assistantMsgCreated = false;
    const tempAssistantId = -Date.now() - 1;
    const appendToAssistant = (text: string) => {
      if (!assistantMsgCreated) {
        assistantMsgCreated = true;
        setShowTyping(false);
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
      userText,
      activeChatId,
      undefined,
      getAvatarManifest(),
      {
        onIntermediate: (stepText) => appendToAssistant(stepText),
        onToolStatus: (statusText) => appendToAssistant(`_${statusText}_`),
        onDisplayState: (state) => dispatchAvatarState(state),
        onDesktopAction: (action) => handleDesktopAction(action),
        onMapUpdate: (data) => { openTool('map'); dispatchMapData(data); },
        onDone: (res) => {
          if (res.aborted) {
            if (assistantMsgCreated) {
              setMessages((prev) => prev.filter(m => m.id !== tempAssistantId));
            }
            setShowTyping(false);
            setSending(false);
            return;
          }
          if (res.model_fallback_notice) {
            toast.warning(res.model_fallback_notice, { duration: 5000 });
          }
          const currentTokens = api.loadTokens();
          const genImages: api.MessageImage[] | undefined = res.generated_images?.length
            ? res.generated_images.map(img => ({
                url: img.image_url
                  ? (img.image_url.startsWith('http')
                      ? img.image_url
                      : `${api.API_BASE}${img.image_url}${currentTokens?.access_token ? `?token=${currentTokens.access_token}` : ''}`)
                  : `data:image/png;base64,${img.image_base64}`,
                type: 'generated' as const
              }))
            : undefined;

          if (assistantMsgCreated) {
            setMessages((prev) => prev.map(m =>
              m.id === tempAssistantId
                ? { ...m, id: res.message_id, ...(res.reply_text ? { content: res.reply_text } : {}), reasoning_content: res.reasoning_content ?? null, tool_calls: res.tool_calls ?? null, ...(genImages ? { images: genImages } : {}) }
                : m
            ));
          } else {
            setMessages((prev) => [...prev, {
              id: res.message_id, role: 'assistant', content: res.reply_text, created_at: Math.floor(Date.now() / 1000),
              reasoning_content: res.reasoning_content ?? null,
              tool_calls: res.tool_calls ?? null,
              images: genImages,
            }]);
          }
          setShowTyping(false);
          setSending(false);
          if (res.display_state) dispatchAvatarState(res.display_state);
        },
        onError: (err) => {
          console.error('Regenerate with hint error:', err);
          if (assistantMsgCreated) {
            setMessages((prev) => prev.filter(m => m.id !== tempAssistantId));
          }
          setShowTyping(false);
          setSending(false);
        },
      },
      { preferredModel: preferredModel, regenerate_hint: hint.trim(), skip_user_history: true, regenerate_from_history: true }
    );
  }, [activeChatId, sending, messages, preferredModel]);

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

  const handleSendToTelegram = async (messageId: number) => {
    closeMsgMenu();
    try {
      await api.sendMessageToTelegram(messageId);
      toast.success('Отправлено в Telegram');
    } catch (err: any) {
      const error = err?.data?.error || err?.message || '';
      if (error === 'telegram_not_linked') {
        toast.error('Telegram не привязан. Привяжите аккаунт в настройках.');
      } else if (error === 'telegram_not_configured') {
        toast.error('Telegram не настроен на сервере');
      } else {
        toast.error('Не удалось отправить в Telegram');
      }
    }
  };

  const prevMsgCountRef = useRef(0);
  useLayoutEffect(() => {
    const pending = pendingPrependScrollRef.current;
    const scroller = messagesScrollRef.current;
    if (!pending || !scroller) return;
    scroller.scrollTop = scroller.scrollHeight - pending.scrollHeight + pending.scrollTop;
    pendingPrependScrollRef.current = null;
    prevMsgCountRef.current = messages.length;
  }, [messages.length]);

  useEffect(() => {
    if (pendingPrependScrollRef.current) return;
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

  // ── Wake word: start Python listener, react to detections ───────────────
  const speechRecorderRef = useRef<ReturnType<typeof createSpeechRecorder> | null>(null);

  useEffect(() => {
    void window.electronAPI.startWakeWord().then((result) => {
      if (!result.ok) {
        console.error('[wakeword] failed to start:', result.error);
        toast.error('Не удалось запустить wake word');
      }
    }).catch((error) => {
      console.error('[wakeword] failed to start:', error);
      toast.error('Не удалось запустить wake word');
    });

    const unsubscribe = window.electronAPI.onWakeWordDetected(async (payload) => {
      console.log('[wakeword] detected:', payload);

      // Don't start if already busy
      if (isRecording || isTranscribing || sending) return;
      if (speechRecorderRef.current?.isActive()) return;

      // Play notification sound — recording is starting
      playSfx('Voice Recording Sound.mp3');

      // Create a fresh speech recorder for this session
      const recorder = createSpeechRecorder({
        silenceDelayMs: 900,
        harkThreshold: -55,

        onSpeechStart: () => {
          setIsRecording(true);
          console.log('[speech] speaking started');
        },

        onSpeechEnd: async (audioBlob) => {
          setIsRecording(false);
          console.log('[speech] speaking ended, transcribing...');

          setIsTranscribing(true);
          try {
            const arrayBuffer = await audioBlob.arrayBuffer();
            const text = await window.electronAPI.transcribeAudio(arrayBuffer);
            if (!text) return;

            // Send immediately if bot is idle, otherwise fall back to textarea
            if (!sending) {
              isVoiceInputRef.current = true;
              setInput(text);
              setTimeout(() => {
                void playSfx('voice_end.mp3');
                handleSendRef.current();
              }, 0);
            } else {
              setInput((prev) => prev ? `${prev} ${text}` : text);
            }
          } catch (err) {
            console.error('[speech] Transcription failed:', err);
            toast.error('Ошибка распознавания голоса');
          } finally {
            setIsTranscribing(false);
          }

          // Stop recorder and clean up
          recorder.stop();
          speechRecorderRef.current = null;
        },

        onNoSpeech: () => {
          console.log('[speech] no speech detected, cancelling');
          setIsRecording(false);
          recorder.stop();
          speechRecorderRef.current = null;
        },

        onError: (error) => {
          console.error('[speech] Recorder error:', error);
          toast.error('Ошибка записи голоса');
          recorder.stop();
          speechRecorderRef.current = null;
          setIsRecording(false);
        },
      });

      speechRecorderRef.current = recorder;
      await recorder.start();
    });

    return () => {
      unsubscribe();
      window.electronAPI.stopWakeWord();
      speechRecorderRef.current?.stop();
      speechRecorderRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for external tool open requests (bot / IPC)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ toolId?: string }>).detail;
      openTool(detail?.toolId);
    };
    window.addEventListener('chatter:open-tool', handler);
    return () => window.removeEventListener('chatter:open-tool', handler);
  }, []);

  const lastAssistantId = messages.filter(m => m.role === 'assistant').pop()?.id ?? null;
  const formatTime = formatMessageTime;

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

  const resolveImageUrl = useCallback((url: string) => {
    if (!url.startsWith('/')) return url;
    const tokens = api.loadTokens();
    const separator = url.includes('?') ? '&' : '?';
    const authParam = tokens?.access_token ? `${separator}token=${tokens.access_token}` : '';
    return `${api.API_BASE}${url}${authParam}`;
  }, []);

  const handleDownloadImage = useCallback(async (src: string) => {
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
  }, []);

  const handleToggleReasoning = useCallback((messageId: number) => {
    setOpenReasoningId((current) => current === messageId ? null : messageId);
  }, []);

  const handleToggleToolCalls = useCallback((messageId: number) => {
    setOpenToolCallsId((current) => current === messageId ? null : messageId);
  }, []);

  const handleOpenRegenHint = useCallback((messageId: number) => {
    setRegenHintMsgId(messageId);
    setRegenHintText('');
  }, []);

  const handleCloseRegenHint = useCallback(() => {
    setRegenHintMsgId(null);
    setRegenHintText('');
  }, []);

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
            {modelsCatalog.length > 0 && (
              <div className={s.chatTopBar}>
                <div className={s.modelSelector}>
                  <label className={s.modelLabel}>Модель:</label>
                  <div className={s.modelSelectWrap}>
                    <Select
                      options={[
                        { value: '', label: 'Авто', hint: 'Автоматический выбор' },
                        ...modelsCatalog.map(m => ({
                          value: m.id,
                          label: m.name,
                          hint: m.description || undefined,
                        })),
                      ]}
                      value={preferredModel || ''}
                      onChange={async (val) => {
                        const modelId = val || null;
                        try {
                          await api.setPreferredModel(modelId);
                          setPreferredModel(modelId);
                        } catch {
                          toast.error('Не удалось сменить модель');
                        }
                      }}
                      placeholder="Авто"
                    />
                  </div>
                </div>
              </div>
            )}
            <div className={s.messages} ref={messagesScrollRef}>
              {loadingMessages && (
                <div className={s.loadingRow}>Загрузка сообщений...</div>
              )}
              {!loadingMessages && hasMoreMessages && (
                <button className={s.loadOlderBtn} onClick={loadOlderMessages} disabled={loadingOlderMessages}>
                  {loadingOlderMessages ? 'Загрузка...' : 'Загрузить старые сообщения'}
                </button>
              )}
              {messages.map((msg) => (
                <MessageItem
                  key={msg.id}
                  msg={msg}
                  isLastAssistant={msg.id === lastAssistantId}
                  isTtsPlaying={ttsPlayingId === msg.id}
                  isReasoningOpen={openReasoningId === msg.id}
                  isToolCallsOpen={openToolCallsId === msg.id}
                  isRegenHintOpen={regenHintMsgId === msg.id}
                  sending={sending}
                  regenHintText={regenHintText}
                  resolveImageUrl={resolveImageUrl}
                  onSetMessages={setMessages}
                  onSetViewerImageSrc={setViewerImageSrc}
                  onDownloadImage={handleDownloadImage}
                  onToggleReasoning={handleToggleReasoning}
                  onToggleToolCalls={handleToggleToolCalls}
                  onRegenerate={handleRegenerate}
                  onOpenRegenHint={handleOpenRegenHint}
                  onCloseRegenHint={handleCloseRegenHint}
                  onSetRegenHintText={setRegenHintText}
                  onRegenerateWithHint={handleRegenerateWithHint}
                  onMsgKebabClick={handleMsgKebabClick}
                />
              ))}
              {false && messages.map((msg) => (
                <div key={msg.id} className={`${s.messageGroup} ${openReasoningId === msg.id ? s.messageGroupRaised : ''}`}>
                  <div className={s.metaRow}>
                    <span>{msg.role === 'user' ? 'You' : 'Chatter'} &bull; {formatTime(msg.created_at)}</span>
                    <button
                      className={`${s.playBtn} ${ttsPlayingId === msg.id ? s.playBtnPlaying : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        ttsSpeak(msg.id, msg.content, msg.audio, (id, audio) => {
                          setMessages(prev => prev.map(m => m.id === id ? { ...m, audio } : m));
                        });
                      }}
                      title={ttsPlayingId === msg.id ? 'Остановить' : 'Озвучить'}
                    >
                      {ttsPlayingId === msg.id ? (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                          <rect x="6" y="4" width="4" height="16" rx="1" />
                          <rect x="14" y="4" width="4" height="16" rx="1" />
                        </svg>
                      ) : (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                          <polygon points="5 3 19 12 5 21 5 3" />
                        </svg>
                      )}
                    </button>
                    {msg.role === 'assistant' && msg.reasoning_content?.trim() && (
                      <button
                        className={`${s.reasoningToggle} ${openReasoningId === msg.id ? s.reasoningToggleOpen : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenReasoningId((current) => current === msg.id ? null : msg.id);
                        }}
                        title={openReasoningId === msg.id ? 'Скрыть рассуждение' : 'Показать рассуждение'}
                      >
                        <span>Рассуждение</span>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </button>
                    )}
                    {msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0 && (
                      <button
                        className={`${s.reasoningToggle} ${openToolCallsId === msg.id ? s.reasoningToggleOpen : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenToolCallsId((current) => current === msg.id ? null : msg.id);
                        }}
                        title={openToolCallsId === msg.id ? 'Скрыть инструменты' : 'Показать инструменты'}
                      >
                        <span>{msg.tool_calls.length} {msg.tool_calls.length === 1 ? 'инструмент' : msg.tool_calls.length < 5 ? 'инструмента' : 'инструментов'}</span>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </button>
                    )}
                    {msg.id === lastAssistantId && (
                      <>
                        <button
                          className={s.playBtn}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRegenerate(msg.id);
                          }}
                          title="Перегенерировать"
                          disabled={sending}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="23 4 23 10 17 10" />
                            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                          </svg>
                        </button>
                        {regenHintMsgId === msg.id ? (
                          <>
                            <div className={s.regenHintOverlay} onClick={() => { setRegenHintMsgId(null); setRegenHintText(''); }} />
                            <div className={s.regenHintPopup}>
                              <input
                                className={s.regenHintInput}
                                autoFocus
                                placeholder="Инструкция для бота..."
                                value={regenHintText}
                                onChange={(e) => setRegenHintText(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && regenHintText.trim()) {
                                    handleRegenerateWithHint(msg.id, regenHintText);
                                  } else if (e.key === 'Escape') {
                                    setRegenHintMsgId(null);
                                    setRegenHintText('');
                                  }
                                }}
                              />
                              <button
                                className={s.regenHintSend}
                                onClick={() => {
                                  if (regenHintText.trim()) handleRegenerateWithHint(msg.id, regenHintText);
                                }}
                                disabled={!regenHintText.trim() || sending}
                                title="Отправить"
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                                  <polygon points="5 3 19 12 5 21 5 3" />
                                </svg>
                              </button>
                            </div>
                          </>
                        ) : (
                          <button
                            className={s.playBtn}
                            onClick={(e) => {
                              e.stopPropagation();
                              setRegenHintMsgId(msg.id);
                              setRegenHintText('');
                            }}
                            title="Перегенерировать с инструкцией"
                            disabled={sending}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                            </svg>
                          </button>
                        )}
                      </>
                    )}
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
                    <AnimatePresence>
                      {msg.role === 'assistant' && msg.reasoning_content?.trim() && openReasoningId === msg.id && (
                        <motion.div
                          className={s.reasoningPanel}
                          variants={reasoningPanelVariants}
                          initial="hidden"
                          animate="visible"
                          exit="exit"
                        >
                          <MarkdownRenderer content={msg.reasoning_content} />
                        </motion.div>
                      )}
                      {msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0 && openToolCallsId === msg.id && (
                        <motion.div
                          className={s.reasoningPanel}
                          variants={reasoningPanelVariants}
                          initial="hidden"
                          animate="visible"
                          exit="exit"
                        >
                          {msg.tool_calls.map((tc, i) => (
                            <div key={tc.id || i} style={{ marginBottom: i < msg.tool_calls!.length - 1 ? '8px' : 0 }}>
                              <div style={{ fontWeight: 600, marginBottom: 2 }}>{tc.name}</div>
                              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.8 }}>
                                {typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments, null, 2)}
                              </pre>
                            </div>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
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
              {showTyping && (
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
              {/* Suggest Macro cards */}
              {pendingMacros.map((macro, macroIdx) => (
                <div key={macroIdx} className={s.suggestMacroCard}>
                  <div className={s.suggestMacroHeader}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="16 18 22 12 16 6" />
                      <polyline points="8 6 2 12 8 18" />
                    </svg>
                    <span className={s.suggestMacroTitle}>Предложение макроса</span>
                    <button
                      className={s.suggestMacroClose}
                      onClick={() => setPendingMacros(prev => prev.filter((_, i) => i !== macroIdx))}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                  <div className={s.suggestMacroName}>{macro.title}</div>
                  {macro.description && (
                    <div className={s.suggestMacroDesc}>{macro.description}</div>
                  )}
                  <div className={s.suggestMacroCommands}>
                    {macro.commands.map((cmd: string, i: number) => (
                      <code key={i} className={s.suggestMacroCmd}>{cmd}</code>
                    ))}
                  </div>
                  <div className={s.suggestMacroActions}>
                    <button
                      className={s.suggestMacroSaveBtn}
                      onClick={async () => {
                        try {
                          await api.apiFetch('/api/v1/macros', {
                            method: 'POST',
                            body: JSON.stringify({
                              title: macro.title,
                              description: macro.description || '',
                              commands: macro.commands,
                              enabled: true,
                              pinned: false,
                            }),
                          });
                          toast.success('Макрос сохранён в настройки');
                          setPendingMacros(prev => prev.filter((_, i) => i !== macroIdx));
                        } catch {
                          toast.error('Не удалось сохранить макрос');
                        }
                      }}
                    >
                      Сохранить в настройки
                    </button>
                    <button
                      className={s.suggestMacroDismissBtn}
                      onClick={() => setPendingMacros(prev => prev.filter((_, i) => i !== macroIdx))}
                    >
                      Отклонить
                    </button>
                  </div>
                </div>
              ))}

              {/* DevOps Confirmation cards */}
              {devopsConfirmations.map((conf, confIdx) => (
                <div key={confIdx} className={s.suggestMacroCard}>
                  <div className={s.suggestMacroHeader}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="2" width="20" height="20" rx="2" ry="2" />
                      <path d="M7 15h0M12 15h0M17 15h0" />
                    </svg>
                    <span className={s.suggestMacroTitle}>Подтверждение команды</span>
                    <button
                      className={s.suggestMacroClose}
                      onClick={() => setDevopsConfirmations(prev => prev.filter((_, i) => i !== confIdx))}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                  <div className={s.suggestMacroName}>{conf.server_name}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px' }}>{conf.host}</div>
                  <div className={s.suggestMacroCommands}>
                    <code className={s.suggestMacroCmd}>{conf.command}</code>
                  </div>
                  {conf.needs_new_password && (
                    <div style={{ marginTop: '8px', marginBottom: conf.needs_sudo_password ? '0' : '8px' }}>
                      <input
                        type="password"
                        placeholder="New password"
                        value={conf.new_password || ''}
                        onChange={(e) => setDevopsConfirmations(prev => prev.map((c, i) => i === confIdx ? { ...c, new_password: e.target.value } : c))}
                        style={{ fontSize: '12px', padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border-input)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', width: '100%' }}
                      />
                    </div>
                  )}
                  {conf.needs_sudo_password && (
                    <div style={{ marginTop: '8px', marginBottom: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <>
                          <input
                            type="password"
                            placeholder="Sudo пароль"
                            value={conf.sudo_password || ''}
                            onChange={(e) => setDevopsConfirmations(prev => prev.map((c, i) => i === confIdx ? { ...c, sudo_password: e.target.value } : c))}
                            style={{ fontSize: '12px', padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border-input)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none' }}
                          />
                          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-muted)', cursor: 'pointer', marginBottom: '6px' }}>
                            <input
                              className={s.devopsCheckbox}
                              type="checkbox"
                              checked={conf.save_sudo_password || false}
                              onChange={(e) => setDevopsConfirmations(prev => prev.map((c, i) => i === confIdx ? { ...c, save_sudo_password: e.target.checked } : c))}
                            />
                            Сохранить sudo пароль в настройках сервера
                          </label>
                      </>
                    </div>
                  )}
                  {conf._verdict && (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px', background: 'var(--bg-modal-hover)', borderRadius: '6px', marginTop: '6px' }}><MarkdownRenderer content={conf._verdict} /></div>
                  )}
                  <div className={s.suggestMacroActions}>
                    <button
                      className={s.suggestMacroSaveBtn}
                      onClick={async () => {
                        try {
                          const body: Record<string, unknown> = {
                            confirmation_id: conf.confirmation_id,
                            approved: true,
                          };
                          if (conf.needs_sudo_password) {
                            if (!conf.sudo_password?.trim()) {
                              toast.error('Введите sudo пароль');
                              return;
                            }
                            body.sudo_password = conf.sudo_password;
                            body.save_sudo_password = conf.save_sudo_password === true;
                          }
                          if (conf.needs_new_password) {
                            if (!conf.new_password?.trim()) {
                              toast.error('Enter new password');
                              return;
                            }
                            body.new_password = conf.new_password;
                          }
                          await api.apiFetch('/api/v1/devops/approve', {
                            method: 'POST',
                            body: JSON.stringify(body),
                          });
                          toast.success('Команда подтверждена');
                          setDevopsConfirmations(prev => prev.filter((_, i) => i !== confIdx));
                        } catch {
                          toast.error('Ошибка подтверждения');
                        }
                      }}
                    >
                      Разрешить
                    </button>
                    <button
                      className={s.suggestMacroSaveBtn}
                      style={{ background: 'var(--bg-modal-hover)', color: 'var(--text-primary)', border: '1px solid var(--border-input)' }}
                      onClick={async () => {
                        try {
                          if (conf.needs_sudo_password && !conf.sudo_password?.trim()) {
                            toast.error('Введите sudo пароль');
                            return;
                          }
                          if (conf.needs_new_password && !conf.new_password?.trim()) {
                            toast.error('Enter new password');
                            return;
                          }
                          // Create auto-approve policy for this exact command
                          const escapedCmd = conf.command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                          await api.apiFetch(`/api/v1/devops/servers/${conf.server_id}/policies`, {
                            method: 'POST',
                            body: JSON.stringify({ pattern: `^${escapedCmd}$`, auto_approve: true }),
                          });
                          // Also approve current command
                          const body: Record<string, unknown> = { confirmation_id: conf.confirmation_id, approved: true };
                          if (conf.needs_sudo_password) {
                            body.sudo_password = conf.sudo_password;
                            body.save_sudo_password = conf.save_sudo_password === true;
                          }
                          if (conf.needs_new_password) {
                            body.new_password = conf.new_password;
                          }
                          await api.apiFetch('/api/v1/devops/approve', {
                            method: 'POST',
                            body: JSON.stringify(body),
                          });
                          toast.success('Команда одобрена навсегда');
                          setDevopsConfirmations(prev => prev.filter((_, i) => i !== confIdx));
                        } catch {
                          toast.error('Ошибка сохранения политики');
                        }
                      }}
                    >
                      Разрешить всегда
                    </button>
                    <button
                      className={s.suggestMacroSaveBtn}
                      style={{ background: 'var(--bg-modal-hover)', color: 'var(--text-primary)', border: '1px solid var(--border-input)', opacity: conf._reviewing ? 0.6 : 1, minWidth: '80px' }}
                      onClick={async () => {
                        setDevopsConfirmations(prev => prev.map((c, i) => i === confIdx ? { ...c, _reviewing: true } : c));
                        try {
                          const res = await api.apiFetch<{ verdict: string }>('/api/v1/devops/runbooks/review-commands', {
                            method: 'POST',
                            body: JSON.stringify({ commands: [conf.command] }),
                          });
                          setDevopsConfirmations(prev => prev.map((c, i) => i === confIdx ? { ...c, _reviewing: false, _verdict: res.verdict } : c));
                        } catch {
                          toast.error('Не удалось проверить команду');
                          setDevopsConfirmations(prev => prev.map((c, i) => i === confIdx ? { ...c, _reviewing: false } : c));
                        }
                      }}
                    >
                      {conf._reviewing ? 'Проверяю...' : 'Проверить'}
                    </button>
                    <button
                      className={s.suggestMacroDismissBtn}
                      onClick={async () => {
                        try {
                          await api.apiFetch('/api/v1/devops/approve', {
                            method: 'POST',
                            body: JSON.stringify({ confirmation_id: conf.confirmation_id, approved: false }),
                          });
                        } catch {}
                        setDevopsConfirmations(prev => prev.filter((_, i) => i !== confIdx));
                      }}
                    >
                      Отклонить
                    </button>
                  </div>
                </div>
              ))}

              {/* PC Command Confirmation cards */}
              {pcCommandConfirmations.map((conf, confIdx) => (
                <div key={`pc-${confIdx}`} className={s.suggestMacroCard}>
                  <div className={s.suggestMacroHeader}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                      <line x1="8" y1="21" x2="16" y2="21" />
                      <line x1="12" y1="17" x2="12" y2="21" />
                    </svg>
                    <span className={s.suggestMacroTitle}>Команда на ПК</span>
                    <button
                      className={s.suggestMacroClose}
                      onClick={() => setPcCommandConfirmations(prev => prev.filter((_, i) => i !== confIdx))}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                  <div className={s.suggestMacroCommands}>
                    <code className={s.suggestMacroCmd}>{conf.command}</code>
                  </div>
                  {conf._verdict && (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px', background: 'var(--bg-modal-hover)', borderRadius: '6px', marginTop: '6px' }}><MarkdownRenderer content={conf._verdict} /></div>
                  )}
                  <div className={s.suggestMacroActions}>
                    <button
                      className={s.suggestMacroSaveBtn}
                      onClick={async () => {
                        try {
                          await api.apiFetch('/api/v1/pc-commands/approve', {
                            method: 'POST',
                            body: JSON.stringify({ confirmation_id: conf.confirmation_id, approved: true }),
                          });
                          toast.success('Команда выполнена');
                          setPcCommandConfirmations(prev => prev.filter((_, i) => i !== confIdx));
                        } catch {
                          toast.error('Ошибка выполнения');
                        }
                      }}
                    >
                      Разрешить
                    </button>
                    <button
                      className={s.suggestMacroSaveBtn}
                      style={{ background: 'var(--bg-modal-hover)', color: 'var(--text-primary)', border: '1px solid var(--border-input)' }}
                      onClick={async () => {
                        try {
                          // Create auto-approve policy for this exact command
                          const escapedCmd = conf.command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                          await api.apiFetch('/api/v1/pc-commands/policies', {
                            method: 'POST',
                            body: JSON.stringify({ pattern: `^${escapedCmd}$` }),
                          });
                          // Also approve current command
                          await api.apiFetch('/api/v1/pc-commands/approve', {
                            method: 'POST',
                            body: JSON.stringify({ confirmation_id: conf.confirmation_id, approved: true }),
                          });
                          toast.success('Команда одобрена навсегда');
                          setPcCommandConfirmations(prev => prev.filter((_, i) => i !== confIdx));
                        } catch {
                          toast.error('Ошибка сохранения политики');
                        }
                      }}
                    >
                      Разрешить всегда
                    </button>
                    <button
                      className={s.suggestMacroSaveBtn}
                      style={{ background: 'var(--bg-modal-hover)', color: 'var(--text-primary)', border: '1px solid var(--border-input)', opacity: conf._reviewing ? 0.6 : 1, minWidth: '80px' }}
                      onClick={async () => {
                        setPcCommandConfirmations(prev => prev.map((c, i) => i === confIdx ? { ...c, _reviewing: true } : c));
                        try {
                          const res = await api.apiFetch<{ verdict: string }>('/api/v1/devops/runbooks/review-commands', {
                            method: 'POST',
                            body: JSON.stringify({ commands: [conf.command] }),
                          });
                          setPcCommandConfirmations(prev => prev.map((c, i) => i === confIdx ? { ...c, _reviewing: false, _verdict: res.verdict } : c));
                        } catch {
                          toast.error('Не удалось проверить команду');
                          setPcCommandConfirmations(prev => prev.map((c, i) => i === confIdx ? { ...c, _reviewing: false } : c));
                        }
                      }}
                    >
                      {conf._reviewing ? 'Проверяю...' : 'Проверить'}
                    </button>
                    <button
                      className={s.suggestMacroDismissBtn}
                      onClick={async () => {
                        try {
                          await api.apiFetch('/api/v1/pc-commands/approve', {
                            method: 'POST',
                            body: JSON.stringify({ confirmation_id: conf.confirmation_id, approved: false }),
                          });
                        } catch {}
                        setPcCommandConfirmations(prev => prev.filter((_, i) => i !== confIdx));
                      }}
                    >
                      Отклонить
                    </button>
                  </div>
                </div>
              ))}

              {/* Suggest DevOps Runbook cards */}
              {pendingRunbooks.map((rb, rbIdx) => (
                <div key={rbIdx} className={s.suggestMacroCard}>
                  <div className={s.suggestMacroHeader}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                    </svg>
                    <span className={s.suggestMacroTitle}>Предложение инструкции</span>
                    <button
                      className={s.suggestMacroClose}
                      onClick={() => setPendingRunbooks(prev => prev.filter((_, i) => i !== rbIdx))}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                  <div className={s.suggestMacroName}>{rb.title}</div>
                  {rb.commands.length > 0 && (
                    <div className={s.suggestMacroCommands}>
                      {rb.commands.map((cmd: string, i: number) => (
                        <code key={i} className={s.suggestMacroCmd}>{cmd}</code>
                      ))}
                    </div>
                  )}
                  {rb._verdict && (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px', background: 'var(--bg-modal-hover)', borderRadius: '6px', marginTop: '6px' }}><MarkdownRenderer content={rb._verdict} /></div>
                  )}
                  <div className={s.suggestMacroActions}>
                    <button
                      className={s.suggestMacroSaveBtn}
                      onClick={async () => {
                        try {
                          await api.apiFetch('/api/v1/devops/runbooks', {
                            method: 'POST',
                            body: JSON.stringify({
                              title: rb.title,
                              content: rb.content,
                              commands: rb.commands,
                            }),
                          });
                          toast.success('Инструкция сохранена');
                          setPendingRunbooks(prev => prev.filter((_, i) => i !== rbIdx));
                        } catch {
                          toast.error('Не удалось сохранить инструкцию');
                        }
                      }}
                    >
                      Сохранить
                    </button>
                    <button
                      className={s.suggestMacroSaveBtn}
                      style={{ background: 'var(--bg-modal-hover)', color: 'var(--text-primary)', border: '1px solid var(--border-input)', opacity: rb._reviewing ? 0.6 : 1 }}
                      onClick={async () => {
                        setPendingRunbooks(prev => prev.map((r, i) => i === rbIdx ? { ...r, _reviewing: true } : r));
                        try {
                          const res = await api.apiFetch<{ verdict: string }>('/api/v1/devops/runbooks/review-commands', {
                            method: 'POST',
                            body: JSON.stringify({ commands: rb.commands }),
                          });
                          setPendingRunbooks(prev => prev.map((r, i) => i === rbIdx ? { ...r, _reviewing: false, _verdict: res.verdict } : r));
                        } catch {
                          toast.error('Не удалось проверить команды');
                          setPendingRunbooks(prev => prev.map((r, i) => i === rbIdx ? { ...r, _reviewing: false } : r));
                        }
                      }}
                    >
                      {rb._reviewing ? 'Проверяю...' : 'Проверить'}
                    </button>
                    <button
                      className={s.suggestMacroDismissBtn}
                      onClick={() => setPendingRunbooks(prev => prev.filter((_, i) => i !== rbIdx))}
                    >
                      Отклонить
                    </button>
                  </div>
                </div>
              ))}

              {/* Suggest Server Creds Update cards */}
              {pendingCredsUpdates.map((upd, updIdx) => (
                <div key={`creds-${updIdx}`} className={s.suggestMacroCard}>
                  <div className={s.suggestMacroHeader}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    </svg>
                    <span className={s.suggestMacroTitle}>Смена учётных данных</span>
                    <button
                      className={s.suggestMacroClose}
                      onClick={() => setPendingCredsUpdates(prev => prev.filter((_, i) => i !== updIdx))}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                  <div className={s.suggestMacroName}>{upd.server_name}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-body)', marginTop: '6px', lineHeight: '1.5' }}>
                    <div>{upd.reason}</div>
                    <div style={{ marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Пользователь:</span>
                        <code style={{ fontSize: '11px', color: 'var(--danger, #e53935)', textDecoration: 'line-through' }}>{upd.current_username}</code>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>
                        <code style={{ fontSize: '11px', color: 'var(--accent)' }}>{upd.new_username}</code>
                      </div>
                      {upd.use_ssh_key && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Авторизация:</span>
                          <span style={{ fontSize: '11px', color: 'var(--accent)' }}>SSH-ключ</span>
                        </div>
                      )}
                      {upd.remove_password && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Пароль:</span>
                          <span style={{ fontSize: '11px', color: 'var(--danger, #e53935)' }}>будет удалён</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className={s.suggestMacroActions}>
                    <button
                      className={s.suggestMacroSaveBtn}
                      onClick={async () => {
                        try {
                          if (upd.confirmation_id) {
                            await api.apiFetch('/api/v1/devops/approve', {
                              method: 'POST',
                              body: JSON.stringify({ confirmation_id: upd.confirmation_id, approved: true }),
                            });
                          } else {
                            const body: Record<string, unknown> = {
                              username: upd.new_username,
                              use_ssh_key_for_login: upd.use_ssh_key,
                            };
                            if (upd.remove_password) body.password = '';
                            await api.apiFetch(`/api/v1/devops/servers/${upd.server_id}`, {
                              method: 'PUT',
                              body: JSON.stringify(body),
                            });
                          }
                          toast.success(`Учётные данные для "${upd.server_name}" обновлены`);
                          setPendingCredsUpdates(prev => prev.filter((_, i) => i !== updIdx));
                        } catch (err: any) {
                          toast.error(err?.body?.error || 'Ошибка обновления кредов');
                        }
                      }}
                    >
                      Применить
                    </button>
                    <button
                      className={s.suggestMacroDismissBtn}
                      onClick={async () => {
                        if (upd.confirmation_id) {
                          try {
                            await api.apiFetch('/api/v1/devops/approve', {
                              method: 'POST',
                              body: JSON.stringify({ confirmation_id: upd.confirmation_id, approved: false }),
                            });
                          } catch {}
                        }
                        setPendingCredsUpdates(prev => prev.filter((_, i) => i !== updIdx));
                      }}
                    >
                      Отклонить
                    </button>
                  </div>
                </div>
              ))}

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
                <button className={s.contextMenuItem} onClick={() => handleSendToTelegram(msgMenuId)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                  Отправить в Telegram
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

              {sending ? (
                <svg
                  className={s.sendIcon}
                  onClick={() => { api.stopChatStream(); }}
                  viewBox="0 0 24 24" fill="var(--accent-icon-light)" stroke="none"
                >
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              ) : (
              <svg
                className={!input.trim() && attachedImages.length === 0 ? s.sendIconDisabled : s.sendIcon}
                onClick={() => { if (input.trim() || attachedImages.length > 0) handleSend(); }}
                viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon-light)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              >
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
              )}

              <svg
                className={isTranscribing ? s.micIconTranscribing : isRecording ? s.micIconRecording : s.micIcon}
                onClick={isTranscribing ? undefined : toggleRecording}
                viewBox="0 0 24 24"
                fill="none"
                stroke={isRecording ? '#e53935' : isTranscribing ? 'var(--accent)' : 'var(--accent-icon-light)'}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
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

        <ConfirmDialog
          open={deletingChatId !== null}
          title="Удалить чат?"
          text="Это действие нельзя отменить. Все сообщения будут удалены безвозвратно."
          onCancel={() => setDeletingChatId(null)}
          onConfirm={handleConfirmDelete}
        />

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
