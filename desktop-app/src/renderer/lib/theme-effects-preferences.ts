import {
  DEFAULT_THEME_EFFECTS,
  parseThemeEffectsPatch,
  type ThemeEffectsPreferences,
} from '../../main/theme-effects-types';
export const THEME_EFFECTS_CHANGED = 'chatter-theme-effects-changed';
const key = 'chatter_theme_effects';
let cached: ThemeEffectsPreferences | undefined;
export function readThemeEffectsPreferences() {
  if (!cached) {
    let saved: Partial<ThemeEffectsPreferences> | null = null;
    try {
      saved = parseThemeEffectsPatch(JSON.parse(localStorage.getItem(key) || '{}'));
    } catch {}
    cached = { ...DEFAULT_THEME_EFFECTS, ...saved };
  }
  return cached;
}
export function setThemeEffectsPreferences(patch: Partial<ThemeEffectsPreferences>) {
  const checked = parseThemeEffectsPatch(patch);
  if (!checked) throw new Error('invalid_setting_value');
  const next = { ...readThemeEffectsPreferences(), ...checked };
  localStorage.setItem(key, JSON.stringify(next));
  cached = next;
  window.dispatchEvent(new Event(THEME_EFFECTS_CHANGED));
  return next;
}
export const subscribeThemeEffects = (listener: () => void) => {
  window.addEventListener(THEME_EFFECTS_CHANGED, listener);
  const storage = (event: StorageEvent) => {
    if (event.key !== key && event.key !== null) return;
    cached = undefined;
    listener();
  };
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(THEME_EFFECTS_CHANGED, listener);
    window.removeEventListener('storage', storage);
  };
};
