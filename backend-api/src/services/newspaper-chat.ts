import fs from 'node:fs';
import { db } from '../db.js';
import type { MessageImage, NewspaperBlock, NewspaperIssueDocument, NewspaperSource } from '../types.js';
import { appendChatMessage, getOrCreateTemporaryChat } from './chats.js';
import { getNewspaperIssue, listNewspapers } from './newspapers.js';
import { getMediaAssetByUrl, getReusableMediaAssetBySourceUrl, saveImageAsset } from './media-assets.js';
import { resolveImageFile } from './image-storage.js';

/**
 * Newspaper reader chat (temporary): one per user, hidden from chat lists,
 * swept after an idle TTL. Injection is send-time and idempotent:
 *  - [ACTIVE_VIEW] — marker on every send; newspaper tools resolve the
 *    "current" issue from it;
 *  - [NEWSPAPER CONTEXT view_id="…"] — full view payload, written once per
 *    view_id (dedup scan).
 * Both are ordinary user-role rows, so the system prompt, toolset and
 * prompt-cache prefix stay stable.
 */

const NEWSPAPER_CHAT_TITLE = 'Newspaper';

export type NewspaperChatView = {
  issueId: number;
  page: number;
  pageCount: number;
  /** Stable id produced by the renderer for this exact paginated page. */
  pageId?: string;
  /** Page view: ids of blocks visible on the current page (as split by the reader). */
  blockIds?: string[];
  /** Visible notes_list item ids, keyed by canonical source block id. */
  blockItemIds?: Record<string, string[]>;
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
  const rawBlockItemIds = record.block_item_ids;
  const blockItemIds = !blockId && rawBlockItemIds && typeof rawBlockItemIds === 'object' && !Array.isArray(rawBlockItemIds)
    ? Object.fromEntries(Object.entries(rawBlockItemIds as Record<string, unknown>)
        .slice(0, 100)
        .map(([key, value]) => [
          `${key}`.slice(0, 160),
          Array.isArray(value) ? value.map(id => `${id}`).filter(Boolean).slice(0, 100) : [],
        ])
        .filter(([key]) => Boolean(key)))
    : undefined;
  const view: NewspaperChatView = {
    issueId,
    page: Number.isSafeInteger(Number(record.page)) && Number(record.page) > 0 ? Number(record.page) : 1,
    pageCount: Number.isSafeInteger(Number(record.page_count)) && Number(record.page_count) > 0 ? Number(record.page_count) : 0,
    pageId: typeof record.page_id === 'string' && record.page_id.trim() ? record.page_id.trim() : undefined,
    blockIds: !blockId && Array.isArray(record.block_ids)
      ? (record.block_ids as unknown[]).map(id => `${id}`).filter(Boolean).slice(0, 100)
      : undefined,
    blockItemIds,
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

/** Suffix exposing a local image asset url — the model can pass it to describe_image. */
const imageSuffix = (url: string | undefined, remap?: (url: string) => string): string =>
  url ? ` (image_url: ${remap ? remap(url) : url})` : '';

/** Compressed chat variant of a newspaper image (thumbnail webp, GIF → first frame) —
 *  the same pipeline as user-attached photos, reused per source url. */
const chatImageVariantUrl = async (userId: number, url: string): Promise<string> => {
  try {
    const reused = getReusableMediaAssetBySourceUrl(userId, url);
    if (reused) return reused.local_url;
    const asset = getMediaAssetByUrl(url);
    const filepath = asset ? resolveImageFile(asset.storage_filename) : null;
    if (!filepath) return url;
    const saved = await saveImageAsset({
      userId,
      data: fs.readFileSync(filepath),
      retention: 'temporary',
      kind: 'newspaper_chat_image',
      transform: 'thumbnail',
      sourceUrl: url,
      ttlSeconds: 24 * 60 * 60,
    });
    return saved.url;
  } catch {
    return url;
  }
};

const attachedChatImages = (urls: string[]): MessageImage[] | null =>
  urls.length > 0 ? urls.map(url => ({ url, type: 'external' })) : null;

/** Human-readable one-line descriptions of issue items (shared with tools). */
export const describeNewspaperBlockLines = (block: NewspaperBlock, remapImageUrl?: (url: string) => string): string[] => {
  switch (block.type) {
    case 'article':
      return [`[article ${block.id}] "${block.title}" — ${firstTeaser(block.text)}${imageSuffix(block.image_url, remapImageUrl)}`];
    case 'note':
      return [`[note ${block.id}] "${block.title || 'Note'}" — ${firstTeaser(block.text)}${imageSuffix(block.image_url, remapImageUrl)}`];
    case 'notes_list':
      return [
        `[notes_list ${block.id}] "${block.title || 'Brief notes'}":`,
        ...block.items.map((item, index) =>
          `  [note ${newspaperItemId(block.id, item, index)}] "${item.title || 'Note'}" — ${firstTeaser(item.text)}${imageSuffix(item.image_url, remapImageUrl)}`),
      ];
    case 'weather':
      return [`[weather ${block.id}] ${block.location}: ${block.condition}${block.details ? ` (${block.details})` : ''}`];
    case 'image':
      return [`[image ${block.id}] "${block.title}"${block.caption ? ` — ${firstTeaser(block.caption, 120)}` : ''}${imageSuffix(block.image_url, remapImageUrl)}`];
  }
};

type NewspaperMaterialLike = {
  kind: 'article' | 'note' | 'list' | 'image';
  title: string;
  text: string;
  url?: string;
  imageUrl?: string;
  sources?: NewspaperSource[];
};

/** Find an openable material by id: article/note/image blocks and notes_list items. */
export const findNewspaperMaterial = (document: NewspaperIssueDocument, materialId: string): NewspaperMaterialLike | null => {
  for (const block of document.blocks) {
    if (block.id === materialId) {
      if (block.type === 'article') return { kind: 'article', title: block.title, text: block.long_text || block.text, url: block.url, imageUrl: block.image_url, sources: block.sources };
      if (block.type === 'note') return { kind: 'note', title: block.title || 'Note', text: block.long_text || block.text || '', url: block.url, imageUrl: block.image_url, sources: block.sources };
      if (block.type === 'image') return { kind: 'image', title: block.title, text: block.caption || block.prompt || '', imageUrl: block.image_url };
      continue;
    }
    if (block.type === 'notes_list') {
      const index = block.items.findIndex((item, i) => newspaperItemId(block.id, item, i) === materialId);
      if (index >= 0) {
        const item = block.items[index];
        return { kind: 'note', title: item.title || 'Note', text: item.long_text || item.text || '', url: item.url, imageUrl: item.image_url, sources: item.sources };
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

/** Image urls visible in the page view (respects the reader's block/item scope). */
const collectViewImageUrls = (
  document: NewspaperIssueDocument,
  view: NewspaperChatView,
  hasExplicitBlockScope: boolean,
  blockIds: Set<string>,
): string[] => {
  const urls: string[] = [];
  const push = (url: string | undefined) => { if (url) urls.push(url); };
  for (const block of document.blocks) {
    if (hasExplicitBlockScope && !blockIds.has(block.id)) continue;
    if (block.type === 'notes_list' && view.blockItemIds && Object.hasOwn(view.blockItemIds, block.id)) {
      const visibleItemIds = new Set(view.blockItemIds[block.id]);
      block.items.forEach((item, index) => {
        if (visibleItemIds.has(newspaperItemId(block.id, item, index))) push(item.image_url);
      });
      continue;
    }
    if (block.type === 'image' || block.type === 'article' || block.type === 'note') push(block.image_url);
  }
  return [...new Set(urls)];
};

/** Idempotent send-time context injection into the newspaper chat. */
export const injectNewspaperContext = async (userId: number, chatId: number, view: NewspaperChatView): Promise<void> => {
  const page = Number.isSafeInteger(view.page) && view.page > 0 ? view.page : 1;
  const pageCount = Number.isSafeInteger(view.pageCount) && view.pageCount > 0 ? view.pageCount : 0;
  const issue = getNewspaperIssue(userId, view.issueId);
  if (!issue) {
    // Loud on purpose: this was the "injection silently did nothing" case.
    console.warn(`[newspaper-chat] user=${userId} chat=${chatId} issue=${view.issueId} NOT FOUND — no context recorded`);
    return;
  }

  const isItemView = Boolean(view.blockId);
  const viewId = isItemView
    ? `issue-${issue.id}:${sanitizeViewToken(view.blockKind || 'item')}-${sanitizeViewToken(view.blockId || '')}`
    : sanitizeViewToken(view.pageId || '') || `issue-${issue.id}:page-${page}`;

  await appendChatMessage(userId, chatId, 'user', buildActiveViewText(isItemView ? 'newspaper_item' : 'newspaper_page', issue.id, viewId));
  if (hasContextRowFor(chatId, viewId)) {
    console.log(`[newspaper-chat] user=${userId} chat=${chatId} view=${viewId} marker written, full row deduped`);
    return;
  }

  const newspaperName = newspaperNameFor(userId, issue.newspaper_id);
  const issueHeader = (position: string) =>
    `The reader is reading their personal newspaper "${newspaperName}", issue #${issue.issue_number} "${issue.document.title}" (${issue.document.date})${position}.`;

  if (isItemView) {
    const material = findNewspaperMaterial(issue.document, view.blockId as string);
    if (!material) return; // unknown id — ACTIVE_VIEW above is enough
    const illustrationUrl = material.imageUrl ? await chatImageVariantUrl(userId, material.imageUrl) : null;
    const position = pageCount > 0 ? `, currently on page ${page} of ${pageCount}` : '';
    const lines = [
      `[NEWSPAPER CONTEXT view_id="${viewId}"]`,
      `The reader opened the full text of the following material from their personal newspaper "${newspaperName}", issue #${issue.issue_number} "${issue.document.title}" (${issue.document.date})${position}:`,
      '',
      `[${material.kind} ${view.blockId}] "${material.title}"`,
      material.text || '(no text)',
    ];
    if (material.url) lines.push('', `Source article: ${material.url}`);
    if (illustrationUrl) lines.push('', `Illustration: ${illustrationUrl}`);
    const sources = formatSources(material.sources);
    if (sources.length > 0) lines.push('', ...sources);
    lines.push(
      '',
      'This block is automated reading context, not a message from the reader. Do not reply to it directly.',
      '[/NEWSPAPER CONTEXT]',
    );
    await appendChatMessage(userId, chatId, 'user', lines.join('\n'), null, null, attachedChatImages(illustrationUrl ? [illustrationUrl] : []));
    console.log(`[newspaper-chat] user=${userId} chat=${chatId} view=${viewId} material context row written`);
    return;
  }

  const blockIds = new Set((view.blockIds || []).map(id => `${id}`));
  const hasExplicitBlockScope = Array.isArray(view.blockIds);
  // Compressed variants for the view's images — attached to this row so vision
  // models see them inline; non-vision models get [Attached image N: url] markers.
  const variantMap = new Map(await Promise.all(
    collectViewImageUrls(issue.document, view, hasExplicitBlockScope, blockIds)
      .map(async url => [url, await chatImageVariantUrl(userId, url)] as const)));
  const variantUrls = [...variantMap.values()];
  const remapImageUrl = (url: string) => variantMap.get(url) || url;
  const lines = [
    `[NEWSPAPER CONTEXT view_id="${viewId}"]`,
    issueHeader(pageCount > 0 ? `, currently viewing page ${page} of ${pageCount}` : ', currently viewing the issue'),
    'Items visible on this page (ids can be passed to the read_newspaper_item tool for full text and sources):',
  ];
  for (const block of issue.document.blocks) {
    if (hasExplicitBlockScope && !blockIds.has(block.id)) continue;
    if (block.type === 'notes_list' && view.blockItemIds && Object.hasOwn(view.blockItemIds, block.id)) {
      const visibleItemIds = new Set(view.blockItemIds[block.id]);
      const visibleItems = block.items.filter((item, index) =>
        visibleItemIds.has(newspaperItemId(block.id, item, index)));
      if (visibleItems.length === 0) continue;
      lines.push(`- [notes_list ${block.id}] "${block.title || 'Brief notes'}":`);
      lines.push(...visibleItems.map((item, index) => {
        const originalIndex = block.items.indexOf(item);
        return `-   [note ${newspaperItemId(block.id, item, originalIndex >= 0 ? originalIndex : index)}] "${item.title || 'Note'}" — ${firstTeaser(item.text)}${imageSuffix(item.image_url, remapImageUrl)}`;
      }));
      continue;
    }
    lines.push(...describeNewspaperBlockLines(block, remapImageUrl).map(line => `- ${line}`));
  }
  lines.push(
    '',
    'This block is automated reading context, not a message from the reader. Do not reply to it directly.',
    '[/NEWSPAPER CONTEXT]',
  );
  await appendChatMessage(userId, chatId, 'user', lines.join('\n'), null, null, attachedChatImages(variantUrls));
  console.log(`[newspaper-chat] user=${userId} chat=${chatId} view=${viewId} page context row written`);
};

/** Current issue = the most recent [ACTIVE_VIEW] marker; used by newspaper tools. */
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
