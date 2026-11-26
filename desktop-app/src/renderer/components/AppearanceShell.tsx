import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { InteractivePreview } from './InteractivePreview';
import { AppearanceFailureNotice } from './AppearanceFailureNotice';
import type { AppearanceFailureReport, AppearanceFailureTheme } from '../lib/appearance-failure';
import type { InteractiveFailure } from '../../main/interactive-types';
import {
  APPEARANCE_STYLE_EVENT,
  currentAppearance,
  setAppearancePreviewError,
} from '../lib/appearance-runtime';
import { getResolvedTheme, THEME_CHANGE_EVENT } from '../lib/theme';
import type { AppearanceShell as Shell } from '../lib/appearance-schema';
import type {
  AppearanceShellAction,
  AppearanceShellState,
  AppearanceBridgeRequest,
} from '../../main/appearance-shell-types';
import s from './AppearanceShell.module.scss';

function subscribeAppearance(listener: () => void) {
  window.addEventListener(APPEARANCE_STYLE_EVENT, listener);
  return () => window.removeEventListener(APPEARANCE_STYLE_EVENT, listener);
}
export function useCurrentAppearance() {
  return useSyncExternalStore(subscribeAppearance, currentAppearance);
}
function subscribeTheme(listener: () => void) {
  window.addEventListener(THEME_CHANGE_EVENT, listener);
  return () => window.removeEventListener(THEME_CHANGE_EVENT, listener);
}
function sameFiles(a: Record<string, string> | undefined, b: Record<string, string> | undefined) {
  if (a === b) return true;
  const keys = Object.keys(a ?? {});
  return keys.length === Object.keys(b ?? {}).length && keys.every((key) => a?.[key] === b?.[key]);
}
export function useAppearanceShellTheme() {
  return useSyncExternalStore(subscribeTheme, getResolvedTheme);
}

export function AppearanceShell({
  shell,
  state,
  visible,
  onAction,
  onClose,
  onFailure,
  onReadDocument,
  onRequestComplete,
  resolvePendingImage,
  onVisibility,
  onRetry,
  theme,
}: {
  shell: Shell;
  state: AppearanceShellState;
  visible: boolean;
  onAction: (action: AppearanceShellAction) => void;
  onClose: () => void;
  onFailure: (retained?: boolean) => void;
  onReadDocument?: (request: AppearanceBridgeRequest) => Promise<unknown>;
  onRequestComplete?: (request: AppearanceBridgeRequest) => void;
  resolvePendingImage?: (id: string) => string | null;
  onVisibility?: (visible: boolean) => void;
  onRetry?: () => void;
  theme?: AppearanceFailureTheme;
}) {
  const { t } = useTranslation();
  type Slot = {
    key: number;
    shell: Shell;
    project: { entry: string; files: Shell['files']; assets: Shell['assets'] };
    ready: boolean;
    confirmations: boolean;
    theme?: AppearanceFailureTheme;
  };
  const sequence = useRef(0);
  const makeSlot = (value: Shell): Slot => ({
    key: ++sequence.current,
    shell: value,
    project: { entry: value.entry, files: value.files, assets: value.assets },
    ready: false,
    confirmations: false,
    theme,
  });
  type FailureState = { key: number; report: AppearanceFailureReport };
  const [failure, setFailure] = useState<FailureState | null>(null);
  const failureRef = useRef(failure);
  failureRef.current = failure;
  const recordFailure = (value: FailureState | null) => {
    failureRef.current = value;
    setFailure(value);
  };
  const [slots, setSlots] = useState<Slot[]>(() => [makeSlot(shell)]);
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const active = slots.find((slot) => slot.ready) ?? slots[0];
  const activeKey = useRef(active?.key);
  activeKey.current = active?.key;
  const requested = useRef(shell);
  const requestedThemeId = useRef(theme?.id);
  useEffect(() => {
    const previous = requested.current;
    if (
      previous.language === shell.language &&
      requestedThemeId.current === theme?.id &&
      previous.scope === shell.scope &&
      previous.entry === shell.entry &&
      sameFiles(previous.files, shell.files) &&
      sameFiles(previous.assets, shell.assets)
    )
      return;
    requested.current = shell;
    requestedThemeId.current = theme?.id;
    setSlots((previous) => {
      if (previous[previous.length - 1]?.shell === shell && previous[previous.length - 1]?.theme?.id === theme?.id) return previous;
      return [...previous.filter((slot) => slot.ready), makeSlot(shell)];
    });
  }, [shell, theme?.id]);
  const ready = (key: number) => {
    const slot = slotsRef.current.find((item) => item.key === key);
    if (!slot) return;
    if (failureRef.current?.key === key) {
      recordFailure(null);
      setAppearancePreviewError('', 'runtime');
    }
    if (slot.ready) return;
    const next = [{ ...slot, ready: true }];
    slotsRef.current = next;
    activeKey.current = key;
    setSlots(next);
    recordFailure(null);
    setAppearancePreviewError('', 'runtime');
    onAction({ type: 'confirmationPresentation', custom: slot.confirmations });
  };
  const failed = (key: number, info: InteractiveFailure) => {
    const slot = slotsRef.current.find((item) => item.key === key);
    if (!slot) return;
    const retained = slotsRef.current.filter((slot) => slot.ready && slot.key !== key);
    recordFailure({ key, report: { ...info, theme: slot.theme, retained: retained.length > 0 } });
    if (info.recovering) return;
    if (retained.length) {
      slotsRef.current = retained;
      activeKey.current = retained[0].key;
      setSlots(retained);
      setAppearancePreviewError(t('appearance.shellUpdateFailed'), 'runtime');
      onFailure(true);
    } else {
      setAppearancePreviewError(t('appearance.shellFailed'), 'runtime');
      onFailure();
    }
  };
  const retry = () => {
    const next = makeSlot(requested.current),
      failedKey = failureRef.current?.key;
    const retained = slotsRef.current.filter((slot) => slot.ready && slot.key !== failedKey);
    const updated = [...retained, next];
    slotsRef.current = updated;
    activeKey.current = retained[0]?.key ?? next.key;
    setSlots(updated);
    if (failureRef.current)
      recordFailure({
        key: next.key,
        report: {
          ...failureRef.current.report,
          recovering: true,
          at: Date.now(),
          retained: retained.length > 0,
        },
      });
    onRetry?.();
  };
  const notice = failure && (
    <AppearanceFailureNotice
      key={`${failure.key}:${failure.report.at}:${failure.report.recovering}`}
      report={failure.report}
      floating={!visible}
      onRetry={retry}
      onDismiss={() => recordFailure(null)}
    />
  );
  return (
    <>
      <section
        className={s.shell}
        hidden={!visible}
        data-appearance-shell
        aria-label={t('appearance.shellTitle')}
      >
        <header className={s.toolbar}>
          {state.view === 'conversation' ? (
            <button type="button" onClick={() => onAction({ type: 'home' })}>
              {t('appearance.shellHome')}
            </button>
          ) : (
            <span>{t('chatWorkspace.allChats')}</span>
          )}
          <div>
            <button type="button" onClick={() => onAction({ type: 'openLibrary' })}>
              {t('appearance.shellLibrary')}
            </button>
            <button type="button" onClick={() => onAction({ type: 'openSettings' })}>
              {t('settings.title')}
            </button>
            <button type="button" onClick={onClose}>
              {t('appearance.shellNative')}
            </button>
          </div>
        </header>
        {visible && notice}
        {slots.map((slot) => (
          <InteractivePreview
            key={slot.key}
            source=""
            project={slot.project}
            themeId={slot.theme?.id}
            language={slot.shell.language}
            visible={visible && slot.key === active?.key}
            appearance={{
              state,
              onAction: (action) => {
                if (action.type === 'confirmationPresentation') slot.confirmations = action.custom;
                if (activeKey.current === slot.key) onAction(action);
              },
              onClose: () => {
                if (activeKey.current === slot.key) onClose();
              },
              onFailure: (info) => failed(slot.key, info),
              onReady: () => ready(slot.key),
              onReadDocument,
              onRequestComplete,
              resolvePendingImage,
              onVisibility: (value) => {
                if (activeKey.current === slot.key) onVisibility?.(value);
              },
            }}
          />
        ))}
      </section>
      {!visible && notice}
    </>
  );
}
