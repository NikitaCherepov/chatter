import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { InteractiveLanguage } from '../../main/interactive-types';
import s from './InteractivePreview.module.scss';

export function InteractivePreview({ source, language, visible }: { source: string; language: InteractiveLanguage; visible: boolean }) {
  const { t } = useTranslation();
  const slot = useRef<HTMLDivElement>(null);
  const id = useRef<string | null>(null);
  const [seen, setSeen] = useState(false);
  const [run, setRun] = useState(0);
  const [stopped, setStopped] = useState(false);
  const [phase, setPhase] = useState('loading');
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
    const pendingStatuses = new Map<string, string>();
    const unsubscribe = api.onInteractiveStatus(status => {
      if (status.id === id.current) setPhase(status.phase);
      else pendingStatuses.set(status.id, status.phase);
    });
    void api.interactiveCreate({ source, language, dark: document.documentElement.dataset.theme === 'dark', errorLabel })
      .then(created => {
        if (disposed) { void api.interactiveStop(created); return; }
        id.current = created;
        const pending = pendingStatuses.get(created);
        if (pending) setPhase(pending);
        pendingStatuses.clear();
      }).catch(() => { if (!disposed) setPhase('failed'); });
    return () => {
      disposed = true; unsubscribe();
      if (id.current) { void api.interactiveStop(id.current).catch(() => {}); id.current = null; }
    };
  }, [available, seen, stopped, source, language, errorLabel, run]);

  useEffect(() => {
    if (!available) return;
    let frame = 0, last = '';
    const sync = () => {
      const element = slot.current, previewId = id.current;
      if (element && previewId) {
        const rect = element.getBoundingClientRect();
        let left = Math.max(0, rect.left), top = Math.max(40, rect.top);
        let right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
          if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
          if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
        }
        const modal = [...document.querySelectorAll('[aria-modal="true"]')].some(node => (node as HTMLElement).getClientRects().length);
        const placement = { id: previewId,
          visible: visible && !stopped && phase !== 'failed' && phase !== 'stopped' && !modal && right > left && bottom > top && element.getClientRects().length > 0,
          bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          clip: { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) } };
        const key = JSON.stringify(placement) + devicePixelRatio;
        if (key !== last) { last = key; void window.electronAPI.interactivePlace(placement).catch(() => {}); }
      }
      frame = requestAnimationFrame(sync);
    };
    frame = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(frame);
  }, [available, visible, stopped, phase]);

  return <section className={s.preview} hidden={!visible} data-interactive-preview>
    <div className={s.toolbar}>
      <span>{t('interactivePreview.isolated')}</span>
      <div>
        <button type="button" onClick={() => { setStopped(false); setRun(value => value + 1); }}>{t('interactivePreview.restart')}</button>
        <button type="button" disabled={stopped} onClick={() => { setStopped(true); setPhase('stopped'); }}>{t('interactivePreview.stop')}</button>
      </div>
    </div>
    <div ref={slot} className={s.slot}>
      {(!available || phase !== 'ready') && <p role={phase === 'failed' ? 'alert' : undefined}>
        {t(!available ? 'interactivePreview.desktopOnly' : stopped || phase === 'stopped' ? 'interactivePreview.stopped' : phase === 'failed' ? 'interactivePreview.error' : 'interactivePreview.loading')}
      </p>}
    </div>
  </section>;
}
