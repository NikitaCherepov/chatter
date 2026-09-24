import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.API_DB_PATH = path.join(os.tmpdir(), `chatter-memory-foundation-${process.pid}-${Date.now()}.sqlite`);

const { db } = await import('../src/db.js');
const {
  canAccessChat,
  archiveGeneralMemorySpace,
  createGeneralMemorySpace,
  createMemoryRecord,
  createPersona,
  deletePersona,
  getChatMemorySettings,
  getPrimaryPersona,
  listChatMemorySpacesForDeletion,
  purgeCanonicalChatMemory,
  resolvePersonaForChat,
  resolveReadMemorySpaces,
  renameGeneralMemorySpace,
  setActivePersona,
  setDefaultGeneralMemorySpace,
  syncPrimaryPersonaName,
  updatePersona,
  updateChatMemorySettings,
} = await import('../src/services/memory-foundation.js');

for (const [id, name] of [[101, 'Owner'], [202, 'Member'], [303, 'Outsider']] as const) {
  db.prepare('INSERT INTO users (id, name, language) VALUES (?, ?, ?)').run(id, name, 'en');
}

const roomId = Number(db.prepare(`
  INSERT INTO user_chats (user_id, title, room_enabled) VALUES (?, ?, 1)
`).run(101, 'Shared room').lastInsertRowid);
db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)').run(roomId, 202);

assert.equal(canAccessChat(101, roomId), true, 'owner can access the room');
assert.equal(canAccessChat(202, roomId), true, 'member can access the room');
assert.equal(canAccessChat(303, roomId), false, 'unrelated user cannot access the room');
assert.throws(() => getChatMemorySettings(303, roomId), /chat_not_found/);

const ownerSettings = getChatMemorySettings(101, roomId);
const memberSettings = getChatMemorySettings(202, roomId);
assert.notEqual(ownerSettings.persona_id, memberSettings.persona_id, 'room members keep separate personas');
assert.notEqual(ownerSettings.general_space_id, memberSettings.general_space_id, 'room members keep separate general memory');
assert.equal(resolveReadMemorySpaces(101, roomId)[0]?.namespace_key, '101', 'existing Pinecone namespace remains the default');

const workPersona = createPersona(202, 'Work member', 'Рабочий профиль', 'Пишет TypeScript');
const primaryPersona = getPrimaryPersona(202);
assert.equal(primaryPersona.name, 'Member', 'main persona starts with account name');
assert.throws(() => deletePersona(202, primaryPersona.id), /primary_persona_cannot_be_deleted/);
syncPrimaryPersonaName(202, 'Renamed member');
assert.equal(getPrimaryPersona(202).name, 'Renamed member', 'account rename updates only Main');
assert.equal((db.prepare('SELECT name FROM personas WHERE id = ?').get(workPersona.id) as { name: string }).name, 'Work member', 'custom persona name remains independent');
setActivePersona(202, workPersona.id);
assert.equal(resolvePersonaForChat(202, roomId).persona.id, workPersona.id, 'automatic chat follows global persona');
updatePersona(202, workPersona.id, { allow_core_memory_update: 0 });
assert.equal(resolvePersonaForChat(202, roomId).allowCoreMemoryUpdate, false, 'hot-memory updates are controlled by the selected persona');
updateChatMemorySettings(202, roomId, { persona_override_id: primaryPersona.id });
assert.equal(resolvePersonaForChat(202, roomId).persona.id, primaryPersona.id, 'chat can explicitly select Main');
updateChatMemorySettings(202, roomId, { persona_override_id: null });
assert.equal(resolvePersonaForChat(202, roomId).persona.id, workPersona.id, 'automatic returns to the global selection');

const roleplayPersona = createPersona(202, 'Roleplay member', 'Ролевая персона', 'Живёт в вымышленном городе');
updateChatMemorySettings(202, roomId, { persona_override_id: roleplayPersona.id });
assert.equal(resolvePersonaForChat(202, roomId).persona.id, roleplayPersona.id, 'chat override replaces global persona');
setActivePersona(202, workPersona.id);
assert.equal(resolvePersonaForChat(202, roomId).persona.id, roleplayPersona.id, 'global switch does not replace explicit chat override');
deletePersona(202, roleplayPersona.id);
assert.equal(getChatMemorySettings(202, roomId).persona_override_id, null, 'deleting persona resets override to automatic');
assert.equal(resolvePersonaForChat(202, roomId).persona.id, workPersona.id, 'reset chat follows global persona again');

const alternateGeneral = createGeneralMemorySpace(202, 'Alternate');
assert.equal(alternateGeneral.is_primary, 0, 'custom memory space is not primary');
assert.throws(() => renameGeneralMemorySpace(303, alternateGeneral.id, 'Stolen'), /memory_space_not_found/);
assert.throws(() => archiveGeneralMemorySpace(303, alternateGeneral.id), /memory_space_not_found/);
assert.equal(renameGeneralMemorySpace(202, alternateGeneral.id, 'Renamed alternate').name, 'Renamed alternate');
setDefaultGeneralMemorySpace(202, alternateGeneral.id);
assert.equal(getChatMemorySettings(202, roomId).general_space_id, alternateGeneral.id, 'global memory selection is shared by chats');
const primaryGeneral = db.prepare("SELECT * FROM memory_spaces WHERE user_id = ? AND kind = 'general' AND is_primary = 1")
  .get(202) as { id: number };
assert.throws(() => archiveGeneralMemorySpace(202, primaryGeneral.id), /primary_memory_space_cannot_be_deleted/);
assert.equal(archiveGeneralMemorySpace(202, alternateGeneral.id).id, primaryGeneral.id, 'deleting active custom memory returns to primary');
assert.equal(getChatMemorySettings(202, roomId).general_space_id, primaryGeneral.id, 'chat settings return to primary memory');

const memberChatSettings = updateChatMemorySettings(202, roomId, {
  memory_mode: 'both',
  write_target: 'chat',
});
assert.ok(memberChatSettings.chat_space_id, 'chat space is created lazily when enabled');
assert.equal(getChatMemorySettings(101, roomId).chat_space_id, null, 'member cannot create or select owner chat memory');

const memberSpaces = resolveReadMemorySpaces(202, roomId);
const chatSpace = memberSpaces.find(space => space.kind === 'chat');
assert.equal(chatSpace?.user_id, 202);
assert.equal(chatSpace?.chat_id, roomId);
assert.equal(chatSpace?.namespace_key, `account-202-chat-${roomId}`);
assert.equal(memberSpaces.every(space => space.user_id === 202), true, 'every selected space belongs to user AND chat scope');

const rows = db.prepare(`
  SELECT user_id, chat_id FROM chat_memory_settings WHERE chat_id = ? ORDER BY user_id
`).all(roomId) as Array<{ user_id: number; chat_id: number }>;
assert.deepEqual(rows, [
  { user_id: 101, chat_id: roomId },
  { user_id: 202, chat_id: roomId },
]);

const ownerChatSettings = updateChatMemorySettings(101, roomId, {
  memory_mode: 'chat',
  write_target: 'chat',
});
assert.ok(ownerChatSettings.chat_space_id);
createMemoryRecord({
  id: 'owner-room-memory',
  userId: 101,
  spaceId: ownerChatSettings.chat_space_id!,
  text: 'owner room memory',
  source: 'automatic',
  chunks: [{ id: 'owner-room-memory_chunk_0', text: 'owner room memory', index: 0 }],
});
createMemoryRecord({
  id: 'member-room-memory',
  userId: 202,
  spaceId: memberChatSettings.chat_space_id!,
  text: 'member room memory',
  source: 'automatic',
  chunks: [{ id: 'member-room-memory_chunk_0', text: 'member room memory', index: 0 }],
});
assert.equal(listChatMemorySpacesForDeletion(101, roomId).length, 2, 'owner deletion includes every room member chat space');
assert.throws(() => listChatMemorySpacesForDeletion(303, roomId), /chat_not_found/);
assert.equal(purgeCanonicalChatMemory(101, roomId).spaces_deleted, 2);
assert.equal((db.prepare('SELECT COUNT(*) AS count FROM memory_spaces WHERE chat_id = ?').get(roomId) as { count: number }).count, 0);
assert.equal((db.prepare('SELECT COUNT(*) AS count FROM chat_memory_settings WHERE chat_id = ?').get(roomId) as { count: number }).count, 0);
assert.equal((db.prepare("SELECT COUNT(*) AS count FROM memory_records WHERE id IN ('owner-room-memory', 'member-room-memory')").get() as { count: number }).count, 0);
assert.equal((db.prepare("SELECT COUNT(*) AS count FROM memory_chunks WHERE id IN ('owner-room-memory_chunk_0', 'member-room-memory_chunk_0')").get() as { count: number }).count, 0);

console.log('memory foundation tests passed');
