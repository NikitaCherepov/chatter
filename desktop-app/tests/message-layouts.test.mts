import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { remarkMessageLayouts } = require('../src/renderer/lib/remark-message-layouts.ts');
const { remarkMessageImages } = require('../src/renderer/lib/remark-message-images.ts');
const { remarkMessageAccents } = require('../src/renderer/lib/remark-message-accents.ts');
const { prepareMessageAccents, stripMessageAccents, parseMessageLayoutTag } = require('../src/renderer/lib/message-accents.ts');
const render = (source: string) => renderToStaticMarkup(React.createElement(ReactMarkdown, {
  remarkPlugins: [remarkGfm, remarkMessageLayouts, remarkMessageAccents, remarkMessageImages],
  children: prepareMessageAccents(source),
}));
const sample = `<grid columns="2" gap="3">
<box border radius="lg" padding="3" background="surface">
**CPU**

34%

[Normal](style:success)
</box>
<box border padding="3">
<flex direction="row" justify="between" align="center" gap="2">
**Latency**

28 ms
</flex>
![Cat](https://example.com/cat.jpg)
</box>
</grid>`;
const html = render(sample);
assert.equal((html.match(/data-message-layout="grid"/g) ?? []).length, 1);
assert.equal((html.match(/data-message-layout="box"/g) ?? []).length, 2);
assert.equal((html.match(/data-message-layout="flex"/g) ?? []).length, 1);
assert.match(html, /<strong>CPU<\/strong>/);
assert.match(html, /<p>34%<\/p>/);
assert.match(html, /data-message-accent="success"/);
assert.match(html, /<a href="https:\/\/example.com\/cat.jpg"><img/);
assert.match(html, /--layout-columns:2/);
assert.match(html, /justify-content:space-between/);
assert.ok(!html.includes('<p><div'));
assert.match(render('<box background="#2563EB" padding="6" radius="xl" />'), /background-color:#2563EB/);
assert.match(render('<grid>\n<box>\nHello\n</box>\n</grid>'), /<p>Hello<\/p>/);
assert.match(render('<box>\nFirst\n\nSecond'), /<p>First<\/p>\s*<p>Second<\/p>/);
assert.ok(!render('> <box>\n> Inside quote\n> </box>').includes('data-message-layout='), 'layout delimiters must be standalone, not quoted');
for (const source of [sample, '<box>\nText\n</box>', '<grid columns="3">\n<box background="#ff0000" />\n</grid>']) {
  for (let end = 0; end <= source.length; end++) assert.doesNotThrow(() => render(source.slice(0, end)));
}
for (const tag of [
  '<grid columns="0">', '<grid columns="99">', '<grid columns={3}>', '<box padding="999">',
  '<box background="url(https://evil.test)">', '<box background="#fff;position:fixed">',
  '<box style="position:fixed">', '<box onclick="alert(1)">', '<box class="evil">',
  '<box padding="2" padding="3">', '<flex direction="evil">', '<box __proto__="bad">',
  '<iframe src="https://evil.test">', '<script>', '<box border="false">',
]) {
  assert.equal(parseMessageLayoutTag(tag), null, tag);
  assert.ok(!render(`${tag}\nSafe text\n</box>`).includes('data-message-layout='), tag);
}
for (const code of [
  '`<box>`', '```md\n<box>\nTest\n</box>\n```', '~~~~\n<grid>\n~~~~',
  '    <box>\n    **Code**\n    </box>', '\\<box>',
]) {
  assert.equal(prepareMessageAccents(code), code);
  assert.equal(stripMessageAccents(code), code);
  assert.ok(!render(code).includes('data-message-layout='));
}
const plain = stripMessageAccents(sample);
assert.ok(!/<\/?(?:box|grid|flex)\b/.test(plain));
assert.ok(plain.includes('**CPU**') && plain.includes('Normal') && plain.includes('28 ms'));
const deep = Array(50).fill('<box>').join('\n') + '\nContent\n' + Array(50).fill('</box>').join('\n');
assert.equal((render(deep).match(/data-message-layout=/g) ?? []).length, 8);
assert.ok(render(deep).includes('Content'));
assert.equal(render('A **normal** paragraph.'), '<p>A <strong>normal</strong> paragraph.</p>');
console.log('message layouts: containers, nested Markdown, streaming, validation, code and Telegram fallback passed');
