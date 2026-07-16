import { createInstance } from 'i18next';
import deTranslation from './locales/de/translation.json';
import enTranslation from './locales/en/translation.json';
import esTranslation from './locales/es/translation.json';
import frTranslation from './locales/fr/translation.json';
import itTranslation from './locales/it/translation.json';
import jaTranslation from './locales/ja/translation.json';
import koTranslation from './locales/ko/translation.json';
import plTranslation from './locales/pl/translation.json';
import ptBrTranslation from './locales/pt-BR/translation.json';
import ruTranslation from './locales/ru/translation.json';
import zhCnTranslation from './locales/zh-CN/translation.json';

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
    'zh-CN'
] as const;

export type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];
export type BotTranslateOptions = Record<string, unknown>;
export type BotTranslate = (key: string, options?: BotTranslateOptions) => string;

export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';

const SUPPORTED_LANGUAGE_BY_CODE = new Map<string, SupportedLanguage>(
    SUPPORTED_LANGUAGES.map(language => [language.toLowerCase(), language])
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

const botI18n = createInstance();

const botI18nReady = botI18n.init({
    resources: {
        de: { translation: deTranslation },
        en: { translation: enTranslation },
        es: { translation: esTranslation },
        fr: { translation: frTranslation },
        it: { translation: itTranslation },
        ja: { translation: jaTranslation },
        ko: { translation: koTranslation },
        pl: { translation: plTranslation },
        'pt-BR': { translation: ptBrTranslation },
        ru: { translation: ruTranslation },
        'zh-CN': { translation: zhCnTranslation }
    },
    lng: DEFAULT_LANGUAGE,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: SUPPORTED_LANGUAGES,
    load: 'currentOnly',
    initAsync: false,
    interpolation: {
        escapeValue: false
    }
});

export const ensureBotI18nReady = () => botI18nReady;

export const translateBot = (
    language: unknown,
    key: string,
    options: BotTranslateOptions = {}
): string => {
    const result = botI18n.t(key, {
        ...options,
        lng: normalizeSupportedLanguage(language) ?? DEFAULT_LANGUAGE
    } as never);
    return typeof result === 'string' ? result : String(result);
};

export const createBotTranslator = (
    getLanguage: () => unknown
): BotTranslate => (key, options) => translateBot(getLanguage(), key, options);

export default botI18n;
