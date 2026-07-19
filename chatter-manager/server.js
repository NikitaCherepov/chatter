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
const BOOTSTRAP_PASSWORD_FILE = path.resolve(process.env.ADMIN_BOOTSTRAP_PASSWORD_FILE || path.join(CONFIG_DIR, 'admin.bootstrap'));
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const BACKEND_ENV_FILE = path.join(CONFIG_DIR, 'backend.env');
const TELEGRAM_ENV_FILE = path.join(CONFIG_DIR, 'telegram.env');
const VOICE_ENV_FILE = path.join(CONFIG_DIR, 'voice.env');
const COMPOSE_RUNTIME_ENV_FILE = path.join(CONFIG_DIR, 'compose.runtime.env');
const BACKUP_SCHEDULE_FILE = path.join(CONFIG_DIR, 'backup-schedule.json');
const ADMIN_PANEL_URL = new URL(process.env.ADMIN_PANEL_URL || 'http://admin-panel:3000');
const BACKEND_INTERNAL_URL = new URL(process.env.BACKEND_INTERNAL_URL || 'http://backend:3050');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_BACKUP_UPLOAD_BYTES = Number.parseInt(process.env.MAX_BACKUP_UPLOAD_BYTES || `${20 * 1024 * 1024 * 1024}`, 10);
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DATA_DIR = path.resolve(process.env.CHATTER_DATA_DIR || '/data');
const DATABASE_FILE = path.join(DATA_DIR, 'chatter.db');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const BACKUPS_DIR = path.resolve(process.env.CHATTER_BACKUPS_DIR || '/backups');

fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(BACKUPS_DIR, { recursive: true, mode: 0o700 });

const sessions = new Map();
const loginAttempts = new Map();
let applyPromise = null;
let backupPromise = null;
let restorePromise = null;
let activeLogStreams = 0;

const randomSecret = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

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
  CHATTER_IMAGE_PREFIX: process.env.CHATTER_IMAGE_PREFIX || 'chatter',
  CHATTER_IMAGE_TAG: process.env.CHATTER_IMAGE_TAG || 'local',
  CHATTER_PULL_IMAGES: process.env.CHATTER_PULL_IMAGES || '0',
  CHATTER_PUBLIC_HOST: process.env.CHATTER_PUBLIC_HOST || '',
  CHATTER_PUBLIC_URL: process.env.CHATTER_PUBLIC_URL || ''
});

const defaultSettings = () => ({
  telegramEnabled: false,
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

function parseProviderModels(raw, prefix, fallbackBase, fallbackKey, fallbackModels) {
  const chunks = `${raw || ''}`.trim()
    ? `${raw}`.split(';').map(value => value.trim()).filter(Boolean)
    : fallbackBase && fallbackModels.length
      ? [`${fallbackBase}|${fallbackKey}|${fallbackModels.join(',')}`]
      : [];
  const result = [];
  chunks.forEach((chunk, providerIndex) => {
    const [baseUrl = '', apiKey = '', modelsRaw = ''] = chunk.split('|').map(value => value.trim());
    splitModelChain(modelsRaw).forEach((model, modelIndex) => {
      if (!baseUrl || !model) return;
      result.push({ id: `${prefix}-${providerIndex}-${modelIndex}`, baseUrl, apiKey, model });
    });
  });
  return result;
}

function getProviderModels(backendEnv) {
  const proModels = parseProviderModels(
    backendEnv.TIMEWEB_PRO_ENDPOINTS,
    'pro',
    backendEnv.TIMEWEB_BASE_URL,
    backendEnv.TIMEWEB_API_KEY,
    splitModelChain(backendEnv.TIMEWEB_MODEL, ['gemini-3.1-flash-lite-preview'])
  );
  const liteModels = parseProviderModels(
    backendEnv.TIMEWEB_LITE_ENDPOINTS,
    'lite',
    backendEnv.TIMEWEB_LITE_BASE_URL || backendEnv.TIMEWEB_BASE_URL,
    backendEnv.TIMEWEB_LITE_API_KEY || backendEnv.TIMEWEB_API_KEY,
    splitModelChain(backendEnv.TIMEWEB_LITE_MODEL, ['gemini-2.5-flash-lite'])
  );
  const hasExplicitVision = Boolean(
    backendEnv.TIMEWEB_VISION_BASE_URL
    || backendEnv.TIMEWEB_VISION_API_KEY
    || backendEnv.TIMEWEB_VISION_MODEL
  );
  const visionModel = hasExplicitVision
    ? {
        id: 'vision',
        baseUrl: backendEnv.TIMEWEB_VISION_BASE_URL || proModels[0]?.baseUrl || backendEnv.TIMEWEB_BASE_URL || '',
        apiKey: backendEnv.TIMEWEB_VISION_API_KEY || proModels[0]?.apiKey || backendEnv.TIMEWEB_API_KEY || '',
        model: splitModelChain(
          backendEnv.TIMEWEB_VISION_MODEL,
          proModels[0]?.model ? [proModels[0].model] : []
        )[0] || ''
      }
    : { id: 'vision', baseUrl: '', apiKey: '', model: '' };
  return { proModels, liteModels, visionModel };
}

function parseManualModels(raw) {
  return `${raw || ''}`.split(';').map(value => value.trim()).filter(Boolean).map((chunk, index) => {
    const [baseUrl = '', apiKey = '', model = '', name = '', description = '', uniqueId = '', supportsVision = '0', adminOnly = '0'] = chunk.split('|').map(value => value.trim());
    return {
      id: uniqueId || `manual-${index}`,
      baseUrl,
      apiKey,
      model,
      name: name || model,
      description,
      uniqueId: uniqueId || `manual-${index}`,
      supportsVision: ['1', 'true'].includes(supportsVision.toLowerCase()),
      adminOnly: ['1', 'true'].includes(adminOnly.toLowerCase())
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

function mergeSecret(value, existing, fieldName) {
  const secret = `${value || ''}`.trim() || `${existing || ''}`;
  if (/[\r\n\0]/.test(secret)) throw new Error(`${fieldName} contains invalid characters`);
  return secret;
}

function mergeProviderModels(input, existing, label, { required = false } = {}) {
  if (!Array.isArray(input)) return existing;
  if (required && input.length === 0) throw new Error(`${label} requires at least one model`);
  const existingKeys = new Map(existing.map(item => [item.id, item.apiKey]));
  return input.map((item, index) => {
    const id = `${item?.id || `${label}-${index}`}`;
    const baseUrl = normalizeUrl(item?.baseUrl, `${label} provider URL`, { allowEmpty: false });
    const model = validateEnvPart(item?.model, `${label} model`);
    const apiKey = `${item?.apiKey || ''}`.trim() || existingKeys.get(id) || '';
    if (!apiKey || /[|;\r\n\0]/.test(apiKey)) throw new Error(`${label} API key is required`);
    return { id, baseUrl, apiKey, model };
  });
}

function mergeProviderModel(input, existing, label, { required = true } = {}) {
  if (!input || typeof input !== 'object') return existing;
  const baseUrlInput = `${input.baseUrl || ''}`.trim();
  const modelInput = `${input.model || ''}`.trim();
  if (!required && !baseUrlInput && !modelInput && !input.apiKey) return null;
  const apiKey = `${input.apiKey || ''}`.trim() || existing.apiKey || '';
  if (!apiKey || /[|;\r\n\0]/.test(apiKey)) throw new Error(`${label} API key is required`);
  return {
    id: existing.id,
    baseUrl: normalizeUrl(input.baseUrl, `${label} provider URL`, { allowEmpty: false }),
    apiKey,
    model: validateEnvPart(input.model, `${label} model`)
  };
}

function mergeManualModels(input, existing) {
  if (!Array.isArray(input)) return existing;
  const existingKeys = new Map(existing.map(item => [item.id, item.apiKey]));
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
      adminOnly: Boolean(item?.adminOnly)
    };
  });
}

const serializeProviderModels = models => models.map(model => `${model.baseUrl}|${model.apiKey}|${model.model}`).join(';');
const serializeManualModels = models => models.map(model => [model.baseUrl, model.apiKey, model.model, model.name, model.description.replace(/[|;\r\n]/g, ' '), model.uniqueId, model.supportsVision ? '1' : '0', model.adminOnly ? '1' : '0'].join('|')).join(';');

function saveSettings(input) {
  const previous = loadSettings();
  const backendEnv = parseEnv(BACKEND_ENV_FILE);
  const telegramEnv = parseEnv(TELEGRAM_ENV_FILE);
  const voiceEnv = parseEnv(VOICE_ENV_FILE);
  const existingProviderModels = getProviderModels(backendEnv);
  const existingManualModels = parseManualModels(backendEnv.MODELS_MANUAL);
  const telegramEnabled = Boolean(input.telegramEnabled);
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
    backendEnv.TIMEWEB_LITE_ENDPOINTS = serializeProviderModels(liteModels);
  } else {
    delete backendEnv.TIMEWEB_LITE_BASE_URL;
    delete backendEnv.TIMEWEB_LITE_API_KEY;
    delete backendEnv.TIMEWEB_LITE_MODEL;
    delete backendEnv.TIMEWEB_LITE_ENDPOINTS;
  }
  backendEnv.TIMEWEB_LITE_ROUTER_ENABLED = '1';
  if (visionModel) {
    backendEnv.TIMEWEB_VISION_BASE_URL = visionModel.baseUrl;
    backendEnv.TIMEWEB_VISION_API_KEY = visionModel.apiKey;
    backendEnv.TIMEWEB_VISION_MODEL = visionModel.model;
  } else {
    delete backendEnv.TIMEWEB_VISION_BASE_URL;
    delete backendEnv.TIMEWEB_VISION_API_KEY;
    delete backendEnv.TIMEWEB_VISION_MODEL;
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
    TG_USE_RICH_STREAMING: telegramEnv.TG_USE_RICH_STREAMING || '1'
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
      env: { ...process.env, BACKEND_ENV_FILE, TELEGRAM_ENV_FILE, VOICE_ENV_FILE },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    const append = (chunk) => { output += chunk.toString(); if (output.length > 20000) output = output.slice(-20000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Docker operation timed out')); }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output.trim());
      else reject(new Error(output.trim() || `docker exited with code ${code}`));
    });
  });
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

const safeBackupName = (name) => /^chatter-[A-Za-z0-9._-]+\.tar\.gz$/.test(name) ? name : '';

async function readBackupManifest(filePath) {
  try {
    return JSON.parse(await runProcess('tar', ['-xOzf', filePath, 'manifest.json'], 30000));
  } catch {
    return null;
  }
}

async function listBackups() {
  const entries = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && safeBackupName(entry.name));
  const backups = await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(BACKUPS_DIR, entry.name);
    const [stat, manifest] = [fs.statSync(filePath), await readBackupManifest(filePath)];
    return {
      name: entry.name,
      size: stat.size,
      createdAt: manifest?.createdAt || stat.mtime.toISOString(),
      includesUploads: Boolean(manifest?.includesUploads),
      version: `${manifest?.version || 'unknown'}`,
      source: manifest?.source === 'automatic' ? 'automatic' : 'manual'
    };
  }));
  return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function createBackup({ includeUploads = false, source = 'manual' } = {}) {
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
    const manifest = {
      format: 'chatter-backup',
      schemaVersion: 1,
      createdAt,
      version: process.env.CHATTER_IMAGE_TAG || 'local',
      includesUploads: hasUploads,
      source: source === 'automatic' ? 'automatic' : 'manual'
    };
    fs.writeFileSync(path.join(tempDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const tarArgs = ['-czf', tempArchive, '-C', tempDir, 'manifest.json', 'database.sqlite'];
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
  if (schedule.frequency === 'off' || backupPromise) return;
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
    const allowed = name === 'manifest.json' || name === 'database.sqlite' || name === 'uploads' || name.startsWith('uploads/');
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
    await createBackup({ includeUploads: Boolean(manifest.includesUploads), source: 'manual' });
    await stopDataServices();

    fs.copyFileSync(path.join(extractDir, 'database.sqlite'), newDatabase);
    if (fs.existsSync(DATABASE_FILE)) { fs.renameSync(DATABASE_FILE, oldDatabase); databaseMoved = true; }
    fs.renameSync(newDatabase, DATABASE_FILE);
    fs.rmSync(`${DATABASE_FILE}-wal`, { force: true });
    fs.rmSync(`${DATABASE_FILE}-shm`, { force: true });

    if (manifest.includesUploads && fs.existsSync(path.join(extractDir, 'uploads'))) {
      fs.cpSync(path.join(extractDir, 'uploads'), newUploads, { recursive: true });
      if (fs.existsSync(UPLOADS_DIR)) { fs.renameSync(UPLOADS_DIR, oldUploads); uploadsMoved = true; }
      fs.renameSync(newUploads, UPLOADS_DIR);
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
    const output = await runDocker(composeArgs('--profile', 'telegram', '--profile', 'notes', '--profile', 'voice', '--profile', 'admin', 'ps', '-a', '--format', 'json'), 30000);
    if (!output) return [];
    let rows;
    try { rows = JSON.parse(output); if (!Array.isArray(rows)) rows = [rows]; }
    catch { rows = output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
    return rows.map((row) => ({ service: row.Service || '', name: row.Name || '', state: row.State || '', health: row.Health || '', status: row.Status || '' }));
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
  if (!session || session.expiresAt <= Date.now()) { if (token) sessions.delete(token); return null; }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
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
    signal: AbortSignal.timeout(5000),
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
    sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
    const secure = process.env.ADMIN_TLS === '1';
    res.setHeader('Set-Cookie', `chatter_admin_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`);
    return sendJson(res, 200, { ok: true, username: authConfig.username });
  }

  if (req.method === 'POST' && pathname === '/api/logout') {
    const token = parseCookies(req).chatter_admin_session;
    if (token) sessions.delete(token);
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
  if (req.method === 'GET' && pathname === '/api/settings') return sendJson(res, 200, publicSettings());
  if (req.method === 'GET' && pathname === '/api/status') return sendJson(res, 200, { applying: Boolean(applyPromise), services: await getServiceStatus() });
  const serviceActionMatch = pathname.match(/^\/api\/services\/([^/]+)\/(start|stop|restart)$/);
  if (req.method === 'POST' && serviceActionMatch) {
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
  const userDetailMatch = pathname.match(/^\/api\/users\/(\d+)$/);
  if (req.method === 'GET' && userDetailMatch) {
    return sendJson(res, 200, await backendInternalRequest(`/internal/admin/users-overview/${userDetailMatch[1]}`));
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
  if (req.method === 'GET' && pathname === '/api/backups') return sendJson(res, 200, { creating: Boolean(backupPromise), restoring: Boolean(restorePromise), backups: await listBackups() });
  if (req.method === 'GET' && pathname === '/api/backups/schedule') return sendJson(res, 200, getBackupSchedule());

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
    if (backupPromise || restorePromise) return sendJson(res, 409, { error: 'backup_operation_in_progress' });
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
    if (backupPromise || restorePromise) return sendJson(res, 409, { error: 'backup_operation_in_progress' });
    const name = safeBackupName(decodeURIComponent(backupRestoreMatch[1]));
    if (!name) return sendJson(res, 400, { error: 'invalid_backup_name' });
    restorePromise = restoreBackup(name).finally(() => { restorePromise = null; });
    return sendJson(res, 200, await restorePromise);
  }

  const backupDeleteMatch = pathname.match(/^\/api\/backups\/([^/]+)$/);
  if (req.method === 'DELETE' && backupDeleteMatch) {
    if (backupPromise || restorePromise) return sendJson(res, 409, { error: 'backup_operation_in_progress' });
    const name = safeBackupName(decodeURIComponent(backupDeleteMatch[1]));
    const filePath = name ? path.join(BACKUPS_DIR, name) : '';
    if (!filePath || !fs.existsSync(filePath)) return sendJson(res, 404, { error: 'backup_not_found' });
    fs.rmSync(filePath);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/backups') {
    if (backupPromise || restorePromise) return sendJson(res, 409, { error: 'backup_operation_in_progress' });
    const body = await readJson(req);
    backupPromise = createBackup({ includeUploads: body.includeUploads === true, source: 'manual' })
      .finally(() => { backupPromise = null; });
    return sendJson(res, 201, { ok: true, backup: await backupPromise });
  }

  if (req.method === 'POST' && pathname === '/api/image-model/check') {
    try {
      return sendJson(res, 200, await getOpenRouterImageCapabilities(await readJson(req)));
    } catch (error) {
      return sendJson(res, 400, { error: error.message || 'openrouter_model_check_failed' });
    }
  }

  if (req.method === 'PUT' && pathname === '/api/settings') {
    if (applyPromise) return sendJson(res, 409, { error: 'configuration_is_being_applied' });
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

server.listen(PORT, '0.0.0.0', () => console.log(`Chatter Manager is listening on ${process.env.ADMIN_TLS === '1' ? 'https' : 'http'}://0.0.0.0:${PORT}`));
setTimeout(() => { void runScheduledBackupIfDue(); }, 10000).unref();
setInterval(() => { void runScheduledBackupIfDue(); }, 5 * 60 * 1000).unref();
