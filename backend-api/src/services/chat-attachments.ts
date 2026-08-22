import { db } from '../db.js';
import type { MessageAttachment } from '../types.js';
import { countTokens } from './tokenizer.js';
import { canReadChatMessages } from './chat-rooms.js';
import { saveUserDocument } from './attachment-storage.js';
import { guessMimeType } from './document-parser.js';
import { wrapUntrustedContent } from './web-reader.js';

export const ATTACHMENT_CHUNK_TARGET_TOKENS = 12_000;

export type AttachmentChunk = { index: number; start: number; end: number; text: string; estimated_tokens: number };
export type AttachmentReadContext = {
  chatId: number;
  maxContextTokens: number;
  readBudget: { remaining: number };
  getLatestPromptTokens: () => number | undefined;
  getFallbackContextTokens: () => number;
  capacityState: { lastPromptTokens?: number; unreflectedTokens: number };
};

const findNaturalBoundary = (text: string, start: number, preferredEnd: number): number => {
  if (preferredEnd >= text.length) return text.length;
  const minEnd = start + Math.floor((preferredEnd - start) * 0.6);
  const paragraph = text.lastIndexOf('\n\n', preferredEnd);
  if (paragraph >= minEnd) return paragraph + 2;
  const line = text.lastIndexOf('\n', preferredEnd);
  if (line >= minEnd) return line + 1;
  return preferredEnd;
};

/** Deterministic, non-overlapping chunks with paragraph/line boundaries where possible. */
export const splitAttachmentText = (text: string, targetTokens = ATTACHMENT_CHUNK_TARGET_TOKENS): AttachmentChunk[] => {
  if (!text) return [];
  const totalTokens = Math.max(1, countTokens(text));
  const charsPerToken = Math.max(0.25, text.length / totalTokens);
  const targetChars = Math.max(1_000, Math.floor(targetTokens * charsPerToken));
  const chunks: AttachmentChunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = findNaturalBoundary(text, start, Math.min(text.length, start + targetChars));
    let chunkText = text.slice(start, end);
    let chunkTokens = countTokens(chunkText);
    if (chunkTokens > targetTokens && end - start > 1_000) {
      let low = start + 1;
      let high = end;
      let best = low;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = findNaturalBoundary(text, start, middle);
        const candidateTokens = countTokens(text.slice(start, candidate));
        if (candidateTokens <= targetTokens) {
          best = candidate;
          low = middle + 1;
        } else high = middle - 1;
      }
      end = Math.max(start + 1, best);
      chunkText = text.slice(start, end);
      chunkTokens = countTokens(chunkText);
    }
    chunks.push({ index: chunks.length + 1, start, end, text: chunkText, estimated_tokens: chunkTokens });
    start = end;
  }
  return chunks;
};

export const withAttachmentMetadata = (attachment: MessageAttachment): MessageAttachment => {
  if (
    attachment.char_count !== undefined
    && attachment.estimated_tokens !== undefined
    && attachment.chunk_count !== undefined
  ) return attachment;
  const text = attachment.extracted_text || '';
  const chunks = splitAttachmentText(text);
  return { ...attachment, char_count: attachment.char_count ?? text.length, estimated_tokens: attachment.estimated_tokens ?? countTokens(text), chunk_count: attachment.chunk_count ?? chunks.length };
};

export const saveParsedChatAttachment = async (buffer: Buffer, originalName: string, extractedText: string): Promise<MessageAttachment> => {
  const stored = await saveUserDocument(buffer, originalName);
  return withAttachmentMetadata({ name: originalName, size_bytes: buffer.length, mime_type: guessMimeType(originalName), extracted_text: extractedText, url: stored.url, filename: stored.filename });
};

const resolveAttachmentInChat = (userId: number, chatId: number, attachmentUrl: string): MessageAttachment | null => {
  if (!canReadChatMessages(userId, chatId)) return null;
  const rows = db.prepare(`
    SELECT attachments FROM chat_messages
    WHERE chat_id = ? AND attachments IS NOT NULL
      AND TRIM(attachments) NOT IN ('', '[]', 'null')
    ORDER BY id DESC
  `).all(chatId) as Array<{ attachments: string }>;
  for (const row of rows) {
    try {
      const attachments = JSON.parse(row.attachments) as MessageAttachment[];
      const found = attachments.find(item => item?.url === attachmentUrl);
      if (found) return withAttachmentMetadata(found);
    } catch {
      // Ignore malformed legacy rows and continue searching.
    }
  }
  return null;
};

const contextCapacity = (context: AttachmentReadContext) => {
  const latest = context.getLatestPromptTokens();
  const current = latest && latest > 0 ? latest : context.getFallbackContextTokens();
  if (context.capacityState.lastPromptTokens !== current) {
    context.capacityState.lastPromptTokens = current;
    context.capacityState.unreflectedTokens = 0;
  }
  const reserve = Math.max(2_048, Math.min(16_384, Math.floor(context.maxContextTokens * 0.2)));
  return {
    current,
    reserve,
    available: Math.max(0, context.maxContextTokens - current - reserve - context.capacityState.unreflectedTokens),
  };
};

const verifyReadCapacity = (requestedTokens: number, context: AttachmentReadContext): string | null => {
  if (requestedTokens > context.readBudget.remaining) {
    return JSON.stringify({
      status: 'attachment_budget_exceeded',
      requested_estimated_tokens: requestedTokens,
      remaining_attachment_tokens: context.readBudget.remaining,
      instruction: 'Read a smaller chunk or use search_attachment_file first.',
    });
  }
  const capacity = contextCapacity(context);
  if (requestedTokens > capacity.available) {
    return JSON.stringify({
      status: 'too_large_for_context',
      requested_estimated_tokens: requestedTokens,
      available_estimated_tokens: capacity.available,
      current_prompt_tokens: capacity.current,
      reserved_tokens: capacity.reserve,
      instruction: 'Read a smaller chunk or use search_attachment_file first.',
    });
  }
  return null;
};

const untrustedAttachmentResult = (payload: Record<string, unknown>) => (
  wrapUntrustedContent(JSON.stringify(payload, null, 2))
);

export const readChatAttachment = (
  userId: number,
  attachmentUrl: string,
  mode: 'full' | 'chunk',
  chunkIndex: number,
  adjacentChunks: number,
  context: AttachmentReadContext,
): string => {
  const attachment = resolveAttachmentInChat(userId, context.chatId, attachmentUrl);
  if (!attachment) return JSON.stringify({ status: 'not_found_or_forbidden' });
  const chunks = splitAttachmentText(attachment.extracted_text || '');
  if (chunks.length === 0) return JSON.stringify({ status: 'empty_attachment', attachment_url: attachmentUrl });

  let selected: AttachmentChunk[];
  if (mode === 'full') {
    selected = chunks;
  } else {
    const safeIndex = Math.floor(chunkIndex || 1);
    if (safeIndex < 1 || safeIndex > chunks.length) {
      return JSON.stringify({ status: 'chunk_out_of_range', chunks: chunks.length });
    }
    const neighbors = Math.max(0, Math.min(2, Math.floor(adjacentChunks || 0)));
    selected = chunks.slice(Math.max(0, safeIndex - 1 - neighbors), Math.min(chunks.length, safeIndex + neighbors));
  }

  const requestedTokens = selected.reduce((sum, chunk) => sum + chunk.estimated_tokens, 0);
  const capacityError = verifyReadCapacity(requestedTokens, context);
  if (capacityError) return capacityError;
  context.readBudget.remaining = Math.max(0, context.readBudget.remaining - requestedTokens);
  context.capacityState.unreflectedTokens += requestedTokens;

  return untrustedAttachmentResult({
    status: 'ok',
    name: attachment.name,
    attachment_url: attachment.url,
    total_chunks: chunks.length,
    returned_chunks: selected.map(chunk => chunk.index),
    estimated_tokens: requestedTokens,
    remaining_attachment_tokens: context.readBudget.remaining,
    content: selected.map(chunk => ({ chunk: chunk.index, text: chunk.text })),
  });
};

export const searchChatAttachment = (
  userId: number,
  attachmentUrl: string,
  query: string,
  maxResults: number,
  context: AttachmentReadContext,
): string => {
  const attachment = resolveAttachmentInChat(userId, context.chatId, attachmentUrl);
  if (!attachment) return JSON.stringify({ status: 'not_found_or_forbidden' });
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return JSON.stringify({ status: 'empty_query' });

  const text = attachment.extracted_text || '';
  const normalizedText = text.toLocaleLowerCase();
  const chunks = splitAttachmentText(text);
  const limit = Math.max(1, Math.min(10, Math.floor(maxResults || 5)));
  const matches: Array<{ chunk: number; snippet: string }> = [];
  let cursor = 0;
  while (matches.length < limit) {
    const found = normalizedText.indexOf(normalizedQuery, cursor);
    if (found < 0) break;
    const snippetStart = Math.max(0, found - 350);
    const snippetEnd = Math.min(text.length, found + query.length + 350);
    const chunk = chunks.find(item => found >= item.start && found < item.end);
    matches.push({ chunk: chunk?.index ?? 1, snippet: text.slice(snippetStart, snippetEnd) });
    cursor = Math.max(found + normalizedQuery.length, found + 1);
  }

  const requestedTokens = countTokens(matches.map(match => match.snippet).join('\n'));
  const capacityError = verifyReadCapacity(requestedTokens, context);
  if (capacityError) return capacityError;
  context.readBudget.remaining = Math.max(0, context.readBudget.remaining - requestedTokens);
  context.capacityState.unreflectedTokens += requestedTokens;

  return untrustedAttachmentResult({
    status: 'ok',
    name: attachment.name,
    attachment_url: attachment.url,
    query,
    total_chunks: chunks.length,
    matches,
    estimated_tokens: requestedTokens,
    remaining_attachment_tokens: context.readBudget.remaining,
  });
};
