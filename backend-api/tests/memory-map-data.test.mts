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
  const { parseMemoryPage } = await import('../src/services/memory-record-pages.js');
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
  const other = createGeneralMemorySpace(8001, 'Other');
  createMemoryRecord({ id: 'other-record', userId: 8001, spaceId: other.id, text: 'Other space', source: 'test', chunks: [] });
  for (let i = 0; i < 205; i++) createMemoryRecord({ id: `paged-${String(i).padStart(3, '0')}`, userId: 8001, spaceId: space.id, text: i === 3 ? 'МАЯК вдали' : `Memory ${i}`, source: 'test', chunks: [] });
  const first = await VectorMemoryService.listRecordPage(8001, space, { limit: '100', offset: '0' });
  const second = await VectorMemoryService.listRecordPage(8001, space, { limit: '100', offset: '100' });
  const last = await VectorMemoryService.listRecordPage(8001, space, { limit: '100', offset: '200' });
  assert.equal(first.total, 206); assert.equal(first.records.length, 100); assert.equal(second.records.length, 100);
  assert.equal(last.records.length, 6); assert.equal(last.nextOffset, null);
  assert.equal(new Set([...first.records, ...second.records, ...last.records].map(record => record.id)).size, 206);
  const found = await VectorMemoryService.listRecordPage(8001, space, { query: 'маяк' });
  assert.equal(found.total, 1, 'Unicode text search covers every page');
  assert.equal(found.records[0].id, 'paged-003');
  assert.deepEqual(VectorMemoryService.searchRecords(8001, space.id, ['other-record', 'paged-003']).map(record => record!.id), ['paged-003'], 'semantic result hydration stays in exact space');
  assert.deepEqual(VectorMemoryService.searchRecords(8002, space.id, ['paged-003']), []);
  await assert.rejects(() => VectorMemoryService.listRecordPage(8002, space, {}), /memory_space_not_found/);
  for (const query of [{ limit: 0 }, { limit: 501 }, { offset: -1 }, { limit: 'abc' }, { query: 'x'.repeat(301) }]) assert.throws(() => parseMemoryPage(query), /bad_memory_pagination/);
  console.log('memory map data retrieval, lazy loading and account isolation tests passed');
} finally {
  db.close();
  await new Promise<void>(resolve => mock.close(() => resolve()));
}
