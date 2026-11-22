import {
  attachMediaAsset,
  removeMediaReferencesForEntity,
  getMediaAssetByUrl,
  deleteMediaAssetIfUnreferenced,
} from './media-assets.js';
import { db } from '../db.js';
import {
  DEFAULT_APPEARANCE,
  parseAppearanceProfile,
  parseAppearanceSettings,
  type AppearanceSettings,
} from './appearance-schema.js';
export function appearanceFromJson(raw: string | null | undefined): AppearanceSettings {
  try {
    return parseAppearanceSettings(JSON.parse(raw || '{}').appearance);
  } catch {
    return { ...DEFAULT_APPEARANCE, profiles: [] };
  }
}
export function getAppearance(userId: number) {
  const row = db.prepare('SELECT ui_settings FROM users WHERE id=?').get(userId) as
    { ui_settings: string } | undefined;
  if (!row) throw new Error('user_not_found');
  return appearanceFromJson(row.ui_settings);
}
/** Migration must preserve older/unknown profiles instead of normalizing the whole collection to empty. */
export function getLegacyAppearance(userId: number): unknown {
  const row = db.prepare('SELECT ui_settings FROM users WHERE id=?').get(userId) as { ui_settings: string } | undefined;
  if (!row) throw new Error('user_not_found');
  try {
    const settings = JSON.parse(row.ui_settings || '{}');
    return settings.appearance ?? { ...DEFAULT_APPEARANCE, profiles: [] };
  } catch { throw new Error('appearance_migration_invalid_json'); }
}
export function changeAppearance(userId: number, command: any): AppearanceSettings {
  if (
    !command ||
    typeof command !== 'object' ||
    Array.isArray(command) ||
    (command.action === 'save' && typeof command.apply !== 'boolean')
  ) {
    throw new Error('appearance_invalid');
  }
  const oldAssets: number[] = [];
  const result = db.transaction(() => {
    const row = db.prepare('SELECT ui_settings FROM users WHERE id=?').get(userId) as
      { ui_settings: string } | undefined;
    if (!row) throw new Error('user_not_found');
    let settings: any = {};
    try {
      settings = JSON.parse(row.ui_settings || '{}');
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
    } catch {}
    const state = appearanceFromJson(row.ui_settings);
    if (command.action === 'save') {
      const profile = parseAppearanceProfile(command.profile),
        old = state.profiles.find((p) => p.id === profile.id);
      if ((old?.revision ?? 0) !== profile.revision) throw new Error('appearance_conflict');
      if (old?.id === state.activeId && !command.apply)
        throw new Error('appearance_active_requires_apply');
      if (!old && state.profiles.length >= 32) throw new Error('appearance_limit');
      profile.revision = (old?.revision ?? 0) + 1;
      state.profiles = old
        ? state.profiles.map((p) => (p.id === profile.id ? profile : p))
        : [...state.profiles, profile];
      if (command.apply === true) state.activeId = profile.id;
    } else {
      if (command.revision !== state.revision) throw new Error('appearance_conflict');
      if (command.action === 'activate') {
        if (command.id !== null && !state.profiles.some((p) => p.id === command.id))
          throw new Error('appearance_not_found');
        state.activeId = command.id;
      } else if (command.action === 'delete') {
        if (!state.profiles.some((p) => p.id === command.id))
          throw new Error('appearance_not_found');
        state.profiles = state.profiles.filter((p) => p.id !== command.id);
        if (state.activeId === command.id) state.activeId = null;
      } else throw new Error('appearance_invalid');
    }
    state.revision++;
    settings.appearance = parseAppearanceSettings(state);
    // Only owned images can become durable appearance assets.
    const images = state.profiles
      .filter((p) => p.background.type === 'image' && p.background.image.startsWith('/'))
      .map((p) => {
        const asset = getMediaAssetByUrl(p.background.image);
        if (!asset || asset.user_id !== userId) {
          if ((command.action === 'save' && p.id === command.profile.id) || p.id === state.activeId)
            throw new Error('appearance_image_not_found');
          return null;
        }
        return { profile: p, asset };
      });
    oldAssets.push(...removeMediaReferencesForEntity('appearance', userId));
    for (const { profile, asset } of images.filter(
      (entry): entry is NonNullable<typeof entry> => entry !== null,
    ))
      attachMediaAsset({
        assetId: asset.id,
        entityType: 'appearance',
        entityId: userId,
        slot: profile.id,
      });
    db.prepare('UPDATE users SET ui_settings=? WHERE id=?').run(JSON.stringify(settings), userId);
    return state;
  })();
  for (const id of oldAssets) {
    try {
      deleteMediaAssetIfUnreferenced(id);
    } catch (error) {
      console.warn('[appearance] image cleanup failed', error);
    }
  }
  return result;
}
