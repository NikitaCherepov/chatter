import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const { parseAppearanceShellAction, canRunAppearanceAction } = require('../src/main/appearance-shell-types.ts');
const { appearanceMessageActions, canEditChatMessage } = require('../src/renderer/lib/appearance-message-actions.ts');
const React = require('react');
const { projectConfirmation } = require('../src/renderer/lib/confirmation-projection.ts');

const options = { sending: false, forking: false, switchingVariant: false, canEdit: true, canRegenerate: true, canFork: true, canTelegram: true };
const message = { id: 10, role: 'assistant', content: 'Answer', variant_count: 3 };
const actions = appearanceMessageActions(message, options);
assert.equal(canEditChatMessage({ user_id: 2 }, 1), false);
assert.equal(canEditChatMessage({ user_id: 1 }, 1), true);
assert.equal(canEditChatMessage({ user_id: null }, 1), true);
assert.deepEqual(appearanceMessageActions({ ...message, id: -10 }, options), []);
assert.equal(appearanceMessageActions(message, { ...options, canEdit: false }).includes('delete'), false);
assert.equal(appearanceMessageActions({ ...message, questionnaire_response: {} }, options).includes('edit'), false);
for (const busy of [{ sending: true }, { canRegenerate: false }])
  assert.equal(appearanceMessageActions(message, { ...options, ...busy }).includes('regenerate'), false);
assert.equal(appearanceMessageActions(message, { ...options, switchingVariant: true }).includes('activateVariant'), false);
assert.equal(appearanceMessageActions(message, { ...options, canFork: false }).includes('fork'), false);
assert.equal(appearanceMessageActions(message, { ...options, canTelegram: false }).includes('sendTelegram'), false);
const state = { activeChatId: 5, messages: [{ id: 10, role: 'assistant', content: 'Answer', variantIndex: 1, variantCount: 3, actions }],
  speech: { messageId: 10, status: 'playing' }, confirmations: [{ id: 'request-1', title: 'Review', summary: 'Command' }] };
const action = { type: 'messageAction', chatId: 5, messageId: 10, variantIndex: 1, action: 'regenerate', hint: 'More detail' };
assert.deepEqual(parseAppearanceShellAction(action), action);
assert.equal(canRunAppearanceAction(state, action), true);
for (const invalid of [{ ...action, chatId: 6 }, { ...action, messageId: 20 }, { ...action, variantIndex: 2 }])
  assert.equal(canRunAppearanceAction(state, invalid), false);
assert.equal(canRunAppearanceAction(state, { ...action, action: 'activateVariant', index: 3 }), false);
assert.equal(canRunAppearanceAction({ ...state, messages: [{ ...state.messages[0], actions: [] }] }, action), false);
for (const invalid of [{ ...action, hint: ' ' }, { ...action, hint: 'x'.repeat(10001) }, { ...action, messageId: -1 },
  { ...action, action: 'unknown' }, { ...action, action: 'activateVariant', index: -1 }, { type: 'approveConfirmation', id: 'request-1' },
  { type: 'confirmationPresentation', custom: true }]) assert.equal(parseAppearanceShellAction(invalid), null);

const sent: any[] = [], listeners = new Map();
let api: any, activated = false;
const preload = fs.readFileSync(new URL('../src/main/appearance-shell-preload.ts', import.meta.url), 'utf8');
vm.runInNewContext(ts.transpileModule(preload, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
  exports: {}, require: () => ({ contextBridge: { exposeInMainWorld: (_name: string, value: any) => { api = value; } },
    ipcRenderer: { on: (name: string, fn: any) => listeners.set(name, fn), send: (...args: any[]) => sent.push(args) } }),
  navigator: { userActivation: { get isActive() { return activated; } } }, window: { addEventListener() {} }, console,
});
listeners.get('appearance-shell:state')({}, state);
assert.equal(api.copyMessage(10), false, 'mount effects cannot invoke message actions');
assert.equal(api.reviewConfirmation('request-1'), false);
assert.deepEqual(sent, []);
activated = true;
for (const [method, args, name] of [
  ['copyMessage', [10], 'copy'], ['downloadMessageDocx', [10], 'downloadDocx'], ['sendMessageToTelegram', [10], 'sendTelegram'],
  ['forkFromMessage', [10], 'fork'], ['editMessage', [10, 'Edited source', 1], 'edit'], ['deleteMessage', [10], 'delete'],
  ['regenerateMessage', [10, 'Rewrite'], 'regenerate'], ['requestRegenerationHint', [10], 'regenerateHint'],
  ['activateMessageVariant', [10, 2], 'activateVariant'], ['speakMessage', [10], 'speak'],
] as const) {
  assert.equal(api[method](...args), true);
  const parsed = parseAppearanceShellAction(sent.at(-1)[1]);
  assert.equal(parsed.action, name); assert.equal(parsed.chatId, 5); assert.equal(parsed.variantIndex, 1);
  assert.equal(canRunAppearanceAction(state, parsed), true);
}
assert.equal(api.copyMessage(99), false);
assert.equal(api.editMessage(10), false, 'editing without text must not open native UI implicitly');
assert.equal(api.editMessage(10, 'Changed', 2), false, 'the editor cannot save an obsolete variant');
assert.equal(api.reviewConfirmation('request-1'), true);
assert.equal(api.reviewConfirmation('resolved'), false);
assert.equal(api.pauseSpeech(), true);
assert.equal(sent.at(-1)[1].action, 'pause');
const unsubscribe = api.subscribe(() => {}, { navigation: true, confirmations: true });
assert.ok(sent.some(item => item[0] === 'appearance-shell:confirmations' && item[1] === true));
unsubscribe(); unsubscribe();
assert.equal(sent.filter(item => item[0] === 'appearance-shell:confirmations' && item[1] === false).length, 1, 'unsubscribing restores automatic native fallback once');

// Exercise the actual ChatPage dispatch with native callbacks, without a server or React mount.
const page = fs.readFileSync(new URL('../src/renderer/pages/ChatPage.tsx', import.meta.url), 'utf8');
const dispatch = page.slice(page.indexOf('  const handleShellAction ='), page.indexOf('  const shellVisible ='));
const calls: any[] = [], errors: any[] = [];
const context: any = { canRunAppearanceAction, shellState: state, appearanceShell: { scope: 'workspace' },
  activeChatIdRef: { current: 5 }, messagesChatIdRef: { current: 5 }, messagesRef: { current: [{ ...message, variant_index: 1 }] },
  shellMessageActionsPending: { current: new Set() }, ttsPlayback: { messageId: null, status: 'idle' },
  messageSpeechText: (msg: any) => msg.content, messagesScrollRef: { current: { scrollToMessage: (id: number) => calls.push(['scroll', id]) } },
  requestAnimationFrame: (fn: any) => fn(), toast: { error: (error: any) => errors.push(error) },
};
for (const name of ['handleCopyMessage', 'handleDownloadDocx', 'handleSendToTelegram', 'handleForkFromMessage', 'handleDeleteMessage',
  'handleStartEdit', 'handleSaveEdit', 'handleRegenerateWithHint', 'handleRegenerate', 'handleActivateVariant', 'ttsSpeak', 'ttsPause', 'ttsResume', 'ttsStop',
  'setShellOpen', 'setShellHandlesConfirmations', 'setShellConfirmationRequest', 'setRegenHintMsgId', 'setRegenHintText'])
  context[name] = (...args: any[]) => { calls.push([name, ...args]); return Promise.resolve(); };
vm.createContext(context);
vm.runInContext(ts.transpileModule(dispatch + '\nglobalThis.dispatch=handleShellAction;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
for (const [name, handler] of [['copy', 'handleCopyMessage'], ['downloadDocx', 'handleDownloadDocx'], ['sendTelegram', 'handleSendToTelegram'],
  ['fork', 'handleForkFromMessage'], ['delete', 'handleDeleteMessage'], ['edit', 'handleSaveEdit'], ['regenerate', 'handleRegenerateWithHint'],
  ['activateVariant', 'handleActivateVariant'], ['speak', 'ttsSpeak']]) {
  calls.length = 0;
  context.dispatch({ ...action, action: name, index: 2, ...(name === 'edit' ? { text: 'Updated source' } : {}) });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.some(call => call[0] === handler && call[1] === 10), name + ' delegates to the native handler');
  if (name === 'edit') assert.equal(calls.some(call => call[0] === 'setShellOpen'), false, 'saving text keeps the custom shell visible');
}
calls.length = 0;
context.dispatch({ type: 'reviewConfirmation', id: 'request-1' });
assert.equal(calls[0][0], 'setShellConfirmationRequest'); assert.equal(calls[0][1].id, 'request-1');
assert.deepEqual(calls[1], ['setShellOpen', false]);
calls.length = 0;
context.dispatch({ ...action, chatId: 6 });
context.messagesRef.current = [];
context.dispatch(action);
assert.deepEqual(calls, [], 'stale chat and removed-message actions are rejected');
assert.deepEqual(errors, []);
// Clipboard writes use the trusted host IPC even when the isolated theme owns focus.
const nativeMain = fs.readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const clipboardHandler = nativeMain.slice(nativeMain.indexOf("ipcMain.handle('clipboard:write-text'"), nativeMain.indexOf('\n});', nativeMain.indexOf("ipcMain.handle('clipboard:write-text'")) + 4);
let writeClipboard: any;
const clipboardWrites: string[] = [];
vm.runInNewContext(ts.transpileModule(clipboardHandler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
  ipcMain: { handle: (_name: string, handler: any) => { writeClipboard = handler; } },
  assertTrustedIpcSender: (event: any) => { if (!event.trusted) throw new Error('untrusted'); },
  clipboard: { writeText: (text: string) => clipboardWrites.push(text) },
});
assert.throws(() => writeClipboard({ trusted: false }, 'text'), /untrusted/);
assert.throws(() => writeClipboard({ trusted: true }, {}), /clipboard_invalid_text/);
writeClipboard({ trusted: true }, 'Message text');
assert.deepEqual(clipboardWrites, ['Message text']);
const copySource = page.slice(page.indexOf('  const handleCopyMessage ='), page.indexOf('  const handleDownloadDocx ='));
vm.runInNewContext(ts.transpileModule(copySource + '\nglobalThis.copy=handleCopyMessage;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
  useCallback: (fn: any) => fn, messagesRef: { current: [{ id: 10, content: 'Exact message text' }] },
  window: { electronAPI: { writeClipboardText: (text: string) => { clipboardWrites.push(text); return Promise.resolve(); } } },
  navigator: { clipboard: { writeText: () => { throw new Error('unfocused DOM clipboard must not be used'); } } },
  closeMsgMenu() {}, t: (key: string) => key, toast: { success() {}, error() {} },
  set copy(fn: any) { fn(10); },
});
assert.equal(clipboardWrites.at(-1), 'Exact message text');
const projectedCalls: any[] = [];
const Component = () => null;
const projection = projectConfirmation(React.createElement('section', null,
  React.createElement(Component, { content: '**Review**' }), React.createElement(Component, { oldContent: 'before', newContent: 'after' }),
  React.createElement('input', { type: 'checkbox', checked: false, onChange: (event: any) => projectedCalls.push(event.target.checked) })), {
    primary: React.createElement(Component, { onReject: (text: string) => projectedCalls.push(text) }),
    permissions: React.createElement(React.Fragment, null, 'Persistent rule applies to future requests', React.createElement(Component, { label: 'Remember permission', submit: (...args: any[]) => projectedCalls.push(args), remember: true })),
  }, { reject: 'Reject', rejectWithComment: 'Reject with comment' }, false);
assert.equal(projection.customizable, true);
assert.ok(JSON.stringify(projection.content).includes('before'));
assert.ok(JSON.stringify(projection.content).includes('**Review**'));
assert.ok(JSON.stringify(projection.content).includes('Persistent rule applies to future requests'), 'permission explanations must remain visible');
projection.changes.get(projection.fields[0].id)(true);
assert.throws(() => projection.changes.get(projection.fields[0].id)('wrong'), /confirmation_invalid_field/);
await projection.commands.get(projection.actions.find((item: any) => item.comment).id)('  Revise  ');
await projection.commands.get(projection.actions.find((item: any) => item.group === 'permissions').id)();
assert.deepEqual(projectedCalls, [true, 'Revise', [true, true]]);
assert.equal(projectConfirmation(React.createElement(Component, {}), { primary: null }, { reject: '', rejectWithComment: '' }, false).customizable, false);
assert.equal(projectConfirmation(React.createElement('img', { src: 'data:image/png;base64,example' }), { primary: null }, { reject: '', rejectWithComment: '' }, false).customizable, false, 'unprojected evidence must never disappear silently');
const fullCard = { id: 'request-1', ready: true, revision: 8, busy: false, customizable: true,
  actions: [{ id: 'primary-0', disabled: false }], fields: [{ id: 'body-0', disabled: false }] };
const fullState = { ...state, confirmations: [fullCard] };
listeners.get('appearance-shell:state')({}, fullState);
assert.equal(api.runConfirmationAction('request-1', 'primary-0', 7), false);
assert.equal(api.runConfirmationAction('request-1', 'primary-0', 8), true);
assert.equal(canRunAppearanceAction(fullState, parseAppearanceShellAction(sent.at(-1)[1])), true);
assert.equal(api.setConfirmationField('request-1', 'body-0', 'value'), true);
assert.equal(canRunAppearanceAction(fullState, parseAppearanceShellAction(sent.at(-1)[1])), true);
assert.equal(parseAppearanceShellAction({ type: 'confirmationAction', id: 'request-1', actionId: 'missing', revision: -1 }), null);
assert.equal(canRunAppearanceAction({ ...fullState, confirmations: [{ ...fullCard, busy: true }] }, { type: 'confirmationAction', id: 'request-1', actionId: 'primary-0', revision: 8 }), false);
console.log('PASS: theme action permissions, stale variants/chat rejection, user-gesture bridge, native message handlers and confirmation review routing');
