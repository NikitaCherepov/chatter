import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'chatter-auto-confirmation-'));
process.env.API_DB_PATH = join(directory, 'test.sqlite');
process.env.ENCRYPTION_KEY = 'auto-confirmation-test';
const { db } = await import('../src/db.js');
const { createServer, updateServer } = await import('../src/services/devops.js');
const { getAutoConfirmation, saveAutoConfirmation, assessServerCommand } =
  await import('../src/services/auto-confirmation.js');
const { setDecisionSettings } = await import('../src/services/decision-settings.js');
const { importModelKey } = await import('../src/services/model-settings.js');
const originalFetch = globalThis.fetch;
try {
  db.prepare(
    "INSERT INTO users(id,name,status,is_admin) VALUES (81,'Owner','approved',1),(82,'Other','approved',1)",
  ).run();
  const first = createServer(81, 'Test', 'example.test', 22, 'root', 'test');
  const second = createServer(81, 'Other', 'other.test', 22, 'agent', 'test');
  assert.ok(first.ok && second.ok);
  const firstId = first.id,
    secondId = second.id;
  const save = (update: object) =>
    saveAutoConfirmation(81, { revision: getAutoConfirmation(81).revision, ...update });
  assert.equal(getAutoConfirmation(81).settings.enabled, false);
  assert.equal(await assessServerCommand(81, firstId, 'pwd'), null);
  assert.throws(
    () => saveAutoConfirmation(82, { revision: 0, serverId: firstId, enabled: true }),
    /server_not_found/,
  );
  save({ serverId: firstId, enabled: false });
  save({ enabled: true, strictness: 'normal' });
  assert.equal(
    await assessServerCommand(81, firstId, 'pwd'),
    null,
    'explicit disable survives a global enable',
  );
  assert.equal(
    (await assessServerCommand(81, secondId, 'pwd'))?.approved,
    false,
    'unavailable Decision falls back to confirmation',
  );
  save({ resetOverrides: true });
  assert.deepEqual(getAutoConfirmation(81).settings.overrides, {});
  assert.throws(
    () => saveAutoConfirmation(81, { revision: 0, enabled: false, strictness: 'normal' }),
    /settings_changed/,
  );
  assert.throws(() => save({ enabled: true, strictness: 'unknown' }), /invalid_settings/);
  const apiKeyId = importModelKey('Decision', 'test-secret');
  setDecisionSettings({ enabled: true, apiKeyId });
  let scores = [0.85, 0.8];
  let calls = 0;
  let duringRequest: (() => void) | undefined;
  globalThis.fetch = (async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(
      body.questions.map((question: any) => question.name),
      ['auto', 'know'],
    );
    const input = JSON.parse(body.input);
    assert.equal(input.command, 'pwd');
    assert.equal(input.server.username, 'root');
    assert.ok(!String(init?.body).includes('test-secret'));
    duringRequest?.();
    return new Response(
      JSON.stringify({
        usage: { input_tokens: 100, output_tokens: 2 },
        answers: [
          { name: 'auto', type: 'predicate', probability: scores[0] },
          { name: 'know', type: 'predicate', probability: scores[1] },
        ],
      }),
    );
  }) as typeof fetch;
  assert.equal(
    (await assessServerCommand(81, firstId, 'pwd'))?.approved,
    true,
    'thresholds are inclusive',
  );
  scores = [0.99, 0.79];
  assert.equal(
    (await assessServerCommand(81, firstId, 'pwd'))?.approved,
    false,
    'both predicates must pass',
  );
  scores = [0.84, 0.99];
  assert.equal((await assessServerCommand(81, firstId, 'pwd'))?.approved, false);
  save({ enabled: true, strictness: 'strict' });
  scores = [0.94, 0.99];
  assert.equal((await assessServerCommand(81, firstId, 'pwd'))?.approved, false);
  scores = [0.99, 0.99];
  duringRequest = () => save({ enabled: false, strictness: 'normal' });
  assert.equal(
    (await assessServerCommand(81, firstId, 'pwd'))?.approved,
    false,
    'an in-flight disable takes effect',
  );
  duringRequest = undefined;
  save({ serverId: firstId, enabled: true });
  duringRequest = () => updateServer(81, firstId, { host: 'changed.test' });
  assert.equal(
    (await assessServerCommand(81, firstId, 'pwd'))?.approved,
    false,
    'a changed target needs confirmation',
  );
  duringRequest = undefined;
  assert.equal(
    await assessServerCommand(81, secondId, 'pwd'),
    null,
    'other servers inherit the disabled default',
  );
  const usage = db
    .prepare(
      "SELECT COUNT(*) AS n FROM user_token_usage WHERE route = 'decision:server-command-approval'",
    )
    .get() as { n: number };
  assert.equal(usage.n, calls);
  const { assessAction } = await import('../src/services/action-assessment.js');
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(JSON.parse(body.input), {
      tool: 'read_file',
      arguments: { path: '/tmp/report.txt' },
    });
    return new Response(
      JSON.stringify({
        answers: [
          { name: 'auto', type: 'predicate', probability: 0.96 },
          { name: 'know', type: 'predicate', probability: 0.91 },
        ],
      }),
    );
  }) as typeof fetch;
  const action = await assessAction({
    userId: 82,
    purpose: 'test-action-approval',
    input: { tool: 'read_file', arguments: { path: '/tmp/report.txt' } },
    strictness: 'strict',
  });
  assert.equal(action.status, 'ready');
  assert.equal(action.approved, true, 'generic actions do not require server settings');
  assert.equal(action.auto, 0.96);
  assert.equal(action.know, 0.91);
  assert.deepEqual(action.thresholds, { auto: 0.95, know: 0.9 });
  globalThis.fetch = (async () => {
    throw new Error('offline');
  }) as typeof fetch;
  assert.equal((await assessServerCommand(81, firstId, 'pwd'))?.status, 'unavailable');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(assessServerCommand(81, firstId, 'pwd', controller.signal));
  const { runTool } = await import('../src/services/ai.js');
  const { getUserById } = await import('../src/services/chats.js');
  const user = getUserById(81)!;
  const run = (command: string) =>
    runTool(
      user,
      0,
      'execute_ssh_command',
      JSON.stringify({ server_id: firstId, command }),
      async () => {
        throw new Error('unexpected model call');
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        answers: [
          { name: 'auto', type: 'predicate', probability: 0.99 },
          { name: 'know', type: 'predicate', probability: 0.99 },
        ],
      }),
    )) as typeof fetch;
  assert.match(
    JSON.parse(await run('rm -rf /')).message,
    /command_blocked_dangerous/,
    'Decision cannot bypass SSH restrictions',
  );
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        answers: [
          { name: 'auto', type: 'predicate', probability: 0.3 },
          { name: 'know', type: 'predicate', probability: 0.99 },
        ],
      }),
    )) as typeof fetch;
  assert.equal(
    JSON.parse(await run('pwd')).status,
    'rejected',
    'low scores use the existing confirmation path',
  );
  db.prepare(
    'UPDATE users SET is_admin = 0, weekly_tokens_quota = 0, weekly_tokens_used = 1 WHERE id = 81',
  ).run();
  globalThis.fetch = (async () => {
    throw new Error('must not request Decision without quota');
  }) as typeof fetch;
  assert.equal((await assessServerCommand(81, firstId, 'pwd'))?.approved, false);
  console.log(
    'PASS: defaults, ownership, overrides, reset, thresholds, quota logging, concurrent changes, failures and abort',
  );
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  await rm(directory, { recursive: true, force: true });
}
