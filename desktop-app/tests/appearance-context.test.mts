import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const { appearanceContextSummary } = require('../src/renderer/lib/appearance-context.ts');
const summary = {
  content: 'Earlier facts. Pending work.',
  through_timeline_index: 42,
  source_message_count: 17,
  token_count: 120,
  context_limit: 10000,
  model_name: 'model',
  provider_name: 'provider',
  updated_at: 12,
};
assert.equal(appearanceContextSummary(null, 'Recap'), null);
const projected = appearanceContextSummary(summary, 'Recap');
assert.equal(projected.kind, 'summary');
assert.equal(projected.throughTimelineIndex, 42);
assert.equal(projected.title, 'Recap');
assert.equal(
  projected.actions,
  undefined,
  'recap metadata never acquires message actions or a fake message ID',
);
summary.content = 'Changed';
assert.notEqual(projected.content, summary.content, 'the published snapshot is independent');
const source = fs.readFileSync(
  new URL('../src/renderer/pages/ChatPage.tsx', import.meta.url),
  'utf8',
);
const start = source.indexOf('context: { showTokens, limit: contextLimit');
const expression = source
  .slice(start + 'context: '.length, source.indexOf('      voice:', start))
  .trim()
  .replace(/,$/, '');
const sandbox: any = {
  showTokens: false,
  contextLimit: 10000,
  tokens: {
    context_summary: summary,
    current_context_tokens: 9000,
    context_source: 'provider',
    context_measurement_stale: true,
    latest_prompt_tokens: 9000,
    latest_cache_hit_tokens: 4500,
  },
  appearanceShell: { scope: 'workspace' },
  appearanceContextSummary,
  t: () => 'Summary of earlier conversation',
};
vm.createContext(sandbox);
const run = () =>
  vm.runInContext(
    ts.transpileModule('globalThis.projected=' + expression, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    sandbox,
  );
run();
assert.equal(sandbox.projected.summary.content, 'Changed');
assert.equal(sandbox.projected.summary.kind, 'summary');
assert.equal(sandbox.projected.source, 'provider');
assert.equal(sandbox.projected.measurementStale, true);
assert.equal(
  sandbox.projected.showTokens,
  false,
  'summary remains visible when token statistics are disabled',
);
sandbox.tokens = null;
run();
assert.equal(
  sandbox.projected.summary,
  null,
  'scope-cleared token state cannot expose the previous chat recap',
);
sandbox.tokens = { context_summary: summary };
sandbox.appearanceShell = { scope: 'navigator' };
run();
assert.equal(
  sandbox.projected.summary,
  null,
  'navigator-only themes do not receive conversation summaries',
);
let bridge: any;
const handlers = new Map();
const preload = fs.readFileSync(
  new URL('../src/main/appearance-shell-preload.ts', import.meta.url),
  'utf8',
);
vm.runInNewContext(
  ts.transpileModule(preload, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  {
    exports: {},
    require: () => ({
      contextBridge: { exposeInMainWorld: (_: any, api: any) => (bridge = api) },
      ipcRenderer: { on: (name: string, fn: any) => handlers.set(name, fn), send() {} },
    }),
    navigator: { userActivation: { isActive: false } },
    window: { addEventListener() {} },
    console,
  },
);
let received: any;
bridge.subscribe((state: any) => (received = state));
handlers.get('appearance-shell:state')(
  {},
  { activeChatId: 1, context: { summary: projected }, messages: [], confirmations: [] },
);
assert.equal(
  received.context.summary.content,
  projected.content,
  'actual isolated preload preserves the recap data',
);
console.log(
  'PASS: summary projection, actual shell-state/preload path, hidden token stats, chat-scope isolation',
);
