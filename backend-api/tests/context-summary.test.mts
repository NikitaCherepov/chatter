import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `chatter-context-summary-${process.pid}-${Date.now()}.sqlite`);
process.env.API_DB_PATH = dbPath;

const { db } = await import('../src/db.js');
const {
  getChatContextTokens,
  getChatMessages,
  getHistoryForAi,
  planRoomHistorySummary,
} = await import('../src/services/chats.js');
const { countTokens } = await import('../src/services/tokenizer.js');
const {
  chunkContextSummarySource,
  enforceContextSummaryModelSettings,
  deleteContextSummary,
  getArchivedContextSummarySource,
  getContextSummary,
  getMatchingContextSummary,
  getRoomContextSummarySource,
  saveContextSummary,
} = await import('../src/services/context-summary.js');

db.prepare("INSERT INTO users (id, name, status) VALUES (91, 'Summary owner', 'approved')").run();
const chatId = Number(db.prepare("INSERT INTO user_chats (user_id, title) VALUES (91, 'Summary test')").run().lastInsertRowid);
const insert = db.prepare(`
  INSERT INTO chat_messages (user_id, chat_id, role, content, timeline_index, archived, token_count, tool_calls_json)
  VALUES (91, ?, ?, ?, ?, ?, ?, ?)
`);
insert.run(chatId, 'user', 'My cat is called Pixel.', 1, 1, 7, null);
insert.run(chatId, 'assistant', 'I will remember that.', 2, 1, 6, JSON.stringify([{
  step: 1,
  content: '',
  tool_calls: [{ id: 'memory-search-1', name: 'search_cold_memory', arguments: { query: 'cat' } }],
  results: [{ id: 'memory-search-1', name: 'search_cold_memory', content: 'Pixel prefers sleeping near the window.' }],
}]));
insert.run(chatId, 'user', 'This stays in the active tail.', 3, 0, 8, null);

assert.deepEqual(
  getChatMessages(91, chatId).map(message => message.timeline_index),
  [1, 2, 3],
  'message API exposes the stable timeline boundary used by the summary card',
);

const source = getArchivedContextSummarySource(91, chatId)!;
assert.equal(source.messageCount, 2);
assert.equal(source.throughTimelineIndex, 2);
assert.match(source.formattedMessages[0], /Pixel/);
assert.match(source.formattedMessages[1], /\[TOOL OUTPUT: search_cold_memory\]/);
assert.match(source.formattedMessages[1], /sleeping near the window/);

assert.equal(enforceContextSummaryModelSettings({ max_tokens: 9000 }, 1200).max_tokens, 1200);
assert.equal(enforceContextSummaryModelSettings({ max_tokens: 700 }, 1200).max_tokens, 1200);
assert.equal(enforceContextSummaryModelSettings(null, 1200).max_tokens, 1200);

const saved = saveContextSummary({
  userId: 91,
  chatId,
  content: 'The user has a cat named Pixel.',
  sourceHash: source.hash,
  throughTimelineIndex: source.throughTimelineIndex,
  sourceMessageCount: source.messageCount,
  contextLimit: 10_000,
  modelName: 'test-model',
  providerName: 'test-provider',
});
assert.equal(saved.source_message_count, 2);
assert.equal(getMatchingContextSummary(91, chatId, source.hash)?.content, saved.content);
assert.equal(getMatchingContextSummary(91, chatId, 'stale'), null);

db.prepare("UPDATE chat_messages SET content = 'My cat is called Nova.' WHERE chat_id = ? AND timeline_index = 1").run(chatId);
const changedSource = getArchivedContextSummarySource(91, chatId)!;
assert.notEqual(changedSource.hash, source.hash);
assert.equal(getMatchingContextSummary(91, chatId, changedSource.hash), null);

const chunks = chunkContextSummarySource([`[1] USER: ${'abcdef '.repeat(2000)}`], 300);
assert.ok(chunks.length > 1);
assert.ok(chunks.every((chunk: string) => countTokens(chunk) <= 300));

deleteContextSummary(91, chatId);
assert.equal(getContextSummary(91, chatId), null);

for (const [id, name] of [[92, 'Room owner'], [93, 'Room initiator'], [94, 'Outsider']] as const) {
  db.prepare('INSERT INTO users (id, name, status) VALUES (?, ?, ?)').run(id, name, 'approved');
}
const roomId = Number(db.prepare(
  "INSERT INTO user_chats (user_id, title, room_enabled) VALUES (92, 'Summary room', 1)",
).run().lastInsertRowid);
db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)').run(roomId, 93);
const insertRoomMessage = db.prepare(`
  INSERT INTO chat_messages (user_id, chat_id, role, content, timeline_index, archived, token_count)
  VALUES (?, ?, ?, ?, ?, 0, 150)
`);
insertRoomMessage.run(93, roomId, 'user', 'Room message one', 1);
insertRoomMessage.run(92, roomId, 'assistant', 'Room message two', 2);
insertRoomMessage.run(93, roomId, 'user', 'Room message three', 3);
insertRoomMessage.run(92, roomId, 'assistant', 'Room message four', 4);

const roomPlan = planRoomHistorySummary(93, roomId, 100);
assert.deepEqual(roomPlan, {
  snapshot_timeline_index: 4,
  summarize_through_timeline_index: 3,
});
assert.throws(() => planRoomHistorySummary(94, roomId, 100), /chat_not_found/);

const roomSource = getRoomContextSummarySource(93, roomId, 0, 3)!;
assert.equal(roomSource.messageCount, 3);
assert.match(roomSource.formattedMessages.join('\n'), /Room message one/);
assert.match(roomSource.formattedMessages.join('\n'), /Room message two/);
assert.match(roomSource.formattedMessages[0], /USER \(Room initiator\)/);
assert.match(roomSource.formattedMessages[1], /ASSISTANT \(Room owner\)/);
assert.doesNotMatch(roomSource.formattedMessages.join('\n'), /Room message four/);

const roomSummary = saveContextSummary({
  userId: 93,
  chatId: roomId,
  content: 'The first three room messages were summarized.',
  sourceHash: roomSource.hash,
  throughTimelineIndex: roomSource.throughTimelineIndex,
  sourceMessageCount: roomSource.messageCount,
  contextLimit: 10_000,
  modelName: 'test-model',
  providerName: 'test-provider',
});
assert.equal(getContextSummary(92, roomId), null, 'room summaries remain private to each initiator');
assert.equal(getChatContextTokens(93, roomId).context_summary?.content, roomSummary.content);

insertRoomMessage.run(93, roomId, 'user', 'Arrived after the snapshot', 5);
const stableTail = getHistoryForAi(93, roomId, 0, false, undefined, null, 100, 3, 4);
assert.deepEqual(
  stableTail.map((message: { content: string }) => message.content),
  ['Room message four'],
  'room history uses the summary boundary and excludes rows written after the snapshot',
);

db.close();
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(`${dbPath}${suffix}`); } catch { /* already absent */ }
}
console.log('context summary tests passed');
