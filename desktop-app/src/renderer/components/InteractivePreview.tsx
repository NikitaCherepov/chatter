import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { InteractiveLanguage, InteractiveStatus } from '../../main/interactive-types';
import s from './InteractivePreview.module.scss';

export function InteractivePreview({ source, language, visible }: { source: string; language: InteractiveLanguage; visible: boolean }) {
  const { t } = useTranslation();
  const slot = useRef<HTMLDivElement>(null);
  const expandedSlot = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const id = useRef<string | null>(null);
  const [seen, setSeen] = useState(false);
  const [run, setRun] = useState(0);
  const [stopped, setStopped] = useState(false);
  const [phase, setPhase] = useState('loading');
  const [expanded, setExpanded] = useState(false);
  const errorLabel = t('interactivePreview.error');
  const available = typeof window.electronAPI?.interactiveCreate === 'function';

  useEffect(() => {
    if (!slot.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setSeen(true);
    });
    observer.observe(slot.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!available || !seen || stopped) return;
    let disposed = false;
    setPhase('loading');
    const api = window.electronAPI;
    const applyStatus = (status: InteractiveStatus) => {
      setPhase(status.phase);
      if (status.escape) setExpanded(false);
    };
    const pendingStatuses = new Map<string, InteractiveStatus>();
    const unsubscribe = api.onInteractiveStatus(status => {
      if (status.id === id.current) applyStatus(status);
      else pendingStatuses.set(status.id, status);
    });
    void api.interactiveCreate({ source, language, dark: document.documentElement.dataset.theme === 'dark', errorLabel })
      .then(created => {
        if (disposed) { void api.interactiveStop(created); return; }
        id.current = created;
        const pending = pendingStatuses.get(created);
        if (pending) applyStatus(pending);
        pendingStatuses.clear();
      }).catch(() => { if (!disposed) setPhase('failed'); });
    return () => {
      disposed = true; unsubscribe();
      if (id.current) { void api.interactiveStop(id.current).catch(() => {}); id.current = null; }
    };
  }, [available, seen, stopped, source, language, errorLabel, run]);

  useEffect(() => {
    if (!expanded || !visible) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setExpanded(false); }
    };
    window.addEventListener('keydown', close, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', close, true);
      expandButton.current?.focus({ preventScroll: true });
    };
  }, [expanded, visible]);

  useEffect(() => {
    if (!available) return;
    let frame = 0, last = '';
    const sync = () => {
      const element = expanded && visible ? expandedSlot.current : slot.current, previewId = id.current;
      if (element && previewId) {
        const rect = element.getBoundingClientRect();
        let left = Math.max(0, rect.left), top = Math.max(40, rect.top);
        let right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
          if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
          if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
        }
        const modal = [...document.querySelectorAll('[aria-modal="true"]')].some(node => node !== overlay.current && (node as HTMLElement).getClientRects().length);
        // Native WebContentsView sits above DOM z-index. Yield its surface while a
        // foreground menu/tooltip overlaps it; never stop/recreate the running UI.
        const covered = [...document.querySelectorAll<HTMLElement>('[data-native-overlay], [role="menu"], [role="listbox"], [role="tooltip"]')].some(layer => {
          if (layer.contains(element) || element.contains(layer) || layer.closest('[aria-hidden="true"]')) return false;
          if (!layer.getClientRects().length) return false;
          // Menus left behind the immersive dialog must not hide its preview.
          if (overlay.current && !overlay.current.contains(layer)) return false;
          const style = getComputedStyle(layer);
          if (style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
          const box = layer.getBoundingClientRect();
          return box.right > left && box.left < right && box.bottom > top && box.top < bottom;
        });
        const placement = { id: previewId,
          expanded: expanded && visible,
          visible: visible && !stopped && phase !== 'failed' && phase !== 'stopped' && !modal && !covered && right > left && bottom > top && element.getClientRects().length > 0,
          bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          clip: { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) } };
        const key = JSON.stringify(placement) + devicePixelRatio;
        if (key !== last) { last = key; void window.electronAPI.interactivePlace(placement).catch(() => {}); }
      }
      frame = requestAnimationFrame(sync);
    };
    frame = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(frame);
  }, [available, visible, stopped, phase, expanded]);

  const status = (!available || phase !== 'ready') && <p role={phase === 'failed' ? 'alert' : undefined}>
    {t(!available ? 'interactivePreview.desktopOnly' : stopped || phase === 'stopped' ? 'interactivePreview.stopped' : phase === 'failed' ? 'interactivePreview.error' : 'interactivePreview.loading')}
  </p>;
  const controls = <>
    <button type="button" onClick={() => { setStopped(false); setRun(value => value + 1); }}>{t('interactivePreview.restart')}</button>
    <button type="button" disabled={stopped} onClick={() => { setStopped(true); setPhase('stopped'); }}>{t('interactivePreview.stop')}</button>
  </>;
  return <>
  <section className={s.preview} hidden={!visible} aria-hidden={expanded && visible ? true : undefined} data-interactive-preview>
    <div className={s.toolbar}>
      <span>{t('interactivePreview.isolated')}</span>
      <div>
        <button ref={expandButton} type="button" onClick={() => setExpanded(true)}>{t('interactivePreview.expand')}</button>
        {controls}
      </div>
    </div>
    <div ref={slot} className={s.slot}>
      {status}
    </div>
  </section>
  {expanded && visible && createPortal(
    <div ref={overlay} className={s.overlay} role="dialog" aria-modal="true" aria-label={t('interactivePreview.title')}
      onMouseDown={event => { if (event.target === event.currentTarget) setExpanded(false); }}>
      <section className={s.dialog}>
        <div className={s.toolbar}>
          <span>{t('interactivePreview.isolated')}</span>
          <div>{controls}<button ref={closeButton} type="button" onClick={() => setExpanded(false)}>{t('interactivePreview.collapse')}</button></div>
        </div>
        <div ref={expandedSlot} className={s.expandedSlot}>{status}</div>
      </section>
    </div>, document.body)}
  </>;
}
