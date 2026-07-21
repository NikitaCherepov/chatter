/** Single source of truth for languages in the admin panel.
 *  Add or remove an entry here — the selector, detector, i18next config,
 *  and translation script pick it up automatically. */
export const SUPPORTED_LANGUAGES = [
  'ru',
  'en',
  'de',
  'es',
  'fr',
  'it',
  'ja',
  'ko',
  'pl',
  'pt-BR',
  'zh-CN',
  'tr',
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';

/** Native display name for every supported language — used directly by
 *  selectors so a new language appears with its proper label immediately,
 *  without waiting for translation dictionary updates. */
export const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  ru: 'Русский',
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
  it: 'Italiano',
  ja: '日本語',
  ko: '한국어',
  pl: 'Polski',
  'pt-BR': 'Português (Brasil)',
  'zh-CN': '中文（简体）',
  tr: 'Türkçe',
};
