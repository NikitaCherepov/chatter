import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const { parseAppearanceDocumentRequest, canReadAppearanceDocument, parseAppearanceShellAction, canRunAppearanceAction } = require('../src/main/appearance-shell-types.ts');
let api: any, activated = false;
const events = new Map(), sent: any[] = [];
const preload = fs.readFileSync(new URL('../src/main/appearance-shell-preload.ts', import.meta.url), 'utf8');
vm.runInNewContext(ts.transpileModule(preload, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports: {}, URL, URLSearchParams, setTimeout, clearTimeout, location: { href: 'chatter-interactive://test/index.html' },
  require: () => ({ contextBridge: { exposeInMainWorld: (_: any, value: any) => { api = value; } },
    ipcRenderer: { on: (name: string, fn: any) => events.set(name, fn), send: (...args: any[]) => sent.push(args) } }),
  navigator: { userActivation: { get isActive() { return activated; } } }, window: { addEventListener() {} }, console,
});
const state = { activeChatId: 5, canSend: true, sending: false, attachmentCount: 1,
  composer: { busy: false, items: [{ id: 'picked-1', kind: 'image' }] },
  messages: [{ id: 10, variantIndex: 2, attachments: [{ url: '/api/v1/attachments/test.pdf' }] }] };
events.get('appearance-shell:state')({}, state);
const read = api.readAttachment(10, 0), request = parseAppearanceDocumentRequest(sent.at(-1)[1]);
assert.equal(request.method, 'readAttachment'); assert.equal(canReadAppearanceDocument(state, request), true);
events.get('appearance-shell:result')({}, { requestId: request.requestId, result: { kind: 'pdf', pageCount: 2, text: 'Extracted text' } });
assert.equal((await read).pageCount, 2);
const page = api.renderAttachmentPage(10, 0, 2, 9999), pageRequest = parseAppearanceDocumentRequest(sent.at(-1)[1]);
assert.equal(pageRequest.width, 1600); assert.equal(pageRequest.page, 2);
events.get('appearance-shell:result')({}, { requestId: pageRequest.requestId, result: { source: 'data:image/png;base64,AA==', page: 2 } });
assert.equal((await page).page, 2);
const stale = api.readAttachment(10, 0);
const staleCheck = assert.rejects(stale, /attachment_scope_changed/);
events.get('appearance-shell:state')({}, { ...state, messages: [{ ...state.messages[0], variantIndex: 3 }] });
await staleCheck;
assert.equal(canReadAppearanceDocument({ ...state, activeChatId: 6 }, request), false);
assert.equal(canReadAppearanceDocument({ ...state, messages: [{ ...state.messages[0], attachments: [{ url: '/api/v1/attachments/other.pdf' }] }] }, request), false);
assert.equal(parseAppearanceDocumentRequest({ ...request, method: 'execute' }), null);
assert.equal(parseAppearanceDocumentRequest({ ...pageRequest, page: 0 }), null);
events.get('appearance-shell:state')({}, state);
assert.equal(api.chooseAttachments(), false, 'a theme cannot open the OS file chooser without user activation');
activated = true; assert.equal(api.attachFiles(), true);
assert.equal(sent.at(-1)[1].type, 'composerAction');
assert.equal(canRunAppearanceAction(state, parseAppearanceShellAction(sent.at(-1)[1])), true);
assert.equal(api.sendMessage(''), true, 'attachments can be sent without accompanying text');
assert.equal(canRunAppearanceAction(state, parseAppearanceShellAction(sent.at(-1)[1])), true);
assert.equal(canRunAppearanceAction({ ...state, attachmentCount: 0 }, parseAppearanceShellAction(sent.at(-1)[1])), false);
assert.equal(new URL(api.pendingAttachmentSource('picked-1')).searchParams.get('pendingId'), 'picked-1');
assert.equal(api.pendingAttachmentSource('unknown'), '');
assert.equal(api.removePendingAttachment('unknown'), false);
assert.equal(api.removePendingAttachment('picked-1'), true);
events.get('appearance-shell:state')({}, { ...state, composer: { ...state.composer, busy: true } });
assert.equal(api.chooseAttachments(), false); assert.equal(api.clearPendingAttachments(), false);
// Direct bridge consumers and hook consumers share capability ownership.
const flags = { navigation: true, confirmations: true };
const plain = api.subscribe(() => {});
const first = api.subscribe(() => {}, flags);
const second = api.subscribe(() => {}, { navigation: true, confirmations: true });
const capabilities = () => sent.filter(([channel]) => ['appearance-shell:navigation', 'appearance-shell:confirmations'].includes(channel));
assert.deepEqual(capabilities().slice(-2), [['appearance-shell:navigation', true], ['appearance-shell:confirmations', true]]);
const beforeRelease = capabilities().length;
flags.navigation = false; flags.confirmations = false; // Cleanup uses the original subscription flags.
first(); first(); plain();
assert.equal(capabilities().length, beforeRelease, 'one owner leaving must not disable another');
second();
assert.deepEqual(capabilities().slice(-2), [['appearance-shell:navigation', false], ['appearance-shell:confirmations', false]]);
console.log('PASS: asynchronous document/page bridge, exact attachment/variant scope, custom composer gestures, stable pending IDs and media-only send');
