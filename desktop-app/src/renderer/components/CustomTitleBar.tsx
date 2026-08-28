import { useLayoutEffect } from 'react';
import { THEME_CHANGE_EVENT } from '../lib/theme';
import s from './CustomTitleBar.module.scss';

export function CustomTitleBar() {
  const electronAPI = window.electronAPI;

  useLayoutEffect(() => {
    if (!electronAPI?.setTitleBarOverlay) return;

    const syncColors = () => {
      const rootStyles = getComputedStyle(document.documentElement);
      const color = rootStyles.getPropertyValue('--bg-secondary').trim();
      const symbolColor = rootStyles.getPropertyValue('--text-secondary').trim();

      void electronAPI.setTitleBarOverlay({ color, symbolColor });
    };

    syncColors();
    window.addEventListener(THEME_CHANGE_EVENT, syncColors);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, syncColors);
  }, [electronAPI]);

  if (!electronAPI) return null;

  return (
    <header className={s.titleBar} aria-label="Chatter">
      <div className={s.safeArea}>
        <span className={s.logo} aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 28 28" fill="none">
            <rect width="28" height="28" rx="7" fill="currentColor" />
            <path
              d="M8 14L12 18L20 10"
              stroke="var(--accent-contrast)"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className={s.title}>Chatter</span>
      </div>
    </header>
  );
}
