/**
 * Text-to-Speech service.
 *
 * Architecture:
 *   - TTS models: abstraction layer. Supports:
 *     1. "piper"    — local Piper TTS via Electron IPC → piper.exe → WAV → Web Audio API
 *     2. "builtin"  — Chromium SpeechSynthesis (0 deps)
 *     3. "cartesia" — Cartesia.ai cloud TTS via backend proxy → MP3 → Web Audio API
 *   - Each model has its own list of voices.
 *   - User selection (model + voice + volume) persisted in localStorage.
 *   - Piper + Cartesia playback use ChatterAudioManager for smooth fade-in/fade-out.
 *
 * Single global state — only one utterance plays at a time.
 */

import { audioManager } from './audioManager';
import { generateTts, fetchAudioBuffer } from './api';
import type { MessageAudio } from './api';

type Listener = (playingId: number | null) => void;

// ── TTS Model / Voice types ────────────────────────────────────────────

export interface TtsVoice {
  id: string;
  name: string;
  lang: string;
}

export interface TtsModel {
  id: string;
  name: string;
  voices: TtsVoice[];
}

// ── Config ──────────────────────────────────────────────────────────────

const STORAGE_KEY = 'chatter_tts_settings';

export interface TtsSettings {
  modelId: string;
  voiceId: string;
  volume: number;
  sfxVolume: number;
}

function loadSettings(): TtsSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...{ modelId: 'piper', voiceId: 'ruslan', volume: 0.3, sfxVolume: 0.3 }, ...parsed };
    }
  } catch {}
  return { modelId: 'piper', voiceId: 'ruslan', volume: 0.3, sfxVolume: 0.3 };
}

function saveSettings(s: TtsSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

// ── Model registry ──────────────────────────────────────────────────────

let cachedBuiltinVoices: TtsVoice[] | null = null;

function getBuiltinVoices(): TtsVoice[] {
  if (cachedBuiltinVoices) return cachedBuiltinVoices;
  const sv = speechSynthesis.getVoices();
  cachedBuiltinVoices = sv.map((v) => ({
    id: v.voiceURI,
    name: v.name,
    lang: v.lang,
  }));
  return cachedBuiltinVoices!;
}

// Currently available Piper voices
const PIPER_VOICES: TtsVoice[] = [
  { id: 'ruslan', name: 'Ruslan', lang: 'ru-RU' },
  { id: 'denis', name: 'Denis', lang: 'ru-RU' },
  { id: 'dmitri', name: 'Dmitri', lang: 'ru-RU' },
  { id: 'irina', name: 'Irina', lang: 'ru-RU' },
];

// ── Cartesia cloud voices (fetched dynamically) ─────────────────────────

let cachedCartesiaVoices: TtsVoice[] | null = null;
let cartesiaFetchPromise: Promise<TtsVoice[]> | null = null;

/**
 * Fetch Cartesia voices from backend.
 * Caches result — call again to refresh.
 */
export async function fetchCartesiaVoiceList(language: string = 'ru'): Promise<TtsVoice[]> {
  if (cachedCartesiaVoices) return cachedCartesiaVoices;

  // Deduplicate concurrent calls
  if (cartesiaFetchPromise) return cartesiaFetchPromise;

  cartesiaFetchPromise = (async () => {
    try {
      const { fetchTtsVoices } = await import('./api');
      const { voices } = await fetchTtsVoices(language);
      cachedCartesiaVoices = voices.map(v => ({
        id: v.id,
        name: v.name,
        lang: v.language || 'ru',
      }));
      return cachedCartesiaVoices;
    } catch (err) {
      console.error('[TTS:cartesia] failed to fetch voices:', err);
      return [];
    } finally {
      cartesiaFetchPromise = null;
    }
  })();

  return cartesiaFetchPromise;
}

/** Invalidate Cartesia voice cache (e.g. on language change) */
export function invalidateCartesiaVoices(): void {
  cachedCartesiaVoices = null;
}

export function getTtsModels(): TtsModel[] {
  const builtinVoices = getBuiltinVoices();
  return [
    {
      id: 'piper',
      name: 'Piper (локальный)',
      voices: PIPER_VOICES,
    },
    {
      id: 'builtin',
      name: 'Встроенный (Chromium)',
      voices: builtinVoices.length > 0
        ? builtinVoices
        : [{ id: '__default', name: 'По умолчанию', lang: 'ru-RU' }],
    },
    {
      id: 'cartesia',
      name: 'Cartesia (облачная)',
      voices: cachedCartesiaVoices || [],
    },
  ];
}

export function getVoicesForModel(modelId: string): TtsVoice[] {
  const model = getTtsModels().find((m) => m.id === modelId);
  return model?.voices ?? [];
}

// ── Playback state ──────────────────────────────────────────────────────

let playingId: number | null = null;
/** Generation ticket — incremented on every stop, so stale generation results are discarded. */
let generationTicket = 0;
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

// ── Stop all playback ──────────────────────────────────────────────────

export async function ttsStop(): Promise<void> {
  generationTicket++; // invalidate any in-flight generation
  speechSynthesis.cancel();
  await audioManager.stopWithFade(150);
  playingId = null;
  notify();
}

// ── Piper: generate via IPC and play ───────────────────────────────────

async function piperSpeak(messageId: number, text: string): Promise<void> {
  await audioManager.stopWithFade(150);

  // Capture ticket — if stop() is called during generation, ticket will differ
  const ticket = ++generationTicket;

  playingId = messageId;
  notify();

  const settings = loadSettings();

  try {
    const buffer = await window.electronAPI.ttsGenerate(text, settings.voiceId);

    // Generation was cancelled while we waited for IPC
    if (ticket !== generationTicket) return;

    if (!buffer) {
      if (playingId === messageId) { playingId = null; notify(); }
      return;
    }

    // Electron IPC returns Uint8Array, but decodeAudioData needs ArrayBuffer
    const raw = buffer instanceof ArrayBuffer
      ? buffer
      : new Uint8Array(buffer as unknown as Iterable<number>).buffer as ArrayBuffer;

    // playBuffer awaits until audio physically finishes
    await audioManager.playBuffer(raw, settings.volume);

    // Check ticket again — stop may have been called during playback
    if (ticket === generationTicket && playingId === messageId) {
      playingId = null;
      notify();
    }
  } catch (err) {
    console.error('[TTS:piper] error:', err);
    if (ticket === generationTicket && playingId === messageId) {
      playingId = null;
      notify();
    }
  }
}

// ── Cartesia: generate via backend API and play ────────────────────────

async function cartesiaSpeak(
  messageId: number,
  text: string,
  existingAudio?: MessageAudio | null,
): Promise<void> {
  await audioManager.stopWithFade(150);

  const ticket = ++generationTicket;
  playingId = messageId;
  notify();

  const settings = loadSettings();

  try {
    let audioBuffer: ArrayBuffer;

    if (existingAudio?.url) {
      // Audio already generated — just download and play
      audioBuffer = await fetchAudioBuffer(existingAudio.url);
    } else {
      // Generate new audio via backend
      const result = await generateTts(text, settings.voiceId, 'ru', messageId);
      if (ticket !== generationTicket) return;

      audioBuffer = await fetchAudioBuffer(result.audio_url);
    }

    if (ticket !== generationTicket) return;

    await audioManager.playBuffer(audioBuffer, settings.volume);

    if (ticket === generationTicket && playingId === messageId) {
      playingId = null;
      notify();
    }
  } catch (err) {
    console.error('[TTS:cartesia] error:', err);
    if (ticket === generationTicket && playingId === messageId) {
      playingId = null;
      notify();
    }
  }
}

// ── Core speak ─────────────────────────────────────────────────────────

export function ttsSpeak(messageId: number, rawText: string, audio?: MessageAudio | null): void {
  if (playingId === messageId) {
    ttsStop();
    return;
  }

  const text = cleanText(rawText);
  if (!text) return;

  const settings = loadSettings();

  if (settings.modelId === 'piper') {
    // Piper is async — fire and forget
    piperSpeak(messageId, text);
    return;
  }

  if (settings.modelId === 'cartesia') {
    // Cartesia is async — fire and forget
    cartesiaSpeak(messageId, text, audio);
    return;
  }

  // Builtin (SpeechSynthesis) — synchronous API
  audioManager.abort();
  speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ru-RU';
  utterance.rate = 1.0;
  utterance.pitch = 1.0;

  const voice = pickBuiltinVoice(settings.voiceId);
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

function pickBuiltinVoice(voiceId: string): SpeechSynthesisVoice | null {
  const sv = speechSynthesis.getVoices();
  if (voiceId) {
    const found = sv.find((v) => v.voiceURI === voiceId);
    if (found) return found;
  }
  const ru = sv.find((v) => v.lang.startsWith('ru'));
  return ru ?? null;
}

// ── Preview (for settings) ─────────────────────────────────────────────

let previewPlaying = false;

function stopPreviewPlayback(): void {
  speechSynthesis.cancel();
  audioManager.abort();
  previewPlaying = false;
}

export async function ttsPreview(modelId: string, voiceId: string): Promise<void> {
  stopPreviewPlayback();
  previewPlaying = true;

  const { volume } = loadSettings();

  if (modelId === 'piper') {
    try {
      const text = 'Привет, я Чаттер!';
      const buffer = await window.electronAPI.ttsGenerate(text, voiceId);
      if (!buffer) { previewPlaying = false; return; }

      // Electron IPC returns Uint8Array, but decodeAudioData needs ArrayBuffer
      const raw = buffer instanceof ArrayBuffer
        ? buffer
        : new Uint8Array(buffer as unknown as Iterable<number>).buffer as ArrayBuffer;

      await audioManager.playBuffer(raw, volume);
      previewPlaying = false;
    } catch (err) {
      console.error('[TTS:piper] preview error:', err);
      previewPlaying = false;
    }
    return;
  }

  if (modelId === 'cartesia') {
    try {
      const text = 'Привет, я Чаттер!';
      const result = await generateTts(text, voiceId, 'ru');
      const audioBuffer = await fetchAudioBuffer(result.audio_url);
      await audioManager.playBuffer(audioBuffer, volume);
      previewPlaying = false;
    } catch (err) {
      console.error('[TTS:cartesia] preview error:', err);
      previewPlaying = false;
    }
    return;
  }

  // Builtin
  const voice = pickBuiltinVoice(voiceId);
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
  stopPreviewPlayback();
}

export function ttsIsPreviewPlaying(): boolean {
  return previewPlaying;
}

// ── Sound effects (notification beeps etc.) ──────────────────────────────

function getAudioMimeType(filename: string): string {
  if (/\.wav$/i.test(filename)) return 'audio/wav';
  if (/\.ogg$/i.test(filename)) return 'audio/ogg';
  return 'audio/mpeg';
}

export async function playSfx(filename: string): Promise<void> {
  try {
    const buffer = await window.electronAPI.readSoundFile(filename);
    if (!buffer) {
      console.error('[SFX] sound file not found:', filename);
      return;
    }

    const raw = buffer instanceof ArrayBuffer
      ? buffer
      : new Uint8Array(buffer as unknown as Iterable<number>).buffer as ArrayBuffer;
    const blob = new Blob([raw], { type: getAudioMimeType(filename) });
    const url = URL.createObjectURL(blob);
    const { sfxVolume } = loadSettings();
    const audio = new Audio(url);
    audio.volume = sfxVolume;

    const revoke = () => URL.revokeObjectURL(url);
    audio.addEventListener('ended', revoke, { once: true });
    audio.addEventListener('error', revoke, { once: true });

    await audio.play();
  } catch (err) {
    console.error('[SFX] play error:', err);
  }
}

// ── Settings helpers ───────────────────────────────────────────────────

export function getTtsSettings(): TtsSettings {
  return loadSettings();
}

export function setTtsSettings(s: TtsSettings): void {
  saveSettings(s);
  ttsStop();
}

// ── Init: listen for voiceschanged ─────────────────────────────────────

if (typeof speechSynthesis !== 'undefined' && speechSynthesis.addEventListener) {
  speechSynthesis.addEventListener('voiceschanged', () => {
    cachedBuiltinVoices = null;
  });
}
