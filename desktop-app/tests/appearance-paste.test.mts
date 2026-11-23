import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const { parseAppearancePaste, parseAppearanceShellAction, canRunAppearanceAction } = require('../src/main/appearance-shell-types.ts');
const ipc = new Map<string, Function>(), dom = new Map<string, Function>(), sent: any[] = [];
let api: any;
let modalOpen = false;
const source = fs.readFileSync(new URL('../src/main/appearance-shell-preload.ts', import.meta.url), 'utf8');
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports: {}, ArrayBuffer, URL, URLSearchParams, setTimeout, clearTimeout, console,
  navigator: { userActivation: { isActive: false } }, location: { href: 'chatter-interactive://paste/index.html' },
  document: { querySelector: (selector: string) => selector === 'dialog:modal' && modalOpen ? {} : null },
  window: { addEventListener: (name: string, handler: Function) => dom.set(name, handler) },
  require: () => ({ contextBridge: { exposeInMainWorld: (_: string, value: any) => { api = value; } },
    ipcRenderer: { on: (name: string, handler: Function) => ipc.set(name, handler), send: (...args: any[]) => sent.push(args) } }),
});
const state = { activeChatId: 1, canSend: true, sending: false, messages: [], composer: { busy: false, items: [] } };
const update = (next: any = state) => ipc.get('appearance-shell:state')!({}, next);
const bytes = new TextEncoder().encode('hello').buffer;
const file = (name = 'note.txt', type = 'text/plain', read = async () => bytes) => ({ name, type, size: bytes.byteLength, arrayBuffer: read });
const paste = (files: any[], trusted = true) => {
  const event = { isTrusted: trusted, eventPhase: 1, clipboardData: { files } };
  dom.get('paste')!(event); event.eventPhase = 3; return event;
};
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const messages = () => sent.filter(([channel]) => channel === 'appearance-shell:paste');
update();
assert.equal(api.attachPastedFiles(), false, 'there is no ambient clipboard-reading API');
paste([]); assert.equal(api.attachPastedFiles(), false, 'text paste remains native');
paste([file()], false); assert.equal(api.attachPastedFiles(), false, 'synthetic paste cannot import files');
const event = paste([file(), file('screenshot.png', 'image/png')]);
await Promise.resolve(); // Capture and bubble listeners may have a microtask checkpoint between them.
assert.equal(api.attachPastedFiles(), true);
assert.equal(api.attachPastedFiles(), false, 'the same paste cannot be claimed twice');
event.eventPhase = 0;
await settle();
assert.equal(messages().length, 1);
const action = parseAppearancePaste(messages()[0][1]);
assert.equal(action.files.length, 2); assert.equal(action.files[0].name, 'note.txt');
assert.deepEqual(new Uint8Array(action.files[0].bytes), new Uint8Array(bytes));
assert.equal(canRunAppearanceAction(state, action), true);
assert.equal(canRunAppearanceAction({ ...state, activeChatId: 2 }, action), false);
assert.equal(canRunAppearanceAction({ ...state, canSend: false }, action), false);
assert.equal(canRunAppearanceAction({ ...state, composer: { busy: true } }, action), false);
assert.equal(parseAppearanceShellAction(action), null, 'ordinary theme action channel cannot submit arbitrary bytes');
assert.equal(parseAppearancePaste({ ...action, files: [{ ...action.files[0], name: 'C:\\private.txt' }] }), null);
assert.equal(parseAppearancePaste({ ...action, files: [{ ...action.files[0], bytes: 'not bytes' }] }), null);
assert.equal(parseAppearancePaste({ ...action, files: [{ ...action.files[0], bytes: new ArrayBuffer(50 * 1024 * 1024 + 1) }] }), null);
assert.equal(parseAppearancePaste({ ...action, files: Array(257).fill(action.files[0]) }), null);

const ended = paste([file()]); ended.eventPhase = 0;
assert.equal(api.attachPastedFiles(), false, 'saved handlers cannot read files after paste dispatch');
update({ ...state, composer: { busy: true } }); paste([file()]); assert.equal(api.attachPastedFiles(), false);
update();
let finish!: (value: ArrayBuffer) => void;
paste([file('slow.txt', 'text/plain', () => new Promise(resolve => { finish = resolve; }))]);
assert.equal(api.attachPastedFiles(), true);
paste([file()]); assert.equal(api.attachPastedFiles(), false, 'another paste cannot race a pending read');
update({ ...state, activeChatId: 2 }); update(); // Away and back is still a different preparation context.
finish(bytes); await settle();
assert.equal(messages().length, 1, 'old pending reads must not reach the new chat context');

paste([file('broken.txt', 'text/plain', async () => { throw new Error('read failed'); })]);
assert.equal(api.attachPastedFiles(), true); await settle();
assert.equal(parseAppearancePaste(messages().at(-1)[1]).files[0].bytes, null, 'read failures reach the normal composer error flow');
let reads = 0;
paste([{ ...file(), size: 51 * 1024 * 1024, arrayBuffer: async () => { reads++; return bytes; } }]);
assert.equal(api.attachPastedFiles(), true); await settle();
assert.equal(reads, 0, 'oversized clipboard files are not read into memory');
assert.equal(parseAppearancePaste(messages().at(-1)[1]).files[0].bytes, null);
const escapes = () => sent.filter(([channel]) => channel === 'appearance-shell:escape').length;
modalOpen = true;
dom.get('keydown')!({ key: 'Escape', defaultPrevented: false });
modalOpen = false; // The dialog's cancel/default action closes it before the delayed navigation check.
await settle(); assert.equal(escapes(), 0, 'dialog Escape must not also navigate the shell home');
dom.get('keydown')!({ key: 'Escape', defaultPrevented: true });
await settle(); assert.equal(escapes(), 0, 'custom overlay keydown handlers may consume Escape');
dom.get('keydown')!({ key: 'Escape', defaultPrevented: false });
await settle(); assert.equal(escapes(), 1, 'Escape without an active modal still navigates normally');
console.log('PASS: genuine paste-only attachment bridge, text/synthetic/late-event guards, images and documents, scoped cancellation, bounded transfer and visible read errors');
console.log('PASS: modal Escape is reserved before dialog cancellation, custom overlays may consume it, and ordinary shell navigation remains available');
