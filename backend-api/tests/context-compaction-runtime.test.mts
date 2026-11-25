import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-compaction-runtime-'));
process.env.API_DB_PATH = path.join(directory, 'test.db');
process.env.ENCRYPTION_KEY = 'compaction-test-only';
for (const key of [
  'TIMEWEB_API_KEY',
  'TIMEWEB_LITE_API_KEY',
  'TIMEWEB_VISION_API_KEY',
  'TIMEWEB_LITE_VISION_API_KEY',
  'TIMEWEB_PRO_ENDPOINTS',
  'TIMEWEB_LITE_ENDPOINTS',
  'MODELS_MANUAL',
])
  process.env[key] = '';
let mode = 'midturn',
  mainCalls = 0,
  summaryCalls = 0,
  overflowed = false;
const requests: any[] = [];
const upstream = http.createServer(async (req, res) => {
  let data = '';
  for await (const chunk of req) data += chunk;
  const body = JSON.parse(data);
  requests.push(body);
  const summary = String(body.messages[0]?.content).startsWith('Summarize the older part');
  if (summary) summaryCalls++;
  else mainCalls++;
  if (mode === 'overflow' && !summary && !overflowed) {
    overflowed = true;
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: 'maximum context length exceeded', code: 'context_length_exceeded' },
      }),
    );
    return;
  }
  if (mode === 'summary-fails' && summary) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: 'Summary temporarily unavailable', code: 'bad_request' },
      }),
    );
    return;
  }
  const first = mainCalls === 1;
  const message = summary
    ? {
        role: 'assistant',
        content:
          mode === 'empty-summary'
            ? ''
            : 'FACTUAL RECAP: Inspecting the theme. Earlier requests and decisions preserved. Clock action must not be repeated.',
      }
    : first && ['midturn', 'summary-fails', 'empty-summary'].includes(mode)
      ? {
          role: 'assistant',
          content: 'Checking the clock before continuing.',
          tool_calls: [
            {
              id: 'clock-once',
              type: 'function',
              function: { name: 'get_user_time', arguments: '{}' },
            },
          ],
        }
      : { role: 'assistant', content: 'Work complete.' };
  const prompt = summary
    ? 250
    : first && ['midturn', 'summary-fails', 'postfinal', 'empty-summary'].includes(mode)
      ? 8500
      : 2000;
  const usage = { prompt_tokens: prompt, completion_tokens: 100, total_tokens: prompt + 100 };
  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const delta: any = { ...message };
    if (delta.tool_calls)
      delta.tool_calls = delta.tool_calls.map((tool: any, index: number) => ({ index, ...tool }));
    res.end(
      'data: ' +
        JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) +
        '\n\n' +
        'data: ' +
        JSON.stringify({
          choices: [
            { index: 0, delta: {}, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' },
          ],
        }) +
        '\n\n' +
        'data: ' +
        JSON.stringify({ choices: [], usage }) +
        '\n\ndata: [DONE]\n\n',
    );
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
        usage,
      }),
    );
  }
});
await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const { db } = await import('../src/db.js');
const settings = await import('../src/services/model-settings.js');
const timers: any[] = [];
const setIntervalOriginal = globalThis.setInterval;
globalThis.setInterval = ((...args: any[]) => {
  const timer = (setIntervalOriginal as any)(...args);
  timers.push(timer);
  return timer;
}) as any;
const ai = await import('../src/services/ai.js');
globalThis.setInterval = setIntervalOriginal;
const { initSubagentRunner } = await import('../src/services/subagents/runner.js');
initSubagentRunner({
  runCompletion: ai.runCompletion,
  runTool: ai.runTool,
  throwIfAborted: ai.throwIfAborted,
  withAbort: ai.withAbort,
  toolDefinitions: ai.toolDefinitions,
  modelSupportsVision: ai.modelSupportsVision,
  normalizeTokenUsage: ai.normalizeTokenUsage,
});
const chats = await import('../src/services/chats.js');
const summaries = await import('../src/services/context-summary.js');
try {
  db.prepare(
    "INSERT INTO users(id,name,status,is_admin,max_context_tokens,feature_flags) VALUES(81,'Context tester','approved',1,10000,?)",
  ).run(JSON.stringify({ disable_prompt_injection_protection: true }));
  const { updateMemoryPreferences } = await import('../src/services/memory-preferences.js');
  updateMemoryPreferences(81, { automatic_memory: false });
  const key = settings.importModelKey('Local test', 'fake-key');
  const model = {
    id: 'context-card',
    uniqueId: 'context-model',
    model: 'context-upstream',
    baseUrl: `http://127.0.0.1:${(upstream.address() as any).port}/v1`,
    apiKeyId: key,
    accessMode: 'all',
    supportsTools: true,
  };
  settings.updateModelSettings({
    proModels: [model],
    liteModels: [],
    manualModels: [model],
    visionModel: { id: 'vision', uniqueId: 'vision', model: '', baseUrl: '', apiKeyId: null },
  });
  ai.refreshConfiguredModels();
  const create = async () => {
    const id = chats.createUserChat(81, 'Existing long chat');
    await chats.appendChatMessage(81, id, 'user', 'Earlier theme requirement');
    await chats.appendChatMessage(81, id, 'assistant', 'Earlier decision');
    return id;
  };
  const options: any = {
    forcePro: true,
    preferredModel: 'context-model',
    allowedTools: ['get_user_time'],
    autoRejectHitl: true,
  };
  const chat = await create();
  let started = 0;
  const result = await ai.sendMessageThroughAi(81, 'Continue editing the theme', chat, {
    ...options,
    onToolCall: (call: any) => {
      if (call.running) started++;
    },
  });
  assert.equal(
    result.reply_text.includes('Work complete.'),
    true,
    JSON.stringify({ reply: result.reply_text, mainCalls, summaryCalls }),
  );
  assert.equal(mainCalls, 2);
  assert.ok(summaryCalls > 0);
  assert.equal(started, 1, 'the completed tool is not run twice after compaction');
  const main = requests.filter(
    (body) => !String(body.messages[0]?.content).startsWith('Summarize the older part'),
  );
  assert.ok(
    main[1].messages.some((message: any) =>
      String(message.content).startsWith('[SUMMARY OF EARLIER CONVERSATION]'),
    ),
  );
  assert.ok(
    main[1].messages.some(
      (message: any) => message.role === 'tool' && message.tool_call_id === 'clock-once',
    ),
    'recent completed results are still available',
  );
  assert.ok(summaries.getContextSummary(81, chat));
  const snapshot = summaries.getContextSnapshot(81, chat)!;
  assert.ok(snapshot.messages.length > 0);
  assert.ok(chats.getChatMessages(81, chat).some((message) => message.archived));
  const saved = chats
    .getChatMessages(81, chat)
    .find((message) => message.id === result.message_id)!;
  assert.equal(
    saved.usage!.context_window!.afterTokens,
    2100,
    'utility summary usage cannot replace the MAIN measurement',
  );
  mainCalls = 0;
  requests.length = 0;
  mode = 'followup';
  await ai.sendMessageThroughAi(81, 'A follow-up', chat, options);
  const followup = requests.find(
    (body) => !String(body.messages[0]?.content).startsWith('Summarize the older part'),
  );
  assert.equal(
    followup.messages.filter(
      (message: any) => message.role === 'tool' && message.tool_call_id === 'clock-once',
    ).length,
    1,
    'reopening history does not resurrect/duplicate the original trace',
  );

  mode = 'empty-summary';
  mainCalls = 0;
  summaryCalls = 0;
  const priorRecap = summaries.getContextSummary(81, chat)!.content;
  const priorArchived = chats
    .getChatMessages(81, chat)
    .filter((message) => message.archived).length;
  const empty = await ai.sendMessageThroughAi(81, 'Preserve the last valid recap', chat, options);
  assert.equal(empty.aborted, true, 'generic runner fallback text must not become a recap');
  assert.equal(summaries.getContextSummary(81, chat)!.content, priorRecap);
  assert.equal(
    chats.getChatMessages(81, chat).filter((message) => message.archived).length,
    priorArchived,
  );

  mode = 'postfinal';
  mainCalls = 0;
  summaryCalls = 0;
  const postChat = await create();
  await ai.sendMessageThroughAi(81, 'A large final answer', postChat, options);
  assert.ok(
    summaries.getContextSummary(81, postChat),
    'post-response compaction saves the recap and tail together',
  );
  assert.equal(chats.getChatContextTokens(81, postChat).context_measurement_stale, true);
  mode = 'followup';
  await ai.sendMessageThroughAi(81, 'Next input', postChat, options);
  assert.equal(
    chats.getChatContextTokens(81, postChat).context_measurement_stale,
    false,
    'a new provider measurement refreshes a compacted window',
  );

  mode = 'overflow';
  mainCalls = 0;
  summaryCalls = 0;
  requests.length = 0;
  const retryChat = await create();
  await ai.sendMessageThroughAi(81, 'Continue after overflow', retryChat, options);
  assert.equal(mainCalls, 2, 'rejected request is retried once after compression');
  assert.ok(summaryCalls > 0);
  assert.ok(summaries.getContextSummary(81, retryChat));

  mode = 'summary-fails';
  mainCalls = 0;
  summaryCalls = 0;
  requests.length = 0;
  const failureChat = await create();
  const failed = await ai.sendMessageThroughAi(
    81,
    'Keep my history on failure',
    failureChat,
    options,
  );
  assert.equal(failed.aborted, true);
  assert.match(failed.reply_text, /Context summary failed/);
  assert.equal(summaries.getContextSummary(81, failureChat), null);
  assert.ok(chats.getChatMessages(81, failureChat).every((message) => !message.archived));
  assert.ok(
    chats
      .getChatMessages(81, failureChat)
      .some((message) => message.tool_calls?.some((call) => call.name === 'get_user_time')),
    'completed actions survive a failed summary',
  );

  mode = 'followup';
  db.prepare('UPDATE users SET max_context_tokens = 400000, max_context_tokens_limit = 400000 WHERE id = 81').run();
  const magnus = {
    ...model,
    id: 'magnus-card',
    uniqueId: 'magnus-test',
    model: 'celeris-1-magnus',
    baseUrl: 'https://inference.celeris.ai/celeris-1-magnus/v1',
  };
  settings.updateModelSettings({ manualModels: [model, magnus] });
  ai.refreshConfiguredModels();
  const magnusClient = ai.resolveManualModel(magnus.uniqueId, true, 81)!;
  magnusClient.client.baseURL = model.baseUrl;

  for (const [configuredModel, limit] of [[model, 65_536], [magnus, 16_384]] as const) {
    requests.length = 0;
    const result = await ai.sendMessageThroughAi(81, 'Continue a large task', await create(), {
      ...options,
      preferredModel: configuredModel.uniqueId,
    });
    assert.match(result.reply_text, /Work complete/);
    assert.equal(requests.at(-1).model, configuredModel.model);
    assert.equal(requests.at(-1).max_tokens, limit);
  }

  // A model reached through the shared completion path must also respect Magnus's limit.
  await ai.runCompletion('pro', {
    messages: [{ role: 'user', content: 'Continue' }],
    max_tokens: 65_536,
  }, magnusClient);
  assert.equal(requests.at(-1).model, magnus.model);
  assert.equal(requests.at(-1).max_tokens, 16_384);
  console.log(
    'PASS: main loop, provider usage, context compaction, overflow retry, preserved history, and model output limits',
  );
} finally {
  timers.forEach(clearInterval);
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
