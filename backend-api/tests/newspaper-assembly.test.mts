import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-newspaper-assembly-'));
process.env.API_DB_PATH = path.join(tempDir, 'newspaper-assembly.db');

const { createAssemblyTools } = await import('../src/services/newspaper-assembly.js');

const DATE = '2026-09-17';
const parse = (result: string) => JSON.parse(result);

const article = (id: string) => ({
  id,
  type: 'article',
  role: 'hero',
  title: 'Story',
  text: 'Body text',
  url: 'https://example.com/a',
  sources: [{ title: 'Example', url: 'https://example.com' }],
});
const note = (id: string) => ({ id, type: 'note', title: 'Brief', text: 'Short' });

const setup = () => {
  const drafts: any[] = [];
  const assembly = createAssemblyTools({
    date: DATE,
    onBlocksChanged: (draft) => { drafts.push(draft); },
  });
  const addBlocks = assembly.tools[0];
  const finalizeIssue = assembly.tools[1];
  const ctx = { userId: 1, timezoneOffset: 0 };
  return { assembly, drafts, addBlocks, finalizeIssue, ctx };
};

// 1. Valid blocks are accepted, appended in order, and the draft callback fires.
{
  const { assembly, drafts, addBlocks, finalizeIssue, ctx } = setup();
  assert.deepEqual(parse(await addBlocks.handler({ blocks: [article('a1')] }, ctx as any)), {
    status: 'success', added: 1, total_blocks: 1, block_ids: ['a1'],
  });
  assert.deepEqual(parse(await addBlocks.handler({ blocks: [note('n1'), note('n2')] }, ctx as any)), {
    status: 'success', added: 2, total_blocks: 3, block_ids: ['n1', 'n2'],
  });
  assert.equal(drafts.length, 2);
  assert.equal(drafts[1].blocks.length, 3);
  assert.equal(drafts[1].date, DATE);

  // 2. finalize publishes the document with server-side date.
  assert.deepEqual(parse(await finalizeIssue.handler({ title: '  Chatter Daily  ', subtitle: 'Утро' }, ctx as any)), {
    status: 'success', message: 'issue finalized', title: 'Chatter Daily', blocks: 3,
  });
  const document = assembly.buildDocument();
  assert.equal(document.date, DATE);
  assert.equal(document.title, 'Chatter Daily');
  assert.equal(document.subtitle, 'Утро');
  assert.equal(document.blocks.length, 3);

  // 3. Double finalize is rejected.
  assert.match(parse(await finalizeIssue.handler({ title: 'Again' }, ctx as any)).message, /already finalized/);
}

// 4. Invalid blocks are rejected with actionable feedback and nothing is added.
{
  const { assembly, addBlocks, ctx } = setup();
  const result = parse(await addBlocks.handler({ blocks: [{ id: 'h1', type: 'hero', title: 'X', text: 'Y' }] }, ctx as any));
  assert.equal(result.status, 'error');
  assert.match(result.problems[0], /unknown "type"/);
  assert.equal(assembly.state.blocks.length, 0);
}

// 5. A batch is atomic: one bad block rejects the whole call.
{
  const { assembly, addBlocks, ctx } = setup();
  const result = parse(await addBlocks.handler({ blocks: [note('ok1'), { id: 'bad' }, note('ok2')] }, ctx as any));
  assert.equal(result.status, 'error');
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /unknown "type"/);
  assert.equal(assembly.state.blocks.length, 0, 'valid blocks from a rejected batch must not leak in');
}

// 6. Duplicate ids across calls are rejected.
{
  const { assembly, addBlocks, ctx } = setup();
  await addBlocks.handler({ blocks: [note('dup')] }, ctx as any);
  const result = parse(await addBlocks.handler({ blocks: [note('dup')] }, ctx as any));
  assert.equal(result.status, 'error');
  assert.match(result.problems[0], /already used/);
  assert.equal(assembly.state.blocks.length, 1);
}

// 7. Empty and malformed payloads are rejected.
{
  const { addBlocks, ctx } = setup();
  assert.match(parse(await addBlocks.handler({ blocks: [] }, ctx as any)).message, /non-empty array/);
  assert.match(parse(await addBlocks.handler({}, ctx as any)).message, /non-empty array/);
}

// 8. Finalize guards: empty issue and empty title.
{
  const { assembly, finalizeIssue, ctx } = setup();
  assert.match(parse(await finalizeIssue.handler({ title: 'No blocks yet' }, ctx as any)).message, /empty issue/);
  assert.match(parse(await finalizeIssue.handler({ title: '   ' }, ctx as any)).message, /non-empty string/);
  assert.equal(assembly.state.meta, null);
}

// 9. Auto-finalize path: blocks exist but the model died before finalize_issue.
{
  const { assembly, addBlocks, ctx } = setup();
  await addBlocks.handler({ blocks: [article('a1')] }, ctx as any);
  const document = assembly.buildDocument('Моя газета');
  assert.equal(document.title, 'Моя газета');
  assert.equal(document.blocks.length, 1);
  assert.equal(document.date, DATE);
}

// 10. The 80-block issue cap is enforced.
{
  const { addBlocks, ctx } = setup();
  const batch = Array.from({ length: 80 }, (_, index) => note(`n${index}`));
  assert.equal(parse(await addBlocks.handler({ blocks: batch }, ctx as any)).status, 'success');
  const overflow = parse(await addBlocks.handler({ blocks: [note('one-too-many')] }, ctx as any));
  assert.equal(overflow.status, 'error');
  assert.match(overflow.message, /cannot exceed 80 blocks/);
}

const { db } = await import('../src/db.js');
db.close();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('newspaper assembly tools: ok');
