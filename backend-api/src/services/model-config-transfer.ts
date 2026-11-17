import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Readable } from 'node:stream';
import { db } from '../db.js';
import { extractBackupStream } from './sillytavern-archive-stream.js';
import { allModels, getModelSettings, modelApiKey, importModelKey, updateModelSettings, type ConfiguredModel } from './model-settings.js';
import { getModelOverride, setModelProvider, refreshCoefficientCache } from './token-quota.js';
import { getImageGenerationSettings, updateImageGenerationSettings, type ImageGenerationRuntimeSettings } from './image-generation-settings.js';

type Role = 'pro' | 'lite' | 'manual' | 'vision';
export type TransferModel = ConfiguredModel & { roles: Role[]; keyRef?: string; billing?: Record<string, any> };
export type TransferImageGeneration = Pick<ImageGenerationRuntimeSettings, 'enabled' | 'img2imgEnabled' | 'provider'> & {
  openrouter: Omit<ImageGenerationRuntimeSettings['openrouter'], 'apiKey'> & { keyRef?: string };
  cloudflare: Omit<ImageGenerationRuntimeSettings['cloudflare'], 'apiToken'> & { keyRef?: string };
};
export type TransferConfig = { format: 'chatter-models'; version: 1; models: TransferModel[]; keys: { id: string; sourceId?: number; name: string; key?: string }[]; warnings: string[]; autoVision?: { pro: boolean; lite: boolean }; imageGeneration?: TransferImageGeneration };
const providers: Record<string, { url: string; field: string; secret: string }> = {
  openrouter: { url: 'https://openrouter.ai/api/v1', field: 'openrouter_model', secret: 'api_key_openrouter' },
  openai: { url: 'https://api.openai.com/v1', field: 'openai_model', secret: 'api_key_openai' },
  deepseek: { url: 'https://api.deepseek.com/v1', field: 'deepseek_model', secret: 'api_key_deepseek' },
  claude: { url: '', field: 'claude_model', secret: 'api_key_claude' },
  google: { url: 'https://generativelanguage.googleapis.com/v1beta/openai', field: 'google_model', secret: 'api_key_makersuite' },
  custom: { url: '', field: 'custom_model', secret: 'api_key_custom' },
};
const safeObject = (value: any) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

export function exportModelConfig(includeKeys: boolean): TransferConfig {
  const s = getModelSettings();
  const models: TransferModel[] = [];
  const keys = new Map<number, TransferConfig['keys'][number]>();
  const addKey = (keyId: number | null, fallbackName: string) => {
    if (!keyId) return undefined;
    if (!keys.has(keyId)) {
      const row = db.prepare('SELECT name FROM api_keys WHERE id = ?').get(keyId) as { name: string } | undefined;
      keys.set(keyId, { id: String(keyId), sourceId: keyId, name: row?.name || fallbackName,
        ...(includeKeys ? { key: modelApiKey(keyId) } : {}) });
    }
    return String(keyId);
  };
  for (const [role, items] of [['pro', s.proModels], ['lite', s.liteModels], ['manual', s.manualModels], ['vision', [s.visionModel]]] as [Role, ConfiguredModel[]][]) {
    for (const m of items.filter(m => m.model)) {
      const override = getModelOverride(m.uniqueId);
      const keyId = m.apiKeyId;
      const keyRef = addKey(keyId, m.model);
      const billing = override ? {
        coefficient: override.coefficient, providerKind: override.provider_kind, openrouterProviderSlug: override.openrouter_provider_slug,
        pricingMode: override.pricing_mode, inputPricePerMillion: override.input_price_per_million,
        outputPricePerMillion: override.output_price_per_million, cacheReadPricePerMillion: override.cache_read_price_per_million,
        pricingSource: override.pricing_source, isFree: Boolean(override.is_free), intelTier: override.intel_tier,
        priceTier: override.price_tier, contextLength: override.context_length,
      } : undefined;
      models.push({ ...m, apiKeyId: null, roles: [role], keyRef, billing });
    }
  }
  const image = getImageGenerationSettings();
  const imageGeneration: TransferImageGeneration = {
    enabled: image.enabled, img2imgEnabled: image.img2imgEnabled, provider: image.provider,
    openrouter: {
      baseUrl: image.openrouter.baseUrl, model: image.openrouter.model, apiKeyId: null,
      keyRef: addKey(image.openrouter.apiKeyId, 'Image generation · OpenRouter'),
    },
    cloudflare: {
      accountId: image.cloudflare.accountId, model: image.cloudflare.model, apiTokenId: null,
      keyRef: addKey(image.cloudflare.apiTokenId, 'Image generation · Cloudflare'),
    },
  };
  return { format: 'chatter-models', version: 1, models, keys: [...keys.values()], warnings: [], autoVision: { pro: s.proSupportsVision, lite: s.liteSupportsVision }, imageGeneration };
}

function validateImageGeneration(value: TransferImageGeneration | undefined) {
  if (value === undefined) return;
  if (!value || typeof value.enabled !== 'boolean' || typeof value.img2imgEnabled !== 'boolean' ||
      !['openrouter', 'cloudflare'].includes(value.provider) ||
      typeof value.openrouter?.baseUrl !== 'string' || typeof value.cloudflare?.accountId !== 'string')
    throw new Error('invalid_image_model_config');
  const url = new URL(value.openrouter.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('invalid_image_model_config');
  for (const provider of ['openrouter', 'cloudflare'] as const) {
    const branch = value[provider];
    const keyId = provider === 'openrouter' ? value.openrouter.apiKeyId : value.cloudflare.apiTokenId;
    if (!branch || (branch.keyRef !== undefined && typeof branch.keyRef !== 'string') ||
        (keyId !== null && (!Number.isSafeInteger(keyId) || Number(keyId) <= 0)) ||
        typeof branch.model?.id !== 'string' || !branch.model.id.trim() ||
        typeof branch.model.name !== 'string' || !branch.model.params)
      throw new Error('invalid_image_model_config');
    for (const policy of Object.values(branch.model.params)) {
      if (policy !== null && (!policy || !Array.isArray(policy.allowed) ||
          policy.allowed.length > 100 || policy.allowed.some((item: unknown) => typeof item !== 'string') ||
          typeof policy.default !== 'string'))
        throw new Error('invalid_image_model_config');
    }
  }
}

export function parseModelConfig(files: { name: string; data: Buffer }[]): TransferConfig {
  const parse = (file: { data: Buffer }) => { if (file.data.length > 2 * 1024 * 1024) throw new Error('model_config_file_too_large'); return JSON.parse(file.data.toString('utf8').replace(/^\uFEFF/, '')); };
  const native = files.length === 1 && parse(files[0]).format === 'chatter-models' ? files[0] : undefined;
  if (native) {
    const data = parse(native);
    if (data.format !== 'chatter-models' || data.version !== 1 || !Array.isArray(data.models) || !Array.isArray(data.keys) || data.models.length > 800 || data.keys.length > 500) throw new Error('invalid_model_config');
    if (data.models.some((m: any) => !m || typeof m.model !== 'string' || typeof m.baseUrl !== 'string' || !Array.isArray(m.roles) || m.roles.some((r: any) => !['pro', 'lite', 'manual', 'vision'].includes(r))) ||
      data.keys.some((k: any) => !k || typeof k.id !== 'string' || typeof k.name !== 'string' || (k.key !== undefined && typeof k.key !== 'string'))) throw new Error('invalid_model_config');
    validateImageGeneration(data.imageGeneration);
    const hasChatGpt = data.models.some((model: any) => model.auth === 'chatgpt');
    return { ...data, models: data.models.filter((model: any) => model.auth !== 'chatgpt'), warnings: hasChatGpt ? ['chatgpt_reconnect_required'] : [] };
  }
  const settings = files.filter(f => /(^|\/)settings\.json$/i.test(f.name));
  if (settings.length > 1) throw new Error('model_config_multiple_users');
  const root = settings[0] ? parse(settings[0]) : {};
  const directory = settings[0]?.name.slice(0, -'settings.json'.length) || '';
  const secretsFile = files.find(f => f.name === `${directory}secrets.json`);
  const secrets = secretsFile ? safeObject(parse(secretsFile)) : {};
  const keys: TransferConfig['keys'] = [];
  const active = new Map<string, string>();
  for (const [kind, raw] of Object.entries(secrets)) {
    const entries = typeof raw === 'string' ? [{ id: kind, value: raw, active: true, label: kind }] : Array.isArray(raw) ? raw : [];
    for (const entry of entries) if (typeof entry.value === 'string' && entry.value.trim()) {
      const id = String(entry.id || `${kind}-${keys.length}`);
      keys.push({ id, name: String(entry.label || kind), key: entry.value });
      if (entry.active) active.set(kind, id);
    }
  }
  const warnings = ['st_settings_not_transferred'];
  const models: TransferModel[] = [];
  const add = (api: string, model: unknown, url: unknown, id: string, name?: string, keyRef?: string) => {
    if (typeof model !== 'string' || !model.trim()) return;
    const provider = providers[api];
    const baseUrl = typeof url === 'string' && url.trim() ? url : provider?.url || '';
    const ref = keyRef || (provider ? active.get(provider.secret) : undefined) || `missing-${api}`;
    if (!keys.some(k => k.id === ref)) keys.push({ id: ref, name: name || api || 'API key' });
    if (provider && !active.has(provider.secret)) active.set(provider.secret, ref);
    if (models.some(m => m.model === model && m.baseUrl === baseUrl && m.keyRef === ref)) return;
    models.push({ id, uniqueId: id, baseUrl, model, name: name || model, apiKeyId: null, keyRef: ref, roles: ['manual'] });
    if (!baseUrl) warnings.push('st_connection_needs_configuration');
  };
  const profiles = root.extension_settings?.connectionManager?.profiles || [];
  if (Array.isArray(profiles)) for (const p of profiles) {
    if (p.mode && p.mode !== 'cc') { warnings.push('st_text_completion_not_supported'); continue; }
    add(String(p.api || ''), p.model, p['api-url'], `st-${p.id || crypto.randomUUID()}`, p.name, p['secret-id']);
  }
  const presets = files.filter(f => (f.name.startsWith(directory) && /(^|\/)OpenAI Settings\/[^/]+\.json$/i.test(f.name)) || (!settings.length && files.length === 1));
  const oai = root.oai_settings || root.openai_settings || {};
  for (const data of [oai, ...presets.map(parse)]) {
    const api = String(data.chat_completion_source || 'openai');
    const provider = providers[api];
    add(api, data[provider?.field || `${api}_model`], api === 'custom' ? data.custom_url : undefined,
      `st-${crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16)}`);
  }
  if (!models.length) throw new Error('model_config_no_models');
  return { format: 'chatter-models', version: 1, models, keys, warnings: [...new Set(warnings)] };
}

export async function parseModelArchive(input: Readable) {
  const root = path.resolve(process.env.UPLOADS_DIR || 'uploads', '.model-config-imports');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'import-'));
  try {
    const entries = await extractBackupStream(input, directory, name => /(^|\/)(settings|secrets)\.json$/i.test(name) || /(^|\/)OpenAI Settings\/[^/]+\.json$/i.test(name));
    return parseModelConfig(entries.filter(entry => entry.size));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

export function importModelConfig(input: TransferConfig) {
  if (input.format !== 'chatter-models' || input.version !== 1 || !Array.isArray(input.models) || input.models.length > 800 || !Array.isArray(input.keys) || input.keys.length > 500) throw new Error('invalid_model_config');
  const allowed: Role[] = ['pro', 'lite', 'manual', 'vision'];
  validateImageGeneration(input.imageGeneration);
  for (const m of input.models) {
    if (!Array.isArray(m.roles) || !m.roles.length || m.roles.some(r => !allowed.includes(r))) throw new Error('invalid_model_roles');
    const b = safeObject(m.billing);
    for (const field of ['coefficient', 'inputPricePerMillion', 'outputPricePerMillion', 'cacheReadPricePerMillion', 'contextLength']) {
      if (b[field] != null && (typeof b[field] !== 'number' || !Number.isFinite(b[field]) || b[field] < 0)) throw new Error('invalid_model_prices');
    }
    if (b.providerKind != null && !['custom', 'openrouter', 'deepseek', 'xiaomi'].includes(b.providerKind)) throw new Error('invalid_provider');
    if (b.pricingMode != null && !['manual', 'auto'].includes(b.pricingMode)) throw new Error('invalid_pricing_mode');
    for (const field of ['openrouterProviderSlug', 'pricingSource']) if (b[field] != null && (typeof b[field] !== 'string' || b[field].length > 200)) throw new Error('invalid_model_billing');
    for (const field of ['intelTier', 'priceTier']) if (b[field] != null && ![1, 2, 3].includes(b[field])) throw new Error('invalid_model_tier');
  }
  const importTransaction = db.transaction(() => {
    const current = getModelSettings();
    const next = { ...current, proModels: [...current.proModels], liteModels: [...current.liteModels], manualModels: [...current.manualModels] };
    const known = allModels(current).filter(m => m.model);
    const reserved = new Set([...known.map(m => m.uniqueId), ...(db.prepare('SELECT model_id FROM model_overrides').all() as { model_id: string }[]).map(m => m.model_id)]);
    const keyMap = new Map<string, number>();
    const resolveKey = (keyRef: string | undefined, currentId: number | null) => {
      if (!keyRef) return currentId;
      const key = input.keys.find(k => k.id === keyRef);
      if (!key?.key) throw new Error('api_key_required');
      if (!keyMap.has(key.id)) keyMap.set(key.id, importModelKey(key.name, key.key, key.sourceId));
      return keyMap.get(key.id)!;
    };
    let added = 0; let skipped = 0;
    const billing: { id: string; value: any }[] = [];
    for (const source of input.models) {
      if (source.roles.every(r => r === 'vision') && next.visionModel.model) { skipped++; continue; }
      const apiKeyId = resolveKey(source.keyRef, source.apiKeyId);
      const signature = (m: ConfiguredModel) => JSON.stringify([m.baseUrl.replace(/\/$/, ''), m.model, m.apiKeyId, m.proxyUrl || '']);
      let m: ConfiguredModel = { ...source, apiKeyId, uniqueId: source.uniqueId || source.id || `import-${crypto.randomUUID()}` };
      const duplicate = known.find(k => signature(k) === signature(m) && (k.uniqueId === m.uniqueId || k.uniqueId.startsWith(`${m.uniqueId}-import-`)));
      if (duplicate) m = duplicate;
      else {
        const original = m.uniqueId;
        let n = 1;
        while (reserved.has(m.uniqueId)) m.uniqueId = `${original}-import-${n++}`;
        reserved.add(m.uniqueId);
        // Card IDs are also stable. Remap only when occupied by a different entry.
        if (known.some(k => k.id === m.id)) m.id = `import-${crypto.randomUUID()}`;
        known.push(m);
        if (source.billing) billing.push({ id: m.uniqueId, value: { ...source.billing, selectedApiKeyId: apiKeyId } });
      }
      for (const role of [...new Set(source.roles)]) {
        if (role === 'vision') {
          if (next.visionModel.model) { skipped++; continue; }
          next.visionModel = m; added++; continue;
        }
        const target = role === 'pro' ? next.proModels : role === 'lite' ? next.liteModels : next.manualModels;
        if (target.some(k => k.uniqueId === m.uniqueId)) { skipped++; continue; }
        target.push(m); added++;
      }
    }
    if (!current.proModels.length && input.autoVision && typeof input.autoVision.pro === 'boolean') next.proSupportsVision = input.autoVision.pro;
    if (!current.liteModels.length && input.autoVision && typeof input.autoVision.lite === 'boolean') next.liteSupportsVision = input.autoVision.lite;
    updateModelSettings(next);
    for (const entry of billing) if (!getModelOverride(entry.id)) setModelProvider(entry.id, entry.value);
    if (input.imageGeneration) {
      const image = input.imageGeneration;
      const previous = getImageGenerationSettings();
      const updated = updateImageGenerationSettings({
        enabled: image.enabled, img2imgEnabled: image.img2imgEnabled, provider: image.provider,
        openrouter: {
          baseUrl: image.openrouter.baseUrl, model: image.openrouter.model,
          apiKeyId: resolveKey(image.openrouter.keyRef, image.openrouter.apiKeyId),
        },
        cloudflare: {
          accountId: image.cloudflare.accountId, model: image.cloudflare.model,
          apiTokenId: resolveKey(image.cloudflare.keyRef, image.cloudflare.apiTokenId),
        },
      });
      if (JSON.stringify(previous) === JSON.stringify(updated)) skipped++;
      else added++;
    }
    return { added, skipped };
  });
  try {
    return importTransaction();
  } finally {
    refreshCoefficientCache();
  }
}
