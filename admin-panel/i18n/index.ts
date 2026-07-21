import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE, getLanguageDisplayName } from './languages';
import enTranslation from './locales/en/translation.json';

export { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE, getLanguageDisplayName };

/**
 * Default language is statically imported so the initial render always has
 * translations ready.  All other languages are loaded asynchronously from
 * the filesystem — the bundler resolves `import()` paths at build time.
 *
 * Adding a language is one step: append its code to `languages.ts`.
 * The translation JSON is discovered automatically via the dynamic import.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resources: any = {
  [DEFAULT_LANGUAGE]: { translation: enTranslation },
};

const i18n = createInstance();

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: SUPPORTED_LANGUAGES,
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
    },
    load: 'currentOnly',
    initAsync: false,
    interpolation: {
      escapeValue: false,
    },
  });

// Stream in the remaining locales without blocking the app.
for (const lang of SUPPORTED_LANGUAGES) {
  if (lang === DEFAULT_LANGUAGE) continue;
  void (async () => {
    try {
      const mod = await import(`./locales/${lang}/translation.json`);
      i18n.addResourceBundle(lang, 'translation', mod.default ?? mod, true, true);
    } catch {
      // Translation file not yet generated — user sees fallbackLng until then.
    }
  })();
}

export default i18n;
