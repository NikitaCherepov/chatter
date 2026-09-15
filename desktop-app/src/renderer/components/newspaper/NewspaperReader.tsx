import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Select, type SelectOption } from '../Select';
import { ImageViewerModal } from '../ImageViewerModal';
import { saveImageFile } from '../../lib/saveImageFile';
import { TemplateRenderer } from './templates/TemplateRenderer';
import { NewspaperImageViewerProvider } from './NewspaperImageViewerContext';
import type { NewspaperIssue, NewspaperVisualStyle } from './types';
import s from './Newspaper.module.scss';

const ZOOM_MIN = 70;
const ZOOM_MAX = 130;
const ZOOM_STEP = 10;
const zoomKey = (style: NewspaperVisualStyle) => `chatter:newspaper-preview-zoom:${style}`;
const readZoom = (style: NewspaperVisualStyle) => {
  const value = Number(localStorage.getItem(zoomKey(style)) || 100);
  return Number.isFinite(value) ? Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value)) : 100;
};

type Props = {
  issue: NewspaperIssue | null;
  style: NewspaperVisualStyle;
  pageNumber: number;
  pageCount: number;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  onStyleChange: (style: NewspaperVisualStyle) => void;
  previousLabel: string;
  nextLabel: string;
  closeLabel: string;
};

const styleOptions: SelectOption[] = [
  { value: 'wizarding', label: 'Волшебный таблоид', hint: 'Сенсации, пергамент и огромные заголовки' },
  { value: 'broadsheet', label: 'Большая газета', hint: 'Строгая многоколоночная первая полоса' },
  { value: 'deusEx', label: 'Deus Ex', hint: 'Picus: чёрный интерфейс и золото' },
  { value: 'massEffect', label: 'Mass Effect', hint: 'ANN: циан, оранжевый и HUD' },
];

export function NewspaperReader({ issue, style, pageNumber, pageCount, canGoPrevious, canGoNext, onPrevious, onNext, onClose, onStyleChange, previousLabel, nextLabel, closeLabel }: Props) {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(() => readZoom(style));
  const [viewerImage, setViewerImage] = useState<{ src: string; title?: string } | null>(null);

  useEffect(() => setZoom(readZoom(style)), [style]);
  useEffect(() => {
    if (!issue) setViewerImage(null);
  }, [issue]);
  useEffect(() => {
    if (!issue) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        viewerImage ? setViewerImage(null) : onClose();
        return;
      }
      if (event.key === 'ArrowLeft' && canGoPrevious) onPrevious();
      if (event.key === 'ArrowRight' && canGoNext) onNext();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [canGoNext, canGoPrevious, issue, onClose, onNext, onPrevious, viewerImage]);

  const downloadViewerImage = useCallback(async () => {
    if (!viewerImage) return;
    try {
      if (await saveImageFile(viewerImage.src)) toast.success(t('chat.toasts.imageSaved'));
    } catch (error) {
      console.error('Failed to download newspaper image:', error);
      toast.error(t('chat.toasts.imageSaveFailed'));
    }
  }, [t, viewerImage]);

  const applyZoom = (value: number) => {
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(value / ZOOM_STEP) * ZOOM_STEP));
    setZoom(next);
    localStorage.setItem(zoomKey(style), String(next));
  };
  const fitToWindow = () => {
    const viewport = viewportRef.current;
    const page = pageRef.current;
    if (!viewport || !page) return;
    const currentScale = zoom / 100;
    const rect = page.getBoundingClientRect();
    const naturalWidth = rect.width / currentScale;
    const naturalHeight = rect.height / currentScale;
    if (!naturalWidth || !naturalHeight) return;
    const scale = Math.min((viewport.clientWidth - 24) / naturalWidth, (viewport.clientHeight - 18) / naturalHeight);
    applyZoom(Math.floor(scale * 100 / ZOOM_STEP) * ZOOM_STEP);
  };

  return createPortal(<AnimatePresence>{issue && <motion.div key="newspaper-reader" className={s.backdrop} initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} onMouseDown={onClose}><motion.div className={s.dialog} initial={{opacity:0,y:20,scale:.985}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:14,scale:.99}} onMouseDown={event=>event.stopPropagation()} role="dialog" aria-modal="true">
    <header className={s.toolbar}><div className={s.issueMeta}><strong>Выпуск №{issue.issue_number}</strong><span>{pageNumber} / {pageCount}</span></div><div className={s.styleSelect}><Select options={styleOptions} value={style} onChange={value=>onStyleChange(value as NewspaperVisualStyle)} maxVisibleItems={4}/></div><div className={s.toolbarActions}><div className={s.zoomControls}><button type="button" onClick={()=>applyZoom(zoom-ZOOM_STEP)} disabled={zoom<=ZOOM_MIN} aria-label="Уменьшить масштаб">−</button><button type="button" className={s.zoomValue} onClick={fitToWindow} title="Вписать газету в окно">{zoom}%</button><button type="button" onClick={()=>applyZoom(zoom+ZOOM_STEP)} disabled={zoom>=ZOOM_MAX} aria-label="Увеличить масштаб">+</button></div><nav className={s.navigation}><button type="button" onClick={onPrevious} disabled={!canGoPrevious} aria-label={previousLabel}>‹</button><button type="button" onClick={onNext} disabled={!canGoNext} aria-label={nextLabel}>›</button><button type="button" onClick={onClose} aria-label={closeLabel}>×</button></nav></div></header>
    <div className={s.viewport} ref={viewportRef}><motion.div ref={pageRef} className={s.zoomLayer} style={{zoom:zoom/100} as React.CSSProperties} key={`${issue.id}-${style}`} initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} transition={{duration:.18}}><NewspaperImageViewerProvider onOpen={(src, title) => setViewerImage({ src, title })}><TemplateRenderer issue={issue} style={style}/></NewspaperImageViewerProvider></motion.div></div>
  </motion.div></motion.div>}
  {viewerImage && <ImageViewerModal key="newspaper-image-viewer" src={viewerImage.src} alt={viewerImage.title} downloadLabel={t('common.download')} closeLabel={t('common.close')} onClose={() => setViewerImage(null)} onDownload={() => void downloadViewerImage()} aboveNewspaper/>}</AnimatePresence>, document.body);
}
