import { getResolvedTheme } from './theme';
import {
  DEFAULT_APPEARANCE,
  parseAppearanceProfile,
  parseAppearanceSettings,
  type AppearanceProfile,
  type AppearanceSettings,
} from './appearance-schema';
export const APPEARANCE_CHANGE_EVENT = 'chatter-appearance-change';
export const APPEARANCE_STYLE_EVENT = 'chatter-appearance-style';
let settings: AppearanceSettings = DEFAULT_APPEARANCE;
let preview: AppearanceProfile | null = null;
let imageUrl = (url: string) => url;
const subscribers = new Set<() => void>();
const applied = new Set<string>();
let measuredSignature = '';
export const getAppearancePreview = () => preview;
export const subscribeAppearancePreview = (fn: () => void) => {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
};
export const currentAppearance = () =>
  preview ?? settings.profiles.find((p) => p.id === settings.activeId) ?? null;
const rgb = (hex: string) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
const mix = (a: string, b: string, t: number) =>
  '#' +
  rgb(a)
    .map((c, i) =>
      Math.round(c + (rgb(b)[i] - c) * t)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
export function refreshAppearance() {
  const root = document.documentElement;
  for (const key of applied) root.style.removeProperty(key);
  applied.clear();
  const profile = currentAppearance();
  if (!profile) {
    window.dispatchEvent(new Event(APPEARANCE_STYLE_EVENT));
    delete root.dataset.appearance;
    if (measuredSignature) {
      measuredSignature = '';
      window.dispatchEvent(new Event(APPEARANCE_CHANGE_EVENT));
    }
    return;
  }
  root.dataset.appearance = profile.id;
  const p = profile[getResolvedTheme()],
    dark = getResolvedTheme() === 'dark',
    opposite = dark ? '#ffffff' : '#000000';
  const set = (key: string, value: string | number) => {
    root.style.setProperty(key, String(value));
    applied.add(key);
  };
  const c: Record<string, string> = {
    '--bg-primary': mix(p.background, '#ffffff', dark ? 0.06 : 0.85),
    '--bg-secondary': p.background,
    '--bg-input': mix(p.background, p.text, 0.035),
    '--bg-bubble': mix(p.background, p.text, 0.045),
    '--bg-modal-hover': mix(p.background, p.text, 0.08),
    '--text-primary': p.text,
    '--text-body': p.text,
    '--text-secondary': mix(p.text, p.background, 0.12),
    '--text-muted': mix(p.text, p.background, 0.3),
    '--text-hint': mix(p.text, p.background, 0.44),
    '--border-light': mix(p.background, p.text, 0.17),
    '--border-medium': mix(p.background, p.text, 0.3),
    '--border-input': mix(p.background, p.text, 0.3),
    '--accent': p.accent,
    '--accent-contrast':
      rgb(p.accent).reduce((a, c, i) => a + c * [0.299, 0.587, 0.114][i], 0) > 145
        ? '#080f1d'
        : '#ffffff',
    '--accent-icon': mix(p.accent, p.text, 0.1),
    '--accent-icon-light': mix(p.accent, p.background, 0.2),
    '--accent-icon-placeholder': mix(p.accent, p.background, 0.4),
    '--scrollbar-thumb': mix(p.background, p.text, 0.28),
    '--scrollbar-hover': mix(p.background, p.text, 0.42),
    '--selection-bg': mix(p.background, p.accent, 0.3),
    '--selection-text': p.text,
    '--overlay-bg': dark ? 'rgba(0,0,0,.58)' : 'rgba(0,0,0,.3)',
  };
  for (const [key, value] of Object.entries(c)) set(key, value);
  const t = profile.typography;
  set('--appearance-ui-font', JSON.stringify(t.uiFont) + ', system-ui, sans-serif');
  set('--appearance-message-font', JSON.stringify(t.messageFont) + ', system-ui, sans-serif');
  set('--appearance-code-font', JSON.stringify(t.codeFont) + ', monospace');
  set('--appearance-ui-scale', t.uiSize / 14);
  set('--appearance-message-size', t.messageSize + 'px');
  set('--appearance-code-size', t.codeSize + 'px');
  set('--appearance-line-height', t.lineHeight);
  set('--appearance-radius', profile.geometry.radius + 'px');
  set('--appearance-density', profile.geometry.density);
  const b = profile.background;
  let background = 'none';
  if (b.type === 'gradient') background = `linear-gradient(${b.angle}deg, ${b.color}, ${b.color2})`;
  if (b.type === 'image' && b.image)
    background = `linear-gradient(rgba(0,0,0,${b.dim}),rgba(0,0,0,${b.dim})),url(${JSON.stringify(imageUrl(b.image))})`;
  set('--appearance-chat-background', background);
  set('--appearance-chat-position', b.position);
  window.dispatchEvent(new Event(APPEARANCE_STYLE_EVENT));
  const signature = JSON.stringify([profile.typography, profile.geometry]);
  if (signature !== measuredSignature) {
    measuredSignature = signature;
    window.dispatchEvent(new Event(APPEARANCE_CHANGE_EVENT));
  }
}
export function configureAppearance(
  value: AppearanceSettings,
  resolveImage: (url: string) => string,
) {
  try {
    settings = parseAppearanceSettings(value);
  } catch {
    settings = DEFAULT_APPEARANCE;
  }
  imageUrl = resolveImage;
  refreshAppearance();
}
export function previewAppearance(value: AppearanceProfile | null) {
  preview = value ? parseAppearanceProfile(value) : null;
  refreshAppearance();
  for (const fn of subscribers) fn();
}
export function animateMessageArrival(element: HTMLElement) {
  const motion = currentAppearance()?.motion;
  if (
    !motion ||
    motion.preset === 'none' ||
    !motion.duration ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
    return;
  const custom = motion.preset === 'custom';
  const transform =
    motion.preset === 'fade'
      ? 'none'
      : `translateY(${motion.distance}px) scale(${custom ? motion.scale : 1})`;
  element.animate(
    [
      { opacity: 0, transform },
      { opacity: 1, transform: 'none' },
    ],
    { duration: motion.duration, easing: motion.easing },
  );
}

export const APPEARANCE_APPLIED_EVENT = 'chatter-appearance-applied';
export function finishAppearancePreview(profile: AppearanceProfile) {
  previewAppearance(null);
  window.dispatchEvent(
    new CustomEvent(APPEARANCE_APPLIED_EVENT, {
      detail: { id: profile.id, revision: profile.revision },
    }),
  );
}
