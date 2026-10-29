import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dbPath = path.join(os.tmpdir(), `chatter-browser-tool-${process.pid}-${Date.now()}.sqlite`);
process.env.API_DB_PATH = dbPath; process.env.ENCRYPTION_KEY = 'local-browser-test';
for (const key of ['TIMEWEB_API_KEY','TIMEWEB_LITE_API_KEY','TIMEWEB_VISION_API_KEY','TIMEWEB_LITE_VISION_API_KEY','TIMEWEB_PRO_ENDPOINTS','TIMEWEB_LITE_ENDPOINTS','MODELS_MANUAL']) process.env[key] = '';
const { db } = await import('../src/db.js');
const intervals: any[] = [], originalInterval = globalThis.setInterval;
globalThis.setInterval = ((...args: any[]) => { const timer = (originalInterval as any)(...args); intervals.push(timer); return timer; }) as any;
const ai = await import('../src/services/ai.js'); globalThis.setInterval = originalInterval;
const ws = await import('../src/ws-clients.js');
const confirmations = await import('../src/services/pc-command-confirmations.js');
const { getUserById } = await import('../src/services/chats.js');
db.prepare("INSERT INTO users (id, name, status, is_admin) VALUES (81, 'User', 'approved', 1)").run();
const user = getUserById(81)!;
const png = Buffer.from([137,80,78,71,13,10,26,10]).toString('base64');
const messages: any[] = [], client: any = { accountId: 81, connectionId: 'test', lastPongAt: Date.now(), lastMessageAt: Date.now(), pendingIpc: new Map() };
let siteAllowed = true, approval = false, approvalSeen = false;
client.ws = { readyState: 1, send: (text: string) => {
  const packet = JSON.parse(text); messages.push(packet);
  if (packet.type === 'execute_ipc') queueMicrotask(() => {
    const pending = client.pendingIpc.get(packet.request_id); client.pendingIpc.delete(packet.request_id);
    const payload = packet.payload;
    if (payload.action === 'screenshot') pending.resolve({ snapshot_id: 'shot', mime_type: 'image/png', screenshot_base64: png, width: 800, height: 600 });
    else if (payload.action === 'check_site_permission') {
      assert.equal(payload.permission_action, 'click'); assert.equal(payload.snapshot_id, 'shot'); assert.equal(payload.x, .5);
      pending.resolve({ allowed: siteAllowed, origin: 'https://example.test' });
    } else { assert.equal(payload.action, 'click_coordinates'); assert.equal(payload.expected_origin, 'https://example.test'); pending.resolve({ action: 'click_coordinates' }); }
  });
  if (approval && packet.action === 'browser_action_confirmation') queueMicrotask(() => {
    const pending = confirmations.getPendingPcConfirmation(packet.value.confirmation_id)!;
    assert.equal(pending.payload.ipcType, 'browser_control');
    assert.equal((pending.payload as any).ipcPayload.snapshot_id, 'shot');
    assert.equal((pending.payload as any).ipcPayload.x, .5);
    assert.equal((pending.payload as any).ipcPayload.action, 'click_coordinates');
    assert.equal(packet.value.action_type, 'click'); assert.equal(packet.value.target_element, undefined);
    approvalSeen = true; confirmations.deletePendingPcConfirmation(packet.value.confirmation_id); pending.resolve({ action: 'click_coordinates' });
  });
} };
ws.registerWsClient(client);
const sink = { items: [] as any[] }, actionSink: any = { value: null };
const run = (args: any, autoReject = false, supportsVision = true) => ai.runTool(user, 0, 'browser_control', JSON.stringify(args), async () => { throw new Error('unexpected model call'); }, undefined, undefined, actionSink, undefined, undefined, undefined, { currentModelSupportsVision: supportsVision, directImageSink: sink }, autoReject);
try {
  let result = await run({ action: 'screenshot' });
  assert.ok(result.includes('loaded_for_direct_view')); assert.equal(sink.items[0].base64, png);
  assert.ok(!result.includes(png), 'tool text must not contain image bytes');
  assert.ok((await run({ action: 'screenshot' }, false, false)).includes('question is required'), 'helper mode still requires a task');
  result = await run({ action: 'click_coordinates', snapshot_id: 'shot', x: .5, y: .4 }); assert.ok(result.includes('success'));
  const before = messages.filter(message => message.payload?.action === 'click_coordinates').length;
  siteAllowed = false;
  result = await run({ action: 'click_coordinates', snapshot_id: 'shot', x: .5, y: .4 }, true);
  assert.ok(result.includes('rejected')); assert.equal(messages.filter(message => message.payload?.action === 'click_coordinates').length, before, 'auto mode cannot bypass confirmation');
  approval = true; result = await run({ action: 'click_coordinates', snapshot_id: 'shot', x: .5, y: .4 });
  assert.ok(approvalSeen); assert.ok(result.includes('success'));
  result = await run({ action: 'click_coordinates', snapshot_id: 'shot', x: 9, y: .4 }); assert.ok(result.includes('error'));
  const open = (value: any) => ai.runTool(user, 0, 'desktop_action', JSON.stringify({ action: 'open_widget', target: 'browser', value }), async () => { throw new Error('unexpected model'); }, undefined, undefined, actionSink);
  await open({ layout: 'external', maximize: true }); assert.equal(actionSink.value.value.maximize, true);
  assert.ok((await open({ layout: 'invalid' })).includes('error'));
  assert.ok((await open({ layout: 'fullscreen', maximize: true })).includes('error'));
  console.log('PASS: actual backend tools and IPC, direct pixels, session permission, confirmation payload/approval, automatic rejection and widget layout validation');
} finally {
  ws.unregisterWsClient(client); for (const timer of intervals) clearInterval(timer); db.close();
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + suffix); } catch {} }
}
