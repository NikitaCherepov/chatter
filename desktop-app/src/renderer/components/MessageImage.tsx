import React, { createContext, useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isMessageImageUrl } from '../lib/remark-message-images';
import { resolveImageUrl } from '../lib/api';
import s from './MarkdownRenderer.module.scss';

export const ImageClickContext = createContext<((src: string) => void) | undefined>(undefined);

// Shared loading/error behaviour for Markdown images and questionnaire illustrations.
export function MarkdownImage({ src, alt, title }: React.ComponentProps<'img'>) {
  const { t } = useTranslation();
  const resolved = src && isMessageImageUrl(src) ? resolveImageUrl(src) : null;
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [resolved]);
  if (!resolved) return <span>{alt}</span>;
  if (failed) return <span className={s.imageError} role="img" aria-label={alt || t('messageImages.loadFailed')}>
    <span aria-hidden="true">▧</span>
    <span>{t('messageImages.loadFailed')}</span>
    {alt && <span>{alt}</span>}
  </span>;
  return <img src={resolved} alt={alt || ''} title={title?.startsWith('layout:') ? undefined : title}
    loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

export function MessageImage({ src, alt, onImageClick }: { src: string; alt: string; onImageClick?: (src: string) => void }) {
  const hostImageClick = useContext(ImageClickContext);
  if (!isMessageImageUrl(src)) return null;
  const open = onImageClick ?? hostImageClick;
  const resolved = resolveImageUrl(src);
  return <a className={s.imageLink} href={resolved} target="_blank" rel="noopener noreferrer" onClick={event => {
    if (!open || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); event.stopPropagation(); open(resolved);
  }}><MarkdownImage src={src} alt={alt} /></a>;
}
