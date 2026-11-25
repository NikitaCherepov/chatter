import * as api from './api';
import { getLanguagePreference, isLanguagePreference, setLanguagePreference } from '../i18n';
import { getThemePreference, getThemeSchedule, setThemePreference, setThemeSchedule } from './theme';
import { getRenderPerfLevel, setRenderPerfLevel } from './renderPerf';
import type { SettingValue } from '../../main/settings-shell-types';
import {THEME_EFFECT_FIELDS} from '../../main/theme-effects-types';
import {readThemeEffectsPreferences,setThemeEffectsPreferences} from './theme-effects-preferences';

export const APP_SETTINGS_CHANGED = 'chatter-app-settings-changed';
export const ZOOM_STEP_PCT = 5, ZOOM_MIN_PCT = 40, ZOOM_MAX_PCT = 200;
export const zoomLevelToPercent = (level: number) => Math.round(Math.pow(1.2, level) * 100);
export const percentToZoomLevel = (percent: number) => Math.log(percent / 100) / Math.log(1.2);
export const clampZoomPct = (percent: number) => Math.min(ZOOM_MAX_PCT, Math.max(ZOOM_MIN_PCT, Math.round(percent / ZOOM_STEP_PCT) * ZOOM_STEP_PCT));
const changed = (detail?: Partial<api.UiSettings>) => window.dispatchEvent(new CustomEvent(APP_SETTINGS_CHANGED, { detail }));

/** The same writes are used by native controls and theme forms; no alternate storage. */
export async function saveAppUiSettings(patch: Partial<Pick<api.UiSettings, 'show_tokens' | 'dice_roll_enabled' | 'browser_confirm_open' | 'browser_confirm_click' | 'browser_confirm_fill' | 'browser_human_typing'>>, current: () => boolean = () => true) {
  const result = await api.setUiSettings(patch);
  if (current()) changed({ show_tokens: result.settings.show_tokens, dice_roll_enabled: result.settings.dice_roll_enabled });
  return result;
}
export async function saveAppLanguage(value: string, current: () => boolean = () => true) {
  if (!isLanguagePreference(value)) throw new Error('invalid_setting_value');
  const previous = getLanguagePreference();
  try {
    const language = await setLanguagePreference(value);
    if (!current()) throw new Error('settings_scope_changed');
    const result = await api.setUserLanguage(language);
    if (current()) changed();
    return result;
  } catch (error) {
    if (current() && getLanguagePreference() === value) await setLanguagePreference(previous).catch(() => {});
    throw error;
  }
}
export async function setAppZoomPercent(percent: number) {
  if (!Number.isFinite(percent)) throw new Error('invalid_setting_value');
  const value = clampZoomPct(percent);
  await window.electronAPI.setZoomLevel(percentToZoomLevel(value)); changed(); return value;
}
export function saveAppLocalSetting(field: string, value: SettingValue) {
  if(Object.prototype.hasOwnProperty.call(THEME_EFFECT_FIELDS,field)){
    setThemeEffectsPreferences({[THEME_EFFECT_FIELDS[field as keyof typeof THEME_EFFECT_FIELDS]]:value});changed();return;
  }
  if (field === 'theme' && (value === 'system' || value === 'light' || value === 'dark' || value === 'schedule')) setThemePreference(value);
  else if (field === 'renderPerf' && (value === 'low' || value === 'medium' || value === 'high' || value === 'ultra')) setRenderPerfLevel(value);
  else if ((field === 'lightFrom' || field === 'darkFrom') && typeof value === 'string' && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value))
    setThemeSchedule({ ...getThemeSchedule(), [field === 'lightFrom' ? 'light' : 'dark']: value });
  else throw new Error('invalid_setting_value');
  changed();
}
export function readLocalAppSettings(): Record<string, SettingValue> {
  const schedule = getThemeSchedule();
  const effects=readThemeEffectsPreferences();
  return { language: getLanguagePreference(), theme: getThemePreference(), lightFrom: schedule.light, darkFrom: schedule.dark, renderPerf: getRenderPerfLevel(),
    ...Object.fromEntries(Object.entries(THEME_EFFECT_FIELDS).map(([field,key])=>[field,effects[key]])) };
}
