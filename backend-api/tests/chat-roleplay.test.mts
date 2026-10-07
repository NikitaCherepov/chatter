import assert from 'node:assert/strict';

const { applyRoleplayRestrictions, isRoleplayToolAllowed } = await import('../src/services/chat-roleplay.js');

const flags = applyRoleplayRestrictions({ disable_personal: true }, true);
assert.equal(flags?.disable_personal, true, 'chat mode never widens global restrictions');
assert.equal(flags?.disable_memory_write, undefined, 'roleplay does not force a memory-write restriction');
assert.equal(applyRoleplayRestrictions({ disable_memory_write: true }, true)?.disable_memory_write, true, 'explicit write prohibition remains authoritative');
assert.equal(applyRoleplayRestrictions({ disable_memory_write: false }, true)?.disable_memory_write, false, 'allowed memory writes stay allowed');
assert.equal(flags?.disable_pc_control_lite, true);
assert.equal(flags?.disable_pc_control_full, true);
assert.equal(flags?.disable_pc_commands, true);
assert.equal(flags?.disable_internet, true);
assert.equal(flags?.disable_specialized_subagents, true);
assert.equal(flags?.disable_adhoc_subagents, true);
assert.equal(flags?.disable_avatar_control, true);

for (const name of ['save_to_cold_memory', 'search_cold_memory', 'read_memory', 'search_chat_history', 'read_chat_context']) {
  assert.equal(isRoleplayToolAllowed(name, true), true, `${name} remains available`);
}
for (const name of ['delete_from_cold_memory', 'save_note', 'delete_note', 'list_my_notes', 'get_user_time', 'random_roll', 'search_web']) {
  assert.equal(isRoleplayToolAllowed(name, true), false, `${name} is blocked`);
}
assert.equal(isRoleplayToolAllowed('search_web', false), true, 'disabled roleplay mode does not restrict tools');

console.log('chat roleplay tests passed');
