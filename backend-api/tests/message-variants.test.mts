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
  getHistoryForAi,
  getChatMessageVariants,
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

// Regeneration excludes the entire stored response, including all tool steps.
const regenChat = createUserChat(81, 'Regeneration context');
await appendChatMessage(81, regenChat, 'user', 'Earlier question');
await appendChatMessage(81, regenChat, 'assistant', 'Earlier answer');
await appendChatMessage(81, regenChat, 'user', 'Current question');
const toolResponse = await appendChatMessage(81, regenChat, 'assistant', 'Old final', null, null, null, null, JSON.stringify([
  { step: 0, content: 'Old intermediate', tool_calls: [{ id: 'old-call', name: 'search', arguments: { q: 'old query' } }], results: [{ id: 'old-call', name: 'search', content: 'Old result' }] },
  { step: 1, content: 'Old final' },
]));
const expected = [
  { role: 'user', content: 'Earlier question' },
  { role: 'assistant', content: 'Earlier answer' },
  { role: 'user', content: 'Current question' },
];
const regenerationHistory = (messageId?: number) => getHistoryForAi(81, regenChat, 0, false, undefined, null, 0, 0, undefined, { messageId });
assert.deepEqual(regenerationHistory(toolResponse), expected);
assert.deepEqual(regenerationHistory(), expected, 'legacy regeneration also drops complete tool iterations');
assert.ok(getHistoryForAi(81, regenChat).some(message => message.role === 'tool'), 'ordinary context keeps tools');
assert.equal(getChatMessages(81, regenChat, 20, 0).find(message => message.id === toolResponse)!.content, 'Old final', 'context filtering does not erase the saved answer');
assert.throws(() => regenerationHistory(assistantId), /regenerate_message_not_found/, 'a foreign target must not expose the current answer');
await appendChatMessage(81, regenChat, 'assistant', 'Plain replacement', null, null, null, null, null, null, null, { regenerateMessageId: toolResponse });
assert.deepEqual(regenerationHistory(toolResponse), expected, 'plain replacement is also excluded');
assert.deepEqual(activateChatMessageVariant(81, regenChat, toolResponse, 0), { ok: true });
assert.deepEqual(regenerationHistory(toolResponse), expected, 'switching back to a tool variant remains safe');

const variants = getChatMessageVariants(81, regenChat, toolResponse);
assert.equal(variants.length, 2);
assert.deepEqual(variants.map(message => message.variant_index), [0, 1]);
assert.deepEqual(variants.map(message => message.content), ['Old final', 'Plain replacement']);
assert.ok(variants.every(message => message.id === toolResponse && message.variant_count === 2 && message.audio === null));
assert.equal(variants[0].tool_calls?.[0].result_preview, 'Old result');
assert.equal(getMessageVariantState(toolResponse).variant_index, 0, 'loading variants never activates one');
assert.deepEqual(getChatMessageVariants(999, regenChat, toolResponse), [], 'unauthorized readers cannot preload variants');
assert.deepEqual(getChatMessageVariants(81, chatId, toolResponse), [], 'variants stay scoped to their chat');
await appendChatMessage(81, regenChat, 'user', 'Next question');
assert.deepEqual(getChatMessageVariants(81, regenChat, toolResponse), [], 'only the current final message preloads variants');

// Work-log metadata comes from each saved variant's trace without changing content.
const logChat = createUserChat(81, 'Work log');
const logTrace = JSON.stringify([
  {step:1,content:'Searching.',tool_calls:[{id:'search-1',name:'search_web',arguments:{}}],results:[]},
  {step:2,content:'Final answer.',tool_calls:[],results:[],is_final:true},
]);
const logId = await appendChatMessage(81, logChat, 'assistant', 'Searching.\n\nFinal answer.', null, null, null, null, logTrace);
const loadedLog = getChatMessages(81, logChat, 20, 0).find(item=>item.id===logId)!;
assert.deepEqual(loadedLog.intermediate_messages,['Searching.']);
assert.equal(loadedLog.content,'Searching.\n\nFinal answer.','AI context and stored content remain intact');
await appendChatMessage(81, logChat, 'assistant', 'Plain alternative', null, null, null, null, null, null, null, {regenerateMessageId:logId});
const logVariants = getChatMessageVariants(81, logChat, logId);
assert.deepEqual(logVariants[0].intermediate_messages,['Searching.']);
assert.deepEqual(logVariants[1].intermediate_messages,[],'work logs stay isolated between regenerated variants');
db.close();
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(`${dbPath}${suffix}`); } catch { /* already absent */ }
}
console.log('message variant tests passed');
