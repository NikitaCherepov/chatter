// Canonical appearance contract. Run scripts/sync-appearance.mjs after editing.
export type Palette = {
  background: string;
  text: string;
  accent: string;
  surface?: string;
  chat?: string;
};
export type AppearanceProfile = {
  id: string;
  name: string;
  revision: number;
  light: Palette;
  dark: Palette;
  typography: {
    uiFont: string;
    messageFont: string;
    codeFont: string;
    uiSize: number;
    messageSize: number;
    codeSize: number;
    lineHeight: number;
  };
  geometry: { radius: number; density: number };
  background: {
    type: 'solid' | 'gradient' | 'image';
    color: string;
    color2: string;
    angle: number;
    image: string;
    dim: number;
    position: 'center' | 'top' | 'bottom';
  };
  motion: {
    preset: 'none' | 'fade' | 'slide' | 'custom';
    duration: number;
    distance: number;
    scale: number;
    easing: 'ease-out' | 'ease-in-out' | 'linear';
  };
};
export type AppearanceSettings = {
  version: 1;
  revision: number;
  activeId: string | null;
  profiles: AppearanceProfile[];
};
export const DEFAULT_APPEARANCE: AppearanceSettings = {
  version: 1,
  revision: 0,
  activeId: null,
  profiles: [],
};
export const APPEARANCE_FONTS = [
  'Inter',
  'Segoe UI',
  'Arial',
  'Georgia',
  'Verdana',
  'Trebuchet MS',
  'Consolas',
  'Cascadia Code',
  'JetBrains Mono',
];
export function newAppearance(id = 'custom'): AppearanceProfile {
  return {
    id,
    name: 'Custom',
    revision: 0,
    light: { background: '#dfe6ef', text: '#0f1d30', accent: '#122d4d' },
    dark: { background: '#101722', text: '#e4ebf3', accent: '#7da6cf' },
    typography: {
      uiFont: 'Inter',
      messageFont: 'Inter',
      codeFont: 'Consolas',
      uiSize: 14,
      messageSize: 14,
      codeSize: 13,
      lineHeight: 1.6,
    },
    geometry: { radius: 8, density: 1 },
    background: {
      type: 'solid',
      color: '#101722',
      color2: '#243348',
      angle: 135,
      image: '',
      dim: 0.25,
      position: 'center',
    },
    motion: { preset: 'none', duration: 220, distance: 12, scale: 0.98, easing: 'ease-out' },
  };
}
const object = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (): never => {
  throw new Error('appearance_invalid');
};
const keys = (v: any, allowed: string[]) => {
  if (!object(v) || Object.keys(v).some((k) => !allowed.includes(k))) fail();
  return v;
};
const text = (v: unknown, max: number) =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v.trim() : fail();
const number = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fail();
const revision = (value: unknown): number => {
  const n = number(value, 0, 1e9);
  return Number.isSafeInteger(n) ? n : fail();
};
const choice = <T extends string>(v: unknown, items: readonly T[]): T =>
  items.includes(v as T) ? (v as T) : fail();
const color = (v: unknown): string =>
  typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : fail();
const font = (v: unknown): string => {
  const s = text(v, 100);
  return /^[\p{L}\p{N} _.-]+$/u.test(s) ? s : fail();
};
export function parseAppearanceProfile(value: unknown): AppearanceProfile {
  const v = keys(value, [
    'id',
    'name',
    'revision',
    'light',
    'dark',
    'typography',
    'geometry',
    'background',
    'motion',
  ]);
  const id = text(v.id, 64);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) fail();
  const palette = (p: any): Palette => {
    keys(p, ['background', 'text', 'accent', 'surface', 'chat']);
    return {
      background: color(p.background),
      text: color(p.text),
      accent: color(p.accent),
      ...(p.surface !== undefined ? { surface: color(p.surface) } : {}),
      ...(p.chat !== undefined ? { chat: color(p.chat) } : {}),
    };
  };
  const t = keys(v.typography, [
    'uiFont',
    'messageFont',
    'codeFont',
    'uiSize',
    'messageSize',
    'codeSize',
    'lineHeight',
  ]);
  const g = keys(v.geometry, ['radius', 'density']);
  const b = keys(v.background, ['type', 'color', 'color2', 'angle', 'image', 'dim', 'position']);
  const m = keys(v.motion, ['preset', 'duration', 'distance', 'scale', 'easing']);
  if (typeof b.image !== 'string' || b.image.length > 2048) fail();
  if (b.type === 'image' && !b.image) fail();
  if (b.image && !/^\/api\/v1\/images\/[a-zA-Z0-9_.-]+$/.test(b.image)) {
    try {
      const url = new URL(b.image);
      if (url.protocol !== 'https:' || url.username || url.password) fail();
    } catch {
      fail();
    }
  }
  return {
    id,
    name: text(v.name, 80),
    revision: revision(v.revision ?? 0),
    light: palette(v.light),
    dark: palette(v.dark),
    typography: {
      uiFont: font(t.uiFont),
      messageFont: font(t.messageFont),
      codeFont: font(t.codeFont),
      uiSize: number(t.uiSize, 12, 20),
      messageSize: number(t.messageSize, 12, 28),
      codeSize: number(t.codeSize, 11, 24),
      lineHeight: number(t.lineHeight, 1.2, 2),
    },
    geometry: { radius: number(g.radius, 0, 24), density: number(g.density, 0.7, 1.4) },
    background: {
      type: choice(b.type, ['solid', 'gradient', 'image']),
      color: color(b.color),
      color2: color(b.color2),
      angle: number(b.angle, 0, 360),
      image: b.image,
      dim: number(b.dim, 0, 0.9),
      position: choice(b.position, ['center', 'top', 'bottom']),
    },
    motion: {
      preset: choice(m.preset, ['none', 'fade', 'slide', 'custom']),
      duration: number(m.duration, 0, 800),
      distance: number(m.distance, 0, 40),
      scale: number(m.scale, 0.9, 1),
      easing: choice(m.easing, ['ease-out', 'ease-in-out', 'linear']),
    },
  };
}
export function parseAppearanceSettings(value: unknown): AppearanceSettings {
  const v = keys(value, ['version', 'revision', 'activeId', 'profiles']);
  if (v.version !== 1 || !Array.isArray(v.profiles) || v.profiles.length > 32) fail();
  const profiles: AppearanceProfile[] = v.profiles.map(parseAppearanceProfile);
  if (new Set(profiles.map((p) => p.id)).size !== profiles.length) fail();
  if (v.activeId !== null && !profiles.some((p) => p.id === v.activeId)) fail();
  return {
    version: 1,
    revision: revision(v.revision),
    activeId: v.activeId,
    profiles,
  };
}
export const APPEARANCE_CAPABILITIES = {
  version: 1,
  fonts: APPEARANCE_FONTS,
  customFont: 'Installed font family name; other devices use a fallback. Installation is separate.',
  colors:
    'Six-digit hex. light/dark each contain background (application shell), text and accent. Optional surface colors panels, header, composer and settings; optional chat colors the solid conversation backdrop. Omit optional colors for automatic legacy behavior. Text contrast adapts independently in each region.',
  paletteExample: {
    background: '#07111f',
    surface: '#112237',
    chat: '#08192b',
    text: '#d5eaff',
    accent: '#f59542',
  },
  limits: {
    profiles: 32,
    uiSize: [12, 20],
    messageSize: [12, 28],
    codeSize: [11, 24],
    lineHeight: [1.2, 2],
    radius: [0, 24],
    density: [0.7, 1.4],
    duration: [0, 800],
    distance: [0, 40],
    scale: [0.9, 1],
  },
  background: {
    scope:
      'Conversation only. solid follows light/dark.chat or falls back to light/dark.background; gradient/image override that solid color. Never changes the application shell or theme preference.',
    type: ['solid', 'gradient', 'image'],
    image: 'An existing /api/v1/images/file or HTTPS URL',
    position: ['center', 'top', 'bottom'],
  },
  motion: {
    preset: ['none', 'fade', 'slide', 'custom'],
    easing: ['ease-out', 'ease-in-out', 'linear'],
  },
  template: newAppearance(),
};
