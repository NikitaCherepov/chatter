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
  updateUserPromptImage,
} = await import('../src/services/prompts.js');

db.prepare("INSERT INTO users (id, name, language, status) VALUES (71, 'Owner', 'en', 'approved')").run();
const promptRowId = Number(createUserPrompt(71, 'Mira', 'Character', '# DESCRIPTION\nStation mechanic').lastInsertRowid);
const promptId = toUserPromptSelectedId(promptRowId);
const chatId = createUserChat(71, 'Mira chat');

const globalPrompt = resolvePromptForChat(getUserById(71)!, chatId);
assert.deepEqual(getChatPromptSettings(71, chatId), {
  prompt_id: null, room_enabled: false,
  effective_prompt: { id: globalPrompt.id, name: globalPrompt.name, image_url: null },
});
updateUserPromptImage(71, promptRowId, '/images/mira.png');
assert.deepEqual(updateChatPromptSettings(71, chatId, promptId), {
  prompt_id: promptId, room_enabled: false,
  effective_prompt: { id: promptId, name: 'Mira', image_url: '/images/mira.png' },
});
assert.equal(getChatPromptSettings(71, chatId).effective_prompt?.image_url, '/images/mira.png');
// Global selection and returning to automatic must refresh the same metadata.
db.prepare('UPDATE users SET selected_prompt_id = ? WHERE id = 71').run(promptId);
assert.equal(updateChatPromptSettings(71, chatId, null).effective_prompt?.id, promptId);
db.prepare('UPDATE users SET selected_prompt_id = NULL WHERE id = 71').run();
assert.equal(getChatPromptSettings(71, chatId).effective_prompt?.id, globalPrompt.id);
updateChatPromptSettings(71, chatId, promptId);
const user = getUserById(71)!;
assert.equal(resolvePromptForChat(user, chatId).name, 'Mira', 'fixed chat prompt overrides global selection');

createChatRoom(71, chatId);
assert.equal(getChatPromptSettings(71, chatId).effective_prompt, null, 'rooms wait for actual responding agent');
const roomAgent = db.prepare('SELECT source_prompt_id, name, prompt_content FROM chat_agents WHERE chat_id = ?').get(chatId) as {
  source_prompt_id: number; name: string; prompt_content: string;
};
assert.equal(roomAgent.source_prompt_id, promptId, 'room conversion snapshots the fixed chat prompt');
assert.equal(roomAgent.name, 'Mira');
assert.match(roomAgent.prompt_content, /Station mechanic/);
assert.throws(() => updateChatPromptSettings(71, chatId, null), /room_prompt_managed_by_agents/);

const fallbackChat = createUserChat(71, 'Deleted character fallback');
updateChatPromptSettings(71, fallbackChat, promptId);
deleteUserPrompt(71, promptRowId);
assert.equal(getChatPromptSettings(71, fallbackChat).effective_prompt?.id, globalPrompt.id,
  'cached identity uses the same fallback as generation after prompt deletion');
const retainedRoomPrompt = db.prepare('SELECT prompt_content FROM chat_agents WHERE chat_id = ?').get(chatId) as { prompt_content: string };
assert.match(retainedRoomPrompt.prompt_content, /Station mechanic/, 'room snapshot remains valid after source prompt deletion');

db.close();
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(`${dbPath}${suffix}`); } catch { /* already absent */ }
}
console.log('chat prompt binding tests passed');
