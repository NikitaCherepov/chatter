import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Load the actual helper without launching the Telegram bot or loading its secrets.
const source = fs.readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
const helper = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'sendTypingAction');
assert.ok(helper);
const warnings: string[] = [];
const context = vm.createContext({
  AbortController, setTimeout, clearTimeout,
  formatSafeError: (error: Error) => error.message,
  console: { warn: (...args: unknown[]) => warnings.push(args.join(' ')) },
});
vm.runInContext(ts.transpileModule(helper.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, context);

let method: string | undefined, payload: any, signal: AbortSignal | undefined;
let finished = false;
const ctx = {
  chat: { id: 42 }, message: { message_thread_id: 7 },
  telegram: { callApi: (name: string, body: unknown, options: { signal: AbortSignal }) => {
    method = name;
    payload = body;
    signal = options.signal;
    return new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => {
        finished = true;
        reject(new Error('request to https://api.telegram.org/bot123:secret/sendChatAction timed out'));
      });
    });
  } },
};
assert.equal(context.sendTypingAction(ctx), undefined);
assert.equal(method, 'sendChatAction');
assert.equal(payload.chat_id, 42);
assert.equal(payload.message_thread_id, 7);
assert.equal(payload.action, 'typing');
assert.equal(finished, false, 'AI work can proceed while Telegram is waiting');
await new Promise(resolve => setTimeout(resolve, 3200));
assert.equal(signal?.aborted, true, 'the actual network request is aborted');
assert.equal(finished, true);
assert.equal(warnings.length, 1);
assert.ok(!warnings[0].includes('secret'));
assert.ok(warnings[0].includes('[REDACTED]'));

ctx.telegram.callApi = () => { throw new Error('synchronous failure'); };
context.sendTypingAction(ctx);
await new Promise(resolve => setImmediate(resolve));
assert.equal(warnings.length, 2, 'even a synchronous API failure stays contained');
context.sendTypingAction({});
console.log('PASS: typing never blocks AI work, network request aborts, failures are contained, and token is redacted');
