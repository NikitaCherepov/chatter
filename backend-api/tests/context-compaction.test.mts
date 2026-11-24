import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-compaction-'));
process.env.API_DB_PATH = path.join(directory, 'test.db');
const { db } = await import('../src/db.js');
const { compactContext, planContextCompaction, closeInterruptedTools, isContextOverflow } =
  await import('../src/services/context-compaction.js');
const { saveCompactedContext, getContextSummary, getContextSnapshot, contextSourceFingerprint } =
  await import('../src/services/context-summary.js');
const { getHistoryForAi, getChatContextTokens, getProviderContextEstimate } =
  await import('../src/services/chats.js');
try {
  const messages: any[] = [
    { role: 'system', content: 'Policy' },
    ...Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `Turn ${index}`,
    })),
  ];
  const history = {
    origins: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    checkpoints: Array.from({ length: 10 }, (_, index) => ({
      index: index + 1,
      tokens: (index + 1) * 1000,
      epoch: 'one',
    })),
  };
  const plan = planContextCompaction(messages, history.checkpoints, 10000)!;
  assert.equal(plan.source, 'provider');
  assert.equal(plan.cut, 7, 'retain the measured freshest 30% at a complete exchange boundary');
  const unchanged = structuredClone({ messages, history });
  await assert.rejects(
    compactContext({
      messages,
      history,
      limit: 10000,
      summarize: async () => {
        throw new Error('offline');
      },
    }),
    /offline/,
  );
  assert.deepEqual(
    { messages, history },
    unchanged,
    'failed summary cannot remove history or change the boundary',
  );
  const summary = await compactContext({
    messages,
    history,
    limit: 10000,
    summarize: async () => 'Old factual decisions. Continue task.',
  });
  assert.ok(messages[1].content.startsWith('[SUMMARY OF EARLIER CONVERSATION]'));
  assert.equal(messages.length, 6);
  assert.equal(summary!.archivedThrough, 6);
  assert.equal(
    await compactContext({
      messages,
      history,
      limit: 10000,
      summarize: async () => {
        throw new Error('must wait for provider');
      },
    }),
    null,
    'do not switch to a local count after replacing a provider-measured prefix',
  );
  assert.equal(
    isContextOverflow(
      Object.assign(new Error('model_chain_failed'), {
        cause: { code: 'context_length_exceeded' },
      }),
    ),
    true,
  );
  assert.equal(isContextOverflow(new Error('quota exhausted')), false);
  assert.equal(
    planContextCompaction(
      [
        { role: 'system', content: 'x' },
        { role: 'user', content: 'x'.repeat(20000) },
        { role: 'assistant', content: 'ok' },
      ],
      [],
      1000,
    )!.source,
    'local',
  );

  const tools: any[] = [
    { role: 'system', content: 'x' },
    { role: 'user', content: 'old' },
    { role: 'assistant', tool_calls: [{ id: 'a' }, { id: 'b' }] },
    { role: 'tool', tool_call_id: 'a', content: 'done a' },
    { role: 'tool', tool_call_id: 'b', content: 'done b' },
    { role: 'assistant', content: 'new' },
  ];
  const toolPlan = planContextCompaction(
    tools,
    [
      { index: 4, tokens: 9000, epoch: 'x' },
      { index: 6, tokens: 10000, epoch: 'x' },
    ],
    10000,
  )!;
  assert.notEqual(toolPlan.cut, 3);
  assert.notEqual(toolPlan.cut, 4, 'never split a parallel tool-call/result group');
  const interrupted = closeInterruptedTools(tools.slice(2, 4), [5, 5]);
  assert.equal(interrupted.messages.at(-1).tool_call_id, 'b');
  assert.match(
    interrupted.messages.at(-1).content,
    /outcome unknown/,
    'a canceled action is never presented as safely repeatable',
  );

  db.prepare(
    "INSERT INTO users(id,name,status) VALUES(91,'Fixture','approved'),(92,'Member','approved')",
  ).run();
  const chat = Number(
    db.prepare("INSERT INTO user_chats(user_id,title) VALUES(91,'Context')").run().lastInsertRowid,
  );
  const insert = db.prepare(
    'INSERT INTO chat_messages(user_id,chat_id,role,content,timeline_index,token_count,usage_json) VALUES(91,?,?,?,?,?,?)',
  );
  const usage = {
    latest: { prompt_tokens: 9000, completion_tokens: 100, reasoning_tokens: 0 },
    context_window: { epoch: 'x', beforeTokens: 9000, afterTokens: 9100 },
  };
  for (let index = 1; index <= 4; index++)
    insert.run(
      chat,
      index % 2 ? 'user' : 'assistant',
      `Original ${index}`,
      index,
      1_000_000,
      index === 4 ? JSON.stringify(usage) : null,
    );
  assert.equal(
    getProviderContextEstimate(91, chat),
    9100,
    'lying local weights cannot adjust provider measurements',
  );
  const before = contextSourceFingerprint(91, chat, 4);
  const snapshot = {
    throughTimelineIndex: 4,
    coveredTimelineIndices: [1, 2, 3, 4],
    messages: [{ role: 'assistant', content: 'Verbatim recent tail' }],
    origins: [4],
    checkpoints: [{ index: 1, tokens: 9100, epoch: 'x' }],
  };
  const commit = {
    userId: 91,
    chatId: chat,
    content: 'Recap',
    sourceHash: 'fixture',
    throughTimelineIndex: 3,
    sourceMessageCount: 3,
    contextLimit: 10000,
    modelName: 'test',
    providerName: 'test',
    snapshot,
    previousContent: null,
    source: { through: 4, fingerprint: before },
  };
  saveCompactedContext(commit);
  assert.equal(getContextSummary(91, chat)!.content, 'Recap');
  const archived = () =>
    db
      .prepare(
        'SELECT timeline_index FROM chat_messages WHERE chat_id=? AND archived=1 ORDER BY timeline_index',
      )
      .all(chat);
  assert.deepEqual(archived(), [
    { timeline_index: 1 },
    { timeline_index: 2 },
    { timeline_index: 3 },
  ]);
  assert.deepEqual(
    getHistoryForAi(91, chat),
    snapshot.messages,
    'loading uses the compacted tail, not the original large response',
  );
  getChatContextTokens(91, chat);
  getHistoryForAi(91, chat);
  getChatContextTokens(91, chat);
  assert.deepEqual(
    archived(),
    [{ timeline_index: 1 }, { timeline_index: 2 }, { timeline_index: 3 }],
    'repeated reads never restore archived messages',
  );
  assert.equal(getChatContextTokens(91, chat).context_source, 'provider');
  assert.equal(getContextSnapshot(92, chat), null, 'snapshots are private per reader');
  await assert.rejects(
    async () =>
      saveCompactedContext({ ...commit, content: 'Do not replace', previousContent: 'wrong' }),
    /conflict/,
  );
  db.prepare("UPDATE chat_messages SET content='Edited' WHERE chat_id=? AND timeline_index=1").run(
    chat,
  );
  assert.throws(
    () => saveCompactedContext({ ...commit, previousContent: 'Recap' }),
    /source_changed/,
  );
  assert.equal(
    getContextSummary(91, chat)!.content,
    'Recap',
    'failed commit preserves the prior summary and boundary',
  );
  assert.deepEqual(
    getHistoryForAi(91, chat, 0, false, undefined, null, 0, 0, undefined, { messageId: 4 }).map(
      (message) => message.content,
    ),
    ['Edited', 'Original 2', 'Original 3'],
    'regeneration sees original history, excluding the whole target response',
  );

  // Shared room: no shared rows are archived, and concurrent unseen messages survive.
  const room = Number(
    db.prepare("INSERT INTO user_chats(user_id,title,room_enabled) VALUES(91,'Room',1)").run()
      .lastInsertRowid,
  );
  db.prepare('INSERT INTO chat_members(chat_id,user_id) VALUES(?,92)').run(room);
  insert.run(room, 'user', 'Observed', 1, 50, null);
  insert.run(room, 'user', 'Arrived concurrently', 2, 50, null);
  insert.run(room, 'assistant', 'Saved answer', 3, 50, null);
  saveCompactedContext({
    ...commit,
    chatId: room,
    userId: 92,
    source: undefined,
    throughTimelineIndex: 1,
    sourceMessageCount: 1,
    snapshot: {
      throughTimelineIndex: 3,
      coveredTimelineIndices: [1, 3],
      messages: [{ role: 'assistant', content: 'Saved tail' }],
      origins: [3],
      checkpoints: [],
    },
  });
  assert.equal(
    (
      db
        .prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id=? AND archived=1')
        .get(room) as any
    ).n,
    0,
  );
  assert.ok(
    getHistoryForAi(92, room).some((message) =>
      String(message.content).includes('Arrived concurrently'),
    ),
  );
  assert.equal(getContextSummary(91, room), null);
  console.log(
    'PASS: provider-only 30% boundary, tool pairs, failure atomicity, stable archive, snapshots, regeneration, room privacy/concurrency',
  );
} finally {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
