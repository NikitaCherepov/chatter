import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-account-merge-quota-'));
process.env.API_DB_PATH = path.join(tempDir, 'test.db');

const { db } = await import('../src/db.js');
const { seedPlanLimitsIfEmpty } = await import('../src/services/plan-limits.js');
const { assignUserPlan, consumeUserQuota, getUserQuotaPeriod } = await import('../src/services/monthly-usage.js');
const { mergeAccounts } = await import('../src/services/accounts.js');

seedPlanLimitsIfEmpty();
db.prepare(`INSERT INTO users (id, name, plan, status) VALUES (1, 'TG account', 'free', 'approved')`).run();
db.prepare(`INSERT INTO users (id, name, plan, status) VALUES (2, 'Desktop account', 'free', 'approved')`).run();

assignUserPlan({ userId: 1, plan: 'standart', duration: 'month' });
assignUserPlan({ userId: 2, plan: 'standart', duration: 'month' });
consumeUserQuota(1, 'web_search', 3);
consumeUserQuota(2, 'web_search', 1);
consumeUserQuota(1, 'image_gen', 2);

const merged = mergeAccounts(1, 2, 'link');
assert.equal(merged, 2);

// The source account is gone; its subscription/periods were relocated to the
// survivor as is_current = 0 history by the ownership move.
assert.equal((db.prepare(`SELECT COUNT(*) AS c FROM users WHERE id = 1`).get() as any).c, 0);
assert.equal((db.prepare(`SELECT COUNT(*) AS c FROM user_plan_quota_periods WHERE user_id = 1`).get() as any).c, 0);
assert.equal((db.prepare(`SELECT COUNT(*) AS c FROM user_plan_subscriptions WHERE user_id = 1`).get() as any).c, 0);

// The source's in-period usage carried into the survivor's current period
// (regression: usage used to be silently dropped on merge, allowing a quota
// reset by burning limits on a secondary account and then linking it).
const period = getUserQuotaPeriod(2)!;
assert.equal(period.web_search_used, 4, 'merge must sum in-period web_search usage');
assert.equal(period.image_gen_used, 2, 'merge must sum in-period image_gen usage');
assert.equal(period.web_reader_used, 0);

// Exactly one current period remains on the survivor; the moved rows are history.
assert.equal((db.prepare(`SELECT COUNT(*) AS c FROM user_plan_quota_periods WHERE user_id = 2 AND is_current = 1`).get() as any).c, 1);
assert.ok((db.prepare(`SELECT COUNT(*) AS c FROM user_plan_quota_periods WHERE user_id = 2 AND is_current = 0`).get() as any).c >= 1, 'source periods must survive as history');

db.close();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('account merge quota carry: ok');
