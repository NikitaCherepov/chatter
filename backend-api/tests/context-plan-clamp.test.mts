import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Context-size policy on plan change / plan-limits sync: the user's choice
// survives inside the [50%, 100%] band of the plan max.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-context-clamp-'));
process.env.API_DB_PATH = path.join(tempDir, 'fresh.db');

const { db } = await import('../src/db.js');
const { clampContextTokensOnPlanChange, applyUserPlanEntitlements } = await import('../src/services/monthly-usage.js');
const { syncAllUsersPlanLimits } = await import('../src/services/chats.js');
const { loadPlanLimitsFromDb } = await import('../src/services/plan-limits.js');

// ── pure clamp: [50%, 100%] band ──
assert.equal(clampContextTokensOnPlanChange(null, 30_000), 30_000);      // never customized → max
assert.equal(clampContextTokensOnPlanChange(0, 30_000), 30_000);
assert.equal(clampContextTokensOnPlanChange(undefined, 30_000), 30_000);
assert.equal(clampContextTokensOnPlanChange(40_000, 30_000), 30_000);    // above max → max
assert.equal(clampContextTokensOnPlanChange(10_000, 30_000), 15_000);    // below 50% → 50%
assert.equal(clampContextTokensOnPlanChange(15_000, 30_000), 15_000);    // boundary stays
assert.equal(clampContextTokensOnPlanChange(20_000, 30_000), 20_000);    // mid-band survives
assert.equal(clampContextTokensOnPlanChange(30_000, 30_000), 30_000);
assert.equal(clampContextTokensOnPlanChange(600, 1_000), 1_000);         // floor never below 1000
assert.equal(clampContextTokensOnPlanChange(700, 1_500), 1_000);

// Code defaults: free 30k / pro 1M (empty plan_limits_config on a fresh DB).
const defaults = loadPlanLimitsFromDb();
const freeMax = defaults.free.max_context_tokens;
const proMax = defaults.pro.max_context_tokens;
assert.equal(freeMax, 30_000);
assert.equal(proMax, 1_000_000);

const insertUser = (id: number, maxContextTokens: number) =>
  db.prepare("INSERT INTO users (id, plan, max_context_tokens) VALUES (?, 'free', ?)").run(id, maxContextTokens);
const getContext = (id: number) =>
  db.prepare('SELECT plan, max_context_tokens, max_context_tokens_limit FROM users WHERE id = ?').get(id) as
    { plan: string; max_context_tokens: number; max_context_tokens_limit: number };

// ── applyUserPlanEntitlements: upgrade floors small choices ──
insertUser(1, 25_000);
applyUserPlanEntitlements(1, 'pro');
let u = getContext(1);
assert.equal(u.plan, 'pro');
assert.equal(u.max_context_tokens, proMax / 2);
assert.equal(u.max_context_tokens_limit, proMax);

// ── downgrade clamps over-limit choices ──
insertUser(2, 800_000);
db.prepare("UPDATE users SET plan = 'pro' WHERE id = 2").run();
applyUserPlanEntitlements(2, 'free');
u = getContext(2);
assert.equal(u.plan, 'free');
assert.equal(u.max_context_tokens, freeMax);
assert.equal(u.max_context_tokens_limit, freeMax);

// ── mid-band custom choice survives a plan touch ──
insertUser(3, 700_000);
db.prepare("UPDATE users SET plan = 'pro' WHERE id = 3").run();
applyUserPlanEntitlements(3, 'pro');
assert.equal(getContext(3).max_context_tokens, 700_000);

// ── 0 (never customized) → plan max ──
insertUser(4, 0);
applyUserPlanEntitlements(4, 'free');
assert.equal(getContext(4).max_context_tokens, freeMax);

// ── syncAllUsersPlanLimits: per-user band instead of a hard reset ──
insertUser(5, 40_000); // above free max → clamped down
insertUser(6, 10_000); // below 50%     → raised to 50%
insertUser(7, 20_000); // inside band   → survives
syncAllUsersPlanLimits();
assert.equal(getContext(5).max_context_tokens, freeMax);
assert.equal(getContext(6).max_context_tokens, freeMax / 2);
assert.equal(getContext(7).max_context_tokens, 20_000);
assert.equal(getContext(7).max_context_tokens_limit, freeMax);

db.close();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('context plan clamp: ok');
