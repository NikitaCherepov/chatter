import { db } from '../db.js';
import type { NewspaperBlock, NewspaperIssueDocument, NewspaperSource } from '../types.js';
import { appendChatMessage, getOrCreateTemporaryChat } from './chats.js';
import { getNewspaperIssue, listNewspapers } from './newspapers.js';

/**
 * Newspaper reader chat (temporary).
 *
 * The reader keeps a single temporary chat per user: it never appears in chat
 * lists, survives closing/switching issues, and is swept after an idle TTL.
 * Context injection is strictly send-time and idempotent:
 *
 *  - [ACTIVE_VIEW] — a tiny marker row written on EVERY send, so the bot
 *    always knows what the reader is looking at right now (page or material).
 *    Newspaper tools also use it to resolve the "current" issue.
 *  - [NEWSPAPER CONTEXT view_id="…"] — the full payload for a view (page
 *    items or the opened material's full text + sources), written exactly
 *    once per view_id per chat lifetime (dedup scan below).
 *
 * Both rows are ordinary user-role messages: the system prompt and the tool
 * set stay untouched (prompt-cache prefix stays stable), history stays
 * append-only (each context block is paid for exactly once).
 */

const NEWSPAPER_CHAT_TITLE = 'Newspaper';

export type NewspaperChatView = {
  issueId: number;
  page: number;
  pageCount: number;
  /** Page view: ids of blocks visible on the current page (as split by the reader). */
  blockIds?: string[];
  /** Material view: id of the block (or notes_list item) the reader opened. */
  blockId?: string;
  blockKind?: string;
};

/** Parse the client's newspaper_context payload (chat/send, HTTP and WS).
 *  null = absent; ok:false = malformed (caller rejects the request). */
export const parseNewspaperChatView = (raw: unknown): { ok: true; view: NewspaperChatView } | { ok: false; error: string } | null => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'bad_newspaper_context' };
  const record = raw as Record<string, unknown>;
  const issueId = Number(record.issue_id);
  if (!Number.isSafeInteger(issueId) || issueId <= 0) return { ok: false, error: 'bad_newspaper_context' };
  const blockId = typeof record.block_id === 'string' && record.block_id.trim() ? record.block_id.trim() : undefined;
  const view: NewspaperChatView = {
    issueId,
    page: Number.isSafeInteger(Number(record.page)) && Number(record.page) > 0 ? Number(record.page) : 1,
    pageCount: Number.isSafeInteger(Number(record.page_count)) && Number(record.page_count) > 0 ? Number(record.page_count) : 0,
    blockIds: !blockId && Array.isArray(record.block_ids)
      ? (record.block_ids as unknown[]).map(id => `${id}`).filter(Boolean).slice(0, 100)
      : undefined,
    blockId,
    blockKind: typeof record.block_kind === 'string' && record.block_kind.trim() ? record.block_kind.trim() : undefined,
  };
  return { ok: true, view };
};

/** Stable id of a notes_list item — matches the reader's noteMaterial fallback. */
export const newspaperItemId = (listId: string, item: { id?: string }, index: number): string =>
  item.id || `${listId}-${index}`;

/** Marker + context row prefixes (the reader UI filters these from display). */
export const isNewspaperContextContent = (content: string): boolean =>
  content.startsWith('[ACTIVE_VIEW]') || content.startsWith('[NEWSPAPER CONTEXT');

const sanitizeViewToken = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);

export const getOrCreateNewspaperChat = (userId: number): number =>
  getOrCreateTemporaryChat(userId, NEWSPAPER_CHAT_TITLE);

const buildActiveViewText = (viewType: 'newspaper_page' | 'newspaper_item', issueId: number, viewId: string): string =>
  `[ACTIVE_VIEW]\ntype: ${viewType}\nissue_id: ${issueId}\nview_id: ${viewId}\n[/ACTIVE_VIEW]`;

const firstTeaser = (text: string | undefined, max = 220): string => {
  const flat = `${text || ''}`.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/** Human-readable one-line descriptions of issue items (shared with tools). */
export const describeNewspaperBlockLines = (block: NewspaperBlock): string[] => {
  switch (block.type) {
    case 'article':
      return [`[article ${block.id}] "${block.title}" — ${firstTeaser(block.text)}`];
    case 'note':
      return [`[note ${block.id}] "${block.title || 'Note'}" — ${firstTeaser(block.text)}`];
    case 'notes_list':
      return [
        `[notes_list ${block.id}] "${block.title || 'Brief notes'}":`,
        ...block.items.map((item, index) =>
          `  [note ${newspaperItemId(block.id, item, index)}] "${item.title || 'Note'}" — ${firstTeaser(item.text)}`),
      ];
    case 'weather':
      return [`[weather ${block.id}] ${block.location}: ${block.condition}${block.details ? ` (${block.details})` : ''}`];
    case 'image':
      return [`[image ${block.id}] "${block.title}"${block.caption ? ` — ${firstTeaser(block.caption, 120)}` : ''}`];
  }
};

type NewspaperMaterialLike = {
  kind: 'article' | 'note' | 'list';
  title: string;
  text: string;
  url?: string;
  sources?: NewspaperSource[];
};

/** Find an openable material by id: article/note blocks and notes_list items. */
export const findNewspaperMaterial = (document: NewspaperIssueDocument, materialId: string): NewspaperMaterialLike | null => {
  for (const block of document.blocks) {
    if (block.id === materialId) {
      if (block.type === 'article') return { kind: 'article', title: block.title, text: block.long_text || block.text, url: block.url, sources: block.sources };
      if (block.type === 'note') return { kind: 'note', title: block.title || 'Note', text: block.long_text || block.text || '', url: block.url, sources: block.sources };
      continue;
    }
    if (block.type === 'notes_list') {
      const index = block.items.findIndex((item, i) => newspaperItemId(block.id, item, i) === materialId);
      if (index >= 0) {
        const item = block.items[index];
        return { kind: 'note', title: item.title || 'Note', text: item.long_text || item.text || '', url: item.url, sources: item.sources };
      }
    }
  }
  return null;
};

const formatSources = (sources?: NewspaperSource[]): string[] =>
  !sources || sources.length === 0 ? [] : ['Sources:', ...sources.map(source => `- ${source.title} — ${source.url}`)];

const newspaperNameFor = (userId: number, newspaperId: number): string => {
  const newspaper = listNewspapers(userId).find(entry => entry.id === newspaperId);
  return newspaper?.name || 'Newspaper';
};

const hasContextRowFor = (chatId: number, viewId: string): boolean => Boolean(
  db.prepare('SELECT 1 FROM chat_messages WHERE chat_id = ? AND content LIKE ? LIMIT 1')
    .get(chatId, `%[NEWSPAPER CONTEXT view_id="${viewId}"%`)
);

/** Idempotent send-time context injection into the newspaper chat. */
export const injectNewspaperContext = async (userId: number, chatId: number, view: NewspaperChatView): Promise<void> => {
  const page = Number.isSafeInteger(view.page) && view.page > 0 ? view.page : 1;
  const pageCount = Number.isSafeInteger(view.pageCount) && view.pageCount > 0 ? view.pageCount : 0;
  const issue = getNewspaperIssue(userId, view.issueId);
  if (!issue) return; // stale/deleted issue — nothing meaningful to record

  const isItemView = Boolean(view.blockId);
  const viewId = isItemView
    ? `issue-${issue.id}:${sanitizeViewToken(view.blockKind || 'item')}-${sanitizeViewToken(view.blockId || '')}`
    : `issue-${issue.id}:page-${page}`;

  await appendChatMessage(userId, chatId, 'user', buildActiveViewText(isItemView ? 'newspaper_item' : 'newspaper_page', issue.id, viewId));
  if (hasContextRowFor(chatId, viewId)) return;

  const newspaperName = newspaperNameFor(userId, issue.newspaper_id);
  const issueHeader = (position: string) =>
    `The reader is reading their personal newspaper "${newspaperName}", issue #${issue.issue_number} "${issue.document.title}" (${issue.document.date})${position}.`;

  if (isItemView) {
    const material = findNewspaperMaterial(issue.document, view.blockId as string);
    if (!material) return; // unknown id — ACTIVE_VIEW above is enough
    const position = pageCount > 0 ? `, currently on page ${page} of ${pageCount}` : '';
    const lines = [
      `[NEWSPAPER CONTEXT view_id="${viewId}"]`,
      `The reader opened the full text of the following material from their personal newspaper "${newspaperName}", issue #${issue.issue_number} "${issue.document.title}" (${issue.document.date})${position}:`,
      '',
      `[${material.kind} ${view.blockId}] "${material.title}"`,
      material.text || '(no text)',
    ];
    if (material.url) lines.push('', `Source article: ${material.url}`);
    const sources = formatSources(material.sources);
    if (sources.length > 0) lines.push('', ...sources);
    lines.push(
      '',
      'This block is automated reading context, not a message from the reader. Do not reply to it directly.',
      '[/NEWSPAPER CONTEXT]',
    );
    await appendChatMessage(userId, chatId, 'user', lines.join('\n'));
    return;
  }

  const blockIds = new Set((view.blockIds || []).map(id => `${id}`));
  const lines = [
    `[NEWSPAPER CONTEXT view_id="${viewId}"]`,
    issueHeader(pageCount > 0 ? `, currently viewing page ${page} of ${pageCount}` : ', currently viewing the issue'),
    'Items visible on this page (ids can be passed to the read_newspaper_item tool for full text and sources):',
  ];
  for (const block of issue.document.blocks) {
    if (blockIds.size > 0 && !blockIds.has(block.id)) continue;
    lines.push(...describeNewspaperBlockLines(block).map(line => `- ${line}`));
  }
  lines.push(
    '',
    'This block is automated reading context, not a message from the reader. Do not reply to it directly.',
    '[/NEWSPAPER CONTEXT]',
  );
  await appendChatMessage(userId, chatId, 'user', lines.join('\n'));
};

/** The issue the reader currently has open — the most recent [ACTIVE_VIEW]
 *  marker in this chat. Used by newspaper tools to resolve "current". */
export const resolveCurrentIssueFromChat = (chatId: number): number | null => {
  const rows = db.prepare(
    'SELECT content FROM chat_messages WHERE chat_id = ? AND content LIKE ? ORDER BY id DESC LIMIT 20'
  ).all(chatId, '%[ACTIVE_VIEW]%') as Array<{ content: string }>;
  for (const row of rows) {
    const match = row.content.match(/issue_id:\s*(\d+)/);
    if (match) return Number(match[1]);
  }
  return null;
};
