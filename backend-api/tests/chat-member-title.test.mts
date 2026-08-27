import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.API_DB_PATH = path.join(os.tmpdir(), `chatter-chat-member-title-${process.pid}-${Date.now()}.sqlite`);

const { db } = await import('../src/db.js');
const {
  getUserChatListItem,
  listUserChats,
  renameUserChat,
} = await import('../src/services/chats.js');
const { joinChatRoomByInvite } = await import('../src/services/chat-rooms.js');

db.prepare('INSERT INTO users (id, name, language) VALUES (?, ?, ?)').run(101, 'Owner', 'en');
db.prepare('INSERT INTO users (id, name, language) VALUES (?, ?, ?)').run(202, 'Member', 'en');
db.prepare('INSERT INTO users (id, name, language) VALUES (?, ?, ?)').run(303, 'Other member', 'en');

const chatId = Number(db.prepare(`
  INSERT INTO user_chats (user_id, title, room_enabled)
  VALUES (?, ?, 1)
`).run(101, 'Owner room').lastInsertRowid);

db.prepare(`
  INSERT INTO chat_invites (token, chat_id, created_by, created_at, expires_at)
  VALUES (?, ?, ?, ?, ?)
`).run('room-title-test', chatId, 101, 1, 4_102_444_800);
joinChatRoomByInvite(202, 'room-title-test');
joinChatRoomByInvite(303, 'room-title-test');

const joinedTitle = db.prepare('SELECT title FROM chat_members WHERE chat_id = ? AND user_id = ?')
  .get(chatId, 202) as { title: string };
assert.equal(joinedTitle.title, 'Owner room');

assert.equal(getUserChatListItem(202, chatId)?.title, 'Owner room');
assert.equal(renameUserChat(202, chatId, 'My personal room'), true);
assert.equal(getUserChatListItem(202, chatId)?.title, 'My personal room');
assert.equal(getUserChatListItem(101, chatId)?.title, 'Owner room');
assert.equal(getUserChatListItem(303, chatId)?.title, 'Owner room');

assert.equal(renameUserChat(101, chatId, 'Renamed by owner'), true);
assert.equal(getUserChatListItem(101, chatId)?.title, 'Renamed by owner');
assert.equal(getUserChatListItem(202, chatId)?.title, 'My personal room');
assert.equal(getUserChatListItem(303, chatId)?.title, 'Owner room');
assert.equal(renameUserChat(404, chatId, 'Unauthorized'), false);

const memberListItem = listUserChats(202, 100).find(chat => chat.id === chatId);
assert.equal(memberListItem?.title, 'My personal room');

const storedOwnerTitle = db.prepare('SELECT title FROM user_chats WHERE id = ?').get(chatId) as { title: string };
const storedMemberTitle = db.prepare('SELECT title FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, 202) as { title: string };
assert.equal(storedOwnerTitle.title, 'Renamed by owner');
assert.equal(storedMemberTitle.title, 'My personal room');

console.log('chat member title tests passed');
