import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';

const require = createRequire(import.meta.url);
const { parseMessageLink, transformMessageLink } = require('../src/renderer/lib/message-links.ts');
const { getMessageFilePath } = require('../src/main/message-file-link.ts');
const { prepareMessageAccents, stripMessageAccents } = require('../src/renderer/lib/message-accents.ts');

const directory = await mkdtemp(join(tmpdir(), 'chatter-message-links-'));
try {
  const filePath = join(directory, 'Отчёт #1 (готово).xlsx');
  await writeFile(filePath, '');
  const url = pathToFileURL(filePath).href.replaceAll('(', '%28').replaceAll(')', '%29');

  assert.deepEqual(parseMessageLink('chat:123'), { kind: 'chat', chatId: 123, messageId: undefined });
  assert.deepEqual(parseMessageLink('chat:123#456'), { kind: 'chat', chatId: 123, messageId: 456 });
  assert.deepEqual(parseMessageLink(url), { kind: 'file', url });
  assert.equal(await getMessageFilePath(url), filePath);

  for (const invalid of [
    'chat:0', 'chat:123#0', 'chat:123#', 'chat://123', 'chat:123#abc', 'chat:9007199254740992',
    'chat:123#9007199254740992', 'file://example.com/share/test.txt', 'file:relative.txt',
    'file:////example.com/share/test.txt', 'javascript:alert%281%29',
  ]) {
    assert.equal(parseMessageLink(invalid), undefined, invalid);
  }
  for (const unavailable of [
    pathToFileURL(directory).href, pathToFileURL(join(directory, 'missing.txt')).href,
    'file://example.com/share/test.txt', 'file:////example.com/share/test.txt',
    url + '?query', url + '#fragment', url + '%00', url + '%2F', url + '%FF', 123,
    ...(process.platform === 'win32' ? [url + ':stream'] : []),
  ]) {
    assert.equal(await getMessageFilePath(unavailable), undefined, String(unavailable));
  }

  const markdown = `[Chat](chat:123) [Message](chat:123#456) [File](${url})`;
  const render = (children: string) => renderToStaticMarkup(React.createElement(ReactMarkdown, {
    urlTransform: transformMessageLink,
    children: prepareMessageAccents(children),
  }));
  assert.match(render(markdown), /href="chat:123"/);
  assert.match(render(markdown), /href="chat:123#456"/);
  assert.ok(render(markdown).includes(`href="${url}"`));
  assert.doesNotMatch(render(`![File](${url}) [Script](javascript:alert%281%29)`), /file:\/\/\/|javascript:/);
  assert.match(render('[Web](https://example.com/path)'), /href="https:\/\/example.com\/path"/);
  assert.equal(stripMessageAccents(markdown), 'Chat Message File');
  assert.equal(stripMessageAccents('`[Message](chat:123#456)`'), '`[Message](chat:123#456)`');
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log('PASS: Markdown links, local-file validation, unsafe URL rejection and plain-text fallback');
