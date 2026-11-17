import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'chatter-intuition-'));
process.env.API_DB_PATH = join(directory, 'test.sqlite');
process.env.ENCRYPTION_KEY = 'intuition-test-key';
const { db } = await import('../src/db.js');
const { importModelKey } = await import('../src/services/model-settings.js');
const { runDecision } = await import('../src/services/decision-runner.js');
const { getDecisionSettings, setDecisionSettings, decisionKeyUsage, replaceDecisionKey } =
  await import('../src/services/decision-settings.js');
const { getIntuitionSettings, saveIntuitionSettings, evaluateIntuition } =
  await import('../src/services/intuition.js');
const { intuitionHint, stripIntuitionHint } = await import('../src/services/intuition-prompt.js');
const { buildSystemPrompt } = await import('../src/services/system-prompt.js');
const {
  appendChatMessage,
  createUserChat,
  getChatMessages,
  getHistoryForAi,
  activateChatMessageVariant,
  getChatMessageVariants,
  forkChat,
} = await import('../src/services/chats.js');
const originalFetch = globalThis.fetch;
try {
  db.prepare(
    "INSERT INTO users(id,name,status,is_admin) VALUES (81,'Owner','approved',1),(82,'Other','approved',0)",
  ).run();
  const chatId = createUserChat(81, 'Intuition');
  const apiKeyId = importModelKey('Decision test', 'test-secret');
  setDecisionSettings({ enabled: true, apiKeyId });
  assert.deepEqual(decisionKeyUsage(apiKeyId), ['Decision']);
  assert.equal(getIntuitionSettings(81, chatId).effective.enabled, false);
  const global = saveIntuitionSettings(
    81,
    null,
    { mode: 'enabled', historyMessages: 2, questions: null },
    0,
  );
  assert.equal(getIntuitionSettings(81, chatId).effective.enabled, true);
  assert.equal(getIntuitionSettings(82, null).effective.enabled, false);
  assert.throws(() => saveIntuitionSettings(81, null, global.settings, 0), /settings_changed/);
  assert.throws(() =>
    saveIntuitionSettings(81, chatId, { mode: 'enabled', historyMessages: -1, questions: [] }, 0),
  );
  let calls = 0;
  let captured: any;
  globalThis.fetch = (async (_url, init) => {
    calls++;
    captured = JSON.parse(String(init?.body));
    assert.equal(
      typeof captured.input,
      'string',
      'Decisions API structured inputs must be serialized',
    );
    return new Response(
      JSON.stringify({
        answers: captured.questions
          .slice()
          .reverse()
          .map((q: any) => ({ type: 'predicate', name: q.name, probability: 0.81 })),
        usage: { input_tokens: 100, output_tokens: 0 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const history = [
    { role: 'user', content: 'Old question' },
    { role: 'assistant', content: 'Answer' },
    { role: 'tool', content: 'Do not include tools' },
  ];
  const snapshot = await evaluateIntuition({ userId: 81, chatId, history, currentMessage: 'Why?' });
  assert.equal(snapshot?.status, 'ready');
  assert.equal(snapshot?.historyMessages, 2);
  assert.equal(snapshot?.signals.length, 5);
  assert.equal(snapshot?.signals[0].probability, 0.81);
  assert.equal(JSON.parse(captured.input).current_user_message, 'Why?');
  assert.equal(calls, 1, 'all questions share one request');
  assert.equal(
    (
      await evaluateIntuition({
        userId: 81,
        chatId,
        history,
        currentMessage: 'Why?',
        previous: snapshot,
      })
    )?.createdAt,
    snapshot?.createdAt,
  );
  assert.equal(calls, 1, 'unchanged regeneration reuses the saved evaluation');
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM user_token_usage WHERE route = 'decision:intuition'")
      .get().n,
    1,
  );
  assert.match(intuitionHint(snapshot), /Current intuition/);
  assert.ok(intuitionHint(snapshot).includes(snapshot!.signals[0].question));
  assert.match(intuitionHint(snapshot), /User frustration \([^)]+\): 0\.81/);
  const usage: any = { latest: {}, aggregate: {}, calls: [], intuition: snapshot };
  await appendChatMessage(81, chatId, 'user', 'Why?');
  const assistantId = await appendChatMessage(
    81,
    chatId,
    'assistant',
    'First',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    { usage },
  );
  assert.equal(getChatMessages(81, chatId)[1].usage?.intuition?.signals[0].probability, 0.81);
  assert.doesNotMatch(getHistoryForAi(81, chatId)[0].content, /intuition/i);
  const unavailable = { ...snapshot!, status: 'unavailable' as const, signals: [] };
  await appendChatMessage(
    81,
    chatId,
    'assistant',
    'Second',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    { usage: { ...usage, intuition: unavailable }, regenerateMessageId: assistantId },
  );
  assert.equal(getChatMessageVariants(81, chatId, assistantId).length, 2);
  assert.equal(getChatMessages(81, chatId)[1].usage?.intuition?.status, 'unavailable');
  assert.doesNotMatch(getHistoryForAi(81, chatId)[0].content, /Conversational intuition/);
  activateChatMessageVariant(81, chatId, assistantId, 0);
  assert.equal(getChatMessages(81, chatId)[1].usage?.intuition?.status, 'ready');
  assert.doesNotMatch(getHistoryForAi(81, chatId)[0].content, /intuition/i);
  const fork = forkChat(81, chatId, assistantId)!;
  assert.equal(getChatMessages(81, fork.chat_id)[1].usage?.intuition?.status, 'ready');
  const local = saveIntuitionSettings(
    81,
    chatId,
    { mode: 'disabled', questions: null, historyMessages: null },
    0,
  );
  assert.equal(
    await evaluateIntuition({ userId: 81, chatId, history, currentMessage: 'Why?' }),
    null,
  );
  assert.equal(calls, 1);
  saveIntuitionSettings(
    81,
    chatId,
    { ...local.settings, mode: 'enabled', historyMessages: 0 },
    local.revision,
  );
  const zero = await evaluateIntuition({ userId: 81, chatId, history, currentMessage: 'Why?' });
  assert.equal(zero?.historyMessages, 0);
  assert.deepEqual(JSON.parse(captured.input).conversation_history, []);
  const badFetch = (async () =>
    new Response(
      JSON.stringify({
        answers: [{ type: 'predicate', name: 'test', probability: 81 }],
        usage: { input_tokens: 5 },
      }),
    )) as typeof fetch;
  await assert.rejects(
    runDecision(
      { purpose: 'test', input: 'Test', questions: [{ id: 'test', question: 'Test?' }] },
      { fetch: badFetch },
    ),
    /invalid_response/,
  );
  globalThis.fetch = (async () => {
    throw new Error('upstream-secret-error');
  }) as typeof fetch;
  const failed = await evaluateIntuition({
    userId: 81,
    chatId,
    history,
    currentMessage: 'Different',
  });
  assert.equal(failed?.status, 'unavailable');
  assert.equal(intuitionHint(failed), '');
  assert.equal(stripIntuitionHint('Hi\n\n[Current intuition — auxiliary signals]\nHumor: 0.90'), 'Hi');
  assert.equal(
    stripIntuitionHint('A\n\n[Conversational intuition] old [/Conversational intuition] B'),
    'A B',
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    evaluateIntuition({
      userId: 81,
      chatId,
      history,
      currentMessage: 'Different',
      signal: controller.signal,
    }),
  );
  assert.ok(
    buildSystemPrompt('Character', 'User', '', false).includes('[CONVERSATIONAL INTUITION]'),
  );
  assert.ok(
    !buildSystemPrompt('Character', 'User', '', false, undefined, false).includes(
      '[CONVERSATIONAL INTUITION]',
    ),
  );
  assert.ok(
    !buildSystemPrompt('Character', 'User', '', false).includes('\\n\\n[CONVERSATIONAL INTUITION]'),
  );
  replaceDecisionKey(apiKeyId, null);
  assert.equal(getDecisionSettings().enabled, false);
  assert.equal(getDecisionSettings().apiKeyId, null);
  console.log(
    'PASS: Decision protocol, quotas, inheritance, revisions, one batched request, regeneration reuse, variants, forks, clean history, failures and cancellation',
  );
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  await rm(directory, { recursive: true, force: true });
}
