import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Select, type SelectOption } from '../Select';
import { TemplateRenderer } from './templates/TemplateRenderer';
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
  { value: 'editorial', label: 'Редакционная', hint: 'Спокойная современная газета' },
  { value: 'broadsheet', label: 'Большая газета', hint: 'Строгая многоколоночная первая полоса' },
  { value: 'deusEx', label: 'Deus Ex', hint: 'Picus: чёрный интерфейс и золото' },
  { value: 'massEffect', label: 'Mass Effect', hint: 'ANN: циан, оранжевый и HUD' },
];

export function NewspaperReader({ issue, style, pageNumber, pageCount, canGoPrevious, canGoNext, onPrevious, onNext, onClose, onStyleChange, previousLabel, nextLabel, closeLabel }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(() => readZoom(style));

  useEffect(() => setZoom(readZoom(style)), [style]);
  useEffect(() => {
    if (!issue) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft' && canGoPrevious) onPrevious();
      if (event.key === 'ArrowRight' && canGoNext) onNext();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [canGoNext, canGoPrevious, issue, onClose, onNext, onPrevious]);

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

  return createPortal(<AnimatePresence>{issue && <motion.div className={s.backdrop} initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} onMouseDown={onClose}><motion.div className={s.dialog} initial={{opacity:0,y:20,scale:.985}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:14,scale:.99}} onMouseDown={event=>event.stopPropagation()} role="dialog" aria-modal="true">
    <header className={s.toolbar}><div className={s.issueMeta}><strong>Выпуск №{issue.issue_number}</strong><span>{pageNumber} / {pageCount}</span></div><div className={s.styleSelect}><Select options={styleOptions} value={style} onChange={value=>onStyleChange(value as NewspaperVisualStyle)} maxVisibleItems={5}/></div><div className={s.toolbarActions}><div className={s.zoomControls}><button type="button" onClick={()=>applyZoom(zoom-ZOOM_STEP)} disabled={zoom<=ZOOM_MIN} aria-label="Уменьшить масштаб">−</button><button type="button" className={s.zoomValue} onClick={fitToWindow} title="Вписать газету в окно">{zoom}%</button><button type="button" onClick={()=>applyZoom(zoom+ZOOM_STEP)} disabled={zoom>=ZOOM_MAX} aria-label="Увеличить масштаб">+</button></div><nav className={s.navigation}><button type="button" onClick={onPrevious} disabled={!canGoPrevious} aria-label={previousLabel}>‹</button><button type="button" onClick={onNext} disabled={!canGoNext} aria-label={nextLabel}>›</button><button type="button" onClick={onClose} aria-label={closeLabel}>×</button></nav></div></header>
    <div className={s.viewport} ref={viewportRef}><motion.div ref={pageRef} className={s.zoomLayer} style={{zoom:zoom/100} as React.CSSProperties} key={`${issue.id}-${style}`} initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} transition={{duration:.18}}><TemplateRenderer issue={issue} style={style}/></motion.div></div>
  </motion.div></motion.div>}</AnimatePresence>, document.body);
}
