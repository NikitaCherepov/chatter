import React, { FormEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import s from './BrowserTool.module.scss';

type BrowserState = {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  visible: boolean;
};

const EMPTY_STATE: BrowserState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  visible: false,
};

function getBounds(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}

export function BrowserTool() {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const ownerIdRef = useRef(`browser-tool-${crypto.randomUUID()}`);
  const lastBoundsRef = useRef('');
  const [state, setState] = useState<BrowserState>(EMPTY_STATE);
  const [address, setAddress] = useState('');

  useEffect(() => {
    const api = window.electronAPI;
    const unsubscribe = api.onBrowserState((next) => {
      setState(next);
      if (next.url) setAddress(next.url);
    });
    api.browserGetState().then((next) => {
      setState(next);
      if (next.url) setAddress(next.url);
    }).catch(() => {});
    return unsubscribe;
  }, []);

  useLayoutEffect(() => {
    const api = window.electronAPI;
    let frame = 0;
    let disposed = false;

    const syncBounds = () => {
      if (disposed) return;
      const element = viewportRef.current;
      if (element) {
        const bounds = getBounds(element);
        const key = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}:${window.devicePixelRatio}`;
        if (key !== lastBoundsRef.current) {
          lastBoundsRef.current = key;
          void api.browserSetVisible({ visible: true, ownerId: ownerIdRef.current, bounds }).catch(console.error);
        }
      }
      frame = requestAnimationFrame(syncBounds);
    };

    frame = requestAnimationFrame(syncBounds);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      lastBoundsRef.current = '';
      void api.browserSetVisible({ visible: false, ownerId: ownerIdRef.current }).catch(console.error);
    };
  }, []);

  const run = async (action: 'back' | 'forward' | 'reload') => {
    try {
      const next = await window.electronAPI.browserControl({ action });
      if (next && typeof next === 'object') setState(next);
    } catch (error: any) {
      toast.error(error?.message || t('tools.browser.actionFailed', { defaultValue: 'Browser action failed' }));
    }
  };

  const navigate = async (event: FormEvent) => {
    event.preventDefault();
    const value = address.trim();
    if (!value) return;
    try {
      const next = await window.electronAPI.browserControl({ action: 'open', url: value });
      if (next && typeof next === 'object') setState(next);
    } catch (error: any) {
      toast.error(error?.message || t('tools.browser.navigationFailed', { defaultValue: 'Could not open the page' }));
    }
  };

  return (
    <div className={s.browser}>
      <div className={s.toolbar}>
        <button type="button" className={s.navButton} disabled={!state.canGoBack} onClick={() => void run('back')} title={t('common.back')}>
          &larr;
        </button>
        <button type="button" className={s.navButton} disabled={!state.canGoForward} onClick={() => void run('forward')} title={t('tools.browser.forward', { defaultValue: 'Forward' })}>
          &rarr;
        </button>
        <button type="button" className={s.navButton} onClick={() => void run('reload')} title={t('tools.browser.reload', { defaultValue: 'Reload' })}>
          <span className={state.isLoading ? s.loading : ''}>&#x21bb;</span>
        </button>
        <form className={s.addressForm} onSubmit={navigate}>
          <span className={s.securityIcon} title={t('tools.browser.secureSession', { defaultValue: 'Isolated browser session' })}>&#x1f512;</span>
          <input
            className={s.addressInput}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            placeholder={t('tools.browser.addressPlaceholder', { defaultValue: 'Search or enter an address' })}
            spellCheck={false}
          />
        </form>
      </div>
      <div className={s.pageTitle} title={state.title || state.url}>
        {state.title || state.url || t('tools.browser.title', { defaultValue: 'Browser' })}
      </div>
      <div ref={viewportRef} className={s.viewport}>
        <div className={s.placeholder}>{t('tools.browser.loadingPage', { defaultValue: 'Browser page' })}</div>
      </div>
    </div>
  );
}
