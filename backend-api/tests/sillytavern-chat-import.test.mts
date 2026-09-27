import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `chatter-sillytavern-chat-${process.pid}-${Date.now()}.sqlite`);
process.env.API_DB_PATH = dbPath;

const { db } = await import('../src/db.js');
const { importCharacterCard, parseCharacterCard } = await import('../src/services/character-card-import.js');
const { createPersona, getChatMemorySettings } = await import('../src/services/memory-foundation.js');
const { importSillyTavernChats, previewSillyTavernChats } = await import('../src/services/sillytavern-chat-import.js');

db.prepare("INSERT INTO users (id, name, language, status) VALUES (92, 'Test User', 'ru', 'approved')").run();

const character = parseCharacterCard({
  fileName: 'mira.json',
  mimeType: 'application/json',
  data: Buffer.from(JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: { name: 'Мира', description: 'Механик дальней космической станции.' },
  })),
});
const importedCharacter = await importCharacterCard(92, character);
const persona = createPersona(92, 'Тестовый пользователь', 'Test persona', 'Likes coffee');
db.prepare("UPDATE personas SET import_key = 'test-persona.png', import_source = 'sillytavern' WHERE id = ?")
  .run(persona.id);

const rows = [
  {
    user_name: 'Тестовый пользователь',
    character_name: 'Мира',
    create_date: '2026-09-20@12h00m00s',
    chat_metadata: { persona: 'test-persona.png' },
  },
  { name: 'Тестовый пользователь', is_user: true, mes: 'Здесь всегда так тихо?', send_date: '2026-09-20T12:00:01Z' },
  {
    name: 'Мира',
    is_user: false,
    mes: 'Нет. Иногда искрит проводка.',
    send_date: '2026-09-20T12:00:02Z',
    extra: { reasoning: 'Answer briefly.' },
    swipes: ['Нет. Иногда искрит проводка.', 'Только по утрам.'],
    swipe_id: 0,
  },
];
const raw = `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;
const file = { file_name: 'station-chat.jsonl', base64: Buffer.from(raw, 'utf8').toString('base64') };

const [preview] = previewSillyTavernChats(92, [file]);
assert.equal(preview.title, 'station-chat');
assert.equal(preview.message_count, 2);
assert.equal(preview.user_message_count, 1);
assert.equal(preview.assistant_message_count, 1);
assert.equal(preview.matched_prompt_id, importedCharacter.promptId);
assert.equal(preview.matched_prompt_name, 'Мира');
assert.equal(preview.matched_persona_id, persona.id);
assert.equal(preview.matched_persona_name, 'Тестовый пользователь');
assert.ok(!preview.warnings.includes('alternate_swipes_preserved_only'));
assert.equal(preview.already_imported_chat_id, null);

const [first] = importSillyTavernChats(92, [file]);
assert.equal(first.status, 'created');
const chat = db.prepare('SELECT title, default_prompt_id, created_at, updated_at FROM user_chats WHERE id = ? AND user_id = ?')
  .get(first.chat_id, 92) as { title: string; default_prompt_id: number; created_at: string; updated_at: string };
assert.equal(chat.title, 'station-chat');
assert.equal(chat.default_prompt_id, importedCharacter.promptId);
assert.equal(chat.created_at, '2026-09-20 12:00:01');
assert.equal(chat.updated_at, '2026-09-20 12:00:02');

const messages = db.prepare(`
  SELECT role, content, reasoning_content, prompt_id, prompt_name, timeline_index, created_at
  FROM chat_messages WHERE chat_id = ? ORDER BY timeline_index ASC
`).all(first.chat_id) as Array<Record<string, unknown>>;
assert.equal(messages.length, 2);
assert.deepEqual(messages.map(message => message.role), ['user', 'assistant']);
assert.deepEqual(messages.map(message => message.timeline_index), [1, 2]);
assert.equal(messages[1].reasoning_content, 'Answer briefly.');
assert.equal(messages[1].prompt_id, importedCharacter.promptId);
assert.equal(messages[1].prompt_name, 'Мира');
assert.equal(messages[1].created_at, '2026-09-20 12:00:02');
const importedVariants = db.prepare(`
  SELECT variant_index, content FROM chat_message_variants
  WHERE message_id = (SELECT id FROM chat_messages WHERE chat_id = ? AND role = 'assistant')
  ORDER BY variant_index ASC
`).all(first.chat_id) as Array<{ variant_index: number; content: string }>;
assert.deepEqual(importedVariants, [
  { variant_index: 0, content: 'Нет. Иногда искрит проводка.' },
  { variant_index: 1, content: 'Только по утрам.' },
]);

const memorySettings = getChatMemorySettings(92, first.chat_id);
assert.equal(memorySettings.persona_override_id, persona.id);
const provenance = db.prepare('SELECT source_file_name, raw_jsonl, header_json FROM sillytavern_chat_imports WHERE chat_id = ?')
  .get(first.chat_id) as { source_file_name: string; raw_jsonl: string; header_json: string };
assert.equal(provenance.source_file_name, 'station-chat.jsonl');
assert.equal(provenance.raw_jsonl, raw);
assert.equal(JSON.parse(provenance.header_json).character_name, 'Мира');

const [duplicatePreview] = previewSillyTavernChats(92, [file]);
assert.equal(duplicatePreview.already_imported_chat_id, first.chat_id);
const [second] = importSillyTavernChats(92, [file]);
assert.equal(second.status, 'existing');
assert.equal(second.chat_id, first.chat_id);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_chats WHERE user_id = ?').get(92).count, 1);

const invalid = { file_name: 'broken.jsonl', base64: Buffer.from('{"mes":"ok","is_user":true}\nnot-json').toString('base64') };
assert.throws(() => previewSillyTavernChats(92, [invalid]), /sillytavern_chat_invalid_line:2/);

db.close();
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(`${dbPath}${suffix}`); } catch { /* already absent */ }
}
console.log('SillyTavern chat import tests passed');
