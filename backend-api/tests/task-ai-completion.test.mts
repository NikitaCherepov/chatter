import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const dbPath = path.join(os.tmpdir(), `chatter-task-ai-${process.pid}-${Date.now()}.sqlite`);
process.env.API_DB_PATH = dbPath; process.env.ENCRYPTION_KEY = 'task-test-only';
for (const key of ['TIMEWEB_API_KEY','TIMEWEB_LITE_API_KEY','TIMEWEB_VISION_API_KEY','TIMEWEB_LITE_VISION_API_KEY','TIMEWEB_PRO_ENDPOINTS','TIMEWEB_LITE_ENDPOINTS','MODELS_MANUAL']) process.env[key] = '';
let mode = 'silent', turn = 0;
const received: any[] = [];
const upstream = http.createServer(async (req, res) => {
  let data = ''; for await (const chunk of req) data += chunk;
  const body = JSON.parse(data); received.push(body); turn++;
  const finish = (notify: boolean, message: string) => ({ role: 'assistant', content: '', tool_calls: [{ id: `finish-${turn}`, type: 'function', function: { name: 'finish_task', arguments: JSON.stringify({ notify_user: notify, message }) } }] });
  const message = mode === 'empty-whitelist' ? finish(false, '') : mode === 'missing' ? { role: 'assistant', content: 'Ordinary text is not completion' }
    : turn === 1 ? { role: 'assistant', content: 'Internal checking narration', tool_calls: [{ id: 'clock', type: 'function', function: { name: 'get_user_time', arguments: '{}' } }] }
    : mode === 'invalid' && turn === 2 ? finish(true, '') : finish(mode === 'notify', mode === 'notify' ? 'Public result' : '');
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const delta: any = { ...message };
    if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((tool: any, index: number) => ({ index, ...tool }));
    const chunk = { id: 'task-completion', object: 'chat.completion.chunk', created: 1, model: body.model };
    res.end('data: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n'
      + 'data: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\n'
      + 'data: ' + JSON.stringify({ ...chunk, choices: [], usage }) + '\n\ndata: [DONE]\n\n');
  } else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage })); }
});
await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
const { db } = await import('../src/db.js');
const settings = await import('../src/services/model-settings.js');
const intervals: any[] = []; const originalInterval = globalThis.setInterval;
globalThis.setInterval = ((...args: any[]) => { const timer = (originalInterval as any)(...args); intervals.push(timer); return timer; }) as any;
const ai = await import('../src/services/ai.js'); globalThis.setInterval = originalInterval;
try {
  db.prepare("INSERT INTO users (id, name, status, is_admin, feature_flags) VALUES (81, 'Task user', 'approved', 1, ?)").run(JSON.stringify({ disable_prompt_injection_protection: true }));
  const { updateMemoryPreferences } = await import('../src/services/memory-preferences.js');
  updateMemoryPreferences(81, { automatic_memory: false });
  const key = settings.importModelKey('Local fake', 'fake-key');
  const model = { id: 'task-card', uniqueId: 'task-model', model: 'task-upstream', baseUrl: `http://127.0.0.1:${(upstream.address() as any).port}/v1`, apiKeyId: key, accessMode: 'all', supportsTools: true };
  settings.updateModelSettings({ proModels: [model], liteModels: [], manualModels: [model], visionModel: { id: 'vision', uniqueId: 'vision', model: '', baseUrl: '', apiKeyId: null } }); ai.refreshConfiguredModels();
  const run = (allowedTools = ['get_user_time']) => ai.sendMessageThroughAi(81, 'Execute scheduled instruction and finish_task.', undefined, { forcePro: true, preferredModel: 'task-model', skipHistory: true, countAsUserMessage: false, isBackgroundTask: true, scheduledTask: true, autoRejectHitl: true, allowedTools });
  let result = await run();
  assert.deepEqual(result.task_result, { notify_user: false, message: '' });
  assert.equal(turn, 2, 'finish_task ends the run without another completion');
  assert.ok(result.task_trace?.length === 2); assert.ok(JSON.stringify(result.task_trace).includes('Internal checking narration'));
  assert.equal(result.chat_id, 0); assert.equal(result.message_id, 0);
  assert.ok(received[0].tools.some((tool: any) => tool.function.name === 'finish_task'));
  assert.deepEqual(received[0].tools.map((tool: any) => tool.function.name).sort(), ['finish_task', 'get_user_time']);
  mode = 'notify'; turn = 0; result = await run(); assert.deepEqual(result.task_result, { notify_user: true, message: 'Public result' });
  mode = 'invalid'; turn = 0; result = await run(); assert.equal(turn, 3); assert.equal(result.task_result?.notify_user, false, 'invalid finish arguments are corrected through tool feedback');
  mode = 'missing'; turn = 0; await assert.rejects(() => run(), /task_finish_required/); assert.equal(turn, 3, 'plain answers have bounded retries');
  mode = 'empty-whitelist'; turn = 0; result = await run([]);
  assert.deepEqual(result.task_result, { notify_user: false, message: '' });
  assert.deepEqual(received.at(-1).tools.map((tool: any) => tool.function.name), ['finish_task'], 'run control stays available with no business tools');
  turn = 0; await run(['browser_control']);
  const helperBrowser = received.at(-1).tools.find((tool: any) => tool.function.name === 'browser_control');
  assert.ok('question' in helperBrowser.function.parameters.properties, 'text models receive the helper question parameter');
  settings.updateModelSettings({ manualModels: [{ ...model, supportsVision: true }] }); ai.refreshConfiguredModels();
  turn = 0; await run(['browser_control']);
  const directBrowser = received.at(-1).tools.find((tool: any) => tool.function.name === 'browser_control');
  assert.ok(!('question' in directBrowser.function.parameters.properties), 'vision tool schema omits question in the real provider request');
  assert.ok(!('image_mode' in directBrowser.function.parameters.properties), 'vision defaults to direct pixels without a mode selector');
  assert.ok(directBrowser.function.description.includes('PNG pixels directly'));
  const requestCount = received.length;
  settings.updateModelSettings({ manualModels: [{ ...model, supportsTools: false }] }); ai.refreshConfiguredModels();
  await assert.rejects(() => run([]), /task_model_requires_tools/);
  assert.equal(received.length, requestCount, 'unsupported models fail before a paid completion');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM user_chats WHERE user_id = 81').get() as any).n, 0, 'AI execution never creates a chat');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE user_id = 81').get() as any).n, 0, 'AI execution never persists narration or empty answers');
  assert.ok((db.prepare('SELECT COUNT(*) AS n FROM user_token_usage WHERE user_id = 81').get() as any).n > 0, 'existing accounting still charges quiet runs');
  console.log('PASS: actual AI loop with local fake provider, terminal finish_task, silent/notify, narration isolation, validation retry, missing-finish error, no chats and existing billing');
} finally {
  for (const timer of intervals) clearInterval(timer);
  upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); db.close();
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + suffix); } catch {} }
}
