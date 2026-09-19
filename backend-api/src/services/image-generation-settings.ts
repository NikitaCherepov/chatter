import dotenv from 'dotenv';
import { db } from '../db.js';

dotenv.config();

/**
 * Runtime settings for image generation, stored in `system_settings`
 * (same pattern as web-search-runtime). Environment variables are used only
 * ONCE as the seed source when the DB row is missing, so existing installs
 * keep their configuration after the migration.
 *
 * Shape notes (provider abstraction groundwork):
 * - `provider` selects the active adapter; `openrouter` is the only one today.
 * - Each provider holds its own credentials and a `model` object with cached
 *   `capabilities` (result of the admin model check) plus param policies.
 * - A policy (`allowed` + `default`) is the admin-side allowlist for a request
 *   parameter; the adapter converts the chosen value into the provider's wire
 *   format. `null` policy = parameter is not supported/exposed.
 *   The per-request dynamic tool schema for the LLM will be built from the
 *   same policies (future step).
 */

export const IMAGE_ASPECT_RATIOS = [
  'auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3',
  '4:5', '5:4', '1:2', '2:1', '1:4', '4:1', '1:8', '8:1',
  '9:21', '21:9', '9:19.5', '19.5:9', '9:20', '20:9',
] as const;
export type ImageAspectRatio = typeof IMAGE_ASPECT_RATIOS[number];

export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_IMAGE_GEN_MODEL = 'x-ai/grok-imagine-image-quality';
const LEGACY_IMAGE_GENERATION_ENABLED_KEY = 'image_generation_enabled';

export type ImageGenParamPolicy = {
  allowed: string[];
  default: string;
};

export type ImageGenModelConfig = {
  id: string;
  /** Cached result of the admin "check model" call; informational for now. */
  capabilities: unknown;
  params: {
    resolution: ImageGenParamPolicy | null;
    quality: ImageGenParamPolicy | null;
    aspectRatio: ImageGenParamPolicy;
  };
};

export type ImageGenOpenRouterSettings = {
  apiKey: string;
  baseUrl: string;
  model: ImageGenModelConfig;
};

export type ImageGenerationRuntimeSettings = {
  enabled: boolean;
  img2imgEnabled: boolean;
  provider: 'openrouter';
  openrouter: ImageGenOpenRouterSettings;
};

const SETTINGS_KEY = 'image_generation_settings';

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
      apiKey: `${process.env.OPENROUTER_API_KEY || ''}`.trim(),
      baseUrl: `${process.env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL}`.trim(),
      model: {
        id: `${process.env.IMAGE_GEN_MODEL || DEFAULT_IMAGE_GEN_MODEL}`.trim(),
        capabilities: null,
        params: {
          resolution: supported.has('resolution')
            ? { allowed: [maxResolution], default: maxResolution }
            : null,
          quality: supported.has('quality')
            ? { allowed: [quality], default: quality }
            : null,
          aspectRatio: { allowed: [...IMAGE_ASPECT_RATIOS], default: 'auto' },
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
  const base = normalizePolicy(value) ?? { allowed: [...knownRatios], default: 'auto' };
  const allowed = base.allowed.filter(ratio => knownRatios.includes(ratio));
  if (allowed.length === 0) return { allowed: [...knownRatios], default: 'auto' };
  const def = allowed.includes(base.default) ? base.default : (allowed.includes('auto') ? 'auto' : allowed[0]);
  return { allowed, default: def };
};

const normalizeSettings = (value: unknown, fallback: ImageGenerationRuntimeSettings): ImageGenerationRuntimeSettings => {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const orSource = source.openrouter && typeof source.openrouter === 'object'
    ? source.openrouter as Record<string, unknown>
    : {};
  const modelSource = orSource.model && typeof orSource.model === 'object'
    ? orSource.model as Record<string, unknown>
    : {};
  const paramsSource = modelSource.params && typeof modelSource.params === 'object'
    ? modelSource.params as Record<string, unknown>
    : {};

  const modelId = typeof modelSource.id === 'string' && modelSource.id.trim()
    ? modelSource.id.trim()
    : fallback.openrouter.model.id;

  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : fallback.enabled,
    img2imgEnabled: typeof source.img2imgEnabled === 'boolean' ? source.img2imgEnabled : fallback.img2imgEnabled,
    provider: 'openrouter',
    openrouter: {
      apiKey: typeof orSource.apiKey === 'string' ? orSource.apiKey : fallback.openrouter.apiKey,
      baseUrl: typeof orSource.baseUrl === 'string' && orSource.baseUrl.trim()
        ? orSource.baseUrl.trim()
        : fallback.openrouter.baseUrl,
      model: {
        id: modelId,
        capabilities: 'capabilities' in modelSource ? modelSource.capabilities ?? null : fallback.openrouter.model.capabilities,
        params: {
          resolution: 'resolution' in paramsSource ? normalizePolicy(paramsSource.resolution) : fallback.openrouter.model.params.resolution,
          quality: 'quality' in paramsSource ? normalizePolicy(paramsSource.quality) : fallback.openrouter.model.params.quality,
          aspectRatio: normalizeAspectRatioPolicy(paramsSource.aspectRatio ?? fallback.openrouter.model.params.aspectRatio),
        },
      },
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
  db.prepare(`
    INSERT INTO system_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(SETTINGS_KEY, JSON.stringify(settings), Date.now());
};

export const getImageGenerationSettings = (): ImageGenerationRuntimeSettings => {
  const stored = readStoredSettings();
  if (stored === null) {
    // First read after the migration: seed from env (and the legacy enabled
    // toggle), persist, and drop the legacy key so it is not picked up again.
    const seeded = seedFromEnv();
    writeStoredSettings(seeded);
    try {
      db.prepare('DELETE FROM system_settings WHERE key = ?').run(LEGACY_IMAGE_GENERATION_ENABLED_KEY);
    } catch {
      // Non-fatal: the key is simply ignored from now on.
    }
    return seeded;
  }
  return normalizeSettings(stored, seedFromEnv());
};

// ─── Updates ────────────────────────────────────────────────────────────────

const QUALITY_VALUES = ['auto', 'low', 'medium', 'high'] as const;

/**
 * Accepts both the nested runtime shape and the legacy flat fields the admin
 * panel sends today (`model`, `maxResolution`, `quality`, `supportedParameters`).
 * An empty `apiKey` string keeps the current secret (mergeSecret semantics).
 */
export const updateImageGenerationSettings = (patch: unknown): ImageGenerationRuntimeSettings => {
  const current = getImageGenerationSettings();
  const source = patch && typeof patch === 'object' && !Array.isArray(patch)
    ? patch as Record<string, unknown>
    : {};

  if ('provider' in source && source.provider !== 'openrouter') {
    throw new Error(`unsupported image generation provider: ${String(source.provider)}`);
  }

  const next = normalizeSettings({ ...current, openrouter: { ...current.openrouter } }, current);
  next.enabled = typeof source.enabled === 'boolean' ? source.enabled : current.enabled;
  next.img2imgEnabled = typeof source.img2imgEnabled === 'boolean' ? source.img2imgEnabled : current.img2imgEnabled;

  const orPatch = source.openrouter && typeof source.openrouter === 'object'
    ? source.openrouter as Record<string, unknown>
    : null;

  if (orPatch) {
    // Secret merge: an empty string means "keep the current key".
    if (typeof orPatch.apiKey === 'string' && orPatch.apiKey.trim()) {
      next.openrouter.apiKey = orPatch.apiKey.trim();
    }
    if (typeof orPatch.baseUrl === 'string' && orPatch.baseUrl.trim()) {
      next.openrouter.baseUrl = orPatch.baseUrl.trim();
    }
    const modelPatch = orPatch.model && typeof orPatch.model === 'object'
      ? orPatch.model as Record<string, unknown>
      : null;
    if (modelPatch) {
      if (typeof modelPatch.id === 'string' && modelPatch.id.trim()) {
        next.openrouter.model.id = modelPatch.id.trim();
      }
      if ('capabilities' in modelPatch) {
        next.openrouter.model.capabilities = modelPatch.capabilities ?? null;
      }
      const paramsPatch = modelPatch.params && typeof modelPatch.params === 'object'
        ? modelPatch.params as Record<string, unknown>
        : null;
      if (paramsPatch) {
        if ('resolution' in paramsPatch) next.openrouter.model.params.resolution = normalizePolicy(paramsPatch.resolution);
        if ('quality' in paramsPatch) next.openrouter.model.params.quality = normalizePolicy(paramsPatch.quality);
        if ('aspectRatio' in paramsPatch) next.openrouter.model.params.aspectRatio = normalizeAspectRatioPolicy(paramsPatch.aspectRatio);
      }
    }
  }

  // ── Legacy flat fields (current admin panel contract) ──
  // Secret merge: an empty string means "keep the current key".
  if (typeof source.apiKey === 'string' && source.apiKey.trim()) {
    next.openrouter.apiKey = source.apiKey.trim();
  }
  if (typeof source.model === 'string' && source.model.trim()) {
    next.openrouter.model.id = source.model.trim();
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
  return next;
};
