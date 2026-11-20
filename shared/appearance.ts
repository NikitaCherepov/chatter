// Canonical appearance contract. Run scripts/sync-appearance.mjs after editing.
export type Palette = {
  background: string;
  text: string;
  accent: string;
  surface?: string;
  chat?: string;
};
export type AppearanceMaterial = {
  opacity: number;
  blur: number;
  shadow: 'none' | 'soft' | 'medium' | 'strong';
  border: 'none' | 'subtle' | 'defined';
  radius?: number;
};
export const DEFAULT_MATERIAL: AppearanceMaterial = {
  opacity: 1,
  blur: 0,
  shadow: 'none',
  border: 'subtle',
};
export type AppearanceMotion = {
  preset: 'none' | 'fade' | 'slide' | 'custom';
  duration: number;
  distance: number;
  scale: number;
  easing: 'ease-out' | 'ease-in-out' | 'linear';
};

// These are complete motion values, so existing clients can play them too.
export const APPEARANCE_MOTION_PRESETS = {
  none: { preset: 'none', duration: 0, distance: 0, scale: 1, easing: 'ease-out' },
  fade: { preset: 'fade', duration: 160, distance: 0, scale: 1, easing: 'ease-out' },
  slide: { preset: 'slide', duration: 220, distance: 8, scale: 1, easing: 'ease-out' },
  scale: { preset: 'custom', duration: 240, distance: 0, scale: 0.97, easing: 'ease-out' },
} as const satisfies Record<string, AppearanceMotion>;

export function appearanceMotionValues(motion: AppearanceMotion): AppearanceMotion {
  return {
    ...motion,
    distance: motion.preset === 'fade' || motion.preset === 'none' ? 0 : motion.distance,
    scale: motion.preset === 'custom' ? motion.scale : 1,
  };
}

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
  materials?: { panels?: AppearanceMaterial; composer?: AppearanceMaterial };
  background: {
    type: 'solid' | 'gradient' | 'image';
    color: string;
    color2: string;
    angle: number;
    image: string;
    dim: number;
    position: 'center' | 'top' | 'bottom';
  };
  motion: AppearanceMotion;
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
    motion: { ...APPEARANCE_MOTION_PRESETS.none },
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
export function parseAppearanceMotion(value: unknown): AppearanceMotion {
  const motion = keys(value, ['preset', 'duration', 'distance', 'scale', 'easing']);
  return {
    preset: choice(motion.preset, ['none', 'fade', 'slide', 'custom']),
    duration: number(motion.duration, 0, 800),
    distance: number(motion.distance, 0, 40),
    scale: number(motion.scale, 0.9, 1),
    easing: choice(motion.easing, ['ease-out', 'ease-in-out', 'linear']),
  };
}

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
    'materials',
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
  let materials: AppearanceProfile['materials'];
  if (v.materials !== undefined) {
    const source = keys(v.materials, ['panels', 'composer']);
    materials = {};
    for (const region of ['panels', 'composer'] as const) {
      if (source[region] === undefined) continue;
      const item = keys(source[region], ['opacity', 'blur', 'shadow', 'border', 'radius']);
      materials[region] = {
        opacity: number(item.opacity, 0.55, 1),
        blur: number(item.blur, 0, 32),
        shadow: choice(item.shadow, ['none', 'soft', 'medium', 'strong']),
        border: choice(item.border, ['none', 'subtle', 'defined']),
        ...(item.radius !== undefined ? { radius: number(item.radius, 0, 24) } : {}),
      };
    }
  }
  return {
    id,
    name: text(v.name, 80),
    revision: revision(v.revision ?? 0),
    ...(materials !== undefined ? { materials } : {}),
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
    motion: parseAppearanceMotion(v.motion),
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
    presets: APPEARANCE_MOTION_PRESETS,
    description:
      'For a ready-made message arrival, copy one complete value from motion.presets into profile.motion. For custom motion, use preset custom with duration in milliseconds, distance in pixels, starting scale and easing. Only new arrivals animate.',
  },
  materials: {
    regions: ['panels', 'composer'],
    template: DEFAULT_MATERIAL,
    limits: { opacity: [0.55, 1], blur: [0, 32], radius: [0, 24] },
    shadow: ['none', 'soft', 'medium', 'strong'],
    border: ['none', 'subtle', 'defined'],
    description:
      'Optional material per region. Omit a region for unchanged legacy styling. Opacity affects fill only; text remains opaque. Fill opacity is applied exactly as requested; only foreground colors adapt for contrast. The editor warns when a varied backdrop may reduce legibility. System reduced-transparency preferences use an opaque fallback. Blur affects content behind the surface, not text. It is only visible over varied content; panels over a flat background may show no visible blur. Optional radius overrides the global radius in this region only. Use the existing preview/confirmation flow.',
  },
  template: newAppearance(),
};
