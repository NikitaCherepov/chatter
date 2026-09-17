import { API_BASE, loadTokens } from '../../../lib/api';

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
    const url = value.startsWith('/')
      ? new URL(API_BASE + value)
      : new URL(value, window.location.href);
    if (value.startsWith('/')) {
      const token = loadTokens()?.access_token;
      if (token) url.searchParams.set('token', token);
    }
    return ['http:', 'https:', 'file:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
