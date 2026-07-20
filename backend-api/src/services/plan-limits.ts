import { db } from '../db.js';
import type { UserPlan } from '../types.js';

export type PlanLimits = {
  daily_web_search_limit: number;
  daily_image_gen_limit: number;
  image_attachments_allowed: boolean;
  max_context_tokens: number;
  /** Weekly quota in conditional units. 0 means no quota (only flag-based limits apply). */
  weekly_token_quota: number;
};

export const DEFAULT_USER_PLAN: UserPlan = 'free';

export const PLAN_IDS: UserPlan[] = ['free', 'standart', 'pro'];

/**
 * Code-level defaults. Used ONLY to seed plan_limits_config on first run
 * (and as a defensive fallback if a DB row is corrupt). Once seeded, the
 * admin-editable DB values are the source of truth.
 */
export const DEFAULT_PLAN_LIMITS: Record<UserPlan, PlanLimits> = {
  free: {
    daily_web_search_limit: 0,
    daily_image_gen_limit: 0,
    image_attachments_allowed: false,
    max_context_tokens: 30_000,
    weekly_token_quota: 5_000_000,
  },
  standart: {
    daily_web_search_limit: 5,
    daily_image_gen_limit: 2,
    image_attachments_allowed: true,
    max_context_tokens: 60_000,
    weekly_token_quota: 15_000_000,
  },
  pro: {
    daily_web_search_limit: 20,
    daily_image_gen_limit: 5,
    image_attachments_allowed: true,
    max_context_tokens: 1_000_000,
    weekly_token_quota: 30_000_000,
  },
};

export const MAX_IMAGES_PER_REQUEST = 10;

const sanitizeConfig = (raw: unknown, plan: UserPlan): PlanLimits => {
  const fallback = DEFAULT_PLAN_LIMITS[plan];
  if (!raw || typeof raw !== 'object') return { ...fallback };
  const cfg = raw as Partial<PlanLimits>;
  const num = (value: unknown, def: number): number => {
    const n = typeof value === 'string' ? Number(value) : value;
    return Number.isFinite(n) && (n as number) >= 0 ? Math.floor(n as number) : def;
  };
  const real = (value: unknown, def: number): number => {
    const n = typeof value === 'string' ? Number(value) : value;
    return Number.isFinite(n) && (n as number) >= 0 ? (n as number) : def;
  };
  return {
    daily_web_search_limit: num(cfg.daily_web_search_limit, fallback.daily_web_search_limit),
    daily_image_gen_limit: num(cfg.daily_image_gen_limit, fallback.daily_image_gen_limit),
    image_attachments_allowed: Boolean(cfg.image_attachments_allowed ?? fallback.image_attachments_allowed),
    max_context_tokens: num(cfg.max_context_tokens, fallback.max_context_tokens),
    weekly_token_quota: real(cfg.weekly_token_quota, fallback.weekly_token_quota),
  };
};

/**
 * Reads all plan limits from plan_limits_config.
 * Missing rows / fields fall back to code defaults (so the system remains
 * functional even if the DB is in an inconsistent state).
 */
export const loadPlanLimitsFromDb = (): Record<UserPlan, PlanLimits> => {
  const rows = db.prepare('SELECT plan, config_json FROM plan_limits_config').all() as Array<{ plan: string; config_json: string }>;
  const byPlan = new Map<string, string>();
  for (const row of rows) byPlan.set(row.plan, row.config_json);
  const result = {} as Record<UserPlan, PlanLimits>;
  for (const plan of PLAN_IDS) {
    const json = byPlan.get(plan);
    if (!json) {
      result[plan] = { ...DEFAULT_PLAN_LIMITS[plan] };
      continue;
    }
    try {
      result[plan] = sanitizeConfig(JSON.parse(json), plan);
    } catch {
      result[plan] = { ...DEFAULT_PLAN_LIMITS[plan] };
    }
  }
  return result;
};

export const savePlanLimitsToDb = (limits: Record<UserPlan, PlanLimits>): void => {
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO plan_limits_config (plan, config_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(plan) DO UPDATE SET
      config_json = excluded.config_json,
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction((entries: Array<[UserPlan, PlanLimits]>) => {
    for (const [plan, cfg] of entries) {
      stmt.run(plan, JSON.stringify(cfg), now);
    }
  });
  tx(Object.entries(limits));
};

/** Seed plan_limits_config with defaults if empty. Called once at server startup. */
export const seedPlanLimitsIfEmpty = (): void => {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM plan_limits_config').get() as { cnt: number };
  if (row.cnt > 0) return;
  savePlanLimitsToDb(DEFAULT_PLAN_LIMITS);
};

/** Convenience: get limits for a single plan (reads from DB each call). */
export const getPlanLimits = (plan: string | null | undefined): PlanLimits => {
  const all = loadPlanLimitsFromDb();
  return all[(plan as UserPlan)] ?? all[DEFAULT_USER_PLAN];
};

/** Convenience: get limits for the default plan (free). */
export const getDefaultUserPlanLimits = (): PlanLimits =>
  loadPlanLimitsFromDb()[DEFAULT_USER_PLAN];

export const areImageAttachmentsAllowedForPlan = (plan: string | null | undefined, isAdmin = false): boolean =>
  isAdmin || getPlanLimits(plan).image_attachments_allowed;
