import OpenAI from 'openai';
import { Pinecone } from '@pinecone-database/pinecone';
import { db } from '../db.js';
import { resolveAccountId } from './accounts.js';

const TIMEWEB_EMBED_API_KEY = `${process.env.TIMEWEB_EMBED_API_KEY || ''}`.trim();
const TIMEWEB_EMBED_BASE_URL = `${process.env.TIMEWEB_EMBED_BASE_URL || process.env.TIMEWEB_BASE_URL || 'https://api.timeweb.ai/v1'}`.trim();
const TIMEWEB_EMBED_MODEL = `${process.env.TIMEWEB_EMBED_MODEL || process.env.VECTOR_EMBED_MODEL || 'text-embedding-3-small'}`.trim();
const PINECONE_API_KEY = `${process.env.PINECONE_API_KEY || ''}`.trim();
const PINECONE_INDEX_NAME = `${process.env.PINECONE_INDEX_NAME || 'bot-memory'}`.trim();
const VECTOR_MEMORY_MAX_TEXT = Math.max(1, Number.parseInt(process.env.VECTOR_MEMORY_MAX_TEXT || '4000', 10) || 4000);
const VECTOR_MEMORY_MAX_QUERY = Math.max(1, Number.parseInt(process.env.VECTOR_MEMORY_MAX_QUERY || '1000', 10) || 1000);
const VECTOR_MEMORY_TOP_K_MAX = Math.max(1, Number.parseInt(process.env.VECTOR_MEMORY_TOP_K_MAX || '20', 10) || 20);
const VECTOR_MEMORY_CHUNK_SIZE = Math.max(100, Number.parseInt(process.env.VECTOR_MEMORY_CHUNK_SIZE || '1000', 10) || 1000);
const VECTOR_MEMORY_CHUNK_OVERLAP = Math.max(0, Number.parseInt(process.env.VECTOR_MEMORY_CHUNK_OVERLAP || '200', 10) || 200);
const VECTOR_MEMORY_LOG_SUCCESS = `${process.env.VECTOR_MEMORY_LOG_SUCCESS || '0'}`.trim() === '1';

let openaiClient: OpenAI | null = null;
let pineconeClient: Pinecone | null = null;

type NamespaceMigration = {
  source_account_id: number;
  target_account_id: number;
  status: 'pending' | 'failed' | 'completed';
  attempts: number;
};

const canonicalNamespace = (userId: number) => `${resolveAccountId(Math.floor(userId))}`;

const getReadableNamespaces = (userId: number) => {
  const accountId = resolveAccountId(Math.floor(userId));
  const rows = db.prepare(`
    SELECT source_account_id
    FROM account_namespace_migrations
    WHERE target_account_id = ? AND status <> 'completed'
    ORDER BY source_account_id ASC
  `).all(accountId) as Array<{ source_account_id: number }>;
  return [...new Set([`${accountId}`, ...rows.map(row => `${row.source_account_id}`)])];
};

const markNamespaceMigrationFailed = (sourceAccountId: number, error: unknown) => {
  db.prepare(`
    UPDATE account_namespace_migrations
    SET status = 'failed',
        attempts = attempts + 1,
        last_error = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE source_account_id = ?
  `).run(error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000), sourceAccountId);
};

const logSuccess = (message: string, payload?: Record<string, unknown>) => {
  if (!VECTOR_MEMORY_LOG_SUCCESS) return;
  if (payload) {
    console.log(`[vector-memory] ${message}`, payload);
    return;
  }
  console.log(`[vector-memory] ${message}`);
};

const logError = (message: string, payload?: Record<string, unknown>) => {
  if (payload) {
    console.error(`[vector-memory] ${message}`, payload);
    return;
  }
  console.error(`[vector-memory] ${message}`);
};

const isPineconeNotFoundError = (error: unknown) =>
  error instanceof Error
  && (
    error.name === 'PineconeNotFoundError'
    || /\bHTTP status 404\b/i.test(error.message)
  );

const deletePineconeResource = async (operation: () => Promise<void>) => {
  try {
    await operation();
    return 'deleted' as const;
  } catch (error) {
    // Pinecone returns 404 when a namespace or vector is already absent.
    // Delete operations are intentionally idempotent, so this is success.
    if (isPineconeNotFoundError(error)) return 'already_absent' as const;
    throw error;
  }
};

const getOpenAIClient = () => {
  if (!TIMEWEB_EMBED_API_KEY) {
    throw new Error('TIMEWEB_EMBED_API_KEY is not configured');
  }
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: TIMEWEB_EMBED_API_KEY,
      baseURL: TIMEWEB_EMBED_BASE_URL
    });
  }
  return openaiClient;
};

const getPineconeIndex = () => {
  if (!PINECONE_API_KEY) {
    throw new Error('PINECONE_API_KEY is not configured');
  }
  if (!PINECONE_INDEX_NAME) {
    throw new Error('PINECONE_INDEX_NAME is not configured');
  }
  if (!pineconeClient) {
    pineconeClient = new Pinecone({ apiKey: PINECONE_API_KEY });
  }
  return pineconeClient.index(PINECONE_INDEX_NAME);
};

const getEmbedding = async (text: string): Promise<number[]> => {
  const normalized = text.replace(/\n/g, ' ').trim();
  if (!normalized) throw new Error('text_required');
  const openai = getOpenAIClient();
  const response = await openai.embeddings.create({
    model: TIMEWEB_EMBED_MODEL,
    input: normalized
  } as any);
  const embedding = response?.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || !embedding.length) {
    throw new Error('embedding_empty');
  }
  return embedding as number[];
};

const chunkText = (text: string, chunkSize = VECTOR_MEMORY_CHUNK_SIZE, overlap = VECTOR_MEMORY_CHUNK_OVERLAP): string[] => {
  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let currentChunk = '';
  const safeOverlap = Math.max(0, Math.min(overlap, Math.max(0, chunkSize - 1)));

  for (const paragraphRaw of paragraphs) {
    const paragraph = `${paragraphRaw || ''}`.trim();
    if (!paragraph) continue;

    if (paragraph.length > chunkSize) {
      const sentences = paragraph.match(/[^.!?]+[.!?]+/g) || [paragraph];
      for (const sentenceRaw of sentences) {
        const sentence = `${sentenceRaw || ''}`.trim();
        if (!sentence) continue;
        if ((currentChunk + (currentChunk ? ' ' : '') + sentence).length > chunkSize && currentChunk.length > 0) {
          chunks.push(currentChunk.trim());
          currentChunk = `${currentChunk.slice(-safeOverlap)}${sentence}`;
        } else {
          currentChunk += (currentChunk ? ' ' : '') + sentence;
        }
      }
    } else if ((currentChunk + (currentChunk ? '\n\n' : '') + paragraph).length > chunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = `${currentChunk.slice(-safeOverlap)}\n\n${paragraph}`;
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks.length ? chunks : [text.trim()];
};

export class VectorMemoryService {
  static async saveFactBatched(userId: number, fullText: string, sourceTag: string) {
    try {
      const safeText = `${fullText || ''}`.trim();
      if (!safeText) throw new Error('text_required');
      if (safeText.length > VECTOR_MEMORY_MAX_TEXT) throw new Error(`text_too_long_max_${VECTOR_MEMORY_MAX_TEXT}`);

      const safeSource = `${sourceTag || ''}`.trim().slice(0, 240) || 'manual';
      const chunks = chunkText(safeText, VECTOR_MEMORY_CHUNK_SIZE, VECTOR_MEMORY_CHUNK_OVERLAP);
      const namespace = canonicalNamespace(userId);

      const openai = getOpenAIClient();

      const inputForEmbeddings = chunks.map(chunk => {
        // Приклеиваем тег к каждому чанку, чтобы каждый вектор "помнил" откуда он
        return `[Контекст: ${safeSource}] ${chunk}`.replace(/\n/g, ' ').trim();
      });
      const embedResponse = await openai.embeddings.create({
        model: TIMEWEB_EMBED_MODEL,
        input: inputForEmbeddings // <--- Отправляем обогащенные чанки
      } as any);

      const now = Math.floor(Date.now() / 1000);
      const baseId = `fact_${now}_${Math.random().toString(36).slice(2, 8)}`;
      const embeddings = Array.isArray(embedResponse?.data) ? embedResponse.data : [];
      if (!embeddings.length) throw new Error('embedding_empty');

      const records = embeddings.map((embedData: any, index: number) => {
        const values = Array.isArray(embedData?.embedding) ? embedData.embedding : [];
        if (!values.length) throw new Error('embedding_empty');
        return {
          id: `${baseId}_chunk_${index}`,
          values,
          metadata: {
            text: inputForEmbeddings[index] || '',
            source: safeSource,
            timestamp: now,
            chunk_index: index,
            total_chunks: chunks.length
          }
        };
      });

      const index = getPineconeIndex();
      await index.namespace(namespace).upsert(records as any);

      const result = {
        ok: true,
        id: baseId,
        record_id: baseId,
        chunk_ids: records.map(record => record.id),
        namespace,
        source: safeSource,
        size: safeText.length,
        chunks_saved: records.length,
        total_tokens_used: Number(embedResponse?.usage?.total_tokens || 0)
      };

      logSuccess('saveFactBatched ok', {
        user_id: Math.floor(userId),
        namespace,
        chunks_saved: result.chunks_saved,
        total_tokens_used: result.total_tokens_used
      });
      return result;
    } catch (error: any) {
      console.error('[vector-memory] FULL ERROR:', error?.response?.data || error?.message || error);
      console.error('[vector-memory] FULL ERROR META:', {
        status: error?.status || error?.response?.status || null,
        code: error?.code || error?.error?.code || null,
        stack: error?.stack || null
      });
      logError('saveFactBatched failed', {
        user_id: Math.floor(userId),
        error: `${error?.message || String(error)}`
      });
      throw error;
    }
  }

  static async saveChunk(userId: number, textChunk: string, sourceTag: string) {
    return this.saveFactBatched(userId, textChunk, sourceTag);
  }

  static async search(userId: number, query: string, topK = 3) {
    try {
      const safeQuery = `${query || ''}`.trim();
      if (!safeQuery) throw new Error('query_required');
      if (safeQuery.length > VECTOR_MEMORY_MAX_QUERY) throw new Error(`query_too_long_max_${VECTOR_MEMORY_MAX_QUERY}`);

      const safeTopK = Math.max(1, Math.min(VECTOR_MEMORY_TOP_K_MAX, Math.floor(Number(topK) || 3)));
      const namespace = canonicalNamespace(userId);
      const readableNamespaces = getReadableNamespaces(userId);
      const queryVector = await getEmbedding(safeQuery);
      const index = getPineconeIndex();

      const results = await Promise.all(readableNamespaces.map(readableNamespace =>
        index.namespace(readableNamespace).query({
          vector: queryVector,
          topK: safeTopK,
          includeMetadata: true
        } as any)
      ));

      const matchesById = new Map<string, any>();
      for (const result of results) {
        const matches = Array.isArray(result?.matches) ? result.matches : [];
        for (const match of matches) {
          const id = `${match?.id || ''}`;
          const previous = matchesById.get(id);
          if (!previous || Number(match?.score || 0) > Number(previous?.score || 0)) {
            matchesById.set(id, match);
          }
        }
      }
      const items = [...matchesById.values()]
        .sort((left, right) => Number(right?.score || 0) - Number(left?.score || 0))
        .slice(0, safeTopK)
        .map((match: any) => {
          const chunkId = `${match?.id || ''}`;
          return {
            id: chunkId,
            chunk_id: chunkId,
            score: Number(match?.score || 0),
            text: `${match?.metadata?.text || ''}`,
            source: `${match?.metadata?.source || ''}`,
            timestamp: Number(match?.metadata?.timestamp || 0)
          };
        });

      const joinedText = items
        .map(item => `[Источник: ${item.source || 'unknown'}]\n${item.text}`)
        .join('\n\n---\n\n');

      const out = {
        ok: true,
        namespace,
        top_k: safeTopK,
        matches: items,
        text: joinedText
      };

      logSuccess('search ok', {
        user_id: Math.floor(userId),
        namespace,
        top_k: safeTopK,
        matches_count: items.length
      });
      return out;
    } catch (error: any) {
      logError('search failed', {
        user_id: Math.floor(userId),
        error: `${error?.message || String(error)}`
      });
      throw error;
    }
  }

  static async deleteChunk(userId: number, chunkId: string) {
    try {
      const safeChunkId = `${chunkId || ''}`.trim();
      if (!safeChunkId) throw new Error('chunk_id_required');

      const namespace = canonicalNamespace(userId);
      const readableNamespaces = getReadableNamespaces(userId);
      const index = getPineconeIndex();

      const fetchedRecords = await Promise.all(readableNamespaces.map(async readableNamespace => {
        const result = await index.namespace(readableNamespace).fetch([safeChunkId]);
        return {
          namespace: readableNamespace,
          record: result.records?.[safeChunkId] || null
        };
      }));
      const existingRecords = fetchedRecords.filter(item => item.record);
      if (!existingRecords.length) throw new Error('chunk_not_found');

      const deletedIds = new Set<string>();
      const deletedNamespaces: string[] = [];
      await Promise.all(existingRecords.map(async ({ namespace: readableNamespace, record }) => {
        const ids = new Set<string>([safeChunkId]);
        const chunkIdMatch = safeChunkId.match(/^(.*)_chunk_(\d+)$/);
        const metadata = record?.metadata as Record<string, unknown> | undefined;
        const totalChunks = Number(metadata?.total_chunks);

        if (chunkIdMatch && Number.isSafeInteger(totalChunks) && totalChunks > 0 && totalChunks <= 10_000) {
          const recordId = chunkIdMatch[1];
          for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
            ids.add(`${recordId}_chunk_${chunkIndex}`);
          }
        }

        const idsToDelete = [...ids];
        await deletePineconeResource(() =>
          index.namespace(readableNamespace).deleteMany(idsToDelete)
        );
        idsToDelete.forEach(id => deletedIds.add(id));
        deletedNamespaces.push(readableNamespace);
      }));

      const recordIdMatch = safeChunkId.match(/^(.*)_chunk_\d+$/);

      const out = {
        ok: true,
        namespace,
        id: safeChunkId,
        chunk_id: safeChunkId,
        record_id: recordIdMatch?.[1] || safeChunkId,
        deleted_ids: [...deletedIds],
        chunks_deleted: deletedIds.size,
        namespaces_deleted: deletedNamespaces
      };
      logSuccess('deleteChunk ok', {
        user_id: Math.floor(userId),
        namespace,
        id: safeChunkId,
        chunks_deleted: out.chunks_deleted,
        namespaces_deleted: deletedNamespaces
      });
      return out;
    } catch (error: any) {
      logError('deleteChunk failed', {
        user_id: Math.floor(userId),
        error: `${error?.message || String(error)}`
      });
      throw error;
    }
  }

  static async deleteAll(userId: number) {
    try {
      const namespace = canonicalNamespace(userId);
      const readableNamespaces = getReadableNamespaces(userId);
      const index = getPineconeIndex();
      await Promise.all(readableNamespaces.map(readableNamespace =>
        deletePineconeResource(() =>
          index.namespace(readableNamespace).deleteAll()
        )
      ));

      const out = {
        ok: true,
        namespace,
        deleted_all: true
      };
      logSuccess('deleteAll ok', {
        user_id: Math.floor(userId),
        namespace
      });
      return out;
    } catch (error: any) {
      logError('deleteAll failed', {
        user_id: Math.floor(userId),
        error: `${error?.message || String(error)}`
      });
      throw error;
    }
  }
}

const migrateNamespace = async (migration: NamespaceMigration) => {
  const sourceAccountId = Math.floor(migration.source_account_id);
  const targetAccountId = resolveAccountId(migration.target_account_id);
  if (sourceAccountId === targetAccountId) {
    db.prepare(`
      UPDATE account_namespace_migrations
      SET status = 'completed',
          attempts = attempts + 1,
          last_error = NULL,
          completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE source_account_id = ?
    `).run(sourceAccountId);
    return;
  }

  const index = getPineconeIndex();
  const source = index.namespace(`${sourceAccountId}`);
  const target = index.namespace(`${targetAccountId}`);
  let paginationToken: string | undefined;
  let copied = 0;

  do {
    const page = await source.listPaginated({
      limit: 100,
      ...(paginationToken ? { paginationToken } : {}),
    });
    const ids = (page.vectors || [])
      .map(item => `${item.id || ''}`.trim())
      .filter(Boolean);
    if (ids.length > 0) {
      const fetched = await source.fetch(ids);
      const records = Object.values(fetched.records || {});
      if (records.length > 0) {
        await target.upsert(records as any);
        copied += records.length;
      }
    }
    paginationToken = page.pagination?.next || undefined;
  } while (paginationToken);

  // The source remains readable until every upsert has completed successfully.
  const sourceCleanup = await deletePineconeResource(() => source.deleteAll());
  db.prepare(`
    UPDATE account_namespace_migrations
    SET target_account_id = ?,
        status = 'completed',
        attempts = attempts + 1,
        last_error = NULL,
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE source_account_id = ?
  `).run(targetAccountId, sourceAccountId);
  console.log('[vector-memory] namespace migration complete', {
    source_account_id: sourceAccountId,
    target_account_id: targetAccountId,
    copied,
    source_cleanup: sourceCleanup,
  });
};

export const migratePendingAccountNamespaces = async () => {
  if (!PINECONE_API_KEY || !PINECONE_INDEX_NAME) return { migrated: 0, failed: 0 };

  const migrations = db.prepare(`
    SELECT source_account_id, target_account_id, status, attempts
    FROM account_namespace_migrations
    WHERE status IN ('pending', 'failed')
    ORDER BY created_at ASC, source_account_id ASC
  `).all() as NamespaceMigration[];

  let migrated = 0;
  let failed = 0;
  for (const migration of migrations) {
    try {
      await migrateNamespace(migration);
      migrated += 1;
    } catch (error) {
      failed += 1;
      markNamespaceMigrationFailed(migration.source_account_id, error);
      logError('namespace migration failed; legacy namespace remains readable', {
        source_account_id: migration.source_account_id,
        target_account_id: migration.target_account_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { migrated, failed };
};
