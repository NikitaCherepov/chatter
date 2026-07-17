"use client";

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import deTranslation from "./locales/de/translation.json";
import enTranslation from "./locales/en/translation.json";
import esTranslation from "./locales/es/translation.json";
import frTranslation from "./locales/fr/translation.json";
import itTranslation from "./locales/it/translation.json";
import jaTranslation from "./locales/ja/translation.json";
import koTranslation from "./locales/ko/translation.json";
import plTranslation from "./locales/pl/translation.json";
import ptBrTranslation from "./locales/pt-BR/translation.json";
import ruTranslation from "./locales/ru/translation.json";
import zhCnTranslation from "./locales/zh-CN/translation.json";

export const SUPPORTED_LANGUAGES = [
  "ru", "en", "de", "es", "fr", "it", "ja", "ko", "pl", "pt-BR", "zh-CN",
] as const;

export type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];

const supportedByCode = new Map<string, SupportedLanguage>(
  SUPPORTED_LANGUAGES.map((language) => [language.toLowerCase(), language]),
);

export const normalizeSupportedLanguage = (value: unknown): SupportedLanguage | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return null;
  const exact = supportedByCode.get(normalized);
  if (exact) return exact;
  if (normalized === "pt" || normalized.startsWith("pt-")) return "pt-BR";
  if (normalized === "zh" || normalized === "zh-hans" || normalized.startsWith("zh-hans-") || normalized === "zh-sg") {
    return "zh-CN";
  }
  return supportedByCode.get(normalized.split("-")[0]) || null;
};

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources: {
      de: { translation: deTranslation },
      en: { translation: enTranslation },
      es: { translation: esTranslation },
      fr: { translation: frTranslation },
      it: { translation: itTranslation },
      ja: { translation: jaTranslation },
      ko: { translation: koTranslation },
      pl: { translation: plTranslation },
      "pt-BR": { translation: ptBrTranslation },
      ru: { translation: ruTranslation },
      "zh-CN": { translation: zhCnTranslation },
    },
    lng: "en",
    fallbackLng: "en",
    supportedLngs: SUPPORTED_LANGUAGES,
    load: "currentOnly",
    initAsync: false,
    interpolation: { escapeValue: false },
  });
}

export const setAppLanguage = async (value: unknown): Promise<SupportedLanguage> => {
  const language = normalizeSupportedLanguage(value) || "en";
  await i18n.changeLanguage(language);
  document.documentElement.lang = language;
  return language;
};

export default i18n;
