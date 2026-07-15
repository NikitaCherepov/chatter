import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
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

export const SUPPORTED_LANGUAGE_OPTIONS = [
  { value: 'ru', label: 'Русский' },
  { value: 'en', label: 'English' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'it', label: 'Italiano' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'pl', label: 'Polski' },
  { value: 'pt-BR', label: 'Português (Brasil)' },
  { value: 'zh-CN', label: '简体中文' },
] as const;

export type SupportedLanguage = typeof SUPPORTED_LANGUAGE_OPTIONS[number]['value'];
export type LanguagePreference = 'system' | SupportedLanguage;

const LANGUAGE_PREFERENCE_STORAGE_KEY = 'chatter_language_preference';
const SUPPORTED_LANGUAGE_CODES: SupportedLanguage[] = SUPPORTED_LANGUAGE_OPTIONS.map(({ value }) => value);
const SUPPORTED_LANGUAGES = new Set<SupportedLanguage>(SUPPORTED_LANGUAGE_CODES);
const SUPPORTED_LANGUAGE_BY_NORMALIZED_CODE = new Map<string, SupportedLanguage>(
  SUPPORTED_LANGUAGE_CODES.map((language) => [language.toLowerCase(), language]),
);
let detectedSystemLanguage: SupportedLanguage = 'en';

const resources = {
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
} as const;

export function getLanguageDisplayName(language: SupportedLanguage): string {
  return SUPPORTED_LANGUAGE_OPTIONS.find(({ value }) => value === language)?.label ?? language;
}

export function isLanguagePreference(value: string): value is LanguagePreference {
  return value === 'system' || SUPPORTED_LANGUAGES.has(value as SupportedLanguage);
}

export function getLanguagePreference(): LanguagePreference {
  try {
    const stored = localStorage.getItem(LANGUAGE_PREFERENCE_STORAGE_KEY);
    if (stored && isLanguagePreference(stored)) return stored;
  } catch {
    // Fall back to system language when storage is unavailable.
  }
  return 'system';
}

function normalizeSupportedLanguage(language: string): SupportedLanguage | null {
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

async function getSystemLanguages(): Promise<string[]> {
  try {
    const languages = await window.electronAPI?.getSystemLanguages?.();
    if (Array.isArray(languages) && languages.length > 0) return languages;
  } catch {
    // Fall back to Chromium language preferences outside Electron or on IPC failure.
  }

  if (navigator.languages?.length) return [...navigator.languages];
  return navigator.language ? [navigator.language] : [];
}

async function detectSystemLanguage(): Promise<SupportedLanguage> {
  const systemLanguages = await getSystemLanguages();
  for (const language of systemLanguages) {
    const supported = normalizeSupportedLanguage(language);
    if (supported) {
      detectedSystemLanguage = supported;
      return supported;
    }
  }

  detectedSystemLanguage = 'en';
  return detectedSystemLanguage;
}

export function getDetectedSystemLanguage(): SupportedLanguage {
  return detectedSystemLanguage;
}

async function resolveLanguagePreference(
  preference: LanguagePreference,
): Promise<SupportedLanguage> {
  if (preference !== 'system') return preference;
  return detectSystemLanguage();
}

function syncDocumentLanguage(language: string): void {
  const supported = normalizeSupportedLanguage(language) ?? 'en';
  document.documentElement.lang = supported;
}

export async function initializeI18n() {
  const preference = getLanguagePreference();
  const systemLanguage = await detectSystemLanguage();
  const language = preference === 'system' ? systemLanguage : preference;

  if (!i18n.isInitialized) {
    await i18n
      .use(initReactI18next)
      .init({
        resources,
        lng: language,
        fallbackLng: 'en',
        supportedLngs: SUPPORTED_LANGUAGE_CODES,
        load: 'currentOnly',
        interpolation: {
          escapeValue: false,
        },
      });

    i18n.on('languageChanged', syncDocumentLanguage);
  } else {
    await i18n.changeLanguage(language);
  }

  syncDocumentLanguage(i18n.resolvedLanguage ?? language);
  return i18n;
}

export async function setLanguagePreference(
  preference: LanguagePreference,
): Promise<SupportedLanguage> {
  try {
    localStorage.setItem(LANGUAGE_PREFERENCE_STORAGE_KEY, preference);
  } catch {
    // Apply the preference for the current session even if persistence fails.
  }

  const language = await resolveLanguagePreference(preference);
  await i18n.changeLanguage(language);
  syncDocumentLanguage(i18n.resolvedLanguage ?? language);
  return language;
}

export default i18n;
