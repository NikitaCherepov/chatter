import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// Legacy database: tasks still carry the old notify modes and notify_condition.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-tasks-notify-'));
const dbPath = path.join(tempDir, 'legacy.db');
const legacy = new Database(dbPath);
legacy.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    plan TEXT NOT NULL DEFAULT 'free'
  );
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    execute_at INTEGER NOT NULL,
    task_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    notify_mode TEXT NOT NULL DEFAULT 'always',
    notify_condition TEXT,
    recurrence_type TEXT NOT NULL DEFAULT 'once',
    recurrence_weekday INTEGER,
    timezone_offset INTEGER,
    status TEXT NOT NULL DEFAULT 'pending'
  );
`);
legacy.prepare('INSERT INTO users (id) VALUES (7)').run();

const insertTask = legacy.prepare(`
  INSERT INTO tasks (id, user_id, execute_at, task_type, payload, notify_mode, notify_condition)
  VALUES (?, 7, 2000000000, 'ai_instruction', ?, ?, ?)
`);
insertTask.run(1, 'Проверь почту', 'always', null);
insertTask.run(2, 'Погода утром', 'on_match', 'дождь');
insertTask.run(3, 'Новости', 'on_condition', 'important emails from X');
insertTask.run(4, 'Тихая проверка', 'never', null);
insertTask.run(5, 'Бэкап', 'on_error', null);
legacy.close();

process.env.API_DB_PATH = dbPath;
const { db } = await import('../src/db.js');
const { runMigrations } = await import('../src/services/migrations.js');

const { applied } = runMigrations();
assert.ok(applied.includes('0004_tasks_notify'), '0004 must run');

// ── Values survive; dead modes collapse to 'always' ──
const rows = db.prepare('SELECT id, notify_mode FROM tasks ORDER BY id').all() as any[];
assert.deepEqual(
  rows.map(r => r.notify_mode),
  ['always', 'always', 'always', 'never', 'on_error'],
  'always kept, on_match/on_condition → always, never/on_error kept',
);

// ── notify_condition is gone ──
const columns = (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map(c => c.name);
assert.ok(!columns.includes('notify_condition'), 'tasks.notify_condition must be dropped');

// ── New-task defaults: NULL only for ai_instruction ──
const { createTask } = await import('../src/services/tasks.js');
createTask(7, 2000000900, 'message', 'Напомни выпить воды');
createTask(7, 2000001000, 'ai_instruction', 'Проверь почту');
const freshMessage = db.prepare('SELECT notify_mode FROM tasks WHERE id = 6').get() as any;
assert.equal(freshMessage.notify_mode, 'always', 'message task defaults to always');
const freshAi = db.prepare('SELECT notify_mode FROM tasks WHERE id = 7').get() as any;
assert.equal(freshAi.notify_mode, null, 'ai_instruction task defaults to NULL (AI decides)');

// ── Re-run: idempotent ──
const before = JSON.stringify(db.prepare('SELECT id, notify_mode FROM tasks ORDER BY id').all());
const second = runMigrations();
assert.deepEqual(second.applied, [], 'migrations must run exactly once');
const after = JSON.stringify(db.prepare('SELECT id, notify_mode FROM tasks ORDER BY id').all());
assert.equal(after, before, 're-run must not touch task rows');

db.close();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('tasks notify migration: ok');
