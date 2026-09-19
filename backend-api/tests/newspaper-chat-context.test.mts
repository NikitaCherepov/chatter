import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Integration test: injection → chat_messages rows → model history →
 * newspaper tools' "current issue" resolution → TTL sweep.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-newspaper-chat-'));
process.env.API_DB_PATH = path.join(tempDir, 'newspaper-chat.db');

const { db } = await import('../src/db.js');
const { createDemoNewspaperIssue, getNewspaperIssue, listNewspapers } = await import('../src/services/newspapers.js');
const {
  getOrCreateNewspaperChat,
  injectNewspaperContext,
  isNewspaperContextContent,
  newspaperItemId,
  parseNewspaperChatView,
  resolveCurrentIssueFromChat,
} = await import('../src/services/newspaper-chat.js');
const { getHistoryForAi, listStaleTemporaryChats, touchUserChat } = await import('../src/services/chats.js');
const { newspaperIssueContentsTool, newspapersListTool, readNewspaperItemTool } = await import('../src/services/tools/newspapers.js');

db.prepare(`
  INSERT INTO users (id, name, role, is_admin, status, plan, language)
  VALUES (?, ?, 'user', 0, 'approved', 'free', 'ru')
`).run(101, 'Тестовый читатель');

// ── Fixture: one real issue with a known article ─────────────────────────────
const issue = createDemoNewspaperIssue(101);
assert.ok(issue.id > 0, 'demo issue must have a positive server-side id');
const article = issue.document.blocks.find(block => block.type === 'article');
assert.ok(article, 'demo issue must contain an article block');
const notesList = issue.document.blocks.find(block => block.type === 'notes_list');

const chatId = getOrCreateNewspaperChat(101);
assert.ok(Number.isSafeInteger(chatId) && chatId > 0, 'temporary chat id');
assert.equal(getOrCreateNewspaperChat(101), chatId, 'temp chat is reused, not duplicated');

// The temp chat must not leak into the user's normal chat list helpers.
const chatRow = db.prepare('SELECT retention FROM user_chats WHERE id = ?').get(chatId) as { retention: string };
assert.equal(chatRow.retention, 'temporary');

// ── Parse: reject malformed payloads, accept page / material views ───────────
assert.equal(parseNewspaperChatView(undefined), null);
assert.equal(parseNewspaperChatView('nonsense')?.ok, false);
assert.equal(parseNewspaperChatView({ issue_id: -1 })?.ok, false, 'demo (-1) issue ids must be rejected');

const pageView = parseNewspaperChatView({
  issue_id: issue.id,
  page: 2,
  page_count: 3,
  page_id: `issue-${issue.id}-page-2`,
  block_ids: [article!.id],
  block_item_ids: {},
});
assert.equal(pageView?.ok, true);

const itemView = parseNewspaperChatView({
  issue_id: issue.id,
  page: 1,
  page_count: 3,
  block_id: article!.id,
  block_kind: 'article',
});
assert.equal(itemView?.ok, true);

// ── Injection: marker on every send, full row exactly once per view ─────────
await injectNewspaperContext(101, chatId, (pageView as { ok: true; view: any }).view);
await injectNewspaperContext(101, chatId, (pageView as { ok: true; view: any }).view); // same view again
await injectNewspaperContext(101, chatId, (itemView as { ok: true; view: any }).view);

const rows = db.prepare('SELECT role, content FROM chat_messages WHERE chat_id = ? ORDER BY id').all(chatId) as Array<{ role: string; content: string }>;
const markers = rows.filter(row => row.content.startsWith('[ACTIVE_VIEW]'));
const contextRows = rows.filter(row => row.content.startsWith('[NEWSPAPER CONTEXT'));
assert.equal(markers.length, 3, '[ACTIVE_VIEW] is appended on EVERY send');
assert.equal(contextRows.length, 2, 'full context row is deduplicated per view_id');
assert.ok(markers.every(row => row.role === 'user'), 'context rows are plain user-role rows');
assert.ok(contextRows.some(row => row.content.includes(`view_id="issue-${issue.id}-page-2"`)), 'page view_id format');
assert.ok(contextRows.some(row => row.content.includes(`view_id="issue-${issue.id}:article-${article!.id}"`)), 'material view_id format');
const pageRow = contextRows.find(row => row.content.includes(`view_id="issue-${issue.id}-page-2"`));
assert.ok(pageRow?.content.includes(`[article ${article!.id}]`), 'page context contains the visible block');
const hiddenBlock = issue.document.blocks.find(block => block.id !== article!.id);
if (hiddenBlock) assert.ok(!pageRow?.content.includes(`[${hiddenBlock.type} ${hiddenBlock.id}]`), 'page context excludes blocks from other pages');
const materialRow = contextRows.find(row => row.content.includes('article-'));
assert.ok(materialRow!.content.includes(article!.title), 'material row carries the article title');
assert.ok(isNewspaperContextContent(markers[0].content) && !isNewspaperContextContent('Обычное сообщение'), 'display filter predicate');

// ── History: the model must actually see the injected rows ──────────────────
const history = getHistoryForAi(101, chatId) as Array<{ role: string; content: string }>;
const historyContext = history.filter(message => isNewspaperContextContent(String(message.content)));
assert.equal(historyContext.length, 5, 'all marker + context rows survive into model history');
assert.ok(history.some(message => String(message.content).includes('[article ')), 'page row lists article markers');

// ── Current-issue resolution from the chat (tools' "current") ────────────────
assert.equal(resolveCurrentIssueFromChat(chatId), issue.id);
assert.equal(resolveCurrentIssueFromChat(999999), null);

// ── Tools: global newspaper tools with chatId-only context ──────────────────
const toolContext = { userId: 101, timezoneOffset: 0, chatId } as any;
const listResult = await newspapersListTool.handler({}, toolContext);
assert.ok(listResult.includes(`newspaper_id ${listNewspapers(101)[0].id}`), 'newspapers_list output');

const contentsResult = await newspaperIssueContentsTool.handler({}, toolContext);
assert.ok(contentsResult.includes(`[article ${article!.id}]`), 'issue_contents resolves the current issue');

const readResult = await readNewspaperItemTool.handler({ item_id: article!.id }, toolContext);
assert.ok(readResult.includes(article!.title), 'read_newspaper_item returns the material');

if (notesList) {
  const firstNoteId = newspaperItemId(notesList.id, notesList.items[0], 0);
  const noteResult = await readNewspaperItemTool.handler({ item_id: firstNoteId }, toolContext);
  assert.ok(noteResult.length > 0, 'notes_list items are readable');
}

const noChatResult = await newspaperIssueContentsTool.handler({}, { userId: 101, timezoneOffset: 0 } as any);
assert.ok(noChatResult.includes('No newspaper issue is currently open'), 'without chatId the tool explains itself');

// ── Paginated payload (regression): the reader used to send the page slice's
// fake issue id and regenerated block ids — injection silently recorded nothing.
const visibleNoteIds = notesList ? [newspaperItemId(notesList.id, notesList.items[0], 0)] : [];
const paginatedPayload: Record<string, unknown> = {
  issue_id: issue.id,
  page: 1,
  page_count: 2,
  page_id: `issue-${issue.id}-page-1`,
  block_ids: [article!.id, ...(notesList ? [notesList.id] : [])],
};
if (notesList) paginatedPayload.block_item_ids = { [notesList.id]: visibleNoteIds };
const paginatedView = parseNewspaperChatView(paginatedPayload);
assert.equal(paginatedView?.ok, true);
await injectNewspaperContext(101, chatId, (paginatedView as { ok: true; view: any }).view);
await injectNewspaperContext(101, chatId, (paginatedView as { ok: true; view: any }).view); // same page again → dedup by page_id

const contextRowsPaginated = db.prepare("SELECT content FROM chat_messages WHERE chat_id = ? AND content LIKE '[NEWSPAPER CONTEXT%' ORDER BY id").all(chatId) as Array<{ content: string }>;
assert.equal(contextRowsPaginated.length, 3, 'page_id defines a distinct view, deduped on repeat');
const paginatedRow = contextRowsPaginated[contextRowsPaginated.length - 1].content;
assert.ok(paginatedRow.includes(`view_id="issue-${issue.id}-page-1"`), 'renderer page_id becomes the view id');
assert.ok(paginatedRow.includes(`[article ${article!.id}]`), 'canonical article id is listed');
if (notesList) {
  assert.ok(paginatedRow.includes(`[note ${visibleNoteIds[0]}]`), 'visible notes_list item is listed');
  const hiddenIndex = notesList.items.length - 1;
  const hiddenId = newspaperItemId(notesList.id, notesList.items[hiddenIndex], hiddenIndex);
  assert.ok(!paginatedRow.includes(`[note ${hiddenId}]`), 'hidden notes_list item is NOT listed');
}

// ── TTL sweep: stale temp chats are listed, activity keeps them alive ────────
touchUserChat(101, chatId);
assert.equal(listStaleTemporaryChats(10 * 60 * 1000).length, 0, 'fresh temp chat is not stale');
db.prepare("UPDATE user_chats SET updated_at = datetime('now', '-20 minutes') WHERE id = ?").run(chatId);
assert.ok(listStaleTemporaryChats(10 * 60 * 1000).some(row => row.id === chatId), 'idle temp chat becomes stale');

// Stale issue id: injection no-ops silently (nothing recorded).
await injectNewspaperContext(101, chatId, (parseNewspaperChatView({ issue_id: 424242, page: 1, page_count: 1 }) as { ok: true; view: any }).view);
const markersAfterStale = (db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ? AND content LIKE '[ACTIVE_VIEW]%'").get(chatId) as { n: number }).n;
assert.equal(markersAfterStale, 5, 'stale issue id records nothing');

// Sanity: the issue still resolves.
assert.ok(getNewspaperIssue(101, issue.id), 'issue still resolvable');

console.log('newspaper-chat-context: ok');
