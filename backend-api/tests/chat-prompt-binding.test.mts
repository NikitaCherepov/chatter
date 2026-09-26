import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `chatter-chat-prompt-${process.pid}-${Date.now()}.sqlite`);
process.env.API_DB_PATH = dbPath;

const { db } = await import('../src/db.js');
const { createChatRoom } = await import('../src/services/chat-rooms.js');
const {
  createUserChat,
  getChatPromptSettings,
  getUserById,
  resolvePromptForChat,
  updateChatPromptSettings,
} = await import('../src/services/chats.js');
const {
  createUserPrompt,
  deleteUserPrompt,
  toUserPromptSelectedId,
} = await import('../src/services/prompts.js');

db.prepare("INSERT INTO users (id, name, language, status) VALUES (71, 'Owner', 'en', 'approved')").run();
const promptRowId = Number(createUserPrompt(71, 'Mira', 'Character', '# DESCRIPTION\nStation mechanic').lastInsertRowid);
const promptId = toUserPromptSelectedId(promptRowId);
const chatId = createUserChat(71, 'Mira chat');

assert.deepEqual(getChatPromptSettings(71, chatId), { prompt_id: null, room_enabled: false });
assert.deepEqual(updateChatPromptSettings(71, chatId, promptId), { prompt_id: promptId, room_enabled: false });
const user = getUserById(71)!;
assert.equal(resolvePromptForChat(user, chatId).name, 'Mira', 'fixed chat prompt overrides global selection');

createChatRoom(71, chatId);
const roomAgent = db.prepare('SELECT source_prompt_id, name, prompt_content FROM chat_agents WHERE chat_id = ?').get(chatId) as {
  source_prompt_id: number; name: string; prompt_content: string;
};
assert.equal(roomAgent.source_prompt_id, promptId, 'room conversion snapshots the fixed chat prompt');
assert.equal(roomAgent.name, 'Mira');
assert.match(roomAgent.prompt_content, /Station mechanic/);
assert.throws(() => updateChatPromptSettings(71, chatId, null), /room_prompt_managed_by_agents/);

deleteUserPrompt(71, promptRowId);
const retainedRoomPrompt = db.prepare('SELECT prompt_content FROM chat_agents WHERE chat_id = ?').get(chatId) as { prompt_content: string };
assert.match(retainedRoomPrompt.prompt_content, /Station mechanic/, 'room snapshot remains valid after source prompt deletion');

db.close();
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(`${dbPath}${suffix}`); } catch { /* already absent */ }
}
console.log('chat prompt binding tests passed');
