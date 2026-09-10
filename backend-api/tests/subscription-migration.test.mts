import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-subscription-migration-'));
const dbPath = path.join(tempDir, 'legacy.db');
const legacy = new Database(dbPath);
legacy.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    plan TEXT NOT NULL DEFAULT 'free',
    monthly_usage_window_started_at INTEGER NOT NULL DEFAULT 0,
    monthly_web_search_count INTEGER NOT NULL DEFAULT 0,
    monthly_web_search_limit INTEGER NOT NULL DEFAULT 0,
    monthly_web_reader_count INTEGER NOT NULL DEFAULT 0,
    monthly_web_reader_limit INTEGER NOT NULL DEFAULT 0,
    monthly_image_gen_count INTEGER NOT NULL DEFAULT 0,
    monthly_image_gen_limit INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE user_plan_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    plan TEXT NOT NULL,
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ends_at DATETIME,
    is_current INTEGER NOT NULL DEFAULT 1,
    assigned_by INTEGER,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);
// Legacy window opened 1h ago (still inside its billing month) with concrete
// in-progress usage and configured limits that must transfer verbatim.
const windowStart = Math.floor(Date.now() / 1000) - 3600;
legacy.prepare(`INSERT INTO users VALUES (7, 'standart', ?, 2, 5, 1, 5, 1, 2)`).run(windowStart);
legacy.prepare(`
  INSERT INTO user_plan_subscriptions (user_id, plan, started_at, ends_at, is_current)
  VALUES (7, 'standart', datetime(?, 'unixepoch'), '2031-01-01 00:00:00', 1)
`).run(windowStart);
legacy.close();

process.env.API_DB_PATH = dbPath;
const { db } = await import('../src/db.js');
const { runMigrations } = await import('../src/services/migrations.js');
const { consumeUserQuota, getUserQuotaPeriod } = await import('../src/services/monthly-usage.js');

// ── First run: legacy users.monthly_* state transfers into a quota period ──
const applied = runMigrations();
assert.deepEqual(applied.applied, ['0001_user_plan_quota_periods']);

const subscription = db.prepare(`
  SELECT access_kind, quota_anchor_at FROM user_plan_subscriptions
  WHERE user_id = 7 AND is_current = 1
`).get() as any;
assert.equal(subscription.access_kind, 'subscription');
assert.equal(subscription.quota_anchor_at, windowStart);

const period = db.prepare(`
  SELECT * FROM user_plan_quota_periods WHERE user_id = 7 AND is_current = 1
`).get() as any;
assert.ok(period, 'migration must create the active quota period');
assert.equal(period.starts_at, windowStart, 'legacy window start must transfer exactly');
assert.equal(period.web_search_used, 2);
assert.equal(period.web_search_limit, 5);
assert.equal(period.web_reader_used, 1);
assert.equal(period.web_reader_limit, 5);
assert.equal(period.image_gen_used, 1);
assert.equal(period.image_gen_limit, 2);

// ── Re-run: migration is a no-op, runtime-created periods are never rewritten ──
db.prepare(`UPDATE users SET monthly_web_search_count = 99 WHERE id = 7`).run();
const second = runMigrations();
assert.deepEqual(second.applied, [], 'migration must run exactly once');
const periodAfter = db.prepare(`
  SELECT web_search_used FROM user_plan_quota_periods WHERE user_id = 7 AND is_current = 1
`).get() as any;
assert.equal(periodAfter.web_search_used, 2, 'existing periods must not be overwritten');

// ── No double writes: charges hit the quota period + lifetime totals only ──
consumeUserQuota(7, 'web_search', 3);
const afterConsume = getUserQuotaPeriod(7)!;
assert.equal(afterConsume.web_search_used, 5);
const legacyRow = db.prepare(`
  SELECT monthly_web_search_count, total_web_search_count FROM users WHERE id = 7
`).get() as any;
assert.equal(legacyRow.monthly_web_search_count, 99, 'legacy monthly columns must stay frozen at runtime (value set manually above)');
assert.equal(legacyRow.total_web_search_count, 3, 'lifetime counters continue to live in users');

db.close();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('subscription migration: ok');
