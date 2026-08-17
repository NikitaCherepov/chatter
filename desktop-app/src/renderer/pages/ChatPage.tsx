import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { toast } from 'sonner';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useAuth } from '../lib/auth';
import { useUnreadChats } from '../lib/useUnreadChats';
import * as api from '../lib/api';
import { generateDocxBlob, generateChatDocxBlob } from '../lib/markdownToDocx';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { AttachModal, prepareAttachmentFiles } from '../components/AttachModal';
import { RejectWithComment } from '../components/RejectWithComment';
import { FileEditDiff } from '../components/FileEditDiff/FileEditDiff';
import type { ImageItem, DocumentItem } from '../components/AttachModal';
import { Select } from '../components/Select';
import { PromptSelector, type PromptOption } from '../components/PromptSelector';
import Slider from '../components/Slider';
import { SettingsModal } from '../components/SettingsModal';
import { Tooltip } from '../components/Tooltip';
import { PixelAvatar, dispatchAvatarState, startAvatarLoop, stopAvatarLoop, getAvatarManifest } from '../components/PixelAvatar';
import type { SetDisplayStatePayload } from '../components/PixelAvatar';
import { ToolsPanel } from '../components/ToolsPanel';
import { QuotaWidget } from '../components/QuotaWidget';
import { openTool, handleDesktopAction, dispatchMapData, emitSuggestMacro, setToolsPanelState } from '../lib/tools';
import { createSpeechRecorder } from '../lib/speechRecorder';
import { startWakeWordAudioStream, stopWakeWordAudioStream } from '../lib/wakeWordAudio';
import { getWakeWordEnabled } from '../lib/wakeWordToggle';
import { ttsSpeak, ttsStop, ttsSubscribe, playSfx } from '../lib/tts';
import { getSpeechRecognitionLanguage } from '../lib/speechRecognition';
import { getRenderPerfBudget, getRenderPerfStep } from '../lib/renderPerf';
import {
  DEFAULT_MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES,
  prepareImageForUpload,
} from '../lib/imageCompression';
import s from './ChatPage.module.scss';

function DemoDraggableChat({
  chatId,
  children,
}: {
  chatId: number;
  children: (dragHandleProps: any, isDragging: boolean) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `demo-chat-${chatId}`,
    data: { chatId },
  });

  return (
    <div
      ref={setNodeRef}
      className={`${s.demoDraggableChat} ${isDragging ? s.demoDraggableChatDragging : ''}`}
    >
      {children({ ...attributes, ...listeners }, isDragging)}
    </div>
  );
}

function DemoDroppableFolder({
  folderId,
  children,
}: {
  folderId: number | 'unfiled';
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `demo-folder-${folderId}`,
    data: { folderId },
  });

  return (
    <div
      ref={setNodeRef}
      className={`${s.demoDropTarget} ${folderId === 'unfiled' ? s.demoUnfiledTarget : ''} ${isOver ? s.demoDropTargetOver : ''}`}
    >
      {children}
    </div>
  );
}

function DemoDraggableRoomParticipant({
  participantId,
  children,
}: {
  participantId: number;
  children: (dragHandleProps: any) => React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef: setDraggableNodeRef,
    isDragging,
  } = useDraggable({
    id: `room-participant-drag-${participantId}`,
    data: { participantId },
  });
  const {
    setNodeRef: setDroppableNodeRef,
    isOver,
  } = useDroppable({
    id: `room-participant-drop-${participantId}`,
    data: { participantId },
  });

  return (
    <div
      ref={(node) => {
        setDraggableNodeRef(node);
        setDroppableNodeRef(node);
      }}
      className={`${s.roomParticipantCard} ${isDragging ? s.roomParticipantCardDragging : ''} ${isOver && !isDragging ? s.roomParticipantCardDropTarget : ''}`}
    >
      {children({ ...attributes, ...listeners })}
    </div>
  );
}

const chatFolderCollisionDetection: CollisionDetection = (args) => {
  const pointerHits = pointerWithin(args);
  return pointerHits.length > 0 ? pointerHits : closestCenter(args);
};

type ChatSectionKey = `folder:${number}` | 'unfiled';
type ChatSectionPaging = {
  offset: number;
  total: number;
  hasMore: boolean;
  loading: boolean;
};

function ChatSectionSentinel({
  disabled,
  onVisible,
}: {
  disabled: boolean;
  onVisible: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;

  useEffect(() => {
    const element = ref.current;
    if (!element || disabled) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) onVisibleRef.current();
    }, { rootMargin: '160px 0px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [disabled]);

  return <div ref={ref} aria-hidden="true" style={{ height: 1 }} />;
}

function FolderIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 9C4 7.11438 4 6.17157 4.58579 5.58579C5.17157 5 6.11438 5 8 5H8.34315C9.16065 5 9.5694 5 9.93694 5.15224C10.3045 5.30448 10.5935 5.59351 11.1716 6.17157L11.8284 6.82843C12.4065 7.40649 12.6955 7.69552 13.0631 7.84776C13.4306 8 13.8394 8 14.6569 8H16C17.8856 8 18.8284 8 19.4142 8.58579C20 9.17157 20 10.1144 20 12V15C20 16.8856 20 17.8284 19.4142 18.4142C18.8284 19 17.8856 19 16 19H8C6.11438 19 5.17157 19 4.58579 18.4142C4 17.8284 4 16.8856 4 15V9Z"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}

function FolderAddIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M19 14V12C19 10.1144 19 9.17157 18.4142 8.58579C17.8284 8 16.8856 8 15 8H13.6569C12.8394 8 12.4306 8 12.0631 7.84776C11.6955 7.69552 11.4065 7.40649 10.8284 6.82843L10.1716 6.17157C9.59351 5.59351 9.30448 5.30448 8.93694 5.15224C8.5694 5 8.16065 5 7.34315 5H7C5.11438 5 4.17157 5 3.58579 5.58579C3 6.17157 3 7.11438 3 9V15C3 16.8856 3 17.8284 3.58579 18.4142C4.17157 19 5.11438 19 7 19H14"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path d="M16 19H22M19 16V22" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

const ALLOWED_FORMATS: string[] = (() => {
  const raw = import.meta.env.VITE_ALLOWED_IMAGE_FORMATS || '';
  if (!raw.trim()) {
    return ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  }
  return raw.split(',').map((f: string) => f.trim()).filter(Boolean);
})();

const MESSAGE_PAGE_SIZE = 50;
const CHAT_PAGE_SIZE = 25;
/**
 * Minimum number of messages always shown, regardless of character budget.
 */
const MIN_VISIBLE_MESSAGES = 8;

const reasoningPanelVariants = {
  hidden: { opacity: 0, y: -16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' as const } },
  exit: { opacity: 0, y: -16, transition: { duration: 0.15 } },
};

const formatMessageTime = (ts: number, locale?: string) => {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
};

const formatToolValue = (value: unknown) => {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return JSON.stringify(value, null, 2);
};

const cleanNotificationText = (value: string, maxLength = 240) => {
  const clean = value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`>#-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1).trimEnd()}…`;
};

type MessageItemProps = {
  msg: api.Message;
  isLastAssistant: boolean;
  isTtsPlaying: boolean;
  isReasoningOpen: boolean;
  isToolCallsOpen: boolean;
  isSubagentsOpen: boolean;
  isRegenHintOpen: boolean;
  isEditing: boolean;
  streamingState: 'idle' | 'reasoning' | 'content' | 'done';
  editingText: string;
  sending: boolean;
  regenHintText: string;
  showTokens: boolean;
  resolveImageUrl: (url: string) => string;
  onSetMessages: React.Dispatch<React.SetStateAction<api.Message[]>>;
  onSetViewerImageSrc: (src: string, messageId?: number, url?: string) => void;
  onDownloadImage: (src: string) => void;
  onToggleReasoning: (messageId: number) => void;
  onToggleToolCalls: (messageId: number) => void;
  onToggleSubagents: (messageId: number) => void;
  onRegenerate: (messageId: number) => void;
  onOpenRegenHint: (messageId: number) => void;
  onCloseRegenHint: () => void;
  onSetRegenHintText: (value: string) => void;
  onRegenerateWithHint: (messageId: number, hint: string) => void;
  onMsgKebabClick: (e: React.MouseEvent, messageId: number) => void;
  onSetEditingText: (value: string) => void;
  onSaveEdit: (messageId: number) => void;
  onCancelEdit: () => void;
  onDeleteAttachment: (messageId: number, filename: string) => void;
  onDeleteImage: (messageId: number, url: string) => void;
};

const MessageItem = React.memo(function MessageItem({
  msg,
  isLastAssistant,
  isTtsPlaying,
  isReasoningOpen,
  isToolCallsOpen,
  isSubagentsOpen,
  isRegenHintOpen,
  isEditing,
  streamingState,
  editingText,
  sending,
  regenHintText,
  showTokens,
  resolveImageUrl,
  onSetMessages,
  onSetViewerImageSrc,
  onDownloadImage,
  onToggleReasoning,
  onToggleToolCalls,
  onToggleSubagents,
  onRegenerate,
  onOpenRegenHint,
  onCloseRegenHint,
  onSetRegenHintText,
  onRegenerateWithHint,
  onMsgKebabClick,
  onSetEditingText,
  onSaveEdit,
  onCancelEdit,
  onDeleteAttachment,
  onDeleteImage,
}: MessageItemProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language;
  const reasoningOpen = isReasoningOpen;
  const hasReasoning = msg.role === 'assistant' && Boolean(msg.reasoning_content?.trim());
  const hasToolCalls = msg.role === 'assistant' && Boolean(msg.tool_calls?.length);
  const hasSubagents = msg.role === 'assistant' && Boolean(msg.subagents?.length);
  const isStreamingReasoning = streamingState === 'reasoning';
  const isStreamingContent = streamingState === 'content';
  const exactAssistantTokens = msg.role === 'assistant'
    ? msg.usage?.aggregate.completion_tokens
    : undefined;
  const displayedTokenCount = exactAssistantTokens && exactAssistantTokens > 0
    ? exactAssistantTokens
    : msg.token_count;

  return (
    <div className={`${s.messageGroup} ${reasoningOpen || isToolCallsOpen || isSubagentsOpen ? s.messageGroupRaised : ''} ${msg.archived ? s.messageArchived : ''}`}>
      <div className={s.metaRow}>
        <span>{msg.role === 'user' ? t('chat.message.you') : (msg.prompt_name || 'Chatter')} &bull; {formatMessageTime(msg.created_at, locale)}{msg.archived ? t('chat.message.archivedSuffix') : ''}</span>
        <button
          className={`${s.playBtn} ${isTtsPlaying ? s.playBtnPlaying : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            ttsSpeak(msg.id, msg.content, msg.audio, (id, audio) => {
              onSetMessages(prev => prev.map(m => m.id === id ? { ...m, audio } : m));
            });
          }}
          title={isTtsPlaying ? t('chat.message.stopSpeaking') : t('chat.message.speak')}
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
          isStreamingReasoning ? (
            <button
              className={`${s.reasoningToggle} ${s.reasoningToggleStreaming} ${reasoningOpen ? s.reasoningToggleOpen : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggleReasoning(msg.id);
              }}
              title={reasoningOpen ? t('chat.message.hideReasoning') : t('chat.message.showReasoning')}
            >
              <span className={s.streamingLabel}>{t('chat.message.reasoning')}</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          ) : (
          <button
            className={`${s.reasoningToggle} ${reasoningOpen ? s.reasoningToggleOpen : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleReasoning(msg.id);
            }}
            title={reasoningOpen ? t('chat.message.hideReasoning') : t('chat.message.showReasoning')}
          >
            <span>{t('chat.message.reasoningLabel')}{showTokens && typeof msg.reasoning_tokens === 'number' && msg.reasoning_tokens > 0 ? ` · ${msg.reasoning_tokens} tk` : ''}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          )
        )}
        {hasToolCalls && (
          <button
            className={`${s.reasoningToggle} ${isToolCallsOpen ? s.reasoningToggleOpen : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleToolCalls(msg.id);
            }}
            title={isToolCallsOpen ? t('chat.message.hideTools') : t('chat.message.showTools')}
          >
            <span>{msg.tool_calls!.length} {msg.tool_calls!.length === 1 ? t('chat.message.tool_one') : msg.tool_calls!.length < 5 ? t('chat.message.tool_few') : t('chat.message.tool_many')}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        )}
        {hasSubagents && (
          <button
            className={`${s.reasoningToggle} ${isSubagentsOpen ? s.reasoningToggleOpen : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSubagents(msg.id);
            }}
            title={isSubagentsOpen ? t('chat.message.hideSubagents') : t('chat.message.showSubagents')}
          >
            <span>{msg.subagents!.length} {msg.subagents!.length === 1 ? t('chat.message.subagent_one') : msg.subagents!.length < 5 ? t('chat.message.subagent_few') : t('chat.message.subagent_many')}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        )}
        {isLastAssistant && (
          <>
            <button className={s.playBtn} onClick={(e) => { e.stopPropagation(); onRegenerate(msg.id); }} title={t('chat.message.regenerate')} disabled={sending}>
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
                    placeholder={t('chat.message.regenerateHintPlaceholder')}
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
                    title={t('common.send')}
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
                title={t('chat.message.regenerateWithHint')}
                disabled={sending}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
            )}
          </>
        )}
        {(msg.role === 'assistant' && msg.model_name) || (showTokens && typeof displayedTokenCount === 'number' && displayedTokenCount > 0) ? (
          <span className={s.messageUsageMeta}>
            {msg.role === 'assistant' && msg.model_name && (
              <span className={s.modelBadge} title={msg.provider_name || undefined}>{msg.model_name}</span>
            )}
            {showTokens && typeof displayedTokenCount === 'number' && displayedTokenCount > 0 && (
              <span
                className={s.tokenBadge}
                title={exactAssistantTokens && exactAssistantTokens > 0
                  ? t('chat.message.providerTokenUsage')
                  : t('chat.message.localTokenEstimate')}
              >
                {displayedTokenCount} tk
              </span>
            )}
          </span>
        ) : null}
      </div>
      <div className={s.bubbleWrap}>
        <div className={msg.role === 'user' ? s.bubbleUser : s.bubble}>
          {msg.images && msg.images.length > 0 && (
            <div className={s.messageImages}>
              {msg.images.map((img, i) => {
                const src = resolveImageUrl(img.url);
                return (
                  <div key={i} className={s.messageImageWrap}>
                    <img className={s.messageImage} src={src} alt={img.type === 'generated' ? t('chat.image.generatedAlt') : t('chat.image.photoAlt')} loading="lazy" onClick={() => onSetViewerImageSrc(src, msg.id, img.url)} />
                    {msg.id > 0 && <button className={s.messageImageDelete} onClick={(e) => { e.stopPropagation(); onDeleteImage(msg.id, img.url); }} title={t('common.delete')}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>}
                    <button className={s.messageImageDownload} onClick={(e) => { e.stopPropagation(); onDownloadImage(src); }} title={t('common.download')}>
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
          {msg.attachments && msg.attachments.length > 0 && (
            <div className={s.messageImages}>
              {msg.attachments.map((att, i) => {
                const downloadUrl = att.url ? resolveImageUrl(att.url) : null;
                return (
                  <div key={i} className={s.attachmentCard}>
                    <div className={s.attachmentIcon}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                    </div>
                    <div className={s.attachmentInfo}>
                      <span className={s.attachmentName}>{att.name}</span>
                      <span className={s.attachmentSize}>{att.size_bytes < 1024 * 1024 ? `${(att.size_bytes / 1024).toFixed(1)} KB` : `${(att.size_bytes / (1024 * 1024)).toFixed(1)} MB`}</span>
                    </div>
                    {downloadUrl && (
                      <button className={s.attachmentDownload} onClick={(e) => { e.stopPropagation(); onDownloadImage(downloadUrl); }} title={t('common.download')}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="7 10 12 15 17 10" />
                          <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                      </button>
                    )}
                    {msg.id > 0 && att.filename && (
                      <button className={s.attachmentDelete} onClick={(e) => { e.stopPropagation(); onDeleteAttachment(msg.id, att.filename); }} title={t('common.delete')}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {isEditing ? (
            <div className={s.editWrap}>
              <textarea
                className={s.editTextarea}
                value={editingText}
                onChange={(e) => onSetEditingText(e.target.value)}
                autoFocus
                ref={(el) => {
                  if (el) {
                    el.style.height = 'auto';
                    el.style.height = `${el.scrollHeight}px`;
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    onSaveEdit(msg.id);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    onCancelEdit();
                  }
                }}
              />
              <div className={s.editActions}>
                <button className={s.editSaveBtn} onClick={() => onSaveEdit(msg.id)}>{t('common.save')}</button>
                <button className={s.editCancelBtn} onClick={onCancelEdit}>{t('common.cancel')}</button>
              </div>
            </div>
          ) : (
            msg.role === 'assistant'
              ? (
                isStreamingReasoning && !msg.content ? (
                  <div className={`${s.typingDots} ${s.typingDotsStreaming}`}>
                    <span className={s.dot} />
                    <span className={s.dot} />
                    <span className={s.dot} />
                  </div>
                ) : (
                  <div className={`${s.bubbleText} ${isStreamingContent ? s.bubbleTextStreaming : ''}`}><MarkdownRenderer content={msg.content} /></div>
                )
              )
              : <div className={s.bubbleTextPlain}>{msg.content}</div>
          )}
        </div>
        <AnimatePresence>
          {hasReasoning && reasoningOpen && (
            <motion.div className={`${s.reasoningPanel} ${isStreamingReasoning || isStreamingContent ? s.bubbleTextStreaming : ''}`} variants={reasoningPanelVariants} initial="hidden" animate="visible" exit="exit">
              <MarkdownRenderer content={msg.reasoning_content || ''} />
            </motion.div>
          )}
          {hasToolCalls && isToolCallsOpen && (
            <motion.div className={s.reasoningPanel} variants={reasoningPanelVariants} initial="hidden" animate="visible" exit="exit">
              <div className={s.toolCallList}>
                {msg.tool_calls!.map((tc, i) => {
                  const args = formatToolValue(tc.arguments);
                  const result = formatToolValue(tc.result_preview);
                  return (
                    <div key={tc.id || i} className={s.toolCallItem}>
                      <div className={s.toolCallName}>{tc.name}</div>
                      <div className={s.toolCallLabel}>{t('chat.message.arguments')}</div>
                      <pre className={s.toolCallArgs}>{args || '{}'}</pre>
                      {result && (
                        <>
                          <div className={s.toolCallLabel}>{t('chat.message.result')}</div>
                          <pre className={s.toolCallArgs}>{result}</pre>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </motion.div>
          )}
          {hasSubagents && isSubagentsOpen && (
            <motion.div className={s.reasoningPanel} variants={reasoningPanelVariants} initial="hidden" animate="visible" exit="exit">
              <div className={s.toolCallList}>
                {msg.subagents!.map((sa, i) => {
                  const totalToolCalls = sa.iterations?.reduce((sum, it) => sum + (it.tool_calls?.length || 0), 0) ?? 0;
                  return (
                    <div key={i} className={s.toolCallItem}>
                      <div className={s.toolCallName}>{t('chat.message.subagentNumber', { number: i + 1 })}{sa.aborted ? t('chat.message.interruptedSuffix') : ''}</div>
                      <div className={s.toolCallLabel}>{t('chat.message.task')}</div>
                      <pre className={s.toolCallArgs}>{sa.task}</pre>
                      <div className={s.toolCallLabel}>{t('chat.message.systemPrompt')}</div>
                      <pre className={s.toolCallArgs}>{sa.system_prompt.slice(0, 500)}{sa.system_prompt.length > 500 ? '…' : ''}</pre>
                      <div className={s.toolCallLabel}>{t('chat.message.tools')} ({sa.tools.length})</div>
                      <pre className={s.toolCallArgs}>{sa.tools.join(', ')}</pre>
                      <div className={s.toolCallLabel}>{t('chat.message.completedTools')} ({totalToolCalls})</div>
                      {showTokens && sa.usage?.aggregate && (
                        <div className={s.toolCallLabel} title={t('chat.message.providerTokenUsage')}>
                          {sa.usage.aggregate.total_tokens.toLocaleString(locale)} tk
                          {sa.usage.calls?.[0]?.model ? ` · ${sa.usage.calls[0].model}` : ''}
                        </div>
                      )}
                      {sa.iterations?.map((iter, j) => (
                        <div key={j} style={{ marginTop: 4 }}>
                          {iter.content && (
                            <>
                              <div className={s.toolCallLabel} style={{ opacity: 0.6 }}>{t('chat.message.stepWithText', { step: iter.step })}</div>
                              <pre className={s.toolCallArgs} style={{ opacity: 0.7 }}>{iter.content.slice(0, 500)}{iter.content.length > 500 ? '…' : ''}</pre>
                            </>
                          )}
                          {iter.tool_calls?.map((tc, k) => {
                            const args = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {}, null, 2);
                            const result = iter.results?.find(r => (tc.id && r.id === tc.id) || r.name === tc.name);
                            const resultText = result?.content || '';
                            return (
                              <div key={k} style={{ marginTop: 2 }}>
                                <div className={s.toolCallLabel}>{t('chat.message.step', { step: iter.step })} · {tc.name}</div>
                                <pre className={s.toolCallArgs}>{formatToolValue(args) || '{}'}</pre>
                                {resultText && (
                                  <>
                                    <div className={s.toolCallLabel} style={{ opacity: 0.6 }}>{t('chat.message.result')}</div>
                                    <pre className={s.toolCallArgs} style={{ opacity: 0.8 }}>{formatToolValue(resultText.slice(0, 250))}{resultText.length > 250 ? `\n...[truncated ${resultText.length - 250} chars]` : ''}</pre>
                                  </>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ))}
                      <div className={s.toolCallLabel}>{t('chat.message.answer')}</div>
                      <pre className={s.toolCallArgs}>{sa.answer.slice(0, 1000)}{sa.answer.length > 1000 ? '…' : ''}</pre>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <button className={s.msgKebabBtn} onClick={(e) => onMsgKebabClick(e, msg.id)} title={t('common.actions')}>
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

export function ChatPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language;
  const { user, setUser, logout } = useAuth();
  const navigate = useNavigate();
  const showTokens = user?.ui_settings?.show_tokens !== false;
  const diceRollEnabled = Boolean(user?.ui_settings?.dice_roll_enabled);

  // ── Token-streaming infrastructure ──
  // Глобальный буфер для стрим-токенов. Переиспользуется между обычной отправкой,
  // regenerate и regenerate-with-hint. Каждая новая генерация вызывает
  // streamAppenderRef.current.reset() перед началом.
  //
  // rAF-троттлинг группирует множество setState-обновлений в одно на кадр,
  // чтобы избежать дребезга при ~20 FPS потока токенов от бэкенда.
  const streamAppenderRef = useRef({
    textBuffer: '',
    reasoningBuffer: '',
    rafScheduled: false,
    tempAssistantId: 0,
    assistantMsgCreated: false,
    setShowTyping: ((_v: boolean) => {}) as (v: boolean) => void,
    setMessages: ((_updater: (prev: api.Message[]) => api.Message[]) => []) as React.Dispatch<React.SetStateAction<api.Message[]>>,
    rafId: 0 as number | null,

    reset(tempAssistantId: number, setShowTypingFn: (v: boolean) => void, setMessagesFn: React.Dispatch<React.SetStateAction<api.Message[]>>) {
      // Если был запланирован rAF — сбрасываем, иначе старый flush может запуститься после reset
      if (this.rafId !== null) cancelAnimationFrame(this.rafId);
      this.textBuffer = '';
      this.reasoningBuffer = '';
      this.rafScheduled = false;
      this.tempAssistantId = tempAssistantId;
      this.assistantMsgCreated = false;
      this.setShowTyping = setShowTypingFn;
      this.setMessages = setMessagesFn;
      this.rafId = null;
    },

    flush() {
      this.rafScheduled = false;
      this.rafId = null;
      const text = this.textBuffer;
      const reasoning = this.reasoningBuffer;
      this.textBuffer = '';
      this.reasoningBuffer = '';
      if (!text && !reasoning) return;

      if (!this.assistantMsgCreated) {
        this.assistantMsgCreated = true;
        this.setShowTyping(false);
        const initText = text;
        const initReasoning = reasoning || undefined;
        this.setMessages((prev) => [...prev, {
          id: this.tempAssistantId,
          role: 'assistant' as const,
          content: initText,
          reasoning_content: initReasoning ?? null,
          created_at: Math.floor(Date.now() / 1000),
        }]);
        return;
      }

      const tid = this.tempAssistantId;
      const dt = text;
      const dr = reasoning;
      this.setMessages((prev) => prev.map(m => {
        if (m.id !== tid) return m;
        const next: api.Message = { ...m };
        if (dt) next.content = (m.content || '') + dt;
        if (dr) next.reasoning_content = (m.reasoning_content || '') + dr;
        return next;
      }));
    },

    scheduleFlush() {
      if (this.rafScheduled) return;
      this.rafScheduled = true;
      this.rafId = requestAnimationFrame(() => this.flush());
    },

    appendText(text: string) {
      if (!text) return;
      this.textBuffer += text;
      this.scheduleFlush();
    },

    appendReasoning(text: string) {
      if (!text) return;
      this.reasoningBuffer += text;
      this.scheduleFlush();
    },

    /** Принудительный синхронный flush — вызвать перед onDone/onError. */
    flushNow() {
      if (this.rafId !== null) cancelAnimationFrame(this.rafId);
      this.rafId = null;
      this.rafScheduled = false;
      this.flush();
    },
  });

  const [chats, setChats] = useState<api.ChatInfo[]>([]);
  const [activeChatId, setActiveChatId] = useState<number | null>(null);
  const activeChatIdRef = useRef<number | null>(activeChatId);
  activeChatIdRef.current = activeChatId;
  const { unreadByChat, incrementUnread, markAsRead, getUnread } = useUnreadChats();
  const [messages, setMessages] = useState<api.Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [showTyping, setShowTyping] = useState(false);
  /**
   * Стриминг-стейт. Храним и в ref (для чтения в колбеках без stale closure),
   * и в state (для ре-рендера UI).
   */
  const streamingStateRef = useRef<'idle' | 'reasoning' | 'content' | 'done'>('idle');
  const streamingMsgIdRef = useRef<number | null>(null);
  const [streamingState, setStreamingStateRaw] = useState<'idle' | 'reasoning' | 'content' | 'done'>('idle');
  const [streamingMsgId, setStreamingMsgIdRaw] = useState<number | null>(null);

  const setStreamingState = useCallback((s: 'idle' | 'reasoning' | 'content' | 'done' | ((prev: 'idle' | 'reasoning' | 'content' | 'done') => 'idle' | 'reasoning' | 'content' | 'done')) => {
    if (typeof s === 'function') {
      setStreamingStateRaw((prev) => {
        const next = s(prev);
        streamingStateRef.current = next;
        return next;
      });
    } else {
      streamingStateRef.current = s;
      setStreamingStateRaw(s);
    }
  }, []);

  const setStreamingMsgId = useCallback((id: number | null) => {
    streamingMsgIdRef.current = id;
    setStreamingMsgIdRaw(id);
  }, []);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  /**
   * Бюджет символов для ленивого рендеринга ленты.
   * Базовое значение берётся из настроек (low / medium / high).
   * Кнопка «Показать ещё» увеличивает бюджет на шаг.
   * Сбрасывается при смене чата.
   */
  const [charBudget, setCharBudget] = useState(() => getRenderPerfBudget());
  const [loadingChats, setLoadingChats] = useState(false);
  const [sectionPaging, setSectionPaging] = useState<Record<ChatSectionKey, ChatSectionPaging>>({} as Record<ChatSectionKey, ChatSectionPaging>);
  const sectionPagingRef = useRef<Record<ChatSectionKey, ChatSectionPaging>>({} as Record<ChatSectionKey, ChatSectionPaging>);
  const chatListGenerationRef = useRef(0);
  const [showAttachModal, setShowAttachModal] = useState(false);
  const [attachedImages, setAttachedImages] = useState<ImageItem[]>([]);
  const [attachedDocuments, setAttachedDocuments] = useState<DocumentItem[]>([]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [contextMenuChatId, setContextMenuChatId] = useState<number | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  // ── Dice Roll Mode (d20) ──
  const [diceRolling, setDiceRolling] = useState(false);
  const [diceValue, setDiceValue] = useState<number | null>(null);
  const [diceStatus, setDiceStatus] = useState<'idle' | 'rolling' | 'success' | 'crit' | 'fail' | 'crit_fail'>('idle');
  const [diceMode, setDiceMode] = useState<'normal' | 'always_one' | 'always_twenty'>(() => {
    try {
      const saved = localStorage.getItem('chatter_dice_mode');
      if (saved === 'always_one' || saved === 'always_twenty') return saved;
    } catch { /* ignore */ }
    return 'normal';
  });
  const diceAnimTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [demoFiltersOpen, setDemoFiltersOpen] = useState(false);
  const [demoFolderCreatorOpen, setDemoFolderCreatorOpen] = useState(false);
  const [demoFolderName, setDemoFolderName] = useState(() => t('chat.sidebar.folders.new'));
  const [chatFolders, setChatFolders] = useState<api.ChatFolder[]>([]);
  const [unfiledChatCount, setUnfiledChatCount] = useState(0);
  const [demoFolderMenuId, setDemoFolderMenuId] = useState<number | null>(null);
  const [demoFolderMenuPos, setDemoFolderMenuPos] = useState({ x: 0, y: 0 });
  const [demoRenamingFolderId, setDemoRenamingFolderId] = useState<number | null>(null);
  const [demoRenamingFolderName, setDemoRenamingFolderName] = useState('');
  const [demoExpandedFolders, setDemoExpandedFolders] = useState<Record<number, boolean>>({});
  const [demoDraggingChatId, setDemoDraggingChatId] = useState<number | null>(null);
  const [demoDraggingChatSize, setDemoDraggingChatSize] = useState<{ width: number; height: number } | null>(null);
  const [demoMoveMenuOpen, setDemoMoveMenuOpen] = useState(false);
  const [demoPromptFilter, setDemoPromptFilter] = useState('all');
  const [demoModelFilter, setDemoModelFilter] = useState('all');
  const [demoFilesFilter, setDemoFilesFilter] = useState(false);
  const [demoImagesFilter, setDemoImagesFilter] = useState(false);
  const [roomOpen, setRoomOpen] = useState(false);
  const [roomCreated, setRoomCreated] = useState(false);
  const [roomLoading, setRoomLoading] = useState(false);
  const [roomSaving, setRoomSaving] = useState(false);
  const [roomMode, setRoomMode] = useState<'manual' | 'round'>('manual');
  const [nextRoomParticipant, setNextRoomParticipant] = useState<number | null>(null);
  const [roomAutoRespond, setRoomAutoRespond] = useState(true);
  const [draggingRoomParticipantId, setDraggingRoomParticipantId] = useState<number | null>(null);
  const [draggingRoomParticipantSize, setDraggingRoomParticipantSize] = useState<{ width: number; height: number } | null>(null);
  const [roomParticipantMenuId, setRoomParticipantMenuId] = useState<number | null>(null);
  const [changingRoomParticipantPromptId, setChangingRoomParticipantPromptId] = useState<number | null>(null);
  const [renamingRoomParticipantId, setRenamingRoomParticipantId] = useState<number | null>(null);
  const [renamingRoomParticipantName, setRenamingRoomParticipantName] = useState('');
  const [roomCharacters, setRoomCharacters] = useState<api.ChatAgent[]>([]);
  const [roomMembers, setRoomMembers] = useState<api.ChatMember[]>([]);
  const [addParticipantKind, setAddParticipantKind] = useState<'choose' | 'bot' | 'human' | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [joinRoomOpen, setJoinRoomOpen] = useState(false);
  const [joinRoomLink, setJoinRoomLink] = useState('');
  const [joinRoomBusy, setJoinRoomBusy] = useState(false);
  const [roomPrompts, setRoomPrompts] = useState<PromptOption[]>([]);
  const [chatFilterOptions, setChatFilterOptions] = useState<{ prompts: Array<{ id: number; name: string }>; models: string[] }>({ prompts: [], models: [] });
  const [msgMenuId, setMsgMenuId] = useState<number | null>(null);
  const [msgMenuPos, setMsgMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const msgMenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [editingMsgId, setEditingMsgId] = useState<number | null>(null);
  const [editingText, setEditingText] = useState('');
  const [renamingChatId, setRenamingChatId] = useState<number | null>(null);
  const [renamingTitle, setRenamingTitle] = useState('');
  const [deletingChatId, setDeletingChatId] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!demoFolderMenuId) return;
    const closeFolderMenu = () => setDemoFolderMenuId(null);
    window.addEventListener('click', closeFolderMenu);
    return () => window.removeEventListener('click', closeFolderMenu);
  }, [demoFolderMenuId]);
  useEffect(() => {
    if (!roomParticipantMenuId) return;
    const closeParticipantMenu = () => setRoomParticipantMenuId(null);
    window.addEventListener('click', closeParticipantMenu);
    return () => window.removeEventListener('click', closeParticipantMenu);
  }, [roomParticipantMenuId]);
  useEffect(() => {
    if (addParticipantKind === null && inviteLink === null && changingRoomParticipantPromptId === null) return;
    const closePromptPicker = () => {
      setAddParticipantKind(null);
      setChangingRoomParticipantPromptId(null);
    };
    window.addEventListener('click', closePromptPicker);
    return () => window.removeEventListener('click', closePromptPicker);
  }, [addParticipantKind, inviteLink, changingRoomParticipantPromptId]);
  const applyRoom = useCallback((room: api.ChatRoom) => {
    setRoomCreated(room.enabled);
    setRoomMode(room.response_mode);
    setRoomAutoRespond(room.auto_respond);
    setRoomCharacters(room.agents);
    setRoomMembers(room.members ?? []);
    setNextRoomParticipant(room.next_agent_id ?? room.agents[0]?.id ?? null);
  }, []);
  useEffect(() => {
    let cancelled = false;
    setAddParticipantKind(null);
    setChangingRoomParticipantPromptId(null);
    setRoomParticipantMenuId(null);
    setRenamingRoomParticipantId(null);
    setRenamingRoomParticipantName('');
    setRoomSaving(false);
    if (!activeChatId) {
      applyRoom({ enabled: false, response_mode: 'manual', auto_respond: true, next_agent_id: null, agents: [], members: [] });
      return () => { cancelled = true; };
    }
    applyRoom({ enabled: false, response_mode: 'manual', auto_respond: true, next_agent_id: null, agents: [], members: [] });
    setRoomLoading(true);
    void api.getChatRoom(activeChatId)
      .then(({ room }) => {
        if (!cancelled) applyRoom(room);
      })
      .catch((error) => {
        console.error('Failed to load chat room:', error);
        if (!cancelled) applyRoom({ enabled: false, response_mode: 'manual', auto_respond: true, next_agent_id: null, agents: [], members: [] });
      })
      .finally(() => {
        if (!cancelled) setRoomLoading(false);
      });
    return () => { cancelled = true; };
  }, [activeChatId, applyRoom]);
  useEffect(() => {
    if ((addParticipantKind !== 'bot' && changingRoomParticipantPromptId === null) || roomPrompts.length > 0) return;
    let cancelled = false;
    void api.getPrompts()
      .then((result) => {
        if (cancelled) return;
        setRoomPrompts([
          ...result.prompts.map(({ id, name, description }) => ({ id, name, description, kind: 'default' as const })),
          ...result.custom_prompts.map(({ id, name, description }) => ({ id, name, description, kind: 'custom' as const })),
        ]);
      })
      .catch((error) => console.error('Failed to load room prompts:', error));
    return () => { cancelled = true; };
  }, [addParticipantKind, changingRoomParticipantPromptId, roomPrompts.length]);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const pendingPrependScrollRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<api.ChatSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [notificationsEnabled, setNotificationsEnabledState] = useState(true);
  const [viewerImageSrc, setViewerImageSrc] = useState<string | null>(null);
  const [viewerImageMsgId, setViewerImageMsgId] = useState<number | null>(null);
  const [viewerImageUrl, setViewerImageUrl] = useState<string | null>(null);
  const [imageDeleteTarget, setImageDeleteTarget] = useState<{ messageId: number; url: string } | null>(null);
  const [deletingImage, setDeletingImage] = useState(false);
  const [ttsPlayingId, setTtsPlayingId] = useState<number | null>(null);
  const [pendingMacros, setPendingMacros] = useState<Array<{ title: string; description?: string; commands: string[] }>>([]);
  const [pendingChatLinks, setPendingChatLinks] = useState<Array<{ chat_id: number; title: string }>>([]);
  const [devopsConfirmations, setDevopsConfirmations] = useState<Array<{ confirmation_id: string; server_name: string; server_id: number; host: string; command: string; needs_sudo_password?: boolean; sudo_password?: string; save_sudo_password?: boolean; needs_new_password?: boolean; new_password?: string; new_username?: string; _reviewing?: boolean; _verdict?: string }>>([]);
  const [pendingRunbooks, setPendingRunbooks] = useState<Array<{ title: string; content: string; commands: string[]; _reviewing?: boolean; _verdict?: string }>>([]);
  const [pendingCredsUpdates, setPendingCredsUpdates] = useState<Array<{ confirmation_id?: string; server_id: number; server_name: string; current_username: string; new_username: string; reason: string; use_ssh_key: boolean; remove_password: boolean }>>([]);
  const [pcCommandConfirmations, setPcCommandConfirmations] = useState<Array<{ confirmation_id: string; command: string; _reviewing?: boolean; _verdict?: string }>>([]);
  const [browserActionConfirmations, setBrowserActionConfirmations] = useState<Array<{ confirmation_id: string; action_type: 'open' | 'click' | 'fill'; description: string; url?: string; text?: string; origin?: string; target_element?: { tag?: string; role?: string; text?: string; href?: string; inputType?: string; placeholder?: string; sensitive?: boolean } }>>([]);
  const [browserDownloadConfirmations, setBrowserDownloadConfirmations] = useState<Array<{ confirmation_id: string; download_id: string; filename: string; url: string; mime_type?: string; total_bytes?: number; origin?: string | null }>>([]);
  const confirmationSubmissionsRef = useRef(new Set<string>());
  const [submittingConfirmationIds, setSubmittingConfirmationIds] = useState<Set<string>>(new Set());
  const [fileActionConfirmations, setFileActionConfirmations] = useState<Array<{ confirmation_id: string; action_type: 'read' | 'write'; file_path: string; mode?: string; size_bytes?: number; content_preview?: string; start_line?: number; max_lines?: number }>>([]);
  const [editFileLinesConfirmations, setEditFileLinesConfirmations] = useState<Array<{ confirmation_id: string; file_path: string; start_line: number; end_line: number; old_content_preview?: string; new_content_preview?: string }>>([]);
  const autoApprovingFileIdsRef = useRef(new Set<string>());
  const autoApprovedFileIdsRef = useRef(new Set<string>());
  const [webcamCaptureConfirmations, setWebcamCaptureConfirmations] = useState<Array<{ confirmation_id: string; purpose: string; camera_name: string }>>([]);
  const [emailConfirmations, setEmailConfirmations] = useState<Array<{ confirmation_id: string; from: string; to: string; subject: string; body: string }>>([]);
  const [modelsCatalog, setModelsCatalog] = useState<api.ModelCatalogEntry[]>([]);
  const [preferredModel, setPreferredModel] = useState<string | null>(null);
  const [reasoningLevel, setReasoningLevel] = useState<api.ReasoningLevel | null>(null);
  const [autoReasoningLevels, setAutoReasoningLevels] = useState<api.ReasoningLevel[]>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  const [autoSupportsVision, setAutoSupportsVision] = useState<{ pro: boolean; lite: boolean }>({ pro: false, lite: false });
  const [regenHintMsgId, setRegenHintMsgId] = useState<number | null>(null);
  const [regenHintText, setRegenHintText] = useState('');
  const [openReasoningId, setOpenReasoningId] = useState<number | null>(null);
  const [openToolCallsId, setOpenToolCallsId] = useState<number | null>(null);
  const [openSubagentsId, setOpenSubagentsId] = useState<number | null>(null);
  const [contextTokens, setContextTokens] = useState<api.ChatContextTokens | null>(null);

  // Subscribe to TTS state
  useEffect(() => {
    return ttsSubscribe((id) => setTtsPlayingId(id));
  }, []);

  // Load models catalog + reasoning level
  useEffect(() => {
    (async () => {
      try {
        const res = await api.getModels();
        setModelsCatalog(res.models);
        setPreferredModel(res.preferred_model);
        if (res.auto_reasoning_levels) setAutoReasoningLevels(res.auto_reasoning_levels);
        if (res.auto_supports_vision) setAutoSupportsVision(res.auto_supports_vision);
      } catch {}
      try {
        const res = await api.getReasoningLevel();
        setReasoningLevel(res.reasoning_level);
      } catch {}
    })();
  }, []);

  // Ref flag: when true, the next handleSend() call originated from voice input (wake word)
  const isVoiceInputRef = useRef(false);
  const currentAvatarStateRef = useRef<SetDisplayStatePayload | null>(null);

  const beginConfirmationSubmission = useCallback((confirmationId: string) => {
    if (confirmationSubmissionsRef.current.has(confirmationId)) return false;
    confirmationSubmissionsRef.current.add(confirmationId);
    setSubmittingConfirmationIds(new Set(confirmationSubmissionsRef.current));
    return true;
  }, []);

  const finishConfirmationSubmission = useCallback((confirmationId: string) => {
    confirmationSubmissionsRef.current.delete(confirmationId);
    setSubmittingConfirmationIds(new Set(confirmationSubmissionsRef.current));
  }, []);

  const notificationActions = useMemo(() => ({
    open: t('chat.desktopNotifications.open'),
    allow: t('chat.desktopNotifications.allow'),
    decline: t('chat.desktopNotifications.decline'),
  }), [t]);

  const showNativeNotification = useCallback((payload: {
    id: string;
    title: string;
    body: string;
    chatId?: number;
    confirmationId?: string;
    sensitive?: boolean;
    reviewOnly?: boolean;
    actions?: { open: string; allow: string; decline: string };
  }) => {
    void window.electronAPI.showDesktopNotification(payload).catch((error) => {
      console.warn('[notifications] failed to show:', error);
    });
  }, []);

  const notifyAssistantResponse = useCallback((messageId: number, chatId: number, text: string) => {
    const body = cleanNotificationText(text);
    if (!body || messageId <= 0) return;
    showNativeNotification({ id: `message:${messageId}`, title: 'Chatter', body, chatId });
  }, [showNativeNotification]);

  useEffect(() => {
    void window.electronAPI.getNotificationsEnabled().then(setNotificationsEnabledState).catch(() => undefined);
    void window.electronAPI.setNotificationLabels({
      open: t('chat.desktopNotifications.openChatter'),
      notifications: t('chat.desktopNotifications.notifications'),
      quit: t('chat.desktopNotifications.quit'),
    });
    const removeEnabled = window.electronAPI.onNotificationsEnabledChanged(setNotificationsEnabledState);
    const removeOpenChat = window.electronAPI.onNotificationOpenChat(({ chatId }) => {
      if (!Number.isFinite(chatId)) return;
      setActiveChatId(chatId);
      void api.activateChat(chatId).catch(() => undefined);
    });
    return () => {
      removeEnabled();
      removeOpenChat();
    };
  }, [t]);

  const applyAvatarState = useCallback((state: SetDisplayStatePayload) => {
    currentAvatarStateRef.current = {
      ...(currentAvatarStateRef.current || {}),
      ...state,
      ...(state.clear_loop ? { loop_reaction: undefined } : {}),
    };
    dispatchAvatarState(state);
  }, []);

  // Доступные уровни reasoning: для ручной модели — по её capability, для auto — все
  const availableLevels = useMemo<(api.ReasoningLevel | null)[]>(() => {
    if (preferredModel) {
      const model = modelsCatalog.find(m => m.id === preferredModel);
      if (model?.reasoning_levels) return [null, ...model.reasoning_levels];
      return [null]; // модель не поддерживает reasoning
    }
    return [null, ...autoReasoningLevels];
  }, [preferredModel, modelsCatalog, autoReasoningLevels]);

  const LEVEL_LABELS: Record<string, string> = {
    'null': t('chat.reasoning.auto'), 'none': t('chat.reasoning.off'), 'minimal': t('chat.reasoning.minimalShort'), 'low': t('chat.reasoning.lowShort'), 'medium': t('chat.reasoning.mediumShort'), 'high': t('chat.reasoning.highShort'), 'xhigh': t('chat.reasoning.maxShort'),
  };

  const maxImageBytes = user?.image_attachments_allowed
    ? Math.max(
        0,
        Math.floor(
          user.max_image_attachments_total_bytes
          || DEFAULT_MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES,
        ),
      )
    : 0;
  const maxImageCount = user?.image_attachments_allowed
    ? Math.max(0, Math.floor(user.max_image_attachments_per_request || 50))
    : 0;
  const attachedImageBytes = useMemo(
    () => attachedImages.reduce((total, image) => total + image.size_bytes, 0),
    [attachedImages],
  );

  const updateSectionPaging = useCallback((next: Record<ChatSectionKey, ChatSectionPaging>) => {
    sectionPagingRef.current = next;
    setSectionPaging(next);
  }, []);

  const getCurrentChatFilters = useCallback((): api.ChatListFilters => ({
    promptId: demoPromptFilter === 'all' ? undefined : Number(demoPromptFilter),
    model: demoModelFilter === 'all' ? undefined : demoModelFilter,
    hasFiles: demoFilesFilter,
    hasImages: demoImagesFilter,
  }), [demoPromptFilter, demoModelFilter, demoFilesFilter, demoImagesFilter]);

  const loadChats = useCallback(async () => {
    const generation = ++chatListGenerationRef.current;
    setLoadingChats(true);
    try {
      const filters = getCurrentChatFilters();
      const [folderRes, filterOptions] = await Promise.all([
        api.getChatFolders(filters).catch(() => ({ folders: [] as api.ChatFolder[], unfiled_count: 0, total_count: 0, active_chat_id: null, active_chat: null })),
        api.getChatFilterOptions().catch(() => ({ prompts: [] as Array<{ id: number; name: string }>, models: [] as string[] })),
      ]);
      if (generation !== chatListGenerationRef.current) return;
      const hasActiveFilters = Boolean(filters.promptId !== undefined || filters.model || filters.hasFiles || filters.hasImages);
      setChats(!hasActiveFilters && folderRes.active_chat
        ? [{ ...folderRes.active_chat, folder_id: folderRes.active_chat.folder_id ?? null }]
        : []);
      setChatFolders(folderRes.folders.map((folder) => ({
        ...folder,
        chat_count: Number.isFinite(folder.chat_count) ? folder.chat_count : 0,
      })));
      setUnfiledChatCount(Number.isFinite(folderRes.unfiled_count)
        ? folderRes.unfiled_count
        : 0);
      setChatFilterOptions(filterOptions);
      const nextPaging = {} as Record<ChatSectionKey, ChatSectionPaging>;
      for (const folder of folderRes.folders) {
        const total = Math.max(0, Number(folder.chat_count) || 0);
        nextPaging[`folder:${folder.id}`] = { offset: 0, total, hasMore: total > 0, loading: false };
      }
      const unfiledTotal = Math.max(0, Number(folderRes.unfiled_count) || 0);
      nextPaging.unfiled = { offset: 0, total: unfiledTotal, hasMore: unfiledTotal > 0, loading: false };
      updateSectionPaging(nextPaging);
      if (folderRes.active_chat_id) setActiveChatId(folderRes.active_chat_id);
    } catch (err) {
      console.error('Failed to load chats:', err);
    } finally {
      if (generation === chatListGenerationRef.current) setLoadingChats(false);
    }
  }, [getCurrentChatFilters, updateSectionPaging]);

  const loadChatSection = useCallback(async (folderId: number | null) => {
    if (searchQuery.trim().length >= 3) return;
    const key: ChatSectionKey = folderId === null ? 'unfiled' : `folder:${folderId}`;
    const current = sectionPagingRef.current[key];
    if (!current || current.loading || !current.hasMore) return;
    const generation = chatListGenerationRef.current;
    const requestOffset = current.offset;
    updateSectionPaging({
      ...sectionPagingRef.current,
      [key]: { ...current, loading: true },
    });
    try {
      const res = await api.getChats(CHAT_PAGE_SIZE, requestOffset, {
        ...getCurrentChatFilters(),
        folderId,
      });
      if (generation !== chatListGenerationRef.current) return;
      if (res.chats.length > 0) {
        setChats(prev => {
          const seen = new Set(prev.map(chat => chat.id));
          const next = res.chats
            .filter(chat => !seen.has(chat.id))
            .map((chat) => ({ ...chat, folder_id: chat.folder_id ?? null }));
          return [...prev, ...next];
        });
      }
      const nextOffset = requestOffset + res.chats.length;
      const total = Number.isFinite(res.total) ? res.total : current.total;
      updateSectionPaging({
        ...sectionPagingRef.current,
        [key]: {
          offset: nextOffset,
          total,
          hasMore: Number.isFinite(res.total) ? nextOffset < total : res.chats.length === CHAT_PAGE_SIZE,
          loading: false,
        },
      });
    } catch (err) {
      console.error('Failed to load chat folder:', err);
      if (generation === chatListGenerationRef.current) {
        const latest = sectionPagingRef.current[key];
        if (latest) updateSectionPaging({ ...sectionPagingRef.current, [key]: { ...latest, loading: false } });
      }
    }
  }, [getCurrentChatFilters, searchQuery, updateSectionPaging]);

  const refreshChatListMetadata = useCallback(async () => {
    try {
      const folderRes = await api.getChatFolders(getCurrentChatFilters());
      setChatFolders(folderRes.folders.map((folder) => ({
        ...folder,
        chat_count: Number.isFinite(folder.chat_count) ? folder.chat_count : 0,
      })));
      setUnfiledChatCount(Number.isFinite(folderRes.unfiled_count) ? folderRes.unfiled_count : 0);

      const nextPaging = { ...sectionPagingRef.current };
      const knownKeys = new Set<ChatSectionKey>(['unfiled']);
      for (const folder of folderRes.folders) {
        const key: ChatSectionKey = `folder:${folder.id}`;
        knownKeys.add(key);
        const total = Math.max(0, Number(folder.chat_count) || 0);
        const current = nextPaging[key] ?? { offset: 0, total, hasMore: total > 0, loading: false };
        nextPaging[key] = { ...current, total, hasMore: current.offset < total };
      }
      for (const key of Object.keys(nextPaging) as ChatSectionKey[]) {
        if (!knownKeys.has(key)) delete nextPaging[key];
      }
      const unfiledTotal = Math.max(0, Number(folderRes.unfiled_count) || 0);
      const currentUnfiled = nextPaging.unfiled ?? { offset: 0, total: unfiledTotal, hasMore: unfiledTotal > 0, loading: false };
      nextPaging.unfiled = { ...currentUnfiled, total: unfiledTotal, hasMore: currentUnfiled.offset < unfiledTotal };
      updateSectionPaging(nextPaging);
    } catch (err) {
      console.error('Failed to refresh chat list metadata:', err);
    }
  }, [getCurrentChatFilters, updateSectionPaging]);

  useEffect(() => { void loadChats(); }, [loadChats]);

  useEffect(() => {
    if (activeChatId) {
      prevMsgCountRef.current = 0;
      markAsRead(activeChatId);
      loadMessages(activeChatId);
    }
  }, [activeChatId]);

  // Register global handler for scheduler task_result events
  useEffect(() => {
    api.onTaskResult((data) => {
      const taskText = cleanNotificationText(data.text);
      if (taskText) {
        showNativeNotification({
          id: `task:${data.chat_id}:${Date.now()}`,
          title: t('chat.desktopNotifications.taskTitle'),
          body: taskText,
          chatId: data.chat_id,
        });
      }
      // If new chat was created — refresh sidebar
      if (data.is_new_chat) {
        loadChats();
      }

      if (data.chat_id && data.chat_id === activeChatId) {
        // Task belongs to currently open chat — reload messages from DB
        loadMessages(data.chat_id);
      } else if (data.chat_id) {
        // Task is from a different chat — increment unread badge
        incrementUnread(data.chat_id);
      }
    });
  }, [activeChatId, chats, loadChats, showNativeNotification, t]);

  // External clients write into the same backend chat. Refresh the open
  // conversation when their user message and final answer are persisted.
  useEffect(() => api.onChatUpdated((data) => {
    void loadChats();
    if (data.chat_id === activeChatId) {
      void loadMessages(data.chat_id);
    } else if (data.phase === 'assistant') {
      incrementUnread(data.chat_id);
    }
  }), [activeChatId, loadChats]);

  const refreshContextTokens = useCallback(async (chatId: number) => {
    try {
      const tokens = await api.getChatContextTokens(chatId);
      setContextTokens(tokens);
    } catch (err) {
      console.error('Failed to load context tokens:', err);
    }
  }, []);

  const loadMessages = async (chatId: number) => {
    setLoadingMessages(true);
    // Reset character budget — each chat starts with a fresh budget
    setCharBudget(getRenderPerfBudget());
    try {
      const res = await api.getMessages(chatId, MESSAGE_PAGE_SIZE);
      setMessages(res.messages);
      setHasMoreMessages(res.messages.length === MESSAGE_PAGE_SIZE);
      refreshContextTokens(chatId);
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
        // Increase budget by the total length of the loaded batch + step,
        // so new messages immediately appear in the visible render.
        const loadedChars = res.messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
        setCharBudget(prev => prev + loadedChars + getRenderPerfStep());
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

  /**
   * Срез сообщений для DOM-рендера. Идём с конца (свежие) к началу (старые):
   *   1. Первые MIN_VISIBLE_MESSAGES показываем всегда, независимо от бюджета.
   *   2. Дальше копим сумму длин content, пока не упрётся в charBudget.
   *   3. Страховка: если следующее сообщение превышает остаток бюджета —
   *      показываем его целиком (не прячем одно сообщение).
   */
  const visibleMessages = useMemo<api.Message[]>(() => {
    if (messages.length <= MIN_VISIBLE_MESSAGES) return messages;
    let sumChars = 0;
    let cutIndex = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      const len = messages[i].content?.length ?? 0;
      const withinMin = i >= messages.length - MIN_VISIBLE_MESSAGES;
      if (!withinMin && sumChars + len > charBudget) {
        cutIndex = i + 1;
        break;
      }
      sumChars += len;
      cutIndex = i;
    }
    return messages.slice(Math.max(0, cutIndex));
  }, [messages, charBudget]);

  /** How many messages are hidden (not rendered in DOM) beyond visibleMessages. */
  const hiddenMessagesCount = messages.length - visibleMessages.length;

  /** How many messages will actually be revealed on the next click.
   *  Simulates increasing charBudget by one step and computes the difference. */
  const willRevealCount = useMemo(() => {
    if (hiddenMessagesCount === 0) return 0;
    const step = getRenderPerfStep();
    const nextBudget = charBudget + step;
    let sumChars = 0;
    let cutIndex = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      const len = messages[i].content?.length ?? 0;
      const withinMin = i >= messages.length - MIN_VISIBLE_MESSAGES;
      if (!withinMin && sumChars + len > nextBudget) {
        cutIndex = i + 1;
        break;
      }
      sumChars += len;
      cutIndex = i;
    }
    const nextVisible = messages.length - cutIndex;
    return Math.max(0, nextVisible - visibleMessages.length);
  }, [messages, charBudget, hiddenMessagesCount, visibleMessages.length]);

  /** Reveal another batch of hidden messages.
   *  If all in-memory messages are already visible — fall back to server fetch. */
  const showMoreHidden = useCallback(() => {
    if (hiddenMessagesCount > 0) {
      setCharBudget(prev => prev + getRenderPerfStep());
    } else {
      void loadOlderMessages();
    }
  }, [hiddenMessagesCount, loadOlderMessages]);

  const selectChat = async (chatId: number) => {
    setActiveChatId(chatId);
    try { await api.activateChat(chatId); } catch {}
  };

  const handleCreateChat = async () => {
    try {
      const res = await api.createChat();
      const hasActiveFilters = Object.values(getCurrentChatFilters()).some((value) => value !== undefined && value !== false);
      if (!hasActiveFilters) {
        const createdChat: api.ChatInfo = res.chat ?? {
          id: res.chat_id,
          title: t('chat.sidebar.newChat'),
          folder_id: null,
          created_at: Math.floor(Date.now() / 1000),
        };
        setChats((current) => current.some((chat) => chat.id === createdChat.id)
          ? current
          : [createdChat, ...current]);
        setUnfiledChatCount((current) => current + 1);
        const paging = sectionPagingRef.current.unfiled;
        if (paging) {
          updateSectionPaging({
            ...sectionPagingRef.current,
            unfiled: {
              ...paging,
              offset: paging.offset + 1,
              total: paging.total + 1,
              hasMore: paging.offset + 1 < paging.total + 1,
            },
          });
        }
      }
      selectChat(res.chat_id);
      void refreshChatListMetadata();
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

  const notifyConfirmationAction = useCallback((action: api.DesktopActionPayload) => {
    const value = action.value as Record<string, unknown> | undefined;
    const confirmationId = typeof value?.confirmation_id === 'string' ? value.confirmation_id : '';
    if (!confirmationId) return;

    let body = '';
    let sensitive = false;
    let reviewOnly = false;
    switch (action.action) {
      case 'devops_confirmation':
        body = String(value?.command || '');
        sensitive = value?.needs_sudo_password === true || value?.needs_new_password === true;
        break;
      case 'pc_command_confirmation':
        body = String(value?.command || '');
        break;
      case 'browser_action_confirmation': {
        body = String(value?.description || value?.url || '');
        const target = value?.target_element as { sensitive?: boolean; inputType?: string } | undefined;
        sensitive = target?.sensitive === true || target?.inputType === 'password';
        break;
      }
      case 'browser_download_confirmation':
        body = t('chat.desktopNotifications.downloadFile', { filename: String(value?.filename || '') });
        sensitive = true;
        break;
      case 'file_action_confirmation':
        body = String(value?.file_path || '');
        break;
      case 'edit_file_lines_confirmation':
        body = String(value?.file_path || '');
        break;
      case 'webcam_capture_confirmation':
        body = t('chat.desktopNotifications.cameraAccess');
        sensitive = true;
        break;
      case 'email_confirmation':
        body = t('chat.desktopNotifications.emailSend', { to: String(value?.to || ''), subject: String(value?.subject || '') });
        sensitive = true;
        break;
      case 'suggest_server_creds_update':
        body = t('chat.desktopNotifications.credentialsUpdate', { server: String(value?.server_name || '') });
        sensitive = true;
        break;
      default: {
        if (!action.action.endsWith('_confirmation')) return;
        body = String(
          value?.description
          || value?.title
          || value?.command
          || value?.reason
          || value?.purpose
          || value?.filename
          || value?.file_path
          || t('chat.desktopNotifications.sensitiveTitle'),
        );
        sensitive = true;
        reviewOnly = true;
        break;
      }
    }
    if (!body.trim()) return;
    const warning = sensitive
      ? t('chat.desktopNotifications.sensitiveWarning')
      : t('chat.desktopNotifications.standardWarning');
    showNativeNotification({
      id: `confirmation:${confirmationId}`,
      title: sensitive
        ? t('chat.desktopNotifications.sensitiveTitle')
        : t('chat.desktopNotifications.commandTitle'),
      body: `${cleanNotificationText(body, 300)}\n\n${warning}`,
      chatId: activeChatId ?? undefined,
      confirmationId,
      sensitive,
      reviewOnly,
      actions: notificationActions,
    });
  }, [activeChatId, notificationActions, showNativeNotification, t]);

  const handleIncomingDesktopAction = useCallback((action: api.DesktopActionPayload) => {
    if (action.action === 'confirmation_resolved' && action.value) {
      const val = action.value as { confirmation_id?: string };
      const confirmationId = val.confirmation_id;
      if (!confirmationId) return;
      setDevopsConfirmations(prev => prev.filter(c => c.confirmation_id !== confirmationId));
      setPendingCredsUpdates(prev => prev.filter(c => c.confirmation_id !== confirmationId));
      setPcCommandConfirmations(prev => prev.filter(c => c.confirmation_id !== confirmationId));
      setBrowserActionConfirmations(prev => prev.filter(c => c.confirmation_id !== confirmationId));
      setBrowserDownloadConfirmations(prev => prev.filter(c => c.confirmation_id !== confirmationId));
      setFileActionConfirmations(prev => prev.filter(c => c.confirmation_id !== confirmationId));
      setEditFileLinesConfirmations(prev => prev.filter(c => c.confirmation_id !== confirmationId));
      setWebcamCaptureConfirmations(prev => prev.filter(c => c.confirmation_id !== confirmationId));
      setEmailConfirmations(prev => prev.filter(c => c.confirmation_id !== confirmationId));
      finishConfirmationSubmission(confirmationId);
      void window.electronAPI.dismissDesktopNotification(`confirmation:${confirmationId}`).catch(() => {});
      return;
    }
    if (action.action !== 'file_action_confirmation' && action.action !== 'edit_file_lines_confirmation') {
      notifyConfirmationAction(action);
    }
    if (action.action === 'suggest_macro' && action.value) {
      const val = action.value as { title?: string; description?: string; commands?: string[] };
      if (val.title && val.commands?.length) {
        setPendingMacros(prev => [...prev, { title: val.title!, description: val.description, commands: val.commands! }]);
      }
    }
    if (action.action === 'devops_confirmation' && action.value) {
      const val = action.value as { confirmation_id?: string; server_name?: string; server_id?: number; host?: string; command?: string; needs_sudo_password?: boolean; needs_new_password?: boolean; new_username?: string };
      if (val.confirmation_id && val.command) {
        setDevopsConfirmations(prev => {
          if (prev.some(c => c.confirmation_id === val.confirmation_id)) return prev;
          return [...prev, {
            confirmation_id: val.confirmation_id!,
            server_name: val.server_name || t('common.unknown'),
            server_id: val.server_id || 0,
            host: val.host || '',
            command: val.command!,
            needs_sudo_password: Boolean(val.needs_sudo_password),
            needs_new_password: Boolean(val.needs_new_password),
            new_username: val.new_username,
          }];
        });
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
        setPcCommandConfirmations(prev => {
          if (prev.some(c => c.confirmation_id === val.confirmation_id)) return prev;
          return [...prev, {
            confirmation_id: val.confirmation_id!,
            command: val.command!,
          }];
        });
      }
    }
    if (action.action === 'browser_action_confirmation' && action.value) {
      const val = action.value as { confirmation_id?: string; action_type?: 'open' | 'click' | 'fill'; description?: string; url?: string; text?: string; origin?: string; target_element?: { tag?: string; role?: string; text?: string; href?: string; inputType?: string; placeholder?: string; sensitive?: boolean } };
      if (val.confirmation_id && val.action_type && val.description) {
        setBrowserActionConfirmations(prev => {
          if (prev.some(c => c.confirmation_id === val.confirmation_id)) return prev;
          return [...prev, {
            confirmation_id: val.confirmation_id!,
            action_type: val.action_type!,
            description: val.description!,
            url: val.url,
            text: val.text,
            origin: val.origin,
            target_element: val.target_element,
          }];
        });
      }
    }
    if (action.action === 'browser_action_confirmation_resolved' && action.value) {
      const val = action.value as { confirmation_id?: string };
      if (val.confirmation_id) {
        setBrowserActionConfirmations(prev => prev.filter(c => c.confirmation_id !== val.confirmation_id));
        finishConfirmationSubmission(val.confirmation_id);
      }
    }
    if (action.action === 'browser_download_confirmation' && action.value) {
      const val = action.value as { confirmation_id?: string; download_id?: string; filename?: string; url?: string; mime_type?: string; total_bytes?: number; origin?: string | null };
      if (val.confirmation_id && val.download_id && val.filename) {
        setBrowserDownloadConfirmations(prev => {
          if (prev.some(c => c.confirmation_id === val.confirmation_id)) return prev;
          return [...prev.filter(c => c.download_id !== val.download_id), {
            confirmation_id: val.confirmation_id!,
            download_id: val.download_id!,
            filename: val.filename!,
            url: val.url || '',
            mime_type: val.mime_type,
            total_bytes: val.total_bytes,
            origin: val.origin,
          }];
        });
      }
    }
    if (action.action === 'browser_download_confirmation_resolved' && action.value) {
      const val = action.value as { confirmation_id?: string; download_id?: string };
      if (val.confirmation_id || val.download_id) {
        setBrowserDownloadConfirmations(prev => prev.filter(c =>
          c.confirmation_id !== val.confirmation_id && c.download_id !== val.download_id
        ));
        if (val.confirmation_id) finishConfirmationSubmission(val.confirmation_id);
      }
    }
    if (action.action === 'file_action_confirmation' && action.value) {
      const val = action.value as { confirmation_id?: string; action_type?: 'read' | 'write'; file_path?: string; mode?: string; size_bytes?: number; content_preview?: string; start_line?: number; max_lines?: number };
      if (val.confirmation_id && val.file_path && val.action_type) {
        if (val.action_type === 'write') {
          const confirmationId = val.confirmation_id;
          if (autoApprovedFileIdsRef.current.has(confirmationId) || autoApprovingFileIdsRef.current.has(confirmationId)) return;
          autoApprovingFileIdsRef.current.add(confirmationId);
          void (async () => {
            try {
              if (await window.electronAPI.canAutoWrite(val.file_path!)) {
                await api.apiFetch('/api/v1/pc-commands/approve', {
                  method: 'POST',
                  body: JSON.stringify({ confirmation_id: confirmationId, approved: true }),
                });
                autoApprovedFileIdsRef.current.add(confirmationId);
                return;
              }
            } catch {
              // Fall back to the normal confirmation card.
            } finally {
              autoApprovingFileIdsRef.current.delete(confirmationId);
            }

            notifyConfirmationAction(action);
            setFileActionConfirmations(prev => {
              if (prev.some(c => c.confirmation_id === confirmationId)) return prev;
              return [...prev, {
                confirmation_id: confirmationId,
                action_type: val.action_type!,
                file_path: val.file_path!,
                mode: val.mode,
                size_bytes: val.size_bytes,
                content_preview: val.content_preview,
                start_line: val.start_line,
                max_lines: val.max_lines,
              }];
            });
          })();
          return;
        }
        setFileActionConfirmations(prev => {
          if (prev.some(c => c.confirmation_id === val.confirmation_id)) return prev;
          return [...prev, {
            confirmation_id: val.confirmation_id!,
            action_type: val.action_type!,
            file_path: val.file_path!,
            mode: val.mode,
            size_bytes: val.size_bytes,
            content_preview: val.content_preview,
            start_line: val.start_line,
            max_lines: val.max_lines,
          }];
        });
      }
    }
    if (action.action === 'edit_file_lines_confirmation' && action.value) {
      const val = action.value as { confirmation_id?: string; file_path?: string; start_line?: number; end_line?: number; old_content_preview?: string; new_content_preview?: string };
      if (val.confirmation_id && val.file_path) {
        const confirmationId = val.confirmation_id;
        if (autoApprovedFileIdsRef.current.has(confirmationId) || autoApprovingFileIdsRef.current.has(confirmationId)) return;
        autoApprovingFileIdsRef.current.add(confirmationId);
        void (async () => {
          try {
            if (await window.electronAPI.canAutoWrite(val.file_path!)) {
              await api.apiFetch('/api/v1/pc-commands/approve', {
                method: 'POST',
                body: JSON.stringify({ confirmation_id: confirmationId, approved: true }),
              });
              autoApprovedFileIdsRef.current.add(confirmationId);
              return;
            }
          } catch {
            // Fall back to the normal confirmation card.
          } finally {
            autoApprovingFileIdsRef.current.delete(confirmationId);
          }

          notifyConfirmationAction(action);
          setEditFileLinesConfirmations(prev => {
            if (prev.some(c => c.confirmation_id === confirmationId)) return prev;
            return [...prev, {
              confirmation_id: confirmationId,
              file_path: val.file_path!,
              start_line: val.start_line ?? 0,
              end_line: val.end_line ?? 0,
              old_content_preview: val.old_content_preview,
              new_content_preview: val.new_content_preview,
            }];
          });
        })();
      }
    }

    if (action.action === 'webcam_capture_confirmation' && action.value) {
      const val = action.value as { confirmation_id?: string; purpose?: string; camera_name?: string };
      if (val.confirmation_id) {
        setWebcamCaptureConfirmations(prev => {
          if (prev.some(c => c.confirmation_id === val.confirmation_id)) return prev;
          return [...prev, {
            confirmation_id: val.confirmation_id!,
            purpose: val.purpose || t('chat.webcam.defaultTask'),
            camera_name: val.camera_name || 'default',
          }];
        });
      }
    }

    if (action.action === 'email_confirmation' && action.value) {
      const val = action.value as { confirmation_id?: string; from?: string; to?: string; subject?: string; body?: string };
      if (val.confirmation_id && val.to && val.subject && val.body) {
        setEmailConfirmations(prev => {
          if (prev.some(c => c.confirmation_id === val.confirmation_id)) return prev;
          return [...prev, {
            confirmation_id: val.confirmation_id!,
            from: val.from || '',
            to: val.to!,
            subject: val.subject!,
            body: val.body!,
          }];
        });
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
    if (action.action === 'suggest_chat_link' && action.value) {
      const val = action.value as { chat_id?: number; title?: string };
      if (val.chat_id && val.title) {
        setPendingChatLinks(prev => {
          if (prev.some(c => c.chat_id === val.chat_id)) return prev;
          return [...prev, { chat_id: val.chat_id!, title: val.title! }];
        });
      }
    }
    handleDesktopAction(action);
  }, [finishConfirmationSubmission, notifyConfirmationAction, t]);

  const resolveNotificationConfirmation = useCallback(async (
    confirmationId: string,
    decision: 'allow' | 'decline',
  ) => {
    const devops = devopsConfirmations.find(c => c.confirmation_id === confirmationId);
    const credentials = pendingCredsUpdates.find(c => c.confirmation_id === confirmationId);
    const pcCommand = pcCommandConfirmations.find(c => c.confirmation_id === confirmationId);
    const browserAction = browserActionConfirmations.find(c => c.confirmation_id === confirmationId);
    const browserDownload = browserDownloadConfirmations.find(c => c.confirmation_id === confirmationId);
    const fileAction = fileActionConfirmations.find(c => c.confirmation_id === confirmationId);
    const fileEdit = editFileLinesConfirmations.find(c => c.confirmation_id === confirmationId);
    const webcam = webcamCaptureConfirmations.find(c => c.confirmation_id === confirmationId);
    const email = emailConfirmations.find(c => c.confirmation_id === confirmationId);
    if (!devops && !credentials && !pcCommand && !browserAction && !browserDownload && !fileAction && !fileEdit && !webcam && !email) return;

    const browserSensitive = browserAction?.target_element?.sensitive === true
      || browserAction?.target_element?.inputType === 'password';
    const sensitive = Boolean(
      credentials || browserDownload || webcam || email || browserSensitive
      || devops?.needs_sudo_password || devops?.needs_new_password,
    );
    // Sensitive actions intentionally cannot be approved directly from a notification.
    if (decision === 'allow' && sensitive) return;
    if (!beginConfirmationSubmission(confirmationId)) return;
    try {
      const endpoint = email
        ? '/api/v1/email/approve'
        : (devops || credentials)
          ? '/api/v1/devops/approve'
          : '/api/v1/pc-commands/approve';
      await api.apiFetch(endpoint, {
        method: 'POST',
        body: JSON.stringify({ confirmation_id: confirmationId, approved: decision === 'allow' }),
      });
      setDevopsConfirmations(prev => prev.filter(c => c.confirmation_id !== confirmationId));
      setPendingCredsUpdates(prev => prev.filter(c => c.confirmation_id !== confirmationId));
      setPcCommandConfirmations(prev => prev.filter(c => c.confirmation_id !== confirmationId));
      setBrowserActionConfirmations(prev => prev.filter(c => c.confirmation_id !== confirmationId));
      setBrowserDownloadConfirmations(prev => prev.filter(c => c.confirmation_id !== confirmationId));
      setFileActionConfirmations(prev => prev.filter(c => c.confirmation_id !== confirmationId));
      setEditFileLinesConfirmations(prev => prev.filter(c => c.confirmation_id !== confirmationId));
      setWebcamCaptureConfirmations(prev => prev.filter(c => c.confirmation_id !== confirmationId));
      setEmailConfirmations(prev => prev.filter(c => c.confirmation_id !== confirmationId));
      if (decision === 'allow') toast.success(t('chat.toasts.commandApproved'));
    } catch (error) {
      toast.error(api.getApiErrorMessage(error, t('chat.toasts.commandApprovalFailed')));
    } finally {
      finishConfirmationSubmission(confirmationId);
    }
  }, [
    beginConfirmationSubmission,
    browserActionConfirmations,
    browserDownloadConfirmations,
    devopsConfirmations,
    editFileLinesConfirmations,
    emailConfirmations,
    fileActionConfirmations,
    finishConfirmationSubmission,
    pcCommandConfirmations,
    pendingCredsUpdates,
    t,
    webcamCaptureConfirmations,
  ]);

  useEffect(() => api.onDesktopAction(handleIncomingDesktopAction), [handleIncomingDesktopAction]);

  useEffect(() => window.electronAPI.onNotificationConfirmationAction(({ confirmationId, action }) => {
    void resolveNotificationConfirmation(confirmationId, action);
  }), [resolveNotificationConfirmation]);

  useEffect(() => {
    const removeResolved = window.electronAPI.onBrowserDownloadResolved(({ download_id }) => {
      if (!download_id) return;
      setBrowserDownloadConfirmations(prev => prev.filter(c => c.download_id !== download_id));
    });
    return () => {
      removeResolved();
    };
  }, []);

  useEffect(() => api.onMapUpdate((data) => {
    openTool('map');
    dispatchMapData(data);
  }), []);

  // ── Dice Roll: переключение режима кубика по клику (normal → always_one → always_twenty → normal) ──
  const cycleDiceMode = useCallback(() => {
    if (diceAnimTimer.current) { clearTimeout(diceAnimTimer.current); diceAnimTimer.current = null; }
    setDiceRolling(false);
    setDiceValue(null);
    setDiceStatus('idle');
    try { sessionStorage.removeItem('chatter_dice_roll'); } catch { /* ignore */ }
    setDiceMode((prev) => {
      const next = prev === 'normal' ? 'always_one' : prev === 'always_one' ? 'always_twenty' : 'normal';
      try { localStorage.setItem('chatter_dice_mode', next); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // ── Dice Roll: запуск анимации (быстрые случайные числа → замедление → фиксация) ──
  const startDiceRollAnimation = useCallback(() => {
    if (diceAnimTimer.current) clearTimeout(diceAnimTimer.current);
    setDiceRolling(true);
    setDiceStatus('rolling');
    setDiceValue(null);

    // Быстро крутим случайные числа, постепенно замедляясь.
    // Общая длительность ~1.2с.
    const totalDuration = 1200;
    const startTs = Date.now();
    const tick = () => {
      const elapsed = Date.now() - startTs;
      // Замедление: интервал растёт от 50мс до 220мс к концу
      const progress = Math.min(1, elapsed / totalDuration);
      const interval = 50 + Math.pow(progress, 2) * 170;
      setDiceValue(Math.floor(Math.random() * 20) + 1);
      if (elapsed < totalDuration) {
        diceAnimTimer.current = setTimeout(tick, interval);
      }
    };
    tick();
  }, []);

  // ── Dice Roll: фиксация результата с цветом ──
  // Результат сохраняется в sessionStorage и не исчезает до следующего броска.
  const finishDiceRoll = useCallback((roll: number) => {
    if (diceAnimTimer.current) {
      clearTimeout(diceAnimTimer.current);
      diceAnimTimer.current = null;
    }
    setDiceValue(roll);
    setDiceRolling(false);
    let status: 'success' | 'crit' | 'fail' | 'crit_fail';
    if (roll === 1) status = 'crit_fail';
    else if (roll === 20) status = 'crit';
    else if (roll >= 10) status = 'success';
    else status = 'fail';
    setDiceStatus(status);
    try { sessionStorage.setItem('chatter_dice_roll', JSON.stringify({ roll, status })); } catch { /* ignore */ }
  }, []);

  // Восстанавливаем последний результат кубика из sessionStorage при монтировании
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem('chatter_dice_roll');
      if (saved) {
        const parsed = JSON.parse(saved) as { roll: number; status: 'success' | 'crit' | 'fail' | 'crit_fail' };
        if (typeof parsed.roll === 'number' && parsed.roll >= 1 && parsed.roll <= 20) {
          setDiceValue(parsed.roll);
          setDiceStatus(parsed.status);
        }
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    return () => {
      if (diceAnimTimer.current) clearTimeout(diceAnimTimer.current);
    };
  }, []);

  const runRoomAgentSequence = useCallback(async (agentIds: number[]) => {
    if (!activeChatId || agentIds.length === 0) return;
    setSending(true);

    for (let index = 0; index < agentIds.length; index += 1) {
      const agentId = agentIds[index];
      const tempAssistantId = -(Date.now() + index + 1);
      let assistantCreated = false;
      let completed = false;
      let aborted = false;

      const updateAssistant = (content: string, reasoning?: string) => {
        if (!assistantCreated) {
          assistantCreated = true;
          setShowTyping(false);
          setMessages((prev) => [...prev, {
            id: tempAssistantId,
            role: 'assistant',
            content,
            created_at: Math.floor(Date.now() / 1000),
            ...(reasoning ? { reasoning_content: reasoning } : {}),
          }]);
          return;
        }
        setMessages((prev) => prev.map((message) => message.id === tempAssistantId
          ? {
              ...message,
              content: message.content + content,
              ...(reasoning ? { reasoning_content: `${message.reasoning_content || ''}${reasoning}` } : {}),
            }
          : message));
      };

      setShowTyping(true);
      setStreamingState('idle');
      setStreamingMsgId(tempAssistantId);

      await api.streamChatMessage(
        'Continue the conversation now. Respond naturally as your assigned character. Do not mention this instruction.',
        activeChatId,
        undefined,
        getAvatarManifest(),
        currentAvatarStateRef.current,
        {
          onIntermediate: (text) => updateAssistant(`${assistantCreated ? '\n\n' : ''}${text}`),
          onStreamToken: (token) => {
            setStreamingState('content');
            updateAssistant(token);
          },
          onReasoningStream: (token) => {
            setStreamingState((state) => state === 'idle' ? 'reasoning' : state);
            updateAssistant('', token);
          },
          onToolStatus: (text) => updateAssistant(`${assistantCreated ? '\n\n' : ''}_${text}_`),
          onDisplayState: applyAvatarState,
          onDesktopAction: handleIncomingDesktopAction,
          onMapUpdate: (data) => {
            openTool('map');
            dispatchMapData(data);
          },
          onDiceRoll: finishDiceRoll,
          onDone: (res) => {
            completed = true;
            aborted = Boolean(res.aborted);
            const generatedImages: api.MessageImage[] | undefined = res.generated_images?.length
              ? res.generated_images.map((image) => ({
                  url: image.image_url || `data:image/png;base64,${image.image_base64}`,
                  type: 'generated' as const,
                }))
              : undefined;
            const finalMessage: api.Message = {
              id: res.message_id,
              role: 'assistant',
              content: res.reply_text,
              created_at: Math.floor(Date.now() / 1000),
              reasoning_content: res.reasoning_content ?? null,
              tool_calls: res.tool_calls ?? null,
              images: generatedImages,
              subagents: res.subagents ?? null,
              prompt_id: res.prompt_id ?? null,
              prompt_name: res.prompt_name ?? null,
              agent_id: res.agent_id ?? agentId,
              model_name: res.model_name ?? null,
              provider_name: res.provider_name ?? null,
              usage: res.message_usage ?? null,
              ...(typeof res.token_count === 'number' ? { token_count: res.token_count } : {}),
              ...(typeof res.reasoning_tokens === 'number' ? { reasoning_tokens: res.reasoning_tokens } : {}),
            };
            setMessages((prev) => assistantCreated
              ? prev.map((message) => message.id === tempAssistantId ? finalMessage : message)
              : [...prev, finalMessage]);
            if (res.display_state) applyAvatarState(res.display_state);
            notifyAssistantResponse(res.message_id, res.chat_id, res.reply_text);
            refreshContextTokens(res.chat_id);
          },
          onError: (error, message) => {
            console.error('Room agent stream error:', error);
            toast.error(message || error);
            setMessages((prev) => prev.filter((item) => item.id !== tempAssistantId));
          },
        },
        {
          preferredModel,
          skip_user_history: true,
          agentId,
          countAsUserMessage: false,
          dice_mode: diceMode,
        },
      );

      setStreamingState('done');
      setStreamingMsgId(null);
      setShowTyping(false);
      if (!completed || aborted) break;
    }

    setSending(false);
  }, [activeChatId, applyAvatarState, diceMode, finishDiceRoll, handleIncomingDesktopAction, notifyAssistantResponse, preferredModel, refreshContextTokens]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    const hasImages = attachedImages.length > 0;
    const hasDocuments = attachedDocuments.length > 0;
    if ((!text && !hasImages && !hasDocuments) || sending) return;

    const isVoice = isVoiceInputRef.current;
    isVoiceInputRef.current = false;

    setInput('');
    setSending(true);
    setShowTyping(true);

    // Dice Roll Mode: запускаем анимацию сразу при отправке
    if (diceRollEnabled) startDiceRollAnimation();

    const imagesToSend = attachedImages.map((img) => ({
      base64: img.base64,
      mime_type: img.mime_type,
    }));
    if (attachedImages.length > maxImageCount) {
      toast.error(t('attach.error.imageLimit', { count: maxImageCount }));
      return;
    }
    if (attachedImageBytes > maxImageBytes) {
      toast.error(t('attach.error.imageTotalTooLarge', {
        size: `${Math.round(maxImageBytes / (1024 * 1024))} MB`,
      }));
      return;
    }

    const documentsToSend = attachedDocuments.map((doc) => ({
      base64: doc.base64,
      filename: doc.filename,
    }));

    // Clear attached images and documents immediately
    setAttachedImages([]);
    setAttachedDocuments([]);

    const displayText = text || (hasImages ? '[Image]' : '') || (hasDocuments ? '[Document]' : '');
    // Build temporary images for user message (preview URLs from attached files)
    const tempUserImages: api.MessageImage[] | undefined = hasImages
      ? attachedImages.map((img) => ({ url: img.preview, type: 'user_photo' as const }))
      : undefined;
    const tempUserMsg: api.Message = {
      id: -Date.now(), role: 'user', content: displayText, created_at: Math.floor(Date.now() / 1000),
      images: tempUserImages,
      attachments: hasDocuments
        ? attachedDocuments.map((doc) => ({ name: doc.filename, size_bytes: doc.size_bytes, mime_type: '', extracted_text: '', url: '', filename: doc.filename }))
        : undefined,
    };

    setMessages((prev) => [...prev, tempUserMsg]);

    // ID для временного сообщения ассистента — создаётся лениво при первом контенте
    // Используем объект-флаг (а не let) чтобы разделять состояние между
    // appendToAssistant и stream-аппендером.
    const assistantMsgCreatedRef = { current: false };
    const tempAssistantId = -Date.now() - 1;

    // Инициализируем стрим-аппендер для этой генерации
    streamAppenderRef.current.reset(tempAssistantId, setShowTyping, setMessages);
    // Разделяем флаг создания сообщения между appendToAssistant и стримером
    Object.defineProperty(streamAppenderRef.current, 'assistantMsgCreated', {
      get: () => assistantMsgCreatedRef.current,
      set: (v: boolean) => { assistantMsgCreatedRef.current = v; },
      configurable: true,
    });
    // Сбрасываем состояние стриминга для UI-индикатора
    setStreamingState('idle');
    setStreamingMsgId(tempAssistantId);

    const appendToAssistant = (text: string) => {
      if (!assistantMsgCreatedRef.current) {
        assistantMsgCreatedRef.current = true;
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

    const primaryRoomResult = { current: null as api.ChatSendResponse | null };
    await api.streamChatMessage(
      text || ' ',
      activeChatId ?? undefined,
      imagesToSend.length > 0 ? imagesToSend : undefined,
      getAvatarManifest(),
      currentAvatarStateRef.current,
      {
        onIntermediate: (stepText) => {
          // Сбрасываем буфер стримера, чтобы новый шаг начался с чистой строки
          streamAppenderRef.current.flushNow();
          appendToAssistant(stepText);
        },
        onStreamToken: (token) => {
          setStreamingState((prev) => prev === 'idle' || prev === 'reasoning' ? 'content' : prev);
          streamAppenderRef.current.appendText(token);
        },
        onReasoningStream: (token) => {
          setStreamingState((prev) => prev === 'idle' ? 'reasoning' : prev);
          streamAppenderRef.current.appendReasoning(token);
        },
        onToolStatus: (statusText) => {
          streamAppenderRef.current.flushNow();
          appendToAssistant(`_${statusText}_`);
        },
        onDisplayState: (state) => {
          applyAvatarState(state);
        },
        onDesktopAction: handleIncomingDesktopAction,
        onMapUpdate: (data) => {
          openTool('map');
          dispatchMapData(data);
        },
        onDiceRoll: (roll) => {
          // Сервер прислал результат броска — сразу останавливаем анимацию на значении.
          finishDiceRoll(roll);
        },
        onUserMessageSaved: ({ message_id, images }) => {
          setMessages((prev) => prev.map((m) => m.id === tempUserMsg.id
            ? { ...m, id: message_id, ...(images ? { images } : {}) }
            : m));
          setViewerImageMsgId((current) => current === tempUserMsg.id ? message_id : current);
          if (images && tempUserImages) {
            setViewerImageUrl((current) => {
              const index = tempUserImages.findIndex((image) => image.url === current);
              return index >= 0 ? (images[index]?.url ?? current) : current;
            });
          }
        },
        onDone: (res) => {
          primaryRoomResult.current = res;
          // Финализируем стрим-буфер перед обработкой done
          streamAppenderRef.current.flushNow();
          setStreamingState('done');
          setStreamingMsgId(null);
          // Dice Roll Mode: fallback — если событие dice_roll не дошло, используем done-поле
          if (typeof res.dice_roll === 'number' && diceRolling) {
            finishDiceRoll(res.dice_roll);
          }
          if (res.user_only) {
            setMessages((prev) => prev.map((message) =>
              res.user_message_id && (message.id === tempUserMsg.id || message.id === res.user_message_id)
                ? {
                    ...message,
                    id: res.user_message_id!,
                    ...(res.user_message_images ? { images: res.user_message_images } : {}),
                    ...(typeof res.user_token_count === 'number' ? { token_count: res.user_token_count } : {}),
                  }
                : message
            ));
            setShowTyping(false);
            setSending(false);
            setStreamingState('done');
            setStreamingMsgId(null);
            if (!activeChatId || res.chat_id !== activeChatId) {
              setActiveChatId(res.chat_id);
              loadChats();
            }
            refreshContextTokens(res.chat_id);
            return;
          }
          // Если генерация была остановлена пользователем — soft abort.
          // Сохраняем всё что бот успел сделать как обычное сообщение (если message_id > 0).
          if (res.aborted) {
            if (res.message_id > 0) {
              // Сообщение сохранено в БД — финализируем его в UI
              if (assistantMsgCreatedRef.current) {
                setMessages((prev) => prev.map(m => {
                  if (m.id === tempAssistantId) {
                    return {
                      ...m,
                      id: res.message_id,
                      ...(res.reply_text ? { content: res.reply_text } : { content: t('chat.generationStopped') }),
                      reasoning_content: res.reasoning_content ?? null,
                      tool_calls: res.tool_calls ?? null,
                      subagents: res.subagents ?? null,
                      prompt_id: res.prompt_id ?? null,
                      prompt_name: res.prompt_name ?? null,
                      agent_id: res.agent_id ?? null,
                      model_name: res.model_name ?? null,
                      provider_name: res.provider_name ?? null,
                      usage: res.message_usage ?? null,
                    };
                  }
                  if (res.user_message_id && (m.id === tempUserMsg.id || m.id === res.user_message_id)) {
                    return {
                      ...m,
                      id: res.user_message_id,
                      ...(res.user_message_images ? { images: res.user_message_images } : {}),
                    };
                  }
                  return m;
                }));
              } else {
                // Не было промежуточных — добавляем как новое
                setMessages((prev) => {
                  const updated = res.user_message_id
                    ? prev.map(m => (m.id === tempUserMsg.id || m.id === res.user_message_id) ? {
                        ...m,
                        id: res.user_message_id!,
                        ...(res.user_message_images ? { images: res.user_message_images } : {}),
                      } : m)
                    : prev;
                  return [...updated, {
                    id: res.message_id, role: 'assistant' as const,
                    content: res.reply_text || t('chat.generationStopped'),
                    created_at: Math.floor(Date.now() / 1000),
                    reasoning_content: res.reasoning_content ?? null,
                    tool_calls: res.tool_calls ?? null,
                    subagents: res.subagents ?? null,
                    prompt_id: res.prompt_id ?? null,
                    prompt_name: res.prompt_name ?? null,
                    agent_id: res.agent_id ?? null,
                    model_name: res.model_name ?? null,
                    provider_name: res.provider_name ?? null,
                    usage: res.message_usage ?? null,
                  }];
                });
              }
              refreshContextTokens(res.chat_id);
            } else if (assistantMsgCreatedRef.current) {
              // message_id === 0 — старое поведение, удаляем temp
              setMessages((prev) => prev.filter(m => m.id !== tempAssistantId));
            }
            setShowTyping(false);
            setSending(false);
            if (res.display_state) applyAvatarState(res.display_state);
            if (!activeChatId || res.chat_id !== activeChatId) {
              setActiveChatId(res.chat_id);
              loadChats();
            }
            return;
          }
          if (res.model_fallback_notice) {
            toast.warning(res.model_fallback_notice, { duration: 5000 });
          }
          // Build images array from generated_images
          const genImages: api.MessageImage[] | undefined = res.generated_images?.length
            ? res.generated_images.map(img => ({
                url: img.image_url
                  ? img.image_url
                  : `data:image/png;base64,${img.image_base64}`,
                type: 'generated' as const
              }))
            : undefined;

          if (assistantMsgCreatedRef.current) {
            setMessages((prev) => prev.map(m => {
              if (m.id === tempAssistantId) {
                return {
                  ...m,
                  id: res.message_id,
                  ...(res.reply_text ? { content: res.reply_text } : {}),
                  reasoning_content: res.reasoning_content ?? null,
                  tool_calls: res.tool_calls ?? null,
                  ...(genImages ? { images: genImages } : {}),
                  subagents: res.subagents ?? null,
                  prompt_id: res.prompt_id ?? null,
                  prompt_name: res.prompt_name ?? null,
                  agent_id: res.agent_id ?? null,
                  model_name: res.model_name ?? null,
                  provider_name: res.provider_name ?? null,
                  usage: res.message_usage ?? null,
                  ...(typeof res.token_count === 'number' ? { token_count: res.token_count } : {}),
                  ...(typeof res.reasoning_tokens === 'number' ? { reasoning_tokens: res.reasoning_tokens } : {})
                };
              }
              // Replace temp user message id with real one from server
              if (res.user_message_id && (m.id === tempUserMsg.id || m.id === res.user_message_id)) {
                return {
                  ...m,
                  id: res.user_message_id,
                  ...(res.user_message_images ? { images: res.user_message_images } : {}),
                  ...(typeof res.user_token_count === 'number' ? { token_count: res.user_token_count } : {}),
                };
              }
              return m;
            }));
          } else {
            // Ни одного промежуточного сообщения не было — добавляем финальный ответ
            setMessages((prev) => {
              const updated = res.user_message_id
                ? prev.map(m => (m.id === tempUserMsg.id || m.id === res.user_message_id) ? {
                    ...m,
                    id: res.user_message_id!,
                    ...(res.user_message_images ? { images: res.user_message_images } : {}),
                    ...(typeof res.user_token_count === 'number' ? { token_count: res.user_token_count } : {}),
                  } : m)
                : prev;
              return [...updated, {
                id: res.message_id, role: 'assistant', content: res.reply_text, created_at: Math.floor(Date.now() / 1000),
                reasoning_content: res.reasoning_content ?? null,
                tool_calls: res.tool_calls ?? null,
                images: genImages,
                subagents: res.subagents ?? null,
                prompt_id: res.prompt_id ?? null,
                prompt_name: res.prompt_name ?? null,
                agent_id: res.agent_id ?? null,
                model_name: res.model_name ?? null,
                provider_name: res.provider_name ?? null,
                usage: res.message_usage ?? null,
                ...(typeof res.token_count === 'number' ? { token_count: res.token_count } : {}),
                ...(typeof res.reasoning_tokens === 'number' ? { reasoning_tokens: res.reasoning_tokens } : {})
              }];
            });
          }
          setShowTyping(false);
          setSending(false);
          if (res.display_state) applyAvatarState(res.display_state);
          if (!activeChatId || res.chat_id !== activeChatId) {
            setActiveChatId(res.chat_id);
            loadChats();
          }
          notifyAssistantResponse(res.message_id, res.chat_id, res.reply_text);
          refreshContextTokens(res.chat_id);

          // Auto-speak response when triggered by voice input
          if (isVoice && res.reply_text) {
            ttsSpeak(res.message_id, res.reply_text);
          }
        },
        onError: (err, message) => {
          console.error('Stream error:', err);
          streamAppenderRef.current.flushNow();
          setStreamingState('done');
          setStreamingMsgId(null);
          const visibleMessage = message
            || (err.startsWith('too_many_images_max_')
              ? t('attach.error.imageLimit', { count: maxImageCount })
              : err === 'image_payload_too_large' || err === 'image_too_large'
              ? t('attach.error.imageTotalTooLarge', {
                  size: `${Math.round(maxImageBytes / (1024 * 1024))} MB`,
                })
              : err === 'connection_lost_before_request_accepted'
                ? t('chat.connectionLostBeforeSend')
                : undefined);
          if (visibleMessage) {
            // Show localized error as assistant message (not saved to DB)
            setMessages((prev) => {
              const cleaned = prev.filter(m => m.id !== tempAssistantId);
              const errorIdx = cleaned.findIndex(m => m.id === tempUserMsg.id);
              if (errorIdx >= 0) {
                const updated = [...cleaned];
                updated.splice(errorIdx + 1, 0, {
                  id: `error-${Date.now()}`,
                  role: 'assistant' as const,
                  content: visibleMessage,
                  created_at: new Date().toISOString(),
                } as any);
                return updated;
              }
              return [...cleaned, {
                id: `error-${Date.now()}`,
                role: 'assistant' as const,
                content: visibleMessage,
                created_at: new Date().toISOString(),
              } as any];
            });
          } else {
            if (assistantMsgCreatedRef.current) {
              setMessages((prev) => prev.filter(m => m.id !== tempAssistantId && m.id !== tempUserMsg.id));
            } else {
              setMessages((prev) => prev.filter(m => m.id !== tempUserMsg.id));
            }
          }
          setShowTyping(false);
          setSending(false);
          // Сбрасываем кубик только если он ещё крутится (результат не успел прийти)
          if (diceStatus === 'rolling') {
            if (diceAnimTimer.current) { clearTimeout(diceAnimTimer.current); diceAnimTimer.current = null; }
            setDiceRolling(false);
            setDiceStatus('idle');
            setDiceValue(null);
          }
        }
      },
      {
        ...(isVoice ? { isVoice: true } : {}),
        preferredModel,
        dice_mode: diceMode,
        ...(roomCreated && roomAutoRespond && roomCharacters.length > 0
          ? { agentId: roomMode === 'manual'
              ? (nextRoomParticipant ?? roomCharacters[0].id)
              : roomCharacters[0].id }
          : {}),
        ...(roomCreated && (!roomAutoRespond || roomCharacters.length === 0)
          ? { userOnly: true }
          : {}),
      },
      documentsToSend.length > 0 ? documentsToSend : undefined
    );
    if (
      primaryRoomResult.current
      && !primaryRoomResult.current.user_only
      && !primaryRoomResult.current.aborted
      && roomCreated
      && roomAutoRespond
      && roomMode === 'round'
      && roomCharacters.length > 1
    ) {
      await runRoomAgentSequence(roomCharacters.slice(1).map((agent) => agent.id));
    }
  }, [input, sending, activeChatId, attachedImages, attachedDocuments, attachedImageBytes, maxImageBytes, maxImageCount, preferredModel, handleIncomingDesktopAction, diceRollEnabled, startDiceRollAnimation, finishDiceRoll, diceStatus, diceMode, applyAvatarState, t, roomCreated, roomAutoRespond, roomCharacters, roomMode, nextRoomParticipant, runRoomAgentSequence]);

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
          const text = await window.electronAPI.transcribeAudio(arrayBuffer, getSpeechRecognitionLanguage());
          if (text) setInput((prev) => prev ? `${prev} ${text}` : text);
        } catch (err) {
          console.error('[voice] Transcription failed:', err);
          toast.error(t('chat.toasts.speechRecognitionFailed'));
        } finally {
          setIsTranscribing(false);
        }
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error('[voice] Microphone access denied:', err);
      toast.error(t('chat.toasts.microphoneDenied'));
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

  useEffect(() => {
    const containsFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const handleWindowDragOver = (event: DragEvent) => {
      if (!containsFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const clearWindowDrag = (event: DragEvent) => {
      if (containsFiles(event)) event.preventDefault();
      setDraggingFiles(false);
    };

    window.addEventListener('dragover', handleWindowDragOver);
    window.addEventListener('drop', clearWindowDrag);
    window.addEventListener('dragend', clearWindowDrag);
    return () => {
      window.removeEventListener('dragover', handleWindowDragOver);
      window.removeEventListener('drop', clearWindowDrag);
      window.removeEventListener('dragend', clearWindowDrag);
    };
  }, []);

  const handleDroppedFiles = useCallback(async (files: FileList) => {
    if (sending || files.length === 0) return;
    const result = await prepareAttachmentFiles(files, {
      currentImageCount: attachedImages.length,
      maxImageCount,
      currentImageBytes: attachedImageBytes,
      maxTotalImageBytes: maxImageBytes,
    });
    if (result.images.length > 0) {
      setAttachedImages((prev) => [...prev, ...result.images]);
    }
    if (result.documents.length > 0) {
      setAttachedDocuments((prev) => [...prev, ...result.documents]);
    }
    if (result.error) {
      toast.error(t(result.error.key, result.error.values));
    }
  }, [attachedImageBytes, attachedImages.length, maxImageBytes, maxImageCount, sending, t]);

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

      e.preventDefault();

      try {
        if (attachedImages.length >= maxImageCount) {
          toast.error(t('attach.error.imageLimit', { count: maxImageCount }));
          break;
        }
        const newItem = await prepareImageForUpload(file);
        if (attachedImageBytes + newItem.size_bytes > maxImageBytes) {
          URL.revokeObjectURL(newItem.preview);
          toast.error(t('attach.error.imageTotalTooLarge', {
            size: `${Math.round(maxImageBytes / (1024 * 1024))} MB`,
          }));
          break;
        }
        setAttachedImages((prev) => [...prev, newItem]);
      } catch {
        toast.error(t('attach.error.imagePrepare', { name: file.name }));
      }

      // Only handle first image from paste
      break;
    }
  }, [attachedImages.length, attachedImageBytes, maxImageBytes, maxImageCount, t]);

  const handleAttachFromModal = useCallback((items: { images: ImageItem[]; documents: DocumentItem[] }) => {
    if (items.images.length > 0) {
      setAttachedImages((prev) => {
        const combined = [...prev];
        let totalBytes = prev.reduce((total, image) => total + image.size_bytes, 0);
        for (const image of items.images) {
          if (combined.length >= maxImageCount || totalBytes + image.size_bytes > maxImageBytes) {
            URL.revokeObjectURL(image.preview);
            continue;
          }
          combined.push(image);
          totalBytes += image.size_bytes;
        }
        return combined;
      });
    }
    if (items.documents.length > 0) {
      setAttachedDocuments((prev) => [...prev, ...items.documents]);
    }
    setShowAttachModal(false);
  }, [maxImageBytes, maxImageCount]);

  const handleDeleteAttachment = useCallback(async (messageId: number, filename: string) => {
    if (!activeChatId) return;
    // Optimistic: remove from UI immediately
    setMessages(prev => prev.map(m => {
      if (m.id !== messageId || !m.attachments) return m;
      return { ...m, attachments: m.attachments.filter(a => a.filename !== filename) };
    }));
    try {
      const res = await api.deleteAttachment(activeChatId, messageId, filename);
      if (typeof res.token_count === 'number') {
        setMessages(prev => prev.map(m => m.id === messageId ? { ...m, token_count: res.token_count } : m));
      }
    } catch {
      toast.error(t('chat.toasts.fileDeleteFailed'));
      // Reload to restore
      const data = await api.getMessages(activeChatId);
      setMessages(data.messages);
    }
  }, [activeChatId]);

  const performLogout = () => {
    setShowLogoutConfirm(false);
    logout();
    navigate('/login', { replace: true });
  };
  const handleLogout = () => setShowLogoutConfirm(true);
  const toggleNotifications = () => {
    void window.electronAPI.setNotificationsEnabled(!notificationsEnabled)
      .then(setNotificationsEnabledState)
      .catch(() => toast.error(t('settings.toasts.saveSettingFailed')));
  };

  const closeMsgMenu = useCallback(() => {
    setMsgMenuId(null);
    if (msgMenuTimerRef.current) { clearTimeout(msgMenuTimerRef.current); msgMenuTimerRef.current = null; }
  }, []);

  // Close context menu on outside click
  useEffect(() => {
    const close = () => { setContextMenuChatId(null); setDemoMoveMenuOpen(false); closeMsgMenu(); };
    if (contextMenuChatId !== null || msgMenuId !== null) {
      document.addEventListener('click', close);
      return () => document.removeEventListener('click', close);
    }
  }, [contextMenuChatId, msgMenuId, closeMsgMenu]);

  const handleKebabClick = (e: React.MouseEvent, chatId: number) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setContextMenuPos({ x: rect.right, y: rect.bottom });
    setDemoMoveMenuOpen(false);
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

  const handleToggleBotHidden = async (chatId: number) => {
    const chat = chats.find(c => c.id === chatId);
    const newHidden = !chat?.bot_hidden;
    setContextMenuChatId(null);
    // Optimistic update
    setChats(prev => prev.map(c => c.id === chatId ? { ...c, bot_hidden: newHidden } : c));
    try {
      await api.setChatBotHidden(chatId, newHidden);
    } catch (err) {
      console.error('Failed to toggle bot visibility:', err);
      // Revert on error
      setChats(prev => prev.map(c => c.id === chatId ? { ...c, bot_hidden: !newHidden } : c));
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletingChatId) return;
    try {
      await api.deleteChat(deletingChatId);
      const deletedChat = chats.find((chat) => chat.id === deletingChatId);
      setChats(prev => prev.filter(c => c.id !== deletingChatId));
      if (deletedChat) {
        if (deletedChat.folder_id === null) {
          setUnfiledChatCount((current) => Math.max(0, current - 1));
        } else {
          setChatFolders((current) => current.map((folder) => folder.id === deletedChat.folder_id
            ? { ...folder, chat_count: Math.max(0, folder.chat_count - 1) }
            : folder));
        }
        const key: ChatSectionKey = deletedChat.folder_id === null ? 'unfiled' : `folder:${deletedChat.folder_id}`;
        const paging = sectionPagingRef.current[key];
        if (paging) {
          updateSectionPaging({
            ...sectionPagingRef.current,
            [key]: {
              ...paging,
              offset: Math.max(0, paging.offset - 1),
              total: Math.max(0, paging.total - 1),
              hasMore: Math.max(0, paging.offset - 1) < Math.max(0, paging.total - 1),
            },
          });
        }
      }
      if (activeChatId === deletingChatId) {
        setActiveChatId(null);
        setMessages([]);
      }
      void refreshChatListMetadata();
    } catch (err) {
      console.error('Failed to delete chat:', err);
    }
    setDeletingChatId(null);
  };

  const handleExportChat = async (chatId: number) => {
    setContextMenuChatId(null);
    const chat = chats.find(c => c.id === chatId);
    const chatName = chat?.title || t('chat.export.defaultTitle');
    try {
      const res = await api.getMessages(chatId, 10000);
      if (res.messages.length === 0) {
        toast.error(t('chat.toasts.emptyChat'));
        return;
      }
      const blob = await generateChatDocxBlob(res.messages, chatName);
      const buffer = await blob.arrayBuffer();
      const d = new Date();
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const safeName = chatName.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 60);
      const result = await window.electronAPI?.saveFile(`${safeName} ${dateStr}.docx`, buffer);
      if (result && !result.canceled) {
        toast.success(t('chat.toasts.chatSaved'));
      }
    } catch (err) {
      console.error('Failed to export chat:', err);
      toast.error(t('chat.toasts.chatExportFailed'));
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

  const handleStartEdit = (messageId: number) => {
    closeMsgMenu();
    const msg = messages.find(m => m.id === messageId);
    if (!msg) return;
    setEditingMsgId(messageId);
    setEditingText(msg.content);
  };

  const handleSaveEdit = async (messageId: number) => {
    if (!activeChatId || !editingMsgId) return;
    const trimmed = editingText.trim();
    if (!trimmed) return;
    const msg = messages.find(m => m.id === messageId);
    if (!msg) return;
    const oldContent = msg.content;
    setMessages(prev => prev.map(m => m.id === messageId ? { ...m, content: trimmed } : m));
    setEditingMsgId(null);
    setEditingText('');
    try {
      const result = await api.editMessage(activeChatId, messageId, trimmed);
      if (typeof result.token_count === 'number') {
        setMessages(prev => prev.map(m => m.id === messageId ? { ...m, token_count: result.token_count } : m));
      }
    } catch (err) {
      console.error('Failed to edit message:', err);
      setMessages(prev => prev.map(m => m.id === messageId ? { ...m, content: oldContent } : m));
    }
  };

  const handleCancelEdit = () => {
    setEditingMsgId(null);
    setEditingText('');
  };

  const [forking, setForking] = useState(false);

  const handleForkFromMessage = async (messageId: number) => {
    closeMsgMenu();
    if (!activeChatId || forking) return;
    setForking(true);
    try {
      const res = await api.forkChatFromMessage(activeChatId, messageId);
      await loadChats();
      selectChat(res.chat_id);
    } catch (err) {
      console.error('Failed to fork chat:', err);
    } finally {
      setForking(false);
    }
  };

  const handleRegenerate = useCallback(async (assistantMsgId: number) => {
    if (!activeChatId || sending) return;
    const idx = messages.findIndex(m => m.id === assistantMsgId);
    if (idx < 0) return;
    const responseAgentId = messages[idx].agent_id ?? undefined;
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

    // Dice Roll Mode: regenerate тоже бросает кубик (флаг серверный)
    if (diceRollEnabled) startDiceRollAnimation();

    const assistantMsgCreatedRef = { current: false };
    const tempAssistantId = -Date.now() - 1;
    streamAppenderRef.current.reset(tempAssistantId, setShowTyping, setMessages);
    Object.defineProperty(streamAppenderRef.current, 'assistantMsgCreated', {
      get: () => assistantMsgCreatedRef.current,
      set: (v: boolean) => { assistantMsgCreatedRef.current = v; },
      configurable: true,
    });
    setStreamingState('idle');
    setStreamingMsgId(tempAssistantId);

    const appendToAssistant = (text: string) => {
      if (!assistantMsgCreatedRef.current) {
        assistantMsgCreatedRef.current = true;
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
      currentAvatarStateRef.current,
      {
        onIntermediate: (stepText) => { streamAppenderRef.current.flushNow(); appendToAssistant(stepText); },
        onStreamToken: (token) => { setStreamingState((p) => p === 'idle' || p === 'reasoning' ? 'content' : p); streamAppenderRef.current.appendText(token); },
        onReasoningStream: (token) => { setStreamingState((p) => p === 'idle' ? 'reasoning' : p); streamAppenderRef.current.appendReasoning(token); },
        onToolStatus: (statusText) => { streamAppenderRef.current.flushNow(); appendToAssistant(`_${statusText}_`); },
        onDisplayState: (state) => applyAvatarState(state),
        onDesktopAction: handleIncomingDesktopAction,
        onMapUpdate: (data) => { openTool('map'); dispatchMapData(data); },
        onDiceRoll: (roll) => finishDiceRoll(roll),
        onDone: (res) => {
          streamAppenderRef.current.flushNow();
          setStreamingState('done');
          setStreamingMsgId(null);
          const responseMetadata = {
            prompt_id: res.prompt_id ?? null,
            prompt_name: res.prompt_name ?? null,
            agent_id: res.agent_id ?? null,
            model_name: res.model_name ?? null,
            provider_name: res.provider_name ?? null,
            usage: res.message_usage ?? null,
            ...(typeof res.token_count === 'number' ? { token_count: res.token_count } : {}),
            ...(typeof res.reasoning_tokens === 'number' ? { reasoning_tokens: res.reasoning_tokens } : {}),
          };
          // Fallback: если событие dice_roll потерялось, используем done-поле (только если ещё крутится)
          if (typeof res.dice_roll === 'number' && diceRolling) finishDiceRoll(res.dice_roll);
          if (res.aborted) {
            if (res.message_id > 0) {
              if (assistantMsgCreatedRef.current) {
                setMessages((prev) => prev.map(m => {
                  if (m.id === tempAssistantId) {
                    return {
                      ...m,
                      id: res.message_id,
                      ...(res.reply_text ? { content: res.reply_text } : { content: t('chat.generationStopped') }),
                      reasoning_content: res.reasoning_content ?? null,
                      tool_calls: res.tool_calls ?? null,
                      subagents: res.subagents ?? null,
                      ...responseMetadata,
                    };
                  }
                  return m;
                }));
              } else {
                setMessages((prev) => [...prev, {
                  id: res.message_id, role: 'assistant' as const,
                  content: res.reply_text || t('chat.generationStopped'),
                  created_at: Math.floor(Date.now() / 1000),
                  reasoning_content: res.reasoning_content ?? null,
                  tool_calls: res.tool_calls ?? null,
                  subagents: res.subagents ?? null,
                  ...responseMetadata,
                }]);
              }
            } else if (assistantMsgCreatedRef.current) {
              setMessages((prev) => prev.filter(m => m.id !== tempAssistantId));
            }
            setShowTyping(false);
            setSending(false);
            if (res.display_state) applyAvatarState(res.display_state);
            refreshContextTokens(res.chat_id);
            return;
          }
          if (res.model_fallback_notice) {
            toast.warning(res.model_fallback_notice, { duration: 5000 });
          }
          const genImages: api.MessageImage[] | undefined = res.generated_images?.length
            ? res.generated_images.map(img => ({
                url: img.image_url
                  ? img.image_url
                  : `data:image/png;base64,${img.image_base64}`,
                type: 'generated' as const
              }))
            : undefined;

          if (assistantMsgCreatedRef.current) {
            setMessages((prev) => prev.map(m =>
              m.id === tempAssistantId
                ? { ...m, id: res.message_id, ...(res.reply_text ? { content: res.reply_text } : {}), reasoning_content: res.reasoning_content ?? null, tool_calls: res.tool_calls ?? null, subagents: res.subagents ?? null, ...(genImages ? { images: genImages } : {}), ...responseMetadata }
                : m
            ));
          } else {
            setMessages((prev) => [...prev, {
              id: res.message_id, role: 'assistant', content: res.reply_text, created_at: Math.floor(Date.now() / 1000),
              reasoning_content: res.reasoning_content ?? null,
              tool_calls: res.tool_calls ?? null,
              subagents: res.subagents ?? null,
              images: genImages,
              ...responseMetadata,
            }]);
          }
          setShowTyping(false);
          setSending(false);
          if (res.display_state) applyAvatarState(res.display_state);
          notifyAssistantResponse(res.message_id, res.chat_id, res.reply_text);
          refreshContextTokens(res.chat_id);
        },
        onError: (err, message) => {
          console.error('Regenerate error:', err);
          streamAppenderRef.current.flushNow();
          setStreamingState('done');
          setStreamingMsgId(null);
          if (message && assistantMsgCreatedRef.current) {
            setMessages((prev) => {
              const idx = prev.findIndex(m => m.id === tempAssistantId);
              if (idx >= 0) {
                const updated = [...prev];
                updated[idx] = { ...updated[idx], content: message } as any;
                return updated;
              }
              return prev;
            });
          } else if (assistantMsgCreatedRef.current) {
            setMessages((prev) => prev.filter(m => m.id !== tempAssistantId));
          }
          setShowTyping(false);
          setSending(false);
        },
      },
      { preferredModel: preferredModel, skip_user_history: true, regenerate_from_history: true, dice_mode: diceMode, agentId: responseAgentId }
    );
  }, [activeChatId, sending, messages, preferredModel, handleIncomingDesktopAction, diceRollEnabled, startDiceRollAnimation, finishDiceRoll, diceMode, applyAvatarState]);

  const handleRegenerateWithHint = useCallback(async (assistantMsgId: number, hint: string) => {
    if (!activeChatId || sending || !hint.trim()) return;
    setRegenHintMsgId(null);
    setRegenHintText('');
    const idx = messages.findIndex(m => m.id === assistantMsgId);
    if (idx < 0) return;
    const responseAgentId = messages[idx].agent_id ?? undefined;
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

    // Dice Roll Mode: regenerate тоже бросает кубик (флаг серверный)
    if (diceRollEnabled) startDiceRollAnimation();

    const assistantMsgCreatedRef = { current: false };
    const tempAssistantId = -Date.now() - 1;
    streamAppenderRef.current.reset(tempAssistantId, setShowTyping, setMessages);
    Object.defineProperty(streamAppenderRef.current, 'assistantMsgCreated', {
      get: () => assistantMsgCreatedRef.current,
      set: (v: boolean) => { assistantMsgCreatedRef.current = v; },
      configurable: true,
    });
    setStreamingState('idle');
    setStreamingMsgId(tempAssistantId);

    const appendToAssistant = (text: string) => {
      if (!assistantMsgCreatedRef.current) {
        assistantMsgCreatedRef.current = true;
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
      currentAvatarStateRef.current,
      {
        onIntermediate: (stepText) => { streamAppenderRef.current.flushNow(); appendToAssistant(stepText); },
        onStreamToken: (token) => { setStreamingState((p) => p === 'idle' || p === 'reasoning' ? 'content' : p); streamAppenderRef.current.appendText(token); },
        onReasoningStream: (token) => { setStreamingState((p) => p === 'idle' ? 'reasoning' : p); streamAppenderRef.current.appendReasoning(token); },
        onToolStatus: (statusText) => { streamAppenderRef.current.flushNow(); appendToAssistant(`_${statusText}_`); },
        onDisplayState: (state) => applyAvatarState(state),
        onDesktopAction: handleIncomingDesktopAction,
        onMapUpdate: (data) => { openTool('map'); dispatchMapData(data); },
        onDiceRoll: (roll) => finishDiceRoll(roll),
        onDone: (res) => {
          streamAppenderRef.current.flushNow();
          setStreamingState('done');
          setStreamingMsgId(null);
          const responseMetadata = {
            prompt_id: res.prompt_id ?? null,
            prompt_name: res.prompt_name ?? null,
            agent_id: res.agent_id ?? null,
            model_name: res.model_name ?? null,
            provider_name: res.provider_name ?? null,
            usage: res.message_usage ?? null,
            ...(typeof res.token_count === 'number' ? { token_count: res.token_count } : {}),
            ...(typeof res.reasoning_tokens === 'number' ? { reasoning_tokens: res.reasoning_tokens } : {}),
          };
          // Fallback: если событие dice_roll потерялось, используем done-поле (только если ещё крутится)
          if (typeof res.dice_roll === 'number' && diceRolling) finishDiceRoll(res.dice_roll);
          if (res.aborted) {
            if (res.message_id > 0) {
              if (assistantMsgCreatedRef.current) {
                setMessages((prev) => prev.map(m => {
                  if (m.id === tempAssistantId) {
                    return {
                      ...m,
                      id: res.message_id,
                      ...(res.reply_text ? { content: res.reply_text } : { content: t('chat.generationStopped') }),
                      reasoning_content: res.reasoning_content ?? null,
                      tool_calls: res.tool_calls ?? null,
                      subagents: res.subagents ?? null,
                      ...responseMetadata,
                    };
                  }
                  return m;
                }));
              } else {
                setMessages((prev) => [...prev, {
                  id: res.message_id, role: 'assistant' as const,
                  content: res.reply_text || t('chat.generationStopped'),
                  created_at: Math.floor(Date.now() / 1000),
                  reasoning_content: res.reasoning_content ?? null,
                  tool_calls: res.tool_calls ?? null,
                  subagents: res.subagents ?? null,
                  ...responseMetadata,
                }]);
              }
            } else if (assistantMsgCreatedRef.current) {
              setMessages((prev) => prev.filter(m => m.id !== tempAssistantId));
            }
            setShowTyping(false);
            setSending(false);
            if (res.display_state) applyAvatarState(res.display_state);
            refreshContextTokens(res.chat_id);
            return;
          }
          if (res.model_fallback_notice) {
            toast.warning(res.model_fallback_notice, { duration: 5000 });
          }
          const genImages: api.MessageImage[] | undefined = res.generated_images?.length
            ? res.generated_images.map(img => ({
                url: img.image_url
                  ? img.image_url
                  : `data:image/png;base64,${img.image_base64}`,
                type: 'generated' as const
              }))
            : undefined;

          if (assistantMsgCreatedRef.current) {
            setMessages((prev) => prev.map(m =>
              m.id === tempAssistantId
                ? { ...m, id: res.message_id, ...(res.reply_text ? { content: res.reply_text } : {}), reasoning_content: res.reasoning_content ?? null, tool_calls: res.tool_calls ?? null, subagents: res.subagents ?? null, ...(genImages ? { images: genImages } : {}), ...responseMetadata }
                : m
            ));
          } else {
            setMessages((prev) => [...prev, {
              id: res.message_id, role: 'assistant', content: res.reply_text, created_at: Math.floor(Date.now() / 1000),
              reasoning_content: res.reasoning_content ?? null,
              tool_calls: res.tool_calls ?? null,
              subagents: res.subagents ?? null,
              images: genImages,
              ...responseMetadata,
            }]);
          }
          setShowTyping(false);
          setSending(false);
          if (res.display_state) applyAvatarState(res.display_state);
          notifyAssistantResponse(res.message_id, res.chat_id, res.reply_text);
          refreshContextTokens(res.chat_id);
        },
        onError: (err) => {
          console.error('Regenerate with hint error:', err);
          streamAppenderRef.current.flushNow();
          setStreamingState('done');
          setStreamingMsgId(null);
          if (assistantMsgCreatedRef.current) {
            setMessages((prev) => prev.filter(m => m.id !== tempAssistantId));
          }
          setShowTyping(false);
          setSending(false);
        },
      },
      { preferredModel: preferredModel, regenerate_hint: hint.trim(), skip_user_history: true, regenerate_from_history: true, dice_mode: diceMode, agentId: responseAgentId }
    );
  }, [activeChatId, sending, messages, preferredModel, handleIncomingDesktopAction, diceRollEnabled, startDiceRollAnimation, finishDiceRoll, diceMode, applyAvatarState]);

  const handleCopyMessage = (messageId: number) => {
    const msg = messages.find(m => m.id === messageId);
    if (!msg) return;
    navigator.clipboard.writeText(msg.content).then(
      () => toast.success(t('chat.toasts.copied')),
      () => toast.error(t('chat.toasts.copyFailed')),
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
        toast.success(t('chat.toasts.fileSaved'));
      }
    } catch (err) {
      console.error('Failed to export docx:', err);
      toast.error(t('chat.toasts.fileSaveFailed'));
    }
  };

  const handleSendToTelegram = async (messageId: number) => {
    closeMsgMenu();
    try {
      await api.sendMessageToTelegram(messageId);
      toast.success(t('chat.toasts.telegramSent'));
    } catch (err: any) {
      const error = err?.data?.error || err?.message || '';
      if (error === 'telegram_not_linked') {
        toast.error(t('chat.toasts.telegramNotLinked'));
      } else if (error === 'telegram_not_configured') {
        toast.error(t('chat.toasts.telegramNotConfigured'));
      } else {
        toast.error(t('chat.toasts.telegramSendFailed'));
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
      currentAvatarStateRef.current = { ...(currentAvatarStateRef.current || {}), loop_reaction: 'think' };
      startAvatarLoop('think');
    } else {
      currentAvatarStateRef.current = { ...(currentAvatarStateRef.current || {}), loop_reaction: undefined };
      stopAvatarLoop();
    }
  }, [sending]);

  // Listen for avatar state from Electron main process (IPC)
  useEffect(() => {
    const unsub = window.electronAPI?.onAvatarState?.((payload) => {
      applyAvatarState(payload as SetDisplayStatePayload);
    });
    return () => unsub?.();
  }, [applyAvatarState]);

  // ── Wake word: stream mic chunks to ONNX listener, react to detections ──
  const speechRecorderRef = useRef<ReturnType<typeof createSpeechRecorder> | null>(null);
  const [wakeWordEnabled, setWakeWordEnabled] = useState(() => getWakeWordEnabled());

  // Listen for external toggles (SettingsModal Voice tab)
  useEffect(() => {
    const handler = (e: Event) => {
      const enabled = (e as CustomEvent<{ enabled: boolean }>).detail?.enabled;
      if (typeof enabled === 'boolean') setWakeWordEnabled(enabled);
    };
    window.addEventListener('chatter:wakeword-toggle', handler);
    return () => window.removeEventListener('chatter:wakeword-toggle', handler);
  }, []);

  // Detection callback — set up once while ChatPage is mounted
  useEffect(() => {
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
            const text = await window.electronAPI.transcribeAudio(arrayBuffer, getSpeechRecognitionLanguage());
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
            toast.error(t('chat.toasts.speechRecognitionFailed'));
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
          toast.error(t('chat.toasts.voiceRecordingFailed'));
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
      speechRecorderRef.current?.stop();
      speechRecorderRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Start/stop the ONNX listener + microphone stream reactively
  useEffect(() => {
    let disposed = false;

    if (wakeWordEnabled) {
      void (async () => {
        try {
          const result = await window.electronAPI.startWakeWord();
          if (!result.ok) {
            console.error('[wakeword] failed to start:', result.error);
            toast.error(t('chat.toasts.wakeWordFailed'));
            return;
          }
          if (!disposed) await startWakeWordAudioStream();
        } catch (error) {
          console.error('[wakeword] failed to start:', error);
          toast.error(t('chat.toasts.wakeWordFailed'));
        }
      })();
    }

    return () => {
      disposed = true;
      void stopWakeWordAudioStream();
      void window.electronAPI.stopWakeWord();
    };
  }, [wakeWordEnabled, t]);

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
  const formatTime = (timestamp: number) => formatMessageTime(timestamp, locale);

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
      const uuid = crypto.randomUUID().split('-')[0];
      const fileName = `image_${dateStr}_${uuid}.${ext}`;
      const result = await window.electronAPI?.saveFile(fileName, buffer);
      if (result && !result.canceled) {
        toast.success(t('chat.toasts.imageSaved'));
      }
    } catch (err) {
      console.error('Failed to download image:', err);
      toast.error(t('chat.toasts.imageSaveFailed'));
    }
  }, []);

  const handleDeleteImage = useCallback(async (messageId: number, url: string) => {
    setDeletingImage(true);
    try {
      await api.deleteMessageImage(messageId, url);
      // Убираем картинку из messages
      setMessages(prev => prev.map(m => {
        if (m.id !== messageId || !m.images) return m;
        const filtered = m.images.filter(img => img.url !== url);
        return { ...m, images: filtered.length > 0 ? filtered : undefined };
      }));
      setImageDeleteTarget(null);
      setViewerImageSrc(null);
      setViewerImageMsgId(null);
      setViewerImageUrl(null);
    } catch (err) {
      console.error('Failed to delete image:', err);
      toast.error(t('chat.toasts.imageDeleteFailed'));
    } finally {
      setDeletingImage(false);
    }
  }, []);

  const handleToggleReasoning = useCallback((messageId: number) => {
    setOpenReasoningId((current) => current === messageId ? null : messageId);
  }, []);

  const handleToggleToolCalls = useCallback((messageId: number) => {
    setOpenToolCallsId((current) => current === messageId ? null : messageId);
  }, []);

  const handleToggleSubagents = useCallback((messageId: number) => {
    setOpenSubagentsId((current) => current === messageId ? null : messageId);
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

  const renderSidebarChat = (chat: api.ChatInfo, nested = false) => (
    <DemoDraggableChat key={chat.id} chatId={chat.id}>
      {(dragHandleProps) => <div
        className={`${s.chatItem} ${nested ? s.chatItemNested : ''} ${chat.id === activeChatId ? s.chatItemActive : ''}`}
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
          <Tooltip content={chat.title || t('chat.sidebar.newChat')} delayDuration={600} arrowAtPointer>
            <div className={s.chatItemTitle}>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={chat.title || t('chat.sidebar.newChat')}
                  initial={{ opacity: 0, x: 0, filter: 'blur(4px)' }}
                  animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, x: 0, filter: 'blur(4px)' }}
                  transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                  style={{ display: 'inline-block' }}
                >
                  {chat.title || t('chat.sidebar.newChat')}
                </motion.span>
              </AnimatePresence>
            </div>
          </Tooltip>
        )}
        {getUnread(chat.id) > 0 && (
          <span className={s.unreadBadge}>{getUnread(chat.id)}</span>
        )}
        <div className={s.chatItemControls}>
          <button
            className={s.kebabBtn}
            onClick={(e) => handleKebabClick(e, chat.id)}
            title={t('common.actions')}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
              <circle cx="8" cy="3" r="1.5" />
              <circle cx="8" cy="8" r="1.5" />
              <circle cx="8" cy="13" r="1.5" />
            </svg>
          </button>
          <button
            className={s.chatDragHandle}
            {...dragHandleProps}
            onClick={(event) => event.stopPropagation()}
            title={t('chat.sidebar.folders.dragChat')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 1.5v13M1.5 8h13" />
              <polyline points="5.7 3.8 8 1.5 10.3 3.8" />
              <polyline points="5.7 12.2 8 14.5 10.3 12.2" />
              <polyline points="3.8 5.7 1.5 8 3.8 10.3" />
              <polyline points="12.2 5.7 14.5 8 12.2 10.3" />
            </svg>
          </button>
        </div>
        </div>
        {renamingChatId !== chat.id && (
          <div className={s.chatItemTime}>{formatTime(chat.created_at)}</div>
        )}
      </div>}
    </DemoDraggableChat>
  );

  const demoFolders = chatFolders.map((folder) => ({
    ...folder,
    chats: chats.filter((chat) => chat.folder_id === folder.id),
  }));
  const demoUnfiledChats = chats.filter((chat) => chat.folder_id === null);
  const demoDraggingChat = chats.find((chat) => chat.id === demoDraggingChatId) ?? null;

  const toggleDemoFolder = (folderId: number) => {
    setDemoExpandedFolders((current) => ({ ...current, [folderId]: current[folderId] === false }));
  };

  const startDemoFolderRename = (folderId: number, currentName: string) => {
    setDemoFolderMenuId(null);
    setDemoRenamingFolderId(folderId);
    setDemoRenamingFolderName(currentName);
  };

  const toggleDemoFolderMenu = (event: React.MouseEvent<HTMLButtonElement>, folderId: number) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setDemoFolderMenuPos({ x: rect.right + 4, y: rect.top });
    setDemoFolderMenuId((current) => current === folderId ? null : folderId);
  };

  const finishDemoFolderRename = async () => {
    if (!demoRenamingFolderId) return;
    const folderId = demoRenamingFolderId;
    const nextName = demoRenamingFolderName.trim();
    setDemoRenamingFolderId(null);
    setDemoRenamingFolderName('');
    if (!nextName) return;
    const previousName = chatFolders.find((folder) => folder.id === folderId)?.name;
    setChatFolders((current) => current.map((folder) => folder.id === folderId ? { ...folder, name: nextName } : folder));
    try {
      await api.renameChatFolder(folderId, nextName);
    } catch (error) {
      console.error('Failed to rename chat folder:', error);
      if (previousName) {
        setChatFolders((current) => current.map((folder) => folder.id === folderId ? { ...folder, name: previousName } : folder));
      }
    }
  };

  const deleteDemoFolder = async (folderId: number) => {
    const previousFolders = chatFolders;
    const deletedFolderCount = chatFolders.find((folder) => folder.id === folderId)?.chat_count || 0;
    setChatFolders((current) => current.filter((folder) => folder.id !== folderId));
    setUnfiledChatCount((current) => current + deletedFolderCount);
    setChats((current) => current.map((chat) => chat.folder_id === folderId ? { ...chat, folder_id: null } : chat));
    setDemoFolderMenuId(null);
    if (demoRenamingFolderId === folderId) setDemoRenamingFolderId(null);
    try {
      await api.deleteChatFolder(folderId);
      await loadChats();
    } catch (error) {
      console.error('Failed to delete chat folder:', error);
      setChatFolders(previousFolders);
      await loadChats();
    }
  };

  const moveDemoChat = async (chatId: number, folderId: number | null) => {
    const previousFolderId = chats.find((chat) => chat.id === chatId)?.folder_id ?? null;
    if (previousFolderId === folderId) {
      setDemoMoveMenuOpen(false);
      setContextMenuChatId(null);
      return;
    }
    const adjustCounts = (from: number | null, to: number | null) => {
      setChatFolders((current) => current.map((folder) => {
        if (folder.id === from) return { ...folder, chat_count: Math.max(0, folder.chat_count - 1) };
        if (folder.id === to) return { ...folder, chat_count: folder.chat_count + 1 };
        return folder;
      }));
      if (from === null) setUnfiledChatCount((current) => Math.max(0, current - 1));
      if (to === null) setUnfiledChatCount((current) => current + 1);
    };
    const previousPaging = sectionPagingRef.current;
    const sourceKey: ChatSectionKey = previousFolderId === null ? 'unfiled' : `folder:${previousFolderId}`;
    const targetKey: ChatSectionKey = folderId === null ? 'unfiled' : `folder:${folderId}`;
    const nextPaging = { ...previousPaging };
    const sourcePaging = nextPaging[sourceKey];
    if (sourcePaging) {
      const total = Math.max(0, sourcePaging.total - 1);
      const offset = Math.max(0, sourcePaging.offset - 1);
      nextPaging[sourceKey] = { ...sourcePaging, total, offset, hasMore: offset < total };
    }
    const targetPaging = nextPaging[targetKey];
    if (targetPaging) {
      const total = targetPaging.total + 1;
      nextPaging[targetKey] = { ...targetPaging, total, hasMore: targetPaging.offset < total };
    }
    updateSectionPaging(nextPaging);
    adjustCounts(previousFolderId, folderId);
    setChats((current) => current.map((chat) => chat.id === chatId ? { ...chat, folder_id: folderId } : chat));
    if (folderId !== null) setDemoExpandedFolders((current) => ({ ...current, [folderId]: true }));
    setDemoMoveMenuOpen(false);
    setContextMenuChatId(null);
    try {
      await api.moveChatToFolder(chatId, folderId);
    } catch (error) {
      console.error('Failed to move chat to folder:', error);
      updateSectionPaging(previousPaging);
      adjustCounts(folderId, previousFolderId);
      setChats((current) => current.map((chat) => chat.id === chatId ? { ...chat, folder_id: previousFolderId } : chat));
    }
  };

  const handleDemoChatDragStart = ({ active }: DragStartEvent) => {
    const chatId = Number(active.data.current?.chatId);
    setDemoDraggingChatId(Number.isSafeInteger(chatId) ? chatId : null);
    const initialRect = active.rect.current.initial;
    setDemoDraggingChatSize(initialRect ? { width: initialRect.width, height: initialRect.height } : null);
  };

  const handleDemoChatDragEnd = ({ active, over }: DragEndEvent) => {
    setDemoDraggingChatId(null);
    setDemoDraggingChatSize(null);
    const chatId = Number(active.data.current?.chatId);
    const rawFolderId = over?.data.current?.folderId;
    if (!Number.isSafeInteger(chatId) || rawFolderId === undefined) return;
    const folderId = rawFolderId === 'unfiled' ? null : Number(rawFolderId);
    if (folderId !== null && !Number.isSafeInteger(folderId)) return;
    void moveDemoChat(chatId, folderId);
  };

  const getRoomAvatarClass = (participantId: number) => {
    const variant = Math.abs(participantId) % 3;
    if (variant === 1) return s.roomAvatarAlice;
    if (variant === 2) return s.roomAvatarDetective;
    return s.roomAvatarVega;
  };

  const getRoomInitial = (name: string) => name.trim().charAt(0).toUpperCase() || 'C';

  const removeRoomCharacter = async (participantId: number) => {
    if (!activeChatId || roomSaving) return;
    const chatId = activeChatId;
    const previousCharacters = roomCharacters;
    const previousNextParticipant = nextRoomParticipant;
    const nextCharacters = previousCharacters.filter((participant) => participant.id !== participantId);
    setRoomCharacters(nextCharacters);
    setNextRoomParticipant((selected) => selected === participantId ? (nextCharacters[0]?.id ?? null) : selected);
    setRoomParticipantMenuId(null);
    setRoomSaving(true);
    try {
      const { room } = await api.removeChatAgent(chatId, participantId);
      if (activeChatIdRef.current === chatId) applyRoom(room);
    } catch (error) {
      console.error('Failed to remove chat agent:', error);
      if (activeChatIdRef.current === chatId) {
        setRoomCharacters(previousCharacters);
        setNextRoomParticipant(previousNextParticipant);
        toast.error(t('auth.error.generic'));
      }
    } finally {
      if (activeChatIdRef.current === chatId) setRoomSaving(false);
    }
  };

  const addRoomCharacter = async (promptId: number) => {
    if (!activeChatId || roomSaving) return;
    const chatId = activeChatId;
    setAddParticipantKind(null);
    setRoomSaving(true);
    try {
      const { room } = await api.addChatAgent(chatId, promptId);
      if (activeChatIdRef.current === chatId) applyRoom(room);
    } catch (error) {
      console.error('Failed to add chat agent:', error);
      if (activeChatIdRef.current === chatId) toast.error(t('auth.error.generic'));
    } finally {
      if (activeChatIdRef.current === chatId) setRoomSaving(false);
    }
  };

  const startRoomCharacterRename = (participant: api.ChatAgent) => {
    setRoomParticipantMenuId(null);
    setRenamingRoomParticipantId(participant.id);
    setRenamingRoomParticipantName(participant.name);
  };

  const finishRoomCharacterRename = async () => {
    if (!activeChatId || !renamingRoomParticipantId || roomSaving) return;
    const chatId = activeChatId;
    const participantId = renamingRoomParticipantId;
    const nextName = renamingRoomParticipantName.trim();
    setRenamingRoomParticipantId(null);
    setRenamingRoomParticipantName('');
    if (!nextName) return;
    setRoomSaving(true);
    try {
      const { room } = await api.updateChatAgent(chatId, participantId, { name: nextName });
      if (activeChatIdRef.current === chatId) applyRoom(room);
    } catch (error) {
      console.error('Failed to rename chat agent:', error);
      if (activeChatIdRef.current === chatId) toast.error(t('auth.error.generic'));
    } finally {
      if (activeChatIdRef.current === chatId) setRoomSaving(false);
    }
  };

  const startRoomCharacterPromptChange = (participantId: number) => {
    setRoomParticipantMenuId(null);
    setAddParticipantKind(null);
    setChangingRoomParticipantPromptId(participantId);
  };

  const changeRoomCharacterPrompt = async (promptId: number) => {
    if (!activeChatId || changingRoomParticipantPromptId === null || roomSaving) return;
    const chatId = activeChatId;
    const participantId = changingRoomParticipantPromptId;
    setChangingRoomParticipantPromptId(null);
    setRoomSaving(true);
    try {
      const { room } = await api.updateChatAgent(chatId, participantId, { prompt_id: promptId });
      if (activeChatIdRef.current === chatId) applyRoom(room);
    } catch (error) {
      console.error('Failed to change chat agent prompt:', error);
      if (activeChatIdRef.current === chatId) toast.error(t('auth.error.generic'));
    } finally {
      if (activeChatIdRef.current === chatId) setRoomSaving(false);
    }
  };

  const handleRoomParticipantDragEnd = ({ active, over }: DragEndEvent) => {
    setDraggingRoomParticipantId(null);
    setDraggingRoomParticipantSize(null);
    const activeId = Number(active.data.current?.participantId);
    const overId = Number(over?.data.current?.participantId);
    if (!Number.isSafeInteger(activeId) || !Number.isSafeInteger(overId) || activeId === overId || !activeChatId) return;
    const chatId = activeChatId;
    const previousCharacters = roomCharacters;
    const fromIndex = previousCharacters.findIndex((participant) => participant.id === activeId);
    const toIndex = previousCharacters.findIndex((participant) => participant.id === overId);
    if (fromIndex < 0 || toIndex < 0) return;
    const next = [...previousCharacters];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    setRoomCharacters(next);
    void api.reorderChatAgents(chatId, next.map((participant) => participant.id))
      .then(({ room }) => {
        if (activeChatIdRef.current === chatId) applyRoom(room);
      })
      .catch((error) => {
        console.error('Failed to reorder chat agents:', error);
        if (activeChatIdRef.current === chatId) {
          setRoomCharacters(previousCharacters);
          toast.error(t('auth.error.generic'));
        }
      });
  };

  const createRoom = async () => {
    if (!activeChatId || roomSaving) return;
    const chatId = activeChatId;
    setRoomSaving(true);
    try {
      const { room } = await api.createChatRoom(chatId);
      if (activeChatIdRef.current === chatId) applyRoom(room);
    } catch (error) {
      console.error('Failed to create chat room:', error);
      if (activeChatIdRef.current === chatId) toast.error(t('auth.error.generic'));
    } finally {
      if (activeChatIdRef.current === chatId) setRoomSaving(false);
    }
  };

  const deleteRoom = async () => {
    if (!activeChatId || roomSaving) return;
    if (roomCharacters.length > 0) {
      toast.info(t('chat.room.removeAgentsBeforeDelete'));
      return;
    }
    const chatId = activeChatId;
    setRoomSaving(true);
    try {
      const { room } = await api.deleteChatRoom(chatId);
      if (activeChatIdRef.current === chatId) {
        applyRoom(room);
        setRoomOpen(false);
      }
    } catch (error) {
      console.error('Failed to delete chat room:', error);
      if (activeChatIdRef.current === chatId) toast.error(t('auth.error.generic'));
    } finally {
      if (activeChatIdRef.current === chatId) setRoomSaving(false);
    }
  };

  const updateRoomSettings = async (
    patch: { response_mode?: 'manual' | 'round'; auto_respond?: boolean; next_agent_id?: number | null },
  ) => {
    if (!activeChatId || roomSaving) return;
    const chatId = activeChatId;
    const previous = {
      response_mode: roomMode,
      auto_respond: roomAutoRespond,
      next_agent_id: nextRoomParticipant,
    };
    if (patch.response_mode !== undefined) setRoomMode(patch.response_mode);
    if (patch.auto_respond !== undefined) setRoomAutoRespond(patch.auto_respond);
    if (patch.next_agent_id !== undefined) setNextRoomParticipant(patch.next_agent_id);
    setRoomSaving(true);
    try {
      const { room } = await api.updateChatRoomSettings(chatId, patch);
      if (activeChatIdRef.current === chatId) applyRoom(room);
    } catch (error) {
      console.error('Failed to update chat room settings:', error);
      if (activeChatIdRef.current === chatId) {
        setRoomMode(previous.response_mode);
        setRoomAutoRespond(previous.auto_respond);
        setNextRoomParticipant(previous.next_agent_id);
        toast.error(t('auth.error.generic'));
      }
    } finally {
      if (activeChatIdRef.current === chatId) setRoomSaving(false);
    }
  };

  const createInviteLink = async () => {
    if (!activeChatId || roomSaving) return;
    setRoomSaving(true);
    try {
      const { invite } = await api.createRoomInvite(activeChatId);
      setInviteCopied(false);
      setInviteLink(api.buildRoomInviteLink(invite));
    } catch (error) {
      console.error('Failed to create room invite:', error);
      toast.error(t('auth.error.generic'));
    } finally {
      setRoomSaving(false);
    }
  };

  const copyInviteLink = async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setInviteCopied(true);
      setTimeout(() => setInviteCopied(false), 2000);
    } catch {
      toast.error(t('auth.error.generic'));
    }
  };

  const joinRoom = async () => {
    if (joinRoomBusy) return;
    const token = api.parseRoomInviteToken(joinRoomLink);
    if (!token) {
      toast.error(t('chat.room.invalidInviteLink'));
      return;
    }
    setJoinRoomBusy(true);
    try {
      const { chat_id } = await api.joinRoomByInvite(token);
      setJoinRoomOpen(false);
      setJoinRoomLink('');
      await loadChats();
      await selectChat(chat_id);
      setRoomOpen(true);
      toast.success(t('chat.room.joined'));
    } catch (error) {
      console.error('Failed to join room:', error);
      toast.error(t('chat.room.joinFailed'));
    } finally {
      setJoinRoomBusy(false);
    }
  };

  const otherRoomHumans = roomMembers.filter((member) => member.user_id !== user?.id);

  return (
    <div className={s.layout}>
      {/* SIDEBAR */}
      <motion.aside
        className={`${s.sidebar} ${sidebarCollapsed ? s.sidebarCollapsed : ''}`}
        animate={{ width: sidebarCollapsed ? 65 : 260 }}
        transition={{ duration: 0.2, ease: 'easeInOut' }}
      >
        <div className={s.sidebarHeader}>
          <button className={s.burgerBtn} onClick={() => setSidebarCollapsed(!sidebarCollapsed)} title={sidebarCollapsed ? t('chat.sidebar.expand') : t('chat.sidebar.collapse')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <motion.div
            className={s.sidebarTitleGroup}
            animate={{ opacity: sidebarCollapsed ? 0 : 1 }}
            transition={{ duration: 0.15 }}
            style={{ pointerEvents: sidebarCollapsed ? 'none' : 'auto' }}
          >
            <span className={s.sidebarTitle}>{t('chat.sidebar.chats')}</span>
            <button
              className={`${s.sidebarActionBtn} ${demoFiltersOpen ? s.sidebarActionBtnActive : ''}`}
              onClick={() => {
                setDemoFiltersOpen((value) => !value);
                setDemoFolderCreatorOpen(false);
              }}
              title={t('chat.sidebar.filters.title')}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 5h16l-6.2 7.1v5.1l-3.6 1.8v-6.9L4 5z" />
              </svg>
            </button>
          </motion.div>
          <motion.div
            className={s.sidebarHeaderActions}
            animate={{ opacity: sidebarCollapsed ? 0 : 1 }}
            transition={{ duration: 0.15 }}
            style={{ pointerEvents: sidebarCollapsed ? 'none' : 'auto' }}
          >
            <button
              className={`${s.newChatBtn} ${demoFolderCreatorOpen ? s.newChatBtnActive : ''}`}
              onClick={() => {
                setDemoFolderCreatorOpen((value) => {
                  const next = !value;
                  if (next) setDemoFolderName(t('chat.sidebar.folders.new'));
                  return next;
                });
                setDemoFiltersOpen(false);
              }}
              title={t('chat.sidebar.folders.new')}
            >
              <FolderAddIcon />
            </button>
            <button className={s.newChatBtn} onClick={handleCreateChat} title={t('chat.sidebar.newChat')}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="7" y1="1" x2="7" y2="13" />
                <line x1="1" y1="7" x2="13" y2="7" />
              </svg>
            </button>
          </motion.div>
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
            placeholder={t('chat.sidebar.searchPlaceholder')}
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

        <AnimatePresence initial={false}>
          {demoFiltersOpen && !sidebarCollapsed && (
            <motion.div
              className={s.demoFilterPanel}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.16 }}
            >
              <div className={s.demoFilterGrid}>
                <label className={s.demoFilterField}>
                  <span>{t('chat.sidebar.filters.prompt')}</span>
                  <Select
                    value={demoPromptFilter}
                    onChange={setDemoPromptFilter}
                    options={[
                      { value: 'all', label: t('chat.sidebar.filters.all') },
                      ...chatFilterOptions.prompts.map((prompt) => ({
                        value: `${prompt.id}`,
                        label: chatFilterOptions.prompts.some((other) => other.id !== prompt.id && other.name === prompt.name)
                          ? `${prompt.name} · #${prompt.id}`
                          : prompt.name,
                      })),
                    ]}
                  />
                </label>
                <label className={s.demoFilterField}>
                  <span>{t('chat.sidebar.filters.model')}</span>
                  <Select
                    value={demoModelFilter}
                    onChange={setDemoModelFilter}
                    options={[
                      { value: 'all', label: t('chat.sidebar.filters.all') },
                      ...chatFilterOptions.models.map((model) => ({ value: model, label: model })),
                    ]}
                  />
                </label>
              </div>
              <div className={s.demoFilterChips}>
                <button
                  className={demoFilesFilter ? s.demoFilterChipActive : ''}
                  onClick={() => setDemoFilesFilter((value) => !value)}
                >
                  {t('chat.sidebar.filters.withFiles')}
                </button>
                <button
                  className={demoImagesFilter ? s.demoFilterChipActive : ''}
                  onClick={() => setDemoImagesFilter((value) => !value)}
                >
                  {t('chat.sidebar.filters.withImages')}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {demoFolderCreatorOpen && !sidebarCollapsed && (
            <motion.div
              className={s.demoFolderCreator}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.16 }}
            >
              <FolderIcon />
              <input value={demoFolderName} onChange={(event) => setDemoFolderName(event.target.value)} autoFocus />
              <button
                title={t('chat.sidebar.folders.create')}
                onClick={async () => {
                  const value = demoFolderName.trim();
                  if (!value) return;
                  try {
                    const { folder } = await api.createChatFolder(value);
                    setChatFolders((current) => [...current, folder]);
                    updateSectionPaging({
                      ...sectionPagingRef.current,
                      [`folder:${folder.id}`]: { offset: 0, total: 0, hasMore: false, loading: false },
                    });
                    setDemoExpandedFolders((current) => ({ ...current, [folder.id]: true }));
                    setDemoFolderName(t('chat.sidebar.folders.new'));
                    setDemoFolderCreatorOpen(false);
                  } catch (error) {
                    console.error('Failed to create chat folder:', error);
                  }
                }}
              >
                ✓
              </button>
              <button title={t('chat.sidebar.folders.cancel')} onClick={() => setDemoFolderCreatorOpen(false)}>×</button>
            </motion.div>
          )}
        </AnimatePresence>

        <motion.div
          className={s.sidebarContentBody}
          animate={{ opacity: sidebarCollapsed ? 0 : 1 }}
          transition={{ duration: 0.15 }}
          style={{ pointerEvents: sidebarCollapsed ? 'none' : 'auto' }}
        >
          {searchQuery.trim().length >= 3 ? (
            <div className={s.chatList}>
              {searchLoading && (
                <div className={s.emptyChats}>{t('chat.sidebar.searching')}</div>
              )}
              {!searchLoading && searchResults.length === 0 && (
                <div className={s.emptyChats}>{t('chat.sidebar.nothingFound')}</div>
              )}
              {!searchLoading && searchResults.map((result) => (
                <div
                  key={result.chat_id}
                  className={`${s.chatItem} ${result.chat_id === activeChatId ? s.chatItemActive : ''}`}
                  onClick={() => {
                    setChats(prev => prev.some(chat => chat.id === result.chat_id)
                      ? prev
                      : [{ id: result.chat_id, title: result.chat_title, created_at: result.created_at, folder_id: result.folder_id ?? null }, ...prev]);
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
          <DndContext
            collisionDetection={chatFolderCollisionDetection}
            onDragStart={handleDemoChatDragStart}
            onDragCancel={() => {
              setDemoDraggingChatId(null);
              setDemoDraggingChatSize(null);
            }}
            onDragEnd={handleDemoChatDragEnd}
          >
          <div className={s.chatList}>
            {demoFolders.map((folder) => {
              const expanded = demoExpandedFolders[folder.id] !== false;
              return (
                <DemoDroppableFolder folderId={folder.id} key={folder.id}>
                <div className={s.demoFolder}>
                  <div className={s.demoFolderHeader} onClick={() => toggleDemoFolder(folder.id)}>
                    <svg className={`${s.demoFolderChevron} ${expanded ? s.demoFolderChevronExpanded : ''}`} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                    <FolderIcon />
                    {demoRenamingFolderId === folder.id ? (
                      <input
                        className={s.demoFolderRenameInput}
                        value={demoRenamingFolderName}
                        onChange={(event) => setDemoRenamingFolderName(event.target.value)}
                        onClick={(event) => event.stopPropagation()}
                        onBlur={finishDemoFolderRename}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') finishDemoFolderRename();
                          if (event.key === 'Escape') {
                            setDemoRenamingFolderId(null);
                            setDemoRenamingFolderName('');
                          }
                        }}
                        autoFocus
                      />
                    ) : <span className={s.demoFolderName}>{folder.name}</span>}
                    <span className={s.demoFolderCount}>{folder.chat_count}</span>
                    <div className={s.demoFolderActions}>
                      <button
                        className={s.kebabBtn}
                        onClick={(event) => toggleDemoFolderMenu(event, folder.id)}
                        title={t('chat.sidebar.folders.actions')}
                      >
                        <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
                          <circle cx="8" cy="3" r="1.5" />
                          <circle cx="8" cy="8" r="1.5" />
                          <circle cx="8" cy="13" r="1.5" />
                        </svg>
                      </button>
                      {demoFolderMenuId === folder.id && (
                        <div
                          className={s.contextMenu}
                          style={{ top: demoFolderMenuPos.y, left: demoFolderMenuPos.x }}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <button className={s.contextMenuItem} onClick={() => startDemoFolderRename(folder.id, folder.name)}>{t('chat.sidebar.folders.rename')}</button>
                          <button className={`${s.contextMenuItem} ${s.contextMenuItemDanger}`} onClick={() => deleteDemoFolder(folder.id)}>{t('chat.sidebar.folders.delete')}</button>
                        </div>
                      )}
                    </div>
                  </div>
                  <AnimatePresence initial={false}>
                    {expanded && (
                      <motion.div
                        className={s.demoFolderChats}
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.15 }}
                      >
                        {folder.chats.map((chat) => renderSidebarChat(chat, true))}
                        {folder.chats.length === 0 && folder.chat_count === 0 && <div className={s.demoEmptyFolder}>{t('chat.sidebar.folders.dropChat')}</div>}
                        {sectionPaging[`folder:${folder.id}`]?.loading && <div className={s.emptyChats}>{t('common.loading')}</div>}
                        <ChatSectionSentinel
                          disabled={!sectionPaging[`folder:${folder.id}`]?.hasMore || Boolean(sectionPaging[`folder:${folder.id}`]?.loading)}
                          onVisible={() => void loadChatSection(folder.id)}
                        />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                </DemoDroppableFolder>
              );
            })}
            <DemoDroppableFolder folderId="unfiled">
              <div className={s.demoUnfiledDropZone}>
              <div className={s.demoUnfiledHeader}>
                <span>{t('chat.sidebar.folders.unfiled')}</span>
                <span>{unfiledChatCount}</span>
              </div>
              {demoUnfiledChats.map((chat) => renderSidebarChat(chat))}
              {demoUnfiledChats.length === 0 && unfiledChatCount === 0 && <div className={s.demoEmptyUnfiled}>{t('chat.sidebar.folders.dropChat')}</div>}
              {sectionPaging.unfiled?.loading && <div className={s.emptyChats}>{t('common.loading')}</div>}
              <ChatSectionSentinel
                disabled={!sectionPaging.unfiled?.hasMore || Boolean(sectionPaging.unfiled?.loading)}
                onVisible={() => void loadChatSection(null)}
              />
              </div>
            </DemoDroppableFolder>
            {loadingChats && chats.length === 0 && (
              <div className={s.emptyChats}>{t('common.loading')}</div>
            )}
            {!loadingChats && chatFolders.reduce((total, folder) => total + folder.chat_count, unfiledChatCount) === 0 && (
              <div className={s.emptyChats}>{loadingChats ? t('common.loading') : t('chat.sidebar.noChats')}</div>
            )}
          </div>
          <DragOverlay zIndex={10001} dropAnimation={{ duration: 150, easing: 'ease-out' }}>
            {demoDraggingChat && (
              <div
                className={`${s.chatItem} ${demoDraggingChat.folder_id !== null ? s.chatItemNested : ''} ${demoDraggingChat.id === activeChatId ? s.chatItemActive : ''} ${s.demoChatDragOverlay}`}
                style={demoDraggingChatSize || undefined}
              >
                <div className={s.chatItemRow}>
                  <div className={s.chatItemTitle}>
                    {demoDraggingChat.title || t('chat.sidebar.newChat')}
                  </div>
                  {getUnread(demoDraggingChat.id) > 0 && (
                    <span className={s.unreadBadge}>{getUnread(demoDraggingChat.id)}</span>
                  )}
                  <div className={s.chatItemControls} aria-hidden="true">
                    <div className={s.kebabBtn}>
                      <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
                        <circle cx="8" cy="3" r="1.5" />
                        <circle cx="8" cy="8" r="1.5" />
                        <circle cx="8" cy="13" r="1.5" />
                      </svg>
                    </div>
                    <div className={s.chatDragHandle}>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M8 1.5v13M1.5 8h13" />
                        <polyline points="5.7 3.8 8 1.5 10.3 3.8" />
                        <polyline points="5.7 12.2 8 14.5 10.3 12.2" />
                        <polyline points="3.8 5.7 1.5 8 3.8 10.3" />
                        <polyline points="12.2 5.7 14.5 8 12.2 10.3" />
                      </svg>
                    </div>
                  </div>
                </div>
                <div className={s.chatItemTime}>{formatTime(demoDraggingChat.created_at)}</div>
              </div>
            )}
          </DragOverlay>
          </DndContext>
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
              {t('chat.sidebar.rename')}
            </button>
            <button className={s.contextMenuItem} onClick={() => handleExportChat(contextMenuChatId)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              {t('chat.sidebar.downloadDocx')}
            </button>
            <div className={s.demoMoveMenuGroup}>
              <button className={s.contextMenuItem} onClick={() => setDemoMoveMenuOpen((value) => !value)}>
                <FolderIcon size={14} />
                <span>{t('chat.sidebar.folders.moveTo')}</span>
                <svg className={`${s.demoMoveMenuChevron} ${demoMoveMenuOpen ? s.demoMoveMenuChevronOpen : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
              {demoMoveMenuOpen && (
                <div className={s.demoMoveMenuOptions}>
                  {demoFolders.map((folder) => (
                    <button
                      key={folder.id}
                      className={chats.find((chat) => chat.id === contextMenuChatId)?.folder_id === folder.id ? s.demoMoveMenuOptionActive : ''}
                      onClick={() => void moveDemoChat(contextMenuChatId, folder.id)}
                    >
                      <span>{folder.name}</span>
                      {chats.find((chat) => chat.id === contextMenuChatId)?.folder_id === folder.id && <span>✓</span>}
                    </button>
                  ))}
                  <button
                    className={(chats.find((chat) => chat.id === contextMenuChatId)?.folder_id ?? null) === null ? s.demoMoveMenuOptionActive : ''}
                    onClick={() => void moveDemoChat(contextMenuChatId, null)}
                  >
                    <span>{t('chat.sidebar.folders.unfiled')}</span>
                    {(chats.find((chat) => chat.id === contextMenuChatId)?.folder_id ?? null) === null && <span>✓</span>}
                  </button>
                </div>
              )}
            </div>
            <button className={s.contextMenuItem} onClick={() => handleToggleBotHidden(contextMenuChatId)}>
              {chats.find(c => c.id === contextMenuChatId)?.bot_hidden ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                  {t('chat.sidebar.showInBot')}
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                  {t('chat.sidebar.hideFromBot')}
                </>
              )}
            </button>
            <button className={`${s.contextMenuItem} ${s.contextMenuItemDanger}`} onClick={() => handleStartDelete(contextMenuChatId)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              {t('common.delete')}
            </button>
          </div>
        )}

        <div className={s.sidebarFooter}>
          <div className={s.userInfo} style={{ cursor: 'pointer' }} onClick={() => setShowSettings(true)} title={t('settings.title')}>
            <div className={s.avatar}>
              {(user?.name || user?.username || 'U')[0].toUpperCase()}
            </div>
            <motion.span
              className={s.userName}
              animate={{ opacity: sidebarCollapsed ? 0 : 1 }}
              transition={{ duration: 0.15 }}
            >
              {user?.name || user?.username || t('common.user')}
            </motion.span>
            <motion.svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--text-muted)"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              animate={{ opacity: sidebarCollapsed ? 0 : 0.6 }}
              transition={{ duration: 0.15 }}
              className={s.gearIcon}
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </motion.svg>
          </div>
          <motion.div
            className={s.footerBtns}
            animate={{ opacity: sidebarCollapsed ? 0 : 1 }}
            transition={{ duration: 0.15 }}
            style={{ pointerEvents: sidebarCollapsed ? 'none' : 'auto' }}
          >
            <button
              className={s.iconBtn}
              onClick={toggleNotifications}
              title={t(notificationsEnabled ? 'chat.sidebar.notificationsOn' : 'chat.sidebar.notificationsOff')}
              aria-pressed={notificationsEnabled}
            >
              {notificationsEnabled ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                  <path d="M18.63 18H3c0-2 3-2 3-9a6 6 0 0 1 .38-2.1" />
                  <path d="M9.18 3.28A6 6 0 0 1 18 8c0 2.43.36 4.02.86 5.1" />
                  <path d="m2 2 20 20" />
                </svg>
              )}
            </button>
            <button className={s.iconBtn} onClick={handleLogout} title={t('chat.sidebar.logout')}>
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
            <p className={s.emptyStateText}>{t('chat.empty.selectOrCreate')}</p>
          </div>
        ) : (
          <>
            <div className={s.chatTopBar}>
              <div className={s.modelSelector}>
                {modelsCatalog.length > 0 && (
                  <>
                    <label className={s.modelLabel}>{t('chat.model.label')}</label>
                    <div className={s.modelSelectWrap}>
                      <Select
                        options={[
                          { value: '', label: t('chat.reasoning.auto'), hint: t('chat.model.automatic'), badge: (user?.plan === 'pro' ? autoSupportsVision.pro : autoSupportsVision.lite) ? { text: 'Vision', color: 'success' as const } : undefined },
                          ...modelsCatalog.map(m => ({
                            value: m.id,
                            label: m.name,
                            hint: m.description || undefined,
                            badge: m.is_free
                              ? { text: t('chat.model.freeBadge'), color: 'info' as const }
                              : m.supports_vision
                                ? { text: 'Vision', color: 'success' as const }
                                : undefined,
                          })),
                        ]}
                        value={preferredModel || ''}
                        onChange={async (val) => {
                          const modelId = val || null;
                          try {
                            await api.setPreferredModel(modelId);
                            setPreferredModel(modelId);
                          } catch {
                            toast.error(t('chat.toasts.modelChangeFailed'));
                          }
                        }}
                        placeholder={t('chat.reasoning.auto')}
                      />
                    </div>
                  </>
                )}
                {availableLevels.length > 1 && (
                <div className={s.reasoningControl}>
                  <Slider
                    mode="discrete"
                    label={t('chat.reasoning.label')}
                    values={availableLevels}
                    labels={LEVEL_LABELS}
                    value={reasoningLevel}
                    onChange={(v) => setReasoningLevel(v as api.ReasoningLevel | null)}
                    onCommit={async () => {
                      try {
                        await api.setReasoningLevel(reasoningLevel);
                      } catch {
                        toast.error(t('chat.toasts.reasoningChangeFailed'));
                      }
                    }}
                  />
                </div>
                )}
              </div>
              <button
                type="button"
                className={`${s.roomTrigger} ${roomOpen ? s.roomTriggerActive : ''} ${!roomCreated ? s.roomTriggerEmpty : ''}`}
                onClick={() => {
                  setRoomOpen((open) => {
                    if (!open) setToolsPanelState({ isOpen: false });
                    return !open;
                  });
                }}
                title={t(!roomCreated ? 'chat.room.createRoom' : 'chat.room.open')}
              >
                {!roomCreated ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                ) : (
                  <>
                    <span className={s.roomAvatarStack} aria-hidden="true">
                      <span className={`${s.roomAvatar} ${s.roomAvatarHuman}`}>{(user?.name || user?.username || 'Y').trim().charAt(0).toUpperCase()}</span>
                      {roomCharacters.slice(0, 3).map((participant) => (
                        <span key={participant.id} className={`${s.roomAvatar} ${getRoomAvatarClass(participant.id)}`}>{getRoomInitial(participant.name)}</span>
                      ))}
                    </span>
                    <span className={s.roomTriggerText}>{t('chat.room.participantCount', { count: roomCharacters.length + 1 })}</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points={roomOpen ? '18 15 12 9 6 15' : '9 18 15 12 9 6'} />
                    </svg>
                  </>
                )}
              </button>
              {showTokens && contextTokens && (
                <div
                  className={s.contextTokensCompact}
                  title={contextTokens.latest_total_tokens > 0
                    ? t('chat.context.providerTooltip', {
                        input: contextTokens.latest_prompt_tokens.toLocaleString(locale),
                        cacheHit: contextTokens.latest_cache_hit_tokens.toLocaleString(locale),
                        cacheMiss: contextTokens.latest_cache_miss_tokens.toLocaleString(locale),
                        output: contextTokens.latest_completion_tokens.toLocaleString(locale),
                        reasoning: contextTokens.latest_reasoning_tokens.toLocaleString(locale),
                        model: contextTokens.latest_model_name || t('chat.model.automatic'),
                      })
                    : t('chat.context.tooltip', {
                        active: contextTokens.active_messages,
                        archived: contextTokens.archived_messages,
                        promptTokens: contextTokens.system_prompt_tokens.toLocaleString(locale),
                        reasoning: contextTokens.reasoning_tokens > 0 ? `\n${t('chat.context.reasoning')}: ${contextTokens.reasoning_tokens.toLocaleString(locale)} tk` : '',
                      })}
                >
                  <span className={s.contextTokensValue}>
                    {contextTokens.current_context_tokens.toLocaleString(locale)}
                  </span>
                  <span className={s.contextTokensLabel}> tk</span>
                  {contextTokens.latest_total_tokens > 0 && (
                    <>
                      <span className={s.contextTokensSep}>&bull;</span>
                      <span className={s.contextTokensPromptValue}>{contextTokens.latest_cache_hit_tokens.toLocaleString(locale)}</span>
                      <span className={s.contextTokensLabel}> {t('chat.context.cached')}</span>
                    </>
                  )}
                </div>
              )}
            </div>
            <div className={s.messages} ref={messagesScrollRef}>
              {loadingMessages && (
                <div className={s.loadingRow}>{t('chat.messages.loading')}</div>
              )}
              {!loadingMessages && (hiddenMessagesCount > 0 || hasMoreMessages) && (
                <button className={s.loadOlderBtn} onClick={showMoreHidden} disabled={loadingOlderMessages}>
                  {loadingOlderMessages
                    ? t('common.loading')
                    : hiddenMessagesCount > 0
                      ? t('chat.messages.loadMoreHint', { reveal: willRevealCount, count: hiddenMessagesCount })
                      : t('chat.messages.loadOlderFromServer', { count: MESSAGE_PAGE_SIZE })}
                </button>
              )}
              {visibleMessages.map((msg) => (
                <MessageItem
                  key={msg.id}
                  msg={msg}
                  isLastAssistant={msg.id === lastAssistantId}
                  isTtsPlaying={ttsPlayingId === msg.id}
                  isReasoningOpen={openReasoningId === msg.id}
                  isToolCallsOpen={openToolCallsId === msg.id}
                  isSubagentsOpen={openSubagentsId === msg.id}
                  isRegenHintOpen={regenHintMsgId === msg.id}
                  isEditing={editingMsgId === msg.id}
                  streamingState={msg.id === streamingMsgId ? streamingState : 'idle'}
                  editingText={editingText}
                  sending={sending}
                  regenHintText={regenHintText}
                  showTokens={showTokens}
                  resolveImageUrl={resolveImageUrl}
                  onSetMessages={setMessages}
                  onSetViewerImageSrc={(src, msgId, url) => {
                    setViewerImageSrc(src);
                    setViewerImageMsgId(msgId ?? null);
                    setViewerImageUrl(url ?? null);
                  }}
                  onDownloadImage={handleDownloadImage}
                  onToggleReasoning={handleToggleReasoning}
                  onToggleToolCalls={handleToggleToolCalls}
                  onToggleSubagents={handleToggleSubagents}
                  onRegenerate={handleRegenerate}
                  onOpenRegenHint={handleOpenRegenHint}
                  onCloseRegenHint={handleCloseRegenHint}
                  onSetRegenHintText={setRegenHintText}
                  onRegenerateWithHint={handleRegenerateWithHint}
                  onMsgKebabClick={handleMsgKebabClick}
                  onSetEditingText={setEditingText}
                  onSaveEdit={handleSaveEdit}
                  onCancelEdit={handleCancelEdit}
                  onDeleteAttachment={handleDeleteAttachment}
                  onDeleteImage={(messageId, url) => setImageDeleteTarget({ messageId, url })}
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
                      title={ttsPlayingId === msg.id ? t('chat.message.stopSpeaking') : t('chat.message.speak')}
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
                      msg.id === streamingMsgId && streamingState === 'reasoning' ? (
                        // Стрим reasoning — показываем текстовый индикатор.
                        <button
                          className={`${s.reasoningToggle} ${s.reasoningToggleStreaming} ${openReasoningId === msg.id ? s.reasoningToggleOpen : ''}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenReasoningId((current) => current === msg.id ? null : msg.id);
                          }}
                          title={openReasoningId === msg.id ? t('chat.message.hideReasoning') : t('chat.message.showReasoning')}
                        >
                          <span className={s.streamingLabel}>{t('chat.message.reasoning')}</span>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>
                      ) : (
                        <button
                          className={`${s.reasoningToggle} ${openReasoningId === msg.id ? s.reasoningToggleOpen : ''}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenReasoningId((current) => current === msg.id ? null : msg.id);
                          }}
                          title={openReasoningId === msg.id ? t('chat.message.hideReasoning') : t('chat.message.showReasoning')}
                        >
                          <span>{t('chat.message.reasoningLabel')}{showTokens && typeof msg.reasoning_tokens === 'number' && msg.reasoning_tokens > 0 ? ` · ${msg.reasoning_tokens} tk` : ''}</span>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>
                      )
                    )}
                    {msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0 && (
                      <button
                        className={`${s.reasoningToggle} ${openToolCallsId === msg.id ? s.reasoningToggleOpen : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenToolCallsId((current) => current === msg.id ? null : msg.id);
                        }}
                        title={openToolCallsId === msg.id ? t('chat.message.hideTools') : t('chat.message.showTools')}
                      >
                        <span>{msg.tool_calls.length} {msg.tool_calls.length === 1 ? t('chat.message.tool_one') : msg.tool_calls.length < 5 ? t('chat.message.tool_few') : t('chat.message.tool_many')}</span>
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
                          title={t('chat.message.regenerate')}
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
                                placeholder={t('chat.message.regenerateHintPlaceholder')}
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
                                title={t('common.send')}
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
                            title={t('chat.message.regenerateWithHint')}
                            disabled={sending}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                            </svg>
                          </button>
                        )}
                      </>
                    )}
                    {typeof msg.token_count === 'number' && msg.token_count > 0 && (
                      <span className={s.tokenBadge} title={t('chat.message.localTokenEstimate')}>
                        {msg.token_count} tk
                      </span>
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
                                  alt={img.type === 'generated' ? t('chat.image.generatedAlt') : t('chat.image.photoAlt')}
                                  loading="lazy"
                                  onClick={() => {
                                    setViewerImageSrc(src);
                                    setViewerImageMsgId(msg.id);
                                    setViewerImageUrl(img.url);
                                  }}
                                />
                                <button
                                  className={s.messageImageDownload}
                                  onClick={(e) => { e.stopPropagation(); handleDownloadImage(src); }}
                                  title={t('common.download')}
                                >
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                    <polyline points="7 10 12 15 17 10" />
                                    <line x1="12" y1="15" x2="12" y2="3" />
                                  </svg>
                                </button>
                                {msg.id > 0 && <button
                                  className={s.messageImageDelete}
                                  onClick={(e) => { e.stopPropagation(); setImageDeleteTarget({ messageId: msg.id, url: img.url }); }}
                                  title={t('common.delete')}
                                >
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="3 6 5 6 21 6" />
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                  </svg>
                                </button>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {msg.attachments && msg.attachments.length > 0 && (
                        <div className={s.messageImages}>
                          {msg.attachments.map((att, i) => {
                            const downloadUrl = att.url ? resolveImageUrl(att.url) : null;
                            return (
                              <div key={i} className={s.attachmentCard}>
                                <div className={s.attachmentIcon}>
                                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                    <polyline points="14 2 14 8 20 8" />
                                  </svg>
                                </div>
                                <div className={s.attachmentInfo}>
                                  <span className={s.attachmentName}>{att.name}</span>
                                  <span className={s.attachmentSize}>{att.size_bytes < 1024 * 1024 ? `${(att.size_bytes / 1024).toFixed(1)} KB` : `${(att.size_bytes / (1024 * 1024)).toFixed(1)} MB`}</span>
                                </div>
                                {downloadUrl && (
                                  <button className={s.attachmentDownload} onClick={(e) => { e.stopPropagation(); handleDownloadImage(downloadUrl); }} title={t('common.download')}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                      <polyline points="7 10 12 15 17 10" />
                                      <line x1="12" y1="15" x2="12" y2="3" />
                                    </svg>
                                  </button>
                                )}
                                {msg.id > 0 && att.filename && (
                                  <button className={s.attachmentDelete} onClick={(e) => { e.stopPropagation(); handleDeleteAttachment(msg.id, att.filename); }} title={t('common.delete')}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <polyline points="3 6 5 6 21 6" />
                                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                    </svg>
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {msg.role === 'assistant'
                        ? <div className={`${s.bubbleText} ${msg.id === streamingMsgId && streamingState === 'content' ? s.bubbleTextStreaming : ''}`}><MarkdownRenderer content={msg.content} /></div>
                        : <div className={s.bubbleTextPlain}>{msg.content}</div>
                      }
                    </div>
                    <AnimatePresence>
                      {msg.role === 'assistant' && msg.reasoning_content?.trim() && openReasoningId === msg.id && (
                        <motion.div
                          className={`${s.reasoningPanel} ${msg.id === streamingMsgId && (streamingState === 'reasoning' || streamingState === 'content') ? s.bubbleTextStreaming : ''}`}
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
                          {msg.tool_calls.map((tc, i) => {
                            const args = formatToolValue(tc.arguments);
                            const result = formatToolValue(tc.result_preview);
                            return (
                              <div key={tc.id || i} style={{ marginBottom: i < msg.tool_calls!.length - 1 ? '8px' : 0 }}>
                                <div style={{ fontWeight: 600, marginBottom: 2 }}>{tc.name}</div>
                                <div className={s.toolCallLabel}>{t('chat.message.arguments')}</div>
                                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.8 }}>
                                  {args || '{}'}
                                </pre>
                                {result && (
                                  <>
                                    <div className={s.toolCallLabel}>{t('chat.message.result')}</div>
                                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.8 }}>
                                      {result}
                                    </pre>
                                  </>
                                )}
                              </div>
                            );
                          })}
                        </motion.div>
                      )}
                    </AnimatePresence>
                    <button
                      className={s.msgKebabBtn}
                      onClick={(e) => handleMsgKebabClick(e, msg.id)}
                      title={t('common.actions')}
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
                  <div className={s.metaRow}>Chatter &bull; {streamingState === 'reasoning' ? t('chat.message.reasoning') : t('chat.message.typing')}</div>
                  <div className={s.bubble}>
                    <div className={`${s.typingDots} ${streamingState === 'reasoning' ? s.typingDotsStreaming : ''}`}>
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
                    <span className={s.suggestMacroTitle}>{t('chat.macro.title')}</span>
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
                          toast.success(t('chat.toasts.macroSaved'));
                          setPendingMacros(prev => prev.filter((_, i) => i !== macroIdx));
                        } catch {
                          toast.error(t('chat.toasts.macroSaveFailed'));
                        }
                      }}
                    >
                      {t('chat.macro.save')}
                    </button>
                    <button
                      className={s.suggestMacroDismissBtn}
                      onClick={() => setPendingMacros(prev => prev.filter((_, i) => i !== macroIdx))}
                    >
                      {t('common.reject')}
                    </button>
                  </div>
                </div>
              ))}

              {/* Suggest Chat Link cards */}
              {pendingChatLinks.map((link, linkIdx) => (
                <div key={`chat-link-${linkIdx}`} className={s.suggestMacroCard}>
                  <div className={s.suggestMacroHeader}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    <span className={s.suggestMacroTitle}>{t('chat.chatLink.title')}</span>
                    <button
                      className={s.suggestMacroClose}
                      onClick={() => setPendingChatLinks(prev => prev.filter((_, i) => i !== linkIdx))}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                  <div className={s.suggestMacroName}>{link.title}</div>
                  <div className={s.suggestMacroActions}>
                    <button
                      className={s.suggestMacroSaveBtn}
                      onClick={() => {
                        setActiveChatId(link.chat_id);
                        api.activateChat(link.chat_id).catch(() => {});
                        setPendingChatLinks(prev => prev.filter((_, i) => i !== linkIdx));
                      }}
                    >
                      {t('chat.chatLink.open')}
                    </button>
                    <button
                      className={s.suggestMacroDismissBtn}
                      onClick={() => setPendingChatLinks(prev => prev.filter((_, i) => i !== linkIdx))}
                    >
                      {t('common.reject')}
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
                    <span className={s.suggestMacroTitle}>{t('chat.confirm.commandTitle')}</span>
                    <button
                      className={s.suggestMacroClose}
                      disabled={submittingConfirmationIds.has(conf.confirmation_id)}
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
                        placeholder={t('chat.confirm.newPassword')}
                        disabled={submittingConfirmationIds.has(conf.confirmation_id)}
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
                            placeholder={t('chat.confirm.sudoPassword')}
                            disabled={submittingConfirmationIds.has(conf.confirmation_id)}
                            value={conf.sudo_password || ''}
                            onChange={(e) => setDevopsConfirmations(prev => prev.map((c, i) => i === confIdx ? { ...c, sudo_password: e.target.value } : c))}
                            style={{ fontSize: '12px', padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border-input)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none' }}
                          />
                          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-muted)', cursor: 'pointer', marginBottom: '6px' }}>
                            <input
                              className={s.devopsCheckbox}
                              type="checkbox"
                              disabled={submittingConfirmationIds.has(conf.confirmation_id)}
                              checked={conf.save_sudo_password || false}
                              onChange={(e) => setDevopsConfirmations(prev => prev.map((c, i) => i === confIdx ? { ...c, save_sudo_password: e.target.checked } : c))}
                            />
                            {t('chat.confirm.saveSudoPassword')}
                          </label>
                      </>
                    </div>
                  )}
                  {conf._verdict && (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px', background: 'var(--bg-modal-hover)', borderRadius: '6px', marginTop: '6px' }}><MarkdownRenderer content={conf._verdict} /></div>
                  )}
                  {submittingConfirmationIds.has(conf.confirmation_id) && (
                    <div role="status" style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px', background: 'var(--bg-modal-hover)', borderRadius: '6px', marginTop: '6px' }}>
                      {t('chat.confirm.executing')}
                    </div>
                  )}
                  <div className={s.suggestMacroActions}>
                    <button
                      className={s.suggestMacroSaveBtn}
                      disabled={submittingConfirmationIds.has(conf.confirmation_id)}
                      onClick={async () => {
                        const body: Record<string, unknown> = {
                          confirmation_id: conf.confirmation_id,
                          approved: true,
                        };
                        if (conf.needs_sudo_password) {
                          if (!conf.sudo_password?.trim()) {
                            toast.error(t('chat.toasts.enterSudoPassword'));
                            return;
                          }
                          body.sudo_password = conf.sudo_password;
                          body.save_sudo_password = conf.save_sudo_password === true;
                        }
                        if (conf.needs_new_password) {
                          if (!conf.new_password?.trim()) {
                            toast.error(t('chat.toasts.enterNewPassword'));
                            return;
                          }
                          body.new_password = conf.new_password;
                        }
                        if (!beginConfirmationSubmission(conf.confirmation_id)) return;
                        try {
                          await api.apiFetch('/api/v1/devops/approve', {
                            method: 'POST',
                            body: JSON.stringify(body),
                          });
                          toast.success(t('chat.toasts.commandApproved'));
                          setDevopsConfirmations(prev => prev.filter(c => c.confirmation_id !== conf.confirmation_id));
                        } catch {
                          toast.error(t('chat.toasts.commandApprovalFailed'));
                        } finally {
                          finishConfirmationSubmission(conf.confirmation_id);
                        }
                      }}
                    >
                      {t('chat.confirm.allow')}
                    </button>
                    <button
                      className={s.suggestMacroSaveBtn}
                      disabled={submittingConfirmationIds.has(conf.confirmation_id)}
                      style={{ background: 'var(--bg-modal-hover)', color: 'var(--text-primary)', border: '1px solid var(--border-input)' }}
                      onClick={async () => {
                        if (conf.needs_sudo_password && !conf.sudo_password?.trim()) {
                          toast.error(t('chat.toasts.enterSudoPassword'));
                          return;
                        }
                        if (conf.needs_new_password && !conf.new_password?.trim()) {
                          toast.error(t('chat.toasts.enterNewPassword'));
                          return;
                        }
                        if (!beginConfirmationSubmission(conf.confirmation_id)) return;
                        try {
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
                          toast.success(t('chat.toasts.commandAlwaysApproved'));
                          setDevopsConfirmations(prev => prev.filter(c => c.confirmation_id !== conf.confirmation_id));
                        } catch {
                          toast.error(t('chat.toasts.policySaveFailed'));
                        } finally {
                          finishConfirmationSubmission(conf.confirmation_id);
                        }
                      }}
                    >
                      {t('chat.confirm.alwaysAllow')}
                    </button>
                    <button
                      className={s.suggestMacroSaveBtn}
                      disabled={conf._reviewing || submittingConfirmationIds.has(conf.confirmation_id)}
                      style={{ background: 'var(--bg-modal-hover)', color: 'var(--text-primary)', border: '1px solid var(--border-input)', opacity: conf._reviewing || submittingConfirmationIds.has(conf.confirmation_id) ? 0.6 : 1, minWidth: '80px' }}
                      onClick={async () => {
                        setDevopsConfirmations(prev => prev.map((c, i) => i === confIdx ? { ...c, _reviewing: true } : c));
                        try {
                          const res = await api.apiFetch<{ verdict: string }>('/api/v1/devops/runbooks/review-commands', {
                            method: 'POST',
                            body: JSON.stringify({ commands: [conf.command] }),
                          });
                          setDevopsConfirmations(prev => prev.map((c, i) => i === confIdx ? { ...c, _reviewing: false, _verdict: res.verdict } : c));
                        } catch (err) {
                          toast.error(api.getApiErrorMessage(err, t('chat.toasts.commandReviewFailed')));
                          setDevopsConfirmations(prev => prev.map((c, i) => i === confIdx ? { ...c, _reviewing: false } : c));
                        }
                      }}
                    >
                      {conf._reviewing ? t('chat.confirm.reviewing') : t('chat.confirm.review')}
                    </button>
                    <RejectWithComment
                      className={s.suggestMacroDismissBtn}
                      disabled={submittingConfirmationIds.has(conf.confirmation_id)}
                      onReject={async (comment) => {
                        if (!beginConfirmationSubmission(conf.confirmation_id)) return;
                        try {
                          await api.apiFetch('/api/v1/devops/approve', {
                            method: 'POST',
                            body: JSON.stringify({ confirmation_id: conf.confirmation_id, approved: false, rejection_comment: comment }),
                          });
                          setDevopsConfirmations(prev => prev.filter(c => c.confirmation_id !== conf.confirmation_id));
                        } catch {
                          toast.error(t('chat.toasts.commandApprovalFailed'));
                        } finally {
                          finishConfirmationSubmission(conf.confirmation_id);
                        }
                      }}
                    />
                  </div>
                </div>
              ))}

              {/* Browser action confirmation cards */}
              {browserActionConfirmations.map((conf) => (
                <div key={`browser-${conf.confirmation_id}`} className={s.suggestMacroCard}>
                  <div className={s.suggestMacroHeader}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M3 12h18" />
                      <path d="M12 3a15 15 0 0 1 0 18" />
                      <path d="M12 3a15 15 0 0 0 0 18" />
                    </svg>
                    <span className={s.suggestMacroTitle}>{t('chat.browser.confirmTitle')}</span>
                    <button
                      className={s.suggestMacroClose}
                      disabled={submittingConfirmationIds.has(conf.confirmation_id)}
                      onClick={() => {
                        if (!beginConfirmationSubmission(conf.confirmation_id)) return;
                        setBrowserActionConfirmations(prev => prev.filter(c => c.confirmation_id !== conf.confirmation_id));
                        void api.apiFetch('/api/v1/pc-commands/approve', {
                          method: 'POST',
                          body: JSON.stringify({ confirmation_id: conf.confirmation_id, approved: false }),
                        }).catch((error) => {
                          if (!(error instanceof api.ApiError) || error.status !== 404) {
                            toast.error(t('chat.browser.failed'));
                          }
                        }).finally(() => finishConfirmationSubmission(conf.confirmation_id));
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                  <div className={s.suggestMacroCommands}>
                    <code className={s.suggestMacroCmd}>
                      {conf.action_type === 'open'
                        ? t('chat.browser.open', { target: conf.url || conf.description })
                        : conf.action_type === 'fill'
                          ? t('chat.browser.fill', { target: conf.description })
                          : t('chat.browser.click', { target: conf.description })}
                    </code>
                  </div>
                  {conf.target_element && conf.action_type !== 'open' && (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px', background: 'var(--bg-modal-hover)', borderRadius: '6px', marginTop: '6px' }}>
                      <div>
                        {t('chat.browser.actualTarget')}: &lt;{conf.target_element.tag || 'element'}{conf.target_element.inputType ? ` type="${conf.target_element.inputType}"` : ''}{conf.target_element.role ? ` role="${conf.target_element.role}"` : ''}&gt;
                      </div>
                      {conf.target_element.href && (
                        <div style={{ marginTop: '4px', overflowWrap: 'anywhere' }}>{conf.target_element.href}</div>
                      )}
                    </div>
                  )}
                  {conf.text && (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px', background: 'var(--bg-modal-hover)', borderRadius: '6px', marginTop: '6px', whiteSpace: 'pre-wrap' }}>
                      {conf.text}
                    </div>
                  )}
                  {conf.origin && conf.action_type !== 'open' && (
                    <div style={{ fontSize: '11px', color: 'var(--text-hint)', marginTop: '6px' }}>
                      {t('chat.browser.currentSite', { site: conf.origin })}
                    </div>
                  )}
                  {submittingConfirmationIds.has(conf.confirmation_id) && (
                    <div role="status" style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>
                      {t('chat.confirm.executing')}
                    </div>
                  )}
                  <div className={s.suggestMacroActions}>
                    <button
                      className={s.suggestMacroSaveBtn}
                      disabled={submittingConfirmationIds.has(conf.confirmation_id)}
                      onClick={async () => {
                        if (!beginConfirmationSubmission(conf.confirmation_id)) return;
                        try {
                          await api.apiFetch('/api/v1/pc-commands/approve', {
                            method: 'POST',
                            body: JSON.stringify({ confirmation_id: conf.confirmation_id, approved: true }),
                          });
                          toast.success(t('chat.browser.executed'));
                          setBrowserActionConfirmations(prev => prev.filter(c => c.confirmation_id !== conf.confirmation_id));
                        } catch (error) {
                          toast.error(t('chat.browser.failed'));
                          if (error instanceof api.ApiError && (error.status === 404 || error.status === 500)) {
                            setBrowserActionConfirmations(prev => prev.filter(c => c.confirmation_id !== conf.confirmation_id));
                          }
                        } finally {
                          finishConfirmationSubmission(conf.confirmation_id);
                        }
                      }}
                    >
                      {t('chat.confirm.allow')}
                    </button>
                    {conf.origin && conf.action_type !== 'open' && (
                      <button
                        className={s.suggestMacroSaveBtn}
                        style={{ background: 'var(--bg-modal-hover)', color: 'var(--text-primary)', border: '1px solid var(--border-input)' }}
                        title={t('chat.browser.allowSiteSessionHint', { site: conf.origin })}
                        disabled={submittingConfirmationIds.has(conf.confirmation_id)}
                        onClick={async () => {
                          if (!beginConfirmationSubmission(conf.confirmation_id)) return;
                          try {
                            await api.apiFetch('/api/v1/pc-commands/approve', {
                              method: 'POST',
                              body: JSON.stringify({
                                confirmation_id: conf.confirmation_id,
                                approved: true,
                                allow_browser_site_session: true,
                              }),
                            });
                            toast.success(t('chat.browser.siteAllowedSession', { site: conf.origin }));
                            setBrowserActionConfirmations(prev => prev.filter(c => c.confirmation_id !== conf.confirmation_id));
                          } catch (error) {
                            toast.error(t('chat.browser.failed'));
                            if (error instanceof api.ApiError && (error.status === 404 || error.status === 500)) {
                              setBrowserActionConfirmations(prev => prev.filter(c => c.confirmation_id !== conf.confirmation_id));
                            }
                          } finally {
                            finishConfirmationSubmission(conf.confirmation_id);
                          }
                        }}
                      >
                        {t('chat.browser.allowSiteSession')}
                      </button>
                    )}
                    <RejectWithComment
                      className={s.suggestMacroDismissBtn}
                      disabled={submittingConfirmationIds.has(conf.confirmation_id)}
                      onReject={async (comment) => {
                        if (!beginConfirmationSubmission(conf.confirmation_id)) return;
                        try {
                          await api.apiFetch('/api/v1/pc-commands/approve', {
                            method: 'POST',
                            body: JSON.stringify({ confirmation_id: conf.confirmation_id, approved: false, rejection_comment: comment }),
                          });
                          setBrowserActionConfirmations(prev => prev.filter(c => c.confirmation_id !== conf.confirmation_id));
                        } catch (error) {
                          toast.error(t('chat.browser.failed'));
                          if (error instanceof api.ApiError && (error.status === 404 || error.status === 500)) {
                            setBrowserActionConfirmations(prev => prev.filter(c => c.confirmation_id !== conf.confirmation_id));
                          }
                        } finally {
                          finishConfirmationSubmission(conf.confirmation_id);
                        }
                      }}
                    />
                  </div>
                </div>
              ))}

              {/* Embedded browser download confirmation cards */}
              {browserDownloadConfirmations.map((conf) => {
                const submitDownloadDecision = async (approved: boolean) => {
                  if (!beginConfirmationSubmission(conf.confirmation_id)) return;
                  try {
                    const response = await api.apiFetch<any>('/api/v1/pc-commands/approve', {
                      method: 'POST',
                      body: JSON.stringify({
                        confirmation_id: conf.confirmation_id,
                        approved,
                      }),
                    });
                    const decisionResult = response?.result;
                    setBrowserDownloadConfirmations(prev => prev.filter(c => c.confirmation_id !== conf.confirmation_id));
                    if (approved && decisionResult?.status === 'started') toast.success(t('chat.browserDownload.started'));
                  } catch (error) {
                    if (!(error instanceof api.ApiError) || (error.status !== 404 && error.status !== 500)) {
                      toast.error(t('chat.browserDownload.failed'));
                    }
                    setBrowserDownloadConfirmations(prev => prev.filter(c => c.confirmation_id !== conf.confirmation_id));
                  } finally {
                    finishConfirmationSubmission(conf.confirmation_id);
                  }
                };
                return (
                  <div key={`browser-download-${conf.confirmation_id}`} className={s.suggestMacroCard}>
                    <div className={s.suggestMacroHeader}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 3v12" />
                        <path d="m7 10 5 5 5-5" />
                        <path d="M5 21h14" />
                      </svg>
                      <span className={s.suggestMacroTitle}>{t('chat.browserDownload.confirmTitle')}</span>
                      <button
                        className={s.suggestMacroClose}
                        disabled={submittingConfirmationIds.has(conf.confirmation_id)}
                        onClick={() => void submitDownloadDecision(false)}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                    <div className={s.suggestMacroCommands}>
                      <code className={s.suggestMacroCmd}>{conf.filename}</code>
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px', background: 'var(--bg-modal-hover)', borderRadius: '6px', marginTop: '6px' }}>
                      {conf.total_bytes && conf.total_bytes > 0 && (
                        <div>{t('chat.browserDownload.size', { size: conf.total_bytes < 1024 * 1024 ? `${(conf.total_bytes / 1024).toFixed(1)} KB` : `${(conf.total_bytes / (1024 * 1024)).toFixed(1)} MB` })}</div>
                      )}
                      {conf.mime_type && <div>{t('chat.browserDownload.type', { type: conf.mime_type })}</div>}
                      {conf.url && <div style={{ marginTop: '4px', overflowWrap: 'anywhere' }}>{conf.url}</div>}
                    </div>
                    {submittingConfirmationIds.has(conf.confirmation_id) && (
                      <div role="status" style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>
                        {t('chat.confirm.executing')}
                      </div>
                    )}
                    <div className={s.suggestMacroActions}>
                      <button
                        className={s.suggestMacroSaveBtn}
                        disabled={submittingConfirmationIds.has(conf.confirmation_id)}
                        onClick={() => void submitDownloadDecision(true)}
                      >
                        {t('chat.browserDownload.download')}
                      </button>
                      <button
                        className={s.suggestMacroDismissBtn}
                        disabled={submittingConfirmationIds.has(conf.confirmation_id)}
                        onClick={() => void submitDownloadDecision(false)}
                      >
                        {t('chat.browserDownload.cancel')}
                      </button>
                    </div>
                  </div>
                );
              })}

              {/* PC Command Confirmation cards */}
              {pcCommandConfirmations.map((conf, confIdx) => (
                <div key={`pc-${confIdx}`} className={s.suggestMacroCard}>
                  <div className={s.suggestMacroHeader}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                      <line x1="8" y1="21" x2="16" y2="21" />
                      <line x1="12" y1="17" x2="12" y2="21" />
                    </svg>
                    <span className={s.suggestMacroTitle}>{t('chat.confirm.pcCommand')}</span>
                    <button
                      className={s.suggestMacroClose}
                      disabled={submittingConfirmationIds.has(conf.confirmation_id)}
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
                  {submittingConfirmationIds.has(conf.confirmation_id) && (
                    <div role="status" style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px', background: 'var(--bg-modal-hover)', borderRadius: '6px', marginTop: '6px' }}>
                      {t('chat.confirm.executing')}
                    </div>
                  )}
                  <div className={s.suggestMacroActions}>
                    <button
                      className={s.suggestMacroSaveBtn}
                      disabled={submittingConfirmationIds.has(conf.confirmation_id)}
                      onClick={async () => {
                        if (!beginConfirmationSubmission(conf.confirmation_id)) return;
                        try {
                          await api.apiFetch('/api/v1/pc-commands/approve', {
                            method: 'POST',
                            body: JSON.stringify({ confirmation_id: conf.confirmation_id, approved: true }),
                          });
                          toast.success(t('chat.toasts.commandExecuted'));
                          setPcCommandConfirmations(prev => prev.filter(c => c.confirmation_id !== conf.confirmation_id));
                        } catch {
                          toast.error(t('chat.toasts.commandExecutionFailed'));
                        } finally {
                          finishConfirmationSubmission(conf.confirmation_id);
                        }
                      }}
                    >
                      {t('chat.confirm.allow')}
                    </button>
                    <button
                      className={s.suggestMacroSaveBtn}
                      disabled={submittingConfirmationIds.has(conf.confirmation_id)}
                      style={{ background: 'var(--bg-modal-hover)', color: 'var(--text-primary)', border: '1px solid var(--border-input)' }}
                      onClick={async () => {
                        if (!beginConfirmationSubmission(conf.confirmation_id)) return;
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
                          toast.success(t('chat.toasts.commandAlwaysApproved'));
                          setPcCommandConfirmations(prev => prev.filter(c => c.confirmation_id !== conf.confirmation_id));
                        } catch {
                          toast.error(t('chat.toasts.policySaveFailed'));
                        } finally {
                          finishConfirmationSubmission(conf.confirmation_id);
                        }
                      }}
                    >
                      {t('chat.confirm.alwaysAllow')}
                    </button>
                    <button
                      className={s.suggestMacroSaveBtn}
                      disabled={conf._reviewing || submittingConfirmationIds.has(conf.confirmation_id)}
                      style={{ background: 'var(--bg-modal-hover)', color: 'var(--text-primary)', border: '1px solid var(--border-input)', opacity: conf._reviewing || submittingConfirmationIds.has(conf.confirmation_id) ? 0.6 : 1, minWidth: '80px' }}
                      onClick={async () => {
                        setPcCommandConfirmations(prev => prev.map((c, i) => i === confIdx ? { ...c, _reviewing: true } : c));
                        try {
                          const res = await api.apiFetch<{ verdict: string }>('/api/v1/devops/runbooks/review-commands', {
                            method: 'POST',
                            body: JSON.stringify({ commands: [conf.command] }),
                          });
                          setPcCommandConfirmations(prev => prev.map((c, i) => i === confIdx ? { ...c, _reviewing: false, _verdict: res.verdict } : c));
                        } catch (err) {
                          toast.error(api.getApiErrorMessage(err, t('chat.toasts.commandReviewFailed')));
                          setPcCommandConfirmations(prev => prev.map((c, i) => i === confIdx ? { ...c, _reviewing: false } : c));
                        }
                      }}
                    >
                      {conf._reviewing ? t('chat.confirm.reviewing') : t('chat.confirm.review')}
                    </button>
                    <RejectWithComment
                      className={s.suggestMacroDismissBtn}
                      disabled={submittingConfirmationIds.has(conf.confirmation_id)}
                      onReject={async (comment) => {
                        if (!beginConfirmationSubmission(conf.confirmation_id)) return;
                        try {
                          await api.apiFetch('/api/v1/pc-commands/approve', {
                            method: 'POST',
                            body: JSON.stringify({ confirmation_id: conf.confirmation_id, approved: false, rejection_comment: comment }),
                          });
                          setPcCommandConfirmations(prev => prev.filter(c => c.confirmation_id !== conf.confirmation_id));
                        } catch {
                          toast.error(t('chat.toasts.commandExecutionFailed'));
                        } finally {
                          finishConfirmationSubmission(conf.confirmation_id);
                        }
                      }}
                    />
                  </div>
                </div>
              ))}

              {/* File Action Confirmation cards */}
              {fileActionConfirmations.map((conf, confIdx) => (
                <div key={`file-${confIdx}`} className={s.suggestMacroCard}>
                  <div className={s.suggestMacroHeader}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                    </svg>
                    <span className={s.suggestMacroTitle}>
                      {conf.action_type === 'write' ? t('chat.file.writingTitle', { append: conf.mode === 'append' ? t('chat.file.appendMarker') : '' }) : t('chat.file.reading')}
                    </span>
                    <button
                      className={s.suggestMacroClose}
                      onClick={() => setFileActionConfirmations(prev => prev.filter((_, i) => i !== confIdx))}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                  <div className={s.suggestMacroCommands}>
                    <code className={s.suggestMacroCmd}>{conf.file_path}</code>
                  </div>
                  {conf.action_type === 'write' && conf.size_bytes !== undefined && (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                      {t('chat.file.sizeValue', { size: (conf.size_bytes / 1024).toFixed(1) })}
                      {conf.mode === 'append' ? t('chat.file.appendMode') : t('chat.file.overwriteMode')}
                    </div>
                  )}
                  {conf.action_type === 'read' && conf.start_line !== undefined && (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                      {t('chat.file.lineRange', { start: conf.start_line, end: conf.start_line + (conf.max_lines || 500) - 1 })}
                    </div>
                  )}
                  {conf.content_preview && (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px', background: 'var(--bg-modal-hover)', borderRadius: '6px', marginTop: '6px', maxHeight: '200px', overflow: 'auto' }}>
                      <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'inherit' }}>{conf.content_preview.slice(0, 1500)}</pre>
                    </div>
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
                          toast.success(conf.action_type === 'write' ? t('chat.toasts.fileWritten') : t('chat.toasts.fileRead'));
                          setFileActionConfirmations(prev => prev.filter((_, i) => i !== confIdx));
                        } catch {
                          toast.error(t('chat.toasts.commandExecutionFailed'));
                        }
                      }}
                    >
                      {conf.action_type === 'write' ? t('chat.file.write') : t('chat.file.read')}
                    </button>
                    {conf.action_type === 'write' && (
                      <button
                        className={s.suggestMacroSaveBtn}
                        style={{ background: 'var(--bg-modal-hover)', color: 'var(--text-primary)', border: '1px solid var(--border-input)' }}
                        title={t('chat.file.allowFolderSessionHint')}
                        onClick={async () => {
                          try {
                            const selection = await window.electronAPI.grantSessionWriteFolder(conf.file_path);
                            if (selection.canceled || !selection.folder) return;
                            await api.apiFetch('/api/v1/pc-commands/approve', {
                              method: 'POST',
                              body: JSON.stringify({ confirmation_id: conf.confirmation_id, approved: true }),
                            });
                            autoApprovedFileIdsRef.current.add(conf.confirmation_id);
                            toast.success(t('chat.toasts.folderAllowedSession', { folder: selection.folder }));
                            setFileActionConfirmations(prev => prev.filter((_, i) => i !== confIdx));
                          } catch {
                            toast.error(t('chat.toasts.commandExecutionFailed'));
                          }
                        }}
                      >
                        {t('chat.file.allowFolderSession')}
                      </button>
                    )}
                    <RejectWithComment
                      className={s.suggestMacroDismissBtn}
                      onReject={async (comment) => {
                        try {
                          await api.apiFetch('/api/v1/pc-commands/approve', {
                            method: 'POST',
                            body: JSON.stringify({ confirmation_id: conf.confirmation_id, approved: false, rejection_comment: comment }),
                          });
                        } catch {}
                        setFileActionConfirmations(prev => prev.filter((_, i) => i !== confIdx));
                      }}
                    />
                  </div>
                </div>
              ))}

              {/* Edit File Lines Confirmation cards */}
              {editFileLinesConfirmations.map((conf, confIdx) => (
                <div key={`edit-${confIdx}`} className={s.suggestMacroCard}>
                  <div className={s.suggestMacroHeader}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 20h9"/>
                      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                    </svg>
                    <span className={s.suggestMacroTitle}>
                      {t('chat.file.editingLines', { start: conf.start_line, end: conf.end_line })}
                    </span>
                    <button
                      className={s.suggestMacroClose}
                      onClick={() => setEditFileLinesConfirmations(prev => prev.filter((_, i) => i !== confIdx))}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                  <div className={s.suggestMacroCommands}>
                    <code className={s.suggestMacroCmd}>{conf.file_path}</code>
                  </div>
                  <FileEditDiff
                    oldContent={conf.old_content_preview || ''}
                    newContent={conf.new_content_preview || ''}
                  />
                  <div className={s.suggestMacroActions}>
                    <button
                      className={s.suggestMacroSaveBtn}
                      onClick={async () => {
                        try {
                          await api.apiFetch('/api/v1/pc-commands/approve', {
                            method: 'POST',
                            body: JSON.stringify({ confirmation_id: conf.confirmation_id, approved: true }),
                          });
                          toast.success(t('chat.toasts.linesReplaced'));
                          setEditFileLinesConfirmations(prev => prev.filter((_, i) => i !== confIdx));
                        } catch {
                          toast.error(t('chat.toasts.commandExecutionFailed'));
                        }
                      }}
                    >
                      {t('common.apply')}
                    </button>
                    <button
                      className={s.suggestMacroSaveBtn}
                      style={{ background: 'var(--bg-modal-hover)', color: 'var(--text-primary)', border: '1px solid var(--border-input)' }}
                      title={t('chat.file.allowFolderSessionHint')}
                      onClick={async () => {
                        try {
                          const selection = await window.electronAPI.grantSessionWriteFolder(conf.file_path);
                          if (selection.canceled || !selection.folder) return;
                          await api.apiFetch('/api/v1/pc-commands/approve', {
                            method: 'POST',
                            body: JSON.stringify({ confirmation_id: conf.confirmation_id, approved: true }),
                          });
                          autoApprovedFileIdsRef.current.add(conf.confirmation_id);
                          toast.success(t('chat.toasts.folderAllowedSession', { folder: selection.folder }));
                          setEditFileLinesConfirmations(prev => prev.filter((_, i) => i !== confIdx));
                        } catch {
                          toast.error(t('chat.toasts.commandExecutionFailed'));
                        }
                      }}
                    >
                      {t('chat.file.allowFolderSession')}
                    </button>
                    <RejectWithComment
                      className={s.suggestMacroDismissBtn}
                      onReject={async (comment) => {
                        try {
                          await api.apiFetch('/api/v1/pc-commands/approve', {
                            method: 'POST',
                            body: JSON.stringify({ confirmation_id: conf.confirmation_id, approved: false, rejection_comment: comment }),
                          });
                        } catch {}
                        setEditFileLinesConfirmations(prev => prev.filter((_, i) => i !== confIdx));
                      }}
                    />
                  </div>
                </div>
              ))}


              {/* Webcam Capture Confirmation cards */}
              {webcamCaptureConfirmations.map((conf, confIdx) => (
                <div key={`webcam-${confIdx}`} className={s.suggestMacroCard}>
                  <div className={s.suggestMacroHeader}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                      <circle cx="12" cy="13" r="4"/>
                    </svg>
                    <span className={s.suggestMacroTitle}>{t('chat.webcam.title')}</span>
                    <button
                      className={s.suggestMacroClose}
                      onClick={() => setWebcamCaptureConfirmations(prev => prev.filter((_, i) => i !== confIdx))}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                  <div className={s.suggestMacroCommands}>
                    <code className={s.suggestMacroCmd}>{t('chat.webcam.cameraValue', { camera: conf.camera_name })}</code>
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                    {t('chat.webcam.taskValue', { task: conf.purpose })}
                  </div>
                  <div className={s.suggestMacroActions}>
                    <button
                      className={s.suggestMacroSaveBtn}
                      onClick={async () => {
                        try {
                          await api.apiFetch('/api/v1/pc-commands/approve', {
                            method: 'POST',
                            body: JSON.stringify({ confirmation_id: conf.confirmation_id, approved: true }),
                          });
                          toast.success(t('chat.toasts.photoCaptured'));
                          setWebcamCaptureConfirmations(prev => prev.filter((_, i) => i !== confIdx));
                        } catch {
                          toast.error(t('chat.toasts.captureFailed'));
                        }
                      }}
                    >
                      {t('chat.confirm.allow')}
                    </button>
                    <RejectWithComment
                      className={s.suggestMacroDismissBtn}
                      onReject={async (comment) => {
                        try {
                          await api.apiFetch('/api/v1/pc-commands/approve', {
                            method: 'POST',
                            body: JSON.stringify({ confirmation_id: conf.confirmation_id, approved: false, rejection_comment: comment }),
                          });
                        } catch {}
                        setWebcamCaptureConfirmations(prev => prev.filter((_, i) => i !== confIdx));
                      }}
                    />
                  </div>
                </div>
              ))}


              {/* Email Confirmation cards */}
              {emailConfirmations.map((conf, confIdx) => (
                <div key={`email-${confIdx}`} className={s.suggestMacroCard}>
                  <div className={s.suggestMacroHeader}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="4" width="20" height="16" rx="2" ry="2" />
                      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                    </svg>
                    <span className={s.suggestMacroTitle}>{t('chat.email.title')}</span>
                    <button
                      className={s.suggestMacroClose}
                      onClick={() => setEmailConfirmations(prev => prev.filter((_, i) => i !== confIdx))}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                  {conf.from && (
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '2px' }}>
                      {t('chat.email.from')} <span style={{ color: 'var(--text-primary)' }}>{conf.from}</span>
                    </div>
                  )}
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '2px' }}>
                    {t('chat.email.to')} <span style={{ color: 'var(--text-primary)' }}>{conf.to}</span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px' }}>
                    {t('chat.email.subject')} <span style={{ color: 'var(--text-primary)' }}>{conf.subject}</span>
                  </div>
                  <div style={{ fontSize: '12px', padding: '8px', background: 'var(--bg-modal-hover)', borderRadius: '6px', maxHeight: '200px', overflowY: 'auto' }}>
                    <MarkdownRenderer content={conf.body} />
                  </div>
                  <div className={s.suggestMacroActions} style={{ marginTop: 10 }}>
                    <button
                      className={s.suggestMacroSaveBtn}
                      onClick={async () => {
                        try {
                          await api.apiFetch('/api/v1/email/approve', {
                            method: 'POST',
                            body: JSON.stringify({ confirmation_id: conf.confirmation_id, approved: true }),
                          });
                          toast.success(t('chat.toasts.emailSent'));
                          setEmailConfirmations(prev => prev.filter((_, i) => i !== confIdx));
                        } catch {
                          toast.error(t('chat.toasts.emailSendFailed'));
                        }
                      }}
                    >
                      {t('common.send')}
                    </button>
                    <RejectWithComment
                      className={s.suggestMacroDismissBtn}
                      onReject={async (comment) => {
                        try {
                          await api.apiFetch('/api/v1/email/approve', {
                            method: 'POST',
                            body: JSON.stringify({ confirmation_id: conf.confirmation_id, approved: false, rejection_comment: comment }),
                          });
                        } catch {}
                        setEmailConfirmations(prev => prev.filter((_, i) => i !== confIdx));
                      }}
                    />
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
                    <span className={s.suggestMacroTitle}>{t('chat.runbook.title')}</span>
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
                          toast.success(t('chat.toasts.runbookSaved'));
                          setPendingRunbooks(prev => prev.filter((_, i) => i !== rbIdx));
                        } catch {
                          toast.error(t('chat.toasts.runbookSaveFailed'));
                        }
                      }}
                    >
                      {t('common.save')}
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
                        } catch (err) {
                          toast.error(api.getApiErrorMessage(err, t('chat.toasts.commandsReviewFailed')));
                          setPendingRunbooks(prev => prev.map((r, i) => i === rbIdx ? { ...r, _reviewing: false } : r));
                        }
                      }}
                    >
                      {rb._reviewing ? t('chat.confirm.reviewing') : t('chat.confirm.review')}
                    </button>
                    <button
                      className={s.suggestMacroDismissBtn}
                      onClick={() => setPendingRunbooks(prev => prev.filter((_, i) => i !== rbIdx))}
                    >
                      {t('common.reject')}
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
                    <span className={s.suggestMacroTitle}>{t('chat.credentials.title')}</span>
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
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{t('chat.credentials.user')}</span>
                        <code style={{ fontSize: '11px', color: 'var(--danger, #e53935)', textDecoration: 'line-through' }}>{upd.current_username}</code>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>
                        <code style={{ fontSize: '11px', color: 'var(--accent)' }}>{upd.new_username}</code>
                      </div>
                      {upd.use_ssh_key && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{t('chat.credentials.authentication')}</span>
                          <span style={{ fontSize: '11px', color: 'var(--accent)' }}>{t('chat.credentials.sshKey')}</span>
                        </div>
                      )}
                      {upd.remove_password && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{t('chat.credentials.password')}</span>
                          <span style={{ fontSize: '11px', color: 'var(--danger, #e53935)' }}>{t('chat.credentials.willBeRemoved')}</span>
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
                          toast.error(err?.body?.error || t('chat.toasts.credentialsUpdateFailed'));
                        }
                      }}
                    >
                      {t('common.apply')}
                    </button>
                    <RejectWithComment
                      className={s.suggestMacroDismissBtn}
                      onReject={async (comment) => {
                        if (upd.confirmation_id) {
                          try {
                            await api.apiFetch('/api/v1/devops/approve', {
                              method: 'POST',
                              body: JSON.stringify({ confirmation_id: upd.confirmation_id, approved: false, rejection_comment: comment }),
                            });
                          } catch {}
                        }
                        setPendingCredsUpdates(prev => prev.filter((_, i) => i !== updIdx));
                      }}
                    />
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
                  {t('common.copy')}
                </button>
                <button className={s.contextMenuItem} onClick={() => handleDownloadDocx(msgMenuId)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  {t('chat.sidebar.downloadDocx')}
                </button>
                {user?.telegram_linked && (
                  <button className={s.contextMenuItem} onClick={() => handleSendToTelegram(msgMenuId)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="22" y1="2" x2="11" y2="13" />
                      <polygon points="22 2 15 22 11 13 2 9 22 2" />
                    </svg>
                    {t('chat.message.sendTelegram')}
                  </button>
                )}
                <button className={s.contextMenuItem} onClick={() => handleForkFromMessage(msgMenuId)} disabled={forking} title={t('chat.message.branchTitle')}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="6" cy="6" r="2" />
                    <circle cx="6" cy="18" r="2" />
                    <circle cx="18" cy="6" r="2" />
                    <path d="M6 8v8" />
                    <path d="M18 8c0 4-4 4-6 6" />
                  </svg>
                  {t('chat.message.createBranch')}
                </button>
                <button className={s.contextMenuItem} onClick={() => handleStartEdit(msgMenuId)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                  {t('common.edit')}
                </button>
                <button className={`${s.contextMenuItem} ${s.contextMenuItemDanger}`} onClick={() => handleDeleteMessage(msgMenuId)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                  {t('common.delete')}
                </button>
              </div>
            )}

            {/* Group room turn controls (UI prototype only) */}
            {roomCreated && roomCharacters.length > 1 && <div className={s.roomTurnBar}>
              {roomMode === 'manual' ? (
                <>
                  <span className={s.roomTurnLabel}>{t('chat.room.whoRespondsNext')}</span>
                  <div className={s.roomTurnParticipants}>
                    {roomCharacters.map((participant) => (
                      <button
                        key={participant.id}
                        type="button"
                        className={`${s.roomTurnParticipant} ${nextRoomParticipant === participant.id ? s.roomTurnParticipantActive : ''}`}
                        onClick={() => void updateRoomSettings({ next_agent_id: participant.id })}
                      >
                        <span className={`${s.roomTurnAvatar} ${getRoomAvatarClass(participant.id)}`}>{getRoomInitial(participant.name)}</span>
                        <span>{participant.name}</span>
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className={s.roomActionButton}
                    disabled={sending}
                    onClick={() => void runRoomAgentSequence([
                      nextRoomParticipant ?? roomCharacters[0].id,
                    ])}
                  >
                    {t('chat.room.reply')}
                  </button>
                </>
              ) : (
                <>
                  <span className={s.roomTurnLabel}>{t('chat.room.roundOrder')}</span>
                  <div className={s.roomRoundOrder}>
                    {roomCharacters.map((participant, index) => (
                      <React.Fragment key={participant.id}>
                        {index > 0 && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6" /></svg>}
                        <span><b>{index + 1}</b> {participant.name}</span>
                      </React.Fragment>
                    ))}
                  </div>
                  <button
                    type="button"
                    className={s.roomActionButton}
                    disabled={sending}
                    onClick={() => void runRoomAgentSequence(roomCharacters.map((participant) => participant.id))}
                  >
                    {t('chat.room.startSequence')}
                  </button>
                </>
              )}
            </div>}

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
                  {t('common.clear')}
                </button>
              </div>
            )}

            {/* Document previews above input */}
            {attachedDocuments.length > 0 && (
              <div className={s.imagePreviews} style={{ flexDirection: 'column', alignItems: 'stretch', gap: '4px' }}>
                {attachedDocuments.map((doc, i) => (
                  <div key={i} className={s.docPreviewItem} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 8px', borderRadius: '6px', backgroundColor: 'var(--bg-secondary)', fontSize: '12px' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)' }}>
                      {doc.filename}
                    </span>
                    <span style={{ color: 'var(--text-hint)', fontSize: '11px' }}>
                      {(doc.size_bytes / 1024).toFixed(1)} KB
                    </span>
                    <button
                      style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '16px', padding: '0 4px', lineHeight: 1 }}
                      onClick={() => setAttachedDocuments((prev) => prev.filter((_, idx) => idx !== i))}
                      title={t('common.delete')}
                    >
                      &times;
                    </button>
                  </div>
                ))}
                <button className={s.imageClearAll} onClick={() => setAttachedDocuments([])}>
                  {t('common.clear')}
                </button>
              </div>
            )}

            <div className={s.inputArea}>
              <QuotaWidget variant="compact" />
              {/* Dice Roll Mode: круглый кубик d20 слева от иконки файлов */}
              {diceRollEnabled && (
                <div
                  className={
                    diceStatus === 'rolling' ? `${s.diceRoll} ${s.diceRolling}`
                    : diceStatus === 'crit' ? `${s.diceRoll} ${s.diceRollCrit}`
                    : diceStatus === 'success' ? `${s.diceRoll} ${s.diceRollSuccess}`
                    : diceStatus === 'fail' ? `${s.diceRoll} ${s.diceRollFail}`
                    : diceStatus === 'crit_fail' ? `${s.diceRoll} ${s.diceRollCritFail}`
                    : diceMode === 'always_one' ? `${s.diceRoll} ${s.diceRollForceFail}`
                    : diceMode === 'always_twenty' ? `${s.diceRoll} ${s.diceRollForceCrit}`
                    : `${s.diceRoll} ${s.diceRollIdle}`
                  }
                  onClick={cycleDiceMode}
                  style={{ cursor: 'pointer' }}
                  title={
                    diceStatus === 'rolling' ? t('chat.dice.rolling')
                    : diceStatus === 'crit' ? `Критический успех! (${diceValue})`
                    : diceStatus === 'success' ? `Успех (${diceValue})`
                    : diceStatus === 'fail' ? `Неудача (${diceValue})`
                    : diceStatus === 'crit_fail' ? `Критический провал! (${diceValue})`
                    : diceMode === 'always_one' ? t('chat.dice.alwaysOneTitle')
                    : diceMode === 'always_twenty' ? t('chat.dice.alwaysTwentyTitle')
                    : t('chat.dice.normalTitle')
                  }
                >
                  {diceRolling || diceValue !== null ? diceValue : (diceMode === 'always_one' ? '1' : diceMode === 'always_twenty' ? '20' : '🎲')}
                </div>
              )}

              {maxImageBytes > 0 ? (
                <svg
                  className={s.inputIcon}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setShowAttachModal(true)}
                  viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon-light)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                >
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                </svg>
              ) : (
                <svg
                  className={s.inputIcon}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setShowAttachModal(true)}
                  viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon-light)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
              )}

              <div
                className={s.composerInputSlot}
                onDragEnter={(event) => {
                  if (!Array.from(event.dataTransfer.types).includes('Files') || sending) return;
                  event.preventDefault();
                  setDraggingFiles(true);
                }}
                onDragOver={(event) => {
                  if (!Array.from(event.dataTransfer.types).includes('Files') || sending) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'copy';
                  setDraggingFiles(true);
                }}
                onDragLeave={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  if (event.clientX <= rect.left || event.clientX >= rect.right || event.clientY <= rect.top || event.clientY >= rect.bottom) {
                    setDraggingFiles(false);
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setDraggingFiles(false);
                  void handleDroppedFiles(event.dataTransfer.files);
                }}
              >
                <textarea
                  ref={textareaRef}
                  className={s.textarea}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  placeholder={t('chat.composer.placeholder')}
                  rows={1}
                  disabled={sending}
                />
                {draggingFiles && !sending && (
                  <div className={s.composerDropTarget}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 5v14" />
                      <path d="m19 12-7 7-7-7" />
                    </svg>
                    <span>{t('attach.drop')}</span>
                  </div>
                )}
              </div>

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
                className={!input.trim() && attachedImages.length === 0 && attachedDocuments.length === 0 ? s.sendIconDisabled : s.sendIcon}
                onClick={() => { if (input.trim() || attachedImages.length > 0 || attachedDocuments.length > 0) handleSend(); }}
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

      <AnimatePresence initial={false}>
        {roomOpen && (
          <motion.aside
            className={s.roomPanel}
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 300, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className={s.roomPanelInner}>
              <div className={s.roomPanelHeader}>
                <div>
                  <div className={s.roomPanelTitle}>{t('chat.room.title')}</div>
                  <div className={s.roomPanelSubtitle}>{t('chat.room.subtitle')}</div>
                </div>
                <button type="button" className={s.roomCloseBtn} onClick={() => setRoomOpen(false)} aria-label={t('common.close')}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                </button>
              </div>

              {roomLoading ? (
                <div className={s.roomCreateState}>{t('common.loading')}</div>
              ) : !roomCreated ? (
                <div className={s.roomCreateState}>
                  <button
                    type="button"
                    className={s.roomCreateButton}
                    disabled={!activeChatId || roomSaving}
                    onClick={() => void createRoom()}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                    {t('chat.room.createRoom')}
                  </button>
                  <button
                    type="button"
                    className={s.roomJoinButton}
                    disabled={joinRoomBusy}
                    onClick={() => setJoinRoomOpen((open) => !open)}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6M21 3l-7 7M10 14H3v7h7z" /></svg>
                    {t('chat.room.joinRoom')}
                  </button>
                  {joinRoomOpen && (
                    <div className={s.roomJoinPanel} onClick={(event) => event.stopPropagation()}>
                      <input
                        className={s.roomJoinInput}
                        value={joinRoomLink}
                        placeholder={t('chat.room.inviteLinkPlaceholder')}
                        onChange={(event) => setJoinRoomLink(event.target.value)}
                        onKeyDown={(event) => { if (event.key === 'Enter') void joinRoom(); }}
                        autoFocus
                      />
                      <button type="button" className={s.roomCreateButton} disabled={joinRoomBusy} onClick={() => void joinRoom()}>
                        {t('chat.room.joinSubmit')}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
              <>
              <div className={s.roomSection}>
                <div className={s.roomSectionLabel}>{t('chat.room.mode')}</div>
                <div className={s.roomModeSwitch}>
                  <button type="button" disabled={roomSaving} className={roomMode === 'manual' ? s.roomModeActive : ''} onClick={() => void updateRoomSettings({ response_mode: 'manual' })}>
                    {t('chat.room.manual')}
                  </button>
                  <button type="button" disabled={roomSaving} className={roomMode === 'round' ? s.roomModeActive : ''} onClick={() => void updateRoomSettings({ response_mode: 'round' })}>
                    {t('chat.room.round')}
                  </button>
                </div>
                <div className={s.roomModeHint}>{t(roomMode === 'manual' ? 'chat.room.manualHint' : 'chat.room.roundHint')}</div>
                <div className={s.roomAutoRespondRow}>
                  <div className={s.roomAutoRespondText}>
                    <strong>{t('chat.room.autoRespond')}</strong>
                    <span>{t('chat.room.autoRespondHint')}</span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={roomAutoRespond}
                    className={`${s.roomToggle} ${roomAutoRespond ? s.roomToggleActive : ''}`}
                    disabled={roomSaving}
                    onClick={() => void updateRoomSettings({ auto_respond: !roomAutoRespond })}
                  >
                    <span />
                  </button>
                </div>
              </div>

              <div className={s.roomSection}>
                <div className={s.roomParticipantsHeader}>
                  <span className={s.roomSectionLabel}>{t('chat.room.participants')}</span>
                  <span className={s.roomParticipantTotal}>{otherRoomHumans.length + roomCharacters.length + 1}</span>
                </div>
                <DndContext
                  collisionDetection={closestCenter}
                  onDragStart={({ active }) => {
                    const participantId = Number(active.data.current?.participantId);
                    setDraggingRoomParticipantId(Number.isSafeInteger(participantId) ? participantId : null);
                    const initialRect = active.rect.current.initial;
                    setDraggingRoomParticipantSize(initialRect ? { width: initialRect.width, height: initialRect.height } : null);
                    setRoomParticipantMenuId(null);
                  }}
                  onDragCancel={() => {
                    setDraggingRoomParticipantId(null);
                    setDraggingRoomParticipantSize(null);
                  }}
                  onDragEnd={handleRoomParticipantDragEnd}
                >
                  <div className={s.roomParticipantList}>
                    <div className={s.roomParticipantCard}>
                      <span className={`${s.roomParticipantAvatar} ${s.roomAvatarHuman}`}>{(user?.name || user?.username || 'Y').trim().charAt(0).toUpperCase()}</span>
                      <div className={s.roomParticipantInfo}>
                        <strong>{user?.name || user?.username || t('chat.room.you')}</strong>
                        <span>{t('chat.room.human')}</span>
                      </div>
                      <span className={s.roomParticipantYou}>{t('chat.room.you')}</span>
                    </div>
                    {otherRoomHumans.map((member) => (
                      <div className={s.roomParticipantCard} key={`member-${member.user_id}`}>
                        <span className={`${s.roomParticipantAvatar} ${s.roomAvatarHuman}`}>{(member.name || 'U').trim().charAt(0).toUpperCase()}</span>
                        <div className={s.roomParticipantInfo}>
                          <strong>{member.name || `#${member.user_id}`}</strong>
                          <span>{t('chat.room.human')}</span>
                        </div>
                      </div>
                    ))}
                    {roomCharacters.map((participant, index) => (
                      <DemoDraggableRoomParticipant participantId={participant.id} key={participant.id}>
                        {(dragHandleProps) => (
                          <>
                            {roomCharacters.length > 1 && (
                              <button type="button" className={s.roomParticipantDrag} aria-label={t('chat.room.reorder')} {...dragHandleProps}>
                                <svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor"><circle cx="3" cy="3" r="1"/><circle cx="9" cy="3" r="1"/><circle cx="3" cy="8" r="1"/><circle cx="9" cy="8" r="1"/><circle cx="3" cy="13" r="1"/><circle cx="9" cy="13" r="1"/></svg>
                              </button>
                            )}
                            <span className={s.roomParticipantIndex}>{index + 1}</span>
                            <span className={`${s.roomParticipantAvatar} ${getRoomAvatarClass(participant.id)}`}>{getRoomInitial(participant.name)}</span>
                            <div className={s.roomParticipantInfo}>
                              {renamingRoomParticipantId === participant.id ? (
                                <input
                                  className={s.roomParticipantRenameInput}
                                  value={renamingRoomParticipantName}
                                  maxLength={80}
                                  onChange={(event) => setRenamingRoomParticipantName(event.target.value)}
                                  onClick={(event) => event.stopPropagation()}
                                  onBlur={() => void finishRoomCharacterRename()}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter') void finishRoomCharacterRename();
                                    if (event.key === 'Escape') {
                                      setRenamingRoomParticipantId(null);
                                      setRenamingRoomParticipantName('');
                                    }
                                  }}
                                  autoFocus
                                />
                              ) : <strong>{participant.name}</strong>}
                              <span>{index === 0 ? t('chat.room.mainAssistant') : t('chat.room.character')}</span>
                            </div>
                            {roomCharacters.length > 0 && (
                              <button
                                type="button"
                                className={s.roomParticipantMenu}
                                aria-label={t('common.actions')}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setRoomParticipantMenuId((current) => current === participant.id ? null : participant.id);
                                }}
                              >
                                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="8" cy="13" r="1.4"/></svg>
                              </button>
                            )}
                            {roomParticipantMenuId === participant.id && (
                              <div className={s.roomParticipantContextMenu} onClick={(event) => event.stopPropagation()}>
                                <button type="button" onClick={() => startRoomCharacterRename(participant)}>
                                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                                  {t('chat.sidebar.rename')}
                                </button>
                                <button type="button" onClick={() => startRoomCharacterPromptChange(participant.id)}>
                                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M1 14h6"/><path d="M9 8h6"/><path d="M17 16h6"/></svg>
                                  {t('chat.room.changePrompt')}
                                </button>
                                <button type="button" className={s.roomParticipantContextDanger} onClick={() => void removeRoomCharacter(participant.id)}>
                                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                                  {t('chat.room.removeParticipant')}
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </DemoDraggableRoomParticipant>
                    ))}
                  </div>
                  <DragOverlay zIndex={10002} dropAnimation={null}>
                    {draggingRoomParticipantId && (() => {
                      const participant = roomCharacters.find((item) => item.id === draggingRoomParticipantId);
                      if (!participant) return null;
                      const index = roomCharacters.findIndex((item) => item.id === participant.id);
                      return (
                        <div className={`${s.roomParticipantCard} ${s.roomParticipantCardOverlay}`} style={draggingRoomParticipantSize || undefined}>
                          <button type="button" className={s.roomParticipantDrag} tabIndex={-1}>
                            <svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor"><circle cx="3" cy="3" r="1"/><circle cx="9" cy="3" r="1"/><circle cx="3" cy="8" r="1"/><circle cx="9" cy="8" r="1"/><circle cx="3" cy="13" r="1"/><circle cx="9" cy="13" r="1"/></svg>
                          </button>
                          <span className={s.roomParticipantIndex}>{index + 1}</span>
                          <span className={`${s.roomParticipantAvatar} ${getRoomAvatarClass(participant.id)}`}>{getRoomInitial(participant.name)}</span>
                          <div className={s.roomParticipantInfo}>
                            <strong>{participant.name}</strong>
                            <span>{index === 0 ? t('chat.room.mainAssistant') : t('chat.room.character')}</span>
                          </div>
                        </div>
                      );
                    })()}
                  </DragOverlay>
                </DndContext>
                <div className={s.roomAddParticipantWrap}>
                  {changingRoomParticipantPromptId !== null && (() => {
                    const participant = roomCharacters.find((item) => item.id === changingRoomParticipantPromptId);
                    if (!participant) return null;
                    return (
                      <div className={s.roomPromptPicker} onClick={(event) => event.stopPropagation()}>
                        <div className={s.roomPromptPickerTitle}>{t('chat.room.changePrompt')}</div>
                        <PromptSelector
                          options={roomPrompts}
                          value={participant.source_prompt_id}
                          onChange={(promptId) => void changeRoomCharacterPrompt(promptId)}
                          disabled={roomSaving}
                          placeholder={t('chat.room.choosePrompt')}
                          maxVisibleItems={5}
                          allowCreate={false}
                        />
                      </div>
                    );
                  })()}
                  {addParticipantKind === 'choose' && (
                    <div className={s.roomPromptPicker} onClick={(event) => event.stopPropagation()}>
                      <div className={s.roomPromptPickerTitle}>{t('chat.room.addParticipantKind')}</div>
                      <button type="button" className={s.roomAddKindOption} disabled={roomSaving} onClick={() => { setAddParticipantKind('bot'); }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M8 4h8M9 14h.01M15 14h.01"/></svg>
                        {t('chat.room.addBot')}
                      </button>
                      <button type="button" className={s.roomAddKindOption} disabled={roomSaving} onClick={() => { setAddParticipantKind(null); void createInviteLink(); }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg>
                        {t('chat.room.addHuman')}
                      </button>
                    </div>
                  )}
                  {addParticipantKind === 'bot' && (
                    <div className={s.roomPromptPicker} onClick={(event) => event.stopPropagation()}>
                      <div className={s.roomPromptPickerTitle}>{t('chat.room.choosePrompt')}</div>
                      <PromptSelector
                        options={roomPrompts}
                        value={null}
                        onChange={(promptId) => void addRoomCharacter(promptId)}
                        disabled={roomSaving}
                        placeholder={t('chat.room.choosePrompt')}
                        maxVisibleItems={5}
                        allowCreate={false}
                      />
                    </div>
                  )}
                  {inviteLink && (
                    <div className={s.roomPromptPicker} onClick={(event) => event.stopPropagation()}>
                      <div className={s.roomPromptPickerTitle}>{t('chat.room.inviteLinkTitle')}</div>
                      <div className={s.roomInviteLink}>{inviteLink}</div>
                      <div className={s.roomInviteActions}>
                        <button type="button" className={s.roomCreateButton} onClick={() => void copyInviteLink()}>
                          {inviteCopied ? t('chat.room.inviteCopied') : t('chat.room.copyInvite')}
                        </button>
                        <button type="button" className={s.roomInviteClose} onClick={() => setInviteLink(null)} aria-label={t('common.close')}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                        </button>
                      </div>
                      <div className={s.roomInviteHint}>{t('chat.room.inviteHint')}</div>
                    </div>
                  )}
                  <button
                    type="button"
                    className={s.roomAddParticipant}
                    disabled={roomSaving}
                    onClick={(event) => {
                      event.stopPropagation();
                      setChangingRoomParticipantPromptId(null);
                      setInviteLink(null);
                      setAddParticipantKind((kind) => (kind === 'choose' ? null : 'choose'));
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                    {t('chat.room.addParticipant')}
                  </button>
                </div>
              </div>
              <button
                type="button"
                className={s.roomDeleteButton}
                disabled={roomSaving}
                onClick={() => void deleteRoom()}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                {t('chat.room.deleteRoom')}
              </button>
              </>
              )}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* RIGHT TOOLS PANEL */}
      <ToolsPanel plan={user?.plan || 'free'} isAdmin={user?.is_admin || 0} activeChatId={activeChatId} onImageClick={(src, msgId, url) => { setViewerImageSrc(src); setViewerImageMsgId(msgId ?? null); setViewerImageUrl(url ?? null); }} onChatSelect={selectChat} />

      <AnimatePresence>
        {showSettings && (
          <SettingsModal
            key="settings-modal"
            onClose={() => setShowSettings(false)}
            onAccountChanged={loadChats}
            onAuthInvalidated={() => {
              setShowSettings(false);
              logout();
              navigate('/login', { replace: true });
            }}
          />
        )}

        {showAttachModal && (
          <AttachModal
            key="attach-modal"
            onClose={() => setShowAttachModal(false)}
            onAttach={handleAttachFromModal}
            currentImageCount={attachedImages.length}
            maxImageCount={maxImageCount}
            currentImageBytes={attachedImageBytes}
            maxTotalImageBytes={maxImageBytes}
          />
        )}

        <ConfirmDialog
          key="confirm-logout"
          open={showLogoutConfirm}
          title={t('chat.logoutDialog.title')}
          text={t('chat.logoutDialog.message')}
          confirmLabel={t('chat.logoutDialog.confirm')}
          onCancel={() => setShowLogoutConfirm(false)}
          onConfirm={performLogout}
        />

        <ConfirmDialog
          key="confirm-delete-chat"
          open={deletingChatId !== null}
          title={t('chat.deleteChat.title')}
          text={t('chat.deleteChat.message')}
          onCancel={() => setDeletingChatId(null)}
          onConfirm={handleConfirmDelete}
        />

        <ConfirmDialog
          key="confirm-delete-image"
          open={imageDeleteTarget !== null}
          title={t('chat.deleteImage.title')}
          text={t('chat.deleteImage.message')}
          onCancel={() => setImageDeleteTarget(null)}
          onConfirm={() => imageDeleteTarget && handleDeleteImage(imageDeleteTarget.messageId, imageDeleteTarget.url)}
          confirmLabel={deletingImage ? '...' : t('common.delete')}
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
              title={t('common.download')}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
            {viewerImageMsgId !== null && viewerImageMsgId > 0 && viewerImageUrl && (
              <button
                className={s.imageViewerDelete}
                onClick={(e) => { e.stopPropagation(); setImageDeleteTarget({ messageId: viewerImageMsgId, url: viewerImageUrl }); }}
                title={t('common.delete')}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            )}
            <button
              className={s.imageViewerClose}
              onClick={() => setViewerImageSrc(null)}
              title={t('common.close')}
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
