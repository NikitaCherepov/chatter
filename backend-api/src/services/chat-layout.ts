import { db } from '../db.js';
import {
  MAX_CHAT_LAYOUT_PROFILES,
  parseChatLayoutProfile,
  parseChatLayoutSettings,
  type ChatLayoutSettings,
} from './chat-layout-schema.js';

function readUiSettings(userId: number): Record<string, unknown> {
  const row = db.prepare('SELECT ui_settings FROM users WHERE id=?').get(userId) as
    { ui_settings: string | null } | undefined;
  if (!row) throw new Error('user_not_found');
  try {
    const value = JSON.parse(row.ui_settings || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* Older accounts can contain invalid UI settings. */ }
  return {};
}

export function getChatLayouts(userId: number): ChatLayoutSettings {
  return parseChatLayoutSettings(readUiSettings(userId).chat_layout);
}

export const changeChatLayouts = db.transaction((userId: number, input: unknown): ChatLayoutSettings => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('chat_layout_invalid');
  const command = input as Record<string, unknown>;
  const settings = readUiSettings(userId);
  const state = parseChatLayoutSettings(settings.chat_layout);
  if (command.action === 'save') {
    if (typeof command.apply !== 'boolean') throw new Error('chat_layout_invalid');
    const profile = parseChatLayoutProfile(command.profile);
    const original = state.profiles.find(item => item.id === profile.id);
    if ((original?.revision ?? 0) !== profile.revision) throw new Error('chat_layout_conflict');
    if (profile.id === state.activeId && !command.apply) throw new Error('chat_layout_active_requires_apply');
    if (!original && state.profiles.length >= MAX_CHAT_LAYOUT_PROFILES) throw new Error('chat_layout_limit');
    profile.revision++;
    state.profiles = original
      ? state.profiles.map(item => item.id === profile.id ? profile : item)
      : [...state.profiles, profile];
    if (command.apply) state.activeId = profile.id;
  } else if (command.action === 'activate' || command.action === 'delete') {
    if (command.revision !== state.revision) throw new Error('chat_layout_conflict');
    const id = command.id;
    if (command.action === 'activate' && id === null) {
      state.activeId = null;
    } else {
      if (typeof id !== 'string' || !state.profiles.some(profile => profile.id === id)) {
        throw new Error('chat_layout_not_found');
      }
      if (command.action === 'activate') state.activeId = id;
      else {
        state.profiles = state.profiles.filter(profile => profile.id !== id);
        if (state.activeId === id) state.activeId = null;
      }
    }
  } else throw new Error('chat_layout_invalid');
  state.revision++;
  settings.chat_layout = parseChatLayoutSettings(state);
  db.prepare('UPDATE users SET ui_settings=? WHERE id=?').run(JSON.stringify(settings), userId);
  return state;
});
