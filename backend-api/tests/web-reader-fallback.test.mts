import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDbPath = join(tmpdir(), `chatter-web-reader-${process.pid}-${Date.now()}.db`);
process.env.API_DB_PATH = testDbPath;
process.env.BROWSERLESS_TOKEN = 'test-token';

let browserlessRequests = 0;
let browserlessQuotaChecks = 0;
let browserlessQuotaConsumes = 0;
const browserlessQuota = {
  check: () => {
    browserlessQuotaChecks += 1;
    return null;
  },
  consume: () => {
    browserlessQuotaConsumes += 1;
  },
};
globalThis.fetch = (async (input, init) => {
  browserlessRequests += 1;
  assert.match(String(input), /\/stealth\/bql\?/);
  assert.match(String(input), /timeout=25000/);
  const request = JSON.parse(String(init?.body || '{}'));
  assert.match(request.query, /evaluate\(content: \$extractor\)/);
  assert.doesNotMatch(request.query, /\bsolve\s*\(/);
  assert.match(request.variables.extractor, /^\(\(\) => \{/);
  assert.match(request.variables.extractor, /\}\)\(\)$/);
  const target = request?.variables?.target || 'https://example.com/fallback';
  const text = target.includes('/fallback')
    ? `Browserless fallback content ${'B'.repeat(31_000)}`
    : 'Browserless fallback content';
  return new Response(JSON.stringify({
    data: {
      goto: { status: 200 },
      extract: {
        value: JSON.stringify({
          title: 'Browserless page',
          url: target,
          text,
          links: [{ text: 'Browserless reference', href: 'https://example.com/browserless-reference' }],
          truncated: false,
        }),
      },
    },
  }), {
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

const fallback = await getCleanTextFromUrl('https://example.com/fallback', { userId: 701, browserlessQuota });
assert.match(fallback, /Browserless fallback content/);
assert.equal(browserlessRequests, 1);
const fallbackCursor = fallback.match(/cursor "([^"]+)"/)?.[1];
assert.ok(fallbackCursor);
const fallbackNext = await getCleanTextFromUrl('https://example.com/fallback', {
  userId: 701,
  cursor: fallbackCursor,
  browserlessQuota,
});
assert.match(fallbackNext, /showing cached characters 15001-/);
assert.equal(browserlessRequests, 1, 'Browserless cursor must use the cached document');
await getCleanTextFromUrl('https://example.com/fallback', { userId: 701, browserlessQuota });
assert.equal(browserlessRequests, 1, 'repeating the URL must reuse the ten-minute cache');

let desktopClient: any;
let desktopRequests = 0;
desktopClient = {
  ws: {
    readyState: 1,
    send(raw: string, callback?: (error?: Error) => void) {
      callback?.();
      const message = JSON.parse(raw);
      if (message.type !== 'execute_ipc') return;
      desktopRequests += 1;
      setTimeout(() => desktopClient.pendingIpc.get(message.request_id)?.resolve({
        status: 'success',
        title: 'Desktop page',
        url: 'https://example.com/desktop',
        text: `Desktop Chromium content ${'D'.repeat(31_000)}`,
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
const desktopCursor = desktop.match(/cursor "([^"]+)"/)?.[1];
assert.ok(desktopCursor);
const desktopNext = await getCleanTextFromUrl('https://example.com/desktop', {
  userId: 701,
  chatId: 9,
  cursor: desktopCursor,
});
assert.match(desktopNext, /showing cached characters 15001-/);
assert.equal(desktopRequests, 1, 'desktop cursor must not invoke the desktop again');

updateWebReaderRuntimeSettings({ desktopEnabled: false });
const browserlessOnly = await getCleanTextFromUrl('https://example.com/browserless-only', { userId: 701, browserlessQuota });
assert.match(browserlessOnly, /Browserless fallback content/);
assert.equal(browserlessRequests, 2);
assert.equal(browserlessQuotaChecks, 2);
assert.equal(browserlessQuotaConsumes, 2);

await assert.rejects(
  getCleanTextFromUrl('https://example.com/browserless-blocked', {
    userId: 701,
    browserlessQuota: { check: () => 'Browserless limit exhausted.', consume: () => assert.fail('blocked quota consumed') },
  }),
  /Browserless limit exhausted/,
);
assert.equal(browserlessRequests, 2, 'exhausted quota must block the Browserless HTTP request');

const stats = getWebReaderStats().providers;
assert.equal(stats.find(row => row.provider === 'desktop')?.attempts, 2);
assert.equal(stats.find(row => row.provider === 'desktop')?.successes, 1);
assert.equal(stats.find(row => row.provider === 'desktop')?.unavailableFailures, 1);
assert.equal(stats.find(row => row.provider === 'desktop')?.cacheHits, 1);
assert.equal(stats.find(row => row.provider === 'browserless')?.successes, 2);
assert.equal(stats.find(row => row.provider === 'browserless')?.cacheHits, 2);

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
