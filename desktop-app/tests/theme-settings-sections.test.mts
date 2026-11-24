import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const { ThemeSettingsController } = require('../src/renderer/lib/theme-settings-controller.ts');
const { settingsFields } = require('../src/renderer/lib/settings-fields.ts');
const { SECTION_SETTING_KEYS } = require('../src/renderer/lib/settings-field-keys.ts');
const { WAKE_WORD_CHOICES } = require('../src/main/wakeword-config.ts');
const en = require('../src/renderer/i18n/locales/en/translation.json');
const t = (key: string) => key.split('.').reduce((value: any, part: string) => value?.[part], en) ?? key;
const writes: any[] = [], patches: any[] = [], cache: any[] = [];
let active = true, available = true, contextCap = 30000, offline = false;
let wakeEnabled = false, wake = { words: ['alexa'], sensitivity: 50 };
let browser = { concurrency: 2, searchEnabled: true, readerEnabled: true };
let memory = { automatic_memory: false, result_limit: null as number | null, admin_result_limit: 7, effective_result_limit: 7 };
let ui = { show_tokens: true, browser_confirm_open: true, browser_confirm_click: true, browser_confirm_fill: true, browser_human_typing: true };
let tts = { modelId: 'piper', voiceId: 'ru', volume: 0.3, sfxVolume: 0.3 };
let recognitionSource = 'local', recognitionLanguage = 'auto';
let previewSignal: AbortSignal | null = null, previewFailure = false;
let user = { id: 4, name: 'Before', timezone_offset: null as number | null, timezone_confirmed: false };
let contextTokens = 20000, attachmentTokens = 15000, agentModel: string | null = 'smart', reasoning: string | null = 'high';
let modelCatalog = [{ id: 'smart', name: 'Smart', reasoning_levels: ['high'] }, { id: 'simple', name: 'Simple', reasoning_levels: [] }];
const voices = [{ id: 'piper', name: 'Piper', voices: [{ id: 'ru', name: 'Ruslan', lang: 'ru' }] },
  { id: 'builtin', name: 'Builtin', voices: [{ id: 'en', name: 'English', lang: 'en' }] }];
const api = {
  patchMemoryPreferences: async (patch: any) => { writes.push(['memory', patch]); memory = { ...memory, ...patch }; return { preferences: { ...memory } }; },
  fetchTranscriptionStatus: async () => ({ available }), fetchMe: async () => ({ ...user }),
  setUserName: async (name: string) => { writes.push(['name', name]); user.name = name; return { name }; },
  setUserTimezone: async (offset: number) => { writes.push(['timezone', offset]); user.timezone_offset = offset; user.timezone_confirmed = true; return { timezone_offset: offset, timezone_confirmed: true }; },
  setContextTokenLimit: async (value: number) => { writes.push(['context', value]); contextTokens = Math.min(contextCap, value); return { max_context_tokens: contextTokens, max_context_tokens_limit: contextCap }; },
  setAttachmentTokenLimit: async (value: number) => { writes.push(['attachment', value]); attachmentTokens = Math.min(value, Math.floor(contextTokens * 0.9)); return { attachment_max_tokens: attachmentTokens }; },
  setSubagentModel: async (value: string | null) => { writes.push(['agentModel', value]); agentModel = value; return { subagent_model: value }; },
  setSubagentReasoningLevel: async (value: string | null) => { writes.push(['reasoning', value]); reasoning = value; return { reasoning_level: value }; },
};
const reads = {
  context: async () => ({ max_context_tokens: contextTokens, max_context_tokens_limit: contextCap }),
  attachment: async () => ({ attachment_max_tokens: attachmentTokens === 0 ? 0 : Math.min(attachmentTokens, Math.floor(contextTokens * 0.9)) }),
  desktopBrowser: async () => ({ ...browser }),
  memoryPreferences: async () => ({ preferences: { ...memory } }), ui: async () => ({ settings: { ...ui } }),
  models: async () => ({ models: modelCatalog, auto_reasoning_levels: ['high'] }),
  agentModel: async () => ({ subagent_model: agentModel }), agentReasoning: async () => ({ reasoning_level: reasoning }),
};
const module: any = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/renderer/lib/theme-settings-sections.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: module.exports, window: { electronAPI: {
  getDesktopBrowserSettings: async () => ({ ...browser }), setDesktopBrowserSettings: async (value: any) => { writes.push(['browser', value]); browser = value; return { ...browser }; },
} }, require: (name: string) => {
  if (name === './api') return api;
  if (name === './settings-service') return { settingsReads: reads };
  if (name === './settings-fields') return { settingsFields };
  if (name === './settings-field-keys') return { SECTION_SETTING_KEYS };
  if (name === './app-settings') return { saveAppUiSettings: async (patch: any) => { writes.push(['ui', patch]); ui = { ...ui, ...patch }; return { settings: { ...ui } }; } };
  if (name.endsWith('/i18n')) return { SUPPORTED_LANGUAGES: ['en', 'ru'], getLanguageDisplayName: (value: string) => value };
  if (name === './tts') return { fetchPiperVoiceList: async () => [], fetchRemoteTtsProviders: async () => { if (offline) throw new Error('offline'); return []; }, getTtsModels: () => voices,
    getTtsSettings: () => ({ ...tts }), setTtsSettings: (value: any) => { writes.push(['tts', { ...value }]); tts = value; },
    ttsStopPreview: () => {}, ttsPreview: async (_model: string, _voice: string, options: any) => {
      if (previewFailure) throw new Error('preview failure'); previewSignal = options.signal;
      await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }));
    } };
  if (name === './speechRecognition') return { getSpeechRecognitionLanguage: () => recognitionLanguage, getSpeechRecognitionSource: () => recognitionSource,
    setSpeechRecognitionLanguage: (value: string) => { recognitionLanguage = value; writes.push(['language', value]); },
    setSpeechRecognitionSource: (value: string) => { recognitionSource = value; writes.push(['source', value]); } };
  if (name.endsWith('/wakeword-config')) return { WAKE_WORD_CHOICES };
  if (name === './wakeWordToggle') return { getWakeWordEnabled: () => wakeEnabled, getWakeWordConfig: () => wake,
    setWakeWordEnabled: (value: boolean) => { writes.push(['wakeEnabled', value]); wakeEnabled = value; },
    setWakeWordConfig: (value: any) => { writes.push(['wakeConfig', value]); wake = value; } };
  throw new Error(name);
} });
const sections = module.exports.createThemeSettingsSections({ client: {
  fetchQuery: async ({ queryFn }: any) => queryFn(), setQueryData: (...args: any[]) => cache.push(args), invalidateQueries: async () => {},
}, base: 'fixture', userId: 4, current: () => active, t, patchUser: (patch: any) => patches.push(patch) });
const controller = new ThemeSettingsController({ catalog: { groups: [], sections: Object.keys(sections).map(id => ({ id, groupId: '', label: id, mode: 'hybrid' })) },
  sections, search: () => [], error: (code: string) => code });
const action = (action: string, sectionId: string, extras: any = {}) => controller.handle({ type: 'settingsAction', action, sectionId, editorId: controller.getState().editor?.id, ...extras });
const edit = (section: string, fieldId: string, value: any) => action('edit', section, { fieldId, value });
const field = (id: string) => controller.getState().editor.fields.find((field: any) => field.id === id);

await action('open', 'memory'); assert.equal(field('resultLimit').value, 'automatic'); await edit('memory', 'resultLimit', '15'); await edit('memory', 'automaticMemory', true); await action('save', 'memory');
assert.equal(memory.result_limit, 15); assert.equal(memory.automatic_memory, true);
await edit('memory', 'resultLimit', '21'); assert.ok(field('resultLimit').error); await action('discard', 'memory');
await edit('memory', 'resultLimit', 'automatic'); await action('save', 'memory'); assert.equal(memory.result_limit, null);
await action('open', 'browser'); assert.equal(field('autoOpen').value, false); await edit('browser', 'autoOpen', true); await edit('browser', 'humanTyping', false); await action('save', 'browser');
assert.equal(ui.browser_confirm_open, false); assert.equal(ui.browser_confirm_click, true); assert.equal(ui.browser_human_typing, false); assert.equal(ui.show_tokens, true);
assert.ok(field('autoFill').help.includes(t('settings.browser.sensitiveFieldsNote')));

const beforeVoice = writes.length; await action('open', 'voice'); assert.equal(writes.length, beforeVoice);
const preview = action('run', 'voice', { actionId: 'previewVoice' });
assert.equal(controller.getState().editor.actions.find((item: any) => item.id === 'previewVoice').active, true);
assert.equal(await action('run', 'voice', { actionId: 'arbitrary' }), false);
await action('run', 'voice', { actionId: 'stopPreview' }); await preview; assert.equal(previewSignal!.aborted, true); assert.equal(writes.length, beforeVoice);
const editingPreview = action('run', 'voice', { actionId: 'previewVoice' }); await edit('voice', 'volume', 0.4); await editingPreview;
assert.equal(previewSignal!.aborted, true); await action('discard', 'voice');
previewFailure = true; assert.equal(await action('run', 'voice', { actionId: 'previewVoice' }), false); assert.equal(controller.getState().editor.error, 'action'); previewFailure = false;
await edit('voice', 'wakeEnabled', true); await edit('voice', 'wake_alexa', false);
assert.ok(field('wake_alexa').error); assert.equal(await action('save', 'voice'), false);
await edit('voice', 'wake_hey_jarvis', true); await action('save', 'voice'); assert.equal(wakeEnabled, true); assert.equal(wake.words.join(','), 'hey_jarvis');
assert.equal(writes.find(([id]) => id === 'wakeEnabled')[1], true);
assert.equal(field('recognitionSource').options.find((option: any) => option.value === 'server').disabled, false);
await edit('voice', 'modelId', 'builtin'); assert.equal(field('voiceId').value, 'en'); assert.equal(tts.modelId, 'piper');
await action('save', 'voice'); assert.equal(tts.modelId, 'builtin'); assert.equal(tts.voiceId, 'en');
assert.ok(writes.filter(([id]) => id === 'tts').every(([, value]) => value.modelId === 'builtin' && value.voiceId === 'en'), 'never save an incompatible model/voice pair');
await edit('voice', 'volume', '0.35'); await action('save', 'voice'); assert.equal(tts.volume, 0.35);
await edit('voice', 'recognitionSource', 'server'); available = false;
assert.equal(await action('save', 'voice'), false, 'server availability is rechecked before persisting'); assert.equal(recognitionSource, 'local');
await action('discard', 'voice'); await action('reload', 'voice');
tts.modelId = 'removed-provider'; tts.voiceId = 'removed-voice'; await action('reload', 'voice');
assert.equal(field('modelId').value, 'removed-provider'); assert.equal(field('modelId').error, null);
await edit('voice', 'sfxVolume', 0.5); await action('save', 'voice'); assert.equal(tts.sfxVolume, 0.5); assert.equal(tts.modelId, 'removed-provider', 'reading/volume changes do not replace unavailable saved voices');
offline = true; await action('reload', 'voice'); await edit('voice', 'volume', 0.4); assert.equal(await action('save', 'voice'), true); assert.equal(tts.volume, 0.4, 'local voice settings work when the remote catalog fails');

await action('open', 'account'); assert.equal(field('name').type, 'text'); assert.equal(field('timezone').value, 'auto');
await edit('account', 'name', '  After  '); await edit('account', 'timezone', '5.75');
await action('save', 'account'); assert.equal(user.name, 'After'); assert.equal(user.timezone_offset, 5.75); assert.equal(user.timezone_confirmed, true);
await edit('account', 'name', ''); assert.ok(field('name').error); await action('discard', 'account');
await edit('account', 'name', 'My draft'); user.name = 'External'; assert.equal(await action('save', 'account'), false); assert.equal(field('name').value, 'My draft'); await action('discard', 'account');

await action('open', 'limits'); await edit('limits', 'contextTokens', 10000); assert.equal(field('attachmentTokens').max, 9000);
assert.equal(await action('save', 'limits'), true); assert.equal(field('attachmentTokens').value, 9000, 'refresh dependent effective values after context reduction');
await edit('limits', 'contextTokens', 20000); await edit('limits', 'attachmentTokens', 17000); assert.equal(await action('save', 'limits'), true);
assert.equal(attachmentTokens, 17000); await edit('limits', 'attachmentTokens', 0); await action('save', 'limits'); assert.equal(field('attachmentTokens').value, 0);
await edit('limits', 'desktopSearch', false); await edit('limits', 'browserConcurrency', 4); await action('save', 'limits');
assert.equal(browser.searchEnabled, false); assert.equal(browser.readerEnabled, true); assert.equal(browser.concurrency, 4);
await edit('limits', 'contextTokens', 30000); contextCap = 25000; const writeCount = writes.length;
assert.equal(await action('save', 'limits'), false); assert.equal(writes.length, writeCount, 'changed server cap prevents stale draft writes'); await action('discard', 'limits');

await action('open', 'agents'); await edit('agents', 'model', 'simple'); assert.equal(field('reasoning').value, ''); await action('save', 'agents');
assert.equal(agentModel, 'simple'); assert.equal(reasoning, null);
await edit('agents', 'model', 'smart'); await edit('agents', 'reasoning', 'high'); modelCatalog = modelCatalog.filter(model => model.id !== 'smart');
assert.equal(await action('save', 'agents'), false, 'model catalog is revalidated'); await action('discard', 'agents');
active = false; assert.equal(await action('reload', 'agents'), false); assert.equal(controller.getState().editor.error, 'load'); controller.dispose();
for (const section of Object.values(sections) as any[]) for (const item of section.groups()) assert.notEqual(item.label, undefined);
console.log('PASS: voice dependencies/availability/offline controls, coherent TTS pairs, wake-word validation, account drafts/timezones/conflicts, changing server caps/budgets, desktop runtime, agents, memory defaults, browser permission semantics and scope guards');
