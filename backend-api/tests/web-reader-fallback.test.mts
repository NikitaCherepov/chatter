import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDbPath = join(tmpdir(), `chatter-web-reader-${process.pid}-${Date.now()}.db`);
process.env.API_DB_PATH = testDbPath;
process.env.BROWSERLESS_TOKEN = 'test-token';

let browserlessRequests = 0;
globalThis.fetch = (async () => {
  browserlessRequests += 1;
  return new Response(JSON.stringify({ data: { text: { text: 'Browserless fallback content' } } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof fetch;

const { db } = await import('../src/db.js');
const { getWebReaderRuntimeSettings, getWebReaderStats, updateWebReaderRuntimeSettings } = await import('../src/services/web-reader-runtime.js');
const { getCleanTextFromUrl } = await import('../src/services/web-reader.js');
const { registerWsClient, unregisterWsClient } = await import('../src/ws-clients.js');

assert.deepEqual(getWebReaderRuntimeSettings(), {
  enabled: true,
  desktopEnabled: true,
  browserlessEnabled: true,
});

const fallback = await getCleanTextFromUrl('https://example.com/fallback', { userId: 701 });
assert.match(fallback, /Browserless fallback content/);
assert.equal(browserlessRequests, 1);

let desktopClient: any;
desktopClient = {
  ws: {
    readyState: 1,
    send(raw: string, callback?: (error?: Error) => void) {
      callback?.();
      const message = JSON.parse(raw);
      if (message.type !== 'execute_ipc') return;
      setTimeout(() => desktopClient.pendingIpc.get(message.request_id)?.resolve({
        status: 'success',
        title: 'Desktop page',
        url: 'https://example.com/desktop',
        text: 'Desktop Chromium content',
        elements: [{ text: 'Reference', href: 'https://example.com/reference' }],
      }), 0);
    },
  },
  accessToken: 'test',
  accountId: 701,
  pendingIpc: new Map(),
  connectionId: 'test-desktop',
  connectedAt: Date.now(),
  lastMessageAt: Date.now(),
  lastPingAt: Date.now(),
  lastPongAt: Date.now(),
  missedPongs: 0,
  authRefreshInFlight: false,
};
registerWsClient(desktopClient);

const desktop = await getCleanTextFromUrl('https://example.com/desktop', { userId: 701, chatId: 9 });
assert.match(desktop, /Desktop Chromium content/);
assert.match(desktop, /https:\/\/example.com\/reference/);
assert.equal(browserlessRequests, 1, 'desktop success must not call Browserless');

updateWebReaderRuntimeSettings({ desktopEnabled: false });
const browserlessOnly = await getCleanTextFromUrl('https://example.com/browserless-only', { userId: 701 });
assert.match(browserlessOnly, /Browserless fallback content/);
assert.equal(browserlessRequests, 2);

const stats = getWebReaderStats().providers;
assert.equal(stats.find(row => row.provider === 'desktop')?.attempts, 2);
assert.equal(stats.find(row => row.provider === 'desktop')?.successes, 1);
assert.equal(stats.find(row => row.provider === 'desktop')?.unavailableFailures, 1);
assert.equal(stats.find(row => row.provider === 'browserless')?.successes, 2);

updateWebReaderRuntimeSettings({ enabled: false });
await assert.rejects(
  getCleanTextFromUrl('https://example.com/disabled', { userId: 701 }),
  /web_reader_disabled/,
);

updateWebReaderRuntimeSettings({ enabled: true, desktopEnabled: false, browserlessEnabled: false });
await assert.rejects(
  getCleanTextFromUrl('https://example.com/no-provider', { userId: 701 }),
  /web_reader_no_provider_available/,
);

await assert.rejects(getCleanTextFromUrl('http://127.0.0.1/private', { userId: 701 }), /unsafe_url/);

unregisterWsClient(desktopClient);
console.log('web-reader fallback test passed');
db.close();
rmSync(testDbPath, { force: true });
