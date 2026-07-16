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
] as const;

export type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];

const LANGUAGE_BY_NORMALIZED_CODE = new Map<string, SupportedLanguage>(
  SUPPORTED_LANGUAGES.map(language => [language.toLowerCase(), language]),
);

export const normalizeSupportedLanguage = (value: unknown): SupportedLanguage | null => {
  if (typeof value !== 'string') return null;

  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  if (!normalized) return null;

  const exactMatch = LANGUAGE_BY_NORMALIZED_CODE.get(normalized);
  if (exactMatch) return exactMatch;

  const baseMatch = LANGUAGE_BY_NORMALIZED_CODE.get(normalized.split('-')[0]);
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
};
