import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { connectChatGptOnDesktop } = createRequire(import.meta.url)('../src/main/chatgpt-auth.ts');
const realFetch = globalThis.fetch;
let callback = '';
let beginBody: any;
let completeBody: any;
globalThis.fetch = (async (url: any, options: any) => {
  assert.ok(String(url).startsWith('https://selected.example/backend/api/v1/admin/chatgpt/'));
  assert.equal(options.headers.Authorization, 'Bearer fake-chatter-user-token');
  assert.equal(options.redirect, 'error');
  const body = JSON.parse(options.body);
  if (String(url).endsWith('/begin')) {
    beginBody = body;
    callback = body.redirectUri;
    return Response.json({ state: 'one-time-state', authorizeUrl: 'https://auth.openai.com/api/accounts/authorize?state=one-time-state' });
  }
  completeBody = body;
  return Response.json({ id: 1, name: 'Account', email: 'test@example.com' });
}) as typeof fetch;
try {
  const result = await connectChatGptOnDesktop({ apiBase: 'https://selected.example/backend', accessToken: 'fake-chatter-user-token', serverKey: 'fake-server-key' }, async url => {
    assert.equal(new URL(url).origin, 'https://auth.openai.com');
    const wrong = await realFetch(callback + '?state=wrong&code=test-code');
    assert.equal(wrong.status, 400);
    const done = await realFetch(callback + '?state=one-time-state&code=test-code&client_id=oaiapp_test');
    assert.equal(done.status, 200);
    assert.ok(!(await done.text()).includes('test-code'));
  });
  assert.equal(result.email, 'test@example.com');
  assert.ok(beginBody.redirectUri.startsWith('http://127.0.0.1:'));
  assert.equal(new URL(beginBody.redirectUri).pathname, '/auth/callback');
  assert.deepEqual(completeBody, { state: 'one-time-state', code: 'test-code', clientId: 'oaiapp_test' });
  await assert.rejects(realFetch(callback), 'loopback listener closes after authorization');
  console.log('ChatGPT desktop callback tests passed');
} finally { globalThis.fetch = realFetch; }
