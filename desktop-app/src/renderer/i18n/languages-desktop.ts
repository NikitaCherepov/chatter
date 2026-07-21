/** Desktop-specific language helpers.
 *  The core list (SUPPORTED_LANGUAGES, normalizeSupportedLanguage,
 *  getLanguageDisplayName, etc.) lives in languages.ts and is synced
 *  from shared/languages.ts on every predev/prebuild.
 *
 *  This file holds only the extras the desktop app needs on top of the
 *  shared definitions — keeping it separate means sync can safely
 *  overwrite languages.ts without losing desktop-specific types. */

import {
  SUPPORTED_LANGUAGES,
  normalizeSupportedLanguage,
} from './languages';

export type LanguagePreference = 'system' | (typeof SUPPORTED_LANGUAGES)[number];

/** Mutable array copy of SUPPORTED_LANGUAGES — needed by i18next's
 *  `supportedLngs` option which doesn't accept a readonly tuple. */
export const SUPPORTED_LANGUAGE_CODES: string[] = [...SUPPORTED_LANGUAGES];

export function isLanguagePreference(value: string): value is LanguagePreference {
  if (value === 'system') return true;
  return normalizeSupportedLanguage(value) !== null;
}
