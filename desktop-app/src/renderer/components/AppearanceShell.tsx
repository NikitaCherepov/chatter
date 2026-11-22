import { useMemo, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { InteractivePreview } from './InteractivePreview';
import { APPEARANCE_STYLE_EVENT, currentAppearance } from '../lib/appearance-runtime';
import { getResolvedTheme, THEME_CHANGE_EVENT } from '../lib/theme';
import type { AppearanceShell as Shell } from '../lib/appearance-schema';
import type {
  AppearanceShellAction,
  AppearanceShellState,
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
}: {
  shell: Shell;
  state: AppearanceShellState;
  visible: boolean;
  onAction: (action: AppearanceShellAction) => void;
  onClose: () => void;
  onFailure: () => void;
}) {
  const { t } = useTranslation();
  const project = useMemo(() => shell.files ? { entry: shell.entry, files: shell.files } : undefined,
    [shell.entry, shell.files]);
  return (
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
        ) : <span>{t('chatWorkspace.allChats')}</span>}
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
      <InteractivePreview
        source={shell.source ?? ''}
        project={project}
        language={shell.language}
        visible={visible}
        appearance={{ state, onAction, onClose, onFailure }}
      />
    </section>
  );
}
