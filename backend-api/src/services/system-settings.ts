import { db } from '../db.js';

const readSetting = <T>(key: string, fallback: T): T => {
  const row = db.prepare('SELECT value_json FROM system_settings WHERE key = ?').get(key) as
    | { value_json: string }
    | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return fallback;
  }
};

const writeSetting = (key: string, value: unknown) => {
  db.prepare(`
    INSERT INTO system_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), Date.now());
};

const IMAGE_GENERATION_ENABLED_KEY = 'image_generation_enabled';
const IMAGE_GENERATION_ENABLED_FALLBACK = true;

export const isImageGenerationEnabled = () =>
  readSetting(IMAGE_GENERATION_ENABLED_KEY, IMAGE_GENERATION_ENABLED_FALLBACK) === true;

export const setImageGenerationEnabled = (enabled: boolean) => {
  writeSetting(IMAGE_GENERATION_ENABLED_KEY, enabled);
  return isImageGenerationEnabled();
};
