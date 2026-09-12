import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// allowed_tools service roundtrip: create → read → update → tolerant parsing.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-tasks-allowed-tools-'));
const dbPath = path.join(tempDir, 'fresh.db');

process.env.API_DB_PATH = dbPath;
const { db } = await import('../src/db.js');
const { createTask, getUserTaskById, updatePendingTask } = await import('../src/services/tasks.js');

const userId = 7;
db.prepare('INSERT INTO users (id) VALUES (?)').run(userId);

// ── createTask stores the whitelist as JSON, DTO returns a parsed array ──
const idList = createTask(
  userId, 2000000000, 'ai_instruction', 'Погода на завтра', 'once',
  null, null, null, 'new_chat', null, true,
  ['web_search', 'web_reader'],
);
let task = getUserTaskById(userId, idList)!;
assert.ok(task, 'created task must be readable');
assert.deepEqual(task.allowed_tools, ['web_search', 'web_reader'], 'list roundtrip');
assert.equal(
  db.prepare('SELECT allowed_tools FROM tasks WHERE id = ?').get(idList)!.allowed_tools,
  '["web_search","web_reader"]',
  'stored as compact JSON',
);

// ── null (default) = all available tools, [] = run without tools ──
const idNull = createTask(userId, 2000000000, 'ai_instruction', 'Без ограничения', 'once');
assert.equal(getUserTaskById(userId, idNull)!.allowed_tools, null, 'null stays null');

const idEmpty = createTask(
  userId, 2000000000, 'ai_instruction', 'Без тулзов', 'once',
  null, null, null, 'new_chat', null, true, [],
);
assert.deepEqual(getUserTaskById(userId, idEmpty)!.allowed_tools, [], 'empty array survives the roundtrip');

// ── updatePendingTask replaces and clears the whitelist ──
assert.equal(updatePendingTask(userId, idList, { allowed_tools: ['web_search'] }), true);
task = getUserTaskById(userId, idList)!;
assert.deepEqual(task.allowed_tools, ['web_search'], 'update narrows the list');

assert.equal(updatePendingTask(userId, idList, { allowed_tools: null }), true);
assert.equal(getUserTaskById(userId, idList)!.allowed_tools, null, 'null clears the restriction');

// ── corrupt / legacy values are tolerated → null (all tools) ──
db.prepare('UPDATE tasks SET allowed_tools = ? WHERE id = ?').run('{"web_search":true}', idList);
assert.equal(getUserTaskById(userId, idList)!.allowed_tools, null, 'JSON object → null');
db.prepare('UPDATE tasks SET allowed_tools = ? WHERE id = ?').run('not json at all', idList);
assert.equal(getUserTaskById(userId, idList)!.allowed_tools, null, 'non-JSON → null');
db.prepare('UPDATE tasks SET allowed_tools = ? WHERE id = ?').run('["ok", 42, null]', idList);
assert.deepEqual(getUserTaskById(userId, idList)!.allowed_tools, ['ok'], 'non-string entries are dropped');

db.close();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('tasks allowed_tools roundtrip: ok');
