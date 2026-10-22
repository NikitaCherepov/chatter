import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { remarkMessageImages, isMessageImageUrl } = require('../src/renderer/lib/remark-message-images.ts');
const { remarkMessageAccents } = require('../src/renderer/lib/remark-message-accents.ts');
const render = (children: string) => renderToStaticMarkup(React.createElement(ReactMarkdown, {
  remarkPlugins: [remarkGfm, remarkMessageAccents, remarkMessageImages], children,
}));
const side = '![Cat](https://example.com/cat.jpg "layout:side")\n**Piano** — [Look](style:success) at this cat.';
const gallery = '![One](https://example.com/1.jpg "layout:gallery")\n![Two](https://example.com/2.jpg "layout:gallery")';
const html = render(side);
assert.match(html, /data-message-images="side"/);
assert.match(html, /data-message-image-body/);
assert.match(html, /<strong>Piano<\/strong>/);
assert.match(html, /data-message-accent="success"/);
assert.ok(!html.includes('title="layout:'));
assert.ok(!html.includes('<p><div'), 'block wrappers must not be nested in paragraphs');
assert.match(render(side.replace('\n', '\n\n')), /data-message-image-body/);
assert.match(render('![Cat](https://example.com/cat.jpg "layout:side")'), /<figure/);
assert.equal((render(gallery).match(/<figure/g) ?? []).length, 2);
assert.match(render(gallery), /<figcaption>One<\/figcaption>/);
assert.equal((render(gallery.replace('\n', '\n\n')).match(/data-message-images="gallery"/g) ?? []).length, 1);
assert.equal((render(`${gallery}\n\nOther text.\n\n${gallery}`).match(/data-message-images="gallery"/g) ?? []).length, 2);
assert.match(render(`> ${gallery.replaceAll('\n', '\n> ')}`), /<blockquote>\s*<div data-message-images="gallery"/);
assert.ok(!render('Text ![One](https://example.com/1.jpg "layout:gallery")').includes('data-message-images='));
assert.ok(!render('![Plain](https://example.com/a.jpg "An ordinary title")').includes('data-message-images='));
assert.ok(!render('![Unknown](https://example.com/a.jpg "layout:carousel")').includes('data-message-images='));
for (const url of ['javascript:alert(1)', 'data:image/svg+xml,test', 'file:///etc/passwd', '//evil.test/a', '/\\evil.test/a', 'https://good.test/\nbad', 'relative.jpg']) {
  assert.equal(isMessageImageUrl(url), false, url);
  assert.ok(!render(`![Bad](${url} "layout:gallery")`).includes('data-message-images='));
}
for (const url of ['https://example.com/a.png?q=1&b=2', 'http://example.com/a.jpg', '/uploads/a.webp', '/api/v1/media/image/1']) assert.equal(isMessageImageUrl(url), true, url);
const unsafeAlt = render('![<script>alert(1)</script>](https://example.com/a.jpg "layout:gallery")');
assert.ok(!unsafeAlt.includes('<script>'));
assert.match(unsafeAlt, /&lt;script&gt;/);
for (const code of [`\`![Cat](https://example.com/a.jpg "layout:side")\``, `\`\`\`md\n${gallery}\n\`\`\``]) assert.ok(!render(code).includes('data-message-images='));
for (const source of [side, gallery]) for (let length = 0; length <= source.length; length++) assert.doesNotThrow(() => render(source.slice(0, length)));
console.log('message images: side, gallery, captions, Markdown, security and streaming passed');
