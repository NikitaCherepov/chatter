export const CHAT_LAYOUT_OPTIONS = {
  chatSide: ['left', 'right'],
  tools: ['rail', 'header'],
  composer: ['floating', 'docked'],
  column: ['fluid', 'reading', 'wide'],
  chatList: ['comfortable', 'compact'],
  messages: ['classic', 'bubbles'],
  headerDetails: ['full', 'minimal'],
} as const;

export type ChatLayout = {
  [K in keyof typeof CHAT_LAYOUT_OPTIONS]: (typeof CHAT_LAYOUT_OPTIONS)[K][number];
};

export type ChatLayoutProfile = ChatLayout & {
  id: string;
  name: string;
  revision: number;
  sidebarWidth: number;
};

export type ChatLayoutSettings = {
  activeId: string | null;
  revision: number;
  profiles: ChatLayoutProfile[];
};

export type ChatLayoutCommand =
  | { action: 'save'; profile: ChatLayoutProfile; apply: boolean }
  | { action: 'activate'; id: string | null; revision: number }
  | { action: 'delete'; id: string; revision: number };

export const DEFAULT_CHAT_LAYOUT: ChatLayout = {
  chatSide: 'left',
  tools: 'rail',
  composer: 'floating',
  column: 'fluid',
  chatList: 'comfortable',
  messages: 'classic',
  headerDetails: 'full',
};

export const CHAT_LAYOUT_SIDEBAR_WIDTH = { min: 200, max: 360, default: 260 } as const;

export const MAX_CHAT_LAYOUT_PROFILES = 32;

export const CHAT_LAYOUT_CAPABILITIES = {
  options: CHAT_LAYOUT_OPTIONS,
  sidebarWidth: CHAT_LAYOUT_SIDEBAR_WIDTH,
  template: { id: 'my-layout', name: 'My layout', revision: 0, ...DEFAULT_CHAT_LAYOUT, sidebarWidth: CHAT_LAYOUT_SIDEBAR_WIDTH.default },
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('chat_layout_invalid');
  return value as Record<string, unknown>;
}

function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('chat_layout_invalid');
  return value;
}

export function parseChatLayoutProfile(value: unknown): ChatLayoutProfile {
  const raw = record(value);
  const { id, name, sidebarWidth = CHAT_LAYOUT_SIDEBAR_WIDTH.default } = raw;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)
      || typeof name !== 'string' || !name.trim() || name.trim().length > 80
      || typeof sidebarWidth !== 'number' || !Number.isInteger(sidebarWidth)
      || sidebarWidth < CHAT_LAYOUT_SIDEBAR_WIDTH.min || sidebarWidth > CHAT_LAYOUT_SIDEBAR_WIDTH.max) {
    throw new Error('chat_layout_invalid');
  }
  const layout: ChatLayout = { ...DEFAULT_CHAT_LAYOUT };
  for (const key of Object.keys(CHAT_LAYOUT_OPTIONS) as (keyof ChatLayout)[]) {
    const input = raw[key];
    if (input === undefined) continue;
    const values: readonly unknown[] = CHAT_LAYOUT_OPTIONS[key];
    if (!values.includes(input)) throw new Error('chat_layout_invalid');
    Object.assign(layout, { [key]: input });
  }
  return { ...layout, id, name: name.trim(), revision: revision(raw.revision), sidebarWidth };
}

export function parseChatLayoutSettings(value: unknown): ChatLayoutSettings {
  if (value === undefined) return { activeId: null, revision: 0, profiles: [] };
  const raw = record(value);
  if (!Array.isArray(raw.profiles) || raw.profiles.length > MAX_CHAT_LAYOUT_PROFILES) throw new Error('chat_layout_invalid');
  const profiles = raw.profiles.map(parseChatLayoutProfile);
  const ids = new Set(profiles.map(profile => profile.id));
  const { activeId } = raw;
  if (ids.size !== profiles.length || (activeId !== null && (typeof activeId !== 'string' || !ids.has(activeId)))) {
    throw new Error('chat_layout_invalid');
  }
  return { activeId: typeof activeId === 'string' ? activeId : null, revision: revision(raw.revision), profiles };
}
