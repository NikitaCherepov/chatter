import React, { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api';
import s from './GalleryTool.module.scss';

type Props = {
  chatId: number | null;
  onImageClick?: (src: string) => void;
  onChatSelect?: (chatId: number) => void;
};

const PAGE_SIZE = 50;

type GalleryMode = 'current' | 'all';

export function GalleryTool({ chatId, onImageClick, onChatSelect }: Props) {
  const [mode, setMode] = useState<GalleryMode>('current');
  const [media, setMedia] = useState<api.ChatMediaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);

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

  // В режиме "all" — грузим при смене mode на "all", игнорируем смену chatId
  useEffect(() => {
    if (mode !== 'all') return;
    loadMedia(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // В режиме "current" — грузим при смене chatId
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

  const isCurrent = mode === 'current';
  const isAll = mode === 'all';

  // Показываем empty state когда нет чата в режиме "current"
  if (isCurrent && !chatId) {
    return (
      <div className={s.root}>
        <div className={s.modeSwitch}>
          <ModeButton active={isCurrent} onClick={() => setMode('current')}>Этот чат</ModeButton>
          <ModeButton active={isAll} onClick={() => setMode('all')}>Все чаты</ModeButton>
        </div>
        <div className={s.empty}>Выберите чат</div>
      </div>
    );
  }

  return (
    <div className={s.root}>
      <div className={s.modeSwitch}>
        <ModeButton active={isCurrent} onClick={() => setMode('current')}>Этот чат</ModeButton>
        <ModeButton active={isAll} onClick={() => setMode('all')}>Все чаты</ModeButton>
      </div>

      {media.length === 0 && !loading ? (
        <div className={s.empty}>
          {mode === 'all' ? 'Нет изображений' : 'В этом чате нет изображений'}
        </div>
      ) : (
        <div className={s.grid}>
          {media.map((item, i) => {
            const src = api.resolveImageUrl(item.url);
            return (
              <div
                key={`${item.message_id}-${i}`}
                className={s.thumbWrapper}
              >
                <button
                  className={s.thumb}
                  onClick={() => onImageClick?.(src)}
                  title={item.type === 'generated' ? 'Сгенерировано' : 'Фото пользователя'}
                >
                  <img src={src} alt="" loading="lazy" />
                  {item.type === 'generated' && <span className={s.badge}>AI</span>}
                </button>
                {/* В режиме "все чаты" — badge с названием чата и кнопка перехода */}
                {mode === 'all' && item.chat_title && (
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
              </div>
            );
          })}
        </div>
      )}
      {hasMore && (
        <button className={s.loadMore} onClick={handleLoadMore} disabled={loading}>
          {loading ? '...' : 'Загрузить ещё'}
        </button>
      )}
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
