import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `chatter-character-chat-${process.pid}-${Date.now()}.sqlite`);
process.env.API_DB_PATH = dbPath;

const { db } = await import('../src/db.js');
const {
  importCharacterCard,
  listCharacterCardPromptSummaries,
  parseCharacterCard,
  startCharacterCardChat,
} = await import('../src/services/character-card-import.js');

db.prepare("INSERT INTO users (id, name, language, status) VALUES (91, 'Nikita', 'ru', 'approved')").run();

const parsed = parseCharacterCard({
  fileName: 'kamellia.json',
  mimeType: 'application/json',
  data: Buffer.from(JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Камелия',
      description: 'Character description',
      first_mes: 'Привет, {{user}}. Я — {{char}}.',
    },
  })),
});
const imported = await importCharacterCard(91, parsed);

assert.deepEqual(
  listCharacterCardPromptSummaries(91).get(imported.promptId),
  { first_message_present: true },
);

const started = await startCharacterCardChat(91, imported.promptId);
const chat = db.prepare('SELECT title, default_prompt_id FROM user_chats WHERE id = ? AND user_id = ?')
  .get(started.chatId, 91) as { title: string; default_prompt_id: number };
assert.equal(chat.title, 'Камелия');
assert.equal(chat.default_prompt_id, imported.promptId);

const greeting = db.prepare('SELECT role, content, prompt_id, prompt_name FROM chat_messages WHERE id = ? AND chat_id = ?')
  .get(started.messageId, started.chatId) as { role: string; content: string; prompt_id: number; prompt_name: string };
assert.equal(greeting.role, 'assistant');
assert.equal(greeting.content, 'Привет, Nikita. Я — Камелия.');
assert.equal(greeting.prompt_id, imported.promptId);
assert.equal(greeting.prompt_name, 'Камелия');

await assert.rejects(() => startCharacterCardChat(91, -999999), /character_card_not_found/);

db.close();
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(`${dbPath}${suffix}`); } catch { /* already absent */ }
}
console.log('character-card start chat tests passed');
