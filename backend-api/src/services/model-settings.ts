import crypto from 'node:crypto';
import { db } from '../db.js';
import { getEncryptionKey } from '../utils/encryption.js';
import { getChatGptConnection } from './chatgpt-connections.js';

export type ConfiguredModel = {
  auth?: 'api_key' | 'chatgpt'; chatGptConnectionId?: number | null;
  id: string; uniqueId: string; baseUrl: string; model: string; proxyUrl?: string;
  apiKeyId: number | null; apiKey?: string; hasApiKey?: boolean;
  name?: string; description?: string; supportsVision?: boolean; supportsTools?: boolean; adminOnly?: boolean;
};
export type ModelSettings = {
  proModels: ConfiguredModel[]; liteModels: ConfiguredModel[]; manualModels: ConfiguredModel[];
  visionModel: ConfiguredModel; visionLiteModels?: ConfiguredModel[];
  proSupportsVision: boolean; liteSupportsVision: boolean;
};
const KEY = 'ai_model_settings_v1';
const emptyVision = (): ConfiguredModel => ({ id: 'vision', uniqueId: 'vision', baseUrl: '', model: '', apiKeyId: null });
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'model';
const chain = (raw: string | undefined, fallback: string[]) => raw?.trim() ? raw.split(',').map(s => s.trim()).filter(Boolean) : fallback;
const flag = (s: unknown) => s === true || s === '1' || s === 'true';
export function decryptModelKey(encrypted: string): string {
  const [iv, data] = encrypted.split('::');
  const cipher = crypto.createDecipheriv('aes-256-cbc', getEncryptionKey(['ENCRYPTION_KEY']), Buffer.from(iv, 'hex'));
  return Buffer.concat([cipher.update(Buffer.from(data, 'hex')), cipher.final()]).toString('utf8');
}
export function modelApiKey(id: number | null): string {
  if (!id) return '';
  const row = db.prepare('SELECT key_encrypted FROM api_keys WHERE id = ?').get(id) as { key_encrypted: string } | undefined;
  return row ? decryptModelKey(row.key_encrypted) : '';
}
export function importModelKey(name: string, value: string, preferredId?: number): number {
  const key = value.trim();
  if (!key || key.length > 8192 || /[|;\r\n\0]/.test(key)) throw new Error('invalid_api_key');
  const rows = db.prepare('SELECT id, key_encrypted FROM api_keys').all() as { id: number; key_encrypted: string }[];
  const duplicate = rows.find(row => decryptModelKey(row.key_encrypted) === key);
  const id = Number.isSafeInteger(preferredId) && preferredId! > 0 && !rows.some(row => row.id === preferredId) ? preferredId : null;
  // Native exports can deliberately contain distinct named keys with equal values.
  // Preserve their free IDs on a clean installation; ST/legacy migration deduplicates by value.
  if (duplicate && id === null) return duplicate.id;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', getEncryptionKey(['ENCRYPTION_KEY']), iv);
  const encrypted = `${iv.toString('hex')}::${Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]).toString('hex')}`;
  const prefix = key.length > 12 ? `${key.slice(0, 7)}…${key.slice(-4)}` : '••••';
  return Number(db.prepare('INSERT INTO api_keys (id, name, key_encrypted, key_prefix) VALUES (?, ?, ?, ?)')
    .run(id, name.trim().slice(0, 200) || 'Imported model key', encrypted, prefix).lastInsertRowid);
}
export const allModels = (s: ModelSettings) => [...s.proModels, ...s.liteModels, ...s.manualModels, s.visionModel, ...(s.visionLiteModels || [])];
export function replaceModelKeyReference(id: number, replacement: number | null) {
  const settings = getModelSettings();
  for (const m of allModels(settings)) if (m.apiKeyId === id) m.apiKeyId = replacement;
  store(settings);
}

export function legacyModelSettings(env: NodeJS.ProcessEnv = process.env): ModelSettings {
  const parse = (kind: 'pro' | 'lite'): ConfiguredModel[] => {
    const lite = kind === 'lite';
    const base = (lite ? env.TIMEWEB_LITE_BASE_URL : '') || env.TIMEWEB_BASE_URL || '';
    const key = (lite ? env.TIMEWEB_LITE_API_KEY : '') || env.TIMEWEB_API_KEY || '';
    const models = chain(lite ? env.TIMEWEB_LITE_MODEL : env.TIMEWEB_MODEL, [lite ? 'gemini-2.5-flash-lite' : 'gemini-3.1-flash-lite-preview']);
    const raw = lite ? env.TIMEWEB_LITE_ENDPOINTS : env.TIMEWEB_PRO_ENDPOINTS;
    const chunks = raw?.trim() ? raw.split(';').filter(s => s.trim()) : [`${base}|${key}|${models.join(',')}||`];
    return chunks.flatMap((chunk, p) => {
      const [url, secret, names, ids, proxy] = chunk.split('|').map(s => s.trim());
      return chain(names, models).map((model, i) => ({
        id: `${kind}-${p}-${i}`, uniqueId: ids?.split(',')[i]?.trim() || `${kind}-${slug(model)}-${p}-${i}`,
        baseUrl: url || base, model, apiKey: secret || key, apiKeyId: null,
        proxyUrl: proxy || (lite ? env.TIMEWEB_LITE_PROXY_URL : '') || env.TIMEWEB_PROXY_URL || '',
      })).filter(m => m.baseUrl && m.apiKey);
    });
  };
  const proModels = parse('pro');
  const liteModels = parse('lite');
  const explicit = env.TIMEWEB_VISION_MODEL || env.TIMEWEB_VISION_BASE_URL || env.TIMEWEB_VISION_API_KEY;
  const visionModel = explicit ? {
    ...emptyVision(), uniqueId: env.TIMEWEB_VISION_UNIQUE_ID || 'vision',
    baseUrl: env.TIMEWEB_VISION_BASE_URL || env.TIMEWEB_BASE_URL || proModels[0]?.baseUrl || '',
    apiKey: env.TIMEWEB_VISION_API_KEY || env.TIMEWEB_API_KEY || proModels[0]?.apiKey || '',
    model: chain(env.TIMEWEB_VISION_MODEL, [proModels[0]?.model || 'glm-4v'])[0],
    proxyUrl: env.TIMEWEB_VISION_PROXY_URL || env.TIMEWEB_PROXY_URL || '',
  } : emptyVision();
  const manualModels = (env.MODELS_MANUAL || '').split(';').filter(Boolean).map((chunk, i) => {
    const [baseUrl, apiKey, model, name, description, uniqueId, vision, admin, proxyUrl, tools = '1'] = chunk.split('|').map(s => s.trim());
    return { id: uniqueId || `manual-${i}`, uniqueId: uniqueId || `manual-${i}`, baseUrl, apiKey, model, name: name || model,
      description, supportsVision: flag(vision), supportsTools: flag(tools), adminOnly: flag(admin), proxyUrl, apiKeyId: null };
  }).filter(m => m.baseUrl && m.apiKey && m.model);
  const visionLiteModels = env.TIMEWEB_LITE_VISION_MODEL || env.TIMEWEB_LITE_VISION_BASE_URL || env.TIMEWEB_LITE_VISION_API_KEY
    ? chain(env.TIMEWEB_LITE_VISION_MODEL, [visionModel.model || proModels[0]?.model || 'glm-4v']).map((model, i) => ({
      id: `vision-lite-${i}`, uniqueId: i ? `vision-lite-${slug(model)}-${i}` : `${visionModel.uniqueId}-lite`, model,
      baseUrl: env.TIMEWEB_LITE_VISION_BASE_URL || env.TIMEWEB_LITE_BASE_URL || visionModel.baseUrl || env.TIMEWEB_BASE_URL || '',
      apiKey: env.TIMEWEB_LITE_VISION_API_KEY || env.TIMEWEB_LITE_API_KEY || visionModel.apiKey || env.TIMEWEB_API_KEY || '',
      proxyUrl: env.TIMEWEB_LITE_VISION_PROXY_URL || env.TIMEWEB_LITE_PROXY_URL || env.TIMEWEB_PROXY_URL || '', apiKeyId: null,
    })) : undefined;
  return { proModels, liteModels, manualModels, visionModel, visionLiteModels,
    proSupportsVision: flag(env.TIMEWEB_MODEL_SUPPORTS_VISION), liteSupportsVision: flag(env.TIMEWEB_LITE_MODEL_SUPPORTS_VISION) };
}
function store(settings: ModelSettings) {
  db.prepare('INSERT INTO system_settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at')
    .run(KEY, JSON.stringify(settings), Date.now());
}
export function getModelSettings(): ModelSettings {
  const row = db.prepare('SELECT value_json FROM system_settings WHERE key = ?').get(KEY) as { value_json: string } | undefined;
  if (row) return JSON.parse(row.value_json);
  return db.transaction(() => {
    const settings = legacyModelSettings();
    for (const model of allModels(settings)) {
      if (model.apiKey) {
        const reference = db.prepare('SELECT selected_api_key_id FROM model_overrides WHERE model_id = ?').get(model.uniqueId) as { selected_api_key_id: number | null } | undefined;
        model.apiKeyId = reference?.selected_api_key_id && modelApiKey(reference.selected_api_key_id) === model.apiKey
          ? reference.selected_api_key_id : importModelKey(model.name || model.model, model.apiKey);
      }
      delete model.apiKey;
    }
    store(settings);
    return settings;
  })();
}
export function publicModelSettings() {
  const settings = getModelSettings();
  const hasCredentials = (m: ConfiguredModel) => { if (m.auth !== 'chatgpt') return Boolean(m.apiKeyId); try { return Boolean(m.chatGptConnectionId && getChatGptConnection(m.chatGptConnectionId)); } catch { return false; } };
  const redact = (m: ConfiguredModel) => ({ ...m, apiKey: '', hasApiKey: hasCredentials(m) });
  return { ...settings, hasAiApiKey: settings.proModels.some(hasCredentials),
    aiBaseUrl: settings.proModels[0]?.baseUrl || 'https://openrouter.ai/api/v1', aiModel: settings.proModels.map(m => m.model).join(','),
    proModels: settings.proModels.map(redact), liteModels: settings.liteModels.map(redact),
    manualModels: settings.manualModels.map(redact), visionModel: redact(settings.visionModel), visionLiteModels: settings.visionLiteModels?.map(redact) };
}
export function updateModelSettings(input: any): ModelSettings {
  const current = getModelSettings();
  const validate = (items: unknown, old: ConfiguredModel[], kind: string): ConfiguredModel[] => {
    if (!Array.isArray(items) || items.length > 200) throw new Error('invalid_model_list');
    const ids = new Set<string>();
    const cardIds = new Set<string>();
    return items.map((item, i) => {
      if (!item || typeof item !== 'object') throw new Error('invalid_model');
      const id = String(item.id || `${kind}-${crypto.randomUUID()}`);
      if (id.length > 200 || /[\r\n\0]/.test(id) || cardIds.has(id)) throw new Error('invalid_model_card_id');
      cardIds.add(id);
      const uniqueId = String(item.uniqueId || `${kind}-${slug(String(item.model))}-${i}`);
      if (!uniqueId || uniqueId.length > 200 || /[|;\r\n\0]/.test(uniqueId) || ids.has(uniqueId)) throw new Error('invalid_model_id');
      ids.add(uniqueId);
      const before = old.find(m => m.id === id);
      const baseUrl = String(item.baseUrl || '').trim();
      const model = String(item.model || '').trim();
      if (!baseUrl && !model && kind === 'vision') return emptyVision();
      const url = new URL(baseUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !model || model.length > 300 || /[|;\r\n\0]/.test(model)) throw new Error('invalid_model');
      let apiKeyId = item.apiKeyId === undefined ? before?.apiKeyId || null : item.apiKeyId;
      if (item.auth === 'chatgpt') {
        const connectionId = Number(item.chatGptConnectionId);
        if (!Number.isSafeInteger(connectionId) || connectionId < 1) throw new Error('chatgpt_connection_required');
        const connection = getChatGptConnection(connectionId);
        if (!connection.shared && kind !== 'manual') throw new Error('chatgpt_enable_shared_access_for_auto_models');
        return { id, uniqueId, baseUrl: 'https://api.openai.com/v1', model, apiKeyId: null, auth: 'chatgpt' as const, chatGptConnectionId: connectionId,
          name: String(item.name || model), description: String(item.description || ''), supportsVision: Boolean(item.supportsVision), supportsTools: item.supportsTools !== false, adminOnly: !connection.shared || Boolean(item.adminOnly) };
      }
      if (item.apiKey?.trim()) apiKeyId = importModelKey(item.name || model, item.apiKey);
      if (!Number.isSafeInteger(apiKeyId) || !modelApiKey(apiKeyId)) throw new Error('api_key_required');
      const proxyUrl = String(item.proxyUrl || '');
      if (proxyUrl) { const proxy = new URL(proxyUrl); if (!['http:', 'https:', 'socks:', 'socks5:', 'socks4:', 'socks5h:'].includes(proxy.protocol)) throw new Error('invalid_proxy'); }
      return { id, uniqueId, baseUrl, model, apiKeyId, proxyUrl, name: String(item.name || model), description: String(item.description || ''),
        supportsVision: Boolean(item.supportsVision), supportsTools: item.supportsTools !== false, adminOnly: Boolean(item.adminOnly) };
    });
  };
  return db.transaction(() => {
    const next = { ...current,
      proSupportsVision: typeof input.proSupportsVision === 'boolean' ? input.proSupportsVision : current.proSupportsVision,
      liteSupportsVision: typeof input.liteSupportsVision === 'boolean' ? input.liteSupportsVision : current.liteSupportsVision,
      proModels: validate(input.proModels ?? current.proModels, current.proModels, 'pro'),
      liteModels: validate(input.liteModels ?? current.liteModels, current.liteModels, 'lite'),
      manualModels: validate(input.manualModels ?? current.manualModels, current.manualModels, 'manual'),
      visionModel: validate([input.visionModel ?? current.visionModel], [current.visionModel], 'vision')[0],
    };
    const byId = new Map<string, ConfiguredModel>();
    for (const m of allModels(next).filter(m => m.model)) {
      const other = byId.get(m.uniqueId);
      if (other && (other.model !== m.model || other.baseUrl !== m.baseUrl || other.apiKeyId !== m.apiKeyId)) throw new Error('model_id_conflict');
      byId.set(m.uniqueId, m);
    }
    store(next);
    return next;
  })();
}
