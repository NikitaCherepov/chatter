import { db } from '../db.js';

export type VectorMemoryStorage = 'pinecone' | 'qdrant';
export type VectorMemorySettings = { storage: VectorMemoryStorage };

const SETTINGS_KEY = 'vector_memory_settings';
const DEFAULT_SETTINGS: VectorMemorySettings = {
  storage: `${process.env.PINECONE_API_KEY || ''}`.trim() ? 'pinecone' : 'qdrant',
};

const normalizeSettings = (value: unknown): VectorMemorySettings => {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (source.storage === 'pinecone') return { storage: 'pinecone' };
  if (source.storage === 'qdrant' || source.storage === 'sqlite') return { storage: 'qdrant' };
  return { ...DEFAULT_SETTINGS };
};

export const getVectorMemorySettings = (): VectorMemorySettings => {
  const row = db.prepare('SELECT value_json FROM system_settings WHERE key = ?').get(SETTINGS_KEY) as
    | { value_json: string }
    | undefined;
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    return normalizeSettings(JSON.parse(row.value_json));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
};

export const getVectorMemoryStorage = (): VectorMemoryStorage => getVectorMemorySettings().storage;

export const updateVectorMemorySettings = (patch: unknown): VectorMemorySettings => {
  const source = patch && typeof patch === 'object' ? patch as Record<string, unknown> : {};
  if (source.storage !== 'pinecone' && source.storage !== 'qdrant') {
    throw new Error('bad_vector_memory_storage');
  }
  if (source.storage === 'pinecone' && !`${process.env.PINECONE_API_KEY || ''}`.trim()) {
    throw new Error('pinecone_api_key_required');
  }
  const next: VectorMemorySettings = { storage: source.storage };
  db.prepare(`
    INSERT INTO system_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(SETTINGS_KEY, JSON.stringify(next), Date.now());
  return next;
};
