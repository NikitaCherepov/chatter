import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-memory-limits-'));
let vectorLimit = 0;
let rerankLimit = 0;
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const part of req) raw += part;
  const body = raw ? JSON.parse(raw) : {};
  let json: any;
  if (req.url === '/v1/embeddings') {
    const embedding = body.encoding_format === 'base64' ? Buffer.from(new Float32Array([0.1, 0.2]).buffer).toString('base64') : [0.1, 0.2];
    json = { object: 'list', data: [{ object: 'embedding', index: 0, embedding }], model: 'test-embedding', usage: { prompt_tokens: 1, total_tokens: 1 } };
  } else if (req.url === '/v1/rerank') {
    rerankLimit = body.top_n;
    // Deliberately return every candidate: the backend still enforces the count.
    json = { results: body.documents.map((_: string, index: number) => ({ index, relevance_score: 0.9 })), usage: { total_tokens: 1 } };
  } else if (req.url?.includes('/points/query/groups')) {
    vectorLimit = body.limit;
    json = { result: { groups: Array.from({ length: body.limit }, (_, i) => ({
      id: 'memory-' + i, hits: [{ id: i + 1, score: 0.9, payload: {
        chunk_id: 'memory-' + i + '_chunk_0', text: 'Fact ' + i, source: 'test', chunk_index: 0, total_chunks: 1,
      } }],
    })) }, status: 'ok', time: 0 };
  } else if (req.url?.endsWith('/exists')) {
    json = { result: { exists: true }, status: 'ok', time: 0 };
  } else if (req.method === 'GET' && req.url?.startsWith('/collections/')) {
    json = { result: { config: { params: { vectors: { size: 2, distance: 'Cosine' } } } }, status: 'ok', time: 0 };
  } else if (req.url === '/') {
    json = { version: '1.19.0' };
  } else if (req.method === 'PUT' && req.url?.includes('/index')) {
    json = { result: { operation_id: 1, status: 'completed' }, status: 'ok', time: 0 };
  } else {
    throw new Error('Unexpected test request: ' + req.method + ' ' + req.url);
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(json));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + (server.address() as any).port;
process.env.API_DB_PATH = path.join(directory, 'test.sqlite');
process.env.ENCRYPTION_KEY = 'memory-limit-test-key';
process.env.QDRANT_URL = origin;
process.env.TIMEWEB_EMBED_BASE_URL = origin + '/v1';
process.env.TIMEWEB_EMBED_API_KEY = 'fake-test-key';
process.env.TIMEWEB_EMBED_MODEL = 'test-embedding';
process.env.VECTOR_MEMORY_STORAGE = 'qdrant';
const { db } = await import('../src/db.js');
const { VectorMemoryService } = await import('../src/services/vector-memory.js');
const { getVectorMemorySettings, updateVectorMemorySettings } = await import('../src/services/vector-memory-settings.js');
try {
  db.prepare("INSERT INTO users (id, name) VALUES (101, 'Test')").run();
  const settings = getVectorMemorySettings();
  updateVectorMemorySettings({ reranking: { enabled: false, resultLimit: 7 } });
  let result = await VectorMemoryService.search(101, 'question');
  assert.equal(vectorLimit, 7);
  assert.equal(result.groups.length, 7);
  result = await VectorMemoryService.search(101, 'question', 20, undefined, undefined, { resultLimit: 9 });
  assert.equal(vectorLimit, 9, 'explicit tool count cannot exceed personal limit');
  assert.equal(result.groups.length, 9);
  result = await VectorMemoryService.search(101, 'question', 2, undefined, undefined, { resultLimit: 9 });
  assert.equal(result.groups.length, 2, 'tool can request fewer memories');
  updateVectorMemorySettings({ reranking: { enabled: true, provider: 'custom', baseUrl: origin + '/v1', model: 'test-reranker', apiKeyId: settings.apiKeyId, minScore: 0.1, resultLimit: 7 } });
  result = await VectorMemoryService.search(101, 'question', undefined, undefined, undefined, { resultLimit: 9 });
  assert.equal(vectorLimit, 20, 'reranking always receives up to 20 candidates');
  assert.equal(rerankLimit, 9);
  assert.equal(result.groups.length, 9, 'backend enforces personal count after reranking');
  result = await VectorMemoryService.search(101, 'question', 2, undefined, undefined, { resultLimit: 9 });
  assert.equal(vectorLimit, 20);
  assert.equal(rerankLimit, 2);
  assert.equal(result.groups.length, 2);
  result = await VectorMemoryService.search(101, 'question');
  assert.equal(rerankLimit, 7);
  assert.equal(result.groups.length, 7, 'search without personal override follows admin count');
  console.log('vector memory result limit tests passed');
} finally {
  db.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(directory, { recursive: true, force: true });
}
