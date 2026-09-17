import { resolveAuthenticatedAssetUrl } from '../../../lib/api';

export function safeUrl(value?: string) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function safeImageUrl(value?: string, width = 1200) {
  if (!value) return null;
  if (value.startsWith('data:image/') || value.startsWith('blob:')) return value;
  try {
    const resolved = value.startsWith('/')
      ? resolveAuthenticatedAssetUrl(value, { width, preserveAnimation: true })
      : new URL(value, window.location.href).href;
    const url = new URL(resolved);
    return ['http:', 'https:', 'file:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
