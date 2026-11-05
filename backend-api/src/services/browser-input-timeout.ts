export function usesHumanBrowserTyping(uiSettings: string | null | undefined): boolean {
  try { return JSON.parse(uiSettings || '{}')?.browser_human_typing !== false; }
  catch { return true; }
}

/** Allow visible character-by-character typing without changing passive browser timeouts. */
export function browserInputTimeout(ipcType: string, payload: any, baseMs: number): number {
  if (payload?.human_typing === false) return baseMs;
  if (ipcType === 'browser_control' && payload?.action === 'fill' && typeof payload.text === 'string') {
    return baseMs + Math.min(payload.text.length, 10000) * 400 + 5000;
  }
  if (ipcType === 'google_ai' && typeof payload?.message === 'string' && payload.message.length) {
    // Google AI may retry the composer up to three times.
    return baseMs + Math.min(payload.message.length, 8000) * 400 * 4 + 5000;
  }
  return baseMs;
}
