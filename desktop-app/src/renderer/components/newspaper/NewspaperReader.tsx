import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Select } from '../Select';
import { ImageViewerModal } from '../ImageViewerModal';
import { saveImageFile } from '../../lib/saveImageFile';
import { TemplateRenderer } from './templates/TemplateRenderer';
import { NewspaperImageViewerProvider } from './NewspaperImageViewerContext';
import { NewspaperStyleSelect, type NewspaperStyleOption } from './NewspaperStyleSelect/NewspaperStyleSelect';
import type { NewspaperIssue, NewspaperVisualStyle } from './types';
import s from './Newspaper.module.scss';

const ZOOM_MIN = 100;
const ZOOM_MAX = 150;
const ZOOM_STEP = 10;
const ZOOM_DEFAULT = 100;
const SHOW_READER_CHROME = false;

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

const styleOptions: NewspaperStyleOption[] = [
  { value: 'wizarding', label: 'Волшебный таблоид', hint: 'Сенсации, пергамент и огромные заголовки' },
  { value: 'broadsheet', label: 'Большая газета', hint: 'Строгая многоколоночная первая полоса' },
  { value: 'deusEx', label: 'Deus Ex', hint: 'Picus: чёрный интерфейс и золото' },
  { value: 'massEffect', label: 'Mass Effect', hint: 'ANN: циан, оранжевый и HUD' },
];

export function NewspaperReader({ issue, style, pageNumber, pageCount, canGoPrevious, canGoNext, onPrevious, onNext, onClose, onStyleChange, previousLabel, nextLabel, closeLabel }: Props) {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null);
  const [zoom, setZoom] = useState(ZOOM_DEFAULT);
  const [dragging, setDragging] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [viewerImage, setViewerImage] = useState<{ src: string; title?: string } | null>(null);

  useEffect(() => {
    if (!issue) setViewerImage(null);
  }, [issue]);
  useEffect(() => {
    if (!issue) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (viewerImage) setViewerImage(null);
        else if (controlsOpen) setControlsOpen(false);
        else onClose();
        return;
      }
      if (event.key === 'ArrowLeft' && canGoPrevious) onPrevious();
      if (event.key === 'ArrowRight' && canGoNext) onNext();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [canGoNext, canGoPrevious, controlsOpen, issue, onClose, onNext, onPrevious, viewerImage]);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!issue || !viewport) return;
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setZoom(current => {
        const direction = event.deltaY < 0 ? 1 : -1;
        const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, current + direction * ZOOM_STEP));
        if (next === current) return current;
        const rect = viewport.getBoundingClientRect();
        const pointerX = event.clientX - rect.left;
        const pointerY = event.clientY - rect.top;
        const scale = next / current;
        const nextLeft = (viewport.scrollLeft + pointerX) * scale - pointerX;
        const nextTop = (viewport.scrollTop + pointerY) * scale - pointerY;
        requestAnimationFrame(() => {
          viewport.scrollLeft = nextLeft;
          viewport.scrollTop = nextTop;
        });
        return next;
      });
    };
    viewport.addEventListener('wheel', handleWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', handleWheel);
  }, [issue]);

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
  const startDragging = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('a, button, input, textarea, select, [role="button"], [role="link"], [data-clickable="true"]')) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    };
    viewport.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const moveDragging = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const viewport = viewportRef.current;
    if (!drag || !viewport || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    viewport.scrollLeft = drag.scrollLeft - (event.clientX - drag.x);
    viewport.scrollTop = drag.scrollTop - (event.clientY - drag.y);
  };
  const stopDragging = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const viewport = viewportRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (viewport?.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setDragging(false);
  };

  return createPortal(<AnimatePresence>{issue && <motion.div key="newspaper-reader" className={s.backdrop} initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} onMouseDown={() => controlsOpen ? setControlsOpen(false) : onClose()}><motion.div className={s.dialog} initial={{opacity:0,y:20,scale:.985}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:14,scale:.99}} onMouseDown={event=>{ event.stopPropagation(); if (controlsOpen && !(event.target as HTMLElement).closest('[data-reader-controls]')) setControlsOpen(false); }} role="dialog" aria-modal="true">
    <AnimatePresence initial={false} mode="wait">{!controlsOpen ? <motion.button
      key="reader-handle"
      type="button"
      className={s.readerHandle}
      data-style={style}
      data-reader-controls
      aria-label="Настройки выпуска"
      aria-expanded="false"
      aria-controls="newspaper-reader-controls"
      initial={{ opacity: 0, x: 44 }}
      animate={{ opacity: 1, x: 0 }}
      whileHover={{ x: -8 }}
      exit={{ opacity: 0, x: 52 }}
      transition={{ duration: .18, ease: 'easeOut' }}
      onClick={() => setControlsOpen(true)}
    ><span className={s.readerHandleGlyph}>{style === 'deusEx' ? 'SYS' : style === 'massEffect' ? 'MENU' : style === 'wizarding' ? 'МЕНЮ' : 'EDIT'}</span></motion.button> : <motion.aside
      key="reader-panel"
      id="newspaper-reader-controls"
      className={s.readerPanel}
      data-style={style}
      data-reader-controls
      initial={{ opacity: 0, x: 280 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 280 }}
      transition={{ duration: .24, ease: [0.22, 1, 0.36, 1] }}
    >
      <header className={s.readerPanelHeader}><div><span>ISSUE CONTROL</span><strong>Выпуск №{issue.issue_number}</strong></div><small>{pageNumber} / {pageCount}</small></header>
      <div className={s.readerControlGroup}><span>Стиль</span><NewspaperStyleSelect options={styleOptions} value={style} onChange={onStyleChange}/></div>
      <div className={s.readerControlGroup}><span>Масштаб</span><div className={s.readerZoomRow}><button type="button" onClick={()=>applyZoom(zoom-ZOOM_STEP)} disabled={zoom<=ZOOM_MIN}>−</button><strong>{zoom}%</strong><button type="button" onClick={()=>applyZoom(zoom+ZOOM_STEP)} disabled={zoom>=ZOOM_MAX}>+</button></div></div>
      <div className={s.readerPanelActions}><button type="button" className={s.readerClose} onClick={() => setControlsOpen(false)}>{closeLabel}</button></div>
    </motion.aside>}</AnimatePresence>
    <AnimatePresence initial={false}>
      {canGoPrevious && <motion.button
        key="reader-previous"
        type="button"
        className={`${s.readerPageTab} ${s.readerPageTabPrevious}`}
        data-style={style}
        data-reader-controls
        aria-label={previousLabel}
        initial={{ opacity: 0, x: 46 }}
        animate={{ opacity: 1, x: 0 }}
        whileHover={{ x: -8 }}
        whileTap={{ scale: .96 }}
        exit={{ opacity: 0, x: 46 }}
        transition={{ duration: .18, ease: 'easeOut' }}
        onClick={onPrevious}
      ><span className={s.readerPageTabContent}><b>‹</b><small>{style === 'deusEx' ? 'PREV' : style === 'massEffect' ? 'BACK' : 'Назад'}</small></span></motion.button>}
      {canGoNext && <motion.button
        key="reader-next"
        type="button"
        className={`${s.readerPageTab} ${s.readerPageTabNext}`}
        data-style={style}
        data-reader-controls
        aria-label={nextLabel}
        initial={{ opacity: 0, x: -46 }}
        animate={{ opacity: 1, x: 0 }}
        whileHover={{ x: 8 }}
        whileTap={{ scale: .96 }}
        exit={{ opacity: 0, x: -46 }}
        transition={{ duration: .18, ease: 'easeOut' }}
        onClick={onNext}
      ><span className={s.readerPageTabContent}><b>›</b><small>{style === 'deusEx' ? 'NEXT' : style === 'massEffect' ? 'FWD' : 'Вперёд'}</small></span></motion.button>}
    </AnimatePresence>
    {SHOW_READER_CHROME && <header className={s.toolbar}><div className={s.issueMeta}><strong>Выпуск №{issue.issue_number}</strong><span>{pageNumber} / {pageCount}</span></div><div className={s.styleSelect}><Select options={styleOptions} value={style} onChange={value=>onStyleChange(value as NewspaperVisualStyle)} maxVisibleItems={4}/></div><div className={s.toolbarActions}><div className={s.zoomControls}><button type="button" onClick={()=>applyZoom(zoom-ZOOM_STEP)} disabled={zoom<=ZOOM_MIN} aria-label="Уменьшить масштаб">−</button><button type="button" className={s.zoomValue} onClick={fitToWindow} title="Вписать газету в окно">{zoom}%</button><button type="button" onClick={()=>applyZoom(zoom+ZOOM_STEP)} disabled={zoom>=ZOOM_MAX} aria-label="Увеличить масштаб">+</button></div><nav className={s.navigation}><button type="button" onClick={onPrevious} disabled={!canGoPrevious} aria-label={previousLabel}>‹</button><button type="button" onClick={onNext} disabled={!canGoNext} aria-label={nextLabel}>›</button><button type="button" onClick={onClose} aria-label={closeLabel}>×</button></nav></div></header>}
    <div className={`${s.viewport} ${dragging ? s.viewportDragging : ''}`} data-style={style} ref={viewportRef} onPointerDown={startDragging} onPointerMove={moveDragging} onPointerUp={stopDragging} onPointerCancel={stopDragging} onDragStart={event=>event.preventDefault()}><motion.div ref={pageRef} className={s.zoomLayer} style={{zoom:zoom/100} as React.CSSProperties} key={`${issue.id}-${style}`} initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} transition={{duration:.18}}><NewspaperImageViewerProvider onOpen={(src, title) => setViewerImage({ src, title })}><TemplateRenderer issue={issue} style={style}/></NewspaperImageViewerProvider></motion.div></div>
  </motion.div></motion.div>}
  {viewerImage && <ImageViewerModal key="newspaper-image-viewer" src={viewerImage.src} alt={viewerImage.title} downloadLabel={t('common.download')} closeLabel={t('common.close')} onClose={() => setViewerImage(null)} onDownload={() => void downloadViewerImage()} aboveNewspaper/>}</AnimatePresence>, document.body);
}
