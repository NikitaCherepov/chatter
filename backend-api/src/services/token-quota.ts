import { db } from '../db.js';
import { getNowUnix } from '../db.js';
import type { BillingMode } from './plan-limits.js';

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
  selected_api_key_id: number | null;
  is_free: number; // INTEGER 0/1
  /** Admin-set display tier 1..3 (NULL = not set). */
  intel_tier: number | null;
  /** Admin-set display tier 1..3 (NULL = not set). */
  price_tier: number | null;
  /** Maximum total context accepted by this model/provider endpoint. */
  context_length: number | null;
  /** Locally measured generation speed, EMA (tokens/sec). */
  avg_tps: number | null;
  tps_samples: number | null;
  tps_updated_at: number | null;
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
           cache_read_price_per_million, pricing_source, pricing_updated_at,
           selected_api_key_id, is_free,
           intel_tier, price_tier, context_length, avg_tps, tps_samples, tps_updated_at
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

/** Returns true if model is explicitly marked as free via is_free flag. */
export const isModelFree = (modelId: string | null | undefined): boolean => {
  if (!modelId) return false;
  const override = getModelOverride(modelId);
  if (!override) return false;
  return override.is_free === 1;
};

/** Calculates quota units without writing anything to the database. */
export const calculateChargedTokens = (
  totalTokens: number,
  modelId: string | null | undefined,
): { charged: number; coefficient: number; isFree: boolean } => {
  const coefficient = getCoefficient(modelId);
  const isFree = isModelFree(modelId);
  return {
    charged: Math.max(0, Math.round(Math.max(0, totalTokens || 0) * coefficient * 1000) / 1000),
    coefficient,
    isFree,
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
    selectedApiKeyId?: number | null;
    isFree?: boolean | null;
    /** Admin-set display tier 1..3; null = unset. */
    intelTier?: number | null;
    /** Admin-set display tier 1..3; null = unset. */
    priceTier?: number | null;
    /** Maximum total context accepted by this model/provider endpoint. */
    contextLength?: number | null;
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
  const selectedApiKeyId = params.selectedApiKeyId !== undefined ? params.selectedApiKeyId : existing?.selected_api_key_id ?? null;
  const isFree = params.isFree !== undefined && params.isFree !== null
    ? (params.isFree ? 1 : 0)
    : existing?.is_free ?? 0;
  const validTier = (v: unknown): number | null =>
    (v === 1 || v === 2 || v === 3) ? v : null;
  const intelTier = params.intelTier !== undefined ? validTier(params.intelTier) : existing?.intel_tier ?? null;
  const priceTier = params.priceTier !== undefined ? validTier(params.priceTier) : existing?.price_tier ?? null;
  const contextLength = params.contextLength !== undefined
    ? (Number.isFinite(params.contextLength) && (params.contextLength ?? 0) >= 1000
      ? Math.floor(params.contextLength as number)
      : null)
    : existing?.context_length ?? null;

  db.prepare(`
    INSERT INTO model_overrides (
      model_id, coefficient, updated_at,
      provider_kind, openrouter_provider_slug, pricing_mode,
      input_price_per_million, output_price_per_million,
      cache_read_price_per_million, pricing_source, pricing_updated_at,
      selected_api_key_id, is_free, intel_tier, price_tier, context_length
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      pricing_updated_at = excluded.pricing_updated_at,
      selected_api_key_id = excluded.selected_api_key_id,
      is_free = excluded.is_free,
      intel_tier = excluded.intel_tier,
      price_tier = excluded.price_tier,
      context_length = excluded.context_length
  `).run(
    modelId, coeff, now,
    providerKind,
    openrouterProviderSlug,
    pricingMode,
    typeof inputPrice === 'number' && Number.isFinite(inputPrice) ? inputPrice : null,
    typeof outputPrice === 'number' && Number.isFinite(outputPrice) ? outputPrice : null,
    typeof cacheReadPrice === 'number' && Number.isFinite(cacheReadPrice) ? cacheReadPrice : null,
    pricingSource,
    pricingSource ? now : null,
    selectedApiKeyId,
    isFree,
    intelTier,
    priceTier,
    contextLength
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
  weekly_cost_used: number;
  weekly_cost_quota: number;
};

const getUserQuotaState = (userId: number): QuotaState | null => {
  const row = db.prepare(`
    SELECT weekly_tokens_used, weekly_tokens_quota, weekly_window_started_at,
           weekly_cost_used, weekly_cost_quota
    FROM users WHERE id = ?
  `).get(userId) as QuotaState | undefined;
  return row ?? null;
};

/**
 * Lazy-reset of the weekly window. If window_started_at + 7d <= now,
 * rolls window forward by N×7d (N >= 1) and zeroes BOTH weekly_tokens_used
 * and weekly_cost_used. Returns the resulting (post-reset) quota state.
 */
export const advanceWeeklyWindowIfNeeded = (userId: number, now = getNowUnix()): QuotaState | null => {
  const state = getUserQuotaState(userId);
  if (!state) return null;
  if (state.weekly_window_started_at === 0) {
    // First ever request — start the window now, keep used = 0.
    db.prepare(`
      UPDATE users SET weekly_window_started_at = ?, weekly_tokens_used = 0, weekly_cost_used = 0 WHERE id = ?
    `).run(now, userId);
    return { ...state, weekly_window_started_at: now, weekly_tokens_used: 0, weekly_cost_used: 0 };
  }
  const elapsed = now - state.weekly_window_started_at;
  if (elapsed < WEEK_SECONDS) return state;
  const weeksPassed = Math.floor(elapsed / WEEK_SECONDS);
  const newWindowStart = state.weekly_window_started_at + weeksPassed * WEEK_SECONDS;
  db.prepare(`
    UPDATE users SET weekly_window_started_at = ?, weekly_tokens_used = 0, weekly_cost_used = 0 WHERE id = ?
  `).run(newWindowStart, userId);
  return { ...state, weekly_window_started_at: newWindowStart, weekly_tokens_used: 0, weekly_cost_used: 0 };
};

export type QuotaCheckResult =
  | { ok: true; used: number; quota: number; windowStartedAt: number; billingMode: BillingMode }
  | { ok: false; error: 'quota_exceeded'; used: number; quota: number; windowStartedAt: number; resetsAt: number; billingMode: BillingMode };

// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
export type QuotaExceededResult = Extract<QuotaCheckResult, { error: 'quota_exceeded' }>;

/**
 * Checks if the user may start a new AI request. Admins always pass.
 * Lazily advances the weekly window. Does NOT charge.
 *
 * Branches on user's plan billing_mode:
 *   - 'tokens': compare weekly_tokens_used vs weekly_tokens_quota
 *   - 'budget': compare weekly_cost_used vs weekly_cost_quota
 */
export const checkQuota = (userId: number, isAdmin: boolean, billingMode: BillingMode = 'tokens'): QuotaCheckResult => {
  const state = advanceWeeklyWindowIfNeeded(userId);
  if (!state) {
    return { ok: true, used: 0, quota: 0, windowStartedAt: 0, billingMode };
  }

  if (billingMode === 'budget') {
    // Admin bypasses; quota <= 0 means "no quota configured" → block.
    if (isAdmin) {
      return { ok: true, used: state.weekly_cost_used, quota: state.weekly_cost_quota, windowStartedAt: state.weekly_window_started_at, billingMode };
    }
    if (state.weekly_cost_quota <= 0 || state.weekly_cost_used >= state.weekly_cost_quota) {
      return { ok: false, error: 'quota_exceeded', used: state.weekly_cost_used, quota: state.weekly_cost_quota, windowStartedAt: state.weekly_window_started_at, resetsAt: state.weekly_window_started_at + WEEK_SECONDS, billingMode };
    }
    return { ok: true, used: state.weekly_cost_used, quota: state.weekly_cost_quota, windowStartedAt: state.weekly_window_started_at, billingMode };
  }

  // 'tokens' mode (legacy)
  if (isAdmin) {
    return {
      ok: true,
      used: state.weekly_tokens_used,
      quota: state.weekly_tokens_quota,
      windowStartedAt: state.weekly_window_started_at,
      billingMode,
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
      billingMode,
    };
  }
  return {
    ok: true,
    used: state.weekly_tokens_used,
    quota: state.weekly_tokens_quota,
    windowStartedAt: state.weekly_window_started_at,
    billingMode,
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

export type ChargeTokensResult = {
  charged: number;
  coefficient: number;
  isFree: boolean;
  costUsd: number;
};

/**
 * Writes a row to user_token_usage and increments weekly_tokens_used +
 * weekly_cost_used. coefficient is looked up from model_overrides by modelId
 * (default 1.0). If coefficient = 0, charged_tokens = 0 (free model, does not
 * consume quota).
 *
 * weekly_cost_used is incremented by COALESCE(actualCostUsd, estimatedCostUsd, 0)
 * regardless of billing_mode — this way switching modes between tokens/budget
 * keeps both counters in sync.
 *
 * This function MUST be safe to call in finally / catch blocks — never throws.
 */
export const chargeTokens = (input: ChargeInput): ChargeTokensResult => {
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

    // Effective cost: prefer actual from API, fall back to estimated, then 0.
    const actualCost = typeof input.actualCostUsd === 'number' && Number.isFinite(input.actualCostUsd) ? input.actualCostUsd : null;
    const costUsd = actualCost ?? estResult.cost ?? 0;

    db.prepare(`
      INSERT INTO user_token_usage (
        user_id, chat_id, message_id, route, model_id, model_name, provider_name,
        prompt_tokens, completion_tokens, cache_hit_tokens, cache_miss_tokens,
        reasoning_tokens, total_tokens, charged_tokens, aborted, created_at,
        upstream_provider_slug,
        input_price_per_million, output_price_per_million, cache_read_price_per_million,
        estimated_cost_usd, actual_cost_usd, pricing_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      actualCost,
      pricingSource
    );

    // Free models (is_free=1) do not consume weekly quota nor cost budget.
    // Usage row is still written for request analytics (with NULL cost).
    if (!isFree && charged > 0) {
      db.prepare(`UPDATE users SET weekly_tokens_used = weekly_tokens_used + ? WHERE id = ?`)
        .run(charged, input.userId);
    }

    if (!isFree && costUsd > 0) {
      db.prepare(`UPDATE users SET weekly_cost_used = weekly_cost_used + ? WHERE id = ?`)
        .run(Math.max(0, Math.round(costUsd * 1e7) / 1e7), input.userId);
    }

    return { charged, coefficient, isFree, costUsd };
  } catch (err) {
    console.warn('[token-quota] chargeTokens failed:', err);
    return { charged: 0, coefficient: 1, isFree: false, costUsd: 0 };
  }
};
