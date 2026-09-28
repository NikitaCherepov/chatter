import crypto from 'node:crypto';
import { db } from '../db.js';
import { getEncryptionKey } from '../utils/encryption.js';

export type VectorMemoryProvider = 'openrouter' | 'custom';
export type VectorMemorySettings = {
  storage: 'qdrant';
  provider: VectorMemoryProvider;
  baseUrl: string;
  model: string;
  apiKeyId: number | null;
  activeCollection: string;
};

export type VectorMemoryPublicSettings = VectorMemorySettings & { hasApiKey: boolean };

const SETTINGS_KEY = 'vector_memory_settings';
const DEFAULT_COLLECTION = 'chatter_memory';
const VAULT_DELIMITER = '::';

const normalizeId = (value: unknown): number | null => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const decryptSecret = (encrypted: string): string => {
  const [ivHex, payloadHex] = encrypted.split(VAULT_DELIMITER);
  if (!ivHex || !payloadHex) throw new Error('invalid_api_key_ciphertext');
  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    getEncryptionKey(['ENCRYPTION_KEY']),
    Buffer.from(ivHex, 'hex'),
  );
  return Buffer.concat([
    decipher.update(Buffer.from(payloadHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
};

const storeLegacySecret = (secret: string): number => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', getEncryptionKey(['ENCRYPTION_KEY']), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const prefix = secret.length > 12
    ? `${secret.slice(0, 7)}…${secret.slice(-4)}`
    : secret.length > 4 ? `${secret.slice(0, 3)}…${secret.slice(-4)}` : secret;
  const result = db.prepare(
    'INSERT INTO api_keys (name, key_encrypted, key_prefix) VALUES (?, ?, ?)'
  ).run('Vector memory embeddings', `${iv.toString('hex')}${VAULT_DELIMITER}${encrypted.toString('hex')}`, prefix);
  return Number(result.lastInsertRowid);
};

const requireApiKeyId = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const id = normalizeId(value);
  if (!id || !db.prepare('SELECT id FROM api_keys WHERE id = ?').get(id)) {
    throw new Error('api_key_not_found');
  }
  return id;
};

const readSecret = (id: number | null): string => {
  if (!id) return '';
  const row = db.prepare('SELECT key_encrypted FROM api_keys WHERE id = ?').get(id) as
    | { key_encrypted: string }
    | undefined;
  return row ? decryptSecret(row.key_encrypted) : '';
};

export const getVectorMemoryApiKey = (id: number | null) => readSecret(id);

export const getVectorMemoryApiKeyUsage = (id: number): string[] => {
  const settings = readSettings();
  const usages = settings.apiKeyId === id ? ['Vector memory · active embedding model'] : [];
  const backups = db.prepare(`
    SELECT model FROM vector_memory_collections
    WHERE api_key_id = ? AND status <> 'active'
    ORDER BY created_at DESC
  `).all(id) as Array<{ model: string }>;
  return [...usages, ...backups.map(row => `Vector memory backup · ${row.model}`)];
};

export const replaceVectorMemoryApiKeyReference = (currentId: number, replacementId: number | null) => {
  const settings = readSettings();
  if (settings.apiKeyId === currentId) {
    writeSettings({ ...settings, apiKeyId: replacementId });
  }
  db.prepare('UPDATE vector_memory_collections SET api_key_id = ?, updated_at = ? WHERE api_key_id = ?')
    .run(replacementId, Date.now(), currentId);
};

const normalizeCollectionName = (value: unknown) => {
  const name = `${value || ''}`.trim();
  if (!name || !/^[a-zA-Z0-9_-]{1,120}$/.test(name)) throw new Error('bad_qdrant_collection_name');
  return name;
};

const seedFromEnv = (): VectorMemorySettings => {
  const baseUrl = `${process.env.TIMEWEB_EMBED_BASE_URL || process.env.TIMEWEB_BASE_URL || 'https://openrouter.ai/api/v1'}`.trim();
  const legacySecret = `${process.env.TIMEWEB_EMBED_API_KEY || ''}`.trim();
  return {
    storage: 'qdrant',
    provider: /openrouter\.ai/i.test(baseUrl) ? 'openrouter' : 'custom',
    baseUrl,
    model: `${process.env.TIMEWEB_EMBED_MODEL || process.env.VECTOR_EMBED_MODEL || 'text-embedding-3-small'}`.trim(),
    apiKeyId: legacySecret ? storeLegacySecret(legacySecret) : null,
    activeCollection: `${process.env.QDRANT_COLLECTION || DEFAULT_COLLECTION}`.trim() || DEFAULT_COLLECTION,
  };
};

const normalizeSettings = (value: unknown, fallback: VectorMemorySettings): VectorMemorySettings => {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const provider: VectorMemoryProvider = source.provider === 'openrouter' ? 'openrouter' : 'custom';
  return {
    storage: 'qdrant',
    provider,
    baseUrl: `${source.baseUrl || fallback.baseUrl}`.trim(),
    model: `${source.model || fallback.model}`.trim(),
    apiKeyId: normalizeId(source.apiKeyId) ?? fallback.apiKeyId,
    activeCollection: normalizeCollectionName(source.activeCollection || fallback.activeCollection),
  };
};

const writeSettings = (settings: VectorMemorySettings) => {
  db.prepare(`
    INSERT INTO system_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(SETTINGS_KEY, JSON.stringify(settings), Date.now());
};

const ensureActiveRegistry = (settings: VectorMemorySettings) => {
  const now = Date.now();
  db.prepare(`
    INSERT INTO vector_memory_collections (
      collection_name, provider, base_url, model, api_key_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(collection_name) DO UPDATE SET
      provider = excluded.provider,
      base_url = excluded.base_url,
      model = excluded.model,
      api_key_id = excluded.api_key_id,
      status = 'active',
      updated_at = excluded.updated_at
    WHERE vector_memory_collections.provider <> excluded.provider
       OR vector_memory_collections.base_url <> excluded.base_url
       OR vector_memory_collections.model <> excluded.model
       OR vector_memory_collections.api_key_id IS NOT excluded.api_key_id
       OR vector_memory_collections.status <> 'active'
  `).run(
    settings.activeCollection,
    settings.provider,
    settings.baseUrl,
    settings.model,
    settings.apiKeyId,
    now,
    now,
  );
};

const readSettings = (): VectorMemorySettings => {
  const row = db.prepare('SELECT value_json FROM system_settings WHERE key = ?').get(SETTINGS_KEY) as
    | { value_json: string }
    | undefined;
  if (!row) {
    const seeded = seedFromEnv();
    writeSettings(seeded);
    ensureActiveRegistry(seeded);
    return seeded;
  }
  let parsed: unknown = null;
  try { parsed = JSON.parse(row.value_json); } catch { /* use the safe fallback */ }
  const parsedRecord = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  // Older rows contained only `{ storage }`. Seed their missing runtime fields
  // once from env, then persist the complete DB-backed form.
  const fallback = ('model' in parsedRecord && 'baseUrl' in parsedRecord && 'activeCollection' in parsedRecord)
    ? {
        storage: 'qdrant' as const,
        provider: 'custom' as const,
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'text-embedding-3-small',
        apiKeyId: null,
        activeCollection: DEFAULT_COLLECTION,
      }
    : seedFromEnv();
  const normalized = normalizeSettings(parsed, fallback);
  if (JSON.stringify(parsed) !== JSON.stringify(normalized)) writeSettings(normalized);
  ensureActiveRegistry(normalized);
  return normalized;
};

export const getVectorMemorySettings = (): VectorMemoryPublicSettings => {
  const settings = readSettings();
  return { ...settings, hasApiKey: Boolean(readSecret(settings.apiKeyId)) };
};

export const getVectorMemoryRuntimeSettings = () => {
  const settings = readSettings();
  return { ...settings, apiKey: readSecret(settings.apiKeyId) };
};

// Keep the legacy union in the return type while older Pinecone branches are
// being retired; runtime selection is intentionally fixed to local Qdrant.
export const getVectorMemoryStorage = (): 'qdrant' | 'pinecone' => 'qdrant';

export const updateVectorMemorySettings = (patch: unknown): VectorMemoryPublicSettings => {
  const source = patch && typeof patch === 'object' ? patch as Record<string, unknown> : {};
  const current = readSettings();
  const next = normalizeSettings({
    ...current,
    ...source,
    apiKeyId: 'apiKeyId' in source ? requireApiKeyId(source.apiKeyId) : current.apiKeyId,
  }, current);
  if (!next.baseUrl || !next.model || !next.apiKeyId) throw new Error('embedding_configuration_required');
  if (
    next.activeCollection !== current.activeCollection
    || next.provider !== current.provider
    || next.baseUrl !== current.baseUrl
    || next.model !== current.model
  ) {
    throw new Error('embedding_migration_required');
  }
  writeSettings(next);
  ensureActiveRegistry(next);
  return getVectorMemorySettings();
};

export const activateVectorMemoryCollection = (settings: VectorMemorySettings) => {
  db.transaction(() => {
    db.prepare(`
      UPDATE vector_memory_collections
      SET status = 'backup', updated_at = ?
      WHERE status = 'active' AND collection_name <> ?
    `).run(Date.now(), settings.activeCollection);
    writeSettings(settings);
    ensureActiveRegistry(settings);
  })();
};
