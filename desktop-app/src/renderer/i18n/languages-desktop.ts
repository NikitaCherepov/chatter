/** Desktop-specific language helpers.
 *  The core list (SUPPORTED_LANGUAGES, normalizeSupportedLanguage, etc.)
 *  lives in languages.ts and is synced from shared/languages.ts.
 *  This file holds only the extras the desktop app needs. */

import { normalizeSupportedLanguage, SUPPORTED_LANGUAGES } from './languages';

export type LanguagePreference = 'system' | (typeof SUPPORTED_LANGUAGES)[number];

export function isLanguagePreference(value: string): value is LanguagePreference {
  if (value === 'system') return true;
  return normalizeSupportedLanguage(value) !== null;
}
