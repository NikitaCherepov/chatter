'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = Number.parseInt(process.env.ADMIN_INTERNAL_PORT || '8080', 10);
const CONFIG_DIR = path.resolve(process.env.CHATTER_CONFIG_DIR || '/config');
const COMPOSE_FILE = path.resolve(process.env.CHATTER_COMPOSE_FILE || '/workspace/docker-compose.yml');
const PROJECT_DIR = path.dirname(COMPOSE_FILE);
const PROJECT_NAME = process.env.COMPOSE_PROJECT_NAME || 'chatter';
const AUTH_FILE = path.join(CONFIG_DIR, 'auth.json');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const BACKEND_ENV_FILE = path.join(CONFIG_DIR, 'backend.env');
const TELEGRAM_ENV_FILE = path.join(CONFIG_DIR, 'telegram.env');
const VOICE_ENV_FILE = path.join(CONFIG_DIR, 'voice.env');
const COMPOSE_RUNTIME_ENV_FILE = path.join(CONFIG_DIR, 'compose.runtime.env');
const ADMIN_PANEL_URL = new URL(process.env.ADMIN_PANEL_URL || 'http://admin-panel:3000');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });

const sessions = new Map();
const loginAttempts = new Map();
let applyPromise = null;

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
  const password = `${process.env.ADMIN_PASSWORD || ''}`;
  if (!username || password.length < 12) {
    throw new Error('ADMIN_USERNAME and an ADMIN_PASSWORD of at least 12 characters are required on first start');
  }
  const auth = { username, ...hashPassword(password), updatedAt: new Date().toISOString() };
  atomicWrite(AUTH_FILE, `${JSON.stringify(auth, null, 2)}\n`);
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
  VOICE_PORT: process.env.VOICE_PORT || '3030'
});

const defaultSettings = () => ({
  telegramEnabled: false,
  notesUrl: '',
  aiBaseUrl: 'https://openrouter.ai/api/v1',
  aiModel: '',
  voiceMode: 'off',
  voiceExternalUrl: '',
  updatedAt: null
});

const loadSettings = () => ({ ...defaultSettings(), ...loadJson(SETTINGS_FILE, {}) });

function publicSettings() {
  const backendEnv = parseEnv(BACKEND_ENV_FILE);
  const telegramEnv = parseEnv(TELEGRAM_ENV_FILE);
  return {
    ...loadSettings(),
    hasTelegramToken: Boolean(telegramEnv.TELEGRAM_TOKEN),
    hasAiApiKey: Boolean(backendEnv.TIMEWEB_API_KEY),
    hasVoiceToken: Boolean(backendEnv.VOICE_TRANSCRIBE_TOKEN || parseEnv(VOICE_ENV_FILE).VOICE_TRANSCRIBE_TOKEN)
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

function saveSettings(input) {
  const previous = loadSettings();
  const backendEnv = parseEnv(BACKEND_ENV_FILE);
  const telegramEnv = parseEnv(TELEGRAM_ENV_FILE);
  const voiceEnv = parseEnv(VOICE_ENV_FILE);
  const telegramEnabled = Boolean(input.telegramEnabled);
  const telegramToken = `${input.telegramToken || ''}`.trim() || telegramEnv.TELEGRAM_TOKEN || '';
  const aiApiKey = `${input.aiApiKey || ''}`.trim() || backendEnv.TIMEWEB_API_KEY || '';
  const aiBaseUrl = normalizeUrl(input.aiBaseUrl ?? previous.aiBaseUrl, 'AI base URL', { allowEmpty: false });
  const aiModel = `${input.aiModel ?? previous.aiModel ?? ''}`.trim();
  const notesUrl = normalizeUrl(input.notesUrl ?? previous.notesUrl, 'Notes URL');
  const voiceMode = ['off', 'local', 'remote'].includes(input.voiceMode) ? input.voiceMode : 'off';
  const voiceExternalUrl = normalizeUrl(input.voiceExternalUrl ?? previous.voiceExternalUrl, 'Voice URL');
  let voiceToken = `${input.voiceToken || ''}`.trim() || backendEnv.VOICE_TRANSCRIBE_TOKEN || voiceEnv.VOICE_TRANSCRIBE_TOKEN || '';

  if (telegramEnabled && !telegramToken) throw new Error('Telegram token is required when Telegram is enabled');
  if (voiceMode === 'remote' && !voiceExternalUrl) throw new Error('External Voice URL is required');
  if (voiceMode !== 'off' && !voiceToken) voiceToken = randomSecret(32);

  const internalToken = backendEnv.BACKEND_INTERNAL_TOKEN || telegramEnv.BACKEND_INTERNAL_TOKEN || randomSecret(32);
  Object.assign(backendEnv, {
    API_JWT_SECRET: backendEnv.API_JWT_SECRET || randomSecret(32),
    BACKEND_INTERNAL_TOKEN: internalToken,
    ENCRYPTION_KEY: backendEnv.ENCRYPTION_KEY || randomSecret(32),
    TIMEWEB_API_KEY: aiApiKey,
    TIMEWEB_BASE_URL: aiBaseUrl,
    TELEGRAM_TOKEN: telegramToken,
    VOICE_TRANSCRIBE_URL: voiceMode === 'local' ? 'http://voice:3030/api/voice' : voiceMode === 'remote' ? voiceExternalUrl : '',
    VOICE_TRANSCRIBE_TOKEN: voiceMode === 'off' ? '' : voiceToken
  });
  // TTS endpoints are derived from VOICE_TRANSCRIBE_URL. Remove stale
  // overrides when switching between local and remote Voice installations.
  delete backendEnv.VOICE_TTS_URL;
  delete backendEnv.VOICE_SILERO_URL;
  if (aiModel) backendEnv.TIMEWEB_MODEL = aiModel;
  else delete backendEnv.TIMEWEB_MODEL;

  Object.assign(telegramEnv, { TELEGRAM_TOKEN: telegramToken, BACKEND_INTERNAL_TOKEN: internalToken, NOTES_WEBAPP_URL: notesUrl });
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
  const settings = { telegramEnabled, notesUrl, aiBaseUrl, aiModel, voiceMode, voiceExternalUrl, updatedAt: new Date().toISOString() };
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
    const child = spawn('docker', args, {
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

async function removeServices(profile, services) {
  await runDocker(composeArgs('--profile', profile, 'rm', '-s', '-f', ...services), 2 * 60 * 1000);
}

async function applyConfiguration() {
  const settings = loadSettings();
  await runDocker(composeArgs('up', '-d', '--force-recreate', 'backend'));
  if (settings.telegramEnabled) await runDocker(composeArgs('--profile', 'telegram', 'up', '-d', '--build', 'telegram-bot', 'webapp-notes'));
  else await removeServices('telegram', ['telegram-bot', 'webapp-notes']);
  if (settings.voiceMode === 'local') await runDocker(composeArgs('--profile', 'voice', 'up', '-d', '--build', 'voice'));
  else await removeServices('voice', ['voice']);
}

async function getServiceStatus() {
  try {
    const output = await runDocker(composeArgs('--profile', 'telegram', '--profile', 'voice', '--profile', 'admin', 'ps', '-a', '--format', 'json'), 30000);
    if (!output) return [];
    let rows;
    try { rows = JSON.parse(output); if (!Array.isArray(rows)) rows = [rows]; }
    catch { rows = output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
    return rows.map((row) => ({ service: row.Service || '', name: row.Name || '', state: row.State || '', health: row.Health || '', status: row.Status || '' }));
  } catch (error) {
    return [{ service: 'docker', state: 'error', status: error.message }];
  }
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

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
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
  if (req.method === 'GET' && pathname === '/api/settings') return sendJson(res, 200, publicSettings());
  if (req.method === 'GET' && pathname === '/api/status') return sendJson(res, 200, { applying: Boolean(applyPromise), services: await getServiceStatus() });

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
