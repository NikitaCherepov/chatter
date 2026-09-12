import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// Legacy database: tasks table without target_mode/target_chat_id, payloads
// still carry the old JSON routing wrapper.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-tasks-target-mode-'));
const dbPath = path.join(tempDir, 'legacy.db');
const legacy = new Database(dbPath);
legacy.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    plan TEXT NOT NULL DEFAULT 'free'
  );
  CREATE TABLE user_chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    room_enabled INTEGER NOT NULL DEFAULT 0
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
legacy.prepare('INSERT INTO users (id) VALUES (7), (8)').run();
// user 7: own normal chat + own room; user 8: foreign normal chat.
legacy.prepare('INSERT INTO user_chats (id, user_id, title, room_enabled) VALUES (1, 7, ?, 0)').run('Личный');
legacy.prepare('INSERT INTO user_chats (id, user_id, title, room_enabled) VALUES (2, 7, ?, 1)').run('Комната');
legacy.prepare('INSERT INTO user_chats (id, user_id, title, room_enabled) VALUES (3, 8, ?, 0)').run('Чужой');

const insertTask = legacy.prepare(`
  INSERT INTO tasks (id, user_id, execute_at, task_type, payload, recurrence_type, status)
  VALUES (?, 7, 2000000000, ?, ?, ?, 'pending')
`);
insertTask.run(1, 'ai_instruction', JSON.stringify({ instruction: 'Погода на завтра', _create_new_chat: true }), 'daily');
insertTask.run(2, 'ai_instruction', JSON.stringify({ instruction: 'Сводка новостей', _target_chat_id: 1 }), 'once');
insertTask.run(3, 'ai_instruction', JSON.stringify({ instruction: 'В комнату', _target_chat_id: 2 }), 'once'); // own room
insertTask.run(4, 'ai_instruction', JSON.stringify({ instruction: 'Чужой чат', _target_chat_id: 3 }), 'once'); // foreign chat
insertTask.run(5, 'ai_instruction', JSON.stringify({ instruction: 'Просто обёртка' }), 'once'); // no routing metadata
insertTask.run(6, 'ai_instruction', JSON.stringify({ _instruction: 'Старый ключ', _target_chat_id: 1 }), 'weekly');
insertTask.run(7, 'ai_instruction', 'Плоский текст без JSON', 'once'); // plain-text payload
insertTask.run(8, 'message', 'Напомни выпить воды', 'daily'); // non-ai_instruction: never touched
legacy.close();

process.env.API_DB_PATH = dbPath;
const { db } = await import('../src/db.js');
const { runMigrations } = await import('../src/services/migrations.js');

// db.ts must have added the columns before migrations run.
const taskColumns = (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map(c => c.name);
assert.ok(taskColumns.includes('target_mode'), 'db.ts must ensure tasks.target_mode');
assert.ok(taskColumns.includes('target_chat_id'), 'db.ts must ensure tasks.target_chat_id');

// ── 0003: legacy routing metadata converts into the explicit columns ──
const { applied } = runMigrations();
assert.ok(applied.includes('0003_tasks_target_mode'), '0003 must run');

const rows = db.prepare('SELECT id, payload, target_mode, target_chat_id, task_type FROM tasks ORDER BY id').all() as any[];

assert.deepEqual(
  { m: rows[0].target_mode, c: rows[0].target_chat_id, p: rows[0].payload },
  { m: 'new_chat', c: null, p: 'Погода на завтра' },
  '_create_new_chat → new_chat, payload unwrapped',
);
assert.deepEqual(
  { m: rows[1].target_mode, c: rows[1].target_chat_id, p: rows[1].payload },
  { m: 'chat', c: 1, p: 'Сводка новостей' },
  'valid own chat → chat + target_chat_id, payload unwrapped',
);
assert.deepEqual(
  { m: rows[2].target_mode, c: rows[2].target_chat_id, p: rows[2].payload },
  { m: 'chat', c: null, p: 'В комнату' },
  'room target is forbidden → falls back to chat with NULL target',
);
assert.deepEqual(
  { m: rows[3].target_mode, c: rows[3].target_chat_id, p: rows[3].payload },
  { m: 'chat', c: null, p: 'Чужой чат' },
  'foreign chat target → falls back to chat with NULL target',
);
assert.deepEqual(
  { m: rows[4].target_mode, c: rows[4].target_chat_id, p: rows[4].payload },
  { m: 'chat', c: null, p: 'Просто обёртка' },
  'wrapper without routing metadata → chat with NULL target, payload unwrapped',
);
assert.deepEqual(
  { m: rows[5].target_mode, c: rows[5].target_chat_id, p: rows[5].payload },
  { m: 'chat', c: 1, p: 'Старый ключ' },
  '_instruction key is unwrapped too',
);
assert.deepEqual(
  { m: rows[6].target_mode, c: rows[6].target_chat_id, p: rows[6].payload },
  { m: 'chat', c: null, p: 'Плоский текст без JSON' },
  'plain-text ai_instruction payload stays byte-identical, default mode kept',
);
assert.deepEqual(
  { m: rows[7].target_mode, c: rows[7].target_chat_id, p: rows[7].payload },
  { m: 'chat', c: null, p: 'Напомни выпить воды' },
  'non-ai_instruction task is not rewritten',
);

// ── Re-run: migration is idempotent, rows unchanged ──
const before = JSON.stringify(rows);
const second = runMigrations();
assert.deepEqual(second.applied, [], 'migrations must run exactly once');
const after = JSON.stringify(db.prepare('SELECT id, payload, target_mode, target_chat_id, task_type FROM tasks ORDER BY id').all());
assert.equal(after, before, 're-run must not touch task rows');

db.close();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('tasks target mode migration: ok');
