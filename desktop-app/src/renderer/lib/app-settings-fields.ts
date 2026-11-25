import { SUPPORTED_LANGUAGES, getDetectedSystemLanguage, getLanguageDisplayName } from '../i18n';
import type { SettingValue, ThemeSettingField } from '../../main/settings-shell-types';
import { ZOOM_MAX_PCT, ZOOM_MIN_PCT, ZOOM_STEP_PCT } from './app-settings';

type Translate = (key: string, options?: Record<string, unknown>) => string;
export const APP_SETTING_KEYS: Record<string, string> = {
  language: 'settings.app.interfaceLanguage', theme: 'settings.app.theme', lightFrom: 'settings.app.themeLightFrom', darkFrom: 'settings.app.themeDarkFrom',
  zoom: 'settings.app.zoom', renderPerf: 'settings.app.layout.history', showTokens: 'settings.app.showTokens', diceRoll: 'settings.app.diceMode',
  themeEffectsEnabled:'themeEffects.enabled',themeEffectIntensity:'themeEffects.intensity',themeSoundEnabled:'themeEffects.soundEnabled',themeMusicEnabled:'themeEffects.musicEnabled',themeSoundVolume:'themeEffects.soundVolume',themeMusicVolume:'themeEffects.musicVolume',
};
export function appSettingsFields(draft: Record<string, SettingValue>, saved: Record<string, SettingValue>, t: Translate): ThemeSettingField[] {
  if (!Object.keys(saved).length) return [];
  const options: Record<string, { value: string; label: string }[]> = {
    language: [{ value: 'system', label: t('settings.language.systemWithLanguage', { language: getLanguageDisplayName(getDetectedSystemLanguage()) }) },
      ...SUPPORTED_LANGUAGES.map(value => ({ value, label: getLanguageDisplayName(value) }))],
    theme: ['system', 'light', 'dark', 'schedule'].map(value => ({ value, label: t('settings.app.theme' + value[0].toUpperCase() + value.slice(1)) })),
    renderPerf: ['low', 'medium', 'high', 'ultra'].map(value => ({ value, label: t('settings.app.renderPerf' + value[0].toUpperCase() + value.slice(1)) })),
  };
  return Object.entries(APP_SETTING_KEYS).map(([id, key]) => {
    const effectNumber=['themeEffectIntensity','themeSoundVolume','themeMusicVolume'].includes(id);
    const type = options[id] ? 'select' : id === 'zoom'||effectNumber ? 'number' : id.endsWith('From') ? 'time' : 'toggle';
    const value = draft[id], numeric = typeof value === 'string' && value.trim() ? Number(value) : value;
    const valid = type === 'select' ? options[id].some(option => option.value === value)
      : type === 'number' ? typeof numeric === 'number' && Number.isFinite(numeric) && (effectNumber?numeric>=0&&numeric<=1:numeric >= ZOOM_MIN_PCT && numeric <= ZOOM_MAX_PCT && (numeric === saved[id] || numeric % ZOOM_STEP_PCT === 0))
      : type === 'time' ? typeof value === 'string' && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value) : typeof value === 'boolean';
    const helpKey = id.endsWith('From') ? 'settings.app.themeScheduleHelp' : id === 'renderPerf' ? 'settings.app.layout.renderHelp'
      : id === 'showTokens' ? 'settings.app.layout.tokensHelp' : id === 'diceRoll' ? 'settings.app.diceHelp' : null;
    return { id, groupId: ['renderPerf', 'showTokens', 'diceRoll'].includes(id) ? 'chat' : 'appearance', type, label: t(key),
      help: helpKey ? t(helpKey) : '', value, savedValue: saved[id], dirty: (type === 'number' && valid ? numeric : value) !== saved[id], error: valid ? null : t('themeSettings.invalid', { field: t(key) }),
      visible: !id.endsWith('From') || draft.theme === 'schedule', ...(options[id] ? { options: options[id] } : {}),
      ...(id === 'zoom' ? { min: ZOOM_MIN_PCT, max: ZOOM_MAX_PCT, step: ZOOM_STEP_PCT } : effectNumber ? {min:0,max:1,step:.05} : {}) };

  });
}
