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
import { normalizeSupportedLanguage, SUPPORTED_LANGUAGES } from './languages.js';

export type BackendTranslationValues = Record<string, string | number>;

const backendI18n = createInstance();

backendI18n.init({
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
    'zh-CN': { translation: zhCnTranslation },
  },
  lng: 'en',
  fallbackLng: 'en',
  supportedLngs: SUPPORTED_LANGUAGES,
  load: 'currentOnly',
  initAsync: false,
  interpolation: {
    escapeValue: false,
  },
});

export const hasBackendTranslation = (key: string) => backendI18n.exists(key, { lng: 'en' });

export const translateForLanguage = (
  language: unknown,
  key: string,
  values: BackendTranslationValues = {},
) => {
  const result = backendI18n.t(key, {
    ...values,
    lng: normalizeSupportedLanguage(language) || 'en',
  });
  return typeof result === 'string' ? result : String(result);
};

export default backendI18n;
