import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.API_DB_PATH = path.join(os.tmpdir(), `chatter-chat-member-title-${process.pid}-${Date.now()}.sqlite`);

const { db } = await import('../src/db.js');
const {
  getUserChatListItem,
  listUserChats,
  renameUserChat,
  createChatFolder,
  listChatFolders,
  moveUserChatToFolder,
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

// Owner folder placement must not split or overwrite the member's counters.
const ownerFolderA = createChatFolder(101, 'Owner A');
const ownerFolderB = createChatFolder(101, 'Owner B');
const memberFolder = createChatFolder(202, 'Member folder');
const roomIds = [chatId];
for (const [index, folder] of [ownerFolderA, ownerFolderB].entries()) {
  const id = Number(db.prepare('INSERT INTO user_chats (user_id, title, room_enabled, folder_id) VALUES (?, ?, 1, ?)')
    .run(101, `Room ${index}`, folder.id).lastInsertRowid);
  const token = `folder-count-test-${index}`;
  db.prepare('INSERT INTO chat_invites (token, chat_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(token, id, 101, 1, 4_102_444_800);
  joinChatRoomByInvite(202, token);
  roomIds.push(id);
}
assert.equal(listChatFolders(202).unfiled_count, 3);
assert.equal(listChatFolders(202).total_count, 3);
assert.equal(listChatFolders(101).unfiled_count, 1);
assert.equal(listChatFolders(101).folders.find(folder => folder.id === ownerFolderA.id)?.chat_count, 1);
assert.equal(listChatFolders(101).folders.find(folder => folder.id === ownerFolderB.id)?.chat_count, 1);
assert.equal(listChatFolders(303).total_count, 1, 'unjoined rooms must not be counted');
assert.equal(moveUserChatToFolder(202, roomIds[1], memberFolder.id), true);
const memberCounts = listChatFolders(202);
assert.equal(memberCounts.unfiled_count, 2);
assert.equal(memberCounts.folders.find(folder => folder.id === memberFolder.id)?.chat_count, 1);
assert.equal(memberCounts.total_count, 3);
assert.equal(memberCounts.unfiled_count, listUserChats(202, 100, 0, { folderId: null }).length);
assert.equal(listChatFolders(202, { folderId: memberFolder.id }).total_count, 1);
assert.equal(listChatFolders(101).folders.find(folder => folder.id === ownerFolderA.id)?.chat_count, 1, 'member moves do not change owner counts');
db.close();
console.log('chat member title and folder count tests passed');
