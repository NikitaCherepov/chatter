import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { InteractiveLanguage, InteractiveStatus } from '../../main/interactive-types';
import type { AppearanceProject } from '../lib/appearance-project';
import { canReadAppearanceRequest, type AppearanceShellAction, type AppearanceShellState, type AppearanceBridgeRequest } from '../../main/appearance-shell-types';
import s from './InteractivePreview.module.scss';
import { appearanceImageRequestAllowed } from '../lib/appearance-media';
import { resolveImageUrl } from '../lib/api';
import { fileToBase64 } from '../lib/attachment-files';

type AppearanceBridge = {
  state: AppearanceShellState;
  onAction: (action: AppearanceShellAction) => void;
  onClose: () => void;
  onFailure: () => void;
  onReadDocument?: (request: AppearanceBridgeRequest) => Promise<unknown>;
  onRequestComplete?: (request: AppearanceBridgeRequest) => void;
  resolvePendingImage?: (id: string) => string | null;
  onVisibility?:(visible:boolean)=>void;
};

export function InteractivePreview({ source, language, visible, appearance, project }: {
  source: string;
  language: InteractiveLanguage;
  visible: boolean;
  appearance?: AppearanceBridge;
  project?: AppearanceProject;
}) {
  const { t } = useTranslation();
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  const bridge = appearance ? 'appearance-chat-list-v1' as const : undefined;
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
    // Capabilities belong to this running preview. A parent refresh must not
    // discard them while the subscribed theme is still mounted.
    if (bridge) appearanceRef.current?.onAction({ type: 'confirmationPresentation', custom: false });
    const api = window.electronAPI;
    const applyStatus = (status: InteractiveStatus) => {
      if(status.visible!==undefined)appearanceRef.current?.onVisibility?.(status.visible);
      setPhase(status.phase);
      if (status.confirmations !== undefined)
        appearanceRef.current?.onAction({ type: 'confirmationPresentation', custom: status.confirmations });
      if (status.escape) {
        setExpanded(false);
        const shell = appearanceRef.current;
        if (shell?.state.view === 'conversation') shell.onAction({ type: 'home' });
        else {
          if (shell) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
          shell?.onClose();
        }
      }
      if (status.reset) {
        window.dispatchEvent(new KeyboardEvent('keydown', {
          code: 'Backspace', key: 'Backspace', ctrlKey: true, altKey: true,
        }));
        appearanceRef.current?.onClose();
      }
      if (status.phase === 'failed') appearanceRef.current?.onFailure();
    };
    const pendingStatuses = new Map<string, InteractiveStatus>();
    const unsubscribe = api.onInteractiveStatus(status => {
      if (status.id === id.current) applyStatus(status);
      else pendingStatuses.set(status.id, status);
    });
    const unsubscribeActions = bridge ? api.onAppearanceShellAction(event => {
      if (event.id === id.current) appearanceRef.current?.onAction(event.action);
    }) : () => {};
    const unsubscribeImages = bridge ? api.onAppearanceImageRequest(request => {
      if (request.id !== id.current) return;
      void (async () => {
        let url: string | null = null;
        try {
          const state = appearanceRef.current?.state;
          url = state && appearanceImageRequestAllowed(state, request)
            ? request.pendingId ? appearanceRef.current?.resolvePendingImage?.(request.pendingId) ?? null : resolveImageUrl(request.url, request.width || undefined) : null;
          if (url?.startsWith('blob:')) {
            const blob = await (await fetch(url)).blob();
            url = blob.size <= 16 * 1024 * 1024 ? await fileToBase64(blob) : null;
          }
        } catch { url = null; }
        await api.appearanceImageResult(request.id, request.requestId, url).catch(() => {});
      })();
    }) : () => {};
    const unsubscribeDocuments = bridge ? api.onAppearanceDocumentRequest(event => {
      if (event.id !== id.current) return;
      void (async () => {
        let result: unknown, error: string | undefined;
        try {
          const shell = appearanceRef.current;
          if (!shell?.onReadDocument || !canReadAppearanceRequest(shell.state, event.request)) throw new Error(event.request.method === 'settings' ? 'settings_scope_changed' : 'attachment_scope_changed');
          result = await shell.onReadDocument(event.request);
        } catch (reason: any) { error = event.request.method === 'settings'
          ? typeof reason?.message === 'string' && /^[a-z][a-z0-9_]{0,100}$/.test(reason.message) ? reason.message : 'settings_operation_failed'
          : reason?.message?.startsWith('attachment_') ? reason.message : 'attachment_preview_failed'; }
        finally { if (event.request.method === 'settings') event.request.params = {}; }
        await api.appearanceDocumentResult(event.id, event.request.requestId, result, error).catch(() => {});
        appearanceRef.current?.onRequestComplete?.(event.request);
      })();
    }) : () => {};
    void api.interactiveCreate({ source, language, project, dark: document.documentElement.dataset.theme === 'dark', errorLabel, bridge })
      .then(created => {
        if (disposed) { void api.interactiveStop(created); return; }
        id.current = created;
        if (appearanceRef.current)
          void api.appearanceShellState(created, appearanceRef.current.state).catch(() => {});
        const pending = pendingStatuses.get(created);
        if (pending) applyStatus(pending);
        pendingStatuses.clear();
      }).catch(() => {
        if (!disposed) { setPhase('failed'); appearanceRef.current?.onFailure(); }
      });
    return () => {
      disposed = true; unsubscribe(); unsubscribeActions(); unsubscribeImages(); unsubscribeDocuments();
      appearanceRef.current?.onVisibility?.(false);
      if (id.current) { void api.interactiveStop(id.current).catch(() => {}); id.current = null; }
    };
  }, [available, seen, stopped, source, project, language, errorLabel, run, bridge]);

  useEffect(() => {
    if (appearance && id.current)
      void window.electronAPI.appearanceShellState(id.current, appearance.state).catch(() => {});
  }, [appearance?.state, phase]);

  useEffect(() => {
    if (bridge && visible && (phase === 'failed' || phase === 'stopped')) {
      setPhase('loading');
      setRun(value => value + 1);
    }
  }, [bridge, visible]);

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
        const modal = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].some(node => node !== overlay.current
          && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none');
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
          visible: visible && !stopped && phase !== 'failed' && phase !== 'stopped' && !modal && !covered
            && getComputedStyle(element).visibility !== 'hidden'
            && right > left && bottom > top && element.getClientRects().length > 0,
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
  <section className={`${s.preview} ${appearance ? s.embedded : ''}`} hidden={!visible} aria-hidden={expanded && visible ? true : undefined} data-interactive-preview>
    {!appearance && <div className={s.toolbar}>
      <span>{t('interactivePreview.isolated')}</span>
      <div>
        <button ref={expandButton} type="button" onClick={() => setExpanded(true)}>{t('interactivePreview.expand')}</button>
        {controls}
      </div>
    </div>}
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
