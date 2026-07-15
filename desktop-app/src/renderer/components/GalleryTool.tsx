import { useTranslation } from 'react-i18next';
import React, { useCallback, useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import * as api from '../lib/api';
import { ConfirmDialog } from './ConfirmDialog';
import s from './GalleryTool.module.scss';

type Props = {
  chatId: number | null;
  onImageClick?: (src: string, messageId?: number, url?: string) => void;
  onChatSelect?: (chatId: number) => void;
};

const PAGE_SIZE = 50;

type GalleryMode = 'current' | 'all';

export function GalleryTool({ chatId, onImageClick, onChatSelect }: Props) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<GalleryMode>('current');
  const [media, setMedia] = useState<api.ChatMediaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<api.ChatMediaItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadMedia = useCallback(async (resetOffset: number = 0) => {
    setLoading(true);
    try {
      const res = mode === 'all'
        ? await api.getAllMedia(PAGE_SIZE, resetOffset)
        : chatId
          ? await api.getChatMedia(chatId, PAGE_SIZE, resetOffset)
          : { media: [] };

      if (resetOffset === 0) {
        setMedia(res.media);
      } else {
        setMedia(prev => [...prev, ...res.media]);
      }
      setHasMore(res.media.length === PAGE_SIZE);
      setOffset(resetOffset + res.media.length);
    } catch (err) {
      console.error('[gallery] Failed to load media:', err);
      setMedia([]);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [mode, chatId]);

  useEffect(() => {
    if (mode !== 'all') return;
    loadMedia(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    if (mode !== 'current') return;
    if (chatId) {
      loadMedia(0);
    } else {
      setMedia([]);
      setHasMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, chatId]);

  const handleLoadMore = () => {
    if (!loading && hasMore) {
      loadMedia(offset);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteMessageImage(deleteTarget.message_id, deleteTarget.url);
      setMedia(prev => prev.filter(m => !(m.message_id === deleteTarget.message_id && m.url === deleteTarget.url)));
      setDeleteTarget(null);
    } catch (err) {
      console.error('[gallery] Failed to delete image:', err);
    } finally {
      setDeleting(false);
    }
  };

  const isCurrent = mode === 'current';
  const isAll = mode === 'all';

  return (
    <div className={s.root}>
      <div className={s.modeSwitch}>
        <ModeButton active={isCurrent} onClick={() => setMode('current')}>{t('tools.gallery.thisChat')}</ModeButton>
        <ModeButton active={isAll} onClick={() => setMode('all')}>{t('tools.gallery.allChats')}</ModeButton>
      </div>

      {isCurrent && !chatId ? (
        <div className={s.empty}>{t('tools.gallery.selectChat')}</div>
      ) : media.length === 0 && !loading ? (
        <div className={s.empty}>
          {isAll ? t('tools.gallery.empty') : t('tools.gallery.emptyChat')}
        </div>
      ) : (
        <div className={s.grid}>
          {media.map((item, i) => {
            const src = api.resolveImageUrl(item.url);
            const key = `${item.message_id}-${i}`;
            return (
              <div key={key} className={s.thumbWrapper}>
                <button
                  className={s.thumb}
                  onClick={() => onImageClick?.(src, item.message_id, item.url)}
                  title={item.type === 'generated' ? t('tools.gallery.generated') : t('tools.gallery.userPhoto')}
                >
                  <img src={src} alt="" loading="lazy" />
                  {item.type === 'generated' && <span className={s.badge}>{t('tools.gallery.ai')}</span>}
                </button>

                {/* В режиме "все чаты" — badge с названием чата и кнопка перехода */}
                {isAll && item.chat_title && (
                  <div className={s.chatBadge}>
                    <span className={s.chatBadgeText} title={item.chat_title}>
                      {item.chat_title}
                    </span>
                    {onChatSelect && item.chat_id && (
                      <button
                        className={s.chatJump}
                        onClick={(e) => {
                          e.stopPropagation();
                          onChatSelect(item.chat_id!);
                        }}
                        title={`Перейти к чату: ${item.chat_title}`}
                      >
                        ↗
                      </button>
                    )}
                  </div>
                )}

                {/* Кнопка удаления */}
                <button
                  className={s.deleteBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteTarget(item);
                  }}
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
      {hasMore && (
        <button className={s.loadMore} onClick={handleLoadMore} disabled={loading}>
          {loading ? '...' : t('tools.gallery.loadMore')}
        </button>
      )}

      <AnimatePresence>
        <ConfirmDialog
          key="confirm-delete-gallery-image"
          open={deleteTarget !== null}
          title={t('chat.deleteImage.title')}
          text={t('chat.deleteImage.message')}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={handleDelete}
          confirmLabel={deleting ? '...' : t('common.delete')}
        />
      </AnimatePresence>
    </div>
  );
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className={`${s.modeBtn} ${active ? s.modeBtnActive : ''}`} onClick={onClick}>
      {children}
    </button>
  );
}
