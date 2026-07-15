import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import enTranslation from './locales/en/translation.json';
import ruTranslation from './locales/ru/translation.json';

export type SupportedLanguage = 'en' | 'ru';
export type LanguagePreference = 'system' | SupportedLanguage;

const LANGUAGE_PREFERENCE_STORAGE_KEY = 'chatter_language_preference';
const SUPPORTED_LANGUAGES = new Set<SupportedLanguage>(['en', 'ru']);
let detectedSystemLanguage: SupportedLanguage = 'en';

const resources = {
  en: { translation: enTranslation },
  ru: { translation: ruTranslation },
} as const;

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
  const baseLanguage = language.trim().toLowerCase().replace('_', '-').split('-')[0];
  return SUPPORTED_LANGUAGES.has(baseLanguage as SupportedLanguage)
    ? baseLanguage as SupportedLanguage
    : null;
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
        supportedLngs: ['en', 'ru'],
        load: 'languageOnly',
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
