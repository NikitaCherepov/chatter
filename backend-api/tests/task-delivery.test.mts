import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const dbPath = path.join(os.tmpdir(), `chatter-task-delivery-${process.pid}-${Date.now()}.sqlite`);
process.env.API_DB_PATH = dbPath;
const { db } = await import('../src/db.js');
const chats = await import('../src/services/chats.js');
const tasks = await import('../src/services/tasks.js');
const { parseTaskCompletion } = await import('../src/services/task-completion.js');
db.prepare("INSERT INTO users (id, name, status, language) VALUES (81, 'Task owner', 'approved', 'en')").run();
const pushed: any[] = [];
let decision: any = { notify_user: false, message: '' }, fail = false, calls = 0;
let expectedContext: number | undefined;
const countChats = () => (db.prepare('SELECT COUNT(*) AS n FROM user_chats WHERE user_id = 81').get() as any).n;
const countMessages = () => (db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE user_id = 81').get() as any).n;
const source = fs.readFileSync(new URL('../src/services/scheduler.ts', import.meta.url), 'utf8').replace(/^import .*;\r?$/gm, '');
const sandbox: any = { exports: {}, process, db, ...chats, ...tasks, parseTaskCompletion,
  console: { error: () => {}, log: () => {}, warn: () => {} },
  translateForLanguage: (_lang: any, key: string, data: any = {}) => `${key}: ${data.text ?? data.error ?? ''}`,
  isDesktopOnline: () => true, sendToDesktop: (_id: number, message: any) => pushed.push(message),
  getTelegramIdentityForAccount: () => null, sendTelegramMessage: () => { throw new Error('unexpected Telegram'); },
  runSmartHomeControl: async () => 'OK',
  sendMessageThroughAi: async (_userId: number, prompt: string, chatId: number | undefined, options: any) => {
    calls++;
    assert.equal(chatId, expectedContext);
    assert.ok(prompt.includes('finish_task'));
    assert.equal(options.skipHistory, true); assert.equal(options.scheduledTask, true);
    assert.equal(options.autoRejectHitl, true); assert.deepEqual(options.allowedTools, []);
    if (fail) throw new Error('model failure');
    return { reply_text: 'Internal narration must never be delivered', task_result: decision,
      task_trace: [{ step: 0, content: 'Checking', tool_calls: [], results: [] }],
      message_usage: { calls: [], aggregate: { total_tokens: 7 } }, chat_id: chatId ?? 0, message_id: 0 };
  },
};
vm.createContext(sandbox);
vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
const run = sandbox.exports.runScheduledTask;
const makeTask = (mode: any = null, targetMode: any = 'new_chat', target: number | null = null, recurrence: any = 'once') => {
  const id = tasks.createTask(81, Math.floor(Date.now() / 1000), 'ai_instruction', 'Only report when there is news', recurrence, null, 0, mode, targetMode, target, true, []);
  return { ...tasks.getUserTaskById(81, id)!, user_id: 81 };
};
let task = makeTask();
let result = await run(task);
assert.equal(result.ok, true); assert.equal(result.delivered, false); assert.equal(result.chatId, null);
assert.equal(countChats(), 0); assert.equal(countMessages(), 0); assert.equal(pushed.length, 0);
let log = db.prepare('SELECT * FROM task_runs ORDER BY id DESC LIMIT 1').get() as any;
assert.equal(log.status, 'done'); assert.equal(log.notify_user, 0); assert.equal(log.chat_id, null);
assert.ok(log.trace_json.includes('Checking')); assert.ok(log.usage_json.includes('7'));
assert.equal(tasks.getUserTaskById(81, task.id)!.status, 'done');
decision = { notify_user: true, message: 'There is news' };
task = makeTask(); result = await run(task);
assert.equal(result.delivered, true); assert.equal(countChats(), 1); assert.equal(countMessages(), 2);
assert.equal(pushed.length, 1); assert.equal(pushed[0].text, 'There is news');
const targetId = result.chatId;
assert.equal(chats.getChatMessages(81, targetId).at(-1)!.content, 'There is news');
const before = { chats: countChats(), messages: countMessages(), pushes: pushed.length };
for (const mode of ['never', 'on_error']) {
  result = await run(makeTask(mode));
  assert.equal(result.ok, true); assert.equal(result.delivered, false); assert.equal(result.chatId, null);
}
assert.deepEqual({ chats: countChats(), messages: countMessages(), pushes: pushed.length }, before);
decision = { notify_user: false, message: '' };
task = makeTask(null, 'chat', targetId); expectedContext = targetId;
await run(task); assert.equal(countMessages(), before.messages, 'silent targeted run never writes into the chat');
expectedContext = undefined;
await run(makeTask(null, 'chat', 999999));
assert.equal(countChats(), before.chats, 'silent stale target does not create a replacement chat or warning');
task = makeTask(null, 'new_chat', null, 'daily'); await run(task);
assert.equal(tasks.getUserTaskById(81, task.id)!.status, 'pending');
assert.ok(tasks.getUserTaskById(81, task.id)!.execute_at > task.execute_at, 'silent recurring task advances normally');
task = makeTask(); await run(task, { advanceSchedule: false });
assert.equal(tasks.getUserTaskById(81, task.id)!.status, 'pending');
assert.equal((db.prepare('SELECT is_test FROM task_runs ORDER BY id DESC LIMIT 1').get() as any).is_test, 1);
decision = undefined; result = await run(makeTask());
assert.equal(result.ok, false); assert.equal(countChats(), before.chats, 'missing finish decision never becomes a notification');
fail = true; result = await run(makeTask('never')); assert.equal(result.ok, false); assert.equal(pushed.length, before.pushes);
result = await run(makeTask('on_error')); assert.equal(result.ok, false); assert.equal(countChats(), before.chats + 1); assert.equal(pushed.length, before.pushes + 1);
assert.ok(pushed.at(-1).text.includes('model failure'));
const ordinaryPushes = pushed.length, ordinaryMessages = countMessages();
const reminderId = tasks.createTask(81, Math.floor(Date.now() / 1000), 'message', 'Reminder', 'once', null, 0, 'always', 'chat', targetId);
result = await run({ ...tasks.getUserTaskById(81, reminderId)!, user_id: 81 });
assert.equal(result.delivered, true); assert.equal(pushed.length, ordinaryPushes + 1);
const homeId = tasks.createTask(81, Math.floor(Date.now() / 1000), 'smart_home', '{}', 'once', null, 0, 'never', 'chat', targetId);
result = await run({ ...tasks.getUserTaskById(81, homeId)!, user_id: 81 });
assert.equal(result.ok, true); assert.equal(result.delivered, false);
assert.equal(countMessages(), ordinaryMessages + 2, 'ordinary tasks retain history even when smart-home notifications are disabled');
assert.ok(calls >= 10);
db.close();
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + suffix); } catch {} }
console.log('PASS: actual scheduler and DB, explicit notify decision, no silent chats/messages/pushes, journal, modes, context, errors, recurring and test runs');
