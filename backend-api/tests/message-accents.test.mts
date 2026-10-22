import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { MESSAGE_FORMATTING_HINT, buildSystemPrompt } = require('../src/services/system-prompt.ts');
const { markdownToTelegramRichHtml, formatForTelegram } = require('../src/services/telegram-send.ts');
const { MESSAGE_ACCENT_STYLES } = require('../src/services/message-accents.ts');

for (const style of MESSAGE_ACCENT_STYLES) {
  assert.ok(MESSAGE_FORMATTING_HINT.includes(style), `model instruction must document ${style}`);
  const source = `[Hello **world**](style:${style})`;
  assert.equal(formatForTelegram(source), 'Hello *world*');
  const html = markdownToTelegramRichHtml(source);
  assert.ok(html.includes('Hello <b>world</b>'));
  assert.ok(!html.includes('style:'));
  assert.ok(!html.includes('<a '));
}
const code = '`[example](style:info)`';
assert.equal(formatForTelegram('[Incomplete](style:warn'), 'Incomplete');
assert.equal(formatForTelegram(code), code);
assert.ok(markdownToTelegramRichHtml(code).includes('[example](style:info)'));
assert.ok(buildSystemPrompt('Character', 'Persona', '', false, false).endsWith(MESSAGE_FORMATTING_HINT));
assert.match(MESSAGE_FORMATTING_HINT, /sparingly/);
assert.match(MESSAGE_FORMATTING_HINT, /No HTML, CSS, scripts/);
for (const layout of ['side', 'gallery']) {
  assert.ok(MESSAGE_FORMATTING_HINT.includes(`layout:${layout}`));
  const image = `![A cat](https://example.com/cat.jpg "layout:${layout}")`;
  assert.equal(formatForTelegram(image), '![A cat](https://example.com/cat.jpg)');
  const html = markdownToTelegramRichHtml(image);
  assert.ok(html.includes('href="https://example.com/cat.jpg"'));
  assert.ok(html.includes('A cat'));
  assert.ok(!html.includes('layout:'));
}
console.log('message accents: system instruction and Telegram conversions passed');
