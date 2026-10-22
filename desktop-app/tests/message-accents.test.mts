import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { remarkMessageAccents } = require('../src/renderer/lib/remark-message-accents.ts');
const { MESSAGE_ACCENT_STYLES, getMessageAccentStyle, stripMessageAccents, prepareMessageAccents } = require('../src/renderer/lib/message-accents.ts');

const render = (content: string) => renderToStaticMarkup(React.createElement(ReactMarkdown, {
  remarkPlugins: [remarkGfm, remarkMessageAccents], children: prepareMessageAccents(content),
}));
for (const style of MESSAGE_ACCENT_STYLES) {
  const source = `[Hello **world**](style:${style})`;
  const html = render(source);
  assert.ok(html.includes(`data-message-accent="${style}"`), style);
  assert.ok(html.includes('<strong>world</strong>'));
  assert.ok(!html.includes('href='), 'formatting must not create a clickable URL');
  assert.equal(stripMessageAccents(source), 'Hello **world**');
}
assert.equal(stripMessageAccents('[A [nested] label](style:info)'), 'A [nested] label');
assert.equal(stripMessageAccents('[a \\] b](style:info)'), 'a \\] b');
assert.equal(stripMessageAccents('[ordinary](https://example.com)'), '[ordinary](https://example.com)');
assert.equal(stripMessageAccents('[unknown](style:unknown)'), '[unknown](style:unknown)');
assert.equal(getMessageAccentStyle('javascript:alert(1)'), null);
assert.equal(getMessageAccentStyle('style:info onclick=alert(1)'), null);
for (const code of [
  '`[text](style:info)`',
  '``[text](style:info) ` test``',
  '```md\n[text](style:info)\n```',
  '~~~~md\n[text](style:info)\n~~~~',
  '```md\n[text](style:info)',
]) {
  assert.equal(stripMessageAccents(code), code, 'code examples must remain literal');
  assert.equal(prepareMessageAccents(code), code);
  assert.ok(!render(code).includes('data-message-accent='));
}
assert.ok(!render('<span style="color:red" onclick="alert(1)">Hi</span>').includes('<span'));
assert.ok(!render('[bad](javascript:alert%281%29)').includes('href="javascript:'));
assert.equal(render('A **bold** word.'), '<p>A <strong>bold</strong> word.</p>');
assert.ok(render('| A | B |\n| - | - |\n| 1 | 2 |').includes('<table>'));
const streaming = 'Answer: [An important **detail**](style:highlight-warning).';
for (let end = 0; end <= streaming.length; end++) assert.doesNotThrow(() => render(streaming.slice(0, end)));
assert.equal(prepareMessageAccents('Answer: [An important **detail**](style:highlight-w'), 'Answer: An important **detail**');
assert.ok(!render('[Hello](style:badge-suc').includes('style:'));
assert.equal(prepareMessageAccents('[Hello](style:info)'), '[Hello](style:info)');
for (const layout of ['side', 'gallery']) {
  for (const title of [`"layout:${layout}"`, `'layout:${layout}'`, `(layout:${layout})`]) {
    const source = `![A cat](https://example.com/cat.jpg ${title})`;
    assert.equal(stripMessageAccents(source), '![A cat](https://example.com/cat.jpg)');
    assert.equal(prepareMessageAccents(source), source);
    assert.equal(stripMessageAccents(`\`${source}\``), `\`${source}\``);
    assert.equal(stripMessageAccents(`\`\`\`md\n${source}\n\`\`\``), `\`\`\`md\n${source}\n\`\`\``);
  }
}
assert.equal(stripMessageAccents('![Cat](https://example.com/a_(1).jpg "layout:side")'), '![Cat](https://example.com/a_(1).jpg)');
assert.equal(stripMessageAccents('![A \\] cat](</uploads/cat.jpg> "layout:gallery")'), '![A \\] cat](</uploads/cat.jpg>)');
assert.equal(stripMessageAccents('![Cat](https://example.com/a.jpg "Ordinary title")'), '![Cat](https://example.com/a.jpg "Ordinary title")');
console.log('message accents: styles, Markdown, fallback, security and stream prefixes passed');
