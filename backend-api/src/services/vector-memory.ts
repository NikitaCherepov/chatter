import OpenAI from 'openai';
import { Pinecone } from '@pinecone-database/pinecone';

const TIMEWEB_EMBED_API_KEY = `${process.env.TIMEWEB_EMBED_API_KEY || process.env.TIMEWEB_API_KEY || ''}`.trim();
const TIMEWEB_EMBED_BASE_URL = `${process.env.TIMEWEB_EMBED_BASE_URL || process.env.TIMEWEB_BASE_URL || 'https://api.timeweb.ai/v1'}`.trim();
const TIMEWEB_EMBED_MODEL = `${process.env.TIMEWEB_EMBED_MODEL || process.env.VECTOR_EMBED_MODEL || 'text-embedding-3-large'}`.trim();
const PINECONE_API_KEY = `${process.env.PINECONE_API_KEY || ''}`.trim();
const PINECONE_INDEX_NAME = `${process.env.PINECONE_INDEX_NAME || 'bot-memory'}`.trim();
const VECTOR_MEMORY_MAX_TEXT = Math.max(1, Number.parseInt(process.env.VECTOR_MEMORY_MAX_TEXT || '4000', 10) || 4000);
const VECTOR_MEMORY_MAX_QUERY = Math.max(1, Number.parseInt(process.env.VECTOR_MEMORY_MAX_QUERY || '1000', 10) || 1000);
const VECTOR_MEMORY_TOP_K_MAX = Math.max(1, Number.parseInt(process.env.VECTOR_MEMORY_TOP_K_MAX || '20', 10) || 20);

let openaiClient: OpenAI | null = null;
let pineconeClient: Pinecone | null = null;

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

export class VectorMemoryService {
  static async saveChunk(userId: number, textChunk: string, sourceTag: string) {
    const safeText = `${textChunk || ''}`.trim();
    if (!safeText) throw new Error('text_required');
    if (safeText.length > VECTOR_MEMORY_MAX_TEXT) throw new Error(`text_too_long_max_${VECTOR_MEMORY_MAX_TEXT}`);

    const safeSource = `${sourceTag || ''}`.trim().slice(0, 240) || 'manual';
    const namespace = `${Math.floor(userId)}`;
    const vector = await getEmbedding(safeText);
    const chunkId = `chunk_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    const index = getPineconeIndex();
    await index.namespace(namespace).upsert([{
      id: chunkId,
      values: vector,
      metadata: {
        text: safeText,
        source: safeSource,
        timestamp: Date.now()
      }
    } as any]);

    return {
      ok: true,
      id: chunkId,
      namespace,
      source: safeSource,
      size: safeText.length
    };
  }

  static async search(userId: number, query: string, topK = 3) {
    const safeQuery = `${query || ''}`.trim();
    if (!safeQuery) throw new Error('query_required');
    if (safeQuery.length > VECTOR_MEMORY_MAX_QUERY) throw new Error(`query_too_long_max_${VECTOR_MEMORY_MAX_QUERY}`);

    const safeTopK = Math.max(1, Math.min(VECTOR_MEMORY_TOP_K_MAX, Math.floor(Number(topK) || 3)));
    const namespace = `${Math.floor(userId)}`;
    const queryVector = await getEmbedding(safeQuery);
    const index = getPineconeIndex();

    const result = await index.namespace(namespace).query({
      vector: queryVector,
      topK: safeTopK,
      includeMetadata: true
    } as any);

    const matches = Array.isArray(result?.matches) ? result.matches : [];
    const items = matches.map((match: any) => ({
      id: `${match?.id || ''}`,
      score: Number(match?.score || 0),
      text: `${match?.metadata?.text || ''}`,
      source: `${match?.metadata?.source || ''}`,
      timestamp: Number(match?.metadata?.timestamp || 0)
    }));

    const joinedText = items
      .map(item => `[Источник: ${item.source || 'unknown'}]\n${item.text}`)
      .join('\n\n---\n\n');

    return {
      ok: true,
      namespace,
      top_k: safeTopK,
      matches: items,
      text: joinedText
    };
  }

  static async deleteChunk(userId: number, chunkId: string) {
    const safeChunkId = `${chunkId || ''}`.trim();
    if (!safeChunkId) throw new Error('chunk_id_required');

    const namespace = `${Math.floor(userId)}`;
    const index = getPineconeIndex();
    await index.namespace(namespace).deleteOne(safeChunkId);

    return {
      ok: true,
      namespace,
      id: safeChunkId
    };
  }

  static async deleteAll(userId: number) {
    const namespace = `${Math.floor(userId)}`;
    const index = getPineconeIndex();
    await index.namespace(namespace).deleteAll();

    return {
      ok: true,
      namespace,
      deleted_all: true
    };
  }
}
