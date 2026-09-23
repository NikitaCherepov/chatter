import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.API_DB_PATH = path.join(os.tmpdir(), `chatter-vector-migration-${process.pid}-${Date.now()}.sqlite`);

const { db } = await import('../src/db.js');
const { ensureMemoryDefaults } = await import('../src/services/memory-foundation.js');
const { migrateVectorMemoryToQdrant } = await import('../src/services/vector-memory-migration.js');
const { getVectorMemorySettings, updateVectorMemorySettings } = await import('../src/services/vector-memory-settings.js');

assert.equal(
  db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'memory_vectors'").get().count,
  0,
  'obsolete SQLite vector table must not exist',
);

db.prepare('INSERT INTO users (id, name, language) VALUES (?, ?, ?)').run(101, 'Migration user', 'en');
ensureMemoryDefaults(101);

const source = {
  kind: 'test-pinecone',
  async *readNamespace(namespace: string) {
    if (namespace !== '101') return;
    yield [
      { id: 'fact_old_chunk_0', values: [0.1, 0.2, 0.3], metadata: { text: '[Контекст: legacy] Первая часть', source: 'legacy', timestamp: 100, chunk_index: 0, total_chunks: 2 } },
      { id: 'fact_old_chunk_1', values: [0.4, 0.5, 0.6], metadata: { text: '[Контекст: legacy] Вторая часть', source: 'legacy', timestamp: 100, chunk_index: 1, total_chunks: 2 } },
    ];
  },
};

const copied = new Map<string, { id: string; values: number[] }>();
const target = {
  kind: 'test-qdrant',
  async prepare() {},
  async write(userId: number, space: { id: number }, _model: string, vectors: Array<{ id: string; values: number[] }>) {
    return vectors.map(vector => {
      const pointId = `${userId}:${space.id}:${vector.id}`;
      copied.set(pointId, vector);
      return pointId;
    });
  },
  async verify(ids: string[]) {
    return ids.every(id => copied.has(id));
  },
};

const result = await migrateVectorMemoryToQdrant(source, target);
assert.equal(result.verified, true);
assert.equal(result.source_vectors, 2);
assert.equal(result.copied_vectors, 2);
assert.equal(getVectorMemorySettings().storage, 'qdrant', 'storage switches only after verification');
assert.equal(copied.size, 2);
const record = db.prepare('SELECT text, source FROM memory_records WHERE id = ?').get('fact_old') as { text: string; source: string };
assert.equal(record.source, 'legacy');
assert.equal(record.text, 'Первая часть\n\nВторая часть');
assert.equal((db.prepare('SELECT COUNT(*) AS count FROM memory_chunks WHERE memory_record_id = ?').get('fact_old') as { count: number }).count, 2);

updateVectorMemorySettings({ storage: 'pinecone' });
const invalidSource = {
  kind: 'invalid-test-pinecone',
  async *readNamespace(namespace: string) {
    if (namespace !== '101') return;
    yield [
      { id: 'bad_chunk_0', values: [0.1, 0.2], metadata: { text: 'Первая часть' } },
      { id: 'bad_chunk_1', values: [0.3, 0.4, 0.5], metadata: { text: 'Вторая часть' } },
    ];
  },
};
await assert.rejects(() => migrateVectorMemoryToQdrant(invalidSource, target), /vector_dimension_mismatch/);
assert.equal(getVectorMemorySettings().storage, 'pinecone', 'failed migration must not switch storage');

const unverifiableSource = {
  kind: 'unverifiable-test-pinecone',
  async *readNamespace(namespace: string) {
    if (namespace !== '101') return;
    yield [{ id: 'unverified_chunk_0', values: [0.1, 0.2, 0.3], metadata: { text: 'Не подтверждено' } }];
  },
};
const unverifiableTarget = {
  ...target,
  kind: 'unverifiable-test-qdrant',
  async verify() { return false; },
};
await assert.rejects(() => migrateVectorMemoryToQdrant(unverifiableSource, unverifiableTarget), /vector_migration_verification_failed/);
assert.equal(getVectorMemorySettings().storage, 'pinecone', 'unverified target must not become active');

console.log('vector memory migration tests passed');
