import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const module: any = { exports: {} }, stored = new Map<string, string>(), audio: any[] = [];
const utterances: any[] = [];
let generate = async () => new ArrayBuffer(8), remote = async () => ({ audio_url: '/fixture' });
stored.set('chatter_tts_settings', JSON.stringify({ modelId: 'piper', voiceId: 'ru', volume: .3, sfxVolume: .3 }));
const initial = stored.get('chatter_tts_settings');
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/renderer/lib/tts.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: module.exports, ArrayBuffer, Uint8Array, Event, console: { error() {} },
  localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) },
  window: { electronAPI: { ttsGenerate: () => generate(), listPiperVoices: async () => [{ id: 'ru', name: 'Ru', lang: 'ru' }] }, dispatchEvent() {} },
  speechSynthesis: { cancel() {}, getVoices: () => [], addEventListener() {}, speak: (utterance: any) => utterances.push(utterance) },
  SpeechSynthesisUtterance: class { constructor(public text: string) {} },
  require: (name: string) => name === './audioManager' ? { audioManager: { abort() {}, stopWithFade: async () => {}, playBuffer: async (_buffer: unknown, volume: number) => { audio.push(volume); } } }
    : name.endsWith('/i18n') ? { default: { language: 'en', resolvedLanguage: 'en', t: (key: string) => key, getFixedT: () => () => 'Preview' } }
    : { fetchTtsVoicePreview: () => remote(), fetchAudioBuffer: async () => new ArrayBuffer(8) },
});
const { ttsPreview, ttsStopPreview, ttsIsPreviewPlaying, setTtsSettings } = module.exports;
await module.exports.fetchPiperVoiceList();
let complete!: (buffer: ArrayBuffer) => void;
generate = () => new Promise(resolve => { complete = resolve; });
const canceled = new AbortController(); const pending = ttsPreview('piper', 'ru', { signal: canceled.signal, throwOnError: true });
assert.equal(ttsIsPreviewPlaying(), true); canceled.abort(); assert.equal(ttsIsPreviewPlaying(), false);
complete(new ArrayBuffer(8)); await pending; assert.equal(audio.length, 0, 'canceled late generation never plays');

const stale = ttsPreview('piper', 'ru');
const builtin = ttsPreview('builtin', '__default', { volume: .65 }); assert.equal(utterances.at(-1).volume, .65);
complete(new ArrayBuffer(8)); await stale; assert.equal(ttsIsPreviewPlaying(), true, 'an old result cannot clear the new preview state');
ttsStopPreview(); await builtin; assert.equal(ttsIsPreviewPlaying(), false);
assert.equal(stored.get('chatter_tts_settings'), initial, 'preview volume never changes the saved preference');

generate = async () => new ArrayBuffer(8); await ttsPreview('piper', 'ru', { volume: .75, throwOnError: true });
assert.equal(audio.at(-1), .75); assert.equal(ttsIsPreviewPlaying(), false);
const failed = ttsPreview('builtin', '__default', { throwOnError: true }); utterances.at(-1).onerror({ error: 'synthesis-failed' });
await assert.rejects(failed, /synthesis-failed/); assert.equal(ttsIsPreviewPlaying(), false);
await assert.rejects(ttsPreview('unsupported', 'voice', { throwOnError: true }), /unsupported/);

generate = () => new Promise(resolve => { complete = resolve; }); const beforeChange = audio.length;
const changed = ttsPreview('piper', 'ru'); setTtsSettings({ modelId: 'builtin', voiceId: '__default', volume: .3, sfxVolume: .3 });
complete(new ArrayBuffer(8)); await changed; assert.equal(audio.length, beforeChange, 'applying voice settings cancels a previous pending preview');
let completeRemote!: (value: any) => void;
remote = () => new Promise(resolve => { completeRemote = resolve; });
const remoteAbort = new AbortController(), remotePreview = ttsPreview('cartesia', 'remote', { signal: remoteAbort.signal });
await Promise.resolve(); await Promise.resolve(); remoteAbort.abort(); completeRemote({ audio_url: '/fixture' }); await remotePreview;
assert.equal(audio.length, beforeChange);
console.log('PASS: shared TTS preview draft volume, explicit stop/abort, no saved writes, builtin completion/errors, stale local/remote generation suppression, independent preview tickets and cancellation on setting changes');
