import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

process.env.API_DB_PATH = path.join(os.tmpdir(), `chatter-map-${process.pid}-${Date.now()}.sqlite`);
const requests: any[] = [];
const mock = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/') { res.end(JSON.stringify({ version: '1.19.0' })); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  const request = JSON.parse(body); requests.push(request);
  res.end(JSON.stringify({ status: 'ok', time: 0, result: request.ids.map((id: string, index: number) => ({
    id, vector: index ? [0, 1, 0] : [1, 0, 0], payload: { chunk_id: `record_chunk_${index}`, record_id: 'record', embedding_model: 'test' },
  })) }));
});
await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
process.env.QDRANT_URL = `http://127.0.0.1:${(mock.address() as any).port}`;
const { db } = await import('../src/db.js');
try {
  const { createGeneralMemorySpace, createMemoryRecord } = await import('../src/services/memory-foundation.js');
  const { VectorMemoryService } = await import('../src/services/vector-memory.js');
  for (const id of [8001, 8002]) db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(id, `User ${id}`);
  const space = createGeneralMemorySpace(8001, 'Map test');
  createMemoryRecord({ id: 'record', userId: 8001, spaceId: space.id, text: 'Whole memory', source: 'test', chunks: [
    { id: 'record_chunk_0', text: 'First', index: 0 }, { id: 'record_chunk_1', text: 'Second', index: 1 },
  ] });
  const records = await VectorMemoryService.listRecords(8001, space);
  assert.equal(requests.length, 0, 'ordinary list does not fetch vectors');
  const vectors = await VectorMemoryService.listMapVectors(8001, space, records.map(record => record.id));
  assert.equal(vectors.length, 1);
  assert.equal(vectors[0].record_id, 'record');
  assert(Math.abs(vectors[0].values[0] - Math.SQRT1_2) < 1e-9);
  assert.equal(requests[0].with_vector, true);
  assert.equal(requests[0].ids.length, 2, 'all fragments contribute to the single point');
  await assert.rejects(() => VectorMemoryService.listMapVectors(8002, space, ['record']), /memory_space_not_found/);
  assert.equal(requests.length, 1, 'foreign-account access fails before Qdrant');
  assert.deepEqual(await VectorMemoryService.listMapVectors(8001, space, []), []);
  assert.equal(requests.length, 1, 'empty maps make no vector request');
  console.log('memory map data retrieval, lazy loading and account isolation tests passed');
} finally {
  db.close();
  await new Promise<void>(resolve => mock.close(() => resolve()));
}
