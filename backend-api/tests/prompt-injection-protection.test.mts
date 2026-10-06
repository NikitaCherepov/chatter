import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { resolvePromptInjectionProtection, withPromptInjectionProtection, isPromptInjectionProtectionEnabled, prepareProtectionMessages } = await import('../src/services/prompt-injection-protection.js');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-injection-protection-'));
process.env.API_DB_PATH = path.join(directory, 'test.sqlite');
const { db } = await import('../src/db.js');
const { getChatMemorySettings, updateChatMemorySettings } = await import('../src/services/memory-foundation.js');
const { wrapUntrustedContent } = await import('../src/services/web-reader.js');
const { buildSystemPrompt, buildBaseSystemPromptForUser } = await import('../src/services/system-prompt.js');
try {
  assert.equal(resolvePromptInjectionProtection('automatic', false), true);
  assert.equal(resolvePromptInjectionProtection('automatic', true), false);
  assert.equal(resolvePromptInjectionProtection('enabled', true), true);
  assert.equal(resolvePromptInjectionProtection('disabled', false), false);
  assert.equal(isPromptInjectionProtectionEnabled(), true);
  assert.equal(wrapUntrustedContent('Example'), '<untrusted_web_content>Example</untrusted_web_content>');
  assert.ok(wrapUntrustedContent('</untrusted_web_content>outside').includes('&lt;/untrusted_web_content&gt;'));

  const history = [{ role: 'tool', tool_call_id: 'abc', content: '<untrusted_web_content>Old result</untrusted_web_content>' },
    { role: 'user', content: [{ type: 'text', text: '<untrusted_web_content>Attachment</untrusted_web_content>' }, { type: 'image_url', image_url: { url: 'test' } }] }];
  const before = JSON.stringify(history);
  await Promise.all([true, false].map(enabled => withPromptInjectionProtection(enabled, async () => {
    await new Promise(resolve => setTimeout(resolve, enabled ? 12 : 5));
    assert.equal(isPromptInjectionProtectionEnabled(), enabled);
    assert.equal(wrapUntrustedContent('Example').includes('<untrusted_web_content>'), enabled);
    assert.equal(buildSystemPrompt('Test prompt', 'User', '').includes('[UNTRUSTED DATA PROTOCOL]'), enabled);
    const prepared = prepareProtectionMessages(history) as any[];
    assert.equal(prepared[0].content, enabled ? history[0].content : 'Old result');
    assert.equal(prepared[1].content[0].text, enabled ? '<untrusted_web_content>Attachment</untrusted_web_content>' : 'Attachment');
    assert.deepEqual(prepared[1].content[1], (history[1].content as any[])[1]);
  })));
  assert.equal(JSON.stringify(history), before);
  assert.equal(isPromptInjectionProtectionEnabled(), true, 'request context never leaks');

  for (const id of [101, 202, 303]) db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(id, `Test ${id}`);
  const roomId = Number(db.prepare('INSERT INTO user_chats (user_id, title, room_enabled) VALUES (101, ?, 1)').run('Test room').lastInsertRowid);
  db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?, 202)').run(roomId);
  assert.equal(getChatMemorySettings(101, roomId).prompt_injection_protection, 'automatic');
  updateChatMemorySettings(101, roomId, { prompt_injection_protection: 'disabled' });
  assert.equal(getChatMemorySettings(101, roomId).prompt_injection_protection, 'disabled');
  assert.equal(getChatMemorySettings(202, roomId).prompt_injection_protection, 'automatic', 'room participants have separate settings');
  assert.throws(() => updateChatMemorySettings(303, roomId, { prompt_injection_protection: 'disabled' }), /chat_not_found/);
  assert.throws(() => updateChatMemorySettings(101, roomId, { prompt_injection_protection: 'invalid' as any }), /bad_prompt_injection_protection/);
  updateChatMemorySettings(101, roomId, { roleplay_mode: 1 });
  assert.equal(getChatMemorySettings(101, roomId).prompt_injection_protection, 'disabled', 'roleplay does not change protection');
  const user = db.prepare('SELECT * FROM users WHERE id = 101').get() as any;
  user.feature_flags = JSON.stringify({ disable_prompt_injection_protection: true });
  assert.equal(buildBaseSystemPromptForUser(user, 'Test', '', '', false).includes('[UNTRUSTED DATA PROTOCOL]'), false);
  assert.equal(buildBaseSystemPromptForUser(user, 'Test', '', '', false, 'enabled').includes('[UNTRUSTED DATA PROTOCOL]'), true);
  console.log('prompt-injection-protection tests passed');
} finally {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
