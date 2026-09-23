import { Pinecone } from '@pinecone-database/pinecone';
import { db, getNowUnix } from '../db.js';
import { getVectorMemorySettings, updateVectorMemorySettings } from './vector-memory-settings.js';
import { ensureMemoryDefaults, type MemorySpace } from './memory-foundation.js';
import {
  assertQdrantReady,
  qdrantPointId,
  upsertQdrantVectors,
  verifyQdrantVectors,
} from './qdrant-memory.js';

export type SourceVector = { id: string; values: number[]; metadata?: Record<string, unknown> };
export type VectorMigrationSource = {
  kind: string;
  readNamespace(namespace: string): AsyncGenerator<SourceVector[]>;
};
export type VectorMigrationTarget = {
  kind: string;
  prepare(): Promise<void>;
  write(userId: number, space: MemorySpace, embeddingModel: string, vectors: SourceVector[]): Promise<string[]>;
  verify(ids: string[]): Promise<boolean>;
};

const apiKey = `${process.env.PINECONE_API_KEY || ''}`.trim();
const indexName = `${process.env.PINECONE_INDEX_NAME || 'bot-memory'}`.trim();
const embeddingModel = `${process.env.TIMEWEB_EMBED_MODEL || process.env.VECTOR_EMBED_MODEL || 'text-embedding-3-small'}`.trim();

const pineconeSource = (): VectorMigrationSource => {
  if (!apiKey) throw new Error('PINECONE_API_KEY is not configured');
  const index = new Pinecone({ apiKey }).index(indexName);
  return {
    kind: 'pinecone',
    async *readNamespace(namespace: string) {
      const scoped = index.namespace(namespace);
      let paginationToken: string | undefined;
      do {
        const page = await scoped.listPaginated({ limit: 100, ...(paginationToken ? { paginationToken } : {}) });
        const ids = (page.vectors || []).map(item => `${item.id || ''}`.trim()).filter(Boolean);
        if (ids.length) {
          const fetched = await scoped.fetch(ids);
          yield ids.map(id => fetched.records?.[id]).filter(Boolean).map(record => ({
            id: `${record!.id}`,
            values: Array.isArray(record!.values) ? record!.values : [],
            metadata: record!.metadata as Record<string, unknown> | undefined,
          }));
        }
        paginationToken = page.pagination?.next || undefined;
      } while (paginationToken);
    },
  };
};

const qdrantTarget = (): VectorMigrationTarget => ({
  kind: 'qdrant',
  prepare: assertQdrantReady,
  async write(userId, space, model, vectors) {
    return upsertQdrantVectors(userId, space, model, vectors);
  },
  verify: verifyQdrantVectors,
});

const recordIdForChunk = (chunkId: string) => chunkId.match(/^(.*)_chunk_\d+$/)?.[1] || chunkId;
const chunkIndexFor = (chunkId: string, metadata?: Record<string, unknown>) => {
  const fromMetadata = Number(metadata?.chunk_index);
  if (Number.isSafeInteger(fromMetadata) && fromMetadata >= 0) return fromMetadata;
  return Number(chunkId.match(/_chunk_(\d+)$/)?.[1] || 0);
};
const cleanChunkText = (text: string, source: string) => {
  const prefix = `[Контекст: ${source}] `;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
};

export const migrateVectorMemoryToQdrant = async (
  source: VectorMigrationSource = pineconeSource(),
  target: VectorMigrationTarget = qdrantTarget(),
) => {
  if (getVectorMemorySettings().storage !== 'pinecone') throw new Error('pinecone_is_not_active');
  await target.prepare();
  const users = db.prepare('SELECT id FROM users ORDER BY id').all() as Array<{ id: number }>;
  users.forEach(user => ensureMemoryDefaults(user.id));
  const spaces = db.prepare(`
    SELECT id, user_id, name, kind, chat_id, namespace_key, is_default, archived_at, created_at, updated_at
    FROM memory_spaces WHERE archived_at IS NULL ORDER BY user_id, id
  `).all() as MemorySpace[];
  const legacyByUser = db.prepare(`
    SELECT target_account_id, source_account_id FROM account_namespace_migrations
    WHERE status <> 'completed'
  `).all() as Array<{ target_account_id: number; source_account_id: number }>;
  const seen = new Set<string>();
  let sourceVectors = 0;
  let copiedVectors = 0;
  let records = 0;
  let expectedDimension: number | null = null;
  const now = getNowUnix();

  const upsertRecord = db.prepare(`
    INSERT INTO memory_records (id, user_id, memory_space_id, text, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET text = excluded.text, source = excluded.source, updated_at = excluded.updated_at
  `);
  const upsertChunk = db.prepare(`
    INSERT INTO memory_chunks (id, memory_record_id, user_id, memory_space_id, text, chunk_index, total_chunks, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET text = excluded.text, chunk_index = excluded.chunk_index,
      total_chunks = excluded.total_chunks, updated_at = excluded.updated_at
  `);

  for (const space of spaces) {
    const namespaces = new Set([space.namespace_key]);
    if (space.kind === 'general' && space.is_default === 1) {
      namespaces.add(String(space.user_id));
      legacyByUser.filter(row => row.target_account_id === space.user_id)
        .forEach(row => namespaces.add(String(row.source_account_id)));
    }
    const grouped = new Map<string, SourceVector[]>();
    for (const namespace of namespaces) {
      for await (const batch of source.readNamespace(namespace)) {
        for (const vector of batch) {
          if (!vector.id || !vector.values.length) throw new Error(`invalid_vector:${namespace}:${vector.id}`);
          if (expectedDimension === null) expectedDimension = vector.values.length;
          if (vector.values.length !== expectedDimension) {
            throw new Error(`vector_dimension_mismatch:${namespace}:${vector.id}:${vector.values.length}:${expectedDimension}`);
          }
          const identity = `${space.user_id}:${space.id}:${vector.id}`;
          if (seen.has(identity)) continue;
          seen.add(identity);
          sourceVectors += 1;
          const recordId = recordIdForChunk(vector.id);
          const group = grouped.get(recordId) || [];
          group.push({
            ...vector,
            metadata: { ...(vector.metadata || {}), record_id: recordId },
          });
          grouped.set(recordId, group);
        }
      }
    }

    const vectors = [...grouped.values()].flat();
    for (const [recordId, items] of grouped) {
      const existingRecord = db.prepare('SELECT user_id, memory_space_id FROM memory_records WHERE id = ?')
        .get(recordId) as { user_id: number; memory_space_id: number } | undefined;
      if (existingRecord && (existingRecord.user_id !== space.user_id || existingRecord.memory_space_id !== space.id)) {
        throw new Error(`record_id_scope_conflict:${recordId}`);
      }
      for (const item of items) {
        const existingChunk = db.prepare('SELECT user_id, memory_space_id, memory_record_id FROM memory_chunks WHERE id = ?')
          .get(item.id) as { user_id: number; memory_space_id: number; memory_record_id: string } | undefined;
        if (existingChunk && (
          existingChunk.user_id !== space.user_id
          || existingChunk.memory_space_id !== space.id
          || existingChunk.memory_record_id !== recordId
        )) {
          throw new Error(`chunk_id_scope_conflict:${item.id}`);
        }
      }
    }
    if (vectors.length) {
      const pointIds = await target.write(space.user_id, space, embeddingModel, vectors);
      if (pointIds.length !== vectors.length || !(await target.verify(pointIds))) {
        throw new Error(`vector_migration_verification_failed:${sourceVectors}:${copiedVectors}`);
      }
      copiedVectors += vectors.length;
    }

    db.transaction(() => {
      for (const [recordId, items] of grouped) {
        const sorted = items.sort((a, b) => chunkIndexFor(a.id, a.metadata) - chunkIndexFor(b.id, b.metadata));
        const sourceTag = `${sorted[0]?.metadata?.source || 'memory'}`.slice(0, 240);
        const createdAt = Number(sorted[0]?.metadata?.timestamp) || now;
        const text = sorted.map(item => cleanChunkText(`${item.metadata?.text || ''}`, sourceTag)).join('\n\n').trim();
        upsertRecord.run(recordId, space.user_id, space.id, text, sourceTag, createdAt, now);
        sorted.forEach((item, index) => {
          upsertChunk.run(
            item.id,
            recordId,
            space.user_id,
            space.id,
            `${item.metadata?.text || ''}`,
            chunkIndexFor(item.id, item.metadata) || index,
            sorted.length,
            createdAt,
            now,
          );
        });
        records += 1;
      }
    })();
  }

  if (copiedVectors !== sourceVectors) {
    throw new Error(`vector_migration_verification_failed:${sourceVectors}:${copiedVectors}`);
  }
  updateVectorMemorySettings({ storage: 'qdrant' });
  return {
    ok: true,
    source: source.kind,
    target: target.kind,
    source_vectors: sourceVectors,
    copied_vectors: copiedVectors,
    records,
    verified: true,
  };
};

export const qdrantMigrationPointId = qdrantPointId;
