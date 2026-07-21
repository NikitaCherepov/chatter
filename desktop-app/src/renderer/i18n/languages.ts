/**
 * Canonical source of truth for supported languages across all server-side
 * projects in the chatter monorepo (Telegram bot, admin panel, backend API,
 * webapp-notes).  Desktop app keeps its own copy for offline use.
 *
 * ─── HOW THIS FILE IS USED ────────────────────────────────────────────────
 * A sync script (`npm run sync:languages` from the repo root) copies this
 * file verbatim into every project's local i18n folder.  Projects import
 * from their local copy — the bundler/tsc never needs to reach outside of
 * its own root, and tsconfig `rootDir`/`include` stays intact.
 *
 * ─── ADDING A NEW LANGUAGE ────────────────────────────────────────────────
 * 1. Append the language code to SUPPORTED_LANGUAGES below.
 * 2. Run `npm run sync:languages` (or let the prebuild/predev hook do it).
 * 3. Run the relevant `npm run i18n:translate:* -- --to <code>` scripts.
 *
 * ─── IMPORTANT ─────────────────────────────────────────────────────────────
 * Do NOT edit the local copies in <project>/i18n/languages.ts directly —
 * they are regenerated from this file on every sync.  Edit HERE instead.
 */
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
  'tr',
  'cs'
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';

const SUPPORTED_LANGUAGE_BY_CODE = new Map<string, SupportedLanguage>(
  SUPPORTED_LANGUAGES.map((language) => [language.toLowerCase(), language]),
);

export const normalizeSupportedLanguage = (value: unknown): SupportedLanguage | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  if (!normalized) return null;

  const exact = SUPPORTED_LANGUAGE_BY_CODE.get(normalized);
  if (exact) return exact;

  if (normalized === 'pt' || normalized.startsWith('pt-')) return 'pt-BR';
  if (
    normalized === 'zh'
    || normalized === 'zh-hans'
    || normalized.startsWith('zh-hans-')
    || normalized === 'zh-sg'
    || normalized.startsWith('zh-sg-')
  ) {
    return 'zh-CN';
  }

  return SUPPORTED_LANGUAGE_BY_CODE.get(normalized.split('-')[0]) ?? null;
};

/**
 * Native display name for a supported language — i.e. the name of the
 * language written *in that language* ("Русский", "Deutsch", "日本語").
 * Matches the previous hardcoded LANGUAGE_LABELS behaviour and is
 * consistent with the desktop app and Telegram bot.
 *
 * Uses `Intl.DisplayNames` with the language itself as the locale, so the
 * output is independent of the user's current UI language.
 */
export const getLanguageDisplayName = (language: SupportedLanguage): string => {
  try {
    return new Intl.DisplayNames([language], { type: 'language' }).of(language) || language;
  } catch {
    return language;
  }
};
