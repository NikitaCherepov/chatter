import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { zipSync, strToU8 } from 'fflate';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-group-import-'));
process.env.API_DB_PATH = path.join(directory, 'test.sqlite');
process.env.UPLOADS_DIR = path.join(directory, 'uploads');
const { db } = await import('../src/db.js');
const { previewSillyTavernBackup, importSillyTavernBackup } = await import('../src/services/sillytavern-backup-import.js');
const { uploadBackupSession, cancelBackupSession } = await import('../src/services/sillytavern-backup-session.js');
db.prepare("INSERT INTO users (id, name, language) VALUES (81, 'Group tester', 'en')").run();
const card = (description: string) => ({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Same name', description, first_mes: 'Hello' } });
const rows = [
  { user_name: 'unused', character_name: 'unused', chat_metadata: {} },
  { name: 'Tester', is_user: true, mes: 'Hello', send_date: '2026-10-06T09:00:00Z' },
  { name: 'Same name', original_avatar: 'first.png', is_user: false, mes: 'First', swipes: ['First', 'Alternative'], swipe_id: 0 },
  { name: 'Same name', original_avatar: 'second.png', is_user: false, mes: 'Second' },
  { name: 'Missing character', original_avatar: 'missing.png', is_user: false, mes: 'Keep my history' },
];
const jsonl = strToU8(rows.map(row => JSON.stringify(row)).join('\n'));
const files = {
  'data/default-user/characters/first.json': strToU8(JSON.stringify(card('First character prompt'))),
  'data/default-user/characters/second.json': strToU8(JSON.stringify(card('Second character prompt'))),
  'data/default-user/groups/g1.json': strToU8(JSON.stringify({ id: 'g1', name: 'Test group', members: ['first.png', 'second.png', 'missing.png'], chats: ['history1', 'history2'], chat_id: 'history1', generation_mode: 1 })),
  'data/default-user/group chats/history1.jsonl': jsonl,
  'data/default-user/group chats/history2.jsonl': jsonl,
};
const archive = Buffer.from(zipSync(files));
const preview = previewSillyTavernBackup(81, archive);
assert.equal(preview.groups.count, 1);
assert.equal(preview.groups.history_count, 2);
assert.equal(preview.groups.missing_cards, 2);
assert.ok(preview.warnings.includes('group_character_missing'));
assert.ok(preview.warnings.includes('group_behavior_changed'));
assert.ok(!preview.warnings.includes('group_chats_not_supported'));
const first = await importSillyTavernBackup(81, archive);
assert.equal(first.characters.created, 2);
assert.equal(first.groups.created, 2);
assert.equal(first.chats.chat_ids.length, 2);
for (const chatId of first.chats.chat_ids) {
  assert.equal(db.prepare('SELECT room_enabled FROM user_chats WHERE id = ?').get(chatId).room_enabled, 1);
  const agents = db.prepare('SELECT * FROM chat_agents WHERE chat_id = ? ORDER BY sort_order').all(chatId) as any[];
  assert.equal(agents.length, 2);
  assert.ok(agents.every(agent => agent.owner_user_id === 81 && agent.source_prompt_id !== null));
  assert.notEqual(agents[0].prompt_content, agents[1].prompt_content);
  assert.equal(db.prepare('SELECT auto_respond FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, 81).auto_respond, 0);
  const messages = db.prepare("SELECT * FROM chat_messages WHERE chat_id = ? AND role = 'assistant' ORDER BY timeline_index").all(chatId) as any[];
  assert.equal(messages[0].agent_id, agents[0].id);
  assert.equal(messages[1].agent_id, agents[1].id);
  assert.equal(messages[2].agent_id, null);
  assert.equal(messages[2].prompt_id, null);
  assert.equal(messages[2].prompt_name, 'Missing character');
  assert.equal(db.prepare('SELECT agent_id FROM chat_message_variants WHERE message_id = ? AND variant_index = 1').get(messages[0].id).agent_id, agents[0].id);
}
const second = await importSillyTavernBackup(81, archive);
assert.equal(second.characters.created, 0);
assert.equal(second.groups.existing, 2);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_agents').get().n, 4);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_chats').get().n, 2);
const upload = await uploadBackupSession(81, Readable.from([archive]), archive.length);
assert.equal(upload.preview.groups.existing_count, 2);
assert.ok(upload.preview.storage.sufficient);
cancelBackupSession(81, upload.import_id);
const orphan = Buffer.from(zipSync({ 'data/default-user/group chats/orphan.jsonl': jsonl }));
const orphanResult = await importSillyTavernBackup(81, orphan);
assert.equal(orphanResult.groups.created, 1);
assert.ok(orphanResult.warnings.includes('group_metadata_missing'));
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_agents WHERE chat_id = ?').get(orphanResult.chats.chat_ids[0]).n, 0);
const changedPrefix = Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, data]) => ['backup/' + name, data]))));
assert.equal((await importSillyTavernBackup(81, changedPrefix)).groups.existing, 2, 'archive wrapper directory does not change group identity');
const malformed = Buffer.from(zipSync({ ...files, 'data/default-user/groups/g1.json': strToU8('{"members": null}') }));
assert.throws(() => previewSillyTavernBackup(81, malformed), /invalid_group/);
db.close();
fs.rmSync(directory, { recursive: true, force: true });
console.log('SillyTavern group import tests passed');

