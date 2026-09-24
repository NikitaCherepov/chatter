import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.API_DB_PATH = path.join(os.tmpdir(), `chatter-memory-fork-${process.pid}-${Date.now()}.sqlite`);

const { db } = await import('../src/db.js');
const { forkChat } = await import('../src/services/chats.js');
const {
  createMemoryRecord,
  getChatMemorySettings,
  initializeForkedChatMemory,
  updateChatMemorySettings,
} = await import('../src/services/memory-foundation.js');

db.prepare("INSERT INTO users (id, name, language) VALUES (1, 'Owner', 'en')").run();
const sourceChatId = Number(db.prepare(
  "INSERT INTO user_chats (user_id, title) VALUES (1, 'Source')"
).run().lastInsertRowid);

const insertMessage = db.prepare(`
  INSERT INTO chat_messages (user_id, role, content, chat_id) VALUES (1, 'user', ?, ?)
`);
const messageIds = ['one', 'two', 'three', 'four'].map(content =>
  Number(insertMessage.run(content, sourceChatId).lastInsertRowid)
);
const timelines = db.prepare(`
  SELECT id, timeline_index FROM chat_messages WHERE chat_id = ? ORDER BY timeline_index
`).all(sourceChatId) as Array<{ id: number; timeline_index: number }>;
assert.deepEqual(timelines.map(row => row.timeline_index), [1, 2, 3, 4]);

const sourceSettings = updateChatMemorySettings(1, sourceChatId, {
  memory_mode: 'both',
  write_target: 'chat',
});
assert.ok(sourceSettings.chat_space_id);

const addMemory = (id: string, cursor: number | null) => createMemoryRecord({
  id,
  userId: 1,
  spaceId: sourceSettings.chat_space_id!,
  text: id,
  source: cursor === null ? 'manual' : 'automatic',
  originMessageCursor: cursor,
  chunks: [{ id: `${id}_chunk_0`, text: id, index: 0 }],
});
addMemory('before-deleted-message', 2);
addMemory('after-anchor', 4);
addMemory('manual-memory', null);

// Provenance survives deletion because it is a stable timeline cursor, not a
// foreign key to the source message row.
db.prepare('DELETE FROM chat_messages WHERE id = ? AND chat_id = ?').run(messageIds[1], sourceChatId);

const firstFork = forkChat(1, sourceChatId, messageIds[2]);
assert.ok(firstFork);
assert.equal(firstFork.anchor_timeline_index, 3);
const firstPlan = initializeForkedChatMemory(
  1,
  sourceChatId,
  firstFork.chat_id,
  firstFork.anchor_timeline_index,
);
assert.ok(firstPlan.targetSpace);
assert.deepEqual(
  firstPlan.records.map(item => item.record.id).sort(),
  ['before-deleted-message', 'manual-memory'],
  'fork includes manual memory and automatic memory before the anchor only',
);
assert.equal(getChatMemorySettings(1, firstFork.chat_id).general_space_id, sourceSettings.general_space_id);
assert.notEqual(getChatMemorySettings(1, firstFork.chat_id).chat_space_id, sourceSettings.chat_space_id);

// Simulate the canonical rows written after the vector copy, then prove that a
// branch of this branch compares the same stable timeline positions.
for (const item of firstPlan.records) {
  createMemoryRecord({
    id: `first-${item.record.id}`,
    userId: 1,
    spaceId: firstPlan.targetSpace!.id,
    text: item.record.text,
    source: item.record.source,
    originMessageCursor: item.record.origin_message_cursor,
    chunks: [{ id: `first-${item.record.id}_chunk_0`, text: item.record.text, index: 0 }],
  });
}
createMemoryRecord({
  id: 'first-after-anchor',
  userId: 1,
  spaceId: firstPlan.targetSpace!.id,
  text: 'later branch memory',
  source: 'automatic',
  originMessageCursor: 4,
  chunks: [{ id: 'first-after-anchor_chunk_0', text: 'later branch memory', index: 0 }],
});

const copiedAnchor = db.prepare(`
  SELECT id FROM chat_messages WHERE chat_id = ? AND timeline_index = 3
`).get(firstFork.chat_id) as { id: number };
const secondFork = forkChat(1, firstFork.chat_id, copiedAnchor.id);
assert.ok(secondFork);
assert.equal(secondFork.anchor_timeline_index, 3);
const secondPlan = initializeForkedChatMemory(
  1,
  firstFork.chat_id,
  secondFork.chat_id,
  secondFork.anchor_timeline_index,
);
assert.deepEqual(
  secondPlan.records.map(item => item.record.id).sort(),
  ['first-before-deleted-message', 'first-manual-memory'],
  'branch of branch keeps the same cutoff instead of comparing global row ids',
);

console.log('memory fork tests passed');
