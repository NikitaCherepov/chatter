/**
 * Shared helpers for model autocomplete / preset components.
 * Kept separate from the .tsx so importers don't pull React unnecessarily.
 */

import type { ModelPrices } from '../../../lib/presetModels';

// ── OpenRouter pricing conversion ────────────────────────────────────────────

export type OpenRouterPricing = {
  prompt?: string | null;
  completion?: string | null;
  input_cache_read?: string | null;
};

/**
 * OpenRouter prices in /models and /endpoints are per-token (USD float string).
 * Convert to per-million for display/storage.
 */
export const pricePerTokenToPerMillion = (
  raw: string | number | null | undefined
): number | null => {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1_000_000 * 1e6) / 1e6;
};

export function pricingToModelPrices(
  p: OpenRouterPricing | null | undefined
): ModelPrices | null {
  if (!p) return null;
  const input = pricePerTokenToPerMillion(p.prompt);
  const output = pricePerTokenToPerMillion(p.completion);
  const cache = pricePerTokenToPerMillion(p.input_cache_read);
  if (input === null && output === null && cache === null) return null;
  return {
    inputPricePerMillion: input,
    outputPricePerMillion: output,
    cacheReadPricePerMillion: cache,
  };
}

// ── User input parsing ───────────────────────────────────────────────────────

/**
 * Parse user-typed price strings accepting either "." or "," as the decimal
 * separator. Returns null for empty/invalid input.
 */
export const parseUserPrice = (raw: string): number | null => {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim().replace(',', '.');
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
};

// ── Display formatting ───────────────────────────────────────────────────────

/**
 * Short human-readable modality string, e.g. "text+image→text".
 */
export const formatModalityShort = (raw: string | null | undefined): string => {
  if (!raw) return '';
  // OpenRouter format is already like "text+image+file->text".
  // Just normalize the arrow.
  return raw.replace('->', '\u2192');
};

/**
 * Format context length (in tokens) as short K/M.
 */
export const formatContextLength = (tokens: number | null | undefined): string => {
  if (!tokens || !Number.isFinite(tokens)) return '';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M ctx`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K ctx`;
  return `${tokens} ctx`;
};

/**
 * Build hint for a model option in the autocomplete dropdown.
 */
export const formatModelHint = (m: {
  id?: string;
  architecture?: { modality?: string | null } | null;
  context_length?: number | null;
}): string => {
  const parts: string[] = [];
  const modality = formatModalityShort(m.architecture?.modality);
  if (modality) parts.push(modality);
  const ctx = formatContextLength(m.context_length ?? null);
  if (ctx) parts.push(ctx);
  return parts.join(' \u00b7 ') || (m.id || '');
};
