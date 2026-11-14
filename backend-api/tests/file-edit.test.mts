import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { editFileLines } = createRequire(import.meta.url)('../../desktop-app/src/main/file-edit.ts');

const dbPath = path.join(os.tmpdir(), `chatter-file-edit-${process.pid}-${Date.now()}.sqlite`);
process.env.API_DB_PATH = dbPath;
process.env.ENCRYPTION_KEY = 'file-edit-test';
const { db } = await import('../src/db.js');
const timers: ReturnType<typeof setInterval>[] = [];
const setIntervalOriginal = globalThis.setInterval;
globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
  const timer = setIntervalOriginal(...args);
  timers.push(timer);
  return timer;
}) as typeof setInterval;
const ai = await import('../src/services/ai.js');
const confirmations = await import('../src/services/pc-command-confirmations.js');
globalThis.setInterval = setIntervalOriginal;
const ws = await import('../src/ws-clients.js');
const { getUserById } = await import('../src/services/chats.js');
db.prepare("INSERT INTO users (id, name, status, is_admin) VALUES (81, 'User', 'approved', 1)").run();

const filePath = path.resolve('fixture.css');
const original = '.stack {\n  display: grid;\n}\n\n.header {\n  display: grid;\n}\n';
let lines = original.trimEnd().split('\n');
let version = '1';
const proposed: any[] = [];
const client: any = {
  accountId: 81, connectionId: 'fixture', lastPongAt: Date.now(), lastMessageAt: Date.now(),
  pendingIpc: new Map(),
  ws: { readyState: 1, send(raw: string) {
    const packet = JSON.parse(raw);
    if (packet.type === 'execute_ipc') {
      assert.equal(packet.ipc_type, 'read_file');
      const { start_line, max_lines } = packet.payload;
      const content = lines.slice(start_line - 1, start_line - 1 + max_lines);
      const pending = client.pendingIpc.get(packet.request_id);
      client.pendingIpc.delete(packet.request_id);
      pending.resolve({ content: content.join('\n'), start_line, read_lines: content.length,
        total_lines: lines.length, file_version: version });
    } else if (packet.action === 'edit_file_lines_confirmation') {
      proposed.push(packet.value);
      const id = packet.value.confirmation_id;
      const pending = confirmations.getPendingPcConfirmation(id)!;
      assert.equal(pending.payload.ipcType, 'edit_file_lines');
      confirmations.deletePendingPcConfirmation(id);
      pending.resolve({ ok: true });
    }
  } },
};
ws.registerWsClient(client);

try {
  const user = getUserById(81)!;
  const run = async (tool: string, args: Record<string, unknown>) => JSON.parse(
    (await ai.runTool(user, 0, tool, JSON.stringify({ file_path: filePath, ...args }),
      async () => { throw new Error('unexpected model call'); }))!,
  );
  const read = () => run('read_file', { start_line: 2, max_lines: 6 });
  const snapshot = (await read()).snapshot_id;
  const edit = (args: Record<string, unknown>) => run('edit_file_lines', {
    new_content: '  display: flex;', snapshot_id: snapshot, ...args,
  });
  assert.match((await edit({ old_content: '  display: grid;' })).message, /more than once/);
  assert.match((await edit({ old_content: 'display: grid;' })).message, /does not match/);
  assert.match((await edit({ start_line: 3, end_line: 3 })).message, /Pass old_content/);
  assert.match((await edit({ old_content: '.stack {\n  display: grid;' })).message, /does not match/);
  assert.match((await edit({ old_content: '' })).message, /copy a neighboring line/);
  assert.equal(proposed.length, 0);
  const old = '.header {\n  display: grid;\n}';
  const replacement = '.header {\n  display: flex;\n}';
  assert.equal((await edit({ old_content: old, new_content: replacement })).status, 'success');
  assert.deepEqual(
    [proposed[0].start_line, proposed[0].end_line, proposed[0].old_content_preview],
    [5, 7, old],
  );
  const atFirstLine = (await run('read_file', { max_lines: 3 })).snapshot_id;
  assert.equal((await edit({ snapshot_id: atFirstLine, old_content: '.stack {', new_content: '.stack, .group {' })).status, 'success');
  assert.deepEqual([proposed[1].start_line, proposed[1].end_line], [1, 1]);
  const stale = await read();
  version = '2';
  assert.match((await edit({ snapshot_id: stale.snapshot_id, old_content: old })).message, /changed/);
  lines = [];
  const empty = (await run('read_file', {})).snapshot_id;
  assert.equal((await edit({ snapshot_id: empty, old_content: '', new_content: '.header {}' })).status, 'success');
  assert.deepEqual([proposed[2].start_line, proposed[2].end_line], [1, 0]);

  const stylesheet = dbPath + '.css';
  const apply = async (start: number, end: number, old: string, replacement: string) => {
    const stat = fs.statSync(stylesheet);
    return editFileLines(stylesheet, {
      start_line: start, end_line: end, expected_content: old, new_content: replacement,
      expected_file_version: [stat.size, stat.mtimeMs].join(':'),
    });
  };
  try {
    const crlfOriginal = original.replace(/\n/g, '\r\n');
    fs.writeFileSync(stylesheet, crlfOriginal);
    await assert.rejects(() => apply(5, 6, '.header {\n  display: grid;', replacement), /No changes written.*Unexpected }/);
    assert.equal(fs.readFileSync(stylesheet, 'utf8'), crlfOriginal, 'duplicate brace never reaches disk');
    await assert.rejects(() => apply(7, 8, '}\n', ' }'), /file_edit_range_out_of_bounds/);
    await assert.rejects(() => apply(5, 7, old + ' ', replacement), /file_changed_since_preview/);
    await apply(5, 7, old, replacement);
    assert.equal(fs.readFileSync(stylesheet, 'utf8'), crlfOriginal.replace(old.replace(/\n/g, '\r\n'), replacement.replace(/\n/g, '\r\n')));

    fs.writeFileSync(stylesheet, original.trimEnd());
    await apply(5, 7, old, '.literal::after {\n  content: "}";\n}');
    assert.ok(fs.readFileSync(stylesheet, 'utf8').endsWith('  content: "}";\n}'));

    fs.writeFileSync(stylesheet, '.bad {}\n}\n}\n');
    await apply(3, 3, '}', '');
    assert.equal(fs.readFileSync(stylesheet, 'utf8'), '.bad {}\n}\n');
    await apply(2, 2, '}', '');
    assert.equal(fs.readFileSync(stylesheet, 'utf8'), '.bad {}\n');

    fs.writeFileSync(stylesheet, '');
    await apply(1, 0, '', '.empty {}');
    assert.equal(fs.readFileSync(stylesheet, 'utf8'), '.empty {}');
  } finally {
    fs.unlinkSync(stylesheet);
  }
  console.log('PASS: unique whole lines, snapshot edges, empty files, CSS brace guard and native file writes');
} finally {
  ws.unregisterWsClient(client);
  for (const timer of timers) clearInterval(timer);
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
}
