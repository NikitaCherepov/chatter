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
const VECTOR_MEMORY_CHUNK_SIZE = Math.max(100, Number.parseInt(process.env.VECTOR_MEMORY_CHUNK_SIZE || '1000', 10) || 1000);
const VECTOR_MEMORY_CHUNK_OVERLAP = Math.max(0, Number.parseInt(process.env.VECTOR_MEMORY_CHUNK_OVERLAP || '200', 10) || 200);

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
    const safeText = `${fullText || ''}`.trim();
    if (!safeText) throw new Error('text_required');
    if (safeText.length > VECTOR_MEMORY_MAX_TEXT) throw new Error(`text_too_long_max_${VECTOR_MEMORY_MAX_TEXT}`);

    const safeSource = `${sourceTag || ''}`.trim().slice(0, 240) || 'manual';
    const chunks = chunkText(safeText, VECTOR_MEMORY_CHUNK_SIZE, VECTOR_MEMORY_CHUNK_OVERLAP);
    const namespace = `${Math.floor(userId)}`;

    const openai = getOpenAIClient();
    const embedResponse = await openai.embeddings.create({
      model: TIMEWEB_EMBED_MODEL,
      input: chunks.map(chunk => chunk.replace(/\n/g, ' ').trim())
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
          text: chunks[index] || '',
          source: safeSource,
          timestamp: now,
          chunk_index: index,
          total_chunks: chunks.length
        }
      };
    });

    const index = getPineconeIndex();
    await index.namespace(namespace).upsert(records as any);

    return {
      ok: true,
      id: baseId,
      namespace,
      source: safeSource,
      size: safeText.length,
      chunks_saved: records.length,
      total_tokens_used: Number(embedResponse?.usage?.total_tokens || 0)
    };
  }

  static async saveChunk(userId: number, textChunk: string, sourceTag: string) {
    return this.saveFactBatched(userId, textChunk, sourceTag);
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
