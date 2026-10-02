import crypto from 'node:crypto';
import { db } from '../db.js';
import { getEncryptionKey } from '../utils/encryption.js';

export type TranscriptionProvider = 'openrouter' | 'custom';
export type TranscriptionSettings = {
  enabled: boolean;
  provider: TranscriptionProvider;
  baseUrl: string;
  model: string;
  apiKeyId: number | null;
  audioPricePerSecond: number | null;
  inputPricePerMillion: number | null;
};

export type TranscriptionPublicSettings = TranscriptionSettings & { hasApiKey: boolean };

const SETTINGS_KEY = 'transcription_settings';
const VAULT_DELIMITER = '::';
const DEFAULTS: TranscriptionSettings = {
  enabled: false,
  provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'openai/whisper-large-v3-turbo',
  apiKeyId: null,
  audioPricePerSecond: null,
  inputPricePerMillion: null,
};

const normalizeId = (value: unknown): number | null => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const normalizePrice = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : null;
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
    { key_encrypted: string } | undefined;
  if (!row) return '';
  const [ivHex, payloadHex] = row.key_encrypted.split(VAULT_DELIMITER);
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

const normalizeSettings = (value: unknown, fallback = DEFAULTS): TranscriptionSettings => {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const provider: TranscriptionProvider = source.provider === 'custom' ? 'custom' : 'openrouter';
  return {
    enabled: source.enabled === true,
    provider,
    baseUrl: `${source.baseUrl || fallback.baseUrl}`.trim().replace(/\/+$/, ''),
    model: `${source.model || fallback.model}`.trim(),
    apiKeyId: normalizeId(source.apiKeyId) ?? fallback.apiKeyId,
    audioPricePerSecond: normalizePrice(source.audioPricePerSecond),
    inputPricePerMillion: normalizePrice(source.inputPricePerMillion),
  };
};

const writeSettings = (settings: TranscriptionSettings) => {
  db.prepare(
    `
    INSERT INTO system_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `,
  ).run(SETTINGS_KEY, JSON.stringify(settings), Date.now());
};

const readSettings = (): TranscriptionSettings => {
  const row = db
    .prepare('SELECT value_json FROM system_settings WHERE key = ?')
    .get(SETTINGS_KEY) as { value_json: string } | undefined;
  if (!row) {
    writeSettings(DEFAULTS);
    return { ...DEFAULTS };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value_json);
  } catch {
    parsed = null;
  }
  const normalized = normalizeSettings(parsed);
  if (JSON.stringify(parsed) !== JSON.stringify(normalized)) writeSettings(normalized);
  return normalized;
};

export const getTranscriptionSettings = (): TranscriptionPublicSettings => {
  const settings = readSettings();
  return { ...settings, hasApiKey: Boolean(readSecret(settings.apiKeyId)) };
};

export const getTranscriptionRuntimeSettings = () => {
  const settings = readSettings();
  return { ...settings, apiKey: readSecret(settings.apiKeyId) };
};

export const updateTranscriptionSettings = (patch: unknown): TranscriptionPublicSettings => {
  const source = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {};
  const current = readSettings();
  const next = normalizeSettings(
    {
      ...current,
      ...source,
      apiKeyId: 'apiKeyId' in source ? requireApiKeyId(source.apiKeyId) : current.apiKeyId,
    },
    current,
  );
  if (next.enabled && (!next.baseUrl || !next.model || !next.apiKeyId)) {
    throw new Error('transcription_configuration_required');
  }
  writeSettings(next);
  return getTranscriptionSettings();
};

export const getTranscriptionApiKeyUsage = (id: number): string[] =>
  readSettings().apiKeyId === id ? ['Voice transcription'] : [];

export const replaceTranscriptionApiKeyReference = (
  currentId: number,
  replacementId: number | null,
) => {
  const settings = readSettings();
  if (settings.apiKeyId === currentId) writeSettings({ ...settings, apiKeyId: replacementId });
};
