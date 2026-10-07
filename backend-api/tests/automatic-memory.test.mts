import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-auto-memory-'));
process.env.API_DB_PATH = path.join(directory, 'test.sqlite');
const { db } = await import('../src/db.js');
const { VectorMemoryService, VECTOR_MEMORY_MAX_QUERY } = await import('../src/services/vector-memory.js');
const { retrieveAutomaticMemory, formatAutomaticMemory, extractMemoryQuery } = await import('../src/services/automatic-memory.js');
const { withPromptInjectionProtection } = await import('../src/services/prompt-injection-protection.js');
const { getChatMemorySettings, updateChatMemorySettings } = await import('../src/services/memory-foundation.js');
const originalSearch = VectorMemoryService.search;
const groups = [{ record_id: 'test-memory', score: 0.9, fragments: [{ id: 'fragment', chunk_id: 'test-memory_chunk_0', score: 0.9,
  text: 'Archive fact: the meeting is at the north observatory.', source: 'test', timestamp: 1, chunk_index: 0, total_chunks: 1 }] }];
let calls: any[][] = [];
try {
  assert.equal(extractMemoryQuery('a'.repeat(5000)).length, Math.min(5000, VECTOR_MEMORY_MAX_QUERY));
  assert.equal(extractMemoryQuery([{ type: 'text', text: 'Question' }, { type: 'image_url', image_url: { url: 'secret-image' } }]), 'Question');
  assert.equal(formatAutomaticMemory([]), '');
  const large = groups.map(group => ({ ...group, fragments: group.fragments.map(fragment => ({ ...fragment, text: 'Long archive text '.repeat(2000) })) }));
  const block = formatAutomaticMemory(large);
  const serialized = block.split('<untrusted_web_content>')[1].split('</untrusted_web_content>')[0];
  assert.equal(JSON.parse(serialized)[0].fragments[0].text, large[0].fragments[0].text, 'long fragments are preserved without truncation');
  const multiple = Array.from({ length: 7 }, (_, i) => ({ ...groups[0], record_id: `memory-${i}` }));
  assert.equal(JSON.parse(formatAutomaticMemory(multiple).split('<untrusted_web_content>')[1].split('</untrusted_web_content>')[0]).length, 7, 'all retrieved memories are preserved');
  await withPromptInjectionProtection(false, async () => assert.ok(!formatAutomaticMemory(groups).includes('<untrusted_web_content>')));
  assert.ok(formatAutomaticMemory(groups).includes('<untrusted_web_content>'));

  VectorMemoryService.search = (async (...args: any[]) => { calls.push(args); return { groups }; }) as any;
  const input = { userId: 202, billingUserId: 101, chatId: 9, query: 'Question', resultLimit: 5, signal: new AbortController().signal };
  assert.ok((await retrieveAutomaticMemory(input)).includes('north observatory'));
  assert.deepEqual(calls[0].slice(0, 5), [202, 'Question', undefined, 9, undefined]);
  assert.equal(calls[0][5].resultLimit, 5);
  assert.equal(calls[0][5].billingUserId, 101);
  assert.ok(calls[0][5].signal instanceof AbortSignal);
  const previousCalls = calls.length;
  assert.equal(await retrieveAutomaticMemory({ ...input, query: '' }), '');
  assert.equal(calls.length, previousCalls);
  VectorMemoryService.search = (async () => ({ groups: [] })) as any;
  assert.equal(await retrieveAutomaticMemory(input), '');
  VectorMemoryService.search = (async () => { throw new Error('test failure'); }) as any;
  assert.equal(await retrieveAutomaticMemory(input), '');
  const abort = new AbortController();
  VectorMemoryService.search = (async () => new Promise(() => {})) as any;
  const pending = retrieveAutomaticMemory({ ...input, signal: abort.signal });
  abort.abort();
  assert.equal(await pending, '');

  for (const id of [101, 202]) db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(id, `Test ${id}`);
  const chat = Number(db.prepare("INSERT INTO user_chats (user_id, title, room_enabled) VALUES (101, 'Test', 1)").run().lastInsertRowid);
  db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?, 202)').run(chat);
  assert.equal(getChatMemorySettings(101, chat).automatic_memory, 0);
  updateChatMemorySettings(101, chat, { automatic_memory: 1 });
  assert.equal(getChatMemorySettings(101, chat).automatic_memory, 1);
  assert.equal(getChatMemorySettings(202, chat).automatic_memory, 0);
  updateChatMemorySettings(101, chat, { roleplay_mode: 1 });
  assert.equal(getChatMemorySettings(101, chat).automatic_memory, 1);
  console.log('automatic memory tests passed');
} finally {
  VectorMemoryService.search = originalSearch;
  db.close(); fs.rmSync(directory, { recursive: true, force: true });
}
