import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-model-runtime-'));
process.env.API_DB_PATH = path.join(directory, 'test.sqlite');
process.env.ENCRYPTION_KEY = 'runtime-test-key';
process.env.TIMEWEB_MODEL_RETRIES_PER_MODEL = '0';
process.env.TIMEWEB_MODEL_RETRY_SECONDS = '0';
const requests: { model: string; auth: string }[] = [];
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body);
  requests.push({ model: payload.model, auth: String(req.headers.authorization) });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id: 'test', object: 'chat.completion', created: 1, model: payload.model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'Test reply' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
process.env.TIMEWEB_BASE_URL = baseUrl;
process.env.TIMEWEB_API_KEY = 'runtime-key-one';
process.env.TIMEWEB_MODEL = 'before-model';
process.env.TIMEWEB_PRO_ENDPOINTS = `${baseUrl}|runtime-key-one|before-model|stable-runtime|`;
process.env.TIMEWEB_LITE_ENDPOINTS = `${baseUrl}|runtime-key-one|lite-model|stable-lite|`;
process.env.MODELS_MANUAL = '';
const { db } = await import('../src/db.js');
const config = await import('../src/services/model-settings.js');
const intervals: ReturnType<typeof setInterval>[] = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = ((...args: any[]) => {
  const timer = (realSetInterval as any)(...args); intervals.push(timer); return timer;
}) as typeof setInterval;
const ai = await import('../src/services/ai.js');
globalThis.setInterval = realSetInterval;
try {
  const payload = { messages: [{ role: 'user', content: 'Test' }] };
  const first = await ai.runCompletion('pro', payload);
  assert.equal(first.usedUniqueId, 'stable-runtime');
  assert.equal(requests.at(-1).model, 'before-model');
  const initial = config.publicModelSettings();
  config.updateModelSettings({ proModels: [{ ...initial.proModels[0], model: 'after-model', apiKey: 'runtime-key-two' }] });
  ai.refreshConfiguredModels();
  await ai.runCompletion('pro', payload);
  assert.equal(requests.at(-1).model, 'after-model');
  assert.equal(requests.at(-1).auth, 'Bearer runtime-key-two');
  await ai.runCompletion('vision-pro', payload);
  assert.equal(requests.at(-1).model, 'after-model');
  config.updateModelSettings({ manualModels: [{ ...config.getModelSettings().proModels[0], id: 'manual-card', uniqueId: 'runtime-manual', name: 'Test manual', supportsVision: true, adminOnly: true, supportsTools: false }] });
  ai.refreshConfiguredModels();
  assert.equal(ai.resolveManualModel('runtime-manual', false), undefined);
  assert.equal(ai.resolveManualModel('runtime-manual', true).supportsTools, false);
  assert.equal(ai.getModelsCatalog(true)[0].supports_vision, true);
  config.updateModelSettings({ proModels: [] });
  ai.refreshConfiguredModels();
  await assert.rejects(() => ai.runCompletion('pro', payload), /pro_model_not_configured/);
  console.log('model-runtime tests passed');
} finally {
  for (const timer of intervals) clearInterval(timer);
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.close(); fs.rmSync(directory, { recursive: true, force: true });
}
