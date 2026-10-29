import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dbPath = path.join(os.tmpdir(), `chatter-task-pages-${process.pid}-${Date.now()}.sqlite`);
process.env.API_DB_PATH = dbPath;
const { db } = await import('../src/db.js');
const { createTask, updateTaskStatus, listTaskPage, listTasks } = await import('../src/services/tasks.js');
db.prepare("INSERT INTO users (id, name) VALUES (81, 'Owner'), (82, 'Other')").run();
const ids: number[] = [];
for (let i = 0; i < 123; i++) {
  const id = createTask(81, 1000 + Math.floor(i / 3), 'message', `Task ${i}`);
  updateTaskStatus(id, 'done'); ids.push(id);
}
const foreign = createTask(82, 999999, 'message', 'Private'); updateTaskStatus(foreign, 'done');
const pages = [0, 50, 100].map(offset => listTaskPage(81, 50, 'done', offset));
assert.deepEqual(pages.map(page => page.tasks.length), [50, 50, 23]);
assert.deepEqual(pages.map(page => page.has_more), [true, true, false]);
assert.deepEqual(pages.map(page => page.next_offset), [50, 100, null]);
assert.ok(pages.every(page => page.total === 123));
assert.deepEqual(pages.flatMap(page => page.tasks.map(task => task.id)), ids.reverse(), 'latest first, stable ID tie-break, no missing or duplicated tasks');
assert.deepEqual(listTaskPage(82, 50, 'done').tasks.map(task => task.id), [foreign]);
const later = createTask(81, 2000, 'message', 'Later');
const sooner = createTask(81, 1500, 'message', 'Sooner');
assert.deepEqual(listTasks(81).map(task => task.id), [sooner, later], 'pending tasks stay in nearest-first order');
assert.deepEqual(listTaskPage(81, 2, 'all').tasks.map(task => task.id), [later, sooner]);
assert.equal(listTaskPage(81, Number.NaN, 'done', Number.NaN).tasks.length, 50);
assert.equal(listTaskPage(81, 9999, 'done').tasks.length, 100);
assert.deepEqual(listTaskPage(81, 50, 'done', 123).tasks, []);
db.close();
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + suffix); } catch {} }
console.log('PASS: 123 completed tasks across all pages, newest-first with ties, pending order, user isolation and pagination bounds');
