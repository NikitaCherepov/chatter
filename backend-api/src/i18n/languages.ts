const LANGUAGE_CONFIG = {
  ru: { automaticChatTitle: (number: number) => `Чат ${number}` },
  en: { automaticChatTitle: (number: number) => `Chat ${number}` },
  de: { automaticChatTitle: (number: number) => `Chat ${number}` },
  es: { automaticChatTitle: (number: number) => `Chat ${number}` },
  fr: { automaticChatTitle: (number: number) => `Chat ${number}` },
  it: { automaticChatTitle: (number: number) => `Chat ${number}` },
  ja: { automaticChatTitle: (number: number) => `チャット ${number}` },
  ko: { automaticChatTitle: (number: number) => `채팅 ${number}` },
  pl: { automaticChatTitle: (number: number) => `Czat ${number}` },
  'pt-BR': { automaticChatTitle: (number: number) => `Chat ${number}` },
  'zh-CN': { automaticChatTitle: (number: number) => `聊天 ${number}` },
} as const;

export type SupportedLanguage = keyof typeof LANGUAGE_CONFIG;

export const SUPPORTED_LANGUAGES = Object.keys(LANGUAGE_CONFIG) as SupportedLanguage[];

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

export const formatAutomaticChatTitle = (language: unknown, number: number) => {
  const supportedLanguage = normalizeSupportedLanguage(language) || 'en';
  return LANGUAGE_CONFIG[supportedLanguage].automaticChatTitle(Math.max(1, Math.floor(number)));
};
