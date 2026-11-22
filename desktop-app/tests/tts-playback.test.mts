import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const deferred = () => { let resolve: any; const promise = new Promise<any>(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
const sources: any[] = [], contexts: any[] = [];
let decoding: ReturnType<typeof deferred> | undefined;
class TestAudioContext {
  state = 'running'; currentTime = 0; destination = {};
  constructor() { contexts.push(this); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  decodeAudioData() { return decoding?.promise ?? Promise.resolve({ duration: 1 }); }
  createBufferSource() {
    const node: any = { connect() {}, start() { node.started = true; }, stop() { queueMicrotask(() => node.onended?.()); } };
    sources.push(node); return node;
  }
  createGain() { return { connect() {}, gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} } }; }
}
const timers = { setTimeout: (fn: any) => { queueMicrotask(fn); return 1; } };
const audioExports: any = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/renderer/lib/audioManager.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
  { exports: audioExports, window: { AudioContext: TestAudioContext }, ...timers });
const generated: any[] = [], remote: any[] = [];
let settings = { modelId: 'piper', voiceId: 'test', volume: 1 };
const speech: any = { getVoices: () => [], addEventListener() {}, cancel() { speech.cancels = (speech.cancels ?? 0) + 1; },
  pause() { speech.paused = true; }, resume() { speech.paused = false; }, speak(utterance: any) { speech.utterance = utterance; utterance.onstart?.(); } };
const exports: any = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/renderer/lib/tts.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
  exports, console, ArrayBuffer, ...timers, speechSynthesis: speech, SpeechSynthesisUtterance: class { constructor(public text: string) {} },
  localStorage: { getItem: () => JSON.stringify(settings) },
  window: { electronAPI: { ttsGenerate: () => { const request = deferred(); generated.push(request); return request.promise; } } },
  require: (name: string) => name.includes('audioManager') ? audioExports : name.includes('i18n') ? { default: { t: (key: string) => key, language: 'en' } }
    : { generateTts: () => { const request = deferred(); remote.push(request); return request.promise; }, fetchAudioBuffer: async () => new ArrayBuffer(1) },
});
const state = () => JSON.parse(JSON.stringify(exports.ttsGetPlaybackState()));
exports.ttsSpeak(1, 'First'); await flush();
assert.deepEqual(state(), { messageId: 1, status: 'loading' });
await exports.ttsPause();
assert.equal(state().status, 'paused');
generated[0].resolve(new ArrayBuffer(1)); await flush();
assert.equal(contexts[0].state, 'suspended', 'pause during generation is retained when audio becomes ready');
assert.equal(state().status, 'paused');
const firstSource = sources.at(-1);
await exports.ttsResume();
assert.equal(contexts[0].state, 'running'); assert.equal(state().status, 'playing');
await exports.ttsPause(); await exports.ttsResume();
assert.equal(sources.at(-1), firstSource, 'resume keeps the same audio source and playback position');
assert.equal(generated.length, 1, 'resume does not regenerate audio');
firstSource.onended(); await flush(); assert.equal(state().status, 'idle');

exports.ttsSpeak(2, 'Cancelled'); await flush(); await exports.ttsStop();
const count = sources.length;
generated[1].resolve(new ArrayBuffer(1)); await flush();
assert.equal(sources.length, count, 'a cancelled generation cannot start later');
assert.equal(state().status, 'idle');
decoding = deferred();
exports.ttsSpeak(3, 'Decode'); await flush(); generated[2].resolve(new ArrayBuffer(1)); await flush();
await exports.ttsStop(); decoding.resolve({ duration: 1 }); await flush(); decoding = undefined;
assert.equal(sources.length, count, 'stop during audio decoding also invalidates playback');

settings = { ...settings, modelId: 'builtin' };
exports.ttsSpeak(4, 'Builtin'); assert.equal(state().status, 'playing');
await exports.ttsPause(); assert.equal(speech.paused, true);
await exports.ttsResume(); assert.equal(speech.paused, false);
const oldUtterance = speech.utterance;
await exports.ttsStop(); exports.ttsSpeak(4, 'Replacement');
oldUtterance.onend(); assert.equal(state().status, 'playing', 'old completion cannot clear replacement speech');
await exports.ttsStop();

settings = { ...settings, modelId: 'cartesia' };
exports.ttsSpeak(5, 'Remote'); await flush();
await exports.ttsPause(); remote[0].resolve({ audio_url: '/test.mp3' }); await flush();
assert.equal(state().status, 'paused'); assert.equal(contexts[0].state, 'suspended');
await exports.ttsResume(); assert.equal(remote.length, 1); assert.equal(state().status, 'playing');
await exports.ttsStop(); assert.equal(state().status, 'idle');
console.log('PASS: Piper, remote and built-in TTS pause/resume, same-source continuation, loading/decode cancellation and stale completion guards');
