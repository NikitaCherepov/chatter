import React, { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api';
import s from './GalleryTool.module.scss';

type Props = {
  chatId: number | null;
  onImageClick?: (src: string) => void;
};

const PAGE_SIZE = 50;

export function GalleryTool({ chatId, onImageClick }: Props) {
  const [media, setMedia] = useState<api.ChatMediaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const loadMedia = useCallback(async (id: number, resetOffset: number = 0) => {
    setLoading(true);
    try {
      const res = await api.getChatMedia(id, PAGE_SIZE, resetOffset);
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
  }, []);

  useEffect(() => {
    if (chatId) {
      loadMedia(chatId, 0);
    } else {
      setMedia([]);
      setHasMore(false);
    }
  }, [chatId, loadMedia]);

  const handleLoadMore = () => {
    if (chatId && !loading && hasMore) {
      loadMedia(chatId, offset);
    }
  };

  if (!chatId) {
    return (
      <div className={s.root}>
        <div className={s.empty}>Выберите чат</div>
      </div>
    );
  }

  return (
    <div className={s.root}>
      {media.length === 0 && !loading ? (
        <div className={s.empty}>Нет изображений</div>
      ) : (
        <div className={s.grid}>
          {media.map((item, i) => {
            const src = api.resolveImageUrl(item.url);
            return (
              <button
                key={`${item.message_id}-${i}`}
                className={s.thumb}
                onClick={() => onImageClick?.(src)}
                title={item.type === 'generated' ? 'Сгенерировано' : 'Фото пользователя'}
              >
                <img src={src} alt="" loading="lazy" />
                {item.type === 'generated' && <span className={s.badge}>AI</span>}
              </button>
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
