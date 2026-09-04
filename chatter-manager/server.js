'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = Number.parseInt(process.env.ADMIN_INTERNAL_PORT || '8080', 10);
const CONFIG_DIR = path.resolve(process.env.CHATTER_CONFIG_DIR || '/config');
const COMPOSE_FILE = path.resolve(process.env.CHATTER_COMPOSE_FILE || '/workspace/docker-compose.yml');
const PROJECT_DIR = path.dirname(COMPOSE_FILE);
const PROJECT_NAME = process.env.COMPOSE_PROJECT_NAME || 'chatter';
const DOCKER_BIN = process.env.CHATTER_DOCKER_BIN || 'docker';
const AUTH_FILE = path.join(CONFIG_DIR, 'auth.json');
const SESSIONS_FILE = path.join(CONFIG_DIR, 'admin-sessions.json');
const BOOTSTRAP_PASSWORD_FILE = path.resolve(process.env.ADMIN_BOOTSTRAP_PASSWORD_FILE || path.join(CONFIG_DIR, 'admin.bootstrap'));
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const BACKEND_ENV_FILE = path.join(CONFIG_DIR, 'backend.env');
const TELEGRAM_ENV_FILE = path.join(CONFIG_DIR, 'telegram.env');
const VOICE_ENV_FILE = path.join(CONFIG_DIR, 'voice.env');
const COMPOSE_RUNTIME_ENV_FILE = path.join(CONFIG_DIR, 'compose.runtime.env');
const BACKUP_SCHEDULE_FILE = path.join(CONFIG_DIR, 'backup-schedule.json');
const ADMIN_PANEL_URL = new URL(process.env.ADMIN_PANEL_URL || 'http://admin-panel:3000');
const BACKEND_INTERNAL_URL = new URL(process.env.BACKEND_INTERNAL_URL || 'http://backend:3050');
const SESSION_TTL_MS = Number.parseInt(process.env.SESSION_TTL_MS || `${14 * 24 * 60 * 60 * 1000}`, 10); // 14 days by default
const MAX_BODY_BYTES = 64 * 1024;
const MAX_BACKUP_UPLOAD_BYTES = Number.parseInt(process.env.MAX_BACKUP_UPLOAD_BYTES || `${20 * 1024 * 1024 * 1024}`, 10);
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes cache
const openRouterCache = new Map();

function openRouterCacheKey(url) {
  return `GET:${url}`;
}

function openRouterCacheGet(url) {
  const entry = openRouterCache.get(openRouterCacheKey(url));
  if (!entry || Date.now() > entry.expiresAt) {
    openRouterCache.delete(openRouterCacheKey(url));
    return null;
  }
  return entry.data;
}

function openRouterCacheSet(url, data) {
  openRouterCache.set(openRouterCacheKey(url), {
    data,
    expiresAt: Date.now() + OPENROUTER_CACHE_TTL_MS,
  });
}

async function openRouterFetch(pathname) {
  // OpenRouter Models/Endpoints APIs are public — no API key required.
  // The per-model key (set in each model card) is never sent to the browser
  // and is used only at runtime when proxying actual chat completions.
  const cached = openRouterCacheGet(pathname);
  if (cached) return cached;

  const response = await fetch(`${OPENROUTER_BASE_URL}${pathname}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`OpenRouter API error (HTTP ${response.status})`);

  const data = await response.json();
  openRouterCacheSet(pathname, data);
  return data;
}
const DATA_DIR = path.resolve(process.env.CHATTER_DATA_DIR || '/data');
const DATABASE_FILE = path.join(DATA_DIR, 'chatter.db');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const BACKUPS_DIR = path.resolve(process.env.CHATTER_BACKUPS_DIR || '/backups');
const UPDATE_STATE_FILE = path.join(CONFIG_DIR, 'server-update.json');
const METRICS_FILE = path.join(CONFIG_DIR, 'metrics.json');
const HOST_PROJECT_DIR = `${process.env.CHATTER_HOST_PROJECT_DIR || ''}`.trim();
const HOST_CONFIG_DIR = `${process.env.CHATTER_HOST_CONFIG_DIR || ''}`.trim();
// Host compose.env (the file install.sh writes and the update helper reads).
// CONFIG_DIR is a rw bind mount of the host config directory, so edits made
// here are visible on the host immediately.
const COMPOSE_ENV_FILE = path.join(CONFIG_DIR, 'compose.env');
const UPDATER_LOG_FILE = path.join(CONFIG_DIR, 'server-update.log');
const IMAGE_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

function readEnvFileValue(filePath, key) {
  try {
    const match = fs.readFileSync(filePath, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/** Replace or append a KEY=value line in an env file, preserving all other lines. */
function updateEnvFileValue(filePath, key, value) {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { /* new file */ }
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  const updated = pattern.test(content)
    ? content.replace(pattern, line)
    : (content.length > 0 && !content.endsWith('\n') ? `${content}\n${line}\n` : `${content}${line}\n`);
  atomicWrite(filePath, updated);
}

/**
 * The image tag is read from the host compose.env (the source of truth for
 * the update helper and container recreation), falling back to the process
 * environment. Reading dynamically allows switching update channels (e.g.
 * `latest` -> a feature branch tag) without restarting the manager.
 */
function currentImageTag() {
  const fromEnvFile = readEnvFileValue(COMPOSE_ENV_FILE, 'CHATTER_IMAGE_TAG');
  const tag = `${fromEnvFile || process.env.CHATTER_IMAGE_TAG || ''}`.trim();
  return tag || 'local';
}

function currentImagePrefix() {
  const fromEnvFile = readEnvFileValue(COMPOSE_ENV_FILE, 'CHATTER_IMAGE_PREFIX');
  return `${fromEnvFile || process.env.CHATTER_IMAGE_PREFIX || ''}`.trim() || 'chatter';
}
const BACKUP_CONFIG_FILES = [
  'backend.env',
  'telegram.env',
  'voice.env',
  'compose.runtime.env',
  'settings.json'
];

fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(BACKUPS_DIR, { recursive: true, mode: 0o700 });

const sessions = new Map();
const loginAttempts = new Map();
let applyPromise = null;
let backupPromise = null;
let restorePromise = null;
let updatePromise = null;
let activeLogStreams = 0;

const randomSecret = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
const METRICS_MAX = 10080;
const METRICS_INTERVAL_MS = 60_000;
const metricsHistory = [];
// Load persisted metrics on startup
try {
  const persisted = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8'));
  if (Array.isArray(persisted)) {
    metricsHistory.push(...persisted);
    if (metricsHistory.length > METRICS_MAX) metricsHistory.splice(0, metricsHistory.length - METRICS_MAX);
  }
} catch { /* File doesn't exist yet — fresh start */ }

function atomicWrite(filePath, content, mode = 0o600) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content, { mode });
  fs.renameSync(tempPath, filePath);
  fs.chmodSync(filePath, mode);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function verifyPassword(password, auth) {
  const candidate = crypto.scryptSync(password, auth.salt, 64);
  const expected = Buffer.from(auth.hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function loadJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function persistSessions() {
  const now = Date.now();
  const entries = [...sessions.entries()]
    .filter(([, session]) => session.expiresAt > now)
    .map(([token, session]) => [token, { expiresAt: session.expiresAt }]);
  atomicWrite(SESSIONS_FILE, `${JSON.stringify({ sessions: entries }, null, 2)}\n`);
}

function restoreSessions() {
  const now = Date.now();
  const stored = loadJson(SESSIONS_FILE, { sessions: [] });
  for (const entry of Array.isArray(stored.sessions) ? stored.sessions : []) {
    const [token, session] = Array.isArray(entry) ? entry : [];
    if (typeof token === 'string' && token.length >= 32 && Number(session?.expiresAt) > now) {
      sessions.set(token, { expiresAt: Number(session.expiresAt), lastPersistedAt: now });
    }
  }
}

restoreSessions();

function initializeAuth() {
  const existing = loadJson(AUTH_FILE, null);
  if (existing?.username && existing?.salt && existing?.hash) return existing;
  const username = `${process.env.ADMIN_USERNAME || 'admin'}`.trim();
  let password = '';
  try {
    password = fs.readFileSync(BOOTSTRAP_PASSWORD_FILE, 'utf8').trim();
  } catch {
    // Handled by the validation error below.
  }
  if (!username || password.length < 12) {
    throw new Error('ADMIN_USERNAME and a bootstrap password file with at least 12 characters are required on first start');
  }
  const auth = { username, ...hashPassword(password), updatedAt: new Date().toISOString() };
  atomicWrite(AUTH_FILE, `${JSON.stringify(auth, null, 2)}\n`);
  fs.rmSync(BOOTSTRAP_PASSWORD_FILE, { force: true });
  return auth;
}

let authConfig = initializeAuth();

function parseEnv(filePath) {
  const result = {};
  if (!fs.existsSync(filePath)) return result;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[key] = value;
  }
  return result;
}

function writeEnv(filePath, values) {
  const lines = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      const text = String(value);
      if (/[\r\n\0]/.test(text)) throw new Error(`${key} contains invalid characters`);
      return `${key}=${text}`;
    });
  atomicWrite(filePath, `${lines.join('\n')}\n`);
}

writeEnv(COMPOSE_RUNTIME_ENV_FILE, {
  BACKEND_ENV_FILE,
  TELEGRAM_ENV_FILE,
  VOICE_ENV_FILE,
  CHATTER_MANAGER_ENV_FILE: path.join(CONFIG_DIR, 'manager.env'),
  CHATTER_CONFIG_DIR: CONFIG_DIR,
  BACKEND_PORT: process.env.BACKEND_PORT || '3050',
  NOTES_PORT: process.env.NOTES_PORT || '3001',
  VOICE_PORT: process.env.VOICE_PORT || '3030',
  CHATTER_IMAGE_PREFIX: currentImagePrefix(),
  CHATTER_IMAGE_TAG: currentImageTag(),
  CHATTER_PULL_IMAGES: process.env.CHATTER_PULL_IMAGES || '0',
  CHATTER_PUBLIC_HOST: process.env.CHATTER_PUBLIC_HOST || '',
  CHATTER_PUBLIC_URL: process.env.CHATTER_PUBLIC_URL || ''
});

const defaultSettings = () => ({
  telegramEnabled: false,
  telegramRichStreaming: true,
  notesEnabled: false,
  notesUrl: process.env.CHATTER_PUBLIC_URL
    ? `${process.env.CHATTER_PUBLIC_URL.replace(/\/+$/, '')}/notes`
    : '',
  aiBaseUrl: 'https://openrouter.ai/api/v1',
  aiModel: '',
  voiceMode: 'off',
  voiceExternalUrl: '',
  updatedAt: null
});

const loadSettings = () => {
  const stored = loadJson(SETTINGS_FILE, {});
  const defaults = defaultSettings();
  return {
    ...defaults,
    ...stored,
    notesUrl: defaults.notesUrl || (
      typeof stored.notesUrl === 'string' && stored.notesUrl.trim()
        ? stored.notesUrl
        : ''
    ),
    // Existing installations started Notes together with Telegram. Preserve
    // that behaviour once, then persist the new independent flag on save.
    notesEnabled: typeof stored.notesEnabled === 'boolean'
      ? stored.notesEnabled
      : Boolean(stored.telegramEnabled)
  };
};

function publicSettings() {
  const backendEnv = parseEnv(BACKEND_ENV_FILE);
  const telegramEnv = parseEnv(TELEGRAM_ENV_FILE);
  const providerModels = getProviderModels(backendEnv);
  return {
    ...loadSettings(),
    telegramRichStreaming: telegramEnv.TG_USE_RICH_STREAMING !== '0',
    hasTelegramToken: Boolean(telegramEnv.TELEGRAM_TOKEN),
    hasAiApiKey: providerModels.proModels.some(model => Boolean(model.apiKey)),
    hasVoiceToken: Boolean(backendEnv.VOICE_TRANSCRIBE_TOKEN || parseEnv(VOICE_ENV_FILE).VOICE_TRANSCRIBE_TOKEN),
    proModels: providerModels.proModels.map(redactSecret),
    liteModels: providerModels.liteModels.map(redactSecret),
    visionModel: redactSecret(providerModels.visionModel),
    manualModels: parseManualModels(backendEnv.MODELS_MANUAL).map(redactSecret),
    pinecone: {
      apiKey: '',
      hasApiKey: Boolean(backendEnv.PINECONE_API_KEY),
      indexName: backendEnv.PINECONE_INDEX_NAME || 'bot-memory',
      embeddingBaseUrl: backendEnv.TIMEWEB_EMBED_BASE_URL || providerModels.proModels[0]?.baseUrl || backendEnv.TIMEWEB_BASE_URL || '',
      embeddingApiKey: '',
      hasEmbeddingApiKey: Boolean(backendEnv.TIMEWEB_EMBED_API_KEY),
      embeddingModel: backendEnv.TIMEWEB_EMBED_MODEL || backendEnv.VECTOR_EMBED_MODEL || 'text-embedding-3-small'
    },
    webSearch: {
      baseUrl: backendEnv.TAVILY_API_BASE_URL || 'https://api.tavily.com',
      apiKey: '',
      hasApiKey: Boolean(backendEnv.TAVILY_API_KEY)
    },
    webReader: {
      baseUrl: backendEnv.BROWSERLESS_BASE_URL || 'https://production-sfo.browserless.io',
      token: '',
      hasToken: Boolean(backendEnv.BROWSERLESS_TOKEN)
    },
    cloudTts: {
      apiKey: '',
      hasApiKey: Boolean(backendEnv.CARTESIA_API_KEY),
      model: backendEnv.CARTESIA_MODEL_ID || 'sonic-3.5'
    },
    imageGeneration: {
      enabled: true,
      baseUrl: OPENROUTER_BASE_URL,
      apiKey: '',
      hasApiKey: Boolean(backendEnv.OPENROUTER_API_KEY),
      model: backendEnv.IMAGE_GEN_MODEL || 'x-ai/grok-imagine-image-quality',
      maxResolution: backendEnv.IMAGE_GEN_MAX_RESOLUTION === '1K' ? '1K' : '2K',
      quality: ['low', 'medium', 'high'].includes(backendEnv.IMAGE_GEN_QUALITY) ? backendEnv.IMAGE_GEN_QUALITY : 'auto',
      supportedParameters: `${backendEnv.IMAGE_GEN_SUPPORTED_PARAMETERS || (
        (backendEnv.IMAGE_GEN_MODEL || 'x-ai/grok-imagine-image-quality') === 'x-ai/grok-imagine-image-quality'
          ? 'resolution,input_references'
          : ''
      )}`
        .split(',')
        .map((value) => value.trim())
        .filter((value) => ['resolution', 'quality', 'input_references'].includes(value))
    }
  };
}

function normalizeUrl(value, fieldName, { allowEmpty = true } = {}) {
  const trimmed = `${value || ''}`.trim().replace(/\/$/, '');
  if (!trimmed && allowEmpty) return '';
  let parsed;
  try { parsed = new URL(trimmed); } catch { throw new Error(`${fieldName} must be a valid http(s) URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${fieldName} must use http or https`);
  return trimmed;
}

function splitModelChain(value, fallback = []) {
  const models = `${value || ''}`.split(',').map(model => model.trim()).filter(Boolean);
  return models.length ? models : fallback;
}

function parseProviderModels(raw, prefix, fallbackBase, fallbackKey, fallbackModels, fallbackProxy = '') {
  const chunks = `${raw || ''}`.trim()
    ? `${raw}`.split(';').map(value => value.trim()).filter(Boolean)
    : fallbackBase && fallbackModels.length
      ? [`${fallbackBase}|${fallbackKey}|${fallbackModels.join(',')}||${fallbackProxy}`]
      : [];
  const result = [];
  chunks.forEach((chunk, providerIndex) => {
    const parts = chunk.split('|').map(value => value.trim());
    const baseUrl = parts[0] || '';
    const apiKey = parts[1] || '';
    const modelsRaw = parts[2] || '';
    // 4th field: comma-separated uniqueIds, one per model in modelsRaw.
    // Backward-compat: if absent or fewer entries than models, synthesize from prefix+model.
    const uniqueIdsRaw = parts[3] || '';
    const proxyUrl = parts[4] || '';
    const uniqueIdCandidates = uniqueIdsRaw ? uniqueIdsRaw.split(',').map(value => value.trim()) : [];
    const models = splitModelChain(modelsRaw);
    models.forEach((model, modelIndex) => {
      if (!baseUrl || !model) return;
      const explicitId = uniqueIdCandidates[modelIndex];
      const uniqueId = explicitId || `${prefix}-${slugifyModelId(model)}-${providerIndex}-${modelIndex}`;
      result.push({ id: `${prefix}-${providerIndex}-${modelIndex}`, uniqueId, baseUrl, apiKey, model, proxyUrl });
    });
  });
  return result;
}

function slugifyModelId(value) {
  return `${value || ''}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'model';
}

function getProviderModels(backendEnv) {
  const proModels = parseProviderModels(
    backendEnv.TIMEWEB_PRO_ENDPOINTS,
    'pro',
    backendEnv.TIMEWEB_BASE_URL,
    backendEnv.TIMEWEB_API_KEY,
    splitModelChain(backendEnv.TIMEWEB_MODEL, ['gemini-3.1-flash-lite-preview']),
    backendEnv.TIMEWEB_PROXY_URL
  );
  const liteModels = parseProviderModels(
    backendEnv.TIMEWEB_LITE_ENDPOINTS,
    'lite',
    backendEnv.TIMEWEB_LITE_BASE_URL || backendEnv.TIMEWEB_BASE_URL,
    backendEnv.TIMEWEB_LITE_API_KEY || backendEnv.TIMEWEB_API_KEY,
    splitModelChain(backendEnv.TIMEWEB_LITE_MODEL, ['gemini-2.5-flash-lite']),
    backendEnv.TIMEWEB_LITE_PROXY_URL || backendEnv.TIMEWEB_PROXY_URL
  );
  const hasExplicitVision = Boolean(
    backendEnv.TIMEWEB_VISION_BASE_URL
    || backendEnv.TIMEWEB_VISION_API_KEY
    || backendEnv.TIMEWEB_VISION_MODEL
  );
  const visionModel = hasExplicitVision
    ? {
        id: 'vision',
        uniqueId: backendEnv.TIMEWEB_VISION_UNIQUE_ID || 'vision',
        baseUrl: backendEnv.TIMEWEB_VISION_BASE_URL || proModels[0]?.baseUrl || backendEnv.TIMEWEB_BASE_URL || '',
        apiKey: backendEnv.TIMEWEB_VISION_API_KEY || proModels[0]?.apiKey || backendEnv.TIMEWEB_API_KEY || '',
        proxyUrl: backendEnv.TIMEWEB_VISION_PROXY_URL || proModels[0]?.proxyUrl || backendEnv.TIMEWEB_PROXY_URL || '',
        model: splitModelChain(
          backendEnv.TIMEWEB_VISION_MODEL,
          proModels[0]?.model ? [proModels[0].model] : []
        )[0] || ''
      }
    : { id: 'vision', uniqueId: 'vision', baseUrl: '', apiKey: '', model: '', proxyUrl: '' };
  return { proModels, liteModels, visionModel };
}

function parseManualModels(raw) {
  return `${raw || ''}`.split(';').map(value => value.trim()).filter(Boolean).map((chunk, index) => {
    const [baseUrl = '', apiKey = '', model = '', name = '', description = '', uniqueId = '', supportsVision = '0', adminOnly = '0', proxyUrl = '', supportsTools = '1'] = chunk.split('|').map(value => value.trim());
    return {
      id: uniqueId || `manual-${index}`,
      baseUrl,
      apiKey,
      model,
      name: name || model,
      description,
      uniqueId: uniqueId || `manual-${index}`,
      supportsVision: ['1', 'true'].includes(supportsVision.toLowerCase()),
      supportsTools: ['1', 'true'].includes(supportsTools.toLowerCase()),
      adminOnly: ['1', 'true'].includes(adminOnly.toLowerCase()),
      proxyUrl
    };
  }).filter(model => model.baseUrl && model.apiKey && model.model && model.uniqueId);
}

function redactSecret(entry) {
  return { ...entry, apiKey: '', hasApiKey: Boolean(entry.apiKey) };
}

function validateEnvPart(value, fieldName) {
  const normalized = `${value || ''}`.trim();
  if (!normalized || /[|;\r\n\0]/.test(normalized)) throw new Error(`${fieldName} is invalid`);
  return normalized;
}

function normalizeProxyUrl(value, fieldName = 'Proxy URL') {
  const normalized = `${value || ''}`.trim();
  if (!normalized) return '';
  if (/[|;\r\n\0]/.test(normalized)) throw new Error(`${fieldName} contains invalid characters`);
  let parsed;
  try { parsed = new URL(normalized); } catch { throw new Error(`${fieldName} must be a valid proxy URL`); }
  if (!['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) {
    throw new Error(`${fieldName} must use http, https, socks4 or socks5`);
  }
  return normalized;
}

function mergeSecret(value, existing, fieldName) {
  const secret = `${value || ''}`.trim() || `${existing || ''}`;
  if (/[\r\n\0]/.test(secret)) throw new Error(`${fieldName} contains invalid characters`);
  return secret;
}

function mergeProviderModels(input, existing, label, { required = false } = {}) {
  if (!Array.isArray(input)) return existing;
  if (required && input.length === 0) throw new Error(`${label} requires at least one model`);
  const existingKeys = new Map(existing.map(item => [item.id, item.apiKey]));
  const existingProxies = new Map(existing.map(item => [item.id, item.proxyUrl || '']));
  const existingUniqueIds = new Map(existing.map(item => [item.id, item.uniqueId || '']));
  return input.map((item, index) => {
    const id = `${item?.id || `${label}-${index}`}`;
    const baseUrl = normalizeUrl(item?.baseUrl, `${label} provider URL`, { allowEmpty: false });
    const model = validateEnvPart(item?.model, `${label} model`);
    const apiKey = `${item?.apiKey || ''}`.trim() || existingKeys.get(id) || '';
    if (!apiKey || /[|;\r\n\0]/.test(apiKey)) throw new Error(`${label} API key is required`);
    const proxyUrl = normalizeProxyUrl(
      item?.proxyUrl === undefined ? existingProxies.get(id) : item.proxyUrl,
      `${label} proxy URL`
    );
    // uniqueId keys model overrides (prices / provider kind / API key) in the
    // admin panel — preserve the client value, fall back to the stored one so
    // a save never detaches existing overrides.
    const uniqueId = `${item?.uniqueId || existingUniqueIds.get(id) || ''}`.trim();
    if (/[|;\r\n\0]/.test(uniqueId)) throw new Error(`${label} quota id is invalid`);
    return { id, baseUrl, apiKey, model, proxyUrl, uniqueId };
  });
}

function mergeProviderModel(input, existing, label, { required = true } = {}) {
  if (!input || typeof input !== 'object') return existing;
  const baseUrlInput = `${input.baseUrl || ''}`.trim();
  const modelInput = `${input.model || ''}`.trim();
  if (!required && !baseUrlInput && !modelInput && !input.apiKey) return null;
  const apiKey = `${input.apiKey || ''}`.trim() || existing.apiKey || '';
  if (!apiKey || /[|;\r\n\0]/.test(apiKey)) throw new Error(`${label} API key is required`);
  const uniqueId = `${input.uniqueId || existing.uniqueId || ''}`.trim();
  if (/[|;\r\n\0]/.test(uniqueId)) throw new Error(`${label} quota id is invalid`);
  return {
    id: existing.id,
    baseUrl: normalizeUrl(input.baseUrl, `${label} provider URL`, { allowEmpty: false }),
    apiKey,
    model: validateEnvPart(input.model, `${label} model`),
    uniqueId,
    proxyUrl: normalizeProxyUrl(
      input.proxyUrl === undefined ? existing.proxyUrl : input.proxyUrl,
      `${label} proxy URL`
    )
  };
}

function mergeManualModels(input, existing) {
  if (!Array.isArray(input)) return existing;
  const existingKeys = new Map(existing.map(item => [item.id, item.apiKey]));
  const existingProxies = new Map(existing.map(item => [item.id, item.proxyUrl || '']));
  const uniqueIds = new Set();
  return input.map((item, index) => {
    const id = `${item?.id || `manual-new-${index}`}`;
    const uniqueId = validateEnvPart(item?.uniqueId, 'Manual model ID');
    if (uniqueIds.has(uniqueId)) throw new Error('Manual model IDs must be unique');
    uniqueIds.add(uniqueId);
    const apiKey = `${item?.apiKey || ''}`.trim() || existingKeys.get(id) || '';
    if (!apiKey || /[|;\r\n\0]/.test(apiKey)) throw new Error('Manual model API key is required');
    return {
      id,
      baseUrl: normalizeUrl(item?.baseUrl, 'Manual model provider URL', { allowEmpty: false }),
      apiKey,
      model: validateEnvPart(item?.model, 'Manual model name'),
      name: validateEnvPart(item?.name || item?.model, 'Manual display name'),
      description: `${item?.description || ''}`.trim(),
      uniqueId,
      supportsVision: Boolean(item?.supportsVision),
      supportsTools: item?.supportsTools === undefined ? true : Boolean(item.supportsTools),
      adminOnly: Boolean(item?.adminOnly),
      proxyUrl: normalizeProxyUrl(
        item?.proxyUrl === undefined ? existingProxies.get(id) : item.proxyUrl,
        'Manual model proxy URL'
      )
    };
  });
}

const serializeProviderModels = models => models
  .map(model => {
    const uniqueId = `${model.uniqueId || ''}`.trim();
    const proxyUrl = `${model.proxyUrl || ''}`.trim();
    return [model.baseUrl, model.apiKey, model.model, uniqueId, proxyUrl].join('|');
  })
  .join(';');
const serializeManualModels = models => models.map(model => [model.baseUrl, model.apiKey, model.model, model.name, model.description.replace(/[|;\r\n]/g, ' '), model.uniqueId, model.supportsVision ? '1' : '0', model.adminOnly ? '1' : '0', model.proxyUrl || '', model.supportsTools === false ? '0' : '1'].join('|')).join(';');

function saveSettings(input) {
  const previous = loadSettings();
  const backendEnv = parseEnv(BACKEND_ENV_FILE);
  const telegramEnv = parseEnv(TELEGRAM_ENV_FILE);
  const voiceEnv = parseEnv(VOICE_ENV_FILE);
  const existingProviderModels = getProviderModels(backendEnv);
  const existingManualModels = parseManualModels(backendEnv.MODELS_MANUAL);
  const telegramEnabled = Boolean(input.telegramEnabled);
  const telegramRichStreaming = typeof input.telegramRichStreaming === 'boolean'
    ? input.telegramRichStreaming
    : telegramEnv.TG_USE_RICH_STREAMING !== '0';
  const notesEnabled = Boolean(input.notesEnabled);
  const telegramToken = `${input.telegramToken || ''}`.trim() || telegramEnv.TELEGRAM_TOKEN || '';
  const legacyAiApiKey = `${input.aiApiKey || ''}`.trim() || backendEnv.TIMEWEB_API_KEY || '';
  const legacyAiBaseUrl = normalizeUrl(input.aiBaseUrl ?? previous.aiBaseUrl, 'AI base URL', { allowEmpty: false });
  const legacyAiModel = `${input.aiModel ?? previous.aiModel ?? ''}`.trim();
  const proModels = mergeProviderModels(input.proModels, existingProviderModels.proModels, 'PRO', { required: true });
  const liteModels = mergeProviderModels(
    input.liteModels,
    existingProviderModels.liteModels,
    'LITE',
    { required: true }
  );
  const visionModel = mergeProviderModel(
    input.visionModel,
    existingProviderModels.visionModel,
    'Vision',
    { required: false }
  );
  const manualModels = mergeManualModels(input.manualModels, existingManualModels);
  const pineconeInput = input.pinecone && typeof input.pinecone === 'object' ? input.pinecone : {};
  const webSearchInput = input.webSearch && typeof input.webSearch === 'object' ? input.webSearch : {};
  const webReaderInput = input.webReader && typeof input.webReader === 'object' ? input.webReader : {};
  const cloudTtsInput = input.cloudTts && typeof input.cloudTts === 'object' ? input.cloudTts : {};
  const imageGenerationInput = input.imageGeneration && typeof input.imageGeneration === 'object'
    ? input.imageGeneration
    : {};
  if (!Array.isArray(input.proModels) && proModels.length === 0 && legacyAiApiKey && legacyAiModel) {
    proModels.push({ id: 'pro-legacy', baseUrl: legacyAiBaseUrl, apiKey: legacyAiApiKey, model: legacyAiModel });
  }
  const notesUrl = defaultSettings().notesUrl
    || normalizeUrl(input.notesUrl ?? previous.notesUrl, 'Notes URL');
  const voiceMode = ['off', 'local', 'remote'].includes(input.voiceMode) ? input.voiceMode : 'off';
  const voiceExternalUrl = normalizeUrl(input.voiceExternalUrl ?? previous.voiceExternalUrl, 'Voice URL');
  let voiceToken = `${input.voiceToken || ''}`.trim() || backendEnv.VOICE_TRANSCRIBE_TOKEN || voiceEnv.VOICE_TRANSCRIBE_TOKEN || '';

  if ((telegramEnabled || notesEnabled) && !telegramToken) throw new Error('Telegram token is required when Telegram or Notes is enabled');
  if (voiceMode === 'remote' && !voiceExternalUrl) throw new Error('External Voice URL is required');
  if (voiceMode !== 'off' && !voiceToken) voiceToken = randomSecret(32);

  const internalToken = backendEnv.BACKEND_INTERNAL_TOKEN || telegramEnv.BACKEND_INTERNAL_TOKEN || randomSecret(32);
  Object.assign(backendEnv, {
    API_JWT_SECRET: backendEnv.API_JWT_SECRET || randomSecret(32),
    BACKEND_INTERNAL_TOKEN: internalToken,
    ENCRYPTION_KEY: backendEnv.ENCRYPTION_KEY || randomSecret(32),
    TIMEWEB_API_KEY: proModels[0]?.apiKey || legacyAiApiKey,
    TIMEWEB_BASE_URL: proModels[0]?.baseUrl || legacyAiBaseUrl,
    TIMEWEB_PROXY_URL: proModels[0]?.proxyUrl || '',
    TELEGRAM_TOKEN: telegramToken,
    BACKEND_VOICE_API_ENABLED: voiceMode === 'off' ? '0' : '1',
    VOICE_TRANSCRIBE_URL: voiceMode === 'local' ? 'http://voice:3030/api/voice' : voiceMode === 'remote' ? voiceExternalUrl : '',
    VOICE_TRANSCRIBE_TOKEN: voiceMode === 'off' ? '' : voiceToken
  });
  // TTS endpoints are derived from VOICE_TRANSCRIBE_URL. Remove stale
  // overrides when switching between local and remote Voice installations.
  delete backendEnv.VOICE_TTS_URL;
  delete backendEnv.VOICE_SILERO_URL;
  if (proModels.length) {
    backendEnv.TIMEWEB_MODEL = proModels[0].model;
    backendEnv.TIMEWEB_PRO_ENDPOINTS = serializeProviderModels(proModels);
  } else {
    delete backendEnv.TIMEWEB_MODEL;
    delete backendEnv.TIMEWEB_PRO_ENDPOINTS;
  }
  if (liteModels.length) {
    backendEnv.TIMEWEB_LITE_BASE_URL = liteModels[0].baseUrl;
    backendEnv.TIMEWEB_LITE_API_KEY = liteModels[0].apiKey;
    backendEnv.TIMEWEB_LITE_MODEL = liteModels[0].model;
    backendEnv.TIMEWEB_LITE_PROXY_URL = liteModels[0].proxyUrl || '';
    backendEnv.TIMEWEB_LITE_ENDPOINTS = serializeProviderModels(liteModels);
  } else {
    delete backendEnv.TIMEWEB_LITE_BASE_URL;
    delete backendEnv.TIMEWEB_LITE_API_KEY;
    delete backendEnv.TIMEWEB_LITE_MODEL;
    delete backendEnv.TIMEWEB_LITE_PROXY_URL;
    delete backendEnv.TIMEWEB_LITE_ENDPOINTS;
  }
  backendEnv.TIMEWEB_LITE_ROUTER_ENABLED = '1';
  if (visionModel) {
    backendEnv.TIMEWEB_VISION_BASE_URL = visionModel.baseUrl;
    backendEnv.TIMEWEB_VISION_API_KEY = visionModel.apiKey;
    backendEnv.TIMEWEB_VISION_MODEL = visionModel.model;
    backendEnv.TIMEWEB_VISION_PROXY_URL = visionModel.proxyUrl || '';
    if (visionModel.uniqueId) {
      backendEnv.TIMEWEB_VISION_UNIQUE_ID = visionModel.uniqueId;
    } else {
      delete backendEnv.TIMEWEB_VISION_UNIQUE_ID;
    }
  } else {
    delete backendEnv.TIMEWEB_VISION_BASE_URL;
    delete backendEnv.TIMEWEB_VISION_API_KEY;
    delete backendEnv.TIMEWEB_VISION_MODEL;
    delete backendEnv.TIMEWEB_VISION_PROXY_URL;
    delete backendEnv.TIMEWEB_VISION_UNIQUE_ID;
  }
  // These variables were briefly introduced for a Vision cascade, but the
  // backend uses a single Vision PRO model.
  delete backendEnv.TIMEWEB_VISION_ENDPOINTS;
  delete backendEnv.TIMEWEB_LITE_VISION_ENDPOINTS;
  if (manualModels.length) backendEnv.MODELS_MANUAL = serializeManualModels(manualModels);
  else delete backendEnv.MODELS_MANUAL;
  backendEnv.PINECONE_API_KEY = mergeSecret(pineconeInput.apiKey, backendEnv.PINECONE_API_KEY, 'Pinecone API key');
  backendEnv.PINECONE_INDEX_NAME = validateEnvPart(
    pineconeInput.indexName ?? backendEnv.PINECONE_INDEX_NAME ?? 'bot-memory',
    'Pinecone index name'
  );
  backendEnv.TIMEWEB_EMBED_BASE_URL = normalizeUrl(
    pineconeInput.embeddingBaseUrl ?? backendEnv.TIMEWEB_EMBED_BASE_URL ?? proModels[0]?.baseUrl,
    'Embedding API URL',
    { allowEmpty: false }
  );
  backendEnv.TIMEWEB_EMBED_API_KEY = mergeSecret(
    pineconeInput.embeddingApiKey,
    backendEnv.TIMEWEB_EMBED_API_KEY,
    'Embedding API key'
  );
  if (backendEnv.PINECONE_API_KEY || backendEnv.TIMEWEB_EMBED_API_KEY) {
    if (!backendEnv.PINECONE_API_KEY) throw new Error('Pinecone API key is required');
    if (!backendEnv.TIMEWEB_EMBED_API_KEY) throw new Error('Embedding API key is required');
  }
  backendEnv.TIMEWEB_EMBED_MODEL = validateEnvPart(
    pineconeInput.embeddingModel ?? backendEnv.TIMEWEB_EMBED_MODEL ?? backendEnv.VECTOR_EMBED_MODEL ?? 'text-embedding-3-small',
    'Embedding model'
  );
  backendEnv.TAVILY_API_BASE_URL = normalizeUrl(
    webSearchInput.baseUrl ?? backendEnv.TAVILY_API_BASE_URL ?? 'https://api.tavily.com',
    'Web Search API URL',
    { allowEmpty: false }
  );
  backendEnv.TAVILY_API_KEY = mergeSecret(webSearchInput.apiKey, backendEnv.TAVILY_API_KEY, 'Web Search API key');
  backendEnv.BROWSERLESS_BASE_URL = normalizeUrl(
    webReaderInput.baseUrl ?? backendEnv.BROWSERLESS_BASE_URL ?? 'https://production-sfo.browserless.io',
    'Web Reader API URL',
    { allowEmpty: false }
  );
  backendEnv.BROWSERLESS_TOKEN = mergeSecret(webReaderInput.token, backendEnv.BROWSERLESS_TOKEN, 'Web Reader token');
  backendEnv.CARTESIA_API_KEY = mergeSecret(cloudTtsInput.apiKey, backendEnv.CARTESIA_API_KEY, 'Cloud TTS API key');
  backendEnv.CARTESIA_MODEL_ID = validateEnvPart(
    cloudTtsInput.model ?? backendEnv.CARTESIA_MODEL_ID ?? 'sonic-3.5',
    'Cloud TTS model'
  );
  backendEnv.OPENROUTER_BASE_URL = OPENROUTER_BASE_URL;
  backendEnv.OPENROUTER_API_KEY = mergeSecret(
    imageGenerationInput.apiKey,
    backendEnv.OPENROUTER_API_KEY,
    'OpenRouter image API key'
  );
  backendEnv.IMAGE_GEN_MODEL = validateEnvPart(
    imageGenerationInput.model ?? backendEnv.IMAGE_GEN_MODEL ?? 'x-ai/grok-imagine-image-quality',
    'Image generation model'
  );
  backendEnv.IMAGE_GEN_MAX_RESOLUTION = imageGenerationInput.maxResolution === '1K' ? '1K' : '2K';
  backendEnv.IMAGE_GEN_QUALITY = ['low', 'medium', 'high'].includes(imageGenerationInput.quality)
    ? imageGenerationInput.quality
    : 'auto';
  backendEnv.IMAGE_GEN_SUPPORTED_PARAMETERS = Array.isArray(imageGenerationInput.supportedParameters)
    ? imageGenerationInput.supportedParameters
      .filter((value) => ['resolution', 'quality', 'input_references'].includes(value))
      .join(',') || 'none'
    : backendEnv.IMAGE_GEN_SUPPORTED_PARAMETERS || 'resolution,input_references';

  Object.assign(telegramEnv, {
    TELEGRAM_TOKEN: telegramToken,
    BACKEND_INTERNAL_TOKEN: internalToken,
    NOTES_WEBAPP_URL: notesUrl,
    TG_USE_RICH_STREAMING: telegramRichStreaming ? '1' : '0'
  });
  Object.assign(voiceEnv, {
    VOICE_TRANSCRIBE_TOKEN: voiceToken,
    VOICE_API_PORT: voiceEnv.VOICE_API_PORT || '3030',
    VOICE_TRANSCRIBE_LANGUAGE: voiceEnv.VOICE_TRANSCRIBE_LANGUAGE || 'auto',
    TTS_DEFAULT_LANGUAGE: voiceEnv.TTS_DEFAULT_LANGUAGE || 'ru',
    TTS_RU_PROVIDER: voiceEnv.TTS_RU_PROVIDER || 'silero',
    TTS_EN_PROVIDER: voiceEnv.TTS_EN_PROVIDER || 'piper'
  });

  writeEnv(BACKEND_ENV_FILE, backendEnv);
  writeEnv(TELEGRAM_ENV_FILE, telegramEnv);
  writeEnv(VOICE_ENV_FILE, voiceEnv);
  const settings = {
    telegramEnabled,
    telegramRichStreaming,
    notesEnabled,
    notesUrl,
    aiBaseUrl: proModels[0]?.baseUrl || legacyAiBaseUrl,
    aiModel: proModels.map(model => model.model).join(','),
    voiceMode,
    voiceExternalUrl,
    updatedAt: new Date().toISOString()
  };
  atomicWrite(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
  return settings;
}

const composeArgs = (...args) => [
  'compose',
  '--project-name', PROJECT_NAME,
  '--project-directory', PROJECT_DIR,
  '--env-file', COMPOSE_RUNTIME_ENV_FILE,
  '-f', COMPOSE_FILE,
  ...args
];

function runDocker(args, timeoutMs = 20 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(DOCKER_BIN, args, {
      cwd: PROJECT_DIR,
      env: {
        ...process.env,
        // The manager process keeps the image tag it received at container
        // startup. Read the current channel from compose.env for every Docker
        // invocation so switching branches works without restarting manager.
        CHATTER_IMAGE_TAG: currentImageTag(),
        CHATTER_IMAGE_PREFIX: currentImagePrefix(),
        BACKEND_ENV_FILE,
        TELEGRAM_ENV_FILE,
        VOICE_ENV_FILE,
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const append = (current, chunk) => {
      const next = current + chunk.toString();
      return next.length > 20000 ? next.slice(-20000) : next;
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Docker operation timed out')); }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error([stderr.trim(), stdout.trim()].filter(Boolean).join('\n') || `docker exited with code ${code}`));
    });
  });
}

const SERVER_IMAGE_SUFFIXES = {
  backend: 'backend',
  'telegram-bot': 'telegram-bot',
  'webapp-notes': 'webapp-notes',
  voice: 'voice',
  'admin-panel': 'admin-panel',
  'chatter-manager': 'manager'
};

function serverUpdatesSupported() {
  const tag = currentImageTag();
  return process.env.CHATTER_PULL_IMAGES === '1'
    // 'local' means images were built on the host — there is no registry to pull from.
    && tag && tag !== 'local'
    && path.isAbsolute(HOST_PROJECT_DIR)
    && path.isAbsolute(HOST_CONFIG_DIR)
    && HOST_PROJECT_DIR !== '/'
    && HOST_CONFIG_DIR !== '/';
}

function readUpdateState() {
  const state = loadJson(UPDATE_STATE_FILE, { status: 'idle', targetHash: '', message: '', updatedAt: null });
  const active = ['queued', 'backup', 'restarting'].includes(state.status);
  const updatedAt = Date.parse(state.updatedAt) || 0;
  if (active && Date.now() - updatedAt > 60 * 60 * 1000) {
    return { ...state, status: 'failed', message: 'server_update_timed_out' };
  }
  return state;
}

function writeUpdateState(patch) {
  const state = { ...readUpdateState(), ...patch, updatedAt: new Date().toISOString() };
  atomicWrite(UPDATE_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

function serverUpdateInProgress() {
  return Boolean(updatePromise) || ['queued', 'backup', 'restarting'].includes(readUpdateState().status);
}

async function updateServiceSelection() {
  const settings = loadSettings();
  const profiles = ['admin'];
  if (settings.telegramEnabled) profiles.push('telegram');
  if (settings.notesEnabled) profiles.push('notes');
  if (settings.voiceMode === 'local') profiles.push('voice');

  const profileArgs = profiles.flatMap(profile => ['--profile', profile]);
  const output = await runDocker(composeArgs(...profileArgs, 'config', '--format', 'json'), 30000);
  const config = JSON.parse(output);
  const serviceEntries = Object.entries(config.services || {});
  const services = serviceEntries.map(([service]) => service);
  const images = Object.fromEntries(serviceEntries.map(([service, definition]) => [
    service,
    `${definition?.image || ''}`.trim(),
  ]));
  const releasePrefix = `${currentImagePrefix()}-`;
  const releaseServices = services.filter(service => images[service].startsWith(releasePrefix));
  const externalServices = services.filter(service => !releaseServices.includes(service));

  if (!releaseServices.includes('chatter-manager')) {
    throw new Error('compose_manager_service_missing');
  }

  return { profiles, services, images, releaseServices, externalServices };
}

let lastPullTime = 0;
const PULL_COOLDOWN_MS = 5 * 60 * 1000;

function imageReference(service) {
  const suffix = SERVER_IMAGE_SUFFIXES[service];
  const prefix = currentImagePrefix();
  const tag = currentImageTag();
  if (!suffix || !prefix || !tag || /[\s'"`$]/.test(`${prefix}${tag}`)) throw new Error('invalid_server_image_reference');
  return `${prefix}-${suffix}:${tag}`;
}

const BUNDLED_COMPOSE_FILE = '/app/release/docker-compose.yml';

async function syncBundledComposeFile() {
  if (!serverUpdatesSupported()) return false;
  if (!fs.existsSync(BUNDLED_COMPOSE_FILE)) throw new Error('bundled_compose_file_missing');

  const bundledCompose = fs.readFileSync(BUNDLED_COMPOSE_FILE);
  const installedCompose = fs.readFileSync(COMPOSE_FILE);
  if (bundledCompose.equals(installedCompose)) return false;

  const managerImage = imageReference('chatter-manager');
  await runDocker([
    'compose',
    '--project-name', PROJECT_NAME,
    '--project-directory', PROJECT_DIR,
    '--env-file', COMPOSE_RUNTIME_ENV_FILE,
    '-f', BUNDLED_COMPOSE_FILE,
    '--profile', '*',
    'config', '--format', 'json',
  ], 30000);

  const script = `set -eu
if cmp -s /app/release/docker-compose.yml /host-project/docker-compose.yml; then
  exit 0
fi
cp /host-project/docker-compose.yml /host-project/docker-compose.yml.previous
cat /app/release/docker-compose.yml > /host-project/docker-compose.yml`;

  await runDocker([
    'run', '--rm',
    '--entrypoint', '/bin/sh',
    '--volume', `${HOST_PROJECT_DIR}:/host-project`,
    managerImage,
    '-c', script,
  ], 60000);
  console.log('[manager] synchronized bundled docker-compose.yml', {
    backup: `${HOST_PROJECT_DIR}/docker-compose.yml.previous`,
  });
  return true;
}

async function reconcileNewComposeServices() {
  if (!serverUpdatesSupported()) return true;
  if (serverUpdateInProgress()) return false;

  const composeChanged = await syncBundledComposeFile();
  const selection = await updateServiceSelection();
  const profileArgs = selection.profiles.flatMap(profile => ['--profile', profile]);
  const existingOutput = await runDocker(
    composeArgs(...profileArgs, 'ps', '-a', '--services'),
    30000,
  );
  const existingServices = new Set(existingOutput.split(/\r?\n/).filter(Boolean));
  const missingServices = selection.services.filter(service => !existingServices.has(service));

  console.log('[manager] discovered compose services', {
    releaseServices: selection.releaseServices,
    externalServices: selection.externalServices,
    missingServices,
  });
  const servicesToReconcile = composeChanged
    ? selection.services.filter(service => service !== 'chatter-manager')
    : missingServices;
  if (!servicesToReconcile.length) return true;

  if (process.env.CHATTER_PULL_IMAGES === '1') {
    await runDocker(
      composeArgs(...profileArgs, 'pull', ...servicesToReconcile),
      60 * 60 * 1000,
    );
  }
  await runDocker(
    composeArgs(...profileArgs, 'up', '-d', '--no-build', '--pull', 'never', ...servicesToReconcile),
    10 * 60 * 1000,
  );
  console.log('[manager] reconciled compose services', {
    composeChanged,
    services: servicesToReconcile,
  });
  return true;
}

function scheduleComposeBootstrap(attempt = 1) {
  setTimeout(() => {
    void reconcileNewComposeServices()
      .then((complete) => {
        if (!complete && attempt < 20) scheduleComposeBootstrap(attempt + 1);
      })
      .catch((error) => {
        console.error('[manager] compose bootstrap failed', { attempt, error });
        if (attempt < 20) scheduleComposeBootstrap(attempt + 1);
      });
  }, 15000).unref();
}

async function inspectImage(reference) {
  const [idOutput, configOutput] = await Promise.all([
    runDocker(['image', 'inspect', '--format', '{{json .Id}}', reference], 30000),
    runDocker(['image', 'inspect', '--format', '{{json .Config}}', reference], 30000)
  ]);
  const id = JSON.parse(idOutput);
  const config = JSON.parse(configOutput);
  return {
    id: `${id || ''}`,
    revision: `${config?.Labels?.['org.opencontainers.image.revision'] || ''}`,
    changelog: decodeImageChangelog(config?.Labels?.['io.chatter.server.changelog-base64'])
  };
}

function decodeImageChangelog(value) {
  if (!value) return {};
  try {
    const decoded = Buffer.from(`${value}`, 'base64').toString('utf8').trim();
    const parsed = JSON.parse(decoded);
    if (Array.isArray(parsed?.changes)) {
      return { en: parsed.changes.filter(change => typeof change === 'string' && change.trim()).map(change => change.trim()) };
    }
    if (!parsed?.changes || typeof parsed.changes !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed.changes).flatMap(([locale, changes]) => {
      if (!Array.isArray(changes)) return [];
      return [[locale, changes.filter(change => typeof change === 'string' && change.trim()).map(change => change.trim())]];
    }));
  } catch {
    return {};
  }
}

async function inspectRunningService(service, profiles) {
  const profileArgs = profiles.flatMap(profile => ['--profile', profile]);
  const containerId = await runDocker(composeArgs(...profileArgs, 'ps', '-a', '-q', service), 30000);
  if (!containerId) return null;
  const imageId = await runDocker(['inspect', '--format', '{{.Image}}', containerId.split(/\r?\n/)[0]], 30000);
  if (!imageId) return null;
  return inspectImage(imageId);
}

function shortImageHash(image) {
  if (!image) return '—';
  if (image.revision) return image.revision.slice(0, 7);
  return image.id.replace(/^sha256:/, '').slice(0, 12) || '—';
}

async function getServerUpdateInfo({ pull = false, forcePull = false } = {}) {
  const result = {
    supported: serverUpdatesSupported(),
    imageTag: currentImageTag(),
    installedHash: '—',
    latestHash: '—',
    available: false,
    changedServices: [],
    changelog: {},
    rebuiltFromSameCommit: false,
    checkedAt: null,
    operation: readUpdateState()
  };
  if (!result.supported) return result;
  const selection = await updateServiceSelection();
  const profileArgs = selection.profiles.flatMap(profile => ['--profile', profile]);
  if (pull) {
    const now = Date.now();
    if (forcePull || now - lastPullTime >= PULL_COOLDOWN_MS) {
      await runDocker(composeArgs(...profileArgs, 'pull', ...selection.releaseServices), 60 * 60 * 1000);
      lastPullTime = now;
    }
    result.checkedAt = new Date().toISOString();
  }
  const comparisons = await Promise.all(selection.releaseServices.map(async (service) => {
    const [running, latest] = await Promise.all([
      inspectRunningService(service, selection.profiles),
      inspectImage(selection.images[service])
    ]);
    const changed = Boolean(running && latest.id && (
      running.revision && latest.revision
        ? running.revision !== latest.revision
        : running.id !== latest.id
    ));
    return { service, running, latest, changed };
  }));
  const manager = comparisons.find(item => item.service === 'chatter-manager');
  result.installedHash = shortImageHash(manager?.running);
  result.latestHash = shortImageHash(manager?.latest);
  result.changelog = manager?.latest?.changelog || {};
  result.changedServices = comparisons.filter(item => item.changed).map(item => item.service);
  result.available = result.changedServices.length > 0;
  result.rebuiltFromSameCommit = false;
  return result;
}

async function launchServerUpdateHelper(targetHash, selection) {
  const managerImage = selection.images['chatter-manager'] || imageReference('chatter-manager');
  const profileArgs = selection.profiles.flatMap(profile => ['--profile', profile]);
  const listContainersCommand = [
    'docker', 'compose', '--project-name', '"$COMPOSE_PROJECT_NAME"',
    '--project-directory', '"$HOST_PROJECT_DIR"',
    '--env-file', '"$HOST_CONFIG_DIR/compose.env"',
    '-f', '"$HOST_PROJECT_DIR/docker-compose.yml"',
    ...profileArgs,
    'ps', '-a', '-q', ...selection.services
  ].join(' ');
  // Stop the running services BEFORE recreating them. Otherwise the backend
  // keeps chatter.db open and the recreation step fails with "database is
  // being used by another connection" on servers with slow I/O. The helper
  // runs in a standalone container detached from the project, so it keeps
  // executing even after every service it stops has gone away.
  const stopCommand = [
    'docker', 'compose', '--project-name', '"$COMPOSE_PROJECT_NAME"',
    '--project-directory', '"$HOST_PROJECT_DIR"',
    '--env-file', '"$HOST_CONFIG_DIR/compose.env"',
    '-f', '"$HOST_PROJECT_DIR/docker-compose.yml"',
    ...profileArgs,
    'stop', ...selection.services
  ].join(' ');
  const composeCommand = [
    'docker', 'compose', '--project-name', '"$COMPOSE_PROJECT_NAME"',
    '--project-directory', '"$HOST_PROJECT_DIR"',
    '--env-file', '"$HOST_CONFIG_DIR/compose.env"',
    '-f', '"$HOST_PROJECT_DIR/docker-compose.yml"',
    ...profileArgs,
    'up', '-d', '--no-build', '--pull', 'never', '--force-recreate', '--wait', '--wait-timeout', '180',
    ...selection.services
  ].join(' ');
  const script = `set -eu
report_failure() {
  code=$?
  if [ "$code" -ne 0 ]; then
    printf '{"status":"failed","targetHash":"%s","message":"server_restart_failed","updatedAt":"%s"}\n' "$TARGET_HASH" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$HOST_CONFIG_DIR/server-update.json"
  fi
}
trap report_failure EXIT
sleep 2
OLD_IMAGE_IDS=""
for CONTAINER_ID in $(${listContainersCommand}); do
  IMAGE_ID="$(docker inspect --format '{{.Image}}' "$CONTAINER_ID")"
  OLD_IMAGE_IDS="$OLD_IMAGE_IDS $IMAGE_ID"
done
${stopCommand}
${composeCommand}
# Remove only the previous images used by this Chatter installation. Docker
# refuses to remove an image that is still used by any container, so shared or
# unchanged images remain safe. Cleanup is best-effort, but every outcome is
# logged to server-update.log in the config directory so failures are visible.
LOG_FILE="$HOST_CONFIG_DIR/server-update.log"
log() { printf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG_FILE"; }
log "update to $TARGET_HASH: cleaning up old images"
for IMAGE_ID in $OLD_IMAGE_IDS; do
  if docker image rm "$IMAGE_ID" >> "$LOG_FILE" 2>&1; then
    log "removed old image $IMAGE_ID"
  else
    log "could not remove image $IMAGE_ID (still used by a container or shared)"
  fi
done
# Drop dangling layers left behind by docker pull replacing tags (e.g. the old
# 'latest' image after switching to a branch tag). -f only affects untagged
# images, so tagged images of other projects are safe.
docker image prune -f >> "$LOG_FILE" 2>&1 || log "docker image prune failed"
printf '{"status":"complete","targetHash":"%s","message":"server_update_complete","updatedAt":"%s"}\n' "$TARGET_HASH" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$HOST_CONFIG_DIR/server-update.json"`;
  await runDocker([
    'run', '--detach', '--rm', '--name', `chatter-server-updater-${Date.now()}`,
    '--entrypoint', '/bin/sh',
    '--env', `HOST_PROJECT_DIR=${HOST_PROJECT_DIR}`,
    '--env', `HOST_CONFIG_DIR=${HOST_CONFIG_DIR}`,
    '--env', `COMPOSE_PROJECT_NAME=${PROJECT_NAME}`,
    '--env', `TARGET_HASH=${targetHash}`,
    '--volume', '/var/run/docker.sock:/var/run/docker.sock',
    '--volume', `${HOST_PROJECT_DIR}:${HOST_PROJECT_DIR}:ro`,
    '--volume', `${HOST_CONFIG_DIR}:${HOST_CONFIG_DIR}`,
    managerImage, '-c', script
  ], 60000);
}

async function performServerUpdate(snapshot) {
  const selection = await updateServiceSelection();
  try {
    writeUpdateState({ status: 'backup', targetHash: snapshot.latestHash, message: 'creating_backup' });
    // Stop the data services BEFORE taking the backup. The backend keeps
    // chatter.db open; running `sqlite3 .backup` against a live database on
    // slow-I/O hosts aborts with "database is locked" while the backend is
    // checkpointing its WAL. The manager itself is not stopped here (it owns
    // this update flow), and launchServerUpdateHelper recreates everything,
    // including the manager, from a detached container.
    await stopDataServicesForUpdate(selection);
    await createBackup({ includeUploads: false, source: 'automatic' });
    writeUpdateState({ status: 'restarting', targetHash: snapshot.latestHash, message: 'restarting_server_services' });
    await launchServerUpdateHelper(snapshot.latestHash, selection);
  } catch (error) {
    writeUpdateState({ status: 'failed', targetHash: snapshot.latestHash, message: error.message || 'server_update_failed' });
    throw error;
  }
}

// Stops only the services that touch chatter.db / uploads. The manager and
// admin-panel are left running: the manager drives this update, and the panel
// needs to keep polling /api/server/updates/state. The helper container later
// recreates (and thus restarts) every selected service, including the manager.
async function stopDataServicesForUpdate(selection) {
  const profileArgs = selection.profiles.flatMap(profile => ['--profile', profile]);
  const dataServices = selection.services.filter(service => service !== 'chatter-manager' && service !== 'admin-panel');
  if (dataServices.length === 0) return;
  await runDocker(composeArgs(...profileArgs, 'stop', ...dataServices), 3 * 60 * 1000);
}

function runProcess(command, args, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const append = (chunk) => {
      output += chunk.toString();
      if (output.length > 1024 * 1024) output = output.slice(-1024 * 1024);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output.trim());
      else reject(new Error(output.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function pathSize(targetPath) {
  if (!fs.existsSync(targetPath)) return 0;
  try {
    const output = await runProcess('du', ['-sk', targetPath], 30000);
    return Math.max(0, Number.parseInt(output, 10) || 0) * 1024;
  } catch {
    return 0;
  }
}

function readMemoryInfo() {
  const values = {};
  try {
    for (const line of fs.readFileSync('/proc/meminfo', 'utf8').split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/);
      if (match) values[match[1]] = Number(match[2]) * 1024;
    }
  } catch {
    return {
      total: os.totalmem(),
      available: os.freemem(),
      swapTotal: 0,
      swapFree: 0
    };
  }
  return {
    total: values.MemTotal || os.totalmem(),
    available: values.MemAvailable || values.MemFree || os.freemem(),
    swapTotal: values.SwapTotal || 0,
    swapFree: values.SwapFree || 0
  };
}

const cpuSnapshot = () => os.cpus().reduce((result, cpu) => {
  const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  return { idle: result.idle + cpu.times.idle, total: result.total + total };
}, { idle: 0, total: 0 });

async function cpuUsagePercent() {
  const before = cpuSnapshot();
  await new Promise((resolve) => setTimeout(resolve, 120));
  const after = cpuSnapshot();
  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  return total > 0 ? Math.max(0, Math.min(100, Math.round((1 - idle / total) * 1000) / 10)) : 0;
}

async function getSystemInfo() {
  const memory = readMemoryInfo();
  const disk = fs.statfsSync(DATA_DIR);
  const [cpuUsage, uploadsSize, backupsSize] = await Promise.all([
    cpuUsagePercent(),
    pathSize(UPLOADS_DIR),
    pathSize(BACKUPS_DIR)
  ]);
  const databaseSize = fs.existsSync(DATABASE_FILE) ? fs.statSync(DATABASE_FILE).size : 0;
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    uptimeSeconds: Math.floor(os.uptime()),
    cpu: {
      model: os.cpus()[0]?.model || 'Unknown CPU',
      cores: os.cpus().length,
      usagePercent: cpuUsage,
      loadAverage: os.loadavg()
    },
    memory: {
      total: memory.total,
      used: Math.max(0, memory.total - memory.available),
      available: memory.available
    },
    swap: {
      total: memory.swapTotal,
      used: Math.max(0, memory.swapTotal - memory.swapFree),
      available: memory.swapFree
    },
    disk: {
      total: disk.blocks * disk.bsize,
      available: disk.bavail * disk.bsize,
      used: (disk.blocks - disk.bfree) * disk.bsize
    },
    storage: { databaseSize, uploadsSize, backupsSize }
  };
}

let metricsSaveCounter = 0;

async function collectMetricsSnapshot() {
  try {
    const info = await getSystemInfo();
    metricsHistory.push({
      ts: Date.now(),
      cpu: info.cpu.usagePercent,
      memUsed: info.memory.used,
      memTotal: info.memory.total,
      swapUsed: info.swap.used,
      swapTotal: info.swap.total,
      diskUsed: info.disk.used,
      diskTotal: info.disk.total,
    });
    if (metricsHistory.length > METRICS_MAX) metricsHistory.splice(0, metricsHistory.length - METRICS_MAX);
    // Persist every 10 snapshots (every 10 minutes)
    if (++metricsSaveCounter >= 10) {
      metricsSaveCounter = 0;
      atomicWrite(METRICS_FILE, `${JSON.stringify(metricsHistory)}\n`);
    }
  } catch (error) {
    console.error('[manager] metrics collection failed:', error.message);
  }
}

function downsample(arr, target) {
  if (arr.length <= target) return arr;
  const step = arr.length / target;
  const result = [];
  for (let i = 0; i < target; i++) {
    const slice = arr.slice(Math.floor(i * step), Math.floor((i + 1) * step));
    const avg = (field) => Math.round(slice.reduce((s, p) => s + p[field], 0) / slice.length);
    result.push({ ...slice[0], cpu: avg('cpu'), memUsed: avg('memUsed'), swapUsed: avg('swapUsed'), diskUsed: avg('diskUsed') });
  }
  return result;
}

const safeBackupName = (name) => /^chatter-[A-Za-z0-9._-]+\.tar\.gz$/.test(name) ? name : '';

async function readBackupManifest(filePath) {
  try {
    return JSON.parse(await runProcess('tar', ['-xOzf', filePath, 'manifest.json'], 30000));
  } catch {
    return null;
  }
}

function listBackups() {
  // Fast listing — only stat, no tar extraction. Manifest fields are loaded lazily by the frontend.
  const entries = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && safeBackupName(entry.name));
  const backups = entries.map((entry) => {
    const filePath = path.join(BACKUPS_DIR, entry.name);
    const stat = fs.statSync(filePath);
    return {
      name: entry.name,
      size: stat.size,
      createdAt: stat.birthtime.toISOString(),
    };
  });
  return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function createBackup({ includeUploads = false, includeConfiguration = false, source = 'manual' } = {}) {
  if (!fs.existsSync(DATABASE_FILE)) throw new Error('Chatter database was not found');
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const timestamp = createdAt.replace(/[:.]/g, '-');
  const suffix = includeUploads ? 'full' : 'database';
  const name = `chatter-${timestamp}-${suffix}.tar.gz`;
  const tempDir = path.join(BACKUPS_DIR, `.tmp-${id}`);
  const tempArchive = path.join(BACKUPS_DIR, `.tmp-${id}.tar.gz`);
  const destination = path.join(BACKUPS_DIR, name);
  fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  try {
    const databaseCopy = path.join(tempDir, 'database.sqlite');
    await runProcess('sqlite3', [DATABASE_FILE, `.backup ${databaseCopy}`]);
    const hasUploads = includeUploads && fs.existsSync(UPLOADS_DIR);
    const configurationFiles = includeConfiguration
      ? BACKUP_CONFIG_FILES.filter((file) => fs.existsSync(path.join(CONFIG_DIR, file)))
      : [];
    if (configurationFiles.length) {
      const configBackupDir = path.join(tempDir, 'config');
      fs.mkdirSync(configBackupDir, { recursive: true, mode: 0o700 });
      for (const file of configurationFiles) {
        fs.copyFileSync(path.join(CONFIG_DIR, file), path.join(configBackupDir, file));
        fs.chmodSync(path.join(configBackupDir, file), 0o600);
      }
    }
    const manifest = {
      format: 'chatter-backup',
      schemaVersion: 1,
      createdAt,
      version: process.env.CHATTER_IMAGE_TAG || 'local',
      includesUploads: hasUploads,
      includesConfiguration: configurationFiles.length > 0,
      configurationFiles,
      source: source === 'automatic' ? 'automatic' : 'manual'
    };
    fs.writeFileSync(path.join(tempDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const tarArgs = ['-czf', tempArchive, '-C', tempDir, 'manifest.json', 'database.sqlite'];
    if (configurationFiles.length) tarArgs.push('config');
    if (hasUploads) {
      fs.symlinkSync(UPLOADS_DIR, path.join(tempDir, 'uploads'), 'dir');
      tarArgs[0] = '-chzf';
      tarArgs.push('uploads');
    }
    await runProcess('tar', tarArgs, 60 * 60 * 1000);
    fs.renameSync(tempArchive, destination);
    return (await listBackups()).find((backup) => backup.name === name);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(tempArchive, { force: true });
  }
}

function getBackupSchedule() {
  const stored = loadJson(BACKUP_SCHEDULE_FILE, {});
  return {
    frequency: ['daily', 'weekly'].includes(stored.frequency) ? stored.frequency : 'off',
    includeUploads: stored.includeUploads === true,
    retention: Math.min(30, Math.max(1, Number.parseInt(stored.retention, 10) || 7)),
    lastRunAt: typeof stored.lastRunAt === 'string' ? stored.lastRunAt : ''
  };
}

function saveBackupSchedule(input) {
  const current = getBackupSchedule();
  const schedule = {
    frequency: ['daily', 'weekly'].includes(input.frequency) ? input.frequency : 'off',
    includeUploads: input.includeUploads === true,
    retention: Math.min(30, Math.max(1, Number.parseInt(input.retention, 10) || 7)),
    lastRunAt: current.lastRunAt
  };
  atomicWrite(BACKUP_SCHEDULE_FILE, `${JSON.stringify(schedule, null, 2)}\n`);
  return schedule;
}

async function pruneAutomaticBackups(retention) {
  const automatic = (await listBackups()).filter((backup) => backup.source === 'automatic');
  for (const backup of automatic.slice(retention)) fs.rmSync(path.join(BACKUPS_DIR, backup.name), { force: true });
}

async function runScheduledBackupIfDue() {
  const schedule = getBackupSchedule();
  if (schedule.frequency === 'off' || backupPromise || serverUpdateInProgress()) return;
  const interval = schedule.frequency === 'weekly' ? 7 * 86400000 : 86400000;
  const lastRun = Date.parse(schedule.lastRunAt) || 0;
  if (Date.now() - lastRun < interval) return;
  backupPromise = createBackup({ includeUploads: schedule.includeUploads, source: 'automatic' })
    .then(async (backup) => {
      const updated = { ...schedule, lastRunAt: new Date().toISOString() };
      atomicWrite(BACKUP_SCHEDULE_FILE, `${JSON.stringify(updated, null, 2)}\n`);
      await pruneAutomaticBackups(schedule.retention);
      return backup;
    })
    .catch((error) => { console.error('[backups]', error.message); })
    .finally(() => { backupPromise = null; });
  await backupPromise;
}

async function sqliteQuickCheck(filePath) {
  const output = await runProcess('sqlite3', [filePath, 'PRAGMA quick_check;'], 2 * 60 * 1000);
  if (output.trim() !== 'ok') throw new Error(`SQLite integrity check failed: ${output || 'unknown error'}`);
}

async function inspectBackupArchive(filePath, extractDir) {
  const names = `${await runProcess('tar', ['-tzf', filePath], 2 * 60 * 1000)}`.split(/\r?\n/).filter(Boolean);
  const verbose = `${await runProcess('tar', ['-tvzf', filePath], 2 * 60 * 1000)}`.split(/\r?\n/).filter(Boolean);
  if (names.length === 0 || names.length !== verbose.length) throw new Error('Backup archive is empty or invalid');
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index].replace(/^\.\//, '');
    const normalized = path.posix.normalize(name);
    const allowedConfig = name === 'config' || name === 'config/' || BACKUP_CONFIG_FILES.some((file) => name === `config/${file}`);
    const allowed = name === 'manifest.json' || name === 'database.sqlite' || name === 'uploads' || name.startsWith('uploads/') || allowedConfig;
    if (!allowed || name.includes('\\') || normalized.startsWith('../') || path.posix.isAbsolute(name)) throw new Error('Backup archive contains an unsafe path');
    if (!['-', 'd'].includes(verbose[index][0])) throw new Error('Backup archive contains unsupported links or special files');
  }
  if (!names.some((name) => name.replace(/^\.\//, '') === 'manifest.json') || !names.some((name) => name.replace(/^\.\//, '') === 'database.sqlite')) {
    throw new Error('Backup archive must contain manifest.json and database.sqlite');
  }
  fs.mkdirSync(extractDir, { recursive: true, mode: 0o700 });
  await runProcess('tar', ['-xzf', filePath, '-C', extractDir], 60 * 60 * 1000);
  const manifest = loadJson(path.join(extractDir, 'manifest.json'), null);
  if (manifest?.format !== 'chatter-backup' || manifest?.schemaVersion !== 1) throw new Error('Unsupported Chatter backup format');
  await sqliteQuickCheck(path.join(extractDir, 'database.sqlite'));
  return manifest;
}

function receiveUpload(req, destination) {
  return new Promise((resolve, reject) => {
    const declaredSize = Number(req.headers['content-length'] || 0);
    if (declaredSize > MAX_BACKUP_UPLOAD_BYTES) return reject(new Error('Backup file is too large'));
    const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      output.destroy();
      fs.rmSync(destination, { force: true });
      reject(error);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BACKUP_UPLOAD_BYTES) {
        fail(new Error('Backup file is too large'));
        req.destroy();
      }
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new Error('Backup upload was interrupted')));
    output.on('error', fail);
    output.on('finish', () => {
      if (settled) return;
      settled = true;
      if (size === 0) return reject(new Error('Backup file is empty'));
      resolve(size);
    });
    req.pipe(output);
  });
}

async function importBackup(uploadPath, originalName) {
  const createdAt = new Date().toISOString();
  const timestamp = createdAt.replace(/[:.]/g, '-');
  const lowerName = originalName.toLowerCase();
  const destination = path.join(BACKUPS_DIR, `chatter-${timestamp}-imported.tar.gz`);
  const tempDir = path.join(BACKUPS_DIR, `.import-${crypto.randomUUID()}`);
  try {
    if (lowerName.endsWith('.tar.gz') || lowerName.endsWith('.tgz')) {
      const manifest = await inspectBackupArchive(uploadPath, tempDir);
      fs.writeFileSync(path.join(tempDir, 'manifest.json'), `${JSON.stringify({ ...manifest, source: 'manual', importedAt: createdAt }, null, 2)}\n`, { mode: 0o600 });
      const tarArgs = ['-czf', destination, '-C', tempDir, 'manifest.json', 'database.sqlite'];
      if (fs.existsSync(path.join(tempDir, 'uploads'))) tarArgs.push('uploads');
      if (fs.existsSync(path.join(tempDir, 'config'))) tarArgs.push('config');
      await runProcess('tar', tarArgs, 60 * 60 * 1000);
    } else if (lowerName.endsWith('.db') || lowerName.endsWith('.sqlite') || lowerName.endsWith('.sqlite3')) {
      await sqliteQuickCheck(uploadPath);
      fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
      fs.copyFileSync(uploadPath, path.join(tempDir, 'database.sqlite'));
      const manifest = {
        format: 'chatter-backup', schemaVersion: 1, createdAt,
        version: 'imported', includesUploads: false, source: 'manual'
      };
      fs.writeFileSync(path.join(tempDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      await runProcess('tar', ['-czf', destination, '-C', tempDir, 'manifest.json', 'database.sqlite']);
    } else throw new Error('Use a .db, .sqlite, .sqlite3, .tar.gz or .tgz file');
    return (await listBackups()).find((backup) => backup.name === path.basename(destination));
  } catch (error) {
    fs.rmSync(destination, { force: true });
    throw error;
  } finally {
    fs.rmSync(uploadPath, { force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function stopDataServices() {
  await runDocker(composeArgs('--profile', 'telegram', '--profile', 'notes', 'stop', 'telegram-bot', 'webapp-notes', 'backend'), 3 * 60 * 1000);
}

function setOwnershipRecursive(targetPath, uid, gid) {
  const stat = fs.lstatSync(targetPath);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(targetPath)) {
      setOwnershipRecursive(path.join(targetPath, entry), uid, gid);
    }
  }
  if (stat.isSymbolicLink()) fs.lchownSync(targetPath, uid, gid);
  else fs.chownSync(targetPath, uid, gid);
}

async function restoreBackup(name) {
  const safeName = safeBackupName(name);
  const archivePath = safeName ? path.join(BACKUPS_DIR, safeName) : '';
  if (!archivePath || !fs.existsSync(archivePath)) throw new Error('Backup was not found');
  const id = crypto.randomUUID();
  const extractDir = path.join(BACKUPS_DIR, `.restore-${id}`);
  const oldDatabase = path.join(DATA_DIR, `.restore-old-${id}.sqlite`);
  const newDatabase = path.join(DATA_DIR, `.restore-new-${id}.sqlite`);
  const oldUploads = path.join(DATA_DIR, `.restore-old-uploads-${id}`);
  const newUploads = path.join(DATA_DIR, `.restore-new-uploads-${id}`);
  let databaseMoved = false;
  let uploadsMoved = false;
  try {
    const manifest = await inspectBackupArchive(archivePath, extractDir);
    await createBackup({ includeUploads: Boolean(manifest.includesUploads), includeConfiguration: Boolean(manifest.includesConfiguration), source: 'manual' });
    await stopDataServices();

    const databaseOwner = fs.statSync(fs.existsSync(DATABASE_FILE) ? DATABASE_FILE : DATA_DIR);
    fs.copyFileSync(path.join(extractDir, 'database.sqlite'), newDatabase);
    if (fs.existsSync(DATABASE_FILE)) { fs.renameSync(DATABASE_FILE, oldDatabase); databaseMoved = true; }
    fs.renameSync(newDatabase, DATABASE_FILE);
    fs.chownSync(DATABASE_FILE, databaseOwner.uid, databaseOwner.gid);
    fs.chmodSync(DATABASE_FILE, 0o600);
    fs.rmSync(`${DATABASE_FILE}-wal`, { force: true });
    fs.rmSync(`${DATABASE_FILE}-shm`, { force: true });

    if (manifest.includesUploads && fs.existsSync(path.join(extractDir, 'uploads'))) {
      const uploadsOwner = fs.statSync(fs.existsSync(UPLOADS_DIR) ? UPLOADS_DIR : DATA_DIR);
      fs.cpSync(path.join(extractDir, 'uploads'), newUploads, { recursive: true });
      if (fs.existsSync(UPLOADS_DIR)) { fs.renameSync(UPLOADS_DIR, oldUploads); uploadsMoved = true; }
      fs.renameSync(newUploads, UPLOADS_DIR);
      setOwnershipRecursive(UPLOADS_DIR, uploadsOwner.uid, uploadsOwner.gid);
    }

    if (manifest.includesConfiguration && fs.existsSync(path.join(extractDir, 'config'))) {
      for (const file of BACKUP_CONFIG_FILES) {
        const source = path.join(extractDir, 'config', file);
        if (!fs.existsSync(source)) continue;
        atomicWrite(path.join(CONFIG_DIR, file), fs.readFileSync(source), 0o600);
      }
    }

    await applyConfiguration();
    fs.rmSync(oldDatabase, { force: true });
    fs.rmSync(oldUploads, { recursive: true, force: true });
    return { ok: true };
  } catch (error) {
    if (databaseMoved && fs.existsSync(oldDatabase)) {
      fs.rmSync(DATABASE_FILE, { force: true });
      fs.renameSync(oldDatabase, DATABASE_FILE);
    }
    if (uploadsMoved && fs.existsSync(oldUploads)) {
      fs.rmSync(UPLOADS_DIR, { recursive: true, force: true });
      fs.renameSync(oldUploads, UPLOADS_DIR);
    }
    try { await applyConfiguration(); } catch {}
    throw error;
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(newDatabase, { force: true });
    fs.rmSync(newUploads, { recursive: true, force: true });
  }
}

async function removeServices(profile, services) {
  await runDocker(composeArgs('--profile', profile, 'rm', '-s', '-f', ...services), 2 * 60 * 1000);
}

async function pullServices(profile, services) {
  if (process.env.CHATTER_PULL_IMAGES !== '1') return;
  await runDocker(composeArgs('--profile', profile, 'pull', ...services));
}

async function applyConfiguration() {
  const settings = loadSettings();
  await runDocker(composeArgs('up', '-d', '--no-build', '--force-recreate', 'backend'));
  if (settings.telegramEnabled) {
    await pullServices('telegram', ['telegram-bot']);
    await runDocker(composeArgs('--profile', 'telegram', 'up', '-d', '--no-build', 'telegram-bot'));
  } else await removeServices('telegram', ['telegram-bot']);
  if (settings.notesEnabled) {
    await pullServices('notes', ['webapp-notes']);
    await runDocker(composeArgs('--profile', 'notes', 'up', '-d', '--no-build', 'webapp-notes'));
  } else await removeServices('notes', ['webapp-notes']);
  if (settings.voiceMode === 'local') {
    await pullServices('voice', ['voice']);
    await runDocker(composeArgs('--profile', 'voice', 'up', '-d', '--no-build', 'voice'));
  } else await removeServices('voice', ['voice']);
}

async function getServiceStatus() {
  try {
    const output = await runDocker(composeArgs(
      '--profile', 'telegram',
      '--profile', 'notes',
      '--profile', 'voice',
      '--profile', 'admin',
      'ps', '-a',
      '--format', '{{.Service}}\t{{.Name}}\t{{.State}}\t{{.Health}}\t{{.Status}}'
    ), 30000);
    if (!output) return [];
    return output.split(/\r?\n/).filter(Boolean).map((line) => {
      const [service = '', name = '', state = '', health = '', ...statusParts] = line.split('\t');
      return { service, name, state: state.toLowerCase(), health: health.toLowerCase(), status: statusParts.join('\t') };
    });
  } catch (error) {
    return [{ service: 'docker', state: 'error', status: error.message }];
  }
}

const LOG_SERVICES = {
  backend: ['backend'],
  telegram: ['telegram-bot'],
  notes: ['webapp-notes'],
  voice: ['voice'],
  manager: ['chatter-manager'],
  admin: ['admin-panel']
};

const CONTROLLED_SERVICES = {
  backend: { profile: null },
  'telegram-bot': { profile: 'telegram' },
  'webapp-notes': { profile: 'notes' },
  voice: { profile: 'voice' }
};

async function controlService(service, action) {
  const config = CONTROLLED_SERVICES[service];
  if (!config) throw new Error('unknown_service');
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('unknown_service_action');
  const profileArgs = config.profile ? ['--profile', config.profile] : [];
  if (service === 'voice' && action !== 'restart') {
    const enabled = action === 'start';
    const backendEnv = parseEnv(BACKEND_ENV_FILE);
    const voiceEnv = parseEnv(VOICE_ENV_FILE);
    const voiceToken = voiceEnv.VOICE_TRANSCRIBE_TOKEN || backendEnv.VOICE_TRANSCRIBE_TOKEN || randomSecret(32);
    backendEnv.BACKEND_VOICE_API_ENABLED = enabled ? '1' : '0';
    backendEnv.VOICE_TRANSCRIBE_URL = enabled ? 'http://voice:3030/api/voice' : '';
    backendEnv.VOICE_TRANSCRIBE_TOKEN = enabled ? voiceToken : '';
    voiceEnv.VOICE_TRANSCRIBE_TOKEN = voiceToken;
    writeEnv(BACKEND_ENV_FILE, backendEnv);
    writeEnv(VOICE_ENV_FILE, voiceEnv);
  }
  if (action === 'start') {
    await runDocker(composeArgs(...profileArgs, 'up', '-d', '--no-build', service), 5 * 60 * 1000);
  } else if (action === 'restart') {
    // A plain `docker restart` reuses the existing container and never picks
    // up changes from the private env files. Recreate the container so the
    // service sees the current configuration after a single click.
    await runDocker(composeArgs(...profileArgs, 'up', '-d', '--no-build', '--force-recreate', service), 5 * 60 * 1000);
  } else {
    await runDocker(composeArgs(...profileArgs, action, service), 5 * 60 * 1000);
  }
  if (service === 'voice' && action !== 'restart') {
    await runDocker(composeArgs('up', '-d', '--no-build', '--force-recreate', 'backend'), 5 * 60 * 1000);
  }
  if (action !== 'restart') {
    const running = action === 'start';
    const settings = loadSettings();
    if (service === 'telegram-bot') settings.telegramEnabled = running;
    if (service === 'webapp-notes') settings.notesEnabled = running;
    if (service === 'voice') settings.voiceMode = running ? 'local' : 'off';
    settings.updatedAt = new Date().toISOString();
    atomicWrite(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
  }
  return { ok: true, service, action };
}

function redactLogLine(line) {
  return `${line}`
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED_TELEGRAM_TOKEN]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk|sk-or-v1|pcsk|pplx)-[A-Za-z0-9_-]{16,}\b/gi, '[REDACTED_API_KEY]')
    .replace(/\bAIza[A-Za-z0-9_-]{30,}\b/g, '[REDACTED_API_KEY]')
    .replace(/([?&](?:token|api_key|key)=)[^&\s]+/gi, '$1[REDACTED]');
}

function streamDockerLogs(req, res, service, tail) {
  if (activeLogStreams >= 3) return sendJson(res, 429, { error: 'too_many_log_streams' });
  const selectedServices = service === 'all' ? Object.values(LOG_SERVICES).flat() : LOG_SERVICES[service];
  if (!selectedServices) return sendJson(res, 400, { error: 'unknown_log_service' });
  activeLogStreams += 1;
  securityHeaders(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`event: ready\ndata: ${JSON.stringify({ service, tail })}\n\n`);

  const args = composeArgs(
    '--profile', 'telegram', '--profile', 'notes', '--profile', 'voice', '--profile', 'admin',
    'logs', '--follow', '--timestamps', '--tail', String(tail), '--no-color', ...selectedServices
  );
  const child = spawn(DOCKER_BIN, args, {
    cwd: PROJECT_DIR,
    env: { ...process.env, BACKEND_ENV_FILE, TELEGRAM_ENV_FILE, VOICE_ENV_FILE },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let buffer = '';
  let closed = false;
  const sendChunk = (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) if (line) res.write(`data: ${JSON.stringify({ line: redactLogLine(line) })}\n\n`);
  };
  child.stdout.on('data', sendChunk);
  child.stderr.on('data', sendChunk);
  child.on('error', (error) => {
    if (!closed) res.write(`event: stream-error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
  });
  child.on('close', (code) => {
    if (buffer && !closed) res.write(`data: ${JSON.stringify({ line: redactLogLine(buffer) })}\n\n`);
    if (!closed) {
      res.write(`event: ended\ndata: ${JSON.stringify({ code })}\n\n`);
      res.end();
    }
  });
  const heartbeat = setInterval(() => { if (!closed) res.write(': heartbeat\n\n'); }, 15000);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    activeLogStreams = Math.max(0, activeLogStreams - 1);
    if (!child.killed) child.kill('SIGTERM');
  };
  req.on('close', close);
  res.on('close', close);
}

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
}

function sendJson(res, status, data) {
  securityHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (Buffer.byteLength(body) > MAX_BODY_BYTES) { reject(new Error('Request body is too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function mergeCapability(target, name, descriptor) {
  target.supportedParameters.add(name);
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) return;
  const current = target.parameters[name] || {};
  const values = Array.isArray(descriptor.values)
    ? descriptor.values.filter((value) => ['string', 'number', 'boolean'].includes(typeof value))
    : [];
  target.parameters[name] = {
    type: typeof descriptor.type === 'string' ? descriptor.type : current.type,
    values: [...new Set([...(current.values || []), ...values])],
    ...(Number.isFinite(descriptor.min) ? { min: descriptor.min } : {}),
    ...(Number.isFinite(descriptor.max) ? { max: descriptor.max } : {})
  };
}

async function getOpenRouterImageCapabilities(input) {
  const model = `${input.model || ''}`.trim();
  const modelParts = model.split('/');
  if (modelParts.length < 2 || modelParts.some((part) => !/^[A-Za-z0-9._:@-]+$/.test(part))) {
    throw new Error('Use an OpenRouter model slug such as x-ai/grok-imagine-image-quality');
  }

  const savedApiKey = parseEnv(BACKEND_ENV_FILE).OPENROUTER_API_KEY || '';
  const apiKey = `${input.apiKey || ''}`.trim() || savedApiKey;
  if (!apiKey) throw new Error('OpenRouter API key is required to check the model');

  const modelPath = modelParts.map(encodeURIComponent).join('/');
  const response = await fetch(`${OPENROUTER_BASE_URL}/images/models/${modelPath}/endpoints`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`OpenRouter model check failed (HTTP ${response.status})`);

  const payload = await response.json();
  const endpoints = payload?.data?.endpoints || payload?.endpoints || (Array.isArray(payload?.data) ? payload.data : []);
  if (!Array.isArray(endpoints) || endpoints.length === 0) throw new Error('OpenRouter did not return image endpoints for this model');

  const merged = { supportedParameters: new Set(), parameters: {} };
  for (const endpoint of endpoints) {
    const supported = endpoint?.supported_parameters;
    if (Array.isArray(supported)) {
      for (const name of supported) if (typeof name === 'string') mergeCapability(merged, name, null);
    } else if (supported && typeof supported === 'object') {
      for (const [name, descriptor] of Object.entries(supported)) mergeCapability(merged, name, descriptor);
    }
  }

  return {
    model,
    endpointCount: endpoints.length,
    supportedParameters: [...merged.supportedParameters].sort(),
    parameters: merged.parameters
  };
}

function parseCookies(req) {
  const result = {};
  for (const part of `${req.headers.cookie || ''}`.split(';')) {
    const index = part.indexOf('=');
    if (index > 0) result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1));
  }
  return result;
}

function getSession(req) {
  const token = parseCookies(req).chatter_admin_session;
  const session = token ? sessions.get(token) : null;
  if (!session || session.expiresAt <= Date.now()) {
    if (token && sessions.delete(token)) persistSessions();
    return null;
  }
  const now = Date.now();
  session.expiresAt = now + SESSION_TTL_MS;
  if (!session.lastPersistedAt || now - session.lastPersistedAt > 5 * 60 * 1000) {
    session.lastPersistedAt = now;
    persistSessions();
  }
  return session;
}

function requireSession(req, res) {
  if (getSession(req)) return true;
  sendJson(res, 401, { error: 'unauthorized' });
  return false;
}

async function backendInternalRequest(pathname, options = {}) {
  const internalToken = parseEnv(BACKEND_ENV_FILE).BACKEND_INTERNAL_TOKEN || '';
  if (!internalToken) throw new Error('backend_internal_token_not_configured');

  const response = await fetch(new URL(pathname, BACKEND_INTERNAL_URL), {
    ...options,
    headers: {
      Authorization: `Bearer ${internalToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(options.timeoutMs || 5000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `backend_http_${response.status}`);
  return body;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    if (originUrl.host === req.headers.host) return true;

    const publicUrl = process.env.CHATTER_PUBLIC_URL;
    return Boolean(publicUrl && originUrl.origin === new URL(publicUrl).origin);
  } catch {
    return false;
  }
}

const clientIp = (req) => req.socket.remoteAddress || 'unknown';
function loginAllowed(ip) {
  const now = Date.now();
  const recent = (loginAttempts.get(ip) || []).filter((timestamp) => now - timestamp < 15 * 60 * 1000);
  loginAttempts.set(ip, recent);
  return recent.length < 5;
}
function recordFailedLogin(ip) { const attempts = loginAttempts.get(ip) || []; attempts.push(Date.now()); loginAttempts.set(ip, attempts); }

function proxyAdminPanel(req, res) {
  const headers = { ...req.headers, host: ADMIN_PANEL_URL.host };
  delete headers.connection;
  delete headers.cookie;
  delete headers.authorization;
  const proxy = http.request({
    protocol: ADMIN_PANEL_URL.protocol,
    hostname: ADMIN_PANEL_URL.hostname,
    port: ADMIN_PANEL_URL.port,
    method: req.method,
    path: req.url,
    headers
  }, (upstream) => {
    const responseHeaders = { ...upstream.headers };
    delete responseHeaders.connection;
    delete responseHeaders['set-cookie'];
    res.writeHead(upstream.statusCode || 502, responseHeaders);
    upstream.pipe(res);
  });
  proxy.on('error', (error) => {
    if (!res.headersSent) sendJson(res, 502, { error: 'admin_panel_unavailable', detail: error.message });
    else res.end();
  });
  req.pipe(proxy);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  if (req.method === 'GET' && pathname === '/health') return sendJson(res, 200, { status: 'ok' });
  if (!pathname.startsWith('/api/')) return proxyAdminPanel(req, res);
  if (pathname.startsWith('/api/') && req.method !== 'GET' && !sameOrigin(req)) return sendJson(res, 403, { error: 'origin_rejected' });

  if (req.method === 'POST' && pathname === '/api/login') {
    const ip = clientIp(req);
    if (!loginAllowed(ip)) return sendJson(res, 429, { error: 'too_many_attempts' });
    const body = await readJson(req);
    if (`${body.username || ''}` !== authConfig.username || !verifyPassword(`${body.password || ''}`, authConfig)) {
      recordFailedLogin(ip);
      return sendJson(res, 401, { error: 'invalid_credentials' });
    }
    loginAttempts.delete(ip);
    const token = randomSecret(32);
    sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS, lastPersistedAt: Date.now() });
    persistSessions();
    const secure = process.env.ADMIN_TLS === '1';
    res.setHeader('Set-Cookie', `chatter_admin_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`);
    return sendJson(res, 200, { ok: true, username: authConfig.username });
  }

  if (req.method === 'POST' && pathname === '/api/logout') {
    const token = parseCookies(req).chatter_admin_session;
    if (token && sessions.delete(token)) persistSessions();
    res.setHeader('Set-Cookie', 'chatter_admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'GET' && pathname === '/api/session') {
    const session = getSession(req);
    return sendJson(res, session ? 200 : 401, session ? { authenticated: true, username: authConfig.username } : { authenticated: false });
  }
  if (!pathname.startsWith('/api/') || !requireSession(req, res)) return;
  if (req.method === 'GET' && pathname === '/api/logs/stream') {
    const service = `${url.searchParams.get('service') || 'all'}`;
    const tail = Math.min(1000, Math.max(50, Number.parseInt(url.searchParams.get('tail') || '200', 10) || 200));
    return streamDockerLogs(req, res, service, tail);
  }
  if (req.method === 'GET' && pathname === '/api/settings') {
    const settings = publicSettings();
    try {
      const runtime = await backendInternalRequest('/internal/admin/image-generation/settings');
      settings.imageGeneration.enabled = runtime.enabled === true;
    } catch {
      // Keep the safe default while backend is temporarily unavailable.
    }
    return sendJson(res, 200, settings);
  }
  if (req.method === 'GET' && pathname === '/api/status') return sendJson(res, 200, { applying: Boolean(applyPromise), services: await getServiceStatus() });
  if (req.method === 'GET' && pathname === '/api/server-update') {
    if (url.searchParams.get('refresh') === '1' && serverUpdateInProgress()) return sendJson(res, 409, { error: 'server_update_is_in_progress' });
    try {
      return sendJson(res, 200, await getServerUpdateInfo({
        pull: url.searchParams.get('refresh') === '1',
        forcePull: url.searchParams.get('force') === '1',
      }));
    } catch (error) {
      return sendJson(res, 502, { error: error.message || 'server_update_check_failed' });
    }
  }
  if (req.method === 'POST' && pathname === '/api/server-update') {
    if (!serverUpdatesSupported()) return sendJson(res, 409, { error: 'server_updates_not_available_for_this_installation' });
    if (serverUpdateInProgress() || applyPromise || backupPromise || restorePromise) return sendJson(res, 409, { error: 'another_operation_is_in_progress' });
    let snapshot;
    try {
      snapshot = await getServerUpdateInfo();
    } catch (error) {
      return sendJson(res, 502, { error: error.message || 'server_update_check_failed' });
    }
    if (!snapshot.available) return sendJson(res, 409, { error: 'server_is_already_current' });
    writeUpdateState({ status: 'queued', targetHash: snapshot.latestHash, message: 'server_update_queued' });
    updatePromise = performServerUpdate(snapshot)
      .catch(error => console.error('[manager:server-update]', error))
      .finally(() => { updatePromise = null; });
    return sendJson(res, 202, { ok: true, targetHash: snapshot.latestHash });
  }

  // Switch the update channel (image tag): `latest` for production, a branch
  // tag (e.g. `feature-x`) to track a working branch. Persists the tag into
  // the host compose.env (used by the update helper and container recreation)
  // and into compose.runtime.env (used by this manager's own compose calls),
  // so the change takes effect without restarting the manager.
  if (req.method === 'POST' && pathname === '/api/server-update/tag') {
    if (!serverUpdatesSupported()) return sendJson(res, 409, { error: 'server_updates_not_available_for_this_installation' });
    if (serverUpdateInProgress() || applyPromise || backupPromise || restorePromise) return sendJson(res, 409, { error: 'another_operation_is_in_progress' });
    let tag;
    try {
      tag = `${(await readJson(req)).tag || ''}`.trim();
    } catch {
      return sendJson(res, 400, { error: 'invalid_json' });
    }
    if (!IMAGE_TAG_PATTERN.test(tag)) return sendJson(res, 400, { error: 'invalid_image_tag' });
    if (tag === 'local') return sendJson(res, 400, { error: 'invalid_image_tag' });
    try {
      updateEnvFileValue(COMPOSE_ENV_FILE, 'CHATTER_IMAGE_TAG', tag);
      updateEnvFileValue(COMPOSE_RUNTIME_ENV_FILE, 'CHATTER_IMAGE_TAG', tag);
    } catch (error) {
      return sendJson(res, 500, { error: error.message || 'failed_to_persist_image_tag' });
    }
    lastPullTime = 0; // the next refresh should pull the new channel right away
    console.log(`[manager:server-update] image tag switched to '${tag}'`);
    return sendJson(res, 200, { ok: true, imageTag: tag });
  }

  // Keep the old update-specific path as an alias for existing admin panels.
  if (pathname === '/api/restart/prepare' || pathname === '/api/update/prepare') {
    if (req.method === 'GET') {
      try {
        return sendJson(res, 200, await backendInternalRequest('/internal/admin/update/prepare'));
      } catch (error) {
        return sendJson(res, 502, { error: error.message || 'backend_drain_state_failed' });
      }
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      try {
        return sendJson(res, 200, await backendInternalRequest('/internal/admin/update/prepare', {
          method: 'POST',
          body: JSON.stringify({ action: `${body.action || ''}`.trim().toLowerCase() }),
        }));
      } catch (error) {
        const status = error.message === 'bad_action' ? 400 : 502;
        return sendJson(res, status, { error: error.message || 'backend_drain_action_failed' });
      }
    }
  }
  const serviceActionMatch = pathname.match(/^\/api\/services\/([^/]+)\/(start|stop|restart)$/);
  if (req.method === 'POST' && serviceActionMatch) {
    if (serverUpdateInProgress()) return sendJson(res, 409, { error: 'server_update_is_in_progress' });
    try {
      return sendJson(res, 200, await controlService(serviceActionMatch[1], serviceActionMatch[2]));
    } catch (error) {
      const status = ['unknown_service', 'unknown_service_action'].includes(error.message) ? 400 : 500;
      return sendJson(res, status, { error: error.message || 'service_action_failed' });
    }
  }
  if (req.method === 'GET' && pathname === '/api/users') {
    return sendJson(res, 200, await backendInternalRequest('/internal/admin/users-overview'));
  }
  if (req.method === 'GET' && pathname === '/api/server-access-keys') {
    return sendJson(res, 200, await backendInternalRequest('/internal/admin/server-access-keys'));
  }
  if (req.method === 'POST' && pathname === '/api/server-access-keys') {
    const body = await readJson(req);
    return sendJson(res, 201, await backendInternalRequest('/internal/admin/server-access-keys', {
      method: 'POST',
      body: JSON.stringify({ name: `${body.name || ''}`.trim() }),
    }));
  }
  const serverAccessKeyMatch = pathname.match(/^\/api\/server-access-keys\/(\d+)$/);
  if (req.method === 'DELETE' && serverAccessKeyMatch) {
    return sendJson(res, 200, await backendInternalRequest(`/internal/admin/server-access-keys/${serverAccessKeyMatch[1]}`, {
      method: 'DELETE',
    }));
  }

  // ── API keys ────────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/api-keys') {
    return sendJson(res, 200, await backendInternalRequest('/internal/admin/api-keys'));
  }
  if (req.method === 'POST' && pathname === '/api/api-keys') {
    const body = await readJson(req);
    const name = `${body.name || ''}`.trim();
    const key = `${body.key || ''}`.trim();
    if (!name || !key) return sendJson(res, 400, { error: 'name_and_key_required' });
    return sendJson(res, 201, await backendInternalRequest('/internal/admin/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name, key }),
    }));
  }
  if (req.method === 'GET' && pathname.startsWith('/api/api-keys/')) {
    const rest = decodeURIComponent(pathname.slice('/api/api-keys/'.length));
    if (rest.endsWith('/used-by')) {
      const keyId = rest.replace('/used-by', '');
      if (keyId && !keyId.includes('/')) {
        try {
          return sendJson(res, 200, await backendInternalRequest(`/internal/admin/api-keys/${encodeURIComponent(keyId)}/used-by`));
        } catch { return sendJson(res, 404, { error: 'api_key_not_found' }); }
      }
    } else if (rest && !rest.includes('/')) {
      try {
        return sendJson(res, 200, await backendInternalRequest(`/internal/admin/api-keys/${encodeURIComponent(rest)}`));
      } catch { return sendJson(res, 404, { error: 'api_key_not_found' }); }
    }
  }
  if (req.method === 'DELETE' && pathname.startsWith('/api/api-keys/')) {
    const keyId = decodeURIComponent(pathname.slice('/api/api-keys/'.length));
    if (keyId && !keyId.includes('/')) {
      const body = await readJson(req);
      return sendJson(res, 200, await backendInternalRequest(`/internal/admin/api-keys/${encodeURIComponent(keyId)}`, {
        method: 'DELETE',
        body: JSON.stringify(body || {}),
      }));
    }
  }

  // ── Plan limits (token quotas per plan) ────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/plan-limits') {
    return sendJson(res, 200, await backendInternalRequest('/internal/admin/plan-limits'));
  }
  if (req.method === 'PUT' && pathname === '/api/plan-limits') {
    const body = await readJson(req);
    return sendJson(res, 200, await backendInternalRequest('/internal/admin/plan-limits', {
      method: 'PUT',
      body: JSON.stringify(body),
    }));
  }
  if (req.method === 'POST' && pathname === '/api/sync-plan-limits') {
    return sendJson(res, 200, await backendInternalRequest('/internal/admin/sync-plan-limits', {
      method: 'POST',
      body: '{}',
    }));
  }

  // ── Weekly cost quota: per-user overrides & resets ────────────────────
  const weeklyCostQuotaMatch = pathname.match(/^\/api\/users\/(\d+)\/weekly-cost-quota$/);
  if (weeklyCostQuotaMatch && req.method === 'PUT') {
    const body = await readJson(req);
    return sendJson(res, 200, await backendInternalRequest(`/internal/admin/users/${weeklyCostQuotaMatch[1]}/weekly-cost-quota`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }));
  }
  const resetUserUsageMatch = pathname.match(/^\/api\/users\/(\d+)\/reset-weekly-usage$/);
  if (resetUserUsageMatch && req.method === 'POST') {
    return sendJson(res, 200, await backendInternalRequest(`/internal/admin/users/${resetUserUsageMatch[1]}/reset-weekly-usage`, {
      method: 'POST',
      body: '{}',
    }));
  }
  if (req.method === 'POST' && pathname === '/api/users/reset-weekly-usage-all') {
    return sendJson(res, 200, await backendInternalRequest('/internal/admin/users/reset-weekly-usage-all', {
      method: 'POST',
      body: '{}',
    }));
  }

  // ── Admin: generate new password for user ───────────────────────────────
  const generatePasswordMatch = pathname.match(/^\/api\/users\/([^/]+)\/generate-password$/);
  if (req.method === 'POST' && generatePasswordMatch) {
    const userId = generatePasswordMatch[1];
    return sendJson(res, 200, await backendInternalRequest(`/internal/admin/users/${userId}/generate-password`, {
      method: 'POST',
      body: '{}',
    }));
  }

  // ── Model coefficients (token quota multipliers) ───────────────────────
  if (req.method === 'GET' && pathname === '/api/model-coefficients') {
    return sendJson(res, 200, await backendInternalRequest('/internal/admin/model-coefficients'));
  }
  const modelCoefficientMatch = pathname.match(/^\/api\/model-coefficients\/(.+)$/);
  if (modelCoefficientMatch) {
    const modelId = decodeURIComponent(modelCoefficientMatch[1]);
    const safePath = `/internal/admin/model-coefficients/${encodeURIComponent(modelId)}`;
    if (req.method === 'PUT') {
      const body = await readJson(req);
      return sendJson(res, 200, await backendInternalRequest(safePath, {
        method: 'PUT',
        body: JSON.stringify(body),
      }));
    }
    if (req.method === 'DELETE') {
      return sendJson(res, 200, await backendInternalRequest(safePath, { method: 'DELETE' }));
    }
  }

  // ── Prompts (global presets, admin-panel) ─────────────────────────────

  if (req.method === 'GET' && pathname === '/api/prompts') {
    return sendJson(res, 200, await backendInternalRequest('/internal/admin/prompts'));
  }
  if (req.method === 'POST' && pathname === '/api/prompts') {
    const body = await readJson(req);
    return sendJson(res, 201, await backendInternalRequest('/internal/admin/prompts', {
      method: 'POST',
      body: JSON.stringify(body),
    }));
  }
  const promptIdMatch = pathname.match(/^\/api\/prompts\/(\d+)$/);

  if (promptIdMatch) {
    const pid = promptIdMatch[1];
    if (req.method === 'GET') {
      return sendJson(res, 200, await backendInternalRequest(`/internal/admin/prompts/${pid}`));
    }
    if (req.method === 'DELETE') {
      return sendJson(res, 200, await backendInternalRequest(`/internal/admin/prompts/${pid}`, { method: 'DELETE' }));
    }
  }
  const promptFieldMatch = pathname.match(/^\/api\/prompts\/(\d+)\/(name|description|content|default)$/);

  if (req.method === 'PUT' && promptFieldMatch) {
    const pid = promptFieldMatch[1];
    const field = promptFieldMatch[2];
    const body = await readJson(req);
    const endpoint = field === 'default' ? `/internal/admin/prompts/${pid}/default` : `/internal/admin/prompts/${pid}/${field}`;
    return sendJson(res, 200, await backendInternalRequest(endpoint, {
      method: 'PUT',
      body: JSON.stringify(body),
    }));
  }




  const userDetailMatch = pathname.match(/^\/api\/users\/(\d+)$/);

  if (req.method === 'GET' && userDetailMatch) {
    return sendJson(res, 200, await backendInternalRequest(`/internal/admin/users-overview/${userDetailMatch[1]}`));
  }
  if (req.method === 'DELETE' && userDetailMatch) {
    return sendJson(res, 200, await backendInternalRequest(`/internal/users/${userDetailMatch[1]}`, {
      method: 'DELETE',
    }));
  }
  const userUsageMatch = pathname.match(/^\/api\/users\/(\d+)\/usage$/);
  if (req.method === 'GET' && userUsageMatch) {
    return sendJson(res, 200, await backendInternalRequest(`/internal/admin/users/${userUsageMatch[1]}/usage`));
  }
  const userRoleMatch = pathname.match(/^\/api\/users\/(\d+)\/role$/);
  if (req.method === 'PUT' && userRoleMatch) {
    const body = await readJson(req);
    if (!['user', 'admin'].includes(body.role)) return sendJson(res, 400, { error: 'invalid_role' });
    return sendJson(res, 200, await backendInternalRequest(`/internal/users/${userRoleMatch[1]}/role`, {
      method: 'PUT',
      body: JSON.stringify({ role: body.role }),
    }));
  }
  const userStatusMatch = pathname.match(/^\/api\/users\/(\d+)\/status$/);
  if (req.method === 'PUT' && userStatusMatch) {
    const body = await readJson(req);
    if (!['none', 'approved', 'disapproved'].includes(body.status)) return sendJson(res, 400, { error: 'invalid_status' });
    return sendJson(res, 200, await backendInternalRequest(`/internal/users/${userStatusMatch[1]}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status: body.status }),
    }));
  }
  const userPlanMatch = pathname.match(/^\/api\/users\/(\d+)\/plan$/);
  if (req.method === 'PUT' && userPlanMatch) {
    const body = await readJson(req);
    if (!['free', 'standart', 'pro'].includes(body.plan)) return sendJson(res, 400, { error: 'invalid_plan' });
    const duration = `${body.duration || 'forever'}`;
    if (!['day', 'week', 'month', 'year', 'forever'].includes(duration)) return sendJson(res, 400, { error: 'invalid_duration' });
    const endDate = new Date();
    let endsAt = null;
    if (duration === 'day') endDate.setUTCDate(endDate.getUTCDate() + 1);
    if (duration === 'week') endDate.setUTCDate(endDate.getUTCDate() + 7);
    if (duration === 'month') endDate.setUTCMonth(endDate.getUTCMonth() + 1);
    if (duration === 'year') endDate.setUTCFullYear(endDate.getUTCFullYear() + 1);
    if (duration !== 'forever') endsAt = endDate.toISOString();
    return sendJson(res, 200, await backendInternalRequest(`/internal/users/${userPlanMatch[1]}/plan`, {
      method: 'POST',
      body: JSON.stringify({ plan: body.plan, ends_at: endsAt, record_subscription: true }),
    }));
  }
  const userBanMatch = pathname.match(/^\/api\/users\/(\d+)\/ban$/);
  if (req.method === 'POST' && userBanMatch) {
    const body = await readJson(req);
    return sendJson(res, 200, await backendInternalRequest(`/internal/users/${userBanMatch[1]}/ban`, {
      method: 'POST',
      body: JSON.stringify({ reason: `${body.reason || ''}`.trim() }),
    }));
  }
  if (req.method === 'DELETE' && userBanMatch) {
    return sendJson(res, 200, await backendInternalRequest(`/internal/users/${userBanMatch[1]}/ban`, { method: 'DELETE' }));
  }
  if (req.method === 'GET' && pathname === '/api/system') return sendJson(res, 200, await getSystemInfo());
  if (req.method === 'GET' && pathname === '/api/system/metrics') {
    const range = url.searchParams.get('range') || '24h';
    const rangeMs = range === '7d' ? 7 * 86400000 : range === '3d' ? 3 * 86400000 : 86400000;
    const cutoff = Date.now() - rangeMs;
    const filtered = metricsHistory.filter((p) => p.ts >= cutoff);
    const points = downsample(filtered, 1440).map((p) => ({
      ts: p.ts,
      cpu: p.cpu,
      mem: p.memTotal > 0 ? Math.round((p.memUsed / p.memTotal) * 1000) / 10 : 0,
      swap: p.swapTotal > 0 ? Math.round((p.swapUsed / p.swapTotal) * 1000) / 10 : 0,
      disk: p.diskTotal > 0 ? Math.round((p.diskUsed / p.diskTotal) * 1000) / 10 : 0,
    }));
    return sendJson(res, 200, { range, points });
  }

  if (req.method === 'GET' && pathname === '/api/backups') return sendJson(res, 200, { creating: Boolean(backupPromise), restoring: Boolean(restorePromise), backups: listBackups() });
  if (req.method === 'GET' && pathname === '/api/backups/schedule') return sendJson(res, 200, getBackupSchedule());

  const backupDetailsMatch = pathname.match(/^\/api\/backups\/([^/]+)\/details$/);
  if (req.method === 'GET' && backupDetailsMatch) {
    const name = safeBackupName(decodeURIComponent(backupDetailsMatch[1]));
    const filePath = name ? path.join(BACKUPS_DIR, name) : '';
    if (!filePath || !fs.existsSync(filePath)) return sendJson(res, 404, { error: 'backup_not_found' });
    const manifest = await readBackupManifest(filePath);
    return sendJson(res, 200, {
      name,
      includesUploads: Boolean(manifest?.includesUploads),
      includesConfiguration: Boolean(manifest?.includesConfiguration),
      version: `${manifest?.version || 'unknown'}`,
      source: manifest?.source === 'automatic' ? 'automatic' : 'manual',
    });
  }

  if (req.method === 'PUT' && pathname === '/api/backups/schedule') {
    const schedule = saveBackupSchedule(await readJson(req));
    void runScheduledBackupIfDue();
    return sendJson(res, 200, schedule);
  }

  const backupDownloadMatch = pathname.match(/^\/api\/backups\/([^/]+)\/download$/);
  if (req.method === 'GET' && backupDownloadMatch) {
    const name = safeBackupName(decodeURIComponent(backupDownloadMatch[1]));
    const filePath = name ? path.join(BACKUPS_DIR, name) : '';
    if (!filePath || !fs.existsSync(filePath)) return sendJson(res, 404, { error: 'backup_not_found' });
    const stat = fs.statSync(filePath);
    securityHeaders(res);
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${name}"`
    });
    return fs.createReadStream(filePath).pipe(res);
  }

  if (req.method === 'POST' && pathname === '/api/backups/import') {
    if (backupPromise || restorePromise || serverUpdateInProgress()) return sendJson(res, 409, { error: 'backup_operation_in_progress' });
    const originalName = path.basename(`${url.searchParams.get('filename') || ''}`);
    if (!originalName) return sendJson(res, 400, { error: 'backup_filename_required' });
    const uploadPath = path.join(BACKUPS_DIR, `.upload-${crypto.randomUUID()}`);
    try {
      await receiveUpload(req, uploadPath);
      return sendJson(res, 201, { ok: true, backup: await importBackup(uploadPath, originalName) });
    } catch (error) {
      fs.rmSync(uploadPath, { force: true });
      return sendJson(res, 400, { error: error.message || 'backup_import_failed' });
    }
  }

  const backupRestoreMatch = pathname.match(/^\/api\/backups\/([^/]+)\/restore$/);
  if (req.method === 'POST' && backupRestoreMatch) {
    if (backupPromise || restorePromise || serverUpdateInProgress()) return sendJson(res, 409, { error: 'backup_operation_in_progress' });
    const name = safeBackupName(decodeURIComponent(backupRestoreMatch[1]));
    if (!name) return sendJson(res, 400, { error: 'invalid_backup_name' });
    restorePromise = restoreBackup(name).finally(() => { restorePromise = null; });
    return sendJson(res, 200, await restorePromise);
  }

  const backupDeleteMatch = pathname.match(/^\/api\/backups\/([^/]+)$/);
  if (req.method === 'DELETE' && backupDeleteMatch) {
    if (backupPromise || restorePromise || serverUpdateInProgress()) return sendJson(res, 409, { error: 'backup_operation_in_progress' });
    const name = safeBackupName(decodeURIComponent(backupDeleteMatch[1]));
    const filePath = name ? path.join(BACKUPS_DIR, name) : '';
    if (!filePath || !fs.existsSync(filePath)) return sendJson(res, 404, { error: 'backup_not_found' });
    fs.rmSync(filePath);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/backups') {
    if (backupPromise || restorePromise || serverUpdateInProgress()) return sendJson(res, 409, { error: 'backup_operation_in_progress' });
    const body = await readJson(req);
    backupPromise = createBackup({
      includeUploads: body.includeUploads === true,
      includeConfiguration: body.includeConfiguration === true,
      source: 'manual'
    })
      .finally(() => { backupPromise = null; });
    return sendJson(res, 201, { ok: true, backup: await backupPromise });
  }

  // ── OpenRouter providers proxy ─────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/openrouter/providers') {
    try {
      const data = await openRouterFetch('/providers');
      return sendJson(res, 200, data);
    } catch (error) {
      return sendJson(res, 502, { error: error.message || 'openrouter_providers_failed' });
    }
  }

  // ── OpenRouter model search proxy ─────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/openrouter/models') {
    const query = `${url.searchParams.get('q') || ''}`.trim();
    if (!query || query.length < 2) return sendJson(res, 400, { error: 'query_too_short' });
    try {
      const data = await openRouterFetch(`/models?q=${encodeURIComponent(query)}`);
      return sendJson(res, 200, data);
    } catch (error) {
      return sendJson(res, 502, { error: error.message || 'openrouter_models_search_failed' });
    }
  }

  // ── OpenRouter model provider endpoints ───────────────────────────────────
  const orEndpointsMatch = pathname.match(/^\/api\/openrouter\/models\/([^/]+)\/([^/]+)\/endpoints$/);
  if (req.method === 'GET' && orEndpointsMatch) {
    const author = encodeURIComponent(orEndpointsMatch[1]);
    const slug = encodeURIComponent(orEndpointsMatch[2]);
    if (!author || !slug) return sendJson(res, 400, { error: 'invalid_model_slug' });
    try {
      const data = await openRouterFetch(`/models/${author}/${slug}/endpoints`);
      return sendJson(res, 200, data);
    } catch (error) {
      return sendJson(res, 502, { error: error.message || 'openrouter_endpoints_failed' });
    }
  }

  // ── OpenRouter provider monitor (proxied to backend internal API) ────────
  if (pathname === '/api/image-generation/settings') {
    if (req.method === 'GET') {
      try {
        return sendJson(res, 200, await backendInternalRequest('/internal/admin/image-generation/settings'));
      } catch (error) {
        return sendJson(res, 502, { error: error.message || 'image_generation_settings_failed' });
      }
    }
    if (req.method === 'PUT') {
      const body = await readJson(req);
      try {
        return sendJson(res, 200, await backendInternalRequest('/internal/admin/image-generation/settings', {
          method: 'PUT',
          body: JSON.stringify({ enabled: body.enabled }),
        }));
      } catch (error) {
        return sendJson(res, 400, { error: error.message || 'image_generation_settings_save_failed' });
      }
    }
  }

  if (pathname === '/api/openrouter-monitor/settings') {
    if (req.method === 'GET') {
      try {
        return sendJson(res, 200, await backendInternalRequest('/internal/admin/openrouter-monitor/settings'));
      } catch (error) {
        return sendJson(res, 502, { error: error.message || 'monitor_settings_failed' });
      }
    }
    if (req.method === 'PUT') {
      const body = await readJson(req);
      try {
        return sendJson(res, 200, await backendInternalRequest('/internal/admin/openrouter-monitor/settings', {
          method: 'PUT',
          body: JSON.stringify(body),
        }));
      } catch (error) {
        return sendJson(res, 400, { error: error.message || 'monitor_settings_save_failed' });
      }
    }
  }

  if (req.method === 'GET' && pathname === '/api/openrouter-monitor/status') {
    try {
      return sendJson(res, 200, await backendInternalRequest('/internal/admin/openrouter-monitor/status', { timeoutMs: 15000 }));
    } catch (error) {
      return sendJson(res, 502, { error: error.message || 'monitor_status_failed' });
    }
  }

  if (req.method === 'POST' && pathname === '/api/openrouter-monitor/check') {
    const body = await readJson(req);
    try {
      // A full cycle fetches every unique model slug with a 12s timeout each —
      // allow plenty of time before the manager gives up.
      return sendJson(res, 200, await backendInternalRequest('/internal/admin/openrouter-monitor/check', {
        method: 'POST',
        body: JSON.stringify(body || {}),
        timeoutMs: 300000,
      }));
    } catch (error) {
      return sendJson(res, 502, { error: error.message || 'monitor_check_failed' });
    }
  }

  if (req.method === 'POST' && pathname === '/api/openrouter-monitor/test-notification') {
    const body = await readJson(req);
    try {
      return sendJson(res, 200, await backendInternalRequest('/internal/admin/openrouter-monitor/test-notification', {
        method: 'POST',
        body: JSON.stringify(body || {}),
        timeoutMs: 30000,
      }));
    } catch (error) {
      return sendJson(res, 502, { error: error.message || 'monitor_test_notification_failed' });
    }
  }

  // ── OpenRouter model billing info proxy (admin panel billing setup) ──────
  const orBillingMatch = pathname.match(/^\/api\/models\/([^/]+)\/billing$/);
  if (orBillingMatch) {
    const modelId = decodeURIComponent(orBillingMatch[1]);
    const safePath = `/internal/admin/models/${encodeURIComponent(modelId)}/billing`;
    if (req.method === 'GET') {
      try {
        return sendJson(res, 200, await backendInternalRequest(safePath));
      } catch { return sendJson(res, 404, { error: 'model_override_not_found' }); }
    }
    if (req.method === 'PUT') {
      const body = await readJson(req);
      return sendJson(res, 200, await backendInternalRequest(safePath, {
        method: 'PUT',
        body: JSON.stringify(body),
      }));
    }
  }

  if (req.method === 'POST' && pathname === '/api/image-model/check') {
    try {
      return sendJson(res, 200, await getOpenRouterImageCapabilities(await readJson(req)));
    } catch (error) {
      return sendJson(res, 400, { error: error.message || 'openrouter_model_check_failed' });
    }
  }

  if (req.method === 'PUT' && pathname === '/api/settings') {
    if (applyPromise || serverUpdateInProgress()) return sendJson(res, 409, { error: 'configuration_is_being_applied' });
    try {
      saveSettings(await readJson(req));
    } catch (error) {
      return sendJson(res, 400, { error: error.message || 'invalid_settings' });
    }
    applyPromise = applyConfiguration().finally(() => { applyPromise = null; });
    await applyPromise;
    return sendJson(res, 200, { ok: true, settings: publicSettings() });
  }

  if (req.method === 'PUT' && pathname === '/api/account') {
    const body = await readJson(req);
    const username = `${body.username || ''}`.trim();
    const currentPassword = `${body.currentPassword || ''}`;
    const newPassword = `${body.newPassword || ''}`;
    if (!verifyPassword(currentPassword, authConfig)) return sendJson(res, 403, { error: 'current_password_invalid' });
    if (!username || newPassword.length < 12) return sendJson(res, 400, { error: 'username_and_12_character_password_required' });
    authConfig = { username, ...hashPassword(newPassword), updatedAt: new Date().toISOString() };
    atomicWrite(AUTH_FILE, `${JSON.stringify(authConfig, null, 2)}\n`);
    sessions.clear();
    persistSessions();
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: 'not_found' });
}

const requestHandler = (req, res) => Promise.resolve(handleRequest(req, res)).catch((error) => {
  console.error('[manager]', error);
  if (!res.headersSent) sendJson(res, 500, { error: error.message || 'internal_error' });
  else res.end();
});

let server;
if (process.env.ADMIN_TLS === '1') {
  const certPath = process.env.ADMIN_TLS_CERT || path.join(CONFIG_DIR, 'tls.crt');
  const keyPath = process.env.ADMIN_TLS_KEY || path.join(CONFIG_DIR, 'tls.key');
  server = https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, requestHandler);
} else server = http.createServer(requestHandler);

// Backup archives can take longer than Node's five-minute default to upload
// over a slow connection. Size is still bounded by MAX_BACKUP_UPLOAD_BYTES.
server.requestTimeout = 60 * 60 * 1000;

server.listen(PORT, '0.0.0.0', () => console.log(`Chatter Manager is listening on ${process.env.ADMIN_TLS === '1' ? 'https' : 'http'}://0.0.0.0:${PORT}`));
scheduleComposeBootstrap();

setTimeout(() => { void runScheduledBackupIfDue(); }, 10000).unref();
setInterval(() => { void runScheduledBackupIfDue(); }, 5 * 60 * 1000).unref();
void collectMetricsSnapshot();
setInterval(() => { void collectMetricsSnapshot(); }, METRICS_INTERVAL_MS).unref();
