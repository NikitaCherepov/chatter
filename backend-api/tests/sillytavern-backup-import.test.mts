import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-st-backup-'));
process.env.API_DB_PATH = path.join(tempDir, 'test.sqlite');
process.env.UPLOADS_DIR = path.join(tempDir, 'uploads');

const { db } = await import('../src/db.js');
const { importSillyTavernBackup, previewSillyTavernBackup } = await import('../src/services/sillytavern-backup-import.js');

db.prepare("INSERT INTO users (id, name, language, status) VALUES (93, 'Backup User', 'ru', 'approved')").run();

const character = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Mira',
    description: 'Station mechanic.',
    personality: 'Calm and observant.',
    first_mes: 'Hello, {{user}}.',
  },
};
const longCoreMemory = 'Подробное описание персоны в полном бэкапе. '.repeat(400);
const settings = {
  power_user: {
    personas: { 'alex.png': 'Alex' },
    persona_descriptions: { 'alex.png': { title: 'Main persona', description: longCoreMemory } },
    default_persona: 'alex.png',
  },
};
const chatRows = [
  { user_name: 'Alex', character_name: 'Mira', chat_metadata: { persona: 'alex.png' } },
  { name: 'Alex', is_user: true, mes: 'Hello?', send_date: '2026-09-20T12:00:01Z' },
  {
    name: 'Mira',
    is_user: false,
    mes: 'I am here.',
    send_date: '2026-09-20T12:00:02Z',
    swipes: ['I am here.', 'Always.'],
    swipe_id: 0,
  },
];
const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nVQAAAAASUVORK5CYII=',
  'base64',
);
const archive = Buffer.from(zipSync({
  'st-data/characters/Mira.json': strToU8(JSON.stringify(character)),
  'st-data/settings.json': strToU8(JSON.stringify(settings)),
  'st-data/User Avatars/alex.png': tinyPng,
  'st-data/chats/Mira/station.jsonl': strToU8(`${chatRows.map(row => JSON.stringify(row)).join('\n')}\n`),
  'st-data/vectors/openai/station/text-embedding-3-small/index.json': strToU8(JSON.stringify({
    version: 1,
    items: [{ id: 'fixture-vector', vector: [0.1, 0.2], metadata: { index: 0, text: 'Hello?' } }],
  })),
  'st-data/worlds/station-lore.json': strToU8('{}'),
  'st-data/secrets.json': strToU8('{"secret":"ignored"}'),
}));

const preview = previewSillyTavernBackup(93, archive);
assert.equal(preview.characters.count, 1);
assert.equal(preview.characters.create_count, 1);
assert.deepEqual(preview.characters.names, ['Mira']);
assert.equal(preview.personas.count, 1);
assert.equal(preview.personas.create_count, 1);
assert.equal(preview.personas.avatar_count, 1);
assert.equal(preview.chats.count, 1);
assert.equal(preview.chats.create_count, 1);
assert.equal(preview.chats.message_count, 2);
assert.deepEqual(preview.chat_memory, { chat_count: 1, message_count: 2 });
assert.equal(preview.ignored.worlds, 1);
assert.ok(preview.warnings.includes('worlds_not_supported'));
assert.ok(preview.warnings.includes('other_data_ignored'));

const memoryImports: Array<{ userId: number; chatId: number; facts: any[] }> = [];
const imported = await importSillyTavernBackup(93, archive, {
  importChatMemory: async (userId, chatId, facts) => {
    memoryImports.push({ userId, chatId, facts });
    return { ok: true, imported: facts.length, skipped: 0, chunks_saved: facts.length };
  },
});
assert.deepEqual(imported.characters, { created: 1, existing: 0 });
assert.equal(imported.personas.created, 1);
assert.equal(imported.personas.updated, 0);
assert.equal(imported.personas.avatars, 1);
assert.equal(imported.personas.avatar_errors, 0);
assert.equal(imported.chats.created, 1);
assert.equal(imported.chats.message_count, 2);
assert.deepEqual(imported.chat_memory, { detected: 1, indexed: 1, messages_indexed: 2, messages_skipped: 0, errors: 0 });
assert.equal(memoryImports.length, 1);
assert.equal(memoryImports[0].userId, 93);
assert.equal(memoryImports[0].facts[0].originMessageCursor, 1);
assert.equal(memoryImports[0].facts[1].source, 'Mira');

const prompt = db.prepare('SELECT id, image_url FROM user_prompts WHERE user_id = ? AND name = ?')
  .get(93, 'Mira') as { id: number; image_url: string | null };
const persona = db.prepare("SELECT id, image_url, core_memory FROM personas WHERE user_id = ? AND import_key = 'alex.png'")
  .get(93) as { id: number; image_url: string | null; core_memory: string };
const chat = db.prepare('SELECT id, default_prompt_id FROM user_chats WHERE user_id = ?')
  .get(93) as { id: number; default_prompt_id: number };
assert.ok(persona.image_url);
assert.equal(persona.core_memory, longCoreMemory, 'full backup preserves long persona descriptions');
assert.equal(chat.default_prompt_id, -(1000 + prompt.id));
const chatSettings = db.prepare('SELECT persona_override_id FROM chat_memory_settings WHERE user_id = ? AND chat_id = ?')
  .get(93, chat.id) as { persona_override_id: number };
assert.equal(chatSettings.persona_override_id, persona.id);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chat_message_variants').get().count, 2);
assert.equal(db.prepare('SELECT selected_prompt_id FROM users WHERE id = ?').get(93).selected_prompt_id, null);

const second = await importSillyTavernBackup(93, archive, {
  importChatMemory: async (_userId, _chatId, facts) => ({
    ok: true,
    imported: 0,
    skipped: facts.length,
    chunks_saved: 0,
  }),
});
assert.deepEqual(second.characters, { created: 0, existing: 1 });
assert.equal(second.personas.created, 0);
assert.equal(second.personas.updated, 1);
assert.equal(second.chats.created, 0);
assert.equal(second.chats.existing, 1);
assert.deepEqual(second.chat_memory, { detected: 1, indexed: 1, messages_indexed: 0, messages_skipped: 2, errors: 0 });
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_prompts WHERE user_id = ?').get(93).count, 1);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_chats WHERE user_id = ?').get(93).count, 1);

assert.throws(() => previewSillyTavernBackup(93, Buffer.from('not a zip')), /sillytavern_backup_invalid_zip/);

// Real current header and a filename that differs from the display name.
const modernRows = [
  { chat_metadata: {}, user_name: 'unused', character_name: 'unused' },
  { name: 'Alex', is_user: true, mes: 'A new history' },
  { name: 'Renamed speaker', is_user: false, mes: 'Filename identifies the card' },
];
const modernArchive = Buffer.from(zipSync({
  'characters/card-file.json': strToU8(JSON.stringify(character)),
  'characters/other-file.json': strToU8(JSON.stringify({ ...character, data: { ...character.data, description: 'A different Mira with the same display name.' } })),
  'chats/card-file/current.jsonl': strToU8(modernRows.map(row => JSON.stringify(row)).join('\n')),
}));
const modern = await importSillyTavernBackup(93, modernArchive);
assert.equal(modern.chats.created, 1);
const modernChatId = modern.chats.chat_ids[0];
assert.equal(db.prepare('SELECT default_prompt_id FROM user_chats WHERE id = ?').get(modernChatId).default_prompt_id, -(1000 + prompt.id));
assert.equal(db.prepare("SELECT prompt_id FROM chat_messages WHERE chat_id = ? AND role = 'assistant'").get(modernChatId).prompt_id, -(1000 + prompt.id));
assert.equal(db.prepare('SELECT persona_override_id FROM chat_memory_settings WHERE chat_id = ?').get(modernChatId).persona_override_id, persona.id);
assert.equal((await importSillyTavernBackup(93, modernArchive)).chats.existing, 1);

db.close();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('SillyTavern backup import tests passed');
