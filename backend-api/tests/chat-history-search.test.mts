import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.API_DB_PATH = path.join(os.tmpdir(), `chatter-chat-history-search-${process.pid}-${Date.now()}.sqlite`);

const { db } = await import('../src/db.js');
const { searchChatHistory, searchUserChats } = await import('../src/services/chats.js');
const { updateChatMemorySettings } = await import('../src/services/memory-foundation.js');
const { searchChatHistoryTool } = await import('../src/services/tools/chats/search-chat-history.js');

for (const [id, name] of [[101, 'Owner'], [202, 'Member'], [303, 'Outsider']] as const) {
  db.prepare('INSERT INTO users (id, name, language) VALUES (?, ?, ?)').run(id, name, 'en');
}

const roomId = Number(db.prepare(`
  INSERT INTO user_chats (user_id, title, room_enabled) VALUES (?, ?, 1)
`).run(101, 'Owner room').lastInsertRowid);
db.prepare('INSERT INTO chat_members (chat_id, user_id, title) VALUES (?, ?, ?)')
  .run(roomId, 202, 'Member room title');

const privateChatId = Number(db.prepare(`
  INSERT INTO user_chats (user_id, title) VALUES (?, ?)
`).run(202, 'Private chat').lastInsertRowid);
const hiddenChatId = Number(db.prepare(`
  INSERT INTO user_chats (user_id, title, bot_hidden) VALUES (?, ?, 1)
`).run(202, 'Hidden chat').lastInsertRowid);

const insertMessage = db.prepare(`
  INSERT INTO chat_messages (user_id, role, content, chat_id, created_at)
  VALUES (?, ?, ?, ?, ?)
`);
const roomMessageId = Number(insertMessage.run(
  101,
  'assistant',
  'The observatory keeps a copper telescope near the eastern window.',
  roomId,
  '2026-09-20 12:00:00',
).lastInsertRowid);
const privateMessageId = Number(insertMessage.run(
  202,
  'user',
  'Private pineapple notebook',
  privateChatId,
  '2026-09-21 12:00:00',
).lastInsertRowid);
insertMessage.run(202, 'user', 'Hidden pineapple archive', hiddenChatId, '2026-09-22 12:00:00');

const roomHits = searchChatHistory(202, 'copper telescope', 20);
assert.equal(roomHits.length, 1, 'room member finds messages written by another room participant');
assert.equal(roomHits[0]?.message_id, roomMessageId);
assert.equal(roomHits[0]?.chat_title, 'Member room title', 'member sees their personal room title');

assert.equal(searchChatHistory(303, 'copper telescope', 20).length, 0, 'outsider cannot search room history');
assert.equal(searchChatHistory(202, 'pineapple', 20, roomId).length, 0, 'chat scope excludes other visible chats');
assert.equal(searchChatHistory(202, 'telescope wording-that-does-not-exist', 20, roomId).length, 1,
  'all-terms miss falls back to the relevant individual term');

const pineappleHits = searchChatHistory(202, 'pineapple', 20);
assert.deepEqual(pineappleHits.map(hit => hit.chat_id), [privateChatId], 'bot-hidden chats stay excluded');

const desktopHits = searchUserChats(202, 'pineapple notebook', 20);
assert.equal(desktopHits[0]?.chat_id, privateChatId);
assert.equal(desktopHits[0]?.message_id, privateMessageId, 'desktop search identifies the exact message for navigation');

updateChatMemorySettings(202, roomId, { message_search_scope: 'current' });
const restrictedToolResult = await searchChatHistoryTool.handler(
  { query: 'pineapple', current_chat_only: false },
  { userId: 202, chatId: roomId, timezoneOffset: 0 },
);
assert.match(restrictedToolResult, /No messages found/, 'stored chat scope cannot be widened by tool arguments');

updateChatMemorySettings(202, roomId, { message_search_scope: 'all' });
const unrestrictedToolResult = await searchChatHistoryTool.handler(
  { query: 'pineapple' },
  { userId: 202, chatId: roomId, timezoneOffset: 0 },
);
assert.match(unrestrictedToolResult, new RegExp(`chat_id: ${privateChatId}`), 'all scope searches other accessible chats');

console.log('chat history search tests passed');
