import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { RoomStreamBuffer } = require('../src/renderer/lib/room-stream-buffer.ts');
const { appearanceMessageContent } = require('../src/renderer/lib/appearance-message-content.ts');
const { appearanceMessageInfo } = require('../src/renderer/lib/appearance-message-info.ts');
const { appearanceMessageActions, canEditChatMessage } = require('../src/renderer/lib/appearance-message-actions.ts');
const { APPEARANCE_CAPABILITIES } = require('../src/main/appearance-schema.ts');
const { compileAppearanceProject } = require('../src/main/appearance-project.ts');
const ts = require('typescript');
const labels = (name: string) => name === 'read_file' ? 'Read file' : name;
const buffer = new RoomStreamBuffer('appearance-stream');
buffer.restore({ stream_id: 'appearance-stream', sequence: 0, content: '', reasoning_content: '', agent_id: null, created_at: 0 });
let sequence = 0;
const push = (event: any) => buffer.push({ ...event, stream_id: 'appearance-stream', sequence: ++sequence });
const project = (streaming = true) => appearanceMessageContent({ ...buffer.read(), role: 'assistant' }, streaming, labels);
push({ type: 'chat_agent_reasoning', text: 'Need to inspect the file.' });
assert.equal(project().reasoningContent, 'Need to inspect the file.');
push({ type: 'chat_agent_token', text: 'I will check the file.' });
assert.equal(project().content, 'I will check the file.');
const beforeCommit = project();
push({ type: 'chat_intermediate', text: 'I will check the file.', content: 'I will check the file.' });
assert.equal(project().content, '');
assert.deepEqual(project().workLog, [{ type: 'message', text: 'I will check the file.' }], 'the committed preface remains visible outside the answer');
assert.deepEqual(beforeCommit.workLog, [], 'previous shell snapshots stay immutable');
const call = { id: 'read-1', name: 'read_file', arguments: { path: 'C:/demo.txt' }, running: true };
push({ type: 'chat_tool_status', text: 'Reading', call });
const running = project();
assert.equal(running.streaming, true);
assert.equal(running.toolStatus, 'Reading');
assert.equal(running.workLog[1].call.name, 'read_file');
assert.equal(running.workLog[1].call.label, 'Read file');
assert.equal(running.workLog[1].call.kind, 'file');
assert.equal(running.workLog[1].call.target, 'C:/demo.txt');
assert.equal(running.workLog[1].call.status, 'running');
push({ type: 'chat_tool_status', text: '', call: { ...call, running: false, result_preview: '{"ok":false,"error":"Missing"}' } });
assert.equal(project().workLog.length, 2, 'tool completion updates its row, never appends a second call');
assert.equal(project().workLog[1].call.status, 'error');
assert.equal(running.workLog[1].call.status, 'running', 'old projection does not change with later events');
push({ type: 'chat_agent_token', text: '\n\nThe file is missing.' });
const final = project(false);
assert.equal(final.content, 'The file is missing.');
assert.equal(final.streaming, false);
assert.equal(final.toolStatus, null);
assert.equal(final.workLog[0].text, 'I will check the file.');
assert.equal(final.workLog[1].call.status, 'error');
const persisted = appearanceMessageContent({ ...buffer.read(), role: 'assistant' }, false, labels);
assert.deepEqual(persisted, final, 'history/restored messages use the same projection as the completed stream');

// Legacy data uses the exact same fallback as native WorkLog, without duplicating calls.
const legacy = appearanceMessageContent({ role: 'assistant', content: 'Checking\n\nDone', intermediate_messages: ['Checking'],
  tool_calls: [{ name: 'custom_mcp_tool', arguments: 'raw args' }, { ...call, running: false, result_preview: 'data' }] }, false, labels);
assert.deepEqual(legacy.workLog.map((step: any) => step.type), ['message', 'tool', 'tool']);
assert.equal(legacy.workLog[1].call.label, 'custom_mcp_tool', 'unknown/MCP names remain available');
assert.equal(legacy.workLog[1].call.status, 'unknown', 'missing results are not fabricated successes');
assert.equal(legacy.workLog[1].call.arguments, 'raw args');
assert.equal(legacy.workLog[2].call.status, 'returned');
const edited = appearanceMessageContent({ role: 'assistant', content: 'Edited answer', intermediate_messages: ['Checking'] }, false, labels);
assert.equal(edited.content, 'Edited answer'); assert.deepEqual(edited.workLog, []);
const nested = appearanceMessageContent({ role: 'assistant', content: '', work_log: [
  { type: 'activity', text: 'Preparing' },
  { type: 'tool', call: { name: 'spawn_subagent', arguments: {}, agent_tools: [call] } },
  { type: 'tool', call: { name: 'set_display_state', arguments: {}, result_preview: 'OK' } },
] }, true, labels);
assert.equal(nested.workLog[1].call.children[0].status, 'running');
assert.equal(nested.workLog[2].call.internal, true, 'internal calls remain available for theme-specific grouping');
assert.deepEqual(appearanceMessageContent({ role: 'user', content: 'User text', intermediate_messages: ['User text'] }, false, labels).workLog, []);

// Use the actual isolated preload to verify that the full state reaches subscribers unchanged.
let bridge: any;
const listeners = new Map();
const preload = fs.readFileSync(new URL('../src/main/appearance-shell-preload.ts', import.meta.url), 'utf8');
vm.runInNewContext(ts.transpileModule(preload, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports: {}, require: () => ({ contextBridge: { exposeInMainWorld: (_: any, api: any) => { bridge = api; } },
    ipcRenderer: { on: (name: string, fn: any) => listeners.set(name, fn), send() {} } }),
  navigator: { userActivation: { isActive: false } }, window: { addEventListener() {} }, console,
});
let received: any;
bridge.subscribe((state: any) => { received = state; });
const state = { activeChatId: 1, messages: [{ id: -1, role: 'assistant', ...final }], confirmations: [] };
listeners.get('appearance-shell:state')({}, state);
assert.deepEqual(received.messages[0], state.messages[0]);
assert.equal(bridge.executeTool, undefined, 'display data add no tool execution API');

// Exercise ChatPage's real message mapping, not a second implementation of the bridge projection.
const page = fs.readFileSync(new URL('../src/renderer/pages/ChatPage.tsx', import.meta.url), 'utf8');
const mappingStart = page.indexOf('messages.map(message => ({', page.indexOf('  const shellState ='));
const mapping = page.slice(mappingStart, page.indexOf('})) : [],', mappingStart) + 3);
const context: any = { appearanceMessageContent, appearanceMessageActions, appearanceMessageInfo, canEditChatMessage,
  messages: [{ ...buffer.read(), role: 'assistant', id: -1, created_at: 0 }, { role: 'assistant', id: 4, content: 'Earlier answer', created_at: 0 }],
  sending: true, streamingMsgId: -1, user: { id: 1 }, forking: false, switchingVariantId: null, otherRoomHumans: [], canRegenerateMessage: () => true,
  t: (key: string, options: any) => labels(options.defaultValue) };
vm.createContext(context);
vm.runInContext(ts.transpileModule('globalThis.mapped=' + mapping, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
assert.equal(context.mapped[0].streaming, true);
assert.equal(context.mapped[1].streaming, false, 'conversation-wide sending does not mark older messages as streaming');
assert.equal(context.mapped[0].workLog[0].text, 'I will check the file.');
assert.equal(context.mapped[0].workLog[1].call.label, 'Read file');
assert.equal(context.mapped[0].content, 'The file is missing.');
const template = APPEARANCE_CAPABILITIES.shell.project.template;
const compiled = compileAppearanceProject({ entry: template.entry, files: template.files }, ts);
assert.deepEqual(compiled.diagnostics, [], 'the updated multi-file starter compiles');
assert.ok(compiled.compiled);
console.log('PASS: streaming prefaces survive commit, ordered/nested tools reuse native labels and statuses, history/legacy fallback and isolated bridge retain all display data');
