import { normalizeWakeWordConfig, type WakeWordConfig } from '../../main/wakeword-config';
const STORAGE_KEY = 'chatter_wake_word_enabled';

export function getWakeWordEnabled(): boolean {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === null) return true; // enabled by default
    return value === 'true';
  } catch {
    return true;
  }
}

export function setWakeWordEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {
    // Non-critical — apply for this session even without persistence.
  }

  // Notify active ChatPage instances so they can start/stop the ONNX listener.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('chatter:wakeword-toggle', { detail: { enabled } }),
    );
  }
}

const CONFIG_KEY = 'chatter_wake_word_config';
export function getWakeWordConfig(): WakeWordConfig {
  try { return normalizeWakeWordConfig(JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null')); }
  catch { return normalizeWakeWordConfig(null); }
}
export function setWakeWordConfig(value: WakeWordConfig): void {
  const config = normalizeWakeWordConfig(value);
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); } catch { /* Apply in this session. */ }
  window.dispatchEvent(new CustomEvent('chatter:wakeword-config', { detail: config }));
}
