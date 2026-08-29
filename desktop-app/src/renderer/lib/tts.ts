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
import i18n from '../i18n';
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

let cachedPiperVoices: TtsVoice[] | null = null;
let piperFetchPromise: Promise<TtsVoice[]> | null = null;

export async function fetchPiperVoiceList(): Promise<TtsVoice[]> {
  if (cachedPiperVoices) return cachedPiperVoices;
  if (piperFetchPromise) return piperFetchPromise;

  piperFetchPromise = window.electronAPI.listPiperVoices()
    .then((voices) => {
      cachedPiperVoices = Array.isArray(voices) ? voices : [];
      return cachedPiperVoices;
    })
    .catch((error) => {
      console.error('[TTS:piper] failed to list voices:', error);
      return [];
    })
    .finally(() => {
      piperFetchPromise = null;
    });

  return piperFetchPromise;
}

// ── Remote TTS providers (fetched dynamically from backend) ─────────────

let cachedRemoteTtsModels: TtsModel[] | null = null;
let remoteProvidersFetchPromise: Promise<TtsModel[]> | null = null;

export async function fetchRemoteTtsProviders(forceRefresh = false): Promise<TtsModel[]> {
  if (!forceRefresh && cachedRemoteTtsModels) return cachedRemoteTtsModels;
  if (remoteProvidersFetchPromise) return remoteProvidersFetchPromise;

  remoteProvidersFetchPromise = (async () => {
    try {
      const { fetchTtsProviders } = await import('./api');
      const { providers } = await fetchTtsProviders();
      cachedRemoteTtsModels = providers
        .filter(provider => provider.id && provider.name && !['piper', 'builtin'].includes(provider.id))
        .map(provider => ({
          id: provider.id,
          name: provider.name,
          voices: provider.voices.map(voice => ({
            id: voice.id,
            name: voice.name,
            lang: voice.language || 'en',
          })),
        }))
        .filter(provider => provider.voices.length > 0);
      return cachedRemoteTtsModels;
    } catch (err) {
      console.error('[TTS] failed to fetch remote providers:', err);
      throw err;
    } finally {
      remoteProvidersFetchPromise = null;
    }
  })();

  return remoteProvidersFetchPromise;
}

export function getTtsModels(): TtsModel[] {
  const builtinVoices = getBuiltinVoices();
  const localModels: TtsModel[] = [
    {
      id: 'piper',
      name: i18n.t('tts.piper'),
      voices: cachedPiperVoices || [],
    },
    {
      id: 'builtin',
      name: i18n.t('tts.builtin'),
      voices: builtinVoices.length > 0
        ? builtinVoices
        : [{ id: '__default', name: i18n.t('tts.defaultVoice'), lang: 'ru-RU' }],
    },
  ];
  return [...localModels, ...(cachedRemoteTtsModels || [])];
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

function normalizeVoiceLanguage(language: string | undefined): string {
  return `${language || ''}`.trim().replace(/_/g, '-') || 'en';
}

function getVoiceLanguage(modelId: string, voiceId: string): string {
  const voice = getVoicesForModel(modelId).find((item) => item.id === voiceId);
  return normalizeVoiceLanguage(voice?.lang);
}

function getPreviewText(language: string): string {
  const normalizedLanguage = normalizeVoiceLanguage(language).toLowerCase();
  const baseLanguage = normalizedLanguage.split('-')[0];
  const locale = baseLanguage === 'pt'
    ? 'pt-BR'
    : baseLanguage === 'zh'
      ? 'zh-CN'
      : baseLanguage;
  const fallbackText = i18n.getFixedT('en')('tts.previewText', {
    defaultValue: 'Hello, I am Chatter!',
  });
  return i18n.getFixedT(locale)('tts.previewText', { defaultValue: fallbackText });
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
  existingAudio: MessageAudio | null | undefined,
  onAudioGenerated?: (messageId: number, audio: MessageAudio) => void,
): Promise<void> {
  await audioManager.stopWithFade(150);

  const ticket = ++generationTicket;
  playingId = messageId;
  notify();

  const settings = loadSettings();

  try {
    let audioBuffer: ArrayBuffer;
    let generatedAudio: MessageAudio | null = null;

    if (existingAudio?.url) {
      // Audio already generated — just download and play
      audioBuffer = await fetchAudioBuffer(existingAudio.url);
    } else {
      // Generate new audio via backend
      const language = getVoiceLanguage('cartesia', settings.voiceId);
      const result = await generateTts(text, settings.voiceId, language, messageId);
      if (ticket !== generationTicket) return;

      generatedAudio = { url: result.audio_url, tts_type: result.tts_type, voice_id: result.voice_id };
      onAudioGenerated?.(messageId, generatedAudio);

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

export function ttsSpeak(
  messageId: number,
  rawText: string,
  audio?: MessageAudio | null,
  onAudioGenerated?: (messageId: number, audio: MessageAudio) => void,
): void {
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
    cartesiaSpeak(messageId, text, audio, onAudioGenerated);
    return;
  }

  // Builtin (SpeechSynthesis) — synchronous API
  audioManager.abort();
  speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.0;
  utterance.pitch = 1.0;

  const voice = pickBuiltinVoice(settings.voiceId);
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  } else {
    utterance.lang = i18n.resolvedLanguage || i18n.language || 'en';
  }

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
  const interfaceLanguage = `${i18n.resolvedLanguage || i18n.language || 'en'}`.toLowerCase().split('-')[0];
  return sv.find((voice) => voice.lang.toLowerCase().startsWith(interfaceLanguage))
    ?? sv.find((voice) => voice.default)
    ?? sv[0]
    ?? null;
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
      const text = getPreviewText(getVoiceLanguage(modelId, voiceId));
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
      const { fetchTtsVoicePreview } = await import('./api');
      const language = getVoiceLanguage(modelId, voiceId);
      const text = getPreviewText(language);
      const result = await fetchTtsVoicePreview(voiceId, language, text);
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
  const language = normalizeVoiceLanguage(voice?.lang || i18n.resolvedLanguage || i18n.language);
  const text = getPreviewText(language);

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = voice?.lang || language;
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
