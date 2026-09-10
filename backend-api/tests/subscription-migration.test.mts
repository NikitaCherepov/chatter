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
  INSERT INTO users VALUES (7, 'standart', 1900000000, 2, 5, 1, 5, 1, 2);
  INSERT INTO user_plan_subscriptions (user_id, plan, started_at, ends_at, is_current)
    VALUES (7, 'standart', '2029-01-01 00:00:00', '2031-01-01 00:00:00', 1);
`);
legacy.close();

process.env.API_DB_PATH = dbPath;
const { db } = await import('../src/db.js');
const { ensureUserMonthlyUsageWindow } = await import('../src/services/monthly-usage.js');
const period = ensureUserMonthlyUsageWindow(7, 1900000100)!;

const subscription = db.prepare(`SELECT access_kind, quota_anchor_at FROM user_plan_subscriptions WHERE user_id = 7 AND is_current = 1`).get() as any;
assert.equal(subscription.access_kind, 'subscription');
assert.equal(subscription.quota_anchor_at, 1900000000);
assert.equal(period.web_search_used, 2);
assert.equal(period.web_reader_used, 1);
assert.equal(period.image_gen_used, 1);

db.close();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('subscription migration: ok');
