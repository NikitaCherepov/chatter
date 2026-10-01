import { createHash } from 'node:crypto';
import { db, toUnix } from '../db.js';
import { countTokens } from './tokenizer.js';

export type ContextSummaryDto = {
  content: string;
  through_timeline_index: number;
  source_message_count: number;
  token_count: number;
  context_limit: number;
  model_name: string | null;
  provider_name: string | null;
  updated_at: number;
};

export type ContextSummarySource = {
  hash: string;
  throughTimelineIndex: number;
  messageCount: number;
  formattedMessages: string[];
};

type SourceRow = {
  id: number;
  timeline_index: number | null;
  role: 'user' | 'assistant';
  content: string;
  attachments: string | null;
  images: string | null;
};

const formatSourceRow = (row: SourceRow): string => {
  const additions: string[] = [];
  if (row.attachments) {
    try {
      const attachments = JSON.parse(row.attachments) as Array<{ name?: string }>;
      const names = attachments.map(item => `${item?.name || ''}`.trim()).filter(Boolean);
      if (names.length > 0) additions.push(`Attachments: ${names.join(', ')}`);
    } catch { /* Legacy malformed JSON is ignored. */ }
  }
  if (row.images) {
    try {
      const images = JSON.parse(row.images) as unknown[];
      if (Array.isArray(images) && images.length > 0) additions.push(`Images: ${images.length}`);
    } catch { /* Legacy malformed JSON is ignored. */ }
  }
  const suffix = additions.length > 0 ? `\n[${additions.join('; ')}]` : '';
  return `[${row.timeline_index ?? row.id}] ${row.role.toUpperCase()}: ${row.content}${suffix}`;
};

/** Archived rows are the exact prefix removed by provider-anchored trimming. */
export const getArchivedContextSummarySource = (userId: number, chatId: number): ContextSummarySource | null => {
  const rows = db.prepare(`
    SELECT id, timeline_index, role, content, attachments, images
    FROM chat_messages
    WHERE user_id = ? AND chat_id = ? AND archived = 1
    ORDER BY COALESCE(timeline_index, id) ASC, id ASC
  `).all(userId, chatId) as SourceRow[];
  if (rows.length === 0) return null;

  const fingerprint = rows.map(row => ({
    id: row.id,
    timeline_index: row.timeline_index,
    role: row.role,
    content: row.content,
    attachments: row.attachments,
    images: row.images,
  }));
  return {
    hash: createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex'),
    throughTimelineIndex: rows[rows.length - 1].timeline_index ?? rows[rows.length - 1].id,
    messageCount: rows.length,
    formattedMessages: rows.map(formatSourceRow),
  };
};

export const getContextSummary = (userId: number, chatId: number): ContextSummaryDto | null => {
  const row = db.prepare(`
    SELECT content, through_timeline_index, source_message_count, token_count,
           context_limit, model_name, provider_name, updated_at
    FROM chat_context_summaries
    WHERE user_id = ? AND chat_id = ?
  `).get(userId, chatId) as {
    content: string;
    through_timeline_index: number;
    source_message_count: number;
    token_count: number;
    context_limit: number;
    model_name: string | null;
    provider_name: string | null;
    updated_at: string;
  } | undefined;
  return row ? { ...row, updated_at: toUnix(row.updated_at) } : null;
};

export const getMatchingContextSummary = (userId: number, chatId: number, sourceHash: string): ContextSummaryDto | null => {
  const match = db.prepare(`
    SELECT source_hash FROM chat_context_summaries
    WHERE user_id = ? AND chat_id = ?
  `).get(userId, chatId) as { source_hash: string } | undefined;
  return match?.source_hash === sourceHash ? getContextSummary(userId, chatId) : null;
};

export const saveContextSummary = (input: {
  userId: number;
  chatId: number;
  content: string;
  sourceHash: string;
  throughTimelineIndex: number;
  sourceMessageCount: number;
  contextLimit: number;
  modelName: string | null;
  providerName: string | null;
}): ContextSummaryDto => {
  db.prepare(`
    INSERT INTO chat_context_summaries (
      chat_id, user_id, content, source_hash, through_timeline_index,
      source_message_count, token_count, context_limit, model_name, provider_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, user_id) DO UPDATE SET
      content = excluded.content,
      source_hash = excluded.source_hash,
      through_timeline_index = excluded.through_timeline_index,
      source_message_count = excluded.source_message_count,
      token_count = excluded.token_count,
      context_limit = excluded.context_limit,
      model_name = excluded.model_name,
      provider_name = excluded.provider_name,
      updated_at = CURRENT_TIMESTAMP
  `).run(input.chatId, input.userId, input.content, input.sourceHash, input.throughTimelineIndex,
    input.sourceMessageCount, countTokens(input.content), input.contextLimit, input.modelName, input.providerName);
  return getContextSummary(input.userId, input.chatId)!;
};

export const deleteContextSummary = (userId: number, chatId: number): void => {
  db.prepare('DELETE FROM chat_context_summaries WHERE user_id = ? AND chat_id = ?').run(userId, chatId);
};

export const deleteContextSummariesForChat = (chatId: number): void => {
  db.prepare('DELETE FROM chat_context_summaries WHERE chat_id = ?').run(chatId);
};

export const deleteContextSummariesForUser = (userId: number): void => {
  db.prepare('DELETE FROM chat_context_summaries WHERE user_id = ?').run(userId);
};

export const chunkContextSummarySource = (messages: string[], tokenBudget: number): string[] => {
  const safeBudget = Math.max(256, Math.floor(tokenBudget));
  const chunks: string[] = [];
  let current = '';

  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const message of messages) {
    let remaining = message;
    while (remaining) {
      const candidate = current ? `${current}\n\n${remaining}` : remaining;
      if (countTokens(candidate) <= safeBudget) {
        current = candidate;
        remaining = '';
        continue;
      }
      if (current) {
        pushCurrent();
        continue;
      }

      // A single exceptionally large message is split without dropping text.
      let low = 1;
      let high = remaining.length;
      let fit = 1;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (countTokens(remaining.slice(0, mid)) <= safeBudget) {
          fit = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      chunks.push(remaining.slice(0, fit));
      remaining = remaining.slice(fit);
    }
  }
  pushCurrent();
  return chunks;
};
