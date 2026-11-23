import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const { appearanceMessageInfo } = require('../src/renderer/lib/appearance-message-info.ts');
const { parseAppearanceShellAction: parse, canRunAppearanceAction: allowed } = require('../src/main/appearance-shell-types.ts');
const compile = (text: string) => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
let api: any, activated = false;
const events = new Map(), sent: any[] = [];
vm.runInNewContext(compile(fs.readFileSync(new URL('../src/main/appearance-shell-preload.ts', import.meta.url), 'utf8')), {
  exports: {}, URL, URLSearchParams, setTimeout, clearTimeout,
  require: () => ({ contextBridge: { exposeInMainWorld: (_: string, value: any) => { api = value; } },
    ipcRenderer: { on: (name: string, handler: any) => events.set(name, handler), send: (...args: any[]) => sent.push(args) } }),
  navigator: { userActivation: { get isActive() { return activated; } } }, window: { addEventListener() {} }, console,
});
const state = { activeChatId: 2, messages: [], canSend: true,
  models: { items: [{ id: 'model-a' }], loading: false, busy: false },
  voice: { status: 'idle', canStart: true } };
const update = (next = state) => events.get('appearance-shell:state')({}, next);
update(); assert.equal(api.selectModel('model-a'), false); assert.equal(api.startVoiceRecording(), false);
activated = true;
assert.equal(api.selectModel('unknown'), false); assert.equal(api.selectModel('model-a'), true);
assert.equal(allowed(state, parse(sent.at(-1)[1])), true);
assert.equal(api.selectModel(null), true); assert.equal(parse(sent.at(-1)[1]).id, null);
assert.equal(parse({ type: 'selectModel', id: 123 }), null);
assert.equal(parse({ type: 'voiceAction', chatId: 2, action: 'execute' }), null);
assert.equal(api.startVoiceRecording(), true); assert.equal(allowed(state, parse(sent.at(-1)[1])), true);
assert.equal(allowed({ ...state, activeChatId: 3 }, parse(sent.at(-1)[1])), false);
assert.equal(api.stopVoiceRecording(), false); assert.equal(api.cancelVoiceRecording(), false);
update({ ...state, voice: { status: 'requesting', canStart: false } });
assert.equal(api.cancelVoiceRecording(), true); assert.equal(api.startVoiceRecording(), false);
update({ ...state, voice: { status: 'recording', canStart: false } });
assert.equal(api.stopVoiceRecording(), true); assert.equal(allowed({ ...state, voice: { status: 'recording' } }, parse(sent.at(-1)[1])), true);
update({ ...state, voice: { status: 'transcribing', canStart: false }, models: { ...state.models, busy: true } });
assert.equal(api.cancelVoiceRecording(), true); assert.equal(api.stopVoiceRecording(), false); assert.equal(api.selectModel(null), false);
assert.equal(allowed({ ...state, models: { ...state.models, busy: true } }, { type: 'selectModel', id: 'model-a' }), false);
assert.equal(allowed({ ...state, models: undefined }, { type: 'selectModel', id: null }), false);

const message: any = { role: 'assistant', token_count: 71, model_name: 'Model A', provider_name: 'Provider A',
  usage: { aggregate: { prompt_tokens: 100, completion_tokens: 35, total_tokens: 135, cache_hit_tokens: 90, cache_miss_tokens: 10, reasoning_tokens: 4 },
    perf: { first_token_latency_ms: 180, generation_ms: 700, total_ms: 1700, tokens_per_second: 50 } }, secret: 'do not expose' };
const info = appearanceMessageInfo(message);
assert.equal(info.tokenCount, 35); assert.equal(info.tokenCountSource, 'provider'); assert.equal(info.usage?.cacheHitTokens, 90);
assert.equal(info.performance?.totalMs, 1700); assert.equal(info.performance?.generationMs, 700); assert.equal('secret' in info, false);
assert.equal(appearanceMessageInfo({ ...message, usage: null }).tokenCount, 71);
assert.equal(appearanceMessageInfo({ ...message, usage: null }).tokenCountSource, 'estimate');
assert.equal(appearanceMessageInfo({ role: 'user' } as any).tokenCount, null);
console.log('PASS: model/voice genuine gestures, allowlists and states, stale-chat rejection, public message metadata and provider-vs-estimate token semantics');

const page = fs.readFileSync(new URL('../src/renderer/pages/ChatPage.tsx', import.meta.url), 'utf8');
const between = (start: string, end: string) => page.slice(page.indexOf(start), page.indexOf(end, page.indexOf(start)));
const voiceSource = between('  const cancelRecording =', '  const toggleRecording =');
function voiceFixture({ permission, recognition = async () => 'recognized words' }: { permission?: () => Promise<any>; recognition?: () => Promise<string> } = {}) {
  const result: any = { input: 'existing', transcript: null, recording: false, transcribing: false, requesting: false, error: null, tracksStopped: 0, instances: [] };
  const manualVoiceRef = { current: { id: 0, pending: false } }, composerScopeRef = { current: { epoch: 1 } };
  const busy = { current: { isRecording: false, isTranscribing: false, voiceRequesting: false, sending: false } };
  const stream = { getTracks: () => [{ stop: () => { result.tracksStopped++; } }] };
  class Recorder {
    state = 'inactive'; mimeType = 'audio/webm'; onstop: any; ondataavailable: any; onerror: any; completion: Promise<void> = Promise.resolve();
    constructor() { result.instances.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['audio']) }); this.completion = Promise.resolve(this.onstop?.()); }
  }
  const context: any = { Blob, MediaRecorder: Recorder, console,
    navigator: { mediaDevices: { getUserMedia: permission ?? (async () => stream) } },
    useCallback: (fn: any) => fn, useEffect() {}, composerScope: 'scope', manualVoiceRef, composerScopeRef,
    composerMountedRef: { current: true }, recordingStreamRef: { current: null }, mediaRecorderRef: { current: null },
    speechRecorderRef: { current: null }, wakeVoiceSessionRef: { current: 0 }, isVoiceInputRef: { current: false }, voiceBusyRef: busy,
    setVoiceRequesting: (value: boolean) => { result.requesting = value; busy.current.voiceRequesting = value; },
    setIsRecording: (value: boolean) => { result.recording = value; busy.current.isRecording = value; },
    setIsTranscribing: (value: boolean) => { result.transcribing = value; busy.current.isTranscribing = value; },
    setVoiceError: (value: any) => { result.error = value; }, setVoiceTranscript: (value: any) => { result.transcript = value; },
    setInput: (update: any) => { result.input = update(result.input); },
    transcribeRecordedAudio: recognition, getSpeechRecognitionLanguage: () => 'en',
    toast: { error() {} }, t: (key: string) => key,
  };
  vm.runInNewContext(compile(voiceSource + '\nglobalThis.controls={start:startRecording,stop:stopRecording,cancel:cancelRecording};'), context);
  return { ...context.controls, result, scope: composerScopeRef, session: manualVoiceRef, stream };
}
const native = voiceFixture(); await native.start(); assert.equal(native.result.recording, true);
await native.start(); assert.equal(native.result.instances.length, 1, 'double start cannot open a second stream');
native.stop(); await native.result.instances[0].completion;
assert.equal(native.result.input, 'existing recognized words'); assert.equal(native.result.transcript, null); assert.equal(native.result.tracksStopped, 1);
const theme = voiceFixture(); await theme.start('theme'); theme.stop(); await theme.result.instances[0].completion;
assert.equal(theme.result.input, 'existing'); assert.equal(theme.result.transcript.text, 'recognized words'); assert.equal(theme.result.transcribing, false);
const canceled = voiceFixture(); await canceled.start('theme'); canceled.cancel();
assert.equal(canceled.result.tracksStopped, 1); assert.equal(canceled.result.transcript, null); assert.equal(canceled.result.recording, false);
let finishPermission!: (stream: any) => void;
const pending = voiceFixture({ permission: () => new Promise(resolve => { finishPermission = resolve; }) });
const opening = pending.start('theme'); assert.equal(pending.result.requesting, true); pending.cancel(); finishPermission(pending.stream); await opening;
assert.equal(pending.result.instances.length, 0); assert.equal(pending.result.tracksStopped, 1); assert.equal(pending.result.requesting, false);
let finishText!: (text: string) => void;
const late = voiceFixture({ recognition: () => new Promise(resolve => { finishText = resolve; }) });
await late.start('theme'); late.stop();
while (!finishText) await new Promise(resolve => setTimeout(resolve, 0));
late.scope.current.epoch++; late.cancel(); finishText('stale transcript'); await late.result.instances[0].completion;
assert.equal(late.result.transcript, null); assert.equal(late.result.input, 'existing');
const denied = voiceFixture({ permission: async () => { throw new Error('denied fixture'); } }); await denied.start('theme');
assert.equal(denied.result.error, 'chat.toasts.microphoneDenied'); assert.equal(denied.result.requesting, false);
console.log('PASS: shared native/theme recording lifecycle, one microphone stream, existing transcription service, no automatic send, cancellation, late permission/result isolation and permission errors');

function modelFixture() {
  const result: any = { selected: 'old', busy: false, error: null, calls: [], notices: [] };
  let complete!: () => void, fail!: () => void;
  const operation = { current: null }, scope = { current: { epoch: 1 } };
  const context: any = { useCallback: (fn: any) => fn, composerMountedRef: { current: true }, modelScopeRef: scope, modelOperationRef: operation,
    modelSelectionVersionRef: { current: 0 }, modelCatalogEpochRef: { current: 1 }, modelsCatalog: [{ id: 'model-a', context_length: 16000 }], selectedContextLimit: 64000,
    api: { setPreferredModel: (id: string | null) => { result.calls.push(id); return new Promise<void>((resolve, reject) => { complete = resolve; fail = () => reject(new Error('fixture')); }); },
      getContextTokenLimit: async () => ({ max_context_tokens: 64000 }) },
    setPreferredModel: (id: any) => { result.selected = id; }, setSelectedContextLimit() {},
    setModelBusy: (value: boolean) => { result.busy = value; }, setModelError: (error: any) => { result.error = error; },
    toast: { info: (value: any) => result.notices.push(value), error() {} }, t: (key: string) => key,
  };
  vm.runInNewContext(compile(between('  const selectPreferredModel =', '  // Load models catalog') + '\nglobalThis.select=selectPreferredModel;'), context);
  return { select: context.select, result, scope, complete: () => complete(), fail: () => fail() };
}
const models = modelFixture(); await models.select('unknown'); assert.equal(models.result.calls.length, 0);
const changing = models.select('model-a'); await models.select(null); assert.equal(models.result.calls.length, 1);
models.complete(); await changing; assert.equal(models.result.selected, 'model-a'); assert.equal(models.result.busy, false);
assert.equal(models.result.notices.length, 1, 'existing smaller-model context notice is reused');
const failed = models.select(null); models.fail(); await failed; assert.equal(models.result.selected, 'model-a'); assert.ok(models.result.error);
const staleModel = modelFixture(); const old = staleModel.select('model-a'); staleModel.scope.current.epoch++; staleModel.complete(); await old;
assert.equal(staleModel.result.selected, 'old', 'account/server change discards old model responses');
console.log('PASS: native and theme model changes share validation, serialized writes, rollback-on-failure semantics and stale-account suppression');
