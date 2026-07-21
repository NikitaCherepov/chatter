/** Single source of truth for languages in the desktop app.
 *  Add or remove a code here — the i18next config, language selector,
 *  speech recognition, and the translation script pick it up automatically.
 *  Display names are generated via Intl.DisplayNames (Chromium in Electron). */
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
export type LanguagePreference = 'system' | SupportedLanguage;

export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';

const SUPPORTED_LANGUAGE_CODES: SupportedLanguage[] = [...SUPPORTED_LANGUAGES];
export { SUPPORTED_LANGUAGE_CODES };

const SUPPORTED_LANGUAGE_BY_NORMALIZED_CODE = new Map<string, SupportedLanguage>(
  SUPPORTED_LANGUAGES.map((language) => [language.toLowerCase(), language]),
);

export function normalizeSupportedLanguage(language: string): SupportedLanguage | null {
  const normalized = language.trim().toLowerCase().replace(/_/g, '-');
  const exactMatch = SUPPORTED_LANGUAGE_BY_NORMALIZED_CODE.get(normalized);
  if (exactMatch) return exactMatch;

  const baseLanguage = normalized.split('-')[0];
  const baseMatch = SUPPORTED_LANGUAGE_BY_NORMALIZED_CODE.get(baseLanguage);
  if (baseMatch) return baseMatch;

  if (normalized === 'pt') return 'pt-BR';
  if (
    normalized === 'zh'
    || normalized === 'zh-hans'
    || normalized.startsWith('zh-hans-')
    || normalized === 'zh-sg'
    || normalized.startsWith('zh-sg-')
  ) {
    return 'zh-CN';
  }

  return null;
}

export function getLanguageDisplayName(language: SupportedLanguage): string {
  try {
    return new Intl.DisplayNames([language], { type: 'language' }).of(language) || language;
  } catch {
    return language;
  }
}

const SUPPORTED_LANGUAGE_SET = new Set<SupportedLanguage>(SUPPORTED_LANGUAGE_CODES);

export function isLanguagePreference(value: string): value is LanguagePreference {
  return value === 'system' || SUPPORTED_LANGUAGE_SET.has(value as SupportedLanguage);
}
