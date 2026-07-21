import { createInstance } from 'i18next';
import fs from 'node:fs';
import path from 'node:path';
import enTranslation from './locales/en/translation.json';
import {
  DEFAULT_LANGUAGE,
  normalizeSupportedLanguage,
  SUPPORTED_LANGUAGES,
} from './languages';

export { DEFAULT_LANGUAGE, normalizeSupportedLanguage, SUPPORTED_LANGUAGES };
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
export type BotTranslateOptions = Record<string, unknown>;
export type BotTranslate = (key: string, options?: BotTranslateOptions) => string;

// English is statically imported so the bot always has a working bundle.
// Other locales are read from disk synchronously at startup — works both
// under tsx (src) and the compiled bundle (dist), where tsc does NOT copy
// .json files next to .js.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resources: any = {
  en: { translation: enTranslation },
};

const localesRoot = path.resolve(__dirname, 'locales');

for (const lang of SUPPORTED_LANGUAGES) {
  if (lang === DEFAULT_LANGUAGE) continue;
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

const botI18n = createInstance();

const botI18nReady = botI18n.init({
  resources,
  lng: DEFAULT_LANGUAGE,
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: SUPPORTED_LANGUAGES,
  load: 'currentOnly',
  initAsync: false,
  interpolation: {
    escapeValue: false,
  },
});

export const ensureBotI18nReady = () => botI18nReady;

export const translateBot = (
  language: unknown,
  key: string,
  options: BotTranslateOptions = {},
): string => {
  const result = botI18n.t(key, {
    ...options,
    lng: normalizeSupportedLanguage(language) ?? DEFAULT_LANGUAGE,
  } as never);
  return typeof result === 'string' ? result : String(result);
};

export const createBotTranslator = (
  getLanguage: () => unknown,
): BotTranslate => (key, options) => translateBot(getLanguage(), key, options);

export default botI18n;
