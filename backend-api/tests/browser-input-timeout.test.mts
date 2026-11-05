import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { browserInputTimeout, usesHumanBrowserTyping } = createRequire(import.meta.url)('../src/services/browser-input-timeout.ts');
const text = 'a'.repeat(1000);
assert.equal(browserInputTimeout('browser_control', { action: 'read' }, 30000), 30000);
assert.equal(browserInputTimeout('browser_control', { action: 'screenshot' }, 30000), 30000);
assert.ok(browserInputTimeout('browser_control', { action: 'fill', text }, 30000) > 1000 * 250);
assert.ok(browserInputTimeout('browser_control', { action: 'fill', text }, 60000)
  >= browserInputTimeout('browser_control', { action: 'fill', text }, 30000));
assert.ok(browserInputTimeout('google_ai', { action: 'ask', message: text }, 120000) > 4 * 1000 * 250);
assert.equal(browserInputTimeout('google_ai', { action: 'reload' }, 120000), 120000);
assert.equal(browserInputTimeout('other_tool', { text }, 30000), 30000);
assert.equal(browserInputTimeout('browser_control', { action: 'fill', text: null }, 30000), 30000);
console.log('PASS: typing deadlines cover visible input and retries; passive action deadlines are unchanged');

assert.equal(browserInputTimeout('browser_control', { action: 'fill', text, human_typing: false }, 30000), 30000);
assert.equal(browserInputTimeout('google_ai', { message: text, human_typing: false }, 120000), 120000);
assert.equal(usesHumanBrowserTyping(null), true);
assert.equal(usesHumanBrowserTyping('{broken'), true);
assert.equal(usesHumanBrowserTyping('{"browser_human_typing":false}'), false);
assert.equal(usesHumanBrowserTyping('{"browser_human_typing":true}'), true);
