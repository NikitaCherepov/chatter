import { db } from '../db.js';
import type { UserPlan } from '../types.js';
import { getPlanLimits } from './plan-limits.js';

export type PlanDuration = 'day' | 'week' | 'month' | 'year' | 'forever';
export type QuotaKind = 'web_search' | 'web_reader' | 'image_gen';
export type AccessKind = 'free' | 'subscription' | 'trial' | 'grant';

type SubscriptionRow = {
  id: number;
  user_id: number;
  plan: UserPlan;
  started_at: string;
  ends_at: string | null;
  access_kind: AccessKind;
  billing_interval: 'month' | 'year' | null;
  quota_anchor_at: number;
};

export type QuotaPeriod = {
  id: number;
  subscription_id: number;
  user_id: number;
  plan: UserPlan;
  sequence: number;
  starts_at: number;
  ends_at: number;
  web_search_used: number;
  web_search_limit: number;
  web_reader_used: number;
  web_reader_limit: number;
  image_gen_used: number;
  image_gen_limit: number;
  is_current: number;
};

const MONTH_SECONDS = 30 * 24 * 60 * 60;
const nowEpoch = () => Math.floor(Date.now() / 1000);
const normalizeEpoch = (value: unknown) => {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};
const parseSqlDate = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
};
const sqlDate = (epoch: number | null) => epoch ? new Date(epoch * 1000).toISOString() : null;

/** Calendar-month boundary anchored to the original access start (Jan 31 -> Feb 28 -> Mar 31). */
const addUtcMonthsAnchored = (anchorEpoch: number, months: number): number => {
  const anchor = new Date(anchorEpoch * 1000);
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth();
  const day = anchor.getUTCDate();
  const targetFirst = new Date(Date.UTC(year, month + months, 1, anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds()));
  const lastDay = new Date(Date.UTC(targetFirst.getUTCFullYear(), targetFirst.getUTCMonth() + 1, 0)).getUTCDate();
  targetFirst.setUTCDate(Math.min(day, lastDay));
  return Math.floor(targetFirst.getTime() / 1000);
};

const durationEnd = (start: number, duration: PlanDuration): number | null => {
  if (duration === 'forever') return null;
  if (duration === 'day') return start + 24 * 60 * 60;
  if (duration === 'week') return start + 7 * 24 * 60 * 60;
  if (duration === 'month') return addUtcMonthsAnchored(start, 1);
  return addUtcMonthsAnchored(start, 12);
};

const limitsFor = (plan: UserPlan, startsAt: number, endsAt: number, prorated: boolean) => {
  const limits = getPlanLimits(plan);
  const factor = prorated ? Math.max(0, endsAt - startsAt) / MONTH_SECONDS : 1;
  const scale = (value: number) => value <= 0 ? 0 : Math.max(1, Math.ceil(value * factor));
  return {
    webSearch: scale(limits.monthly_web_search_limit),
    webReader: scale(limits.monthly_web_reader_limit),
    imageGen: scale(limits.monthly_image_gen_limit),
  };
};

/**
 * Context size policy on plan change / plan-limits sync. Keeps the user's
 * choice inside the [50%, 100%] band of the new plan max:
 * - never customized (0/NULL) → the new max
 * - above the new max → clamp down to the new max
 * - below 50% of the new max → raise to 50% of the new max
 * - otherwise the stored choice survives untouched.
 */
export const clampContextTokensOnPlanChange = (current: number | null | undefined, newMax: number): number => {
  const max = Math.max(1000, Math.floor(newMax));
  const currentChoice = Number.isFinite(current as number) && (current as number) > 0
    ? Math.floor(current as number)
    : 0;
  if (currentChoice === 0) return max;
  if (currentChoice > max) return max;
  const floor = Math.max(1000, Math.floor(max / 2));
  if (currentChoice < floor) return floor;
  return currentChoice;
};

/** Updates plan-derived entitlements without touching usage or period dates. */
export const applyUserPlanEntitlements = (userId: number, plan: UserPlan) => {
  const limits = getPlanLimits(plan);
  const weeklyCostLimit = limits.budget_usd > 0 ? limits.budget_usd / 4 : 0;
  const row = db.prepare('SELECT max_context_tokens FROM users WHERE id = ?').get(userId) as
    | { max_context_tokens: number }
    | undefined;
  const nextContextTokens = clampContextTokensOnPlanChange(row?.max_context_tokens, limits.max_context_tokens);
  return db.prepare(`
    UPDATE users SET plan = ?, max_context_tokens_limit = ?, max_context_tokens = ?,
      weekly_tokens_quota = ?, weekly_cost_quota_limit = ?, weekly_cost_quota = ?
    WHERE id = ?
  `).run(plan, limits.max_context_tokens, nextContextTokens,
    limits.weekly_token_quota, weeklyCostLimit, weeklyCostLimit, userId);
};

const currentSubscription = (userId: number) => db.prepare(`
  SELECT id, user_id, plan, started_at, ends_at, access_kind, billing_interval, quota_anchor_at
  FROM user_plan_subscriptions WHERE user_id = ? AND is_current = 1
  ORDER BY id DESC LIMIT 1
`).get(userId) as SubscriptionRow | undefined;

const currentPeriod = (userId: number) => db.prepare(`
  SELECT * FROM user_plan_quota_periods WHERE user_id = ? AND is_current = 1
  ORDER BY id DESC LIMIT 1
`).get(userId) as QuotaPeriod | undefined;

const createPeriod = (
  subscription: SubscriptionRow,
  sequence: number,
  startsAt: number,
  carry?: Partial<Pick<QuotaPeriod, 'web_search_used' | 'web_reader_used' | 'image_gen_used'>>,
  limitsOverride?: Partial<Pick<QuotaPeriod, 'web_search_limit' | 'web_reader_limit' | 'image_gen_limit'>>,
) => {
  const accessEnd = parseSqlDate(subscription.ends_at);
  const naturalEnd = subscription.access_kind === 'trial'
    ? (accessEnd ?? startsAt + MONTH_SECONDS)
    : addUtcMonthsAnchored(normalizeEpoch(subscription.quota_anchor_at) || startsAt, sequence + 1);
  const endsAt = Math.max(startsAt + 1, accessEnd ? Math.min(naturalEnd, accessEnd) : naturalEnd);
  const quota = limitsFor(subscription.plan, startsAt, endsAt, subscription.access_kind === 'trial');
  db.prepare('UPDATE user_plan_quota_periods SET is_current = 0 WHERE user_id = ? AND is_current = 1').run(subscription.user_id);
  const inserted = db.prepare(`
    INSERT INTO user_plan_quota_periods (
      subscription_id, user_id, plan, sequence, starts_at, ends_at,
      web_search_used, web_search_limit, web_reader_used, web_reader_limit,
      image_gen_used, image_gen_limit, is_current
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(subscription.id, subscription.user_id, subscription.plan, sequence, startsAt, endsAt,
    Math.max(0, carry?.web_search_used ?? 0), Math.max(0, limitsOverride?.web_search_limit ?? quota.webSearch),
    Math.max(0, carry?.web_reader_used ?? 0), Math.max(0, limitsOverride?.web_reader_limit ?? quota.webReader),
    Math.max(0, carry?.image_gen_used ?? 0), Math.max(0, limitsOverride?.image_gen_limit ?? quota.imageGen));
  return db.prepare('SELECT * FROM user_plan_quota_periods WHERE id = ?').get(inserted.lastInsertRowid) as QuotaPeriod;
};

const insertSubscription = (userId: number, plan: UserPlan, accessKind: AccessKind, billingInterval: 'month' | 'year' | null, startsAt: number, endsAt: number | null, assignedBy: number | null) => {
  db.prepare('UPDATE user_plan_subscriptions SET is_current = 0 WHERE user_id = ? AND is_current = 1').run(userId);
  const result = db.prepare(`
    INSERT INTO user_plan_subscriptions (
      user_id, plan, started_at, ends_at, is_current, assigned_by,
      access_kind, billing_interval, quota_anchor_at, auto_renew, cancel_at_period_end
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 0, 0)
  `).run(userId, plan, sqlDate(startsAt), sqlDate(endsAt), assignedBy, accessKind, billingInterval, startsAt);
  return currentSubscription(userId) ?? { id: Number(result.lastInsertRowid), user_id: userId, plan, started_at: sqlDate(startsAt)!, ends_at: sqlDate(endsAt), access_kind: accessKind, billing_interval: billingInterval, quota_anchor_at: startsAt };
};

const extendAccessEnd = (subscription: SubscriptionRow, duration: 'month' | 'year', currentEnd: number) => {
  const anchor = parseSqlDate(subscription.started_at) ?? (normalizeEpoch(subscription.quota_anchor_at) || currentEnd);
  const step = duration === 'year' ? 12 : 1;
  let multiple = step;
  let candidate = addUtcMonthsAnchored(anchor, multiple);
  while (candidate <= currentEnd) {
    multiple += step;
    candidate = addUtcMonthsAnchored(anchor, multiple);
  }
  return candidate;
};

const inferDuration = (endsAt: string | null | undefined, now: number): PlanDuration => {
  const end = parseSqlDate(endsAt);
  if (!end) return 'forever';
  const days = (end - now) / 86400;
  if (days <= 2) return 'day';
  if (days <= 10) return 'week';
  if (days <= 62) return 'month';
  return 'year';
};

export const assignUserPlan = (options: {
  userId: number;
  plan: UserPlan;
  duration?: PlanDuration;
  endsAt?: string | null;
  assignedBy?: number | null;
  now?: number;
}) => db.transaction(() => {
  const now = options.now ?? nowEpoch();
  const requestedDuration = options.duration ?? inferDuration(options.endsAt, now);
  const duration: PlanDuration = options.plan === 'free' ? 'forever' : requestedDuration;
  const existing = currentSubscription(options.userId);
  const existingPeriod = currentPeriod(options.userId);

  // Buying more of the same normal subscription extends access. The current
  // monthly quota period is deliberately untouched, preventing renewal resets.
  if (existing && existing.plan === options.plan && existing.access_kind === 'subscription'
      && (duration === 'month' || duration === 'year') && (parseSqlDate(existing.ends_at) ?? 0) > now) {
    const base = Math.max(now, parseSqlDate(existing.ends_at) ?? now);
    const extendedEnd = extendAccessEnd(existing, duration, base);
    db.prepare(`UPDATE user_plan_subscriptions SET ends_at = ?, billing_interval = ? WHERE id = ?`)
      .run(sqlDate(extendedEnd), duration, existing.id);
    ensureUserMonthlyUsageWindow(options.userId, now);
    return { subscription: currentSubscription(options.userId)!, period: currentPeriod(options.userId)!, renewed: true };
  }

  const accessKind: AccessKind = options.plan === 'free' ? 'free'
    : duration === 'day' || duration === 'week' ? 'trial'
      : duration === 'forever' ? 'grant' : 'subscription';
  const billingInterval = duration === 'month' || duration === 'year' ? duration : null;
  const endsAt = durationEnd(now, duration);
  const carry = existing && existing.plan !== 'free' && options.plan !== 'free' && existingPeriod
    ? existingPeriod : undefined;

  db.prepare('UPDATE user_plan_quota_periods SET is_current = 0 WHERE user_id = ? AND is_current = 1').run(options.userId);
  const subscription = insertSubscription(options.userId, options.plan, accessKind, billingInterval, now, endsAt, options.assignedBy ?? null);
  applyUserPlanEntitlements(options.userId, options.plan);
  const period = createPeriod(subscription, 0, now, carry);
  return { subscription, period, renewed: false };
})();

const ensureSubscription = (userId: number, now: number) => {
  let subscription = currentSubscription(userId);
  if (subscription) return subscription;
  const user = db.prepare('SELECT plan FROM users WHERE id = ?').get(userId) as { plan: UserPlan } | undefined;
  if (!user) return null;
  const plan = ['free', 'standart', 'pro'].includes(user.plan) ? user.plan : 'free';
  subscription = insertSubscription(userId, plan, plan === 'free' ? 'free' : 'grant', null, now, null, null);
  return subscription;
};

export const ensureUserMonthlyUsageWindow = (userId: number, now = nowEpoch()) => db.transaction(() => {
  let subscription = ensureSubscription(userId, now);
  if (!subscription) return null;
  const subscriptionEnd = parseSqlDate(subscription.ends_at);
  if (subscriptionEnd && now >= subscriptionEnd) {
    return assignUserPlan({ userId, plan: 'free', duration: 'forever', now }).period;
  }

  // Legacy monthly_* columns in users are intentionally NOT consulted here:
  // the one-time schema migration owns the legacy -> quota-periods transfer.
  let period = currentPeriod(userId);
  if (!period || period.subscription_id !== subscription.id) {
    period = createPeriod(subscription, 0, now);
  }

  while (now >= period.ends_at) {
    subscription = currentSubscription(userId)!;
    const accessEnd = parseSqlDate(subscription.ends_at);
    if (accessEnd && now >= accessEnd) {
      return assignUserPlan({ userId, plan: 'free', duration: 'forever', now }).period;
    }
    period = createPeriod(subscription, period.sequence + 1, period.ends_at);
  }
  return period;
})();

export const getUserQuotaPeriod = (userId: number, now = nowEpoch()) => ensureUserMonthlyUsageWindow(userId, now);

export const getUserQuota = (userId: number, kind: QuotaKind) => {
  const period = ensureUserMonthlyUsageWindow(userId);
  if (!period) return null;
  const used = period[`${kind}_used` as keyof QuotaPeriod] as number;
  const limit = period[`${kind}_limit` as keyof QuotaPeriod] as number;
  return { used, limit, allowed: limit > 0 && used < limit, resetsAt: period.ends_at };
};

export const consumeUserQuota = (userId: number, kind: QuotaKind, count = 1) => db.transaction(() => {
  const safeCount = Math.max(0, Math.floor(count));
  if (!safeCount) return;
  const period = ensureUserMonthlyUsageWindow(userId);
  if (!period) return;
  const periodColumn = `${kind}_used`;
  const totalColumn = `total_${kind}_count`;
  db.prepare(`UPDATE user_plan_quota_periods SET ${periodColumn} = ${periodColumn} + ? WHERE id = ?`).run(safeCount, period.id);
  // Lifetime statistics stay in users; the running period counters live only
  // in user_plan_quota_periods — legacy monthly_* columns are never updated.
  db.prepare(`UPDATE users SET ${totalColumn} = ${totalColumn} + ? WHERE id = ?`)
    .run(safeCount, userId);
})();

export const refreshCurrentQuotaLimits = () => {
  db.transaction(() => {
    const periods = db.prepare(`
      SELECT p.*, s.access_kind FROM user_plan_quota_periods p
      JOIN user_plan_subscriptions s ON s.id = p.subscription_id
      WHERE p.is_current = 1
    `).all() as Array<QuotaPeriod & { access_kind: AccessKind }>;
    for (const period of periods) {
      const quota = limitsFor(period.plan, period.starts_at, period.ends_at, period.access_kind === 'trial');
      db.prepare(`UPDATE user_plan_quota_periods SET web_search_limit = ?, web_reader_limit = ?, image_gen_limit = ? WHERE id = ?`)
        .run(quota.webSearch, quota.webReader, quota.imageGen, period.id);
    }
  })();
};

export const resetExpiredMonthlyUsageWindows = () => {
  const users = db.prepare('SELECT id FROM users').all() as Array<{ id: number }>;
  let changed = 0;
  const now = nowEpoch();
  for (const user of users) {
    const before = currentPeriod(user.id)?.id;
    const after = ensureUserMonthlyUsageWindow(user.id, now)?.id;
    if (before !== after) changed += 1;
  }
  return changed;
};

const usersTableHasColumn = (column: string) => {
  const columns = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  return columns.some(item => item.name === column);
};

/**
 * One-time schema migration body: transfer the exact legacy users.monthly_*
 * state (window start, used counters, configured limits) into quota periods.
 *
 * - Users that already have an active period created by the runtime are kept
 *   exactly as-is (nothing is overwritten).
 * - Expired subscriptions are downgraded through the regular service flow.
 * - Must run inside a single transaction owned by the migration runner.
 */
export const migrateLegacyQuotaPeriods = () => {
  const now = nowEpoch();
  if (!usersTableHasColumn('monthly_usage_window_started_at')) {
    // Fresh install — nothing to transfer.
    if (!usersTableHasColumn('daily_web_search_count')) return;
    // Daily-era upgrade: recreate the full legacy schema first (ancient DBs may
    // carry only a subset of the daily columns).
    const dailyDefs: Array<[string, string]> = [
      ['daily_web_search_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['daily_web_search_limit', 'INTEGER NOT NULL DEFAULT 0'],
      ['daily_web_reader_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['daily_web_reader_limit', 'INTEGER NOT NULL DEFAULT 0'],
      ['daily_image_gen_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['daily_image_gen_limit', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [name, def] of dailyDefs) {
      if (!usersTableHasColumn(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${def}`);
    }
    const columnDefs: Array<[string, string]> = [
      ['monthly_usage_window_started_at', 'INTEGER NOT NULL DEFAULT 0'],
      ['monthly_web_search_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['monthly_web_search_limit', 'INTEGER NOT NULL DEFAULT 0'],
      ['monthly_web_reader_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['monthly_web_reader_limit', 'INTEGER NOT NULL DEFAULT 0'],
      ['monthly_image_gen_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['monthly_image_gen_limit', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [name, def] of columnDefs) {
      if (!usersTableHasColumn(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${def}`);
    }
    db.exec(`
      UPDATE users
      SET monthly_usage_window_started_at = unixepoch(),
          monthly_web_search_count = MAX(0, COALESCE(daily_web_search_count, 0)),
          monthly_web_search_limit = MAX(0, COALESCE(daily_web_search_limit, 0)),
          monthly_web_reader_count = MAX(0, COALESCE(daily_web_reader_count, 0)),
          monthly_web_reader_limit = MAX(0, COALESCE(daily_web_reader_limit, 0)),
          monthly_image_gen_count = MAX(0, COALESCE(daily_image_gen_count, 0)),
          monthly_image_gen_limit = MAX(0, COALESCE(daily_image_gen_limit, 0))
    `);
  }
  const users = db.prepare(`
    SELECT id, monthly_usage_window_started_at,
      monthly_web_search_count, monthly_web_search_limit,
      monthly_web_reader_count, monthly_web_reader_limit,
      monthly_image_gen_count, monthly_image_gen_limit
    FROM users
  `).all() as Array<{
    id: number;
    monthly_usage_window_started_at: number;
    monthly_web_search_count: number;
    monthly_web_search_limit: number;
    monthly_web_reader_count: number;
    monthly_web_reader_limit: number;
    monthly_image_gen_count: number;
    monthly_image_gen_limit: number;
  }>;
  for (const user of users) {
    if (currentPeriod(user.id)) continue;
    const subscription = ensureSubscription(user.id, now);
    if (!subscription) continue;

    const subscriptionEnd = parseSqlDate(subscription.ends_at);
    if (subscriptionEnd && now >= subscriptionEnd) {
      // Expired access: let the service downgrade to free with a fresh period.
      ensureUserMonthlyUsageWindow(user.id, now);
      continue;
    }

    const startedAt = Math.min(normalizeEpoch(user.monthly_usage_window_started_at) || now, now);
    createPeriod(subscription, 0, startedAt, {
      web_search_used: Math.max(0, Number(user.monthly_web_search_count) || 0),
      web_reader_used: Math.max(0, Number(user.monthly_web_reader_count) || 0),
      image_gen_used: Math.max(0, Number(user.monthly_image_gen_count) || 0),
    }, {
      web_search_limit: Math.max(0, Number(user.monthly_web_search_limit) || 0),
      web_reader_limit: Math.max(0, Number(user.monthly_web_reader_limit) || 0),
      image_gen_limit: Math.max(0, Number(user.monthly_image_gen_limit) || 0),
    });
    // Roll forward in case the transferred window had already expired by now.
    ensureUserMonthlyUsageWindow(user.id, now);
  }
};
