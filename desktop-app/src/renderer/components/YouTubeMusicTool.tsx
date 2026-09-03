import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
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

export function YouTubeMusicTool() {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const ownerIdRef = useRef(`youtube-music-tool-${crypto.randomUUID()}`);
  const lastBoundsRef = useRef('');
  const [state, setState] = useState<BrowserState>(EMPTY_STATE);

  useEffect(() => {
    const api = window.electronAPI;
    const unsubscribe = api.onYouTubeMusicState(setState);
    api.youtubeMusicGetState().then(setState).catch(() => {});
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
          void api.youtubeMusicSetVisible({ visible: true, ownerId: ownerIdRef.current, bounds }).catch(console.error);
        }
      }
      frame = requestAnimationFrame(syncBounds);
    };

    frame = requestAnimationFrame(syncBounds);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      lastBoundsRef.current = '';
      void api.youtubeMusicSetVisible({ visible: false, ownerId: ownerIdRef.current }).catch(console.error);
    };
  }, []);

  const run = async (action: 'back' | 'forward' | 'reload' | 'open') => {
    try {
      const next = await window.electronAPI.youtubeMusicControl({
        action,
        ...(action === 'open' ? { url: 'https://music.youtube.com/' } : {}),
      });
      if (next && typeof next === 'object') setState(next);
    } catch (error: any) {
      toast.error(error?.message || t('tools.youtubeMusic.actionFailed'));
    }
  };

  return (
    <div className={s.browser}>
      <div className={s.toolbar}>
        <button type="button" className={s.navButton} disabled={!state.canGoBack} onClick={() => void run('back')} title={t('common.back')}>
          &larr;
        </button>
        <button type="button" className={s.navButton} disabled={!state.canGoForward} onClick={() => void run('forward')} title={t('tools.browser.forward')}>
          &rarr;
        </button>
        <button type="button" className={s.navButton} onClick={() => void run('reload')} title={t('tools.browser.reload')}>
          <span className={state.isLoading ? s.loading : ''}>&#x21bb;</span>
        </button>
        <button type="button" className={s.homeButton} onClick={() => void run('open')} title={t('tools.youtubeMusic.home')}>
          {t('tools.youtubeMusic.title')}
        </button>
      </div>
      <div className={s.pageTitle} title={state.title || state.url}>
        {state.title || t('tools.youtubeMusic.title')}
      </div>
      <div ref={viewportRef} className={s.viewport}>
        <div className={s.placeholder}>{t('tools.youtubeMusic.loading')}</div>
      </div>
    </div>
  );
}
