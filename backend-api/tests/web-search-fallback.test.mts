import assert from 'node:assert/strict';

process.env.SEARXNG_ENABLED = 'false';
process.env.TAVILY_API_KEY = 'test-key';

let requestCount = 0;
let requestBody: Record<string, unknown> | null = null;
globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  requestCount += 1;
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
assert.equal(requestCount, 1);
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
assert.equal(requestCount, 1, 'cached Tavily pagination must not call the API again');
assert.equal(quotaChecks, 1);
assert.equal(quotaConsumes, 1);
assert.match(secondPage, /Result 2/);
assert.match(secondPage, /No more results are available/);

const blocked = await runWebSearch('blocked fallback', {
  ...options,
  tavilyQuota: { check: () => 'Tavily quota blocked.', consume: () => assert.fail('blocked request was consumed') },
});
assert.equal(blocked, 'Tavily quota blocked.');
assert.equal(requestCount, 1, 'quota must be checked before calling Tavily');

await runWebSearch('encyclopedia fallback', {
  userId: options.userId,
  chatId: options.chatId,
  wikipedia: true,
  language: 'en',
  tavilyQuota: options.tavilyQuota,
});
assert.deepEqual(requestBody?.include_domains, ['wikipedia.org']);

console.log('web-search fallback test passed');
