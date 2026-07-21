import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import enTranslation from './locales/en/translation.json';
import {
  DEFAULT_LANGUAGE,
  getLanguageDisplayName,
  normalizeSupportedLanguage,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from './languages';
import {
  isLanguagePreference,
  SUPPORTED_LANGUAGE_CODES,
  type LanguagePreference,
} from './languages-desktop';

export {
  DEFAULT_LANGUAGE,
  getLanguageDisplayName,
  isLanguagePreference,
  normalizeSupportedLanguage,
  SUPPORTED_LANGUAGE_CODES,
  SUPPORTED_LANGUAGES,
  type LanguagePreference,
  type SupportedLanguage,
};

const LANGUAGE_PREFERENCE_STORAGE_KEY = 'chatter_language_preference';
let detectedSystemLanguage: SupportedLanguage = DEFAULT_LANGUAGE;

/**
 * Default language is statically imported so the initial render always has
 * translations ready.  All other languages are loaded asynchronously —
 * the bundler resolves `import()` paths at build time.
 *
 * Adding a language is one step: append its code to `languages.ts`.
 * The translation JSON is discovered automatically via the dynamic import.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resources: any = {
  [DEFAULT_LANGUAGE]: { translation: enTranslation },
};

async function loadRemainingLocales(): Promise<void> {
  const tasks = SUPPORTED_LANGUAGE_CODES
    .filter((lang) => lang !== DEFAULT_LANGUAGE)
    .map(async (lang) => {
      try {
        const mod = await import(`./locales/${lang}/translation.json`);
        i18n.addResourceBundle(lang, 'translation', (mod as { default?: unknown }).default ?? mod, true, true);
      } catch {
        // Translation file not yet generated — user sees fallbackLng until then.
      }
    });
  await Promise.all(tasks);
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

  detectedSystemLanguage = DEFAULT_LANGUAGE;
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
  const supported = normalizeSupportedLanguage(language) ?? DEFAULT_LANGUAGE;
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
        fallbackLng: DEFAULT_LANGUAGE,
        supportedLngs: SUPPORTED_LANGUAGE_CODES,
        load: 'currentOnly',
        interpolation: {
          escapeValue: false,
        },
      });

    i18n.on('languageChanged', syncDocumentLanguage);
    void loadRemainingLocales();
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
