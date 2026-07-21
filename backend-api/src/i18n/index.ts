import { createInstance } from 'i18next';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeSupportedLanguage, SUPPORTED_LANGUAGES } from './languages.js';
import enTranslation from './locales/en/translation.json';

export type BackendTranslationValues = Record<string, string | number>;

// English is statically imported so requests never hit an empty bundle.
// Other locales are read from disk synchronously at startup — works both
// under tsx (src/i18n/) and the compiled bundle (dist/i18n/).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resources: any = {
  en: { translation: enTranslation },
};

const localesRoot = path.resolve(__dirname, 'locales');

for (const lang of SUPPORTED_LANGUAGES) {
  if (lang === 'en') continue;
  const file = path.join(localesRoot, lang, 'translation.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    resources[lang] = { translation: JSON.parse(raw) };
  } catch (error) {
    // Most often: translation file not yet generated.  Log so a typo in
    // the path or a malformed JSON does not disappear silently.
    console.warn(`[i18n] Failed to load locale "${lang}": ${(error as Error).message}`);
  }
}

const backendI18n = createInstance();

backendI18n.init({
  resources,
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

/** Localized default chat title ("Chat N"), pulled from the i18n catalog
 *  (key `chat.defaultTitle`) — no hardcoded language map. */
export const formatAutomaticChatTitle = (language: unknown, number: number) =>
  translateForLanguage(language, 'chat.defaultTitle', { number: Math.max(1, Math.floor(number)) });

export default backendI18n;
