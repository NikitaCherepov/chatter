import type { SupportedLanguage } from '../i18n';

const STORAGE_KEY = 'chatter_speech_recognition_language';

export type SpeechRecognitionLanguage = 'auto' | SupportedLanguage;

export function getSpeechRecognitionLanguage(): SpeechRecognitionLanguage {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'auto' || /^[a-z]{2,3}(?:-[a-z]{2})?$/i.test(value || '')) {
      return value as SpeechRecognitionLanguage;
    }
  } catch {
    // Use automatic detection when storage is unavailable.
  }
  return 'auto';
}

export function setSpeechRecognitionLanguage(language: SpeechRecognitionLanguage): void {
  localStorage.setItem(STORAGE_KEY, language);
}
