/**
 * Text-to-Speech service using Web Speech API (SpeechSynthesis).
 *
 * Architecture:
 *   - TTS models: abstraction layer. Currently only "builtin" (Chromium SpeechSynthesis).
 *     In the future can add cloud TTS models (e.g. server-side).
 *   - Each model has its own list of voices.
 *   - User selection (model + voice) persisted in localStorage.
 *
 * Single global state — only one utterance plays at a time.
 */

type Listener = (playingId: number | null) => void;

// ── TTS Model / Voice types ────────────────────────────────────────────

export interface TtsVoice {
  /** Unique identifier (for builtin: SpeechSynthesisVoice.voiceURI) */
  id: string;
  /** Human-readable name */
  name: string;
  /** Language tag */
  lang: string;
}

export interface TtsModel {
  /** Unique model id */
  id: string;
  /** Display name */
  name: string;
  /** Available voices for this model */
  voices: TtsVoice[];
}

// ── Config ──────────────────────────────────────────────────────────────

const STORAGE_KEY = 'chatter_tts_settings';

export interface TtsSettings {
  modelId: string;
  voiceId: string;
}

function loadSettings(): TtsSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { modelId: 'builtin', voiceId: '' };
}

function saveSettings(s: TtsSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

// ── Model registry ──────────────────────────────────────────────────────

let cachedVoices: TtsVoice[] | null = null;

function getBuiltinVoices(): TtsVoice[] {
  if (cachedVoices) return cachedVoices;
  const sv = speechSynthesis.getVoices();
  cachedVoices = sv.map((v) => ({
    id: v.voiceURI,
    name: v.name,
    lang: v.lang,
  }));
  return cachedVoices!;
}

/** Call when voiceschanged fires — invalidates cache. */
function invalidateVoiceCache(): void {
  cachedVoices = null;
}

/**
 * Returns available TTS models with their voices.
 * The builtin model's voices come from SpeechSynthesis.getVoices().
 * More models can be added here later.
 */
export function getTtsModels(): TtsModel[] {
  const builtinVoices = getBuiltinVoices();
  return [
    {
      id: 'builtin',
      name: 'Встроенный (Chromium)',
      voices: builtinVoices.length > 0
        ? builtinVoices
        : [{ id: '__default', name: 'По умолчанию', lang: 'ru-RU' }],
    },
  ];
}

/** Get voices for a specific model. */
export function getVoicesForModel(modelId: string): TtsVoice[] {
  const model = getTtsModels().find((m) => m.id === modelId);
  return model?.voices ?? [];
}

// ── Playback state ──────────────────────────────────────────────────────

let playingId: number | null = null;
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach((fn) => fn(playingId));
}

export function ttsSubscribe(fn: Listener): () => void {
  listeners.add(fn);
  fn(playingId);
  return () => { listeners.delete(fn); };
}

export function ttsIsPlaying(): number | null {
  return playingId;
}

// ── Text cleaning ──────────────────────────────────────────────────────

function cleanText(raw: string): string {
  let t = raw;
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/(\*{1,3}|_{1,3})(.*?)\1/g, '$2');
  t = t.replace(/```[\s\S]*?```/g, '');
  t = t.replace(/`([^`]+)`/g, '$1');
  t = t.replace(/^#{1,6}\s+/gm, '');
  t = t.replace(/\n{2,}/g, '. ').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

// ── Core speak / stop ──────────────────────────────────────────────────

function pickVoice(modelId: string, voiceId: string): SpeechSynthesisVoice | null {
  if (modelId !== 'builtin') return null;
  const sv = speechSynthesis.getVoices();
  if (voiceId) {
    const found = sv.find((v) => v.voiceURI === voiceId);
    if (found) return found;
  }
  // Fallback: first Russian voice
  const ru = sv.find((v) => v.lang.startsWith('ru'));
  return ru ?? null;
}

export function ttsSpeak(messageId: number, rawText: string): void {
  if (playingId === messageId) {
    ttsStop();
    return;
  }

  if (playingId !== null) {
    speechSynthesis.cancel();
  }

  const text = cleanText(rawText);
  if (!text) return;

  const settings = loadSettings();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ru-RU';
  utterance.rate = 1.0;
  utterance.pitch = 1.0;

  const voice = pickVoice(settings.modelId, settings.voiceId);
  if (voice) utterance.voice = voice;

  utterance.onend = () => {
    if (playingId === messageId) { playingId = null; notify(); }
  };
  utterance.onerror = (e) => {
    if (e.error !== 'interrupted' && e.error !== 'canceled') {
      console.error('[TTS] Speech error:', e.error);
    }
    if (playingId === messageId) { playingId = null; notify(); }
  };

  playingId = messageId;
  notify();
  speechSynthesis.speak(utterance);
}

export function ttsStop(): void {
  speechSynthesis.cancel();
  playingId = null;
  notify();
}

// ── Preview (for settings) ─────────────────────────────────────────────

let previewPlaying = false;

export function ttsPreview(modelId: string, voiceId: string): void {
  speechSynthesis.cancel();
  previewPlaying = false;

  const voice = pickVoice(modelId, voiceId);
  const isRu = voice?.lang?.startsWith('ru') ?? true;
  const text = isRu ? 'Привет, я Чаттер!' : 'Hello, I am Chatter!';

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = isRu ? 'ru-RU' : 'en-US';
  utterance.rate = 1.0;
  utterance.pitch = 1.0;

  if (voice) utterance.voice = voice;

  utterance.onstart = () => { previewPlaying = true; };
  utterance.onend = () => { previewPlaying = false; };
  utterance.onerror = () => { previewPlaying = false; };

  speechSynthesis.speak(utterance);
}

export function ttsStopPreview(): void {
  speechSynthesis.cancel();
  previewPlaying = false;
}

export function ttsIsPreviewPlaying(): boolean {
  return previewPlaying;
}

// ── Settings helpers ───────────────────────────────────────────────────

export function getTtsSettings(): TtsSettings {
  return loadSettings();
}

export function setTtsSettings(s: TtsSettings): void {
  saveSettings(s);
  // Stop current playback if voice changed
  ttsStop();
}

// ── Init: listen for voiceschanged ─────────────────────────────────────

if (typeof speechSynthesis !== 'undefined' && speechSynthesis.addEventListener) {
  speechSynthesis.addEventListener('voiceschanged', () => {
    invalidateVoiceCache();
  });
}
