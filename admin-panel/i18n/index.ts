import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
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
  'zh-CN',
] as const;

const i18n = createInstance();

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
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
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGUAGES,
    detection: {
      order: ['navigator'],
      caches: [],
    },
    load: 'currentOnly',
    initAsync: false,
    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;
