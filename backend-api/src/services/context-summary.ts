import { createHash } from 'node:crypto';
import { db, toUnix } from '../db.js';
import { listRoomReaderUserIds } from './chat-rooms.js';
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

export const enforceContextSummaryModelSettings = <T extends { max_tokens?: number | null }>(
  settings: T | null,
  maxTokens: number,
): T & { max_tokens: number } => {
  return {
    ...((settings ?? {}) as T),
    max_tokens: maxTokens,
  };
};

type SourceRow = {
  id: number;
  timeline_index: number | null;
  role: 'user' | 'assistant';
  content: string;
  attachments: string | null;
  images: string | null;
  tool_calls_json: string | null;
  author_name?: string | null;
  agent_name?: string | null;
};

const formatToolOutputs = (rawJson: string | null): string[] => {
  if (!rawJson) return [];
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    const outputs: string[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const value = item as Record<string, unknown>;
      if (Array.isArray(value.results)) {
        const calls = Array.isArray(value.tool_calls) ? value.tool_calls : [];
        for (const result of value.results) {
          if (!result || typeof result !== 'object') continue;
          const resultValue = result as Record<string, unknown>;
          const matchingCall = calls.find((call) => {
            if (!call || typeof call !== 'object') return false;
            const callValue = call as Record<string, unknown>;
            return resultValue.id && callValue.id === resultValue.id;
          }) as Record<string, unknown> | undefined;
          const name = `${resultValue.name || matchingCall?.name || 'tool'}`;
          const content = typeof resultValue.content === 'string'
            ? resultValue.content
            : resultValue.content == null ? '' : JSON.stringify(resultValue.content);
          if (content.trim()) outputs.push(`[TOOL OUTPUT: ${name}]\n${content}\n[/TOOL OUTPUT]`);
        }
        continue;
      }

      // Legacy flat trace stores only a short result preview.
      const preview = typeof value.result_preview === 'string' ? value.result_preview : '';
      if (preview.trim()) {
        outputs.push(`[TOOL OUTPUT: ${value.name || 'tool'}]\n${preview}\n[/TOOL OUTPUT]`);
      }
    }
    return outputs;
  } catch {
    return [];
  }
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
  const toolOutputs = formatToolOutputs(row.tool_calls_json);
  const toolSuffix = toolOutputs.length > 0 ? `\n${toolOutputs.join('\n')}` : '';
  const speaker = row.role === 'assistant'
    ? (row.agent_name || row.author_name)
    : row.author_name;
  const roleLabel = speaker ? `${row.role.toUpperCase()} (${speaker})` : row.role.toUpperCase();
  return `[${row.timeline_index ?? row.id}] ${roleLabel}: ${row.content}${suffix}${toolSuffix}`;
};

/** Archived rows are the exact prefix removed by provider-anchored trimming. */
export const getArchivedContextSummarySource = (userId: number, chatId: number): ContextSummarySource | null => {
  const rows = db.prepare(`
    SELECT id, timeline_index, role, content, attachments, images, tool_calls_json
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
    tool_calls_json: row.tool_calls_json,
  }));
  return {
    hash: createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex'),
    throughTimelineIndex: rows[rows.length - 1].timeline_index ?? rows[rows.length - 1].id,
    messageCount: rows.length,
    formattedMessages: rows.map(formatSourceRow),
  };
};

/** A stable room-wide slice used to extend one initiator's private summary. */
export const getRoomContextSummarySource = (
  userId: number,
  chatId: number,
  afterTimelineIndex: number,
  throughTimelineIndex: number,
): ContextSummarySource | null => {
  const readerIds = listRoomReaderUserIds(chatId) ?? [];
  if (!readerIds.includes(userId) || readerIds.length < 2) throw new Error('chat_not_found');
  const placeholders = readerIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT cm.id, cm.timeline_index, cm.role, cm.content, cm.attachments, cm.images,
           cm.tool_calls_json, u.name AS author_name, ca.name AS agent_name
    FROM chat_messages cm
    LEFT JOIN users u ON u.id = cm.user_id
    LEFT JOIN chat_agents ca ON ca.id = cm.agent_id
    WHERE cm.chat_id = ? AND cm.user_id IN (${placeholders})
      AND COALESCE(cm.timeline_index, cm.id) > ?
      AND COALESCE(cm.timeline_index, cm.id) <= ?
    ORDER BY COALESCE(cm.timeline_index, cm.id) ASC, cm.id ASC
  `).all(chatId, ...readerIds, afterTimelineIndex, throughTimelineIndex) as SourceRow[];
  if (rows.length === 0) return null;

  const fingerprint = rows.map(row => ({
    id: row.id,
    timeline_index: row.timeline_index,
    role: row.role,
    content: row.content,
    attachments: row.attachments,
    images: row.images,
    tool_calls_json: row.tool_calls_json,
    author_name: row.author_name,
    agent_name: row.agent_name,
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
