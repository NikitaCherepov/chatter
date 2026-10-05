import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.API_DB_PATH = path.join(os.tmpdir(), `chatter-core-memory-${process.pid}-${Date.now()}.sqlite`);

const { db } = await import('../src/db.js');
const { createPersona, getPrimaryPersona, setActivePersona, setPersonaCoreMemory, updatePersona } = await import('../src/services/memory-foundation.js');
const { runCoreMemoryMerge } = await import('../src/services/memory.js');

const longMemory = 'Существующий важный факт о персоне.\n'.repeat(400).trim();
db.prepare('INSERT INTO users (id, name, language, core_memory) VALUES (?, ?, ?, ?)')
  .run(77, 'Tester', 'en', longMemory);
const primary = getPrimaryPersona(77);
assert.equal(primary.core_memory, longMemory, 'initial primary persona preserves legacy memory in full');

const persona = createPersona(77, 'Roleplay', 'Profile', longMemory);
assert.equal(persona.core_memory, longMemory, 'creation preserves long memory');
const editedMemory = `${longMemory}\nEdited fact`;
assert.equal(updatePersona(77, persona.id, { core_memory: editedMemory }).core_memory, editedMemory);
setPersonaCoreMemory(77, primary.id, editedMemory);
assert.equal(getPrimaryPersona(77).core_memory, editedMemory);
assert.equal((db.prepare('SELECT core_memory FROM users WHERE id = 77').get() as { core_memory: string }).core_memory, editedMemory);

setActivePersona(77, persona.id);
const mergedMemory = `${editedMemory}\nMerged fact`;
await runCoreMemoryMerge(async payload => {
  const messages = payload.messages as Array<{ content: string }>;
  assert.ok(messages.some(message => message.content.includes(editedMemory)), 'merge receives full existing memory');
  assert.ok(messages.some(message => message.content.includes("User's selected language code: en.")), 'merge defaults to English');
  return { response: { choices: [{ message: { content: mergedMemory } }] }, usedModel: 'test', usedProvider: 'test' };
}, 77, 'Merged fact', true);
assert.equal((db.prepare('SELECT core_memory FROM personas WHERE id = ?').get(persona.id) as { core_memory: string }).core_memory, mergedMemory);
assert.equal(getPrimaryPersona(77).core_memory, editedMemory, 'merge changes only the selected persona');

const unchangedResult = await runCoreMemoryMerge(async payload => {
  const messages = payload.messages as Array<{ content: string }>;
  assert.ok(messages.some(message => message.content.includes("User's selected language code: ru.")), 'merge receives the user language');
  assert.ok(messages.some(message => message.content.includes('If no update is needed, return the existing memory text exactly')), 'unchanged memory is not translated unnecessarily');
  return { response: { choices: [{ message: { content: mergedMemory } }] }, usedModel: 'test', usedProvider: 'test' };
}, 77, 'Merged fact', true, undefined, 'ru');
assert.ok(unchangedResult.startsWith('Memory: unchanged.'), 'tool response is English');

await runCoreMemoryMerge(async () => { throw new Error('test failure'); }, 77, 'Fallback fact', true);
const fallbackMemory = `${mergedMemory}\n- Fallback fact`;
assert.equal((db.prepare('SELECT core_memory FROM personas WHERE id = ?').get(persona.id) as { core_memory: string }).core_memory, fallbackMemory, 'fallback retains every existing fact');
updatePersona(77, persona.id, { allow_core_memory_update: 0 });
await runCoreMemoryMerge(async () => { assert.fail('disabled merge must not call the model'); }, 77, 'Not saved', true);
assert.equal((db.prepare('SELECT core_memory FROM personas WHERE id = ?').get(persona.id) as { core_memory: string }).core_memory, fallbackMemory);

console.log('core memory tests passed');
