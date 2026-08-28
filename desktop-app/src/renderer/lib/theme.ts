export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = Exclude<ThemePreference, 'system'>;

export const THEME_CHANGE_EVENT = 'chatter-theme-change';

const STORAGE_KEY = 'chatter_theme';
const DEFAULT_THEME: ThemePreference = 'system';
const VALID_THEMES: ThemePreference[] = ['system', 'light', 'dark'];

let systemThemeListenerInitialized = false;

export function getThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && VALID_THEMES.includes(stored as ThemePreference)) {
      return stored as ThemePreference;
    }
  } catch {
    // Use the system theme when storage is unavailable.
  }
  return DEFAULT_THEME;
}

export function getResolvedTheme(preference = getThemePreference()): ResolvedTheme {
  if (preference !== 'system') return preference;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(preference: ThemePreference): void {
  const resolvedTheme = getResolvedTheme(preference);
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.style.colorScheme = resolvedTheme;
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: resolvedTheme }));
}

export function setThemePreference(preference: ThemePreference): void {
  if (!VALID_THEMES.includes(preference)) return;
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Apply the theme for this session even if persistence fails.
  }
  applyTheme(preference);
}

export function initializeTheme(): void {
  applyTheme(getThemePreference());
  if (systemThemeListenerInitialized) return;

  systemThemeListenerInitialized = true;
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getThemePreference() === 'system') applyTheme('system');
  });
}
