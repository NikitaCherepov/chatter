import OpenAI from 'openai';
import { db } from '../db.js';
import {
  activateVectorMemoryCollection,
  getVectorMemoryApiKey,
  getVectorMemoryRuntimeSettings,
  type VectorMemoryProvider,
  type VectorMemorySettings,
} from './vector-memory-settings.js';
import {
  deleteQdrantCollection,
  ensureQdrantCollection,
  getQdrantCollectionInfo,
  upsertQdrantVectors,
} from './qdrant-memory.js';

type MigrationInput = {
  provider?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  apiKeyId?: unknown;
};

type CollectionRow = {
  collection_name: string;
  provider: VectorMemoryProvider;
  base_url: string;
  model: string;
  api_key_id: number | null;
  dimension: number | null;
  point_count: number;
  status: 'active' | 'backup' | 'migrating' | 'failed';
  error: string | null;
  created_at: number;
  updated_at: number;
};

let migrationRunning = false;
let activeWriteOperations = 0;

// A running migration cannot survive a backend restart. Make interrupted
// targets removable instead of leaving an undeletable "migrating" row.
db.prepare(`
  UPDATE vector_memory_collections
  SET status = 'failed', error = COALESCE(error, 'migration_interrupted'), updated_at = ?
  WHERE status = 'migrating'
`).run(Date.now());

const collectionNameFor = (model: string) => {
  const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(-42) || 'model';
  return `chatter_memory_${slug}_${Date.now().toString(36)}`;
};

const parseCandidate = (input: MigrationInput) => {
  const current = getVectorMemoryRuntimeSettings();
  const provider: VectorMemoryProvider = input.provider === 'openrouter' ? 'openrouter' : 'custom';
  const baseUrl = `${input.baseUrl || ''}`.trim();
  const model = `${input.model || ''}`.trim();
  const apiKeyId = Number(input.apiKeyId);
  if (!baseUrl || !model) throw new Error('embedding_configuration_required');
  if (!Number.isInteger(apiKeyId) || apiKeyId <= 0) throw new Error('api_key_required');
  const apiKey = getVectorMemoryApiKey(apiKeyId);
  if (!apiKey) throw new Error('api_key_not_found');
  return { current, provider, baseUrl, model, apiKeyId, apiKey };
};

const embed = async (client: OpenAI, model: string, input: string[]) => {
  const response = await client.embeddings.create({ model, input } as any);
  const rows = Array.isArray(response.data) ? response.data : [];
  if (rows.length !== input.length) throw new Error('embedding_count_mismatch');
  const vectors = rows.map(row => Array.isArray(row.embedding) ? row.embedding.map(Number) : []);
  if (vectors.some(vector => !vector.length)) throw new Error('embedding_empty');
  return vectors;
};

export const isVectorMemoryMigrationRunning = () => migrationRunning;

export const beginVectorMemoryWrite = () => {
  if (migrationRunning) throw new Error('vector_memory_migration_in_progress');
  activeWriteOperations += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeWriteOperations = Math.max(0, activeWriteOperations - 1);
  };
};

export const listVectorMemoryCollections = async () => {
  const rows = db.prepare(`
    SELECT collection_name, provider, base_url, model, api_key_id, dimension, point_count,
           status, error, created_at, updated_at
    FROM vector_memory_collections
    ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'migrating' THEN 1 WHEN 'backup' THEN 2 ELSE 3 END,
             created_at DESC
  `).all() as CollectionRow[];
  for (const row of rows) {
    try {
      const info = await getQdrantCollectionInfo(row.collection_name);
      if (info && (info.dimension !== row.dimension || info.pointCount !== row.point_count)) {
        row.dimension = info.dimension;
        row.point_count = info.pointCount;
        db.prepare(`
          UPDATE vector_memory_collections SET dimension = ?, point_count = ?, updated_at = ?
          WHERE collection_name = ?
        `).run(info.dimension, info.pointCount, Date.now(), row.collection_name);
      }
    } catch {
      // Keep the persisted metadata visible even while Qdrant is unavailable.
    }
  }
  return rows.map(row => ({
    collectionName: row.collection_name,
    provider: row.provider,
    baseUrl: row.base_url,
    model: row.model,
    apiKeyId: row.api_key_id,
    dimension: row.dimension,
    pointCount: row.point_count,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
};

export const migrateVectorMemoryEmbedding = async (input: MigrationInput) => {
  if (migrationRunning) throw new Error('vector_memory_migration_in_progress');
  if (activeWriteOperations > 0) throw new Error('vector_memory_writes_in_progress');
  const candidate = parseCandidate(input);
  migrationRunning = true;
  const collectionName = collectionNameFor(candidate.model);
  const now = Date.now();
  try {
    db.prepare(`
      INSERT INTO vector_memory_collections (
        collection_name, provider, base_url, model, api_key_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'migrating', ?, ?)
    `).run(collectionName, candidate.provider, candidate.baseUrl, candidate.model, candidate.apiKeyId, now, now);
    const client = new OpenAI({ apiKey: candidate.apiKey, baseURL: candidate.baseUrl });
    const probe = await embed(client, candidate.model, ['Chatter vector memory dimension check']);
    const dimension = probe[0].length;
    await ensureQdrantCollection(dimension, collectionName);

    const chunks = db.prepare(`
      SELECT c.id, c.user_id, c.memory_space_id, c.text, c.chunk_index, c.total_chunks,
             r.id AS record_id, r.source, r.created_at
      FROM memory_chunks c
      JOIN memory_records r ON r.id = c.memory_record_id
      WHERE r.deleted_at IS NULL
      ORDER BY c.memory_space_id, c.chunk_index, c.id
    `).all() as Array<{
      id: string;
      user_id: number;
      memory_space_id: number;
      text: string;
      chunk_index: number;
      total_chunks: number;
      record_id: string;
      source: string;
      created_at: number;
    }>;

    for (let offset = 0; offset < chunks.length; offset += 64) {
      const batch = chunks.slice(offset, offset + 64);
      const vectors = await embed(client, candidate.model, batch.map(chunk => chunk.text));
      const bySpace = new Map<string, typeof batch>();
      batch.forEach(chunk => {
        const key = `${chunk.user_id}:${chunk.memory_space_id}`;
        const items = bySpace.get(key) || [];
        items.push(chunk);
        bySpace.set(key, items);
      });
      for (const items of bySpace.values()) {
        const first = items[0];
        await upsertQdrantVectors(
          first.user_id,
          { id: first.memory_space_id },
          candidate.model,
          items.map(item => {
            const index = batch.indexOf(item);
            return {
              id: item.id,
              values: vectors[index],
              metadata: {
                text: item.text,
                source: item.source,
                timestamp: item.created_at,
                chunk_index: item.chunk_index,
                total_chunks: item.total_chunks,
                record_id: item.record_id,
              },
            };
          }),
          collectionName,
        );
      }
    }

    const info = await getQdrantCollectionInfo(collectionName);
    if (!info || info.dimension !== dimension || info.pointCount !== chunks.length) {
      throw new Error(`vector_migration_verification_failed:${chunks.length}:${info?.pointCount ?? 0}`);
    }

    const next: VectorMemorySettings = {
      storage: 'qdrant',
      provider: candidate.provider,
      baseUrl: candidate.baseUrl,
      model: candidate.model,
      apiKeyId: candidate.apiKeyId,
      activeCollection: collectionName,
    };
    activateVectorMemoryCollection(next);
    db.prepare(`
      UPDATE vector_memory_collections
      SET dimension = ?, point_count = ?, error = NULL, updated_at = ?
      WHERE collection_name = ?
    `).run(dimension, info.pointCount, Date.now(), collectionName);
    return { ok: true, collectionName, dimension, pointCount: info.pointCount };
  } catch (error) {
    try {
      db.prepare(`
        UPDATE vector_memory_collections SET status = 'failed', error = ?, updated_at = ?
        WHERE collection_name = ?
      `).run(error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000), Date.now(), collectionName);
    } catch {
      // The registry insert itself may have failed; preserve the original error.
    }
    throw error;
  } finally {
    migrationRunning = false;
  }
};

export const activateExistingVectorMemoryCollection = async (collectionName: string) => {
  if (migrationRunning) throw new Error('vector_memory_migration_in_progress');
  const row = db.prepare(`
    SELECT collection_name, provider, base_url, model, api_key_id, status
    FROM vector_memory_collections WHERE collection_name = ?
  `).get(collectionName) as CollectionRow | undefined;
  if (!row || row.status !== 'backup') throw new Error('vector_memory_backup_not_found');
  if (!getVectorMemoryApiKey(row.api_key_id)) throw new Error('api_key_not_found');
  // A backup is a safe rollback configuration, not a mutable mirror. Rebuild
  // it from canonical SQLite chunks so memories written after the original
  // migration are not lost when returning to the older model.
  return migrateVectorMemoryEmbedding({
    provider: row.provider,
    baseUrl: row.base_url,
    model: row.model,
    apiKeyId: row.api_key_id,
  });
};

export const removeVectorMemoryCollection = async (collectionName: string) => {
  if (migrationRunning) throw new Error('vector_memory_migration_in_progress');
  const row = db.prepare('SELECT status FROM vector_memory_collections WHERE collection_name = ?')
    .get(collectionName) as { status: string } | undefined;
  if (!row) throw new Error('vector_memory_collection_not_found');
  if (row.status === 'active' || row.status === 'migrating') throw new Error('active_vector_memory_collection_cannot_be_deleted');
  await deleteQdrantCollection(collectionName);
  db.prepare('DELETE FROM vector_memory_collections WHERE collection_name = ?').run(collectionName);
  return { ok: true };
};
