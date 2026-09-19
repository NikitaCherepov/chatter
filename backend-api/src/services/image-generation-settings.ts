import dotenv from 'dotenv';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { getEncryptionKey } from '../utils/encryption.js';

dotenv.config();

/**
 * Runtime settings for image generation, stored in `system_settings`
 * (same pattern as web-search-runtime). Environment variables are used only
 * ONCE as the seed source when the DB row is missing, so existing installs
 * keep their configuration after the migration.
 *
 * Shape notes (provider abstraction):
 * - `provider` selects the active adapter (`openrouter` | `cloudflare`).
 * - Each provider holds its own credentials and a `model` object with cached
 *   `capabilities` (result of the admin model check) plus param policies.
 * - A policy (`allowed` + `default`) stores values discovered for a request
 *   parameter plus the single admin-selected runtime default. Quality and
 *   resolution are deliberately not exposed to the LLM tool.
 * - Legacy flat fields (`model`, `maxResolution`, `quality`,
 *   `supportedParameters`, `apiKey`) map to the OPENROUTER branch only: they
 *   are the current admin panel contract, which is OpenRouter-shaped.
 */

export const IMAGE_ASPECT_RATIOS = [
  'auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3',
  '4:5', '5:4', '1:2', '2:1', '1:4', '4:1', '1:8', '8:1',
  '9:21', '21:9', '9:19.5', '19.5:9', '9:20', '20:9',
] as const;
export type ImageAspectRatio = typeof IMAGE_ASPECT_RATIOS[number];

export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_IMAGE_GEN_MODEL = 'x-ai/grok-imagine-image-quality';
export const DEFAULT_CLOUDFLARE_MODEL = '@cf/black-forest-labs/flux-2-klein-4b';
const LEGACY_IMAGE_GENERATION_ENABLED_KEY = 'image_generation_enabled';

export type ImageGenParamPolicy = {
  allowed: string[];
  default: string;
};

export type ImageGenModelConfig = {
  id: string;
  name: string;
  /** Cached result of the admin "check model" call; informational for now. */
  capabilities: unknown;
  params: {
    resolution: ImageGenParamPolicy | null;
    quality: ImageGenParamPolicy | null;
    aspectRatio: ImageGenParamPolicy;
  };
};

export type ImageGenOpenRouterSettings = {
  apiKeyId: number | null;
  apiKey: string;
  baseUrl: string;
  model: ImageGenModelConfig;
};

export type ImageGenCloudflareSettings = {
  apiTokenId: number | null;
  apiToken: string;
  accountId: string;
  model: ImageGenModelConfig;
};

export type ImageGenerationProvider = 'openrouter' | 'cloudflare';
export const IMAGE_GENERATION_PROVIDERS: readonly ImageGenerationProvider[] = ['openrouter', 'cloudflare'];

export type ImageGenerationRuntimeSettings = {
  enabled: boolean;
  img2imgEnabled: boolean;
  provider: ImageGenerationProvider;
  openrouter: ImageGenOpenRouterSettings;
  cloudflare: ImageGenCloudflareSettings;
};

const SETTINGS_KEY = 'image_generation_settings';
const VAULT_DELIMITER = '::';

const normalizeVaultId = (value: unknown): number | null => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const vaultKeyPrefix = (secret: string) => secret.length > 12
  ? `${secret.slice(0, 7)}…${secret.slice(-4)}`
  : secret.length > 4
    ? `${secret.slice(0, 3)}…${secret.slice(-4)}`
    : secret;

const encryptVaultSecret = (secret: string): string => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', getEncryptionKey(['ENCRYPTION_KEY']), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}${VAULT_DELIMITER}${encrypted.toString('hex')}`;
};

const decryptVaultSecret = (encrypted: string): string => {
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

const readVaultSecret = (id: number | null): string => {
  if (!id) return '';
  const row = db.prepare('SELECT key_encrypted FROM api_keys WHERE id = ?')
    .get(id) as { key_encrypted: string } | undefined;
  return row ? decryptVaultSecret(row.key_encrypted) : '';
};

const storeVaultSecret = (currentId: number | null, name: string, secret: string): number => {
  const encrypted = encryptVaultSecret(secret);
  const prefix = vaultKeyPrefix(secret);
  if (currentId && db.prepare('SELECT id FROM api_keys WHERE id = ?').get(currentId)) {
    db.prepare(`
      UPDATE api_keys
      SET name = ?, key_encrypted = ?, key_prefix = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(name, encrypted, prefix, currentId);
    return currentId;
  }
  const result = db.prepare(
    'INSERT INTO api_keys (name, key_encrypted, key_prefix) VALUES (?, ?, ?)'
  ).run(name, encrypted, prefix);
  return Number(result.lastInsertRowid);
};

const requireVaultKey = (value: unknown): number | null => {
  if (value === null) return null;
  const id = normalizeVaultId(value);
  if (!id || !db.prepare('SELECT id FROM api_keys WHERE id = ?').get(id)) {
    throw new Error('api_key_not_found');
  }
  return id;
};

// ─── Defaults ───────────────────────────────────────────────────────────────

const defaultAspectPolicy = (): ImageGenParamPolicy => ({
  allowed: [...IMAGE_ASPECT_RATIOS],
  default: 'auto',
});

// ─── Seeding (env → DB, one time) ───────────────────────────────────────────

const readLegacyEnabled = (): boolean => {
  try {
    const row = db.prepare('SELECT value_json FROM system_settings WHERE key = ?')
      .get(LEGACY_IMAGE_GENERATION_ENABLED_KEY) as { value_json: string } | undefined;
    if (!row) return true;
    return JSON.parse(row.value_json) === true;
  } catch {
    return true;
  }
};

const seedFromEnv = (): ImageGenerationRuntimeSettings => {
  const supported = new Set(
    `${process.env.IMAGE_GEN_SUPPORTED_PARAMETERS === undefined
      ? 'resolution,input_references'
      : process.env.IMAGE_GEN_SUPPORTED_PARAMETERS}`
      .split(',')
      .map(value => value.trim())
      .filter(value => ['resolution', 'quality', 'input_references'].includes(value))
  );
  const maxResolution = process.env.IMAGE_GEN_MAX_RESOLUTION === '1K' ? '1K' : '2K';
  const quality = ['low', 'medium', 'high'].includes(`${process.env.IMAGE_GEN_QUALITY || ''}`)
    ? `${process.env.IMAGE_GEN_QUALITY}`
    : 'auto';

  return {
    enabled: readLegacyEnabled(),
    img2imgEnabled: supported.has('input_references'),
    provider: 'openrouter',
    openrouter: {
      apiKeyId: null,
      apiKey: `${process.env.OPENROUTER_API_KEY || ''}`.trim(),
      baseUrl: `${process.env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL}`.trim(),
      model: {
        id: `${process.env.IMAGE_GEN_MODEL || DEFAULT_IMAGE_GEN_MODEL}`.trim(),
        name: 'Grok Imagine',
        capabilities: null,
        params: {
          resolution: supported.has('resolution')
            ? { allowed: [maxResolution], default: maxResolution }
            : null,
          quality: supported.has('quality')
            ? { allowed: [quality], default: quality }
            : null,
          aspectRatio: defaultAspectPolicy(),
        },
      },
    },
    cloudflare: {
      apiTokenId: null,
      apiToken: '',
      accountId: '',
      model: {
        id: DEFAULT_CLOUDFLARE_MODEL,
        name: 'FLUX.2 [klein] 4B',
        capabilities: null,
        params: {
          // width/height are derived from aspect ratio + quality by the adapter,
          // so there is no discrete "resolution" (1K/2K) concept for Cloudflare.
          resolution: null,
          quality: { allowed: ['auto', 'low', 'medium', 'high'], default: 'auto' },
          aspectRatio: defaultAspectPolicy(),
        },
      },
    },
  };
};

// ─── Normalization ──────────────────────────────────────────────────────────

const normalizePolicy = (value: unknown): ImageGenParamPolicy | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const allowed = Array.isArray(source.allowed)
    ? source.allowed.map(item => `${item}`.trim()).filter(Boolean)
    : [];
  if (allowed.length === 0) return null;
  const def = `${source.default ?? ''}`.trim();
  return { allowed: [...new Set(allowed)], default: allowed.includes(def) ? def : allowed[0] };
};

const normalizeAspectRatioPolicy = (value: unknown): ImageGenParamPolicy => {
  const knownRatios = IMAGE_ASPECT_RATIOS as readonly string[];
  const base = normalizePolicy(value) ?? defaultAspectPolicy();
  const allowed = base.allowed.filter(ratio => knownRatios.includes(ratio));
  if (allowed.length === 0) return defaultAspectPolicy();
  const def = allowed.includes(base.default) ? base.default : (allowed.includes('auto') ? 'auto' : allowed[0]);
  return { allowed, default: def };
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const normalizeModelConfig = (source: unknown, fallback: ImageGenModelConfig): ImageGenModelConfig => {
  const modelSource = asRecord(source);
  const paramsSource = asRecord(modelSource.params);
  const id = typeof modelSource.id === 'string' && modelSource.id.trim()
    ? modelSource.id.trim()
    : fallback.id;
  const knownParams = [
    'resolution' in paramsSource ? normalizePolicy(paramsSource.resolution) : fallback.params.resolution,
    'quality' in paramsSource ? normalizePolicy(paramsSource.quality) : fallback.params.quality,
    normalizeAspectRatioPolicy(paramsSource.aspectRatio ?? fallback.params.aspectRatio),
  ] as const;
  return {
    id,
    name: typeof modelSource.name === 'string' && modelSource.name.trim()
      ? modelSource.name.trim()
      : (id === fallback.id ? fallback.name : id),
    capabilities: 'capabilities' in modelSource ? modelSource.capabilities ?? null : fallback.capabilities,
    params: {
      resolution: knownParams[0],
      quality: knownParams[1],
      aspectRatio: knownParams[2],
    },
  };
};

const normalizeSettings = (value: unknown, fallback: ImageGenerationRuntimeSettings): ImageGenerationRuntimeSettings => {
  const source = asRecord(value);
  const orSource = asRecord(source.openrouter);
  const cfSource = asRecord(source.cloudflare);
  const provider: ImageGenerationProvider =
    source.provider === 'cloudflare' ? 'cloudflare' : 'openrouter';

  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : fallback.enabled,
    img2imgEnabled: typeof source.img2imgEnabled === 'boolean' ? source.img2imgEnabled : fallback.img2imgEnabled,
    provider: IMAGE_GENERATION_PROVIDERS.includes(provider) ? provider : 'openrouter',
    openrouter: {
      apiKeyId: normalizeVaultId(orSource.apiKeyId) ?? fallback.openrouter.apiKeyId,
      apiKey: typeof orSource.apiKey === 'string' ? orSource.apiKey : fallback.openrouter.apiKey,
      baseUrl: typeof orSource.baseUrl === 'string' && orSource.baseUrl.trim()
        ? orSource.baseUrl.trim()
        : fallback.openrouter.baseUrl,
      model: normalizeModelConfig(orSource.model, fallback.openrouter.model),
    },
    cloudflare: {
      apiTokenId: normalizeVaultId(cfSource.apiTokenId) ?? fallback.cloudflare.apiTokenId,
      apiToken: typeof cfSource.apiToken === 'string' ? cfSource.apiToken : fallback.cloudflare.apiToken,
      accountId: typeof cfSource.accountId === 'string' ? cfSource.accountId.trim() : fallback.cloudflare.accountId,
      model: normalizeModelConfig(cfSource.model, fallback.cloudflare.model),
    },
  };
};

// ─── Storage ────────────────────────────────────────────────────────────────

const readStoredSettings = (): unknown => {
  const row = db.prepare('SELECT value_json FROM system_settings WHERE key = ?').get(SETTINGS_KEY) as
    | { value_json: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return null;
  }
};

const writeStoredSettings = (settings: ImageGenerationRuntimeSettings) => {
  const persisted = {
    ...settings,
    openrouter: { ...settings.openrouter, apiKey: '' },
    cloudflare: { ...settings.cloudflare, apiToken: '' },
  };
  db.prepare(`
    INSERT INTO system_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(SETTINGS_KEY, JSON.stringify(persisted), Date.now());
};

const migratePlaintextSecrets = (settings: ImageGenerationRuntimeSettings): boolean => {
  let changed = false;
  if (settings.openrouter.apiKey.trim()) {
    settings.openrouter.apiKeyId = storeVaultSecret(
      settings.openrouter.apiKeyId,
      'Image generation · OpenRouter',
      settings.openrouter.apiKey.trim(),
    );
    settings.openrouter.apiKey = '';
    changed = true;
  }
  if (settings.cloudflare.apiToken.trim()) {
    settings.cloudflare.apiTokenId = storeVaultSecret(
      settings.cloudflare.apiTokenId,
      'Image generation · Cloudflare',
      settings.cloudflare.apiToken.trim(),
    );
    settings.cloudflare.apiToken = '';
    changed = true;
  }
  return changed;
};

const hydrateSecrets = (settings: ImageGenerationRuntimeSettings): ImageGenerationRuntimeSettings => ({
  ...settings,
  openrouter: { ...settings.openrouter, apiKey: readVaultSecret(settings.openrouter.apiKeyId) },
  cloudflare: { ...settings.cloudflare, apiToken: readVaultSecret(settings.cloudflare.apiTokenId) },
});

export const getImageGenerationSettings = (): ImageGenerationRuntimeSettings => {
  const stored = readStoredSettings();
  if (stored === null) {
    // First read after the migration: seed from env (and the legacy enabled
    // toggle), persist, and drop the legacy key so it is not picked up again.
    const seeded = seedFromEnv();
    migratePlaintextSecrets(seeded);
    writeStoredSettings(seeded);
    try {
      db.prepare('DELETE FROM system_settings WHERE key = ?').run(LEGACY_IMAGE_GENERATION_ENABLED_KEY);
    } catch {
      // Non-fatal: the key is simply ignored from now on.
    }
    return hydrateSecrets(seeded);
  }
  const normalized = normalizeSettings(stored, seedFromEnv());
  if (migratePlaintextSecrets(normalized)) writeStoredSettings(normalized);
  return hydrateSecrets(normalized);
};

// ─── Updates ────────────────────────────────────────────────────────────────

const QUALITY_VALUES = ['auto', 'low', 'medium', 'high'] as const;

/**
 * Applies a nested patch to one provider's model config:
 * `{ id?, capabilities?, params? { resolution?, quality?, aspectRatio? } }`.
 */
const applyModelPatch = (target: ImageGenModelConfig, patch: unknown) => {
  const modelPatch = asRecord(patch);
  if (typeof modelPatch.id === 'string' && modelPatch.id.trim()) {
    target.id = modelPatch.id.trim();
    if (!(typeof modelPatch.name === 'string' && modelPatch.name.trim())) {
      target.name = target.id;
    }
  }
  if (typeof modelPatch.name === 'string' && modelPatch.name.trim()) {
    target.name = modelPatch.name.trim();
  }
  if ('capabilities' in modelPatch) {
    target.capabilities = modelPatch.capabilities ?? null;
  }
  const paramsPatch = asRecord(modelPatch.params);
  if ('resolution' in paramsPatch) target.params.resolution = normalizePolicy(paramsPatch.resolution);
  if ('quality' in paramsPatch) target.params.quality = normalizePolicy(paramsPatch.quality);
  if ('aspectRatio' in paramsPatch) target.params.aspectRatio = normalizeAspectRatioPolicy(paramsPatch.aspectRatio);
};

/**
 * Accepts the nested runtime shape for both providers plus the legacy flat
 * fields the admin panel sends today (`model`, `maxResolution`, `quality`,
 * `supportedParameters` — OpenRouter-only mapping). Empty secret strings
 * (openrouter `apiKey`, cloudflare `apiToken`) keep the current value
 * (mergeSecret semantics).
 */
export const updateImageGenerationSettings = (patch: unknown): ImageGenerationRuntimeSettings => {
  const current = getImageGenerationSettings();
  const source = asRecord(patch);

  if ('provider' in source && !IMAGE_GENERATION_PROVIDERS.includes(source.provider as ImageGenerationProvider)) {
    throw new Error(`unsupported image generation provider: ${String(source.provider)}`);
  }

  const next = normalizeSettings({
    ...current,
    openrouter: { ...current.openrouter, model: { ...current.openrouter.model, params: { ...current.openrouter.model.params } } },
    cloudflare: { ...current.cloudflare, model: { ...current.cloudflare.model, params: { ...current.cloudflare.model.params } } },
  }, current);
  if (typeof source.enabled === 'boolean') next.enabled = source.enabled;
  if (typeof source.img2imgEnabled === 'boolean') next.img2imgEnabled = source.img2imgEnabled;
  if (source.provider === 'openrouter' || source.provider === 'cloudflare') next.provider = source.provider;

  // ── openrouter nested patch ──
  const orPatch = asRecord(source.openrouter);
  if (source.openrouter !== undefined && Object.keys(orPatch).length > 0) {
    if ('apiKeyId' in orPatch) {
      next.openrouter.apiKeyId = requireVaultKey(orPatch.apiKeyId);
    }
    // Backward-compatible direct secret input is immediately encrypted into the vault.
    if (typeof orPatch.apiKey === 'string' && orPatch.apiKey.trim()) {
      next.openrouter.apiKeyId = storeVaultSecret(
        next.openrouter.apiKeyId,
        'Image generation · OpenRouter',
        orPatch.apiKey.trim(),
      );
    }
    if (typeof orPatch.baseUrl === 'string' && orPatch.baseUrl.trim()) {
      next.openrouter.baseUrl = orPatch.baseUrl.trim();
    }
    if (orPatch.model !== undefined) {
      applyModelPatch(next.openrouter.model, orPatch.model);
    }
  }

  // ── cloudflare nested patch ──
  const cfPatch = asRecord(source.cloudflare);
  if (source.cloudflare !== undefined && Object.keys(cfPatch).length > 0) {
    if ('apiTokenId' in cfPatch) {
      next.cloudflare.apiTokenId = requireVaultKey(cfPatch.apiTokenId);
    }
    // Backward-compatible direct secret input is immediately encrypted into the vault.
    if (typeof cfPatch.apiToken === 'string' && cfPatch.apiToken.trim()) {
      next.cloudflare.apiTokenId = storeVaultSecret(
        next.cloudflare.apiTokenId,
        'Image generation · Cloudflare',
        cfPatch.apiToken.trim(),
      );
    }
    if (typeof cfPatch.accountId === 'string') {
      next.cloudflare.accountId = cfPatch.accountId.trim();
    }
    if (cfPatch.model !== undefined) {
      applyModelPatch(next.cloudflare.model, cfPatch.model);
    }
  }

  // ── Legacy flat fields (current admin panel contract, OpenRouter-shaped) ──
  // Secret merge: an empty string means "keep the current key".
  if (typeof source.apiKey === 'string' && source.apiKey.trim()) {
    next.openrouter.apiKeyId = storeVaultSecret(
      next.openrouter.apiKeyId,
      'Image generation · OpenRouter',
      source.apiKey.trim(),
    );
  }
  if (typeof source.model === 'string' && source.model.trim()) {
    next.openrouter.model.id = source.model.trim();
    next.openrouter.model.name = next.openrouter.model.id;
  }
  const supportedParametersRaw = Array.isArray(source.supportedParameters) ? source.supportedParameters : null;
  const hasSupportedList = supportedParametersRaw !== null;
  const supportedList = supportedParametersRaw
    ? new Set(supportedParametersRaw
        .map(value => `${value}`.trim())
        .filter(value => ['resolution', 'quality', 'input_references'].includes(value)))
    : null;

  if (typeof source.maxResolution === 'string' && ['1K', '2K'].includes(source.maxResolution)) {
    if (next.openrouter.model.params.resolution || supportedList?.has('resolution')) {
      next.openrouter.model.params.resolution = { allowed: [source.maxResolution], default: source.maxResolution };
    }
  }
  if (typeof source.quality === 'string' && (QUALITY_VALUES as readonly string[]).includes(source.quality)) {
    if (next.openrouter.model.params.quality || supportedList?.has('quality')) {
      next.openrouter.model.params.quality = { allowed: [source.quality], default: source.quality };
    }
  }
  if (hasSupportedList) {
    next.img2imgEnabled = supportedList!.has('input_references');
    if (!supportedList!.has('resolution')) next.openrouter.model.params.resolution = null;
    if (!supportedList!.has('quality')) next.openrouter.model.params.quality = null;
  }

  writeStoredSettings(next);
  return hydrateSecrets(next);
};

export const getImageGenerationApiKeyUsage = (keyId: number): string[] => {
  const settings = getImageGenerationSettings();
  return [
    settings.openrouter.apiKeyId === keyId ? 'Image generation · OpenRouter' : null,
    settings.cloudflare.apiTokenId === keyId ? 'Image generation · Cloudflare' : null,
  ].filter((value): value is string => Boolean(value));
};

export const replaceImageGenerationApiKeyReference = (
  keyId: number,
  replacementKeyId: number | null,
): void => {
  const settings = getImageGenerationSettings();
  let changed = false;
  if (settings.openrouter.apiKeyId === keyId) {
    settings.openrouter.apiKeyId = replacementKeyId;
    settings.openrouter.apiKey = '';
    changed = true;
  }
  if (settings.cloudflare.apiTokenId === keyId) {
    settings.cloudflare.apiTokenId = replacementKeyId;
    settings.cloudflare.apiToken = '';
    changed = true;
  }
  if (changed) writeStoredSettings(settings);
};
