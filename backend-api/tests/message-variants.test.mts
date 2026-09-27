import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `chatter-message-variants-${process.pid}-${Date.now()}.sqlite`);
process.env.API_DB_PATH = dbPath;

const { db } = await import('../src/db.js');
const {
  activateChatMessageVariant,
  appendChatMessage,
  createUserChat,
  editUserMessage,
  forkChat,
  getChatMessages,
  getMessageVariantState,
} = await import('../src/services/chats.js');

db.prepare("INSERT INTO users (id, name, language, status) VALUES (81, 'Owner', 'en', 'approved')").run();
const chatId = createUserChat(81, 'Variants');
await appendChatMessage(81, chatId, 'user', 'Question');
const assistantId = await appendChatMessage(81, chatId, 'assistant', 'First answer', null, null, null, 'First reasoning');

assert.deepEqual(getMessageVariantState(assistantId), { variant_index: 0, variant_count: 1 });

const regeneratedId = await appendChatMessage(
  81,
  chatId,
  'assistant',
  'Second answer',
  null,
  null,
  null,
  'Second reasoning',
  null,
  null,
  null,
  { modelName: 'test-model', providerName: 'test-provider', regenerateMessageId: assistantId },
);
assert.equal(regeneratedId, assistantId, 'regeneration keeps the stable message id');
assert.deepEqual(getMessageVariantState(assistantId), { variant_index: 1, variant_count: 2 });

let message = getChatMessages(81, chatId, 20, 0).find(item => item.id === assistantId)!;
assert.equal(message.content, 'Second answer');
assert.equal(message.reasoning_content, 'Second reasoning');
assert.equal(message.variant_index, 1);
assert.equal(message.variant_count, 2);

assert.deepEqual(activateChatMessageVariant(81, chatId, assistantId, 0), { ok: true });
message = getChatMessages(81, chatId, 20, 0).find(item => item.id === assistantId)!;
assert.equal(message.content, 'First answer');

assert.equal(editUserMessage(81, chatId, assistantId, 'Edited first answer').ok, true);
assert.deepEqual(activateChatMessageVariant(81, chatId, assistantId, 1), { ok: true });
assert.deepEqual(activateChatMessageVariant(81, chatId, assistantId, 0), { ok: true });
message = getChatMessages(81, chatId, 20, 0).find(item => item.id === assistantId)!;
assert.equal(message.content, 'Edited first answer', 'editing updates the active saved variant');

const fork = forkChat(81, chatId, assistantId);
assert.ok(fork);
const copied = getChatMessages(81, fork.chat_id, 20, 0).find(item => item.role === 'assistant')!;
assert.equal(copied.variant_count, 2, 'fork copies all response variants');
assert.deepEqual(activateChatMessageVariant(81, fork.chat_id, copied.id, 1), { ok: true });
assert.equal(getChatMessages(81, fork.chat_id, 20, 0).find(item => item.id === copied.id)!.content, 'Second answer');

await appendChatMessage(81, chatId, 'user', 'Follow-up');
assert.deepEqual(
  activateChatMessageVariant(81, chatId, assistantId, 1),
  { ok: false, error: 'not_latest_message' },
  'old messages cannot change the active timeline without branching',
);

db.close();
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(`${dbPath}${suffix}`); } catch { /* already absent */ }
}
console.log('message variant tests passed');
