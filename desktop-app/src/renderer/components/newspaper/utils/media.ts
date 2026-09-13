export function safeUrl(value?: string) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function safeImageUrl(value?: string) {
  if (!value) return null;
  if (value.startsWith('data:image/') || value.startsWith('blob:')) return value;
  try {
    const url = new URL(value, window.location.href);
    return ['http:', 'https:', 'file:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
