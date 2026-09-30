import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.API_DB_PATH = path.join(os.tmpdir(), `chatter-vector-reranking-${process.pid}-${Date.now()}.sqlite`);
process.env.ENCRYPTION_KEY = 'vector-reranking-test-encryption-key';

const { db } = await import('../src/db.js');
const { rerankMemoryGroups } = await import('../src/services/vector-memory.js');

db.prepare('INSERT INTO users (id, name, language) VALUES (?, ?, ?)').run(707, 'Ranking user', 'en');

const groups = [
  {
    record_id: 'memory-a',
    score: 0.91,
    fragments: [
      { id: 'a-1', chunk_id: 'a-1', score: 0.91, text: 'first matching fragment', source: 'test', timestamp: 1, chunk_index: 0, total_chunks: 4 },
      { id: 'a-2', chunk_id: 'a-2', score: 0.88, text: 'second matching fragment', source: 'test', timestamp: 1, chunk_index: 1, total_chunks: 4 },
    ],
  },
  {
    record_id: 'memory-b',
    score: 0.84,
    fragments: [
      { id: 'b-1', chunk_id: 'b-1', score: 0.84, text: 'another candidate', source: 'test', timestamp: 2, chunk_index: 3, total_chunks: 8 },
    ],
  },
  {
    record_id: 'memory-c',
    score: 0.79,
    fragments: [
      { id: 'c-1', chunk_id: 'c-1', score: 0.79, text: 'weak candidate', source: 'test', timestamp: 3, chunk_index: 0, total_chunks: 1 },
    ],
  },
];

let request: { url: string; init: RequestInit } | null = null;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  request = { url: String(url), init: init || {} };
  return new Response(JSON.stringify({
    provider: 'test-provider',
    results: [
      { index: 1, relevance_score: 0.93 },
      { index: 0, relevance_score: 0.72 },
      { index: 2, relevance_score: 0.12 },
    ],
    usage: { total_tokens: 42, search_units: 1 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

try {
  const settings = {
    storage: 'qdrant' as const,
    provider: 'custom' as const,
    baseUrl: 'https://embedding.example/v1',
    model: 'embedding-model',
    openrouterProviderSlug: null,
    inputPricePerMillion: null,
    apiKeyId: 1,
    activeCollection: 'memory',
    apiKey: 'embedding-secret',
    reranking: {
      enabled: true,
      provider: 'openrouter' as const,
      baseUrl: 'https://ranking.example/v1/',
      model: 'ranking-model',
      openrouterProviderSlug: 'ranking-provider',
      pricePerSearch: 0.004,
      apiKeyId: 2,
      minScore: 0.7,
      resultLimit: 2,
      apiKey: 'ranking-secret',
    },
  };

  const ranked = await rerankMemoryGroups('what matters?', groups, settings, 707);
  assert.deepEqual(ranked.map(group => group.record_id), ['memory-b', 'memory-a']);
  assert.deepEqual(ranked.map(group => group.score), [0.93, 0.72]);
  assert.deepEqual(ranked.map(group => group.vector_score), [0.84, 0.91]);

  assert.equal(request?.url, 'https://ranking.example/v1/rerank');
  assert.equal((request?.init.headers as Record<string, string>).Authorization, 'Bearer ranking-secret');
  const body = JSON.parse(String(request?.init.body));
  assert.equal(body.model, 'ranking-model');
  assert.equal(body.query, 'what matters?');
  assert.deepEqual(body.documents, [
    'first matching fragment\n\nsecond matching fragment',
    'another candidate',
    'weak candidate',
  ], 'only retrieved fragments, not complete memory records, are sent to the reranker');
  assert.equal(body.top_n, 2);
  assert.deepEqual(body.provider, { only: ['ranking-provider'], allow_fallbacks: false });

  const usage = db.prepare(`
    SELECT route, model_id, total_tokens, estimated_cost_usd, actual_cost_usd
    FROM user_token_usage WHERE user_id = ? ORDER BY id DESC LIMIT 1
  `).get(707) as {
    route: string;
    model_id: string;
    total_tokens: number;
    estimated_cost_usd: number | null;
    actual_cost_usd: number | null;
  };
  assert.equal(usage.route, 'memory:rerank');
  assert.equal(usage.model_id, 'ranking-model');
  assert.equal(usage.total_tokens, 42);
  assert.equal(usage.actual_cost_usd, 0.004, 'configured per-search price is used when provider omits usage.cost');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('vector memory reranking tests passed');
