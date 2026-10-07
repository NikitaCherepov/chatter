import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-memory-preferences-'));
process.env.API_DB_PATH = path.join(directory, 'test.sqlite');
process.env.TIMEWEB_EMBED_API_KEY = '';
const { db } = await import('../src/db.js');
const { getMemoryPreferences, updateMemoryPreferences, resolveMemoryPreferences } = await import('../src/services/memory-preferences.js');
const { getChatMemorySettings, updateChatMemorySettings } = await import('../src/services/memory-foundation.js');
const { VectorMemoryService } = await import('../src/services/vector-memory.js');
const { searchColdMemoryTool } = await import('../src/services/tools/memory/search-cold-memory.js');
const originalSearch = VectorMemoryService.search;
try {
  for (const id of [101, 202, 303]) db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(id, 'Test');
  const chat = Number(db.prepare("INSERT INTO user_chats (user_id, title, room_enabled) VALUES (101, 'Room', 1)").run().lastInsertRowid);
  db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?, 202)').run(chat);
  assert.equal(getMemoryPreferences(101).automatic_memory, false);
  assert.equal(getMemoryPreferences(101).result_limit, null);
  assert.equal(getChatMemorySettings(101, chat).automatic_memory_mode, 'automatic');

  const setAdminCount = (count: number) => {
    const row = db.prepare("SELECT value_json FROM system_settings WHERE key = 'vector_memory_settings'").get() as { value_json: string };
    const settings = JSON.parse(row.value_json);
    settings.reranking.resultLimit = count;
    db.prepare("UPDATE system_settings SET value_json = ? WHERE key = 'vector_memory_settings'").run(JSON.stringify(settings));
  };
  setAdminCount(7);
  assert.equal(resolveMemoryPreferences(101, chat).resultLimit, 7);
  assert.equal(resolveMemoryPreferences(202, chat).resultLimit, 7);
  updateMemoryPreferences(101, { automatic_memory: true, result_limit: 9 });
  assert.equal(resolveMemoryPreferences(101, chat).automaticMemory, true);
  assert.equal(resolveMemoryPreferences(101, chat).resultLimit, 9);
  assert.equal(resolveMemoryPreferences(202, chat).automaticMemory, false);
  updateChatMemorySettings(101, chat, { automatic_memory_mode: 'disabled', memory_result_limit: 3 });
  assert.equal(resolveMemoryPreferences(101, chat).automaticMemory, false);
  assert.equal(resolveMemoryPreferences(101, chat).resultLimit, 3);
  updateChatMemorySettings(202, chat, { automatic_memory_mode: 'enabled', memory_result_limit: 11 });
  assert.equal(resolveMemoryPreferences(202, chat).automaticMemory, true);
  assert.equal(getChatMemorySettings(202, chat).automatic_memory, 1, 'legacy field stays consistent with explicit mode');
  assert.equal(resolveMemoryPreferences(202, chat).resultLimit, 11);
  assert.equal(resolveMemoryPreferences(101, chat).resultLimit, 3);
  assert.throws(() => resolveMemoryPreferences(303, chat), /chat_not_found/);
  updateChatMemorySettings(101, chat, { automatic_memory_mode: 'automatic', memory_result_limit: null });
  assert.equal(resolveMemoryPreferences(101, chat).automaticMemory, true);
  assert.equal(resolveMemoryPreferences(101, chat).resultLimit, 9);
  updateMemoryPreferences(101, { result_limit: null });
  setAdminCount(6);
  assert.equal(resolveMemoryPreferences(101, chat).resultLimit, 6, 'inherited settings follow later admin changes');
  updateChatMemorySettings(101, chat, { automatic_memory: 0 });
  assert.equal(resolveMemoryPreferences(101, chat).automaticMemory, false, 'legacy explicit off wins over personal on');
  updateChatMemorySettings(101, chat, { automatic_memory: 1 });
  assert.equal(getChatMemorySettings(101, chat).automatic_memory_mode, 'enabled');
  for (const value of [0, 21, 1.5, '5', NaN]) {
    assert.throws(() => updateMemoryPreferences(101, { result_limit: value as any }), /bad_memory_result_limit/);
    assert.throws(() => updateChatMemorySettings(101, chat, { memory_result_limit: value as any }), /bad_memory_result_limit/);
  }
  assert.throws(() => updateMemoryPreferences(101, { automatic_memory: 1 as any }), /bad_automatic_memory/);
  assert.throws(() => updateChatMemorySettings(101, chat, { automatic_memory_mode: 'bad' as any }), /bad_automatic_memory_mode/);
  let args: any[] = [];
  VectorMemoryService.search = (async (...input: any[]) => { args = input; return { groups: [], matches: [] }; }) as any;
  await searchColdMemoryTool.handler({ query: 'remember' }, { userId: 202, chatId: chat } as any);
  assert.equal(args[2], undefined);
  assert.equal(args[5].resultLimit, 11, 'tool uses same personal chat count as automatic memory');
  await searchColdMemoryTool.handler({ query: 'remember', top_k: 2 }, { userId: 202, chatId: chat } as any);
  assert.equal(args[2], 2);
  assert.equal(args[5].resultLimit, 11);
  console.log('memory preferences tests passed');
} finally {
  VectorMemoryService.search = originalSearch;
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
