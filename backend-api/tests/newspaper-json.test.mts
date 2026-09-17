import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-newspaper-json-'));
process.env.API_DB_PATH = path.join(tempDir, 'newspaper-json.db');

const { parseRepairAndValidateNewspaper, MAX_LLM_REPAIR_ATTEMPTS } = await import('../src/services/newspaper-json.js');
const { db } = await import('../src/db.js');

const DATE = '2026-09-17';

const validDocument = {
  version: 1,
  title: 'Chatter Daily',
  subtitle: 'Утренний выпуск',
  date: '2000-01-01', // must be overridden by the server-side date
  blocks: [
    {
      id: 'a1',
      type: 'article',
      role: 'hero',
      title: 'Story',
      text: 'Body',
      url: 'https://example.com/a',
      image_url: 'https://example.com/i.jpg',
      sources: [{ title: 'Example', url: 'https://example.com' }],
    },
    { id: 'l1', type: 'notes_list', title: 'Коротко', items: [{ id: 'n1', title: 'Note', text: 'Text' }] },
  ],
};

/** A repair fn that must never be called: deterministic stages must be enough. */
const noLlm = async () => {
  throw new Error('llm repair must not be called');
};

const countCalls = (impl: (input: any, call: number) => string | Promise<string>) => {
  const calls: any[] = [];
  const fn = async (input: any) => {
    calls.push(input);
    return impl(input, calls.length);
  };
  return { fn, calls };
};

// 1. Clean JSON parses directly: no jsonrepair stage needed, no LLM, server date wins.
{
  const { document, attempts, llmRepairUsage } = await parseRepairAndValidateNewspaper(
    JSON.stringify(validDocument),
    { date: DATE, llmRepair: noLlm },
  );
  assert.equal(document.date, DATE);
  assert.equal(document.title, 'Chatter Daily');
  assert.equal(document.blocks.length, 2);
  assert.equal(attempts[0].stage, 'direct_parse');
  assert.ok(attempts[0].ok);
  assert.equal(llmRepairUsage, null);
}

// 2. Markdown fences: jsonrepair handles it, no LLM.
{
  const raw = '```json\n' + JSON.stringify(validDocument, null, 2) + '\n```';
  const { document } = await parseRepairAndValidateNewspaper(raw, { date: DATE, llmRepair: noLlm });
  assert.equal(document.blocks.length, 2);
}

// 3. Trailing comma: jsonrepair, no LLM.
{
  const raw = JSON.stringify(validDocument).replace(/}\]$/, '},]');
  const { document } = await parseRepairAndValidateNewspaper(raw, { date: DATE, llmRepair: noLlm });
  assert.equal(document.blocks.length, 2);
}

// 4. Missing comma between properties: jsonrepair, no LLM.
{
  const raw = JSON.stringify(validDocument).replace('"version":1,"title"', '"version":1 "title"');
  const { document } = await parseRepairAndValidateNewspaper(raw, { date: DATE, llmRepair: noLlm });
  assert.equal(document.blocks.length, 2);
}

// 5. Prose around the JSON: brace-sliced candidate, no LLM.
{
  const raw = 'Here is your newspaper issue:\n\n' + JSON.stringify(validDocument) + '\n\nHope you like it!';
  const { document } = await parseRepairAndValidateNewspaper(raw, { date: DATE, llmRepair: noLlm });
  assert.equal(document.blocks.length, 2);
}

// 6. Schema violation (the classic "hero" block type): one LLM repair fixes it.
{
  const broken = {
    ...validDocument,
    blocks: [
      { id: 'a1', type: 'hero', title: 'Story', text: 'Body' },
      ...validDocument.blocks.slice(1),
    ],
  };
  const { fn, calls } = countCalls((input) => {
    const parsed = JSON.parse(input.raw);
    parsed.blocks[0].type = 'article';
    parsed.blocks[0].role = 'hero';
    return JSON.stringify(parsed);
  });
  const progress: any[] = [];
  const { document, attempts } = await parseRepairAndValidateNewspaper(JSON.stringify(broken), {
    date: DATE,
    llmRepair: fn,
    onProgress: (event) => { progress.push(event); },
  });
  assert.equal(document.blocks[0].type, 'article');
  assert.equal(calls.length, 1);
  assert.match(calls[0].problems[0], /unknown "type"/);
  assert.equal(progress.length, 1);
  assert.equal(progress[0].kind, 'schema');
  assert.equal(progress[0].attempt, 1);
  assert.equal(attempts.at(-1)?.stage, 'llm_repair');
  assert.ok(attempts.at(-1)?.ok);
}

// 7. Broken JSON that the model fixes on the second attempt only.
{
  const { fn, calls } = countCalls((_input, call) => (call === 1 ? 'not json at all' : JSON.stringify(validDocument)));
  const progress: any[] = [];
  const raw = '{"version": 1, "title": "Chatter Daily", "blocks": [broken'; // unrepairable truncation
  const { document } = await parseRepairAndValidateNewspaper(raw, {
    date: DATE,
    llmRepair: fn,
    onProgress: (event) => { progress.push(event); },
  });
  assert.equal(document.blocks.length, 2);
  assert.equal(calls.length, 2);
  // jsonrepair closes truncated JSON into a schema-invalid document, and even wraps
  // bare prose ("not json at all") into a JSON string — both surface as schema problems.
  assert.equal(progress[0].kind, 'schema');
  assert.equal(progress[1].kind, 'schema');
}

// 8. Everything fails: descriptive aggregate error, exactly MAX_LLM_REPAIR_ATTEMPTS calls.
{
  const { fn, calls } = countCalls(() => 'still not json');
  await assert.rejects(
    parseRepairAndValidateNewspaper('{"version":1 "title": nope', { date: DATE, llmRepair: fn }),
    /newspaper_editor_json_invalid_after_repairs:/,
  );
  assert.equal(calls.length, MAX_LLM_REPAIR_ATTEMPTS);
}

// 9. maxLlmAttempts: 0 disables the model entirely.
{
  const { fn, calls } = countCalls(() => JSON.stringify(validDocument));
  await assert.rejects(
    parseRepairAndValidateNewspaper('{"version":1 "title": nope', { date: DATE, llmRepair: fn, maxLlmAttempts: 0 }),
    /newspaper_editor_json_invalid_after_repairs:/,
  );
  assert.equal(calls.length, 0);
}

// 10. Empty editor output fails fast.
{
  await assert.rejects(
    parseRepairAndValidateNewspaper('   \n ', { date: DATE, llmRepair: noLlm }),
    /empty output/,
  );
}

// 11. Top-level array is not a newspaper: schema problem, repaired by the model.
{
  const { fn, calls } = countCalls(() => JSON.stringify(validDocument));
  const { document } = await parseRepairAndValidateNewspaper(JSON.stringify([validDocument]), {
    date: DATE,
    llmRepair: fn,
  });
  assert.equal(document.version, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].problems[0], /root object/);
}

db.close();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('newspaper JSON parse/repair/validate pipeline: ok');
// The transitive ai.ts import chain keeps timers alive; same as openrouter-monitor.test.mts.
process.exit(0);
