import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-subscription-quota-'));
process.env.API_DB_PATH = path.join(tempDir, 'test.db');

const { db } = await import('../src/db.js');
const { seedPlanLimitsIfEmpty } = await import('../src/services/plan-limits.js');
const {
  assignUserPlan,
  consumeUserQuota,
  ensureUserMonthlyUsageWindow,
  getUserQuota,
} = await import('../src/services/monthly-usage.js');

const JAN_31 = Math.floor(Date.parse('2030-01-31T12:00:00.000Z') / 1000);
seedPlanLimitsIfEmpty();
db.prepare(`INSERT INTO users (id, name, plan, status) VALUES (1, 'Quota test', 'free', 'approved')`).run();

const first = assignUserPlan({ userId: 1, plan: 'standart', duration: 'month', now: JAN_31 });
consumeUserQuota(1, 'web_search', 3);
assert.equal(getUserQuota(1, 'web_search')?.used, 3);

const renewed = assignUserPlan({ userId: 1, plan: 'standart', duration: 'month', now: JAN_31 + 86400 });
assert.equal(renewed.renewed, true, 'same-plan purchase must renew the current access');
assert.equal(renewed.period.id, first.period.id, 'renewal must not replace the quota period');
assert.equal(getUserQuota(1, 'web_search')?.used, 3, 'renewal must not reset usage');
assert.ok(Date.parse(renewed.subscription.ends_at!) > Date.parse(first.subscription.ends_at!), 'renewal must extend access');

const upgraded = assignUserPlan({ userId: 1, plan: 'pro', duration: 'month', now: JAN_31 + 2 * 86400 });
assert.equal(upgraded.renewed, false);
assert.notEqual(upgraded.period.id, first.period.id);
assert.equal(upgraded.period.web_search_used, 3, 'paid plan changes must carry current usage');
assert.ok(upgraded.period.web_search_limit > first.period.web_search_limit, 'upgrade must apply the new ceiling');

assignUserPlan({ userId: 1, plan: 'free', duration: 'forever', now: JAN_31 + 3 * 86400 });
const trial = assignUserPlan({ userId: 1, plan: 'standart', duration: 'week', now: JAN_31 + 4 * 86400 });
assert.equal(trial.subscription.access_kind, 'trial');
assert.equal(trial.period.web_search_limit, 2, '7-day trial quota must be ceil(monthly * 7/30)');
assert.equal(trial.period.web_reader_limit, 2);
assert.equal(trial.period.image_gen_limit, 1);

const yearly = assignUserPlan({ userId: 1, plan: 'pro', duration: 'year', now: JAN_31 });
const secondMonth = ensureUserMonthlyUsageWindow(1, Math.floor(Date.parse('2030-02-28T12:00:01.000Z') / 1000))!;
assert.equal(secondMonth.subscription_id, yearly.subscription.id);
assert.equal(secondMonth.sequence, 1);
assert.equal(secondMonth.starts_at, Math.floor(Date.parse('2030-02-28T12:00:00.000Z') / 1000));
assert.equal(secondMonth.ends_at, Math.floor(Date.parse('2030-03-31T12:00:00.000Z') / 1000), 'monthly boundaries must retain the Jan-31 anchor');

const expired = ensureUserMonthlyUsageWindow(1, Math.floor(Date.parse('2031-02-01T00:00:00.000Z') / 1000))!;
const freeSubscription = db.prepare(`SELECT plan, access_kind FROM user_plan_subscriptions WHERE user_id = 1 AND is_current = 1`).get() as any;
assert.equal(freeSubscription.plan, 'free');
assert.equal(freeSubscription.access_kind, 'free');
assert.equal(expired.plan, 'free');

db.close();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('subscription quota scenarios: ok');
