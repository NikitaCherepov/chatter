import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDbPath = join(tmpdir(), `chatter-web-search-${process.pid}-${Date.now()}.db`);
process.env.API_DB_PATH = testDbPath;
process.env.TAVILY_API_KEY = 'test-key';

let tavilyRequestCount = 0;
let requestBody: Record<string, unknown> | null = null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = `${input}`;
  if (url.includes('/search?') && init?.method !== 'POST') {
    return new Response(JSON.stringify({
      results: [
        { title: 'Google result', url: 'https://example.com/google', content: 'Found by Google', engines: ['google'] },
      ],
      unresponsive_engines: [['brave', 'CAPTCHA']],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  tavilyRequestCount += 1;
  requestBody = JSON.parse(`${init?.body || '{}'}`) as Record<string, unknown>;
  return new Response(JSON.stringify({
    answer: 'Test summary',
    request_id: 'test-request',
    usage: { credits: 1 },
    results: Array.from({ length: 7 }, (_, index) => ({
      title: `Result ${index + 1}`,
      url: `https://example.com/${index + 1}`,
      content: `Content ${index + 1}`,
      score: 1 - index / 10,
      published_date: `2026-09-${`${index + 1}`.padStart(2, '0')}`,
    })),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

const { db } = await import('../src/db.js');
const {
  getWebSearchStats,
  updateWebSearchRuntimeSettings,
} = await import('../src/services/web-search-runtime.js');
updateWebSearchRuntimeSettings({ searxngEnabled: false });
const { runWebSearch } = await import('../src/services/web-search.js');
let quotaChecks = 0;
let quotaConsumes = 0;
const options = {
  userId: 987654321,
  chatId: 123,
  searchType: 'news' as const,
  sort: 'date' as const,
  freshness: 'month' as const,
  language: 'en',
  tavilyQuota: {
    check: () => {
      quotaChecks += 1;
      return null;
    },
    consume: () => { quotaConsumes += 1; },
  },
};

const firstPage = await runWebSearch('fallback test', options);
assert.equal(tavilyRequestCount, 1);
assert.equal(quotaChecks, 1);
assert.equal(quotaConsumes, 1);
assert.equal(requestBody?.topic, 'news');
assert.equal(requestBody?.time_range, 'month');
assert.equal(requestBody?.max_results, 20);
assert.equal(requestBody?.include_answer, true);
assert.match(firstPage, /Result 7/);
assert.match(firstPage, /from tavily/);
const cursor = firstPage.match(/cursor "([^"]+)"/)?.[1];
assert.ok(cursor);

const secondPage = await runWebSearch('fallback test', { ...options, cursor });
assert.equal(tavilyRequestCount, 1, 'cached Tavily pagination must not call the API again');
assert.equal(quotaChecks, 1);
assert.equal(quotaConsumes, 1);
assert.match(secondPage, /Result 2/);
assert.match(secondPage, /No more results are available/);

const blocked = await runWebSearch('blocked fallback', {
  ...options,
  tavilyQuota: { check: () => 'Tavily quota blocked.', consume: () => assert.fail('blocked request was consumed') },
});
assert.equal(blocked, 'Tavily quota blocked.');
assert.equal(tavilyRequestCount, 1, 'quota must be checked before calling Tavily');

await runWebSearch('encyclopedia fallback', {
  userId: options.userId,
  chatId: options.chatId,
  wikipedia: true,
  language: 'en',
  tavilyQuota: options.tavilyQuota,
});
assert.deepEqual(requestBody?.include_domains, ['wikipedia.org']);

updateWebSearchRuntimeSettings({
  searxngEnabled: true,
  engines: { google: true, brave: true, duckduckgo: false, startpage: false, wikipedia: true },
});
const searxngResult = await runWebSearch('engine health test', options);
assert.match(searxngResult, /Google result/);
assert.equal(tavilyRequestCount, 2, 'SearXNG success must not call Tavily again');

const stats = getWebSearchStats();
const tavily = stats.providers.find(row => row.provider === 'tavily');
const google = stats.engines.find(row => row.engine === 'google');
const brave = stats.engines.find(row => row.engine === 'brave');
assert.equal(tavily?.successes, 2);
assert.equal(tavily?.resultsReturned, 14);
assert.equal(google?.successes, 1);
assert.equal(google?.resultsReturned, 1);
assert.equal(brave?.captchaFailures, 1);

updateWebSearchRuntimeSettings({ enabled: false });
const disabled = await runWebSearch('disabled search', options);
assert.match(disabled, /disabled by the administrator/);

console.log('web-search fallback test passed');
db.close();
rmSync(testDbPath, { force: true });
