import { db } from '../db.js';
import { modelApiKey } from './model-settings.js';

export type DecisionSettings = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKeyId: number | null;
  timeoutMs: number;
  inputPricePerMillion: number;
};
const key = 'decision_settings_v1';
const defaults: DecisionSettings = {
  enabled: false,
  baseUrl: 'https://inference.celeris.ai/celeris-1-decision/v1',
  model: 'celeris-1.1-decision',
  apiKeyId: null,
  timeoutMs: 5000,
  inputPricePerMillion: 0.004,
};
export function getDecisionSettings(): DecisionSettings {
  const row = db.prepare('SELECT value_json FROM system_settings WHERE key = ?').get(key) as
    { value_json: string } | undefined;
  return row ? { ...defaults, ...JSON.parse(row.value_json) } : { ...defaults };
}
export function decisionPublicSettings() {
  const settings = getDecisionSettings();
  return { ...settings, hasApiKey: Boolean(modelApiKey(settings.apiKeyId)) };
}
export function setDecisionSettings(raw: any) {
  const next = { ...getDecisionSettings(), ...raw };
  const url = new URL(next.baseUrl);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    typeof next.enabled !== 'boolean' ||
    typeof next.model !== 'string' ||
    !next.model.trim() ||
    next.model.length > 200 ||
    !Number.isInteger(next.timeoutMs) ||
    next.timeoutMs < 250 ||
    next.timeoutMs > 30000 ||
    !Number.isFinite(next.inputPricePerMillion) ||
    next.inputPricePerMillion < 0 ||
    (next.apiKeyId !== null &&
      (!Number.isSafeInteger(next.apiKeyId) || !modelApiKey(next.apiKeyId)))
  )
    throw new Error('decision_invalid_settings');
  const settings: DecisionSettings = {
    enabled: next.enabled,
    baseUrl: url.href.replace(/\/$/, ''),
    model: next.model.trim(),
    apiKeyId: next.apiKeyId,
    timeoutMs: next.timeoutMs,
    inputPricePerMillion: next.inputPricePerMillion,
  };
  db.prepare(
    'INSERT INTO system_settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
  ).run(key, JSON.stringify(settings), Date.now());
  return decisionPublicSettings();
}
export function decisionKeyUsage(id: number): string[] {
  return getDecisionSettings().apiKeyId === id ? ['Decision'] : [];
}
export function replaceDecisionKey(id: number, replacement: number | null) {
  if (getDecisionSettings().apiKeyId === id)
    setDecisionSettings({
      apiKeyId: replacement,
      ...(replacement === null ? { enabled: false } : {}),
    });
}
