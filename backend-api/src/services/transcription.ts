import { getUserById } from './chats.js';
import { getPlanLimits } from './plan-limits.js';
import { chargeTokens, checkQuota } from './token-quota.js';
import { getTranscriptionRuntimeSettings } from './transcription-settings.js';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
let statusCache: { key: string; expiresAt: number; value: TranscriptionStatus } | null = null;

export type TranscriptionStatus = {
  enabled: boolean;
  available: boolean;
  provider: 'openrouter' | 'custom';
  model: string;
  checkedAt: number;
  error: string | null;
};

const normalizeLanguage = (value: unknown): string | null => {
  const normalized = `${value || ''}`.trim().toLowerCase().replace(/_/g, '-');
  if (!normalized || normalized === 'auto') return null;
  const base = normalized.split('-')[0];
  return /^[a-z]{2,3}$/.test(base) ? base : null;
};

const transcriptionEndpoint = (baseUrl: string) =>
  /\/audio\/transcriptions\/?$/i.test(baseUrl)
    ? baseUrl
    : `${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;

const modelsEndpoint = (baseUrl: string, provider: 'openrouter' | 'custom') => {
  const root = baseUrl.replace(/\/audio\/transcriptions\/?$/i, '').replace(/\/+$/, '');
  return provider === 'openrouter'
    ? `${root}/models?output_modalities=transcription`
    : `${root}/models`;
};

const wavDurationSeconds = (buffer: Buffer): number | null => {
  if (
    buffer.length < 44 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return null;
  }
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ' && size >= 12 && offset + 8 + size <= buffer.length) {
      byteRate = buffer.readUInt32LE(offset + 16);
    } else if (id === 'data') {
      dataSize = Math.min(size, Math.max(0, buffer.length - offset - 8));
      break;
    }
    offset += 8 + size + (size % 2);
  }
  return byteRate > 0 && dataSize > 0 ? dataSize / byteRate : null;
};

export const getTranscriptionStatus = async (force = false): Promise<TranscriptionStatus> => {
  const settings = getTranscriptionRuntimeSettings();
  const cacheKey = JSON.stringify([
    settings.enabled,
    settings.provider,
    settings.baseUrl,
    settings.model,
    settings.apiKeyId,
  ]);
  if (!force && statusCache?.key === cacheKey && statusCache.expiresAt > Date.now())
    return statusCache.value;
  const base: TranscriptionStatus = {
    enabled: settings.enabled,
    available: false,
    provider: settings.provider,
    model: settings.model,
    checkedAt: Date.now(),
    error: null,
  };
  if (!settings.enabled || !settings.baseUrl || !settings.model || !settings.apiKey) {
    const value = { ...base, error: settings.enabled ? 'transcription_not_configured' : null };
    statusCache = { key: cacheKey, expiresAt: Date.now() + 30_000, value };
    return value;
  }
  try {
    const response = await fetch(modelsEndpoint(settings.baseUrl, settings.provider), {
      headers: { Authorization: `Bearer ${settings.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json().catch(() => ({}))) as { data?: Array<{ id?: string }> };
    const models = Array.isArray(payload.data) ? payload.data : [];
    const modelKnown = models.length === 0 || models.some((item) => item?.id === settings.model);
    const value = {
      ...base,
      available: modelKnown,
      error: modelKnown ? null : 'transcription_model_unavailable',
    };
    statusCache = { key: cacheKey, expiresAt: Date.now() + 30_000, value };
    return value;
  } catch (error) {
    const value = { ...base, error: error instanceof Error ? error.message : String(error) };
    statusCache = { key: cacheKey, expiresAt: Date.now() + 15_000, value };
    return value;
  }
};

export const transcribeAudio = async (input: {
  userId: number;
  audioBuffer: Buffer;
  language?: string | null;
}): Promise<{ text: string }> => {
  const settings = getTranscriptionRuntimeSettings();
  if (!settings.enabled || !settings.apiKey || !settings.model || !settings.baseUrl) {
    throw new Error('transcription_not_configured');
  }
  if (!input.audioBuffer.length) throw new Error('empty_audio');
  if (input.audioBuffer.length > MAX_AUDIO_BYTES) throw new Error('audio_too_large');
  const user = getUserById(input.userId);
  if (!user) throw new Error('user_not_found');
  const quota = checkQuota(
    input.userId,
    user.is_admin === 1,
    getPlanLimits(user.plan).billing_mode,
  );
  if (!quota.ok) throw new Error('quota_exceeded');

  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(input.audioBuffer)], { type: 'audio/wav' }),
    'voice.wav',
  );
  form.append('model', settings.model);
  const language = normalizeLanguage(input.language);
  if (language) form.append('language', language);
  const response = await fetch(transcriptionEndpoint(settings.baseUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    text?: string;
    usage?: {
      cost?: number | string | null;
      prompt_tokens?: number;
      input_tokens?: number;
      completion_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
  };
  if (!response.ok) {
    const detail = `${(payload as any)?.error?.message || (payload as any)?.error || ''}`.slice(
      0,
      300,
    );
    throw new Error(`transcription_failed_http_${response.status}${detail ? `: ${detail}` : ''}`);
  }
  const text = `${payload.text || ''}`.trim();
  const promptTokens = Math.max(
    0,
    Math.floor(Number(payload.usage?.prompt_tokens ?? payload.usage?.input_tokens) || 0),
  );
  const completionTokens = Math.max(
    0,
    Math.floor(Number(payload.usage?.completion_tokens ?? payload.usage?.output_tokens) || 0),
  );
  const totalTokens = Math.max(
    promptTokens + completionTokens,
    Math.floor(Number(payload.usage?.total_tokens) || 0),
  );
  const rawReportedCost = payload.usage?.cost;
  const reportedCost =
    rawReportedCost === null || rawReportedCost === undefined || rawReportedCost === ''
      ? null
      : Number(rawReportedCost);
  const duration = wavDurationSeconds(input.audioBuffer);
  const fallbackCost =
    duration !== null && settings.audioPricePerSecond !== null
      ? duration * settings.audioPricePerSecond
      : null;
  chargeTokens({
    userId: input.userId,
    route: 'voice:transcription',
    modelId: settings.model,
    modelName: settings.model,
    providerName: settings.provider,
    promptTokens,
    completionTokens,
    cacheHitTokens: 0,
    cacheMissTokens: promptTokens,
    reasoningTokens: 0,
    totalTokens,
    actualCostUsd:
      reportedCost !== null && Number.isFinite(reportedCost) && reportedCost >= 0
        ? reportedCost
        : fallbackCost,
    pricingSource:
      reportedCost !== null && Number.isFinite(reportedCost) && reportedCost >= 0
        ? 'provider_reported'
        : 'transcription_settings',
    inputPricePerMillion: settings.inputPricePerMillion,
    outputPricePerMillion: null,
    cacheReadPricePerMillion: null,
  });
  return { text };
};
