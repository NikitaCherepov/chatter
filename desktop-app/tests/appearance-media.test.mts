import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const { appearanceContentReferences, appearanceImageRequestAllowed, allowedAppearanceImage } = require('../src/renderer/lib/appearance-media.ts');
const { appearanceMessageContent } = require('../src/renderer/lib/appearance-message-content.ts');
const { parseAppearanceShellAction, canRunAppearanceAction } = require('../src/main/appearance-shell-types.ts');
const { appearanceMessageActions, canEditChatMessage } = require('../src/renderer/lib/appearance-message-actions.ts');
const raw = { id: 10, role: 'assistant', variant_index: 2, content: '![Web](https://img.example/web.png)\n\n![Ref][photo]\n\n[photo]: /api/v1/images/ref.png\n\n[Chat](chat:9#12)\n\n[Local](<file:C:/My Files/demo.txt>)\n\n```text\n![Fake](https://evil.example/code.png)\n```\n\n<img src="https://evil.example/html.png">',
  reasoning_content: '![Reasoning](/api/v1/images/reasoning.png)',
  work_log: [{ type: 'message', text: '![Work](/api/v1/images/work.png)' }],
  images: [{ url: '/api/v1/images/attached.png', type: 'generated' }],
  attachments: [{ url: '/api/v1/attachments/report.pdf', name: 'Report', filename: 'report.pdf', mime_type: 'application/pdf', size_bytes: 1024, extracted_text: 'private preview' }] };
const message = { ...appearanceMessageContent(raw, false, (name: string) => name), id: 10, role: 'assistant', variantIndex: 2, variantCount: 3, actions: [] };
const state = { activeChatId: 5, messages: [message], confirmations: [] };
const refs = appearanceContentReferences(message);
assert.deepEqual([...refs.images].sort(), ['/api/v1/images/attached.png','/api/v1/images/reasoning.png','/api/v1/images/ref.png','/api/v1/images/work.png','https://img.example/web.png'].sort());
assert.ok(refs.links.has('chat:9#12'));
assert.ok([...refs.links].some((url: string) => url.startsWith('file:///')));
assert.equal(JSON.stringify(message).includes('private preview'), false, 'extracted document text is retained in the host, not duplicated in the shell');
assert.deepEqual(message.attachments[0], { url: raw.attachments[0].url, name: 'Report', filename: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 1024 });
const request = { chatId: 5, messageId: 10, variantIndex: 2, url: '/api/v1/images/ref.png' };
assert.equal(appearanceImageRequestAllowed(state, request), true);
for (const change of [{ chatId: 6 }, { messageId: 11 }, { variantIndex: 1 }, { url: 'https://evil.example/code.png' },
  { url: 'https://evil.example/html.png' }, { url: '/api/v1/admin' }, { url: 'file:///C:/secret.png' }, { url: 'data:image/png;base64,AAAA' }])
  assert.equal(appearanceImageRequestAllowed(state, { ...request, ...change }), false);
for (const url of ['/api/v1/images/../../admin', '//evil.example/p.png', 'javascript:alert(1)', '/api/v1/attachments/../../../secret'])
  assert.equal(allowedAppearanceImage(url), false);

let api: any, activated = false;
const events = new Map(), windowEvents = new Map(), sent: any[] = [];
const preload = fs.readFileSync(new URL('../src/main/appearance-shell-preload.ts', import.meta.url), 'utf8');
vm.runInNewContext(ts.transpileModule(preload, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports: {}, URL, URLSearchParams, location: { href: 'chatter-interactive://theme-id/index.html' },
  require: () => ({ contextBridge: { exposeInMainWorld: (_: any, value: any) => { api = value; } },
    ipcRenderer: { on: (name: string, fn: any) => events.set(name, fn), send: (...args: any[]) => sent.push(args) } }),
  navigator: { userActivation: { get isActive() { return activated; } } }, window: { addEventListener: (name: string, fn: any) => windowEvents.set(name, fn) }, console, setTimeout,
});
events.get('appearance-shell:state')({}, state);
const source = new URL(api.imageSource(10, request.url, 99999));
assert.equal(source.protocol, 'chatter-interactive:'); assert.equal(source.pathname, '/_image');
assert.equal(source.searchParams.get('width'), '1600'); assert.equal(source.searchParams.get('variantIndex'), '2');
assert.equal(source.searchParams.has('token'), false);
const originalSource = new URL(api.fullImageSource(10, request.url));
assert.equal(originalSource.searchParams.get('width'), '0', 'originals use the same scoped transport without a resize');
assert.equal(originalSource.searchParams.has('token'), false);
assert.equal(api.fullImageSource(99, request.url), '');
assert.equal(api.openImage(10, request.url), false);
activated = true;
assert.equal(api.openImage(10, request.url), true);
assert.equal(canRunAppearanceAction(state, parseAppearanceShellAction(sent.at(-1)[1])), true);
assert.equal(api.openImage(99, request.url), false);
assert.equal(parseAppearanceShellAction({ ...sent.at(-1)[1], action: 'openAttachment', index: -1 }), null);
assert.equal(canRunAppearanceAction(state, { type: 'contentAction', ...request, action: 'openAttachment', index: 8 }), false);

// Exercise the real host resource callback: a full-size request must not add a thumbnail width.
const previewSource = fs.readFileSync(new URL('../src/renderer/components/InteractivePreview.tsx', import.meta.url), 'utf8');
const imageSubscription = previewSource.slice(previewSource.indexOf('    const unsubscribeImages ='), previewSource.indexOf('    void api.interactiveCreate'));
let imageRequestHandler: any;
const resolvedRequests: any[] = [];
vm.runInNewContext(ts.transpileModule(imageSubscription, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
  bridge: true, id: { current: 'preview' }, appearanceRef: { current: { state } }, appearanceImageRequestAllowed,
  resolveImageUrl: (url: string, width?: number) => { resolvedRequests.push({ url, width }); return 'private-source'; },
  api: { onAppearanceImageRequest: (handler: any) => { imageRequestHandler = handler; }, appearanceImageResult: () => Promise.resolve() },
});
imageRequestHandler({ ...request, id: 'preview', requestId: 'original', width: 0 });
assert.deepEqual(resolvedRequests, [{ url: request.url, width: undefined }]);
imageRequestHandler({ ...request, id: 'preview', requestId: 'thumbnail', width: 560 });
assert.equal(resolvedRequests.at(-1).width, 560);
const beforeEscape = sent.length;
windowEvents.get('keydown')({ key: 'Escape', defaultPrevented: true });
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(sent.length, beforeEscape, 'a custom overlay can consume Escape before host navigation');
windowEvents.get('keydown')({ key: 'Escape', defaultPrevented: false });
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(sent.at(-1)[0], 'appearance-shell:escape');

// The actual host dispatch must reuse viewers/download/links without exiting the custom theme.
const page = fs.readFileSync(new URL('../src/renderer/pages/ChatPage.tsx', import.meta.url), 'utf8');
const dispatch = page.slice(page.indexOf('  const handleShellAction ='), page.indexOf('  const shellVisible ='));
const calls: any[] = [];
const context: any = { canRunAppearanceAction, appearanceContentReferences, appearanceMessageContent, allowedAppearanceImage,
  appearanceMessageActions, canEditChatMessage, shellState: state, appearanceShell: { scope: 'workspace' },
  activeChatIdRef: { current: 5 }, messagesChatIdRef: { current: 5 }, messagesRef: { current: [raw] },
  resolveImageUrl: (url: string) => 'authenticated:' + url, parseMessageLink: (url: string) => url.startsWith('chat:') ? { kind: 'chat', chatId: 9, messageId: 12 } : null,
  openMessageImage: (...args: any[]) => calls.push(['image', ...args]), handleDownloadImage: (...args: any[]) => calls.push(['download', ...args]),
  handleOpenEmailAttachment: (...args: any[]) => calls.push(['attachment', ...args]), openMessageLink: (...args: any[]) => calls.push(['link', ...args]),
  window: { electronAPI: { writeClipboardText: (text: string) => calls.push(['clipboard', text]) }, open: (...args: any[]) => calls.push(['external', ...args]) },
  toast: { error: (error: any) => { throw error; } }, setShellOpen: () => { throw new Error('Media must not leave the custom shell'); } };
vm.createContext(context);
vm.runInContext(ts.transpileModule(dispatch + '\nglobalThis.dispatch=handleShellAction;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
const action = { type: 'contentAction', chatId: 5, messageId: 10, variantIndex: 2 };
for (const [extra, expected] of [[{ action: 'openImage', url: request.url }, 'image'], [{ action: 'downloadImage', url: request.url }, 'download'],
  [{ action: 'openAttachment', index: 0 }, 'attachment'], [{ action: 'downloadAttachment', index: 0 }, 'download'],
  [{ action: 'openLink', url: 'chat:9#12' }, 'link'], [{ action: 'copyText', text: '![Fake](https://evil.example/code.png)' }, 'clipboard']] as const) {
  calls.length = 0; context.dispatch({ ...action, ...extra }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0]?.[0], expected);
}
for (const extra of [{ action: 'openImage', url: 'https://evil.example/code.png' }, { action: 'openLink', url: 'https://evil.example/not-in-message' },
  { action: 'copyText', text: 'unrelated text' }, { action: 'openImage', url: request.url, variantIndex: 1 }]) {
  calls.length = 0; context.dispatch({ ...action, ...extra }); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, []);
}
console.log('PASS: actual Markdown media/reference parsing, scoped image authorization, token-free source URLs, gesture/stale checks and native content handlers without shell navigation');
