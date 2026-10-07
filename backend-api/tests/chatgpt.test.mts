import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-chatgpt-'));
process.env.API_DB_PATH = path.join(dir, 'test.sqlite');
process.env.ENCRYPTION_KEY = 'test-only-chatgpt-encryption';
process.env.TIMEWEB_API_KEY = '';
process.env.TIMEWEB_LITE_API_KEY = '';
const { db } = await import('../src/db.js');
const service = await import('../src/services/chatgpt-connections.js');
const adapter = await import('../src/services/chatgpt-responses.js');
const modelsService = await import('../src/services/model-settings.js');
const intervals: ReturnType<typeof setInterval>[] = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = ((...args: any[]) => {
  const timer = (realSetInterval as any)(...args); intervals.push(timer); return timer;
}) as typeof setInterval;
const ai = await import('../src/services/ai.js');
globalThis.setInterval = realSetInterval;
const originalFetch = globalThis.fetch;
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig' };
let nonce = '';
let tokenSubject = 'account-one';
let refreshes = 0;
let streamFailure = false;
let noComplete = false;
let customEvents: any[] | null = null;
let requestBody: any;
let revokeFails = false;
const sign = (clientId: string, invalidNonce = false) => {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: clientId, sub: tokenSubject, email: 'test@example.com',
    exp: Math.floor(Date.now() / 1000) + 3600, nonce: invalidNonce ? 'bad-nonce' : nonce })).toString('base64url');
  return head + '.' + body + '.' + crypto.sign('RSA-SHA256', Buffer.from(head + '.' + body), privateKey).toString('base64url');
};
let invalidNonce = false;
globalThis.fetch = (async (url: any, options: any = {}) => {
  const target = String(url);
  if (target === 'https://auth.openai.com/.well-known/openid-configuration') return Response.json({
    issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/jwks', revocation_endpoint: 'https://auth.openai.com/revoke',
  });
  if (target === 'https://auth.openai.com/jwks') return Response.json({ keys: [jwk] });
  if (target.endsWith('/api/accounts/oauth/token')) {
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('resource'), 'https://api.openai.com/v1');
    if (body.get('grant_type') === 'refresh_token') {
      refreshes++; assert.equal(body.get('client_id'), 'oaiapp_test');
      assert.equal(body.get('refresh_token'), 'fake-refresh');
      await new Promise(resolve => setTimeout(resolve, 20));
      return Response.json({ access_token: 'fake-refreshed-access', refresh_token: 'fake-rotated-refresh', expires_in: 3600 });
    }
    assert.equal(body.get('client_id'), 'oaiapp_test');
    assert.equal(body.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback');
    assert.ok(body.get('code_verifier'));
    return Response.json({ access_token: 'fake-access', refresh_token: 'fake-refresh', id_token: sign('oaiapp_test', invalidNonce), scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', expires_in: 1 });
  }
  if (target === 'https://api.openai.com/v1/models') {
    assert.equal(options.headers.Authorization, 'Bearer fake-refreshed-access');
    return Response.json({ models: [{ slug: 'visible-model', display_name: 'Visible model', visibility: 'list' }, { slug: 'hidden-model', visibility: 'hidden' }] });
  }
  if (target === 'https://api.openai.com/v1/responses') {
    assert.equal(options.headers.Authorization, 'Bearer fake-refreshed-access');
    requestBody = JSON.parse(options.body);
    const output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] },
      { type: 'function_call', call_id: 'call-one', namespace: 'chatter', name: 'search_cold_memory', arguments: '{"query":"fact"}' }];
    const events = customEvents || (streamFailure ? [{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }]
      : [{ type: 'response.output_text.delta', delta: 'OK' }, ...(noComplete ? [] : [{ type: 'response.completed', response: { id: 'response-one', status: 'completed', output,
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } } } }])]);
    const bytes = new TextEncoder().encode(events.map(event => 'event: ' + event.type + '\r\ndata: ' + JSON.stringify(event) + '\r\n\r\n').join(''));
    return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  }
  if (target === 'https://auth.openai.com/revoke') return new Response('', { status: revokeFails ? 503 : 200 });
  throw new Error('Unexpected request: ' + target);
}) as typeof fetch;

try {
  assert.throws(() => service.validateChatGptRedirect('https://evil.example/auth/callback'), /bad_chatgpt_callback/);
  assert.throws(() => service.validateChatGptRedirect('http://localhost:1455/auth/callback'), /bad_chatgpt_callback/);
  const begin = service.beginChatGptAuthorization(101, 'http://127.0.0.1:1455/auth/callback');
  const authorize = new URL(begin.authorizeUrl);
  nonce = authorize.searchParams.get('nonce')!;
  assert.equal(authorize.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(authorize.searchParams.get('agent_name_hint'), 'Chatter');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authorize.searchParams.get('ext_agent_host_id')?.startsWith('urn:uuid:'));
  await assert.rejects(service.completeChatGptAuthorization(202, { state: begin.state, code: 'test-code', clientId: 'oaiapp_test' }), /invalid_authorization_state/);
  const connection = await service.completeChatGptAuthorization(101, { state: begin.state, code: 'test-code', clientId: 'oaiapp_test' });
  assert.equal(connection.shared, false);
  assert.equal(connection.email, 'test@example.com');
  assert.equal('access_token' in connection, false);
  await assert.rejects(service.verifyChatGptIdentity(sign('oaiapp_other'), 'oaiapp_test', nonce), /invalid_identity/);
  const forged = sign('oaiapp_test').split('.');
  forged[1] = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: 'oaiapp_test', sub: 'forged', nonce, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  await assert.rejects(service.verifyChatGptIdentity(forged.join('.'), 'oaiapp_test', nonce), /invalid_identity/);
  const stored = db.prepare('SELECT credentials FROM chatgpt_connections WHERE id = ?').get(connection.id) as any;
  assert.ok(!stored.credentials.includes('fake-access') && !stored.credentials.includes('fake-refresh'));
  await assert.rejects(service.completeChatGptAuthorization(101, { state: begin.state, code: 'test-code', clientId: 'oaiapp_test' }), /invalid_authorization_state/);
  const tokens = await Promise.all(Array.from({ length: 5 }, () => service.getChatGptAccessToken(connection.id)));
  assert.deepEqual(tokens, Array(5).fill('fake-refreshed-access'));
  assert.equal(refreshes, 1, 'rotating refresh token is exchanged once for simultaneous requests');
  assert.deepEqual(await service.listChatGptModels(connection.id), [{ slug: 'visible-model', name: 'Visible model' }]);
  await assert.rejects(adapter.chatGptCompletion(connection.id, { model: 'visible-model', messages: [] }), /chatgpt_admin_only/);

  const payload = { model: 'visible-model', temperature: 1, max_tokens: 50, top_p: 1,
    messages: [{ role: 'system', content: 'System instructions' }, { role: 'user', content: [{ type: 'text', text: 'question' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,TEST' } }] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'previous-call', function: { name: 'read_memory', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'previous-call', content: 'Tool output' }],
    tools: [{ type: 'function', function: { name: 'search_cold_memory', parameters: { type: 'object', properties: {} } } }],
  };
  let streamed = '';
  const result = await service.withChatGptActor(true, () => adapter.chatGptCompletion(connection.id, payload, undefined, { onToken: text => { streamed += text; } }));
  assert.equal(streamed, 'OK');
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'search_cold_memory');
  assert.equal(result.usage.prompt_tokens, 10);
  assert.equal(result.usage.prompt_tokens_details.cached_tokens, 3);
  assert.equal(requestBody.store, false); assert.equal(requestBody.stream, true);
  assert.equal(requestBody.temperature, undefined); assert.equal(requestBody.max_tokens, undefined); assert.equal(requestBody.max_output_tokens, undefined);
  assert.equal(requestBody.input[0].role, 'developer');
  assert.equal(requestBody.input[1].content[1].type, 'input_image');
  assert.equal(requestBody.input[3].output, 'Tool output');
  assert.equal(requestBody.tools[0].type, 'namespace');
  const replay = adapter.buildChatGptRequest({ model: 'visible-model', messages: [result.choices[0].message, { role: 'tool', tool_call_id: 'call-one', content: 'Found fact' }] });
  assert.equal(replay.input[1].namespace, 'chatter', 'typed output is preserved on the next tool iteration');
  assert.equal(replay.input[2].output, 'Found fact');
  streamFailure = true;
  await assert.rejects(service.withChatGptActor(true, () => adapter.chatGptCompletion(connection.id, payload)), /chatgpt_plan_limit_reached/);
  streamFailure = false; noComplete = true;
  await assert.rejects(service.withChatGptActor(true, () => adapter.chatGptCompletion(connection.id, payload)), /chatgpt_incomplete_response/);
  noComplete = false;
  db.prepare("INSERT INTO users (id, name) VALUES (101, 'Test admin')").run();
  const current = modelsService.getModelSettings();
  const model = { id: 'test-oauth', uniqueId: 'test-oauth', baseUrl: 'https://api.openai.com/v1', model: 'visible-model', auth: 'chatgpt', chatGptConnectionId: connection.id, apiKeyId: null };
  assert.throws(() => modelsService.updateModelSettings({ ...current, proModels: [model] }), /enable_shared_access/);
  const saved = modelsService.updateModelSettings({ ...current, manualModels: [model] });
  assert.equal(saved.manualModels[0].adminOnly, true);
  assert.equal(saved.manualModels[0].apiKeyId, null);
  const quota = await import('../src/services/token-quota.js');
  quota.setModelProvider('test-oauth', { providerKind: 'custom', pricingMode: 'manual', pricingSource: 'manual', inputPricePerMillion: 2.5, outputPricePerMillion: 10, cacheReadPricePerMillion: 0.25 });
  const pricing = quota.getModelOverride('test-oauth');
  assert.equal(pricing.pricing_mode, 'manual');
  assert.equal(pricing.cache_read_price_per_million, 0.25);
  assert.equal(quota.calculateEstimatedCostUsd(1_000_000, 1_000_000, 1_000_000, pricing.input_price_per_million, pricing.output_price_per_million, pricing.cache_read_price_per_million).cost, 12.75);
  service.renameChatGptConnection(connection.id, 'Shared test', true);
  assert.equal(service.listChatGptConnections()[0].shared, true);
  await adapter.chatGptCompletion(connection.id, payload);
  assert.equal(modelsService.updateModelSettings({ ...saved, proModels: [model] }).proModels[0].auth, 'chatgpt');
  ai.refreshConfiguredModels();
  const completion = await ai.runCompletion('pro', { messages: [{ role: 'system', content: 'Runtime instructions' }, { role: 'user', content: 'Runtime question' }] });
  assert.equal(completion.usedUniqueId, 'test-oauth');
  assert.equal(completion.response.choices[0].message.content, 'OK');
  assert.equal(requestBody.input[0].role, 'developer');
  assert.equal(requestBody.model, 'visible-model');
  assert.deepEqual(ai.getModelsCatalog(true)[0].reasoning_levels, ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(ai.getModelsCatalog(true)[0].supported_params, []);
  await ai.runCompletion('pro', { messages: [{ role: 'user', content: 'Reasoning test' }] }, undefined, undefined, 'high');
  assert.deepEqual(requestBody.reasoning, { effort: 'high', summary: 'auto' });
  await ai.runCompletion('pro', { messages: [{ role: 'user', content: 'Auto test' }] }, undefined, undefined, 'auto');
  assert.equal(requestBody.reasoning.effort, undefined);
  const terminal = { type: 'response.completed', response: { id: 'streamed-response', status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } };
  customEvents = [
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Hello ' },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'from stream!' }, terminal,
  ];
  let streamedFinal = '';
  const streamedCompletion = await ai.runCompletion('pro', { messages: [{ role: 'user', content: 'Hello' }] }, undefined, undefined, 'medium', undefined, { onToken: text => { streamedFinal += text; } });
  assert.equal(streamedFinal, 'Hello from stream!');
  assert.equal(streamedCompletion.response.choices[0].message.content, streamedFinal);
  assert.equal(streamedCompletion.response.usage.total_tokens, 15);
  db.prepare("UPDATE users SET status = 'approved', is_admin = 1 WHERE id = 101").run();
  const chatId = Number(db.prepare("INSERT INTO user_chats (user_id, title) VALUES (101, 'ChatGPT stream test')").run().lastInsertRowid);
  await ai.sendMessageThroughAi(101, 'Hello', chatId, { preferredModel: 'test-oauth', forcePro: true, skipUserHistory: true, countAsUserMessage: false, reasoningLevel: 'high' });
  const persisted = db.prepare("SELECT content FROM chat_messages WHERE chat_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1").get(chatId) as any;
  assert.equal(persisted.content, 'Hello from stream!', 'completed streamed text must be saved, not replaced by the generic fallback');
  assert.equal(requestBody.reasoning.effort, 'high');
  customEvents = [
    { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'Summary' },
    { type: 'response.output_text.delta', output_index: 1, delta: 'Final text' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'message', role: 'assistant', content: [] } }, terminal,
  ];
  const summaryResult = await adapter.chatGptCompletion(connection.id, payload);
  assert.equal(summaryResult.choices[0].message.content, 'Final text');
  assert.equal(summaryResult.choices[0].message.reasoning_content, 'Summary');
  customEvents = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'streamed-call', namespace: 'chatter', name: 'search_cold_memory', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"query":' },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"fact"}' }, terminal,
  ];
  const streamedTool = await adapter.chatGptCompletion(connection.id, payload);
  assert.equal(streamedTool.choices[0].message.tool_calls[0].function.arguments, '{"query":"fact"}');
  assert.equal(streamedTool.choices[0].finish_reason, 'tool_calls');
  customEvents = [
    { type: 'response.output_text.delta', output_index: 0, delta: 'Hello' },
    { ...terminal, response: { ...terminal.response, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] }] } },
  ];
  assert.equal((await adapter.chatGptCompletion(connection.id, payload)).choices[0].message.content, 'Hello', 'terminal snapshots must not duplicate accumulated text');
  customEvents = [{ type: 'response.output_item.done', output_index: 0, item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Item done text' }] } }, terminal];
  assert.equal((await adapter.chatGptCompletion(connection.id, payload)).choices[0].message.content, 'Item done text');
  customEvents = [{ type: 'response.refusal.delta', delta: 'Cannot help.' }, terminal];
  assert.equal((await adapter.chatGptCompletion(connection.id, payload)).choices[0].message.content, 'Cannot help.');
  customEvents = [{ type: 'response.output_text.delta', delta: 'Not a successful answer' }, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }];
  await assert.rejects(adapter.chatGptCompletion(connection.id, payload), /chatgpt_plan_limit_reached/);
  customEvents = [{ type: 'response.output_text.delta', delta: 'Truncated' }];
  await assert.rejects(adapter.chatGptCompletion(connection.id, payload), /chatgpt_incomplete_response/);
  customEvents = [terminal];
  await assert.rejects(adapter.chatGptCompletion(connection.id, payload), /chatgpt_empty_response/);
  customEvents = null;
  const transfer = await import('../src/services/model-config-transfer.js');
  const exported = transfer.exportModelConfig(true);
  assert.ok(exported.models.some(item => item.auth === 'chatgpt'));
  assert.ok(!JSON.stringify(exported).includes('fake-refreshed-access'));
  assert.ok(!JSON.stringify(exported).includes('fake-rotated-refresh'));
  const imported = transfer.parseModelConfig([{ name: 'models.json', data: Buffer.from(JSON.stringify(exported)) }]);
  assert.ok(imported.warnings.includes('chatgpt_reconnect_required'));
  assert.ok(imported.models.every(item => item.auth !== 'chatgpt'));
  const reconnect = service.beginChatGptAuthorization(101, 'http://127.0.0.1:1455/auth/callback', connection.id);
  const reauthorize = new URL(reconnect.authorizeUrl);
  assert.equal(reauthorize.searchParams.get('client_id'), 'oaiapp_test');
  assert.equal(reauthorize.searchParams.has('agent_name_hint'), false);
  assert.ok(reauthorize.searchParams.has('id_token_hint'));
  nonce = reauthorize.searchParams.get('nonce')!; invalidNonce = true;
  await assert.rejects(service.completeChatGptAuthorization(101, { state: reconnect.state, code: 'test-code' }), /invalid_identity/);
  invalidNonce = false;
  assert.equal(service.listChatGptConnections().length, 1, 'failed reauthorization preserves the existing connection');
  revokeFails = true;
  await assert.rejects(service.disconnectChatGptConnection(connection.id), /revocation_failed/);
  assert.equal(service.listChatGptConnections().length, 1);
  revokeFails = false;
  await service.disconnectChatGptConnection(connection.id);
  assert.equal(service.listChatGptConnections().length, 0);
  console.log('ChatGPT OAuth and Responses tests passed');
} finally {
  for (const timer of intervals) clearInterval(timer);
  globalThis.fetch = originalFetch;
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
