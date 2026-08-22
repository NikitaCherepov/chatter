import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const dbPath = path.join(os.tmpdir(), `chatter-attachment-${crypto.randomUUID()}.db`);
process.env.API_DB_PATH = dbPath;

const { db } = await import('../src/db.js');
const { createUserChat, appendChatMessage } = await import('../src/services/chats.js');
const {
  readChatAttachment,
  searchChatAttachment,
  splitAttachmentText,
  withAttachmentMetadata,
} = await import('../src/services/chat-attachments.js');
type AttachmentReadContext = import('../src/services/chat-attachments.js').AttachmentReadContext;

const makeContext = (chatId: number, budget = 50_000): AttachmentReadContext => ({
  chatId,
  maxContextTokens: 100_000,
  readBudget: { remaining: budget },
  getLatestPromptTokens: () => 1_000,
  getFallbackContextTokens: () => 1_000,
  capacityState: { unreflectedTokens: 0 },
});

try {
  db.prepare('INSERT INTO users (id, name, role, status, plan) VALUES (?, ?, ?, ?, ?)')
    .run(1, 'Owner', 'user', 'approved', 'free');
  db.prepare('INSERT INTO users (id, name, role, status, plan) VALUES (?, ?, ?, ?, ?)')
    .run(2, 'Other', 'user', 'approved', 'free');

  const chatId = createUserChat(1, 'Attachment test');
  const text = `${'第一段中文内容。'.repeat(5_000)}\n\n${'alpha beta gamma\n'.repeat(3_000)}needle here`;
  const chunks = splitAttachmentText(text, 1_200);
  assert.equal(chunks.map(chunk => chunk.text).join(''), text, 'chunks must not overlap or lose text');
  assert.ok(chunks.every(chunk => chunk.estimated_tokens <= 1_200), 'chunks must respect the target');

  const attachment = withAttachmentMetadata({
    name: 'test.txt',
    size_bytes: 123,
    mime_type: 'text/plain',
    extracted_text: text,
    url: '/api/v1/attachments/test.txt',
    filename: 'test.txt',
  });
  await appendChatMessage(1, chatId, 'user', '', null, null, null, null, null, [attachment]);

  const context = makeContext(chatId);
  const search = searchChatAttachment(1, attachment.url, 'needle', 5, context);
  const read = readChatAttachment(1, attachment.url, 'chunk', 1, 0, context);
  const denied = readChatAttachment(2, attachment.url, 'chunk', 1, 0, makeContext(chatId));
  const blocked = readChatAttachment(1, attachment.url, 'full', 1, 0, makeContext(chatId, 1));

  assert.match(search, /"status": "ok"/);
  assert.match(read, /"status": "ok"/);
  assert.match(denied, /not_found_or_forbidden/);
  assert.match(blocked, /attachment_budget_exceeded/);
  assert.ok(context.readBudget.remaining < 50_000, 'search and read must share one budget');

  console.log('chat attachment tests passed');
} finally {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbPath}${suffix}`); } catch { /* already absent */ }
  }
}
