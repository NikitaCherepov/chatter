import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { QueryClient } from '@tanstack/react-query';
import type { Message } from '../src/renderer/lib/api.ts';
const require = createRequire(import.meta.url);
const { ChatMessageCache } = require('../src/renderer/lib/chat-message-cache.ts');
const ts = require('../node_modules/typescript');
const client = new QueryClient();
const cache = new ChatMessageCache(client, ['server-a', 1]);
const first: Message = { id: 20, role: 'assistant', content: 'First', created_at: 1, variant_index: 0, variant_count: 2 };
const second: Message = { ...first, content: 'Second', reasoning_content: 'Second reasoning', images: [{ url: '/image', type: 'generated' }], variant_index: 1 };
cache.remember(10, [first, { ...first, id: -1, content: 'Live token' }], true);
cache.receiveVariants(10, [first, second]);
assert.equal(cache.read(10)?.messages.length, 1, 'stream projections are not cached as saved history');
assert.equal(cache.read(10)?.hasMore, true);
assert.equal(new ChatMessageCache(client, ['server-a', 2]).read(10), undefined, 'account isolation');
assert.equal(new ChatMessageCache(client, ['server-b', 1]).read(10), undefined, 'server isolation');
const selected = cache.begin(10, first, 1)!;
assert.equal(cache.read(10)?.messages[0].content, 'Second');
assert.equal(cache.project(10, [first])[0].content, 'Second', 'stale history cannot overwrite a pending choice');
assert.equal(cache.begin(10, first, 0), null, 'one pending selection per chat');
assert.equal(cache.finish(selected, false)?.content, 'First');
const stale = cache.begin(10, first, 1)!;
cache.accept(10, { ...second, content: 'Newer server state' });
assert.equal(cache.finish(stale, false), undefined, 'late failure cannot undo a newer server update');
assert.equal(cache.read(10)?.messages[0].content, 'Newer server state');

// Run the actual page handler against a deferred server acknowledgement.
const page = fs.readFileSync(new URL('../src/renderer/pages/ChatPage.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = page.indexOf('  const handleActivateVariant = useCallback(');
const end = page.indexOf('\n  const handleCopyMessage', start);
assert.ok(start > 0 && end > start);
const code = ts.transpileModule(page.slice(start, end).replace('const handleActivateVariant =', 'globalThis.activate ='), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
let state: Message[] = [first], resolve: (value: any) => void, reject: (error: Error) => void;
let calls = 0, historyCalls = 0, errors = 0;
const no = () => {};
cache.remember(10, [first]); cache.receiveVariants(10, [first, second]);
const context: any = {
  ChatMessageCache, messageCache: cache, activeChatId: 10, activeChatIdRef: { current: 10 }, sending: false,
  variantSwitchBusyRef: { current: false }, messagesRef: { current: state }, ttsPlayingId: null,
  setMessages: (update: any) => { state = typeof update === 'function' ? update(state) : update; context.messagesRef.current = state; },
  setSwitchingVariantId: no, setOpenReasoningId: no, setOpenToolCallsId: no, setOpenSubagentsId: no, ttsStop: no,
  refreshContextTokens: no, t: (value: string) => value, useCallback: (fn: any) => fn, loadMessages: no,
  console: { error: no }, toast: { error: () => errors++ },
  api: {
    activateMessageVariant: () => { calls++; return new Promise((res, rej) => { resolve = res; reject = rej; }); },
    getMessages: async () => { historyCalls++; return { messages: [first], variants: [first, second] }; },
  },
};
vm.createContext(context); vm.runInContext(code, context);
let flight = context.activate(20, 1);
assert.equal(state[0].content, 'Second', 'UI changes before the HTTP acknowledgement');
assert.equal(state[0].reasoning_content, 'Second reasoning');
assert.equal(state[0].images?.[0].url, '/image');
assert.equal(historyCalls, 0, 'cached switching never downloads history');
await context.activate(20, 0); assert.equal(calls, 1, 'rapid duplicate clicks are guarded synchronously');
resolve!({ ok: true }); await flight;
assert.equal(state[0].content, 'Second');
flight = context.activate(20, 0); assert.equal(state[0].content, 'First');
reject!(new Error('Save failed')); await flight;
assert.equal(state[0].content, 'Second', 'failure rolls the visible message back');
assert.equal(errors, 1);
flight = context.activate(20, 0);
context.activeChatIdRef.current = 11; state = [{ ...first, id: 99, content: 'Other chat' }];
reject!(new Error('Save failed after navigation')); await flight;
assert.equal(state[0].content, 'Other chat', 'rollback must never change another chat');
assert.equal(cache.read(10)?.messages[0].content, 'Second', 'background rollback restores the original chat cache');

// The actual loader paints cached history before awaiting background refresh.
const loadStart = page.indexOf('  const loadMessages = useCallback(');
const loadEnd = page.indexOf('\n\n  useEffect(() => api.onBackendRestored', loadStart);
assert.ok(loadStart > 0 && loadEnd > loadStart);
const loadCode = ts.transpileModule(page.slice(loadStart, loadEnd).replace('const loadMessages =', 'globalThis.loadMessages ='), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
context.activeChatIdRef.current = 10;
context.messagesChatIdRef = { current: 11 };
context.pendingMessageJumpRef = { current: null };
context.setLoadingMessages = no; context.setContextSummary = no; context.setCharBudget = no; context.setHasMoreMessages = no;
context.getRenderPerfBudget = () => 10000; context.getRenderPerfStep = () => 1000;
context.MESSAGE_PAGE_SIZE = 50; context.MESSAGE_JUMP_PAGE_SIZE = 100;
let finishLoad: (value: any) => void;
context.api.getMessages = () => new Promise(res => { historyCalls++; finishLoad = res; });
vm.runInContext(loadCode, context);
const loadFlight = context.loadMessages(10);
assert.equal(state[0].content, 'Second', 'cached history appears while HTTP is still pending');
cache.accept(10, { ...second, content: 'New completion' });
state = [{ ...second, content: 'New completion' }];
finishLoad!({ messages: [first], variants: [first, second] }); await loadFlight;
assert.equal(state[0].content, 'New completion', 'stale refresh cannot overwrite a newer completed response');
assert.equal(cache.read(10)?.messages[0].content, 'New completion');

// The actual API transport waits for selection persistence before a new prompt.
const apiSource = fs.readFileSync(new URL('../src/renderer/lib/api.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const activationStart = apiSource.indexOf('const pendingVariantActivations =');
const activationEnd = apiSource.indexOf('\nexport async function importSillyTavernChats', activationStart);
const sendStart = apiSource.indexOf('export async function sendChatTrigger(');
const sendEnd = apiSource.indexOf('\n// ', sendStart);
let finishActivation: (value: any) => void;
const sent: string[] = [];
const transport: any = { API_BASE: 'server-a', WebSocket: { OPEN: 1 }, ws: { readyState: 1, send: (text: string) => sent.push(text) },
  apiFetch: () => new Promise(resolve => { finishActivation = resolve; }), console, sendChatTriggerSSE: () => { throw new Error('unexpected fallback'); } };
const transportCode = apiSource.slice(activationStart, activationEnd).replace('export async function activateMessageVariant', 'async function activateMessageVariant')
  + apiSource.slice(sendStart, sendEnd).replace('export async function sendChatTrigger', 'async function sendChatTrigger')
  + '\nglobalThis.activate=activateMessageVariant;globalThis.send=sendChatTrigger;';
vm.createContext(transport); vm.runInContext(ts.transpileModule(transportCode, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, transport);
const activation = transport.activate(10, 20, 1);
const send = transport.send({ chatId: 10, text: 'Next prompt' });
assert.equal(sent.length, 0, 'do not generate using the old active variant');
await transport.send({ chatId: 11, text: 'Independent chat' });
assert.equal(sent.length, 1, 'another chat is not blocked');
finishActivation!({ ok: true }); await activation; await send;
assert.equal(sent.length, 2); assert.equal(JSON.parse(sent[1]).chat_id, 10);
client.clear();
console.log('PASS: actual variant handler, immediate display, no history fetch, rollback, navigation, newer events, RAM cache and account/server isolation');
