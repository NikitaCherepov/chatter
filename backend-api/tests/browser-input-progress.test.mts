import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { wsClients, sendIpcToDesktop } = createRequire(import.meta.url)('../src/ws-clients.ts');

// Deterministic clock exercises actual pending IPC timers without waiting minutes.
const original = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, now: Date.now };
let now = 1000;
let nextId = 0;
const timers = new Map<number, { at: number; run: () => void }>();
globalThis.setTimeout = ((run: () => void, ms: number) => {
  const id = ++nextId; timers.set(id, { at: now + ms, run }); return id;
}) as any;
globalThis.clearTimeout = ((id: number) => timers.delete(id)) as any;
Date.now = () => now;
const advance = (ms: number) => {
  const end = now + ms;
  for (;;) {
    const first = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    if (!first || first[1].at > end) break;
    now = first[1].at; timers.delete(first[0]); first[1].run();
  }
  now = end;
};
const sent: any[] = [];
const client: any = {
  ws: { readyState: 1, send(data: string, callback?: () => void) { sent.push(JSON.parse(data)); callback?.(); } },
  accountId: 1, connectionId: 'test', lastPongAt: now, lastMessageAt: now, pendingIpc: new Map(),
};
wsClients.set(1, client);
const start = (payload: any, timeout = 1000, type = 'browser_control', signal?: AbortSignal) => {
  client.lastPongAt = now;
  let outcome: any;
  const promise = sendIpcToDesktop(1, type, payload, timeout, signal).then(
    (value: any) => outcome = value, (error: Error) => outcome = error.message);
  const request = sent.filter(m => m.type === 'execute_ipc').at(-1);
  return { request, pending: client.pendingIpc.get(request.request_id), promise, result: () => outcome };
};
try {
  const active = start({ action: 'fill', text: 'hello' });
  advance(900);
  active.pending.progress(1);
  advance(1100);
  assert.ok(client.pendingIpc.has(active.request.request_id), 'real progress extends the original wait');
  active.pending.progress(1); // duplicate must not refresh
  active.pending.progress('2'); // malformed must not refresh
  active.pending.progress(0);
  advance(28900);
  await active.promise;
  assert.equal(active.result(), 'ipc_timeout');
  assert.equal(sent.at(-1).type, 'cancel_ipc');

  const passive = start({ action: 'read' });
  passive.pending.progress(10);
  advance(1000); await passive.promise;
  assert.equal(passive.result(), 'ipc_timeout', 'passive operations cannot extend timeout');

  const instant = start({ action: 'fill', text: 'abc', human_typing: false });
  instant.pending.progress(1);
  advance(1000); await instant.promise;
  assert.equal(instant.result(), 'ipc_timeout', 'instant paste retains regular timeout');

  const capped = start({ action: 'fill', text: 'abc' }, 10000);
  for (let i = 1; i <= 8; i++) { advance(9000); capped.pending.progress(i); }
  await capped.promise;
  assert.equal(capped.result(), 'ipc_timeout', 'progress cannot extend beyond the hard deadline');
  assert.equal(timers.size, 0);

  const abort = new AbortController();
  const cancelled = start({ action: 'fill', text: 'abc' }, 1000, 'browser_control', abort.signal);
  cancelled.pending.progress(1);
  abort.abort(); await cancelled.promise;
  assert.match(cancelled.result(), /aborted/);
  assert.equal(timers.size, 0, 'abort clears the refreshed timer');

  const google = start({ message: 'hello' }, 1000, 'google_ai');
  google.pending.progress(1);
  advance(5000);
  assert.ok(client.pendingIpc.has(google.request.request_id), 'Google keeps time to await its answer after typing');
  client.pendingIpc.delete(google.request.request_id);
  google.pending.resolve({ ok: true }); await google.promise;
  assert.deepEqual(google.result(), { ok: true });
  assert.equal(timers.size, 0, 'completion clears the refreshed timer');

  const rejected = start({ action: 'fill', text: 'abc' });
  rejected.pending.progress(1);
  client.pendingIpc.delete(rejected.request.request_id);
  rejected.pending.reject(new Error('desktop_disconnected')); await rejected.promise;
  assert.equal(timers.size, 0, 'disconnect clears the refreshed timer');
  console.log('PASS: progress extension, duplicate validation, passive/instant mode, hard deadline, abort and completion cleanup');
} finally {
  wsClients.delete(1);
  globalThis.setTimeout = original.setTimeout;
  globalThis.clearTimeout = original.clearTimeout;
  Date.now = original.now;
}
