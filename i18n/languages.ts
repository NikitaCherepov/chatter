/** Single source of truth for languages in the Telegram bot.
 *  Add or remove a code here — i18next and the translation script pick it
 *  up automatically. */
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
  'tr'
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';

const SUPPORTED_LANGUAGE_BY_CODE = new Map<string, SupportedLanguage>(
  SUPPORTED_LANGUAGES.map(language => [language.toLowerCase(), language]),
);

export const normalizeSupportedLanguage = (value: unknown): SupportedLanguage | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  if (!normalized) return null;

  const exact = SUPPORTED_LANGUAGE_BY_CODE.get(normalized);
  if (exact) return exact;

  if (normalized === 'pt' || normalized.startsWith('pt-')) return 'pt-BR';
  if (
    normalized === 'zh'
    || normalized === 'zh-hans'
    || normalized.startsWith('zh-hans-')
    || normalized === 'zh-sg'
    || normalized.startsWith('zh-sg-')
  ) {
    return 'zh-CN';
  }

  return SUPPORTED_LANGUAGE_BY_CODE.get(normalized.split('-')[0]) ?? null;
};
