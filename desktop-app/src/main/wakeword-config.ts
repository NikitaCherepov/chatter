export const WAKE_WORD_CHOICES = [
  { id: 'alexa', label: 'Alexa', kind: 'name' },
  { id: 'hey_jarvis', label: 'Hey Jarvis', kind: 'name' },
  { id: 'hey_mycroft', label: 'Hey Mycroft', kind: 'name' },
  { id: 'hey_rhasspy', label: 'Hey Rhasspy', kind: 'name' },
  { id: 'timer', label: 'Timer', kind: 'phrase' },
  { id: 'weather', label: 'Weather', kind: 'phrase' },
] as const;
export type WakeWordId = typeof WAKE_WORD_CHOICES[number]['id'];
export type WakeWordConfig = { words: WakeWordId[]; sensitivity: number };
export const DEFAULT_WAKE_WORD_CONFIG: WakeWordConfig = { words: WAKE_WORD_CHOICES.map(word => word.id), sensitivity: 50 };
export function normalizeWakeWordConfig(value: unknown): WakeWordConfig {
  const raw = value && typeof value === 'object' ? value as Partial<WakeWordConfig> : {};
  const words = Array.isArray(raw.words) ? WAKE_WORD_CHOICES.filter(word => raw.words!.includes(word.id)).map(word => word.id) : [...DEFAULT_WAKE_WORD_CONFIG.words];
  const sensitivity = typeof raw.sensitivity === 'number' && Number.isFinite(raw.sensitivity) ? Math.min(100, Math.max(0, raw.sensitivity)) : 50;
  return { words, sensitivity };
}
export function wakeWordThreshold(sensitivity: number): number { return (85 - normalizeWakeWordConfig({ sensitivity }).sensitivity * 0.6) / 100; }
export function isWakeWordSelected(name: string, words: WakeWordId[]): boolean {
  return words.some(word => word === name || (word === 'timer' && /^\d+_(minute|hour)_timer$/.test(name)));
}
export function selectWakeWord(predictions: Record<string, number>, config: WakeWordConfig): { name: string; score: number } | null {
  let best: { name: string; score: number } | null = null;
  for (const [name, score] of Object.entries(predictions)) {
    if (isWakeWordSelected(name, config.words) && score >= wakeWordThreshold(config.sensitivity) && (!best || score > best.score)) best = { name, score };
  }
  return best;
}
