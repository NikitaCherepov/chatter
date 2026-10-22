import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-chat-activity-'));
process.env.API_DB_PATH = path.join(tempDir, 'test.sqlite');
process.env.ENCRYPTION_KEY = 'chat-activity-test-key';

const { db } = await import('../src/db.js');
const { appendChatMessage, listUserChats, touchUserChat } = await import('../src/services/chats.js');
const { joinChatRoomByInvite } = await import('../src/services/chat-rooms.js');

try {
  for (const id of [101, 202, 303]) {
    db.prepare('INSERT INTO users (id, name, language) VALUES (?, ?, ?)').run(id, `User ${id}`, 'en');
  }
  const roomId = Number(db.prepare('INSERT INTO user_chats (user_id, title, room_enabled) VALUES (?, ?, 1)')
    .run(101, 'Shared room').lastInsertRowid);
  db.prepare('INSERT INTO chat_invites (token, chat_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run('activity-test', roomId, 101, 1, 4_102_444_800);
  joinChatRoomByInvite(202, 'activity-test');
  joinChatRoomByInvite(303, 'activity-test');
  const personalIds = new Map<number, number>();
  for (const id of [101, 202, 303]) {
    personalIds.set(id, Number(db.prepare('INSERT INTO user_chats (user_id, title) VALUES (?, ?)')
      .run(id, `Private ${id}`).lastInsertRowid));
  }
  const oldDate = '2000-01-01 00:00:00';
  const resetActivity = () => {
    db.prepare("UPDATE user_chats SET updated_at = '2001-01-01 00:00:00'").run();
    db.prepare('UPDATE user_chats SET updated_at = ? WHERE id = ?').run(oldDate, roomId);
    for (const id of [101, 202, 303]) assert.equal(listUserChats(id)[0].id, personalIds.get(id));
  };
  const assertRoomFirst = () => {
    for (const id of [101, 202, 303]) {
      const chats = listUserChats(id);
      assert.equal(chats[0].id, roomId, `room must sort first for reader ${id}`);
      assert.ok(chats[0].updated_at > 1_000_000_000);
    }
  };

  resetActivity();
  await appendChatMessage(202, roomId, 'user', 'Message from a non-owner');
  assertRoomFirst();

  resetActivity();
  const assistantId = await appendChatMessage(303, roomId, 'assistant', 'Reply from a non-owner bot');
  assertRoomFirst();

  resetActivity();
  await appendChatMessage(303, roomId, 'assistant', 'Regenerated reply', null, null, null, null, null, null, null, {
    regenerateMessageId: assistantId,
  });
  assertRoomFirst();

  resetActivity();
  await appendChatMessage(101, roomId, 'user', 'Owner message');
  assertRoomFirst();

  resetActivity();
  touchUserChat(404, roomId);
  assert.equal((db.prepare('SELECT updated_at FROM user_chats WHERE id = ?').get(roomId) as any).updated_at, oldDate);
  const privateId = personalIds.get(101)!;
  touchUserChat(202, privateId);
  assert.equal((db.prepare('SELECT updated_at FROM user_chats WHERE id = ?').get(privateId) as any).updated_at, '2001-01-01 00:00:00');

  await appendChatMessage(101, privateId, 'assistant', 'Scheduled notification');
  assert.ok((db.prepare('SELECT updated_at FROM user_chats WHERE id = ?').get(privateId) as any).updated_at > oldDate);
  assert.equal((db.prepare('SELECT user_id FROM user_chats WHERE id = ?').get(roomId) as any).user_id, 101);
  console.log('chat activity order tests passed');
} finally {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
