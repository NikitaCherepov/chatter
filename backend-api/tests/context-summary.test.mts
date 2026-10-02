import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `chatter-context-summary-${process.pid}-${Date.now()}.sqlite`);
process.env.API_DB_PATH = dbPath;

const { db } = await import('../src/db.js');
const { getChatMessages } = await import('../src/services/chats.js');
const { countTokens } = await import('../src/services/tokenizer.js');
const {
  chunkContextSummarySource,
  deleteContextSummary,
  getArchivedContextSummarySource,
  getContextSummary,
  getMatchingContextSummary,
  saveContextSummary,
} = await import('../src/services/context-summary.js');

db.prepare("INSERT INTO users (id, name, status) VALUES (91, 'Summary owner', 'approved')").run();
const chatId = Number(db.prepare("INSERT INTO user_chats (user_id, title) VALUES (91, 'Summary test')").run().lastInsertRowid);
const insert = db.prepare(`
  INSERT INTO chat_messages (user_id, chat_id, role, content, timeline_index, archived, token_count)
  VALUES (91, ?, ?, ?, ?, ?, ?)
`);
insert.run(chatId, 'user', 'My cat is called Pixel.', 1, 1, 7);
insert.run(chatId, 'assistant', 'I will remember that.', 2, 1, 6);
insert.run(chatId, 'user', 'This stays in the active tail.', 3, 0, 8);

assert.deepEqual(
  getChatMessages(91, chatId).map(message => message.timeline_index),
  [1, 2, 3],
  'message API exposes the stable timeline boundary used by the summary card',
);

const source = getArchivedContextSummarySource(91, chatId)!;
assert.equal(source.messageCount, 2);
assert.equal(source.throughTimelineIndex, 2);
assert.match(source.formattedMessages[0], /Pixel/);

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

db.close();
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(`${dbPath}${suffix}`); } catch { /* already absent */ }
}
console.log('context summary tests passed');
