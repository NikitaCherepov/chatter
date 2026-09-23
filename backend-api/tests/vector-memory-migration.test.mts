import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.API_DB_PATH = path.join(os.tmpdir(), `chatter-vector-migration-${process.pid}-${Date.now()}.sqlite`);

const { db } = await import('../src/db.js');
const { ensureMemoryDefaults } = await import('../src/services/memory-foundation.js');
const { migrateVectorMemoryToSqlite } = await import('../src/services/vector-memory-migration.js');
const { getVectorMemorySettings, updateVectorMemorySettings } = await import('../src/services/vector-memory-settings.js');

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

const result = await migrateVectorMemoryToSqlite(source);
assert.equal(result.verified, true);
assert.equal(result.source_vectors, 2);
assert.equal(result.copied_vectors, 2);
assert.equal(getVectorMemorySettings().storage, 'sqlite', 'storage switches only after verification');
assert.equal((db.prepare('SELECT COUNT(*) AS count FROM memory_vectors').get() as { count: number }).count, 2);
const record = db.prepare('SELECT text, source FROM memory_records WHERE id = ?').get('fact_old') as { text: string; source: string };
assert.equal(record.source, 'legacy');
assert.equal(record.text, 'Первая часть\n\nВторая часть');

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
await assert.rejects(() => migrateVectorMemoryToSqlite(invalidSource), /vector_dimension_mismatch/);
assert.equal(getVectorMemorySettings().storage, 'pinecone', 'failed migration must not switch storage');

console.log('vector memory migration tests passed');
