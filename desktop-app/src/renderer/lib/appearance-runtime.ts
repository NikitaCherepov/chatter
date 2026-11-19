import { getResolvedTheme } from './theme';
import { appearanceColors } from './appearance-colors';
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
export function refreshAppearance() {
  const root = document.documentElement;
  for (const key of applied) root.style.removeProperty(key);
  applied.clear();
  const profile = currentAppearance();
  if (!profile) {
    delete root.dataset.appearance;
    delete root.dataset.appearancePanels;
    window.dispatchEvent(new Event(APPEARANCE_STYLE_EVENT));
    if (measuredSignature) {
      measuredSignature = '';
      window.dispatchEvent(new Event(APPEARANCE_CHANGE_EVENT));
    }
    return;
  }
  root.dataset.appearance = profile.id;
  const colors = appearanceColors(profile, getResolvedTheme(), imageUrl);
  const set = (key: string, value: string | number) => {
    root.style.setProperty(key, String(value));
    applied.add(key);
  };
  for (const [key, value] of Object.entries(colors.shell)) set(key, value);
  for (const [key, value] of Object.entries(colors.chat))
    set('--appearance-chat-' + key.slice(2), value);
  if (profile[getResolvedTheme()].surface) {
    root.dataset.appearancePanels = 'custom';
    for (const [key, value] of Object.entries(colors.panel))
      set('--appearance-panel-' + key.slice(2), value);
  } else delete root.dataset.appearancePanels;
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
  set('--appearance-chat-background', colors.background);
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
