export type ThemePreference = 'system' | 'light' | 'dark' | 'schedule';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_CHANGE_EVENT = 'chatter-theme-change';

const STORAGE_KEY = 'chatter_theme';
const DEFAULT_THEME: ThemePreference = 'system';
const VALID_THEMES: ThemePreference[] = ['system', 'light', 'dark', 'schedule'];

const SCHEDULE_KEY = 'chatter_theme_schedule';
const DEFAULT_SCHEDULE = { light: '07:00', dark: '21:00' };
type ThemeSchedule = typeof DEFAULT_SCHEDULE;
const validTime = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
let sessionSchedule: ThemeSchedule | undefined;
let sessionPreference: ThemePreference | undefined;

export function getThemeSchedule(): ThemeSchedule {
  if (sessionSchedule) return sessionSchedule;
  try {
    const saved = JSON.parse(localStorage.getItem(SCHEDULE_KEY) ?? 'null');
    if (validTime(saved?.light) && validTime(saved?.dark)) return saved;
  } catch {
    // Use the default hours when storage is unavailable.
  }
  return DEFAULT_SCHEDULE;
}

export function setThemeSchedule(schedule: ThemeSchedule): void {
  if (!validTime(schedule.light) || !validTime(schedule.dark)) return;
  sessionSchedule = schedule;
  try {
    localStorage.setItem(SCHEDULE_KEY, JSON.stringify(schedule));
    sessionSchedule = undefined;
  } catch {
    // Keep the schedule for this session.
  }
  if (getThemePreference() === 'schedule') applyTheme('schedule');
}

let systemThemeListenerInitialized = false;

export function getThemePreference(): ThemePreference {
  if (sessionPreference) return sessionPreference;
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
  if (preference === 'schedule') {
    const { light, dark } = getThemeSchedule();
    const now = new Date();
    const time = [now.getHours(), now.getMinutes()].map(value => String(value).padStart(2, '0')).join(':');
    const isDark = dark < light ? time >= dark && time < light : time >= dark || time < light;
    return isDark ? 'dark' : 'light';
  }
  if (preference !== 'system') return preference;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(preference: ThemePreference): void {
  const resolvedTheme = getResolvedTheme(preference);
  if (document.documentElement.dataset.theme === resolvedTheme && document.documentElement.style.colorScheme === resolvedTheme) return;
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.style.colorScheme = resolvedTheme;
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: resolvedTheme }));
}

export function setThemePreference(preference: ThemePreference): void {
  if (!VALID_THEMES.includes(preference)) return;
  try {
    localStorage.setItem(STORAGE_KEY, preference);
    sessionPreference = undefined;
  } catch {
    sessionPreference = preference;
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
  const refreshScheduledTheme = () => {
    if (getThemePreference() === 'schedule') applyTheme('schedule');
  };
  window.setInterval(refreshScheduledTheme, 1000);
  window.addEventListener('focus', refreshScheduledTheme);
  document.addEventListener('visibilitychange', refreshScheduledTheme);
}
