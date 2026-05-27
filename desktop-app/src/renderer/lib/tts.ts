/**
 * Text-to-Speech service using Web Speech API (SpeechSynthesis).
 *
 * Single global state — only one utterance plays at a time.
 * Starting a new one automatically stops the previous.
 *
 * Usage:
 *   import { ttsSpeak, ttsStop, ttsSubscribe, ttsIsPlaying } from '../lib/tts';
 *
 *   // Start speaking
 *   ttsSpeak(messageId, "Hello world");
 *
 *   // Stop
 *   ttsStop();
 *
 *   // Subscribe to state changes (which message is playing)
 *   const unsub = ttsSubscribe((playingId) => { ... });
 */

type Listener = (playingId: number | null) => void;

let playingId: number | null = null;
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach((fn) => fn(playingId));
}

export function ttsSubscribe(fn: Listener): () => void {
  listeners.add(fn);
  // Immediately call with current state
  fn(playingId);
  return () => { listeners.delete(fn); };
}

export function ttsIsPlaying(): number | null {
  return playingId;
}

/** Strip markdown-ish noise for cleaner speech. */
function cleanText(raw: string): string {
  let t = raw;
  // Remove image syntax
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  // Remove links but keep text
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Remove bold/italic markers
  t = t.replace(/(\*{1,3}|_{1,3})(.*?)\1/g, '$2');
  // Remove code blocks
  t = t.replace(/```[\s\S]*?```/g, '');
  // Remove inline code
  t = t.replace(/`([^`]+)`/g, '$1');
  // Remove headings markers
  t = t.replace(/^#{1,6}\s+/gm, '');
  // Collapse whitespace
  t = t.replace(/\n{2,}/g, '. ').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

export function ttsSpeak(messageId: number, rawText: string): void {
  // If already playing this exact message — stop
  if (playingId === messageId) {
    ttsStop();
    return;
  }

  // Stop any current playback
  if (playingId !== null) {
    speechSynthesis.cancel();
  }

  const text = cleanText(rawText);
  if (!text) return;

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ru-RU';
  utterance.rate = 1.0;
  utterance.pitch = 1.0;

  // Try to pick a Russian voice
  const voices = speechSynthesis.getVoices();
  const ruVoice = voices.find((v) => v.lang.startsWith('ru'));
  if (ruVoice) {
    utterance.voice = ruVoice;
  }

  utterance.onend = () => {
    if (playingId === messageId) {
      playingId = null;
      notify();
    }
  };

  utterance.onerror = (e) => {
    // "interrupted" is normal when we cancel() — ignore
    if (e.error !== 'interrupted' && e.error !== 'canceled') {
      console.error('[TTS] Speech error:', e.error);
    }
    if (playingId === messageId) {
      playingId = null;
      notify();
    }
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
