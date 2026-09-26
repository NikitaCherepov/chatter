import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `chatter-character-card-${process.pid}-${Date.now()}.sqlite`);
process.env.API_DB_PATH = dbPath;

const { db } = await import('../src/db.js');
const { importCharacterCard, parseCharacterCard } = await import('../src/services/character-card-import.js');

const v2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Card V2',
    description: 'Description',
    personality: 'Calm',
    scenario: 'A tavern',
    mes_example: '<START>\nHello',
    first_mes: 'Welcome',
    alternate_greetings: ['Hi again'],
    system_prompt: 'Stay in character',
    post_history_instructions: 'Be concise',
    character_book: { entries: [] },
  },
};

const parsedJson = parseCharacterCard({ fileName: 'card.json', mimeType: 'application/json', data: Buffer.from(JSON.stringify(v2)) });
assert.equal(parsedJson.spec, 'v2');
assert.equal(parsedJson.name, 'Card V2');
assert.match(parsedJson.content, /# DESCRIPTION\nDescription/);
assert.match(parsedJson.content, /# OTHER\n## SYSTEM PROMPT/);
assert.equal(parsedJson.first_message, 'Welcome');
assert.deepEqual(parsedJson.alternate_greetings, ['Hi again']);
assert.equal(parsedJson.has_character_book, true);

db.prepare("INSERT INTO users (id, name, language) VALUES (77, 'Importer', 'en')").run();
const imported = await importCharacterCard(77, parsedJson);
assert.ok(imported.promptId <= -1000);
const importedPrompt = db.prepare('SELECT name, content FROM user_prompts WHERE user_id = 77').get() as { name: string; content: string };
assert.equal(importedPrompt.name, 'Card V2');
assert.match(importedPrompt.content, /# PERSONALITY\nCalm/);
const storedCard = db.prepare('SELECT first_message, raw_json FROM user_prompt_character_cards').get() as { first_message: string; raw_json: string };
assert.equal(storedCard.first_message, 'Welcome');
assert.equal(JSON.parse(storedCard.raw_json).data.name, 'Card V2');

const chunk = (type: string, data: Buffer) => {
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  output.write(type, 4, 4, 'ascii');
  data.copy(output, 8);
  return output;
};
const textChunk = (keyword: string, value: unknown) => chunk('tEXt', Buffer.from(`${keyword}\0${Buffer.from(JSON.stringify(value)).toString('base64')}`, 'latin1'));
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  textChunk('chara', v2),
  textChunk('ccv3', { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Card V3', description: 'Preferred' } }),
  chunk('IEND', Buffer.alloc(0)),
]);
const parsedPng = parseCharacterCard({ fileName: 'card.png', mimeType: 'image/png', data: png });
assert.equal(parsedPng.spec, 'v3');
assert.equal(parsedPng.name, 'Card V3', 'ccv3 metadata wins over legacy chara metadata');
assert.equal(parsedPng.has_avatar, true);
assert.equal(parsedPng.avatar?.data, png);

assert.throws(() => parseCharacterCard({ fileName: 'bad.json', data: Buffer.from('{}') }), /character_card_name_required/);

db.close();
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(`${dbPath}${suffix}`); } catch { /* already absent */ }
}
console.log('character-card-import tests passed');
