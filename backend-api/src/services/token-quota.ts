import { db } from '../db.js';
import { getNowUnix } from '../db.js';

const WEEK_SECONDS = 7 * 24 * 60 * 60;

// ── Model override types ────────────────────────────────────────────────────

export type ProviderKind = 'openrouter' | 'deepseek' | 'xiaomi' | 'custom' | null;

export type PricingMode = 'auto' | 'manual' | null;

export type ModelOverride = {
  model_id: string;
  coefficient: number;
  updated_at: number;
  provider_kind: ProviderKind;
  openrouter_provider_slug: string | null;
  pricing_mode: PricingMode;
  input_price_per_million: number | null;
  output_price_per_million: number | null;
  cache_read_price_per_million: number | null;
  pricing_source: string | null;
  pricing_updated_at: number | null;
};

export type PricingSnapshot = {
  upstream_provider_slug: string | null;
  input_price_per_million: number | null;
  output_price_per_million: number | null;
  cache_read_price_per_million: number | null;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  pricing_source: string | null;
};

/** In-memory cache of model_id → ModelOverride. Refreshed on demand. */
let overrideCache: Map<string, ModelOverride> | null = null;

const readAllOverrides = (): Map<string, ModelOverride> => {
  const rows = db.prepare(`
    SELECT model_id, coefficient, updated_at,
           provider_kind, openrouter_provider_slug, pricing_mode,
           input_price_per_million, output_price_per_million,
           cache_read_price_per_million, pricing_source, pricing_updated_at
    FROM model_overrides
  `).all() as Array<ModelOverride>;
  const map = new Map<string, ModelOverride>();
  for (const row of rows) {
    if (Number.isFinite(row.coefficient) && row.coefficient >= 0) {
      map.set(row.model_id, row);
    }
  }
  return map;
};

/** Returns cached override map. Loads on first call. */
export const getOverrideMap = (): Map<string, ModelOverride> => {
  if (!overrideCache) overrideCache = readAllOverrides();
  return overrideCache;
};

/** Force a re-read from DB (call after admin updates overrides). */
export const refreshOverrideCache = (): void => {
  overrideCache = readAllOverrides();
};

/** Returns coefficient for a given model_id (defaults to 1.0). */
export const getCoefficient = (modelId: string | null | undefined): number => {
  if (!modelId) return 1.0;
  const map = getOverrideMap();
  const value = map.get(modelId);
  return value?.coefficient ?? 1.0;
};

/** Returns full override for a given model_id, or null. */
export const getModelOverride = (modelId: string | null | undefined): ModelOverride | null => {
  if (!modelId) return null;
  const map = getOverrideMap();
  return map.get(modelId) ?? null;
};

/**
 * Extract a pricing snapshot from the model_override at the time of the request.
 * This is what gets stored in user_token_usage so old requests don't get
 * re-priced when admin changes model prices later.
 */
export const getPricingSnapshot = (modelId: string | null | undefined): PricingSnapshot => {
  const override = getModelOverride(modelId);
  return {
    upstream_provider_slug: override?.openrouter_provider_slug ?? null,
    input_price_per_million: override?.input_price_per_million ?? null,
    output_price_per_million: override?.output_price_per_million ?? null,
    cache_read_price_per_million: override?.cache_read_price_per_million ?? null,
    estimated_cost_usd: null, // calculated in chargeTokens
    actual_cost_usd: null,    // from OpenRouter response if available
    pricing_source: override?.pricing_source ?? null,
  };
};

// ── Coefficient cache (backward-compatible alias) ────────────────────────────

/** @deprecated Use getOverrideMap instead. */
export const getCoefficientMap = (): Map<string, number> => {
  const overrideMap = getOverrideMap();
  const map = new Map<string, number>();
  for (const [id, override] of overrideMap) {
    map.set(id, override.coefficient);
  }
  return map;
};

/** @deprecated Use refreshOverrideCache instead. */
export const refreshCoefficientCache = (): void => {
  refreshOverrideCache();
};

/** Calculates quota units without writing anything to the database. */
export const calculateChargedTokens = (
  totalTokens: number,
  modelId: string | null | undefined,
): { charged: number; coefficient: number; isFree: boolean } => {
  const coefficient = getCoefficient(modelId);
  return {
    charged: Math.max(0, Math.round(Math.max(0, totalTokens || 0) * coefficient * 1000) / 1000),
    coefficient,
    isFree: coefficient === 0,
  };
};

/**
 * Calculate estimated USD cost from token counts and per-million prices.
 * reasoning_tokens are NOT added on top of completion_tokens — they are
 * already included in the completion token count from the API.
 *
 * Formula:
 *   uncachedInputCost = cacheMissTokens * inputPricePerMillion / 1_000_000
 *   cachedInputCost   = cacheHitTokens * cacheReadPricePerMillion / 1_000_000
 *   outputCost        = completionTokens * outputPricePerMillion / 1_000_000
 *   estimatedCost     = uncachedInputCost + cachedInputCost + outputCost
 *
 * If cacheReadPricePerMillion is unknown, falls back to input_price_per_million
 * (marked as estimated).
 */
export const calculateEstimatedCostUsd = (
  cacheMissTokens: number,
  cacheHitTokens: number,
  completionTokens: number,
  inputPricePerMillion: number | null,
  outputPricePerMillion: number | null,
  cacheReadPricePerMillion: number | null,
): { cost: number | null; cachePriceFellBackToInput: boolean } => {
  const inPrice = Number.isFinite(inputPricePerMillion) && (inputPricePerMillion as number) > 0 ? (inputPricePerMillion as number) : 0;
  const outPrice = Number.isFinite(outputPricePerMillion) && (outputPricePerMillion as number) > 0 ? (outputPricePerMillion as number) : 0;
  let cachePrice = Number.isFinite(cacheReadPricePerMillion) && (cacheReadPricePerMillion as number) > 0 ? (cacheReadPricePerMillion as number) : 0;
  let cacheFellBack = false;

  if (cachePrice <= 0 && inPrice > 0) {
    cachePrice = inPrice;
    cacheFellBack = true;
  }

  if (inPrice <= 0 && outPrice <= 0 && cachePrice <= 0) return { cost: null, cachePriceFellBackToInput: false };

  const uncachedInputCost = (cacheMissTokens * inPrice) / 1_000_000;
  const cachedInputCost = (cacheHitTokens * cachePrice) / 1_000_000;
  const outputCost = (completionTokens * outPrice) / 1_000_000;
  const cost = uncachedInputCost + cachedInputCost + outputCost;

  return { cost: Math.max(0, Math.round(cost * 1e7) / 1e7), cachePriceFellBackToInput: cacheFellBack };
};

/** Upsert a coefficient for a model. */
export const setCoefficient = (modelId: string, coefficient: number): void => {
  const safe = Number.isFinite(coefficient) && coefficient >= 0 ? coefficient : 1.0;
  const now = getNowUnix();
  db.prepare(`
    INSERT INTO model_overrides (model_id, coefficient, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(model_id) DO UPDATE SET
      coefficient = excluded.coefficient,
      updated_at = excluded.updated_at
  `).run(modelId, safe, now);
  refreshOverrideCache();
};

/**
 * Upsert full model override info (provider kind, OpenRouter slug, pricing).
 * Does NOT overwrite coefficient unless explicitly provided.
 */
export const setModelProvider = (
  modelId: string,
  params: {
    providerKind?: ProviderKind;
    openrouterProviderSlug?: string | null;
    pricingMode?: PricingMode;
    inputPricePerMillion?: number | null;
    outputPricePerMillion?: number | null;
    cacheReadPricePerMillion?: number | null;
    pricingSource?: string | null;
    coefficient?: number | null;
  }
): void => {
  const now = getNowUnix();
  const existing = getModelOverride(modelId);

  const providerKind = params.providerKind !== undefined ? params.providerKind : existing?.provider_kind ?? null;
  const openrouterProviderSlug = params.openrouterProviderSlug !== undefined ? params.openrouterProviderSlug : existing?.openrouter_provider_slug ?? null;
  const pricingMode = params.pricingMode !== undefined ? params.pricingMode : existing?.pricing_mode ?? null;
  const inputPrice = params.inputPricePerMillion !== undefined ? params.inputPricePerMillion : existing?.input_price_per_million ?? null;
  const outputPrice = params.outputPricePerMillion !== undefined ? params.outputPricePerMillion : existing?.output_price_per_million ?? null;
  const cacheReadPrice = params.cacheReadPricePerMillion !== undefined ? params.cacheReadPricePerMillion : existing?.cache_read_price_per_million ?? null;
  const pricingSource = params.pricingSource !== undefined ? params.pricingSource : existing?.pricing_source ?? null;
  const coeff = params.coefficient !== undefined && params.coefficient !== null
    ? (Number.isFinite(params.coefficient) && params.coefficient >= 0 ? params.coefficient : 1.0)
    : existing?.coefficient ?? 1.0;

  db.prepare(`
    INSERT INTO model_overrides (
      model_id, coefficient, updated_at,
      provider_kind, openrouter_provider_slug, pricing_mode,
      input_price_per_million, output_price_per_million,
      cache_read_price_per_million, pricing_source, pricing_updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(model_id) DO UPDATE SET
      coefficient = excluded.coefficient,
      updated_at = excluded.updated_at,
      provider_kind = excluded.provider_kind,
      openrouter_provider_slug = excluded.openrouter_provider_slug,
      pricing_mode = excluded.pricing_mode,
      input_price_per_million = excluded.input_price_per_million,
      output_price_per_million = excluded.output_price_per_million,
      cache_read_price_per_million = excluded.cache_read_price_per_million,
      pricing_source = excluded.pricing_source,
      pricing_updated_at = excluded.pricing_updated_at
  `).run(
    modelId, coeff, now,
    providerKind,
    openrouterProviderSlug,
    pricingMode,
    typeof inputPrice === 'number' && Number.isFinite(inputPrice) ? inputPrice : null,
    typeof outputPrice === 'number' && Number.isFinite(outputPrice) ? outputPrice : null,
    typeof cacheReadPrice === 'number' && Number.isFinite(cacheReadPrice) ? cacheReadPrice : null,
    pricingSource,
    pricingSource ? now : null
  );
  refreshOverrideCache();
};

/** Remove overrides for model_ids no longer in the catalog. */
export const pruneCoefficients = (knownModelIds: string[]): void => {
  if (knownModelIds.length === 0) {
    db.prepare('DELETE FROM model_overrides').run();
  } else {
    const placeholders = knownModelIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM model_overrides WHERE model_id NOT IN (${placeholders})`).run(...knownModelIds);
  }
  refreshOverrideCache();
};

type QuotaState = {
  weekly_tokens_used: number;
  weekly_tokens_quota: number;
  weekly_window_started_at: number;
};

const getUserQuotaState = (userId: number): QuotaState | null => {
  const row = db.prepare(`
    SELECT weekly_tokens_used, weekly_tokens_quota, weekly_window_started_at
    FROM users WHERE id = ?
  `).get(userId) as QuotaState | undefined;
  return row ?? null;
};

/**
 * Lazy-reset of the weekly window. If window_started_at + 7d <= now,
 * rolls window forward by N×7d (N >= 1) and zeroes weekly_tokens_used.
 * Returns the resulting (post-reset) quota state.
 */
export const advanceWeeklyWindowIfNeeded = (userId: number, now = getNowUnix()): QuotaState | null => {
  const state = getUserQuotaState(userId);
  if (!state) return null;
  if (state.weekly_window_started_at === 0) {
    // First ever request — start the window now, keep used = 0.
    db.prepare(`
      UPDATE users SET weekly_window_started_at = ?, weekly_tokens_used = 0 WHERE id = ?
    `).run(now, userId);
    return { ...state, weekly_window_started_at: now, weekly_tokens_used: 0 };
  }
  const elapsed = now - state.weekly_window_started_at;
  if (elapsed < WEEK_SECONDS) return state;
  const weeksPassed = Math.floor(elapsed / WEEK_SECONDS);
  const newWindowStart = state.weekly_window_started_at + weeksPassed * WEEK_SECONDS;
  db.prepare(`
    UPDATE users SET weekly_window_started_at = ?, weekly_tokens_used = 0 WHERE id = ?
  `).run(newWindowStart, userId);
  return { ...state, weekly_window_started_at: newWindowStart, weekly_tokens_used: 0 };
};

export type QuotaCheckResult =
  | { ok: true; used: number; quota: number; windowStartedAt: number }
  | { ok: false; error: 'quota_exceeded'; used: number; quota: number; windowStartedAt: number; resetsAt: number };

// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
export type QuotaExceededResult = Extract<QuotaCheckResult, { error: 'quota_exceeded' }>;

/**
 * Checks if the user may start a new AI request. Admins always pass.
 * Lazily advances the weekly window. Does NOT charge tokens.
 */
export const checkQuota = (userId: number, isAdmin: boolean): QuotaCheckResult => {
  const state = advanceWeeklyWindowIfNeeded(userId);
  if (!state) {
    return { ok: true, used: 0, quota: 0, windowStartedAt: 0 };
  }
  if (isAdmin || state.weekly_tokens_quota <= 0) {
    return {
      ok: true,
      used: state.weekly_tokens_used,
      quota: state.weekly_tokens_quota,
      windowStartedAt: state.weekly_window_started_at,
    };
  }
  if (state.weekly_tokens_used >= state.weekly_tokens_quota) {
    return {
      ok: false,
      error: 'quota_exceeded',
      used: state.weekly_tokens_used,
      quota: state.weekly_tokens_quota,
      windowStartedAt: state.weekly_window_started_at,
      resetsAt: state.weekly_window_started_at + WEEK_SECONDS,
    };
  }
  return {
    ok: true,
    used: state.weekly_tokens_used,
    quota: state.weekly_tokens_quota,
    windowStartedAt: state.weekly_window_started_at,
  };
};

export type ChargeInput = {
  userId: number;
  chatId?: number | null;
  messageId?: number | null;
  /** 'manual' | 'auto-pro' | 'auto-lite' | 'auto-vision' | 'subagent:<name>' | null */
  route?: string | null;
  /** uniqueId for coefficient/pricing lookup. */
  modelId?: string | null;
  modelName?: string | null;
  /** Internal Chatter route (e.g. 'pro-1', 'lite-1'). */
  providerName?: string | null;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  aborted?: boolean;
  /** Real upstream provider from API response (e.g. 'deepinfra', 'together'). */
  upstreamProviderSlug?: string | null;
  /** Actual cost returned by OpenRouter in usage.cost, if available. */
  actualCostUsd?: number | null;
  /** Pricing source label for this charge. */
  pricingSource?: string | null;
};

/**
 * Writes a row to user_token_usage and increments users.weekly_tokens_used.
 * coefficient is looked up from model_overrides by modelId (default 1.0).
 * If coefficient = 0, charged_tokens = 0 (free model, does not consume quota).
 *
 * Cost snapshot is taken from model_overrides at the time of charge so that
 * future price changes do not affect historical records.
 *
 * This function MUST be safe to call in finally / catch blocks — never throws.
 */
export const chargeTokens = (input: ChargeInput): { charged: number; coefficient: number; isFree: boolean } => {
  try {
    const { charged, coefficient, isFree } = calculateChargedTokens(input.totalTokens, input.modelId);
    const now = getNowUnix();

    // Take pricing snapshot from model_overrides now (immutable for this record).
    const snapshot = getPricingSnapshot(input.modelId);

    // Calculate estimated cost from token counts × stored prices.
    const estResult = calculateEstimatedCostUsd(
      Math.max(0, Math.floor(input.cacheMissTokens || 0)),
      Math.max(0, Math.floor(input.cacheHitTokens || 0)),
      Math.max(0, Math.floor(input.completionTokens || 0)),
      snapshot.input_price_per_million,
      snapshot.output_price_per_million,
      snapshot.cache_read_price_per_million,
    );

    // Determine final pricing source label.
    const pricingSource = input.pricingSource
      || snapshot.pricing_source
      || (estResult.cost !== null ? 'estimated' : null);

    // Upstream provider: prefer explicit value from caller, fall back to override.
    const upstreamProviderSlug = input.upstreamProviderSlug ?? snapshot.upstream_provider_slug;

    db.prepare(`
      INSERT INTO user_token_usage (
        user_id, chat_id, message_id, route, model_id, model_name, provider_name,
        prompt_tokens, completion_tokens, cache_hit_tokens, cache_miss_tokens,
        reasoning_tokens, total_tokens, charged_tokens, aborted, created_at,
        upstream_provider_slug,
        input_price_per_million, output_price_per_million, cache_read_price_per_million,
        estimated_cost_usd, actual_cost_usd, pricing_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.userId,
      input.chatId ?? null,
      input.messageId ?? null,
      input.route ?? null,
      input.modelId ?? null,
      input.modelName ?? null,
      input.providerName ?? null,
      Math.max(0, Math.floor(input.promptTokens || 0)),
      Math.max(0, Math.floor(input.completionTokens || 0)),
      Math.max(0, Math.floor(input.cacheHitTokens || 0)),
      Math.max(0, Math.floor(input.cacheMissTokens || 0)),
      Math.max(0, Math.floor(input.reasoningTokens || 0)),
      Math.max(0, Math.floor(input.totalTokens || 0)),
      charged,
      input.aborted ? 1 : 0,
      now,
      upstreamProviderSlug,
      snapshot.input_price_per_million,
      snapshot.output_price_per_million,
      snapshot.cache_read_price_per_million,
      estResult.cost,
      typeof input.actualCostUsd === 'number' && Number.isFinite(input.actualCostUsd) ? input.actualCostUsd : null,
      pricingSource
    );

    // Free models (coefficient = 0) do not consume weekly quota.
    if (!isFree && charged > 0) {
      db.prepare(`UPDATE users SET weekly_tokens_used = weekly_tokens_used + ? WHERE id = ?`)
        .run(charged, input.userId);
    }

    return { charged, coefficient, isFree };
  } catch (err) {
    console.warn('[token-quota] chargeTokens failed:', err);
    return { charged: 0, coefficient: 1, isFree: false };
  }
};
