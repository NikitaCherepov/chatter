import OpenAI from 'openai';
import { Pinecone } from '@pinecone-database/pinecone';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { resolveAccountId } from './accounts.js';
import { getVectorMemoryRuntimeSettings, getVectorMemoryStorage } from './vector-memory-settings.js';
import { beginVectorMemoryWrite, isVectorMemoryMigrationRunning } from './vector-memory-reembedding.js';
import { chargeTokens } from './token-quota.js';
import { countTokens } from './tokenizer.js';
import {
  deleteQdrantChunks,
  deleteQdrantSpace,
  deleteQdrantUser,
  fetchQdrantVectors,
  queryQdrantVectorGroups,
  upsertQdrantVectors,
} from './qdrant-memory.js';
import {
  createMemoryRecord,
  ensureChatMemorySpace,
  getChatMemorySettings,
  getOwnedMemoryRecord,
  getRecordChunks,
  initializeForkedChatMemory,
  listChatMemorySpacesForDeletion,
  listMemoryRecords,
  removeCanonicalMemoryRecord,
  purgeCanonicalChatMemory,
  resolveReadMemorySpaces,
  resolveWriteMemorySpace,
  updateChatMemorySettings,
  type MemorySpace,
  archiveGeneralMemorySpace,
} from './memory-foundation.js';

const PINECONE_API_KEY = `${process.env.PINECONE_API_KEY || ''}`.trim();
const PINECONE_INDEX_NAME = `${process.env.PINECONE_INDEX_NAME || 'bot-memory'}`.trim();
const VECTOR_MEMORY_MAX_TEXT = Math.max(1, Number.parseInt(process.env.VECTOR_MEMORY_MAX_TEXT || '4000', 10) || 4000);
export const VECTOR_MEMORY_MAX_QUERY = Math.max(1, Number.parseInt(process.env.VECTOR_MEMORY_MAX_QUERY || '1000', 10) || 1000);
const VECTOR_MEMORY_TOP_K_MAX = Math.max(1, Number.parseInt(process.env.VECTOR_MEMORY_TOP_K_MAX || '20', 10) || 20);
const VECTOR_MEMORY_CHUNK_SIZE = Math.max(100, Number.parseInt(process.env.VECTOR_MEMORY_CHUNK_SIZE || '1000', 10) || 1000);
const VECTOR_MEMORY_CHUNK_OVERLAP = Math.max(0, Number.parseInt(process.env.VECTOR_MEMORY_CHUNK_OVERLAP || '200', 10) || 200);
const VECTOR_MEMORY_GROUP_SIZE = 2;
const VECTOR_MEMORY_LOG_SUCCESS = `${process.env.VECTOR_MEMORY_LOG_SUCCESS || '0'}`.trim() === '1';

const memoryEmbeddingText = (source: string, text: string) => `[Context: ${source}] ${text}`;
const stripMemoryContextPrefix = (source: string, text: string) => {
  const prefixes = [`[Context: ${source}] `, `[Контекст: ${source}] `];
  const prefix = prefixes.find(candidate => text.startsWith(candidate));
  return prefix ? text.slice(prefix.length) : text;
};

let openaiClient: { key: string; client: OpenAI } | null = null;
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

const getOpenAIClient = (settings = getVectorMemoryRuntimeSettings()) => {
  if (!settings.apiKey) {
    throw new Error('embedding_api_key_not_configured');
  }
  const key = `${settings.baseUrl}\n${settings.apiKey}`;
  if (!openaiClient || openaiClient.key !== key) {
    openaiClient = { key, client: new OpenAI({
      apiKey: settings.apiKey,
      baseURL: settings.baseUrl,
    }) };
  }
  return openaiClient.client;
};

const getEmbeddingModel = () => getVectorMemoryRuntimeSettings().model;
type EmbeddingChargeContext = {
  userId: number;
  chatId?: number | null;
  route: 'memory:search' | 'memory:save' | 'memory:update';
};

export type MemorySearchGroup = {
  record_id: string;
  score: number;
  vector_score?: number;
  fragments: Array<{
    id: string;
    chunk_id: string;
    score: number;
    text: string;
    source: string;
    timestamp: number;
    chunk_index: number;
    total_chunks: number;
  }>;
};

export const rerankMemoryGroups = async (
  query: string,
  groups: MemorySearchGroup[],
  settings: ReturnType<typeof getVectorMemoryRuntimeSettings>,
  userId: number,
  chatId?: number,
  signal?: AbortSignal,
  outputLimit?: number,
): Promise<MemorySearchGroup[]> => {
  const ranking = settings.reranking;
  const resultLimit = outputLimit ?? ranking.resultLimit;
  if (!ranking.enabled || groups.length === 0) return groups;
  if (!ranking.apiKey || !ranking.baseUrl || !ranking.model) throw new Error('reranking_configuration_required');

  const documents = groups.map(group => group.fragments
    .map(fragment => fragment.text.trim())
    .filter(Boolean)
    .join('\n\n'));
  const response = await fetch(`${ranking.baseUrl.replace(/\/+$/, '')}/rerank`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ranking.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: ranking.model,
      query,
      documents,
      top_n: Math.min(resultLimit, documents.length),
      ...(ranking.openrouterProviderSlug
        ? { provider: { only: [ranking.openrouterProviderSlug], allow_fallbacks: false } }
        : {}),
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
  });
  const json = await response.json().catch(() => null) as any;
  if (!response.ok) {
    const detail = `${json?.error?.message || json?.error || json?.message || ''}`.slice(0, 500);
    throw new Error(`reranking_failed_http_${response.status}${detail ? `: ${detail}` : ''}`);
  }
  const rawResults = Array.isArray(json) ? json : Array.isArray(json?.results) ? json.results : null;
  if (!rawResults) throw new Error('reranking_invalid_response');

  const usageTokens = Math.max(0, Math.floor(Number(json?.usage?.total_tokens) || 0));
  const fallbackTokens = countTokens(`${query}\n${documents.join('\n')}`);
  const totalTokens = usageTokens || fallbackTokens;
  const searchUnits = Math.max(1, Number(json?.usage?.search_units) || 1);
  const rawReportedCost = json?.usage?.cost;
  const reportedCost = rawReportedCost === null || rawReportedCost === undefined || rawReportedCost === ''
    ? null
    : Number(rawReportedCost);
  const actualCostUsd = reportedCost !== null && Number.isFinite(reportedCost) && reportedCost >= 0
    ? reportedCost
    : ranking.pricePerSearch !== null
      ? ranking.pricePerSearch * searchUnits
      : null;
  chargeTokens({
    userId: resolveAccountId(Math.floor(userId)),
    chatId: chatId ?? null,
    route: 'memory:rerank',
    modelId: ranking.model,
    modelName: ranking.model,
    providerName: ranking.provider,
    promptTokens: totalTokens,
    completionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: totalTokens,
    reasoningTokens: 0,
    totalTokens,
    upstreamProviderSlug: `${json?.provider || ranking.openrouterProviderSlug || ''}` || null,
    actualCostUsd,
    pricingSource: 'vector-memory-reranking-settings',
    inputPricePerMillion: null,
    outputPricePerMillion: null,
    cacheReadPricePerMillion: null,
  });

  return rawResults
    .map((entry: any) => ({
      index: Number(entry?.index),
      score: Number(entry?.score ?? entry?.relevance_score ?? entry?.relevanceScore ?? entry?.relevance),
    }))
    .filter((entry: { index: number; score: number }) =>
      Number.isInteger(entry.index)
      && entry.index >= 0
      && entry.index < groups.length
      && Number.isFinite(entry.score)
      && entry.score >= ranking.minScore,
    )
    .sort((left: { score: number }, right: { score: number }) => right.score - left.score)
    .slice(0, resultLimit)
    .map((entry: { index: number; score: number }) => ({
      ...groups[entry.index],
      vector_score: groups[entry.index].score,
      score: entry.score,
    }));
};

const createEmbeddings = async (
  input: string | string[],
  settings = getVectorMemoryRuntimeSettings(),
  chargeContext?: EmbeddingChargeContext,
  signal?: AbortSignal,
) => {
  const response = await getOpenAIClient(settings).embeddings.create({
    model: settings.model,
    input,
    ...(settings.openrouterProviderSlug
      ? { provider: { only: [settings.openrouterProviderSlug], allow_fallbacks: false } }
      : {}),
  } as any, { signal });
  if (chargeContext) {
    const fallbackTokens = (Array.isArray(input) ? input : [input])
      .reduce((sum, item) => sum + countTokens(`${item || ''}`), 0);
    const promptTokens = Math.max(0, Math.floor(Number(response?.usage?.prompt_tokens) || fallbackTokens));
    const totalTokens = Math.max(promptTokens, Math.floor(Number(response?.usage?.total_tokens) || promptTokens));
    const reportedCost = (response as any)?.usage?.cost;
    const rawActualCost = reportedCost === null || reportedCost === undefined || reportedCost === ''
      ? null
      : Number(reportedCost);
    chargeTokens({
      userId: resolveAccountId(Math.floor(chargeContext.userId)),
      chatId: chargeContext.chatId ?? null,
      route: chargeContext.route,
      modelId: settings.model,
      modelName: settings.model,
      providerName: settings.provider,
      promptTokens,
      completionTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: promptTokens,
      reasoningTokens: 0,
      totalTokens,
      upstreamProviderSlug: settings.openrouterProviderSlug,
      actualCostUsd: rawActualCost !== null && Number.isFinite(rawActualCost) && rawActualCost >= 0
        ? rawActualCost
        : null,
      pricingSource: 'vector-memory-settings',
      inputPricePerMillion: settings.inputPricePerMillion,
      outputPricePerMillion: null,
      cacheReadPricePerMillion: null,
    });
  }
  return response;
};
const assertMemoryWritable = () => {
  if (isVectorMemoryMigrationRunning()) throw new Error('vector_memory_migration_in_progress');
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

const getEmbedding = async (
  text: string,
  settings = getVectorMemoryRuntimeSettings(),
  chargeContext?: EmbeddingChargeContext,
  signal?: AbortSignal,
): Promise<number[]> => {
  const normalized = text.replace(/\n/g, ' ').trim();
  if (!normalized) throw new Error('text_required');
  const response = await createEmbeddings(normalized, settings, chargeContext, signal);
  const embedding = response?.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || !embedding.length) {
    throw new Error('embedding_empty');
  }
  return embedding as number[];
};

const namespacesForSpace = (userId: number, space: MemorySpace) => (
  space.is_default === 1
    ? getReadableNamespaces(userId)
    : [space.namespace_key]
);

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
  static async deleteChatMemory(ownerUserId: number, chatId: number) {
    assertMemoryWritable();
    const accountId = resolveAccountId(Math.floor(ownerUserId));
    const spaces = listChatMemorySpacesForDeletion(accountId, chatId);
    for (const space of spaces) {
      if (getVectorMemoryStorage() === 'qdrant') {
        await deleteQdrantSpace(space.user_id, space.id);
      } else {
        await deletePineconeResource(() =>
          getPineconeIndex().namespace(space.namespace_key).deleteAll()
        );
      }
    }
    const result = purgeCanonicalChatMemory(accountId, chatId);
    return { ok: true, ...result };
  }

  static async listRecords(userId: number, space: MemorySpace) {
    const accountId = resolveAccountId(Math.floor(userId));
    if (space.user_id !== accountId) throw new Error('memory_space_not_found');
    if (getVectorMemoryStorage() === 'qdrant') return listMemoryRecords(accountId, space.id);

    const groups = new Map<string, Array<{ id: string; text: string; source: string; timestamp: number; index: number }>>();
    const seenChunks = new Set<string>();
    for (const namespace of [...new Set(namespacesForSpace(accountId, space))]) {
      const scoped = getPineconeIndex().namespace(namespace);
      let paginationToken: string | undefined;
      do {
        const page = await scoped.listPaginated({ limit: 100, ...(paginationToken ? { paginationToken } : {}) });
        const ids = (page.vectors || []).map(item => `${item.id || ''}`.trim()).filter(Boolean);
        if (ids.length) {
          const fetched = await scoped.fetch(ids);
          for (const id of ids) {
            if (seenChunks.has(id)) continue;
            const vector = fetched.records?.[id];
            if (!vector) continue;
            seenChunks.add(id);
            const metadata = vector.metadata as Record<string, unknown> | undefined;
            const recordId = id.match(/^(.*)_chunk_\d+$/)?.[1] || id;
            const source = `${metadata?.source || 'memory'}`;
            const rawText = `${metadata?.text || ''}`;
            const group = groups.get(recordId) || [];
            group.push({
              id,
              text: stripMemoryContextPrefix(source, rawText),
              source,
              timestamp: Number(metadata?.timestamp) || 0,
              index: Number.isSafeInteger(Number(metadata?.chunk_index))
                ? Number(metadata?.chunk_index)
                : Number(id.match(/_chunk_(\d+)$/)?.[1] || 0),
            });
            groups.set(recordId, group);
          }
        }
        paginationToken = page.pagination?.next || undefined;
      } while (paginationToken);
    }
    return [...groups.entries()].map(([id, chunks]) => {
      const sorted = chunks.sort((left, right) => left.index - right.index);
      const timestamp = Math.max(...sorted.map(chunk => chunk.timestamp), 0);
      return {
        id, user_id: accountId, memory_space_id: space.id,
        text: sorted.map(chunk => chunk.text).join('\n\n').trim(),
        source: sorted[0]?.source || 'memory',
        created_at: timestamp, updated_at: timestamp, deleted_at: null,
      };
    }).sort((left, right) => right.created_at - left.created_at);
  }

  static async saveFactBatched(
    userId: number,
    fullText: string,
    sourceTag: string,
    chatId?: number,
    originMessageCursor?: number | null,
  ) {
    assertMemoryWritable();
    try {
      const safeText = `${fullText || ''}`.trim();
      if (!safeText) throw new Error('text_required');
      if (safeText.length > VECTOR_MEMORY_MAX_TEXT) throw new Error(`text_too_long_max_${VECTOR_MEMORY_MAX_TEXT}`);

      const safeSource = `${sourceTag || ''}`.trim().slice(0, 240) || 'manual';
      const chunks = chunkText(safeText, VECTOR_MEMORY_CHUNK_SIZE, VECTOR_MEMORY_CHUNK_OVERLAP);
      const space = resolveWriteMemorySpace(userId, chatId);
      const namespace = space.namespace_key;

      const inputForEmbeddings = chunks.map(chunk => {
        // Include the source in every chunk so the embedding keeps its context.
        return memoryEmbeddingText(safeSource, chunk).replace(/\n/g, ' ').trim();
      });
      const runtimeSettings = getVectorMemoryRuntimeSettings();
      const embedResponse = await createEmbeddings(inputForEmbeddings, runtimeSettings, {
        userId,
        chatId: chatId ?? space.chat_id,
        route: 'memory:save',
      });

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

      if (getVectorMemoryStorage() === 'qdrant') {
        await upsertQdrantVectors(resolveAccountId(Math.floor(userId)), space, runtimeSettings.model, records);
      } else {
        await getPineconeIndex().namespace(namespace).upsert(records as any);
      }

      try {
        createMemoryRecord({
          id: baseId,
          userId,
          spaceId: space.id,
          text: safeText,
          source: safeSource,
          originMessageCursor,
          createdAt: now,
          chunks: chunks.map((chunk, chunkIndex) => ({
            id: `${baseId}_chunk_${chunkIndex}`,
            text: inputForEmbeddings[chunkIndex] || chunk,
            index: chunkIndex,
          })),
        });
      } catch (error) {
        if (getVectorMemoryStorage() === 'qdrant') {
          await deleteQdrantChunks(
            resolveAccountId(Math.floor(userId)),
            space.id,
            records.map(record => record.id),
          );
        } else {
          await deletePineconeResource(() => getPineconeIndex().namespace(namespace).deleteMany(records.map(record => record.id)));
        }
        throw error;
      }

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

  static async saveChunk(userId: number, textChunk: string, sourceTag: string, chatId?: number) {
    return this.saveFactBatched(userId, textChunk, sourceTag, chatId);
  }

  static async importChatFacts(
    userId: number,
    chatId: number,
    facts: Array<{
      text: string;
      source: string;
      originMessageCursor: number;
      createdAt?: number;
    }>,
  ) {
    assertMemoryWritable();
    const accountId = resolveAccountId(Math.floor(userId));
    const initialSettings = getChatMemorySettings(accountId, chatId);
    const space = ensureChatMemorySpace(accountId, chatId);
    const existing = new Set((db.prepare(`
      SELECT origin_message_cursor
      FROM memory_records
      WHERE user_id = ? AND memory_space_id = ? AND deleted_at IS NULL
        AND source LIKE 'sillytavern-chat:%' AND origin_message_cursor IS NOT NULL
    `).all(accountId, space.id) as Array<{ origin_message_cursor: number }>).map(row => row.origin_message_cursor));
    const pending = facts
      .map(fact => ({
        text: `${fact.text || ''}`.trim(),
        source: `${fact.source || ''}`.trim().slice(0, 220) || 'message',
        originMessageCursor: Math.floor(Number(fact.originMessageCursor)),
        createdAt: Math.floor(Number(fact.createdAt) || Date.now() / 1000),
      }))
      .filter(fact => fact.text && Number.isSafeInteger(fact.originMessageCursor) && fact.originMessageCursor > 0)
      .filter(fact => !existing.has(fact.originMessageCursor));

    if (!pending.length) {
      return { ok: true, imported: 0, skipped: facts.length, chunks_saved: 0 };
    }

    const plans = pending.map(fact => {
      const chunks = chunkText(fact.text, VECTOR_MEMORY_CHUNK_SIZE, VECTOR_MEMORY_CHUNK_OVERLAP);
      const recordId = `fact_${randomUUID()}`;
      const source = `sillytavern-chat:${fact.source}`;
      return {
        ...fact,
        source,
        recordId,
        chunks,
        embeddingTexts: chunks.map(chunk => memoryEmbeddingText(source, chunk).replace(/\n/g, ' ').trim()),
      };
    });
    const flattened = plans.flatMap(plan => plan.embeddingTexts.map((text, chunkIndex) => ({ plan, text, chunkIndex })));
    const runtimeSettings = getVectorMemoryRuntimeSettings();
    const vectors: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }> = [];
    const EMBEDDING_BATCH_SIZE = 64;
    for (let offset = 0; offset < flattened.length; offset += EMBEDDING_BATCH_SIZE) {
      const batch = flattened.slice(offset, offset + EMBEDDING_BATCH_SIZE);
      const response = await createEmbeddings(batch.map(item => item.text), runtimeSettings, {
        userId: accountId,
        chatId,
        route: 'memory:save',
      });
      const embeddings = Array.isArray(response?.data) ? response.data : [];
      if (embeddings.length !== batch.length) throw new Error('embedding_count_mismatch');
      batch.forEach((item, index) => {
        const values = Array.isArray(embeddings[index]?.embedding) ? embeddings[index].embedding : [];
        if (!values.length) throw new Error('embedding_empty');
        vectors.push({
          id: `${item.plan.recordId}_chunk_${item.chunkIndex}`,
          values,
          metadata: {
            text: item.text,
            source: item.plan.source,
            timestamp: item.plan.createdAt,
            chunk_index: item.chunkIndex,
            total_chunks: item.plan.chunks.length,
          },
        });
      });
    }

    const writtenIds: string[] = [];
    try {
      const VECTOR_BATCH_SIZE = 100;
      for (let offset = 0; offset < vectors.length; offset += VECTOR_BATCH_SIZE) {
        const batch = vectors.slice(offset, offset + VECTOR_BATCH_SIZE);
        if (getVectorMemoryStorage() === 'qdrant') {
          await upsertQdrantVectors(accountId, space, runtimeSettings.model, batch);
        } else {
          await getPineconeIndex().namespace(space.namespace_key).upsert(batch as any);
        }
        writtenIds.push(...batch.map(vector => vector.id));
      }
      db.transaction(() => {
        plans.forEach(plan => createMemoryRecord({
          id: plan.recordId,
          userId: accountId,
          spaceId: space.id,
          text: plan.text,
          source: plan.source,
          originMessageCursor: plan.originMessageCursor,
          createdAt: plan.createdAt,
          chunks: plan.chunks.map((chunk, chunkIndex) => ({
            id: `${plan.recordId}_chunk_${chunkIndex}`,
            text: plan.embeddingTexts[chunkIndex] || chunk,
            index: chunkIndex,
          })),
        }));
      })();
    } catch (error) {
      if (writtenIds.length) {
        if (getVectorMemoryStorage() === 'qdrant') await deleteQdrantChunks(accountId, space.id, writtenIds);
        else await deletePineconeResource(() => getPineconeIndex().namespace(space.namespace_key).deleteMany(writtenIds));
      }
      throw error;
    }

    const memoryMode = initialSettings.memory_mode === 'general'
      ? 'both'
      : initialSettings.memory_mode === 'off'
        ? 'chat'
        : initialSettings.memory_mode;
    if (initialSettings.chat_space_id === null) {
      updateChatMemorySettings(accountId, chatId, { memory_mode: memoryMode });
    }
    return {
      ok: true,
      imported: plans.length,
      skipped: facts.length - plans.length,
      chunks_saved: vectors.length,
    };
  }

  static async cloneChatMemoryForFork(
    userId: number,
    sourceChatId: number,
    targetChatId: number,
    anchorTimelineIndex: number,
  ) {
    assertMemoryWritable();
    const accountId = resolveAccountId(Math.floor(userId));
    const plan = initializeForkedChatMemory(
      accountId,
      sourceChatId,
      targetChatId,
      anchorTimelineIndex,
    );
    if (!plan.sourceSpace || !plan.targetSpace || !plan.records.length) {
      return { copied_records: 0, copied_chunks: 0 };
    }
    if (plan.records.some(item => item.chunks.length === 0)) {
      throw new Error('memory_chunks_not_found');
    }

    const sourceChunkIds = plan.records.flatMap(item => item.chunks.map(chunk => chunk.id));
    const sourceVectors = new Map<string, {
      values: number[];
      metadata?: Record<string, unknown>;
    }>();
    if (getVectorMemoryStorage() === 'qdrant') {
      const vectors = await fetchQdrantVectors(accountId, plan.sourceSpace.id, sourceChunkIds);
      vectors.forEach(vector => sourceVectors.set(vector.id, vector));
    } else {
      const namespace = getPineconeIndex().namespace(plan.sourceSpace.namespace_key);
      for (let offset = 0; offset < sourceChunkIds.length; offset += 100) {
        const batch = sourceChunkIds.slice(offset, offset + 100);
        const fetched = await namespace.fetch(batch);
        for (const chunkId of batch) {
          const vector = fetched.records?.[chunkId];
          if (!vector?.values?.length) throw new Error(`memory_vector_not_found:${chunkId}`);
          sourceVectors.set(chunkId, {
            values: vector.values,
            metadata: vector.metadata as Record<string, unknown> | undefined,
          });
        }
      }
    }

    const clones = plan.records.map(item => {
      const recordId = `fact_${randomUUID()}`;
      const chunks = item.chunks.map((chunk, index) => {
        const sourceVector = sourceVectors.get(chunk.id);
        if (!sourceVector) throw new Error(`memory_vector_not_found:${chunk.id}`);
        const chunkId = `${recordId}_chunk_${index}`;
        return {
          id: chunkId,
          text: chunk.text,
          index,
          values: sourceVector.values,
          metadata: {
            ...(sourceVector.metadata || {}),
            text: chunk.text,
            source: item.record.source,
            timestamp: item.record.created_at,
            chunk_index: index,
            total_chunks: item.chunks.length,
            record_id: recordId,
          },
        };
      });
      return { recordId, source: item.record, chunks };
    });
    const targetVectors = clones.flatMap(clone => clone.chunks.map(chunk => ({
      id: chunk.id,
      values: chunk.values,
      metadata: chunk.metadata,
    })));

    try {
      if (getVectorMemoryStorage() === 'qdrant') {
        const vectorsByModel = new Map<string, typeof targetVectors>();
        for (const vector of targetVectors) {
          const embeddingModel = `${(vector.metadata as Record<string, unknown>).embedding_model || getEmbeddingModel()}`;
          const group = vectorsByModel.get(embeddingModel) || [];
          group.push(vector);
          vectorsByModel.set(embeddingModel, group);
        }
        for (const [embeddingModel, vectors] of vectorsByModel) {
          await upsertQdrantVectors(accountId, plan.targetSpace, embeddingModel, vectors);
        }
      } else {
        await getPineconeIndex().namespace(plan.targetSpace.namespace_key).upsert(targetVectors as any);
      }
      db.transaction(() => {
        for (const clone of clones) {
          createMemoryRecord({
            id: clone.recordId,
            userId: accountId,
            spaceId: plan.targetSpace!.id,
            text: clone.source.text,
            source: clone.source.source,
            originMessageCursor: clone.source.origin_message_cursor,
            createdAt: clone.source.created_at,
            chunks: clone.chunks.map(chunk => ({
              id: chunk.id,
              text: chunk.text,
              index: chunk.index,
            })),
          });
        }
      })();
    } catch (error) {
      if (getVectorMemoryStorage() === 'qdrant') {
        await deleteQdrantChunks(accountId, plan.targetSpace.id, targetVectors.map(vector => vector.id));
      } else {
        await deletePineconeResource(() =>
          getPineconeIndex().namespace(plan.targetSpace!.namespace_key)
            .deleteMany(targetVectors.map(vector => vector.id))
        );
      }
      throw error;
    }
    return { copied_records: clones.length, copied_chunks: targetVectors.length };
  }

  static async search(userId: number, query: string, topK?: number, chatId?: number, exactSpaceId?: number, options?: { billingUserId?: number; signal?: AbortSignal; resultLimit?: number }) {
    try {
      const safeQuery = `${query || ''}`.trim();
      if (!safeQuery) throw new Error('query_required');
      if (safeQuery.length > VECTOR_MEMORY_MAX_QUERY) throw new Error(`query_too_long_max_${VECTOR_MEMORY_MAX_QUERY}`);

      const runtimeSettings = getVectorMemoryRuntimeSettings();
      const outputLimit = Math.max(1, Math.min(20, Math.floor(options?.resultLimit ?? runtimeSettings.reranking.resultLimit)));
      const safeTopK = Math.max(1, Math.min(VECTOR_MEMORY_TOP_K_MAX, outputLimit, Math.floor(Number(topK) || outputLimit)));
      let spaces = resolveReadMemorySpaces(userId, chatId);
      if (exactSpaceId !== undefined) {
        const accountId = resolveAccountId(Math.floor(userId));
        if (chatId !== undefined) {
          spaces = spaces.filter(space =>
            space.id === exactSpaceId && space.kind === 'chat' && space.chat_id === chatId,
          );
        } else {
          const space = db.prepare(`
            SELECT * FROM memory_spaces
            WHERE id = ? AND user_id = ? AND kind = 'general' AND archived_at IS NULL
          `).get(exactSpaceId, accountId) as MemorySpace | undefined;
          spaces = space ? [space] : [];
        }
        if (!spaces.length) throw new Error('memory_space_not_found');
      }
      const namespace = spaces.map(space => space.namespace_key).join(',');
      if (!spaces.length) {
        return { ok: true, namespace: '', top_k: safeTopK, groups: [], matches: [], text: '' };
      }
      // Keep model and collection from one settings snapshot. A migration may
      // finish while this request is embedding its query.
      const retrievalLimit = runtimeSettings.reranking.enabled ? 20 : safeTopK;
      options?.signal?.throwIfAborted();
      const queryVector = await getEmbedding(safeQuery, runtimeSettings, {
        userId: options?.billingUserId ?? userId,
        chatId: chatId ?? null,
        route: 'memory:search',
      }, options?.signal);
      let groupedMatches: MemorySearchGroup[] = [];

      if (getVectorMemoryStorage() === 'qdrant') {
        const groups = await queryQdrantVectorGroups(
          resolveAccountId(Math.floor(userId)),
          spaces,
          runtimeSettings.model,
          queryVector,
          retrievalLimit,
          VECTOR_MEMORY_GROUP_SIZE,
          runtimeSettings.activeCollection,
        );
        groupedMatches = groups.map(group => {
          const recordId = `${group.id || ''}`;
          const fragments = group.hits.map(point => {
            const payload = point.payload as Record<string, unknown> | null | undefined;
            const chunkId = `${payload?.chunk_id || point.id || ''}`;
            const source = `${payload?.source || ''}`;
            const rawText = `${payload?.text || ''}`;
            return {
              id: chunkId,
              chunk_id: chunkId,
              score: Number(point.score || 0),
              text: stripMemoryContextPrefix(source, rawText),
              source,
              timestamp: Number(payload?.timestamp || 0),
              chunk_index: Number(payload?.chunk_index || 0),
              total_chunks: Math.max(1, Number(payload?.total_chunks || 1)),
            };
          }).filter(fragment => fragment.chunk_id);
          return {
            record_id: recordId,
            score: Number(fragments[0]?.score || 0),
            fragments,
          };
        }).filter(group => group.record_id && group.fragments.length > 0);
      } else {
        const candidateLimit = Math.min(VECTOR_MEMORY_TOP_K_MAX * 4, Math.max(retrievalLimit, retrievalLimit * 4));
        const matchesById = new Map<string, any>();
        const index = getPineconeIndex();
        const readableNamespaces = [...new Set(spaces.flatMap(space => namespacesForSpace(userId, space)))];
        const results = await Promise.all(readableNamespaces.map(readableNamespace =>
          index.namespace(readableNamespace).query({
            vector: queryVector,
            topK: candidateLimit,
            includeMetadata: true
          } as any)
        ));
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
        const records = new Map<string, any[]>();
        [...matchesById.values()]
          .sort((left, right) => Number(right?.score || 0) - Number(left?.score || 0))
          .forEach(match => {
            const chunkId = `${match?.id || ''}`;
            const recordId = `${match?.metadata?.record_id || chunkId.match(/^(.*)_chunk_\d+$/)?.[1] || chunkId}`;
            if (!recordId || !chunkId) return;
            const group = records.get(recordId) || [];
            group.push(match);
            records.set(recordId, group);
          });
        groupedMatches = [...records.entries()]
          .map(([recordId, group]) => ({ recordId, group }))
          .sort((left, right) => Number(right.group[0]?.score || 0) - Number(left.group[0]?.score || 0))
          .slice(0, retrievalLimit)
          .map(({ recordId, group }) => ({
            record_id: recordId,
            score: Number(group[0]?.score || 0),
            fragments: group.slice(0, VECTOR_MEMORY_GROUP_SIZE).map(match => {
              const chunkId = `${match?.id || ''}`;
              const source = `${match?.metadata?.source || ''}`;
              const rawText = `${match?.metadata?.text || ''}`;
              return {
                id: chunkId,
                chunk_id: chunkId,
                score: Number(match?.score || 0),
                text: stripMemoryContextPrefix(source, rawText),
                source,
                timestamp: Number(match?.metadata?.timestamp || 0),
                chunk_index: Number(match?.metadata?.chunk_index || chunkId.match(/_chunk_(\d+)$/)?.[1] || 0),
                total_chunks: Math.max(1, Number(match?.metadata?.total_chunks || 1)),
              };
            }),
          }));
      }

      options?.signal?.throwIfAborted();
      groupedMatches = await rerankMemoryGroups(
        safeQuery,
        groupedMatches,
        runtimeSettings,
        options?.billingUserId ?? userId,
        chatId,
        options?.signal,
        safeTopK,
      );

      const items = groupedMatches.flatMap(group => group.fragments.map(fragment => ({
        ...fragment,
        record_id: group.record_id,
      })));

      const joinedText = groupedMatches
        .map(group => `[Воспоминание: ${group.record_id}]\n${group.fragments
          .map(fragment => `[Источник: ${fragment.source || 'unknown'}]\n${fragment.text}`)
          .join('\n\n')}`)
        .join('\n\n---\n\n');

      const out = {
        ok: true,
        namespace,
        top_k: safeTopK,
        groups: groupedMatches,
        matches: items,
        text: joinedText
      };

      logSuccess('search ok', {
        user_id: Math.floor(userId),
        namespace,
        top_k: safeTopK,
        groups_count: groupedMatches.length,
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

  static async deleteChunk(userId: number, chunkId: string, chatId?: number) {
    assertMemoryWritable();
    try {
      const safeChunkId = `${chunkId || ''}`.trim();
      if (!safeChunkId) throw new Error('chunk_id_required');

      const accountId = resolveAccountId(Math.floor(userId));
      const canonicalChunk = db.prepare(`
        SELECT c.memory_record_id, c.memory_space_id
        FROM memory_chunks c
        JOIN memory_spaces s ON s.id = c.memory_space_id
        WHERE c.id = ? AND c.user_id = ? AND s.user_id = ?
      `).get(safeChunkId, accountId, accountId) as {
        memory_record_id: string; memory_space_id: number;
      } | undefined;
      if (canonicalChunk) {
        const readableSpaceIds = new Set(resolveReadMemorySpaces(userId, chatId).map(space => space.id));
        if (!readableSpaceIds.has(canonicalChunk.memory_space_id)) throw new Error('chunk_not_found');
        const record = getOwnedMemoryRecord(userId, canonicalChunk.memory_record_id);
        if (!record) throw new Error('chunk_not_found');
        const chunks = getRecordChunks(userId, record.id);
        const space = db.prepare('SELECT * FROM memory_spaces WHERE id = ? AND user_id = ?')
          .get(record.memory_space_id, accountId) as MemorySpace | undefined;
        if (!space) throw new Error('chunk_not_found');
        if (getVectorMemoryStorage() === 'qdrant') {
          await deleteQdrantChunks(accountId, space.id, chunks.map(chunk => chunk.id));
        } else {
          await deletePineconeResource(() =>
            getPineconeIndex().namespace(space.namespace_key).deleteMany(chunks.map(chunk => chunk.id))
          );
        }
        removeCanonicalMemoryRecord(userId, record.id);
        return {
          ok: true,
          namespace: space.namespace_key,
          id: safeChunkId,
          chunk_id: safeChunkId,
          record_id: record.id,
          deleted_ids: chunks.map(chunk => chunk.id),
          chunks_deleted: chunks.length,
          namespaces_deleted: [space.namespace_key],
        };
      }
      if (getVectorMemoryStorage() === 'qdrant') throw new Error('chunk_not_found');

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

  static readRecord(userId: number, recordId: string, chatId?: number) {
    const safeRecordId = `${recordId || ''}`.trim();
    if (!safeRecordId) throw new Error('memory_id_required');
    if (safeRecordId.length > 240) throw new Error('memory_id_too_long');
    const record = getOwnedMemoryRecord(userId, safeRecordId);
    const readableSpaceIds = new Set(resolveReadMemorySpaces(userId, chatId).map(space => space.id));
    if (!record || !readableSpaceIds.has(record.memory_space_id)) {
      throw new Error('memory_record_not_found');
    }
    return {
      memory_id: record.id,
      text: record.text,
      source: record.source,
      created_at: record.created_at,
      updated_at: record.updated_at,
    };
  }

  static async deleteRecord(userId: number, recordId: string) {
    assertMemoryWritable();
    const record = getOwnedMemoryRecord(userId, `${recordId || ''}`.trim());
    if (!record) throw new Error('memory_record_not_found');
    const accountId = resolveAccountId(Math.floor(userId));
    const chunks = getRecordChunks(accountId, record.id);
    const space = db.prepare('SELECT * FROM memory_spaces WHERE id = ? AND user_id = ?')
      .get(record.memory_space_id, accountId) as MemorySpace | undefined;
    if (!space) throw new Error('memory_space_not_found');
    if (getVectorMemoryStorage() === 'qdrant') {
      await deleteQdrantChunks(accountId, space.id, chunks.map(chunk => chunk.id));
    } else if (chunks.length) {
      await deletePineconeResource(() =>
        getPineconeIndex().namespace(space.namespace_key).deleteMany(chunks.map(chunk => chunk.id))
      );
    }
    removeCanonicalMemoryRecord(accountId, record.id);
    return { ok: true, record_id: record.id, chunks_deleted: chunks.length };
  }

  static async deleteGeneralSpace(userId: number, space: MemorySpace) {
    assertMemoryWritable();
    const accountId = resolveAccountId(Math.floor(userId));
    if (space.user_id !== accountId || space.kind !== 'general' || space.archived_at !== null) {
      throw new Error('memory_space_not_found');
    }
    if (space.is_primary === 1) throw new Error('primary_memory_space_cannot_be_deleted');
    if (getVectorMemoryStorage() === 'qdrant') {
      await deleteQdrantSpace(accountId, space.id);
    } else {
      await deletePineconeResource(() => getPineconeIndex().namespace(space.namespace_key).deleteAll());
    }
    const activeSpace = archiveGeneralMemorySpace(accountId, space.id);
    return { ok: true, active_space: activeSpace };
  }

  static async updateRecord(userId: number, recordId: string, fullText: string, sourceTag?: string) {
    assertMemoryWritable();
    const safeText = `${fullText || ''}`.trim();
    if (!safeText) throw new Error('text_required');
    if (safeText.length > VECTOR_MEMORY_MAX_TEXT) throw new Error(`text_too_long_max_${VECTOR_MEMORY_MAX_TEXT}`);
    const accountId = resolveAccountId(Math.floor(userId));
    const record = getOwnedMemoryRecord(accountId, `${recordId || ''}`.trim());
    if (!record) throw new Error('memory_record_not_found');
    const space = db.prepare('SELECT * FROM memory_spaces WHERE id = ? AND user_id = ?')
      .get(record.memory_space_id, accountId) as MemorySpace | undefined;
    if (!space) throw new Error('memory_space_not_found');
    const safeSource = sourceTag === undefined
      ? record.source
      : `${sourceTag || ''}`.trim().slice(0, 240) || 'manual';
    const chunks = chunkText(safeText, VECTOR_MEMORY_CHUNK_SIZE, VECTOR_MEMORY_CHUNK_OVERLAP);
    const input = chunks.map(chunk => memoryEmbeddingText(safeSource, chunk).replace(/\n/g, ' ').trim());
    const runtimeSettings = getVectorMemoryRuntimeSettings();
    const response = await createEmbeddings(input, runtimeSettings, {
      userId: accountId,
      chatId: space.chat_id,
      route: 'memory:update',
    });
    const embeddings = Array.isArray(response?.data) ? response.data : [];
    if (embeddings.length !== chunks.length) throw new Error('embedding_empty');
    const oldChunks = getRecordChunks(accountId, record.id);
    const now = Math.floor(Date.now() / 1000);
    const vectors = embeddings.map((entry: any, index: number) => ({
      id: `${record.id}_chunk_${index}`,
      values: Array.isArray(entry?.embedding) ? entry.embedding as number[] : [],
      metadata: {
        text: input[index], source: safeSource, timestamp: record.created_at,
        chunk_index: index, total_chunks: chunks.length, record_id: record.id,
      },
    }));
    if (vectors.some(vector => !vector.values.length)) throw new Error('embedding_empty');
    if (getVectorMemoryStorage() === 'qdrant') {
      await deleteQdrantChunks(accountId, space.id, oldChunks.map(chunk => chunk.id));
      await upsertQdrantVectors(accountId, space, runtimeSettings.model, vectors);
    } else {
      if (oldChunks.length) {
        await deletePineconeResource(() =>
          getPineconeIndex().namespace(space.namespace_key).deleteMany(oldChunks.map(chunk => chunk.id))
        );
      }
      await getPineconeIndex().namespace(space.namespace_key).upsert(vectors as any);
    }
    db.transaction(() => {
      db.prepare('DELETE FROM memory_chunks WHERE memory_record_id = ? AND user_id = ?').run(record.id, accountId);
      db.prepare('UPDATE memory_records SET text = ?, source = ?, updated_at = ? WHERE id = ? AND user_id = ?')
        .run(safeText, safeSource, now, record.id, accountId);
      const insertChunk = db.prepare(`
        INSERT INTO memory_chunks (id, memory_record_id, user_id, memory_space_id, text, chunk_index, total_chunks, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      vectors.forEach((vector, index) => insertChunk.run(
        vector.id, record.id, accountId, space.id, input[index], index, vectors.length, record.created_at, now,
      ));
    })();
    return getOwnedMemoryRecord(accountId, record.id)!;
  }

  static async deleteAll(userId: number) {
    assertMemoryWritable();
    try {
      const namespace = canonicalNamespace(userId);
      if (getVectorMemoryStorage() === 'qdrant') {
        await deleteQdrantUser(resolveAccountId(Math.floor(userId)));
        return { ok: true, namespace, deleted_all: true };
      }
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

// Serialize public mutations against collection migration. Existing writes
// finish on the active collection; a migration starts only when none remain,
// and new writes are rejected until the verified atomic switch completes.
for (const methodName of [
  'deleteChatMemory',
  'saveFactBatched',
  'saveChunk',
  'importChatFacts',
  'cloneChatMemoryForFork',
  'deleteChunk',
  'deleteRecord',
  'deleteGeneralSpace',
  'updateRecord',
  'deleteAll',
] as const) {
  const original = VectorMemoryService[methodName] as (...args: any[]) => Promise<unknown>;
  (VectorMemoryService as any)[methodName] = async function (...args: any[]) {
    const release = beginVectorMemoryWrite();
    try {
      return await original.apply(this, args);
    } finally {
      release();
    }
  };
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
  if (getVectorMemoryStorage() !== 'pinecone') return { migrated: 0, failed: 0 };
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
