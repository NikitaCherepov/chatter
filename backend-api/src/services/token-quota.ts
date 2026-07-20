import { db } from '../db.js';
import { getNowUnix } from '../db.js';

const WEEK_SECONDS = 7 * 24 * 60 * 60;

/** In-memory cache of model_id → coefficient. Refreshed on demand. */
let coefficientCache: Map<string, number> | null = null;

const readAllCoefficients = (): Map<string, number> => {
  const rows = db.prepare('SELECT model_id, coefficient FROM model_overrides').all() as Array<{ model_id: string; coefficient: number }>;
  const map = new Map<string, number>();
  for (const row of rows) {
    if (Number.isFinite(row.coefficient) && row.coefficient >= 0) {
      map.set(row.model_id, row.coefficient);
    }
  }
  return map;
};

/** Returns cached coefficient map. Loads on first call. */
export const getCoefficientMap = (): Map<string, number> => {
  if (!coefficientCache) coefficientCache = readAllCoefficients();
  return coefficientCache;
};

/** Force a re-read from DB (call after admin updates coefficients). */
export const refreshCoefficientCache = (): void => {
  coefficientCache = readAllCoefficients();
};

/** Returns coefficient for a given model_id (defaults to 1.0). */
export const getCoefficient = (modelId: string | null | undefined): number => {
  if (!modelId) return 1.0;
  const map = getCoefficientMap();
  const value = map.get(modelId);
  return value === undefined ? 1.0 : value;
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
  refreshCoefficientCache();
};

/** Remove coefficients for model_ids no longer in the catalog. */
export const pruneCoefficients = (knownModelIds: string[]): void => {
  if (knownModelIds.length === 0) {
    db.prepare('DELETE FROM model_overrides').run();
  } else {
    const placeholders = knownModelIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM model_overrides WHERE model_id NOT IN (${placeholders})`).run(...knownModelIds);
  }
  refreshCoefficientCache();
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
  /** 'manual' | 'auto-pro' | 'auto-lite' | 'auto-vision' | null */
  route?: string | null;
  /** uniqueId of the FIRST model that started answering. */
  modelId?: string | null;
  modelName?: string | null;
  providerName?: string | null;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  aborted?: boolean;
};

/**
 * Writes a row to user_token_usage and increments users.weekly_tokens_used.
 * coefficient is looked up from model_overrides by modelId (default 1.0).
 * If coefficient = 0, charged_tokens = 0 (free model, does not consume quota).
 *
 * This function MUST be safe to call in finally / catch blocks — never throws.
 */
export const chargeTokens = (input: ChargeInput): { charged: number; coefficient: number; isFree: boolean } => {
  try {
    const coefficient = getCoefficient(input.modelId);
    const charged = Math.max(0, Math.round(input.totalTokens * coefficient * 1000) / 1000);
    const isFree = coefficient === 0;
    const now = getNowUnix();

    db.prepare(`
      INSERT INTO user_token_usage (
        user_id, chat_id, message_id, route, model_id, model_name, provider_name,
        prompt_tokens, completion_tokens, cache_hit_tokens, cache_miss_tokens,
        reasoning_tokens, total_tokens, charged_tokens, aborted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      now
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
