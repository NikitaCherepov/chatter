import { createHash } from 'node:crypto';
import { QdrantClient } from '@qdrant/js-client-rest';
import type { MemorySpace } from './memory-foundation.js';

const QDRANT_URL = `${process.env.QDRANT_URL || 'http://127.0.0.1:6333'}`.trim();
const QDRANT_API_KEY = `${process.env.QDRANT_API_KEY || ''}`.trim();
export const QDRANT_COLLECTION = `${process.env.QDRANT_COLLECTION || 'chatter_memory'}`.trim();

export type QdrantVectorInput = {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
};

let client: QdrantClient | null = null;
let knownDimension: number | null = null;

export const getQdrantClient = () => {
  if (!client) {
    client = new QdrantClient({
      url: QDRANT_URL,
      ...(QDRANT_API_KEY ? { apiKey: QDRANT_API_KEY } : {}),
    });
  }
  return client;
};

const isAlreadyExists = (error: unknown) =>
  error instanceof Error && /(already exists|conflict|409)/i.test(error.message);

const vectorSizeFromCollection = (collection: unknown) => {
  const vectors = (collection as any)?.config?.params?.vectors;
  return Number(vectors?.size || 0);
};

const ensurePayloadIndexes = async () => {
  const qdrant = getQdrantClient();
  const indexes: Array<[string, 'integer' | 'keyword']> = [
    ['user_id', 'integer'],
    ['memory_space_id', 'integer'],
    ['embedding_model', 'keyword'],
  ];
  for (const [field_name, field_schema] of indexes) {
    try {
      await qdrant.createPayloadIndex(QDRANT_COLLECTION, { field_name, field_schema, wait: true });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }
};

export const assertQdrantReady = async () => {
  await getQdrantClient().getCollections();
};

export const ensureQdrantCollection = async (dimension: number) => {
  if (!Number.isSafeInteger(dimension) || dimension <= 0) throw new Error('invalid_vector_dimension');
  if (knownDimension !== null) {
    if (knownDimension !== dimension) throw new Error(`qdrant_dimension_mismatch:${knownDimension}:${dimension}`);
    return;
  }
  const qdrant = getQdrantClient();
  const exists = await qdrant.collectionExists(QDRANT_COLLECTION);
  if (!exists.exists) {
    try {
      await qdrant.createCollection(QDRANT_COLLECTION, {
        vectors: { size: dimension, distance: 'Cosine', on_disk: true },
        hnsw_config: { on_disk: true },
        on_disk_payload: true,
      });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }
  const collection = await qdrant.getCollection(QDRANT_COLLECTION);
  const actualDimension = vectorSizeFromCollection(collection);
  if (actualDimension !== dimension) {
    throw new Error(`qdrant_dimension_mismatch:${actualDimension}:${dimension}`);
  }
  knownDimension = actualDimension;
  await ensurePayloadIndexes();
};

export const qdrantPointId = (userId: number, memorySpaceId: number, chunkId: string) => {
  const hex = createHash('sha256')
    .update(`${Math.floor(userId)}:${Math.floor(memorySpaceId)}:${chunkId}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
};

export const upsertQdrantVectors = async (
  userId: number,
  space: Pick<MemorySpace, 'id'>,
  embeddingModel: string,
  vectors: QdrantVectorInput[],
) => {
  if (!vectors.length) return [];
  const dimension = vectors[0].values.length;
  if (vectors.some(vector => !vector.values.length || vector.values.length !== dimension)) {
    throw new Error('vector_dimension_mismatch');
  }
  await ensureQdrantCollection(dimension);
  const pointIds = vectors.map(vector => qdrantPointId(userId, space.id, vector.id));
  const points = vectors.map((vector, index) => ({
    id: pointIds[index],
    vector: vector.values,
    payload: {
      ...(vector.metadata || {}),
      chunk_id: vector.id,
      record_id: `${vector.metadata?.record_id || vector.id.match(/^(.*)_chunk_\d+$/)?.[1] || vector.id}`,
      user_id: Math.floor(userId),
      memory_space_id: space.id,
      embedding_model: embeddingModel,
    },
  }));
  for (let offset = 0; offset < points.length; offset += 100) {
    await getQdrantClient().upsert(QDRANT_COLLECTION, {
      wait: true,
      points: points.slice(offset, offset + 100),
    });
  }
  return pointIds;
};

export const verifyQdrantVectors = async (pointIds: string[]) => {
  if (!pointIds.length) return true;
  const found = new Set<string>();
  for (let offset = 0; offset < pointIds.length; offset += 256) {
    const points = await getQdrantClient().retrieve(QDRANT_COLLECTION, {
      ids: pointIds.slice(offset, offset + 256),
      with_payload: false,
      with_vector: false,
    });
    points.forEach(point => found.add(`${point.id}`));
  }
  return found.size === new Set(pointIds).size;
};

export const deleteQdrantChunks = async (userId: number, memorySpaceId: number, chunkIds: string[]) => {
  if (!chunkIds.length) return;
  await getQdrantClient().delete(QDRANT_COLLECTION, {
    wait: true,
    points: chunkIds.map(chunkId => qdrantPointId(userId, memorySpaceId, chunkId)),
  });
};

export const deleteQdrantUser = async (userId: number) => {
  const exists = await getQdrantClient().collectionExists(QDRANT_COLLECTION);
  if (!exists.exists) return;
  await getQdrantClient().delete(QDRANT_COLLECTION, {
    wait: true,
    filter: { must: [{ key: 'user_id', match: { value: Math.floor(userId) } }] },
  });
};

export const queryQdrantVectors = async (
  userId: number,
  spaces: Array<Pick<MemorySpace, 'id'>>,
  embeddingModel: string,
  queryVector: number[],
  limit: number,
) => {
  await ensureQdrantCollection(queryVector.length);
  const result = await getQdrantClient().query(QDRANT_COLLECTION, {
    query: queryVector,
    limit,
    with_payload: true,
    with_vector: false,
    filter: {
      must: [
        { key: 'user_id', match: { value: Math.floor(userId) } },
        { key: 'memory_space_id', match: { any: spaces.map(space => space.id) } },
        { key: 'embedding_model', match: { value: embeddingModel } },
      ],
    },
  });
  return result.points;
};
