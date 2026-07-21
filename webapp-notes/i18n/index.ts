"use client";

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import enTranslation from "./locales/en/translation.json";
import {
  DEFAULT_LANGUAGE,
  normalizeSupportedLanguage,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from "./languages";

export { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES, normalizeSupportedLanguage, type SupportedLanguage };

/**
 * Default language is statically imported so the initial render always has
 * translations ready.  All other languages are loaded asynchronously — the
 * bundler resolves `import()` paths at build time.
 *
 * Adding a language is one step: append its code to `languages.ts`.
 * The translation JSON is discovered automatically via the dynamic import.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resources: any = {
  [DEFAULT_LANGUAGE]: { translation: enTranslation },
};

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources,
    lng: DEFAULT_LANGUAGE,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: SUPPORTED_LANGUAGES,
    load: "currentOnly",
    initAsync: false,
    interpolation: { escapeValue: false },
  });
}

// Stream in the remaining locales without blocking the app.
for (const lang of SUPPORTED_LANGUAGES) {
  if (lang === DEFAULT_LANGUAGE) continue;
  void (async () => {
    try {
      const mod = await import(`./locales/${lang}/translation.json`);
      i18n.addResourceBundle(lang, "translation", (mod as { default?: unknown }).default ?? mod, true, true);
    } catch {
      // Translation file not yet generated — user sees fallbackLng until then.
    }
  })();
}

export const setAppLanguage = async (value: unknown): Promise<SupportedLanguage> => {
  const language = normalizeSupportedLanguage(value) || DEFAULT_LANGUAGE;
  await i18n.changeLanguage(language);
  document.documentElement.lang = language;
  return language;
};

export default i18n;
