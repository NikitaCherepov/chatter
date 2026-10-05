import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.API_DB_PATH = path.join(os.tmpdir(), `chatter-persona-import-${process.pid}-${Date.now()}.sqlite`);

const { db } = await import('../src/db.js');
const { importSillyTavernPersonas, previewSillyTavernPersonas } = await import('../src/services/persona-import.js');
const { listPersonas } = await import('../src/services/memory-foundation.js');

db.prepare('INSERT INTO users (id, name, language) VALUES (?, ?, ?)').run(77, 'Tester', 'en');

const longDescription = 'Подробное описание персоны. '.repeat(400);
const backup = {
  personas: {
    'user.png': 'Main ST persona',
    'detective.png': 'Detective',
  },
  persona_descriptions: {
    'user.png': { title: 'Everyday profile', description: 'Likes tea', position: 0, role: 0 },
    'detective.png': { title: 'Investigator', description: longDescription, custom_future_field: true },
  },
  default_persona: 'detective.png',
};
const base64 = Buffer.from(JSON.stringify(backup), 'utf8').toString('base64');

const preview = previewSillyTavernPersonas(77, base64);
assert.equal(preview.count, 2);
assert.equal(preview.create_count, 2);
assert.equal(preview.default_name, 'Detective');
assert.ok(preview.warnings.includes('avatars_not_in_backup'));
assert.ok(!preview.warnings.includes('core_memory_truncated'));
assert.equal(preview.entries.find(entry => entry.key === 'detective.png')?.core_memory, longDescription);

const first = importSillyTavernPersonas(77, base64);
assert.equal(first.created, 2);
assert.equal(first.updated, 0);
const personas = listPersonas(77);
const detective = personas.find(persona => persona.import_key === 'detective.png')!;
assert.equal(detective.is_default, 1);
assert.equal(detective.description, 'Investigator');
assert.equal(detective.core_memory, longDescription, 'full description becomes usable core memory');
assert.equal(JSON.parse(detective.import_raw_json!).descriptor.description, longDescription, 'full source description is preserved');
assert.equal(detective.image_url, null, 'regular SillyTavern persona backups contain no avatar bytes');

backup.personas['detective.png'] = 'Detective updated';
backup.persona_descriptions['detective.png'].description = `${longDescription}\nNew fact`;
const updatedBase64 = Buffer.from(JSON.stringify(backup), 'utf8').toString('base64');
const secondPreview = previewSillyTavernPersonas(77, updatedBase64);
assert.equal(secondPreview.update_count, 2);
const second = importSillyTavernPersonas(77, updatedBase64);
assert.equal(second.created, 0);
assert.equal(second.updated, 2);
assert.equal(listPersonas(77).filter(persona => persona.import_source === 'sillytavern').length, 2, 're-import updates instead of duplicating');
assert.equal(listPersonas(77).find(persona => persona.import_key === 'detective.png')?.name, 'Detective updated');
assert.equal(listPersonas(77).find(persona => persona.import_key === 'detective.png')?.core_memory, backup.persona_descriptions['detective.png'].description);

console.log('persona import tests passed');
