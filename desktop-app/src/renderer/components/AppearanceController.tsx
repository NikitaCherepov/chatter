import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../lib/auth';
import { useAppearance } from '../lib/appearance-service';
import { DEFAULT_APPEARANCE } from '../lib/appearance-schema';
import {
  configureAppearance,
  finishAppearancePreview,
  getAppearancePreview,
  previewAppearance,
  subscribeAppearancePreview,
  refreshAppearance,
} from '../lib/appearance-runtime';
import { THEME_CHANGE_EVENT } from '../lib/theme';
import { API_BASE, resolveAuthenticatedAssetUrl } from '../lib/api';
import s from './AppearancePanel.module.scss';
export function AppearanceController() {
  const { user } = useAuth(),
    query = useAppearance(),
    { t } = useTranslation(),
    [error, setError] = useState('');
  const [emergency, setEmergency] = useState(false);
  const resetting = useRef(false);
  const recovery = useRef<HTMLDivElement>(null);
  const state = query.data ?? user?.ui_settings?.appearance ?? DEFAULT_APPEARANCE;
  const preview = useSyncExternalStore(subscribeAppearancePreview, getAppearancePreview);
  useLayoutEffect(() => {
    const element = recovery.current;
    if (!element) return;
    const root = document.documentElement;
    const update = () => root.style.setProperty('--appearance-recovery-space',
      Math.max(0, window.innerHeight - element.getBoundingClientRect().top + 8) + 'px');
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener('resize', update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      root.style.removeProperty('--appearance-recovery-space');
    };
  }, [Boolean(preview), emergency]);
  useLayoutEffect(() => {
    previewAppearance(null);
    setEmergency(false);
    return () => previewAppearance(null);
  }, [user?.id, API_BASE]);
  useLayoutEffect(() => {
    configureAppearance(
      user ? (emergency ? { ...state, activeId: null } : state) : DEFAULT_APPEARANCE,
      resolveAuthenticatedAssetUrl,
    );
  }, [query.data, user?.ui_settings?.appearance, user?.id, emergency]);
  useEffect(() => {
    window.addEventListener(THEME_CHANGE_EVENT, refreshAppearance);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, refreshAppearance);
  }, []);
  useEffect(() => {
    if (!preview) return;
    setError('');
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        previewAppearance(null);
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [preview]);
  const reset = async () => {
    if (!user || resetting.current) return;
    resetting.current = true;
    previewAppearance(null);
    setEmergency(true);
    setError('');
    configureAppearance({ ...state, activeId: null }, resolveAuthenticatedAssetUrl);
    try {
      await query.change({ action: 'activate', id: null, revision: state.revision });
      setEmergency(false);
    } catch {
      setError(t('appearance.failed'));
    } finally {
      resetting.current = false;
    }
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.altKey &&
        event.code === 'Backspace' &&
        !event.repeat
      ) {
        event.preventDefault();
        event.stopPropagation();
        void reset();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [user?.id, state.revision]);
  if (emergency && user)
    return createPortal(
      <div ref={recovery} className={s.recovery} role="region" aria-label={t('appearance.recovery')}>
        <span>{t('appearance.recovery')}</span>
        <button disabled={query.saving} onClick={() => void reset()}>
          {t('appearance.apply')}
        </button>
        <button disabled={query.saving} onClick={() => setEmergency(false)}>
          {t('appearance.restore')}
        </button>
        {error && <small role="alert">{error}</small>}
      </div>,
      document.body,
    );
  if (!preview || !user) return null;
  return createPortal(
    <div ref={recovery} className={s.recovery} role="region" aria-label={t('appearance.preview')}>
      <span>
        {t('appearance.preview')}: <strong>{preview.name}</strong>
      </span>
      <button
        disabled={query.saving}
        onClick={async () => {
          setError('');
          try {
            await query.change({ action: 'save', profile: preview, apply: true });
            finishAppearancePreview(preview);
          } catch {
            setError(t('appearance.failed'));
          }
        }}
      >
        {t('appearance.saveApply')}
      </button>
      <button disabled={query.saving} onClick={() => previewAppearance(null)}>
        {t('appearance.restore')}
      </button>
      {error && <small role="alert">{error}</small>}
    </div>,
    document.body,
  );
}
