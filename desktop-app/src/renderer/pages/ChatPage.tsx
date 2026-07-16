import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useAuth } from '../lib/auth';
import { useUnreadChats } from '../lib/useUnreadChats';
import * as api from '../lib/api';
import { generateDocxBlob, generateChatDocxBlob } from '../lib/markdownToDocx';
import { LinkTelegramModal } from '../components/LinkTelegramModal';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { AttachModal } from '../components/AttachModal';
import { RejectWithComment } from '../components/RejectWithComment';
import type { ImageItem, DocumentItem } from '../components/AttachModal';
import { Select } from '../components/Select';
import Slider from '../components/Slider';
import { SettingsModal } from '../components/SettingsModal';
import { PixelAvatar, dispatchAvatarState, startAvatarLoop, stopAvatarLoop, getAvatarManifest } from '../components/PixelAvatar';
import type { SetDisplayStatePayload } from '../components/PixelAvatar';
import { ToolsPanel } from '../components/ToolsPanel';
import { openTool, handleDesktopAction, dispatchMapData, emitSuggestMacro } from '../lib/tools';
import { createSpeechRecorder } from '../lib/speechRecorder';
import { startWakeWordAudioStream, stopWakeWordAudioStream } from '../lib/wakeWordAudio';
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
const CHAT_PAGE_SIZE = 25;
/**
 * Ленивый рендеринг ленты: показываем не все загруженные сообщения, а только те,
 * что вписываются в токен-бюджет. Гарантируем минимум MIN_VISIBLE_MESSAGES (даже если
 * сумма токенов превышает бюджет). Кнопка «Показать ещё» расширяет бюджет на EXTRA_TOKEN_STEP.
 * Бэкенд по-прежнему отдаёт порциями по MESSAGE_PAGE_SIZE — мы лишь управляем DOM.
 */
const MESSAGE_TOKEN_BUDGET = 20000;
const MIN_VISIBLE_MESSAGES = 8;
const EXTRA_TOKEN_STEP = 20000;

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
                    <button className={s.messageImageDelete} onClick={(e) => { e.stopPropagation(); onDeleteImage(msg.id, img.url); }} title={t('common.delete')}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
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

function getMaxImagesForPlan(plan: string, isAdmin: number): number {
  if (isAdmin === 1) return MAX_IMAGES_ADMIN;
  switch (plan) {
    case 'pro': return MAX_IMAGES_PRO;
    case 'standart': return MAX_IMAGES_STANDART;
    default: return MAX_IMAGES_FREE;
  }
}

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
   * Расширенный бюджет токенов для ленивого рендеринга ленты.
   * Базовый MESSAGE_TOKEN_BUDGET + extraTokenBudget = текущий лимит показа.
   * Кнопка «Показать ещё» увеличивает extraTokenBudget на EXTRA_TOKEN_STEP.
   * Сбрасывается в 0 при смене чата.
   */
  const [extraTokenBudget, setExtraTokenBudget] = useState(0);
  const [loadingChats, setLoadingChats] = useState(false);
  const [loadingMoreChats, setLoadingMoreChats] = useState(false);
  const [hasMoreChats, setHasMoreChats] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [isLinked, setIsLinked] = useState(false);
  const [showAttachModal, setShowAttachModal] = useState(false);
  const [attachedImages, setAttachedImages] = useState<ImageItem[]>([]);
  const [attachedDocuments, setAttachedDocuments] = useState<DocumentItem[]>([]);
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
  const [msgMenuId, setMsgMenuId] = useState<number | null>(null);
  const [msgMenuPos, setMsgMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const msgMenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [editingMsgId, setEditingMsgId] = useState<number | null>(null);
  const [editingText, setEditingText] = useState('');
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
  const [viewerImageMsgId, setViewerImageMsgId] = useState<number | null>(null);
  const [viewerImageUrl, setViewerImageUrl] = useState<string | null>(null);
  const [imageDeleteTarget, setImageDeleteTarget] = useState<{ messageId: number; url: string } | null>(null);
  const [deletingImage, setDeletingImage] = useState(false);
  const [ttsPlayingId, setTtsPlayingId] = useState<number | null>(null);
  const [pendingMacros, setPendingMacros] = useState<Array<{ title: string; description?: string; commands: string[] }>>([]);
  const [devopsConfirmations, setDevopsConfirmations] = useState<Array<{ confirmation_id: string; server_name: string; server_id: number; host: string; command: string; needs_sudo_password?: boolean; sudo_password?: string; save_sudo_password?: boolean; needs_new_password?: boolean; new_password?: string; new_username?: string; _reviewing?: boolean; _verdict?: string }>>([]);
  const [pendingRunbooks, setPendingRunbooks] = useState<Array<{ title: string; content: string; commands: string[]; _reviewing?: boolean; _verdict?: string }>>([]);
  const [pendingCredsUpdates, setPendingCredsUpdates] = useState<Array<{ confirmation_id?: string; server_id: number; server_name: string; current_username: string; new_username: string; reason: string; use_ssh_key: boolean; remove_password: boolean }>>([]);
  const [pcCommandConfirmations, setPcCommandConfirmations] = useState<Array<{ confirmation_id: string; command: string; _reviewing?: boolean; _verdict?: string }>>([]);
  const [fileActionConfirmations, setFileActionConfirmations] = useState<Array<{ confirmation_id: string; action_type: 'read' | 'write'; file_path: string; mode?: string; size_bytes?: number; content_preview?: string; start_line?: number; max_lines?: number }>>([]);
  const [editFileLinesConfirmations, setEditFileLinesConfirmations] = useState<Array<{ confirmation_id: string; file_path: string; start_line: number; end_line: number; old_content_preview?: string; new_content_preview?: string }>>([]);
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

  const maxImages = user ? getMaxImagesForPlan(user.plan, user.is_admin) : 0;

  const checkLinkStatus = async () => {
    try {
      const status = await api.getLinkStatus();
      setIsLinked(status.linked);
    } catch {}
  };

  const loadChats = async () => {
    setLoadingChats(true);
    try {
      const res = await api.getChats(CHAT_PAGE_SIZE);
      setChats(res.chats);
      setHasMoreChats(res.chats.length === CHAT_PAGE_SIZE);
      if (res.active_chat_id) {
        setActiveChatId(res.active_chat_id);
      } else if (res.chats.length > 0) {
        selectChat(res.chats[0].id);
      }
    } catch (err) {
      console.error('Failed to load chats:', err);
    } finally {
      setLoadingChats(false);
    }
  };

  const loadMoreChats = useCallback(async () => {
    if (loadingMoreChats || !hasMoreChats || searchQuery.trim().length >= 3) return;
    setLoadingMoreChats(true);
    try {
      const res = await api.getChats(CHAT_PAGE_SIZE, chats.length);
      setHasMoreChats(res.chats.length === CHAT_PAGE_SIZE);
      if (res.chats.length > 0) {
        setChats(prev => {
          const seen = new Set(prev.map(chat => chat.id));
          const next = res.chats.filter(chat => !seen.has(chat.id));
          return [...prev, ...next];
        });
      }
    } catch (err) {
      console.error('Failed to load more chats:', err);
    } finally {
      setLoadingMoreChats(false);
    }
  }, [loadingMoreChats, hasMoreChats, searchQuery, chats.length]);

  const handleSidebarScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
      loadMoreChats();
    }
  }, [loadMoreChats]);

  useEffect(() => { loadChats(); checkLinkStatus(); }, []);

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
  }, [activeChatId, chats]);

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
    // Сброс токен-бюджета ленивого рендера — каждый чат начинается с чистого бюджета
    setExtraTokenBudget(0);
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
   *   1. Первые MIN_VISIBLE_MESSAGES показываем всегда, независимо от токен-бюджета.
   *   2. Дальше копим сумму token_count, пока не упрётся в MESSAGE_TOKEN_BUDGET + extraTokenBudget.
   * Остальные лежат в messages[] (в памяти), но не рендерятся — пользователь раскрывает
   * их кнопкой «Показать ещё» (увеличивает extraTokenBudget).
   *
   * При streaming нового сообщения оно добавляется в конец messages и попадает в visibleMessages автоматически.
   */
  const visibleMessages = useMemo<api.Message[]>(() => {
    // Если сообщений мало — показываем все, бюджет не важен.
    if (messages.length <= MIN_VISIBLE_MESSAGES) return messages;
    const budget = MESSAGE_TOKEN_BUDGET + extraTokenBudget;
    // Идём с конца (свежие) к началу (старые), копим token_count.
    // Гарантия: первые MIN_VISIBLE_MESSAGES (последние по индексу) показываем всегда,
    // даже если их сумма превышает бюджет — поэтому бюджет проверяем только после них.
    let sumTokens = 0;
    let cutIndex = messages.length; // по умолчанию: показываем все
    for (let i = messages.length - 1; i >= 0; i--) {
      const tk = messages[i].token_count ?? 0;
      // Бюджет проверяем ТОЛЬКО за пределами гарантированного минимума.
      // i < MIN_VISIBLE_MESSAGES — это индексы в "хвосте" (старые сообщения),
      // они могут быть скрыты только по бюджету.
      // Но: если мы ещё не вышли за минимум (i >= messages.length - MIN_VISIBLE_MESSAGES),
      // проверку бюджета пропускаем.
      const withinMin = i >= messages.length - MIN_VISIBLE_MESSAGES;
      if (!withinMin && sumTokens + tk > budget) {
        cutIndex = i + 1; // показываем начиная с i+1, всё что <= i — скрыто
        break;
      }
      sumTokens += tk;
      cutIndex = i;
    }
    return messages.slice(Math.max(0, cutIndex));
  }, [messages, extraTokenBudget]);

  /** Сколько сообщений скрыто (не отрендерено) сверх visibleMessages. */
  const hiddenMessagesCount = messages.length - visibleMessages.length;

  /** Примерное число токенов в скрытой части — для подписи на кнопке. */
  const hiddenTokensSum = useMemo(() => {
    const start = 0;
    const end = messages.length - visibleMessages.length;
    let sum = 0;
    for (let i = start; i < end; i++) sum += messages[i]?.token_count ?? 0;
    return sum;
  }, [messages, visibleMessages.length]);

  /** Раскрыть ещё одну порцию скрытых сообщений (увеличиваем токен-бюджет). */
  const showMoreHidden = useCallback(() => {
    setExtraTokenBudget(prev => prev + EXTRA_TOKEN_STEP);
  }, []);

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

  const handleIncomingDesktopAction = useCallback((action: api.DesktopActionPayload) => {
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
    if (action.action === 'file_action_confirmation' && action.value) {
      const val = action.value as { confirmation_id?: string; action_type?: 'read' | 'write'; file_path?: string; mode?: string; size_bytes?: number; content_preview?: string; start_line?: number; max_lines?: number };
      if (val.confirmation_id && val.file_path && val.action_type) {
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
        setEditFileLinesConfirmations(prev => {
          if (prev.some(c => c.confirmation_id === val.confirmation_id)) return prev;
          return [...prev, {
            confirmation_id: val.confirmation_id!,
            file_path: val.file_path!,
            start_line: val.start_line ?? 0,
            end_line: val.end_line ?? 0,
            old_content_preview: val.old_content_preview,
            new_content_preview: val.new_content_preview,
          }];
        });
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
    handleDesktopAction(action);
  }, []);

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
        onDone: (res) => {
          // Финализируем стрим-буфер перед обработкой done
          streamAppenderRef.current.flushNow();
          setStreamingState('done');
          setStreamingMsgId(null);
          // Dice Roll Mode: fallback — если событие dice_roll не дошло, используем done-поле
          if (typeof res.dice_roll === 'number' && diceRolling) {
            finishDiceRoll(res.dice_roll);
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
                      prompt_name: res.prompt_name ?? null,
                      model_name: res.model_name ?? null,
                      provider_name: res.provider_name ?? null,
                      usage: res.message_usage ?? null,
                    };
                  }
                  if (res.user_message_id && m.id === tempUserMsg.id) {
                    return { ...m, id: res.user_message_id };
                  }
                  return m;
                }));
              } else {
                // Не было промежуточных — добавляем как новое
                setMessages((prev) => {
                  const updated = res.user_message_id
                    ? prev.map(m => m.id === tempUserMsg.id ? { ...m, id: res.user_message_id! } : m)
                    : prev;
                  return [...updated, {
                    id: res.message_id, role: 'assistant' as const,
                    content: res.reply_text || t('chat.generationStopped'),
                    created_at: Math.floor(Date.now() / 1000),
                    reasoning_content: res.reasoning_content ?? null,
                    tool_calls: res.tool_calls ?? null,
                    subagents: res.subagents ?? null,
                    prompt_name: res.prompt_name ?? null,
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
                  prompt_name: res.prompt_name ?? null,
                  model_name: res.model_name ?? null,
                  provider_name: res.provider_name ?? null,
                  usage: res.message_usage ?? null,
                  ...(typeof res.token_count === 'number' ? { token_count: res.token_count } : {}),
                  ...(typeof res.reasoning_tokens === 'number' ? { reasoning_tokens: res.reasoning_tokens } : {})
                };
              }
              // Replace temp user message id with real one from server
              if (res.user_message_id && m.id === tempUserMsg.id) {
                return {
                  ...m,
                  id: res.user_message_id,
                  ...(typeof res.user_token_count === 'number' ? { token_count: res.user_token_count } : {}),
                };
              }
              return m;
            }));
          } else {
            // Ни одного промежуточного сообщения не было — добавляем финальный ответ
            setMessages((prev) => {
              const updated = res.user_message_id
                ? prev.map(m => m.id === tempUserMsg.id ? {
                    ...m,
                    id: res.user_message_id!,
                    ...(typeof res.user_token_count === 'number' ? { token_count: res.user_token_count } : {}),
                  } : m)
                : prev;
              return [...updated, {
                id: res.message_id, role: 'assistant', content: res.reply_text, created_at: Math.floor(Date.now() / 1000),
                reasoning_content: res.reasoning_content ?? null,
                tool_calls: res.tool_calls ?? null,
                images: genImages,
                subagents: res.subagents ?? null,
                prompt_name: res.prompt_name ?? null,
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
          refreshContextTokens(res.chat_id);

          // Auto-speak response when triggered by voice input
          if (isVoice && res.reply_text) {
            ttsSpeak(res.message_id, res.reply_text);
          }
        },
        onError: (err) => {
          console.error('Stream error:', err);
          streamAppenderRef.current.flushNow();
          setStreamingState('done');
          setStreamingMsgId(null);
          if (assistantMsgCreatedRef.current) {
            setMessages((prev) => prev.filter(m => m.id !== tempAssistantId && m.id !== tempUserMsg.id));
          } else {
            setMessages((prev) => prev.filter(m => m.id !== tempUserMsg.id));
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
      isVoice ? { isVoice: true, preferredModel: preferredModel, dice_mode: diceMode } : { preferredModel: preferredModel, dice_mode: diceMode },
      documentsToSend.length > 0 ? documentsToSend : undefined
    );
  }, [input, sending, activeChatId, attachedImages, attachedDocuments, preferredModel, handleIncomingDesktopAction, diceRollEnabled, startDiceRollAnimation, finishDiceRoll, diceStatus, diceMode, applyAvatarState]);

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

  const handleAttachFromModal = useCallback((items: { images: ImageItem[]; documents: DocumentItem[] }) => {
    if (items.images.length > 0) {
      setAttachedImages((prev) => {
        const combined = [...prev, ...items.images];
        if (combined.length > maxImages) {
          const excess = combined.splice(maxImages);
          excess.forEach((img) => URL.revokeObjectURL(img.preview));
        }
        return combined;
      });
    }
    if (items.documents.length > 0) {
      setAttachedDocuments((prev) => [...prev, ...items.documents]);
    }
    setShowAttachModal(false);
  }, [maxImages]);

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

          if (assistantMsgCreatedRef.current) {
            setMessages((prev) => prev.map(m =>
              m.id === tempAssistantId
                ? { ...m, id: res.message_id, ...(res.reply_text ? { content: res.reply_text } : {}), reasoning_content: res.reasoning_content ?? null, tool_calls: res.tool_calls ?? null, ...(genImages ? { images: genImages } : {}), ...(typeof res.token_count === 'number' ? { token_count: res.token_count } : {}), ...(typeof res.reasoning_tokens === 'number' ? { reasoning_tokens: res.reasoning_tokens } : {}) }
                : m
            ));
          } else {
            setMessages((prev) => [...prev, {
              id: res.message_id, role: 'assistant', content: res.reply_text, created_at: Math.floor(Date.now() / 1000),
              reasoning_content: res.reasoning_content ?? null,
              tool_calls: res.tool_calls ?? null,
              images: genImages,
              ...(typeof res.token_count === 'number' ? { token_count: res.token_count } : {}),
              ...(typeof res.reasoning_tokens === 'number' ? { reasoning_tokens: res.reasoning_tokens } : {})
            }]);
          }
          setShowTyping(false);
          setSending(false);
          if (res.display_state) applyAvatarState(res.display_state);
        },
        onError: (err) => {
          console.error('Regenerate error:', err);
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
      { preferredModel: preferredModel, skip_user_history: true, regenerate_from_history: true, dice_mode: diceMode }
    );
  }, [activeChatId, sending, messages, preferredModel, handleIncomingDesktopAction, diceRollEnabled, startDiceRollAnimation, finishDiceRoll, diceMode, applyAvatarState]);

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

          if (assistantMsgCreatedRef.current) {
            setMessages((prev) => prev.map(m =>
              m.id === tempAssistantId
                ? { ...m, id: res.message_id, ...(res.reply_text ? { content: res.reply_text } : {}), reasoning_content: res.reasoning_content ?? null, tool_calls: res.tool_calls ?? null, ...(genImages ? { images: genImages } : {}), ...(typeof res.token_count === 'number' ? { token_count: res.token_count } : {}), ...(typeof res.reasoning_tokens === 'number' ? { reasoning_tokens: res.reasoning_tokens } : {}) }
                : m
            ));
          } else {
            setMessages((prev) => [...prev, {
              id: res.message_id, role: 'assistant', content: res.reply_text, created_at: Math.floor(Date.now() / 1000),
              reasoning_content: res.reasoning_content ?? null,
              tool_calls: res.tool_calls ?? null,
              images: genImages,
              ...(typeof res.token_count === 'number' ? { token_count: res.token_count } : {}),
              ...(typeof res.reasoning_tokens === 'number' ? { reasoning_tokens: res.reasoning_tokens } : {})
            }]);
          }
          setShowTyping(false);
          setSending(false);
          if (res.display_state) applyAvatarState(res.display_state);
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
      { preferredModel: preferredModel, regenerate_hint: hint.trim(), skip_user_history: true, regenerate_from_history: true, dice_mode: diceMode }
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

  useEffect(() => {
    let disposed = false;

    void (async () => {
      try {
        const result = await window.electronAPI.startWakeWord();
        if (!result.ok) {
          console.error('[wakeword] failed to start:', result.error);
          toast.error(t('chat.toasts.wakeWordFailed'));
          return;
        }

        if (!disposed) {
          await startWakeWordAudioStream();
        }
      } catch (error) {
        console.error('[wakeword] failed to start:', error);
        toast.error(t('chat.toasts.wakeWordFailed'));
      }
    })();

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
      disposed = true;
      unsubscribe();
      void stopWakeWordAudioStream();
      void window.electronAPI.stopWakeWord();
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
          <motion.span
            className={s.sidebarTitle}
            animate={{ opacity: sidebarCollapsed ? 0 : 1 }}
            transition={{ duration: 0.15 }}
          >
            {t('chat.sidebar.chats')}
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

        <motion.div
          className={s.sidebarContentBody}
          onScroll={handleSidebarScroll}
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
                      : [{ id: result.chat_id, title: result.chat_title, created_at: result.created_at }, ...prev]);
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
                  )}
                  {getUnread(chat.id) > 0 && (
                    <span className={s.unreadBadge}>{getUnread(chat.id)}</span>
                  )}
                  <button
                    className={s.kebabBtn}
                    onClick={(e) => handleKebabClick(e, chat.id)}
                    title={t('common.actions')}
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
              <div className={s.emptyChats}>{loadingChats ? t('common.loading') : t('chat.sidebar.noChats')}</div>
            )}
            {loadingMoreChats && (
              <div className={s.emptyChats}>{t('common.loading')}</div>
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
              }} title={t('chat.sidebar.unlinkTelegram')}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6L6 18" />
                  <path d="M6 6l12 12" />
                </svg>
              </button>
            ) : (
              <button className={s.iconBtn} onClick={() => setShowLinkModal(true)} title={t('chat.sidebar.linkTelegram')}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent-icon)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
              </button>
            )}
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
                            badge: m.supports_vision ? { text: 'Vision', color: 'success' as const } : undefined,
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
              {!loadingMessages && hiddenMessagesCount > 0 && (
                <button className={s.loadOlderBtn} onClick={showMoreHidden}>
                  {t('chat.messages.showMoreCount', { count: hiddenMessagesCount })}
                  {hiddenTokensSum > 0 ? t('chat.messages.hiddenTokens', { count: Math.round(hiddenTokensSum / 1000) }) : ''}
                </button>
              )}
              {!loadingMessages && hiddenMessagesCount === 0 && hasMoreMessages && (
                <button className={s.loadOlderBtn} onClick={loadOlderMessages} disabled={loadingOlderMessages}>
                  {loadingOlderMessages ? t('common.loading') : t('chat.messages.loadOlderTitle')}
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
                                <button
                                  className={s.messageImageDelete}
                                  onClick={(e) => { e.stopPropagation(); setImageDeleteTarget({ messageId: msg.id, url: img.url }); }}
                                  title={t('common.delete')}
                                >
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="3 6 5 6 21 6" />
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
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
                            {t('chat.confirm.saveSudoPassword')}
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
                          await api.apiFetch('/api/v1/devops/approve', {
                            method: 'POST',
                            body: JSON.stringify(body),
                          });
                          toast.success(t('chat.toasts.commandApproved'));
                          setDevopsConfirmations(prev => prev.filter((_, i) => i !== confIdx));
                        } catch {
                          toast.error(t('chat.toasts.commandApprovalFailed'));
                        }
                      }}
                    >
                      {t('chat.confirm.allow')}
                    </button>
                    <button
                      className={s.suggestMacroSaveBtn}
                      style={{ background: 'var(--bg-modal-hover)', color: 'var(--text-primary)', border: '1px solid var(--border-input)' }}
                      onClick={async () => {
                        try {
                          if (conf.needs_sudo_password && !conf.sudo_password?.trim()) {
                            toast.error(t('chat.toasts.enterSudoPassword'));
                            return;
                          }
                          if (conf.needs_new_password && !conf.new_password?.trim()) {
                            toast.error(t('chat.toasts.enterNewPassword'));
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
                          toast.success(t('chat.toasts.commandAlwaysApproved'));
                          setDevopsConfirmations(prev => prev.filter((_, i) => i !== confIdx));
                        } catch {
                          toast.error(t('chat.toasts.policySaveFailed'));
                        }
                      }}
                    >
                      {t('chat.confirm.alwaysAllow')}
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
                          toast.error(t('chat.toasts.commandReviewFailed'));
                          setDevopsConfirmations(prev => prev.map((c, i) => i === confIdx ? { ...c, _reviewing: false } : c));
                        }
                      }}
                    >
                      {conf._reviewing ? t('chat.confirm.reviewing') : t('chat.confirm.review')}
                    </button>
                    <RejectWithComment
                      className={s.suggestMacroDismissBtn}
                      onReject={async (comment) => {
                        try {
                          await api.apiFetch('/api/v1/devops/approve', {
                            method: 'POST',
                            body: JSON.stringify({ confirmation_id: conf.confirmation_id, approved: false, rejection_comment: comment }),
                          });
                        } catch {}
                        setDevopsConfirmations(prev => prev.filter((_, i) => i !== confIdx));
                      }}
                    />
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
                    <span className={s.suggestMacroTitle}>{t('chat.confirm.pcCommand')}</span>
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
                          toast.success(t('chat.toasts.commandExecuted'));
                          setPcCommandConfirmations(prev => prev.filter((_, i) => i !== confIdx));
                        } catch {
                          toast.error(t('chat.toasts.commandExecutionFailed'));
                        }
                      }}
                    >
                      {t('chat.confirm.allow')}
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
                          toast.success(t('chat.toasts.commandAlwaysApproved'));
                          setPcCommandConfirmations(prev => prev.filter((_, i) => i !== confIdx));
                        } catch {
                          toast.error(t('chat.toasts.policySaveFailed'));
                        }
                      }}
                    >
                      {t('chat.confirm.alwaysAllow')}
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
                          toast.error(t('chat.toasts.commandReviewFailed'));
                          setPcCommandConfirmations(prev => prev.map((c, i) => i === confIdx ? { ...c, _reviewing: false } : c));
                        }
                      }}
                    >
                      {conf._reviewing ? t('chat.confirm.reviewing') : t('chat.confirm.review')}
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
                        setPcCommandConfirmations(prev => prev.filter((_, i) => i !== confIdx));
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
                  {conf.old_content_preview && (
                    <div style={{ fontSize: '12px', marginTop: '6px' }}>
                      <div style={{ color: '#e74c3c', marginBottom: '2px', fontWeight: 600 }}>{t('chat.file.removingLines', { start: conf.start_line, end: conf.end_line })}</div>
                      <div style={{ padding: '8px', background: 'rgba(231, 76, 60, 0.08)', borderRadius: '6px', borderLeft: '3px solid #e74c3c', maxHeight: '150px', overflow: 'auto' }}>
                        <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'inherit' }}>{conf.old_content_preview.slice(0, 1000)}</pre>
                      </div>
                    </div>
                  )}
                  {conf.new_content_preview && (
                    <div style={{ fontSize: '12px', marginTop: '6px' }}>
                      <div style={{ color: '#27ae60', marginBottom: '2px', fontWeight: 600 }}>{t('chat.file.added')}</div>
                      <div style={{ padding: '8px', background: 'rgba(39, 174, 96, 0.08)', borderRadius: '6px', borderLeft: '3px solid #27ae60', maxHeight: '150px', overflow: 'auto' }}>
                        <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'inherit' }}>{conf.new_content_preview.slice(0, 1000)}</pre>
                      </div>
                    </div>
                  )}
                  {!conf.new_content_preview && conf.old_content_preview && (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px', fontStyle: 'italic' }}>
                      {t('chat.file.emptyReplacement')}
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
                          toast.success(t('chat.toasts.linesReplaced'));
                          setEditFileLinesConfirmations(prev => prev.filter((_, i) => i !== confIdx));
                        } catch {
                          toast.error(t('chat.toasts.commandExecutionFailed'));
                        }
                      }}
                    >
                      {t('common.apply')}
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
                        } catch {
                          toast.error(t('chat.toasts.commandsReviewFailed'));
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
                <button className={s.contextMenuItem} onClick={() => handleSendToTelegram(msgMenuId)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                  {t('chat.message.sendTelegram')}
                </button>
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

      {/* RIGHT TOOLS PANEL */}
      <ToolsPanel plan={user?.plan || 'free'} isAdmin={user?.is_admin || 0} activeChatId={activeChatId} onImageClick={(src, msgId, url) => { setViewerImageSrc(src); setViewerImageMsgId(msgId ?? null); setViewerImageUrl(url ?? null); }} onChatSelect={selectChat} />

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

        {showAttachModal && (
          <AttachModal
            key="attach-modal"
            onClose={() => setShowAttachModal(false)}
            onAttach={handleAttachFromModal}
            currentImageCount={attachedImages.length}
            maxImageCount={maxImages}
          />
        )}

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
            {viewerImageMsgId !== null && viewerImageUrl && (
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

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
