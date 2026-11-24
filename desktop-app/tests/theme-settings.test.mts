import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const { ThemeSettingsController } = require('../src/renderer/lib/theme-settings-controller.ts');
const { parseAppearanceShellAction: parse, canRunAppearanceAction: allowed } = require('../src/main/appearance-shell-types.ts');
const { SETTINGS_GROUPS, searchSettings, settingsSectionKey } = require('../src/renderer/lib/settings-navigation.ts');
const rawEntries = require('../src/renderer/lib/settings-search-entries.json');
const en = require('../src/renderer/i18n/locales/en/translation.json'), ru = require('../src/renderer/i18n/locales/ru/translation.json');
const translate = (dict: any) => (key: string) => key.split('.').reduce((value: any, part: string) => value?.[part], dict) ?? key;
const t = translate(en), russian = translate(ru);
const compile = (text: string) => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const fieldsModule: any = { exports: {} };
vm.runInNewContext(compile(fs.readFileSync(new URL('../src/renderer/lib/app-settings-fields.ts', import.meta.url), 'utf8')), {
  exports: fieldsModule.exports, require: (name: string) => name.endsWith('/i18n') ? { SUPPORTED_LANGUAGES: ['en', 'ru'], getDetectedSystemLanguage: () => 'en', getLanguageDisplayName: (value: string) => value }
    : { ZOOM_MIN_PCT: 40, ZOOM_MAX_PCT: 200, ZOOM_STEP_PCT: 5 },
});
const { appSettingsFields, APP_SETTING_KEYS } = fieldsModule.exports;
const { SECTION_SETTING_KEYS } = require('../src/renderer/lib/settings-field-keys.ts');
const { SETTINGS_REQUESTS, settingsOperations, parseSettingsRequest } = require('../src/main/settings-request-types.ts');
const catalogModule: any = { exports: {} };
vm.runInNewContext(compile(fs.readFileSync(new URL('../src/renderer/lib/settings-catalog.ts', import.meta.url), 'utf8')), {
  exports: catalogModule.exports, require: (name: string) => name.includes('settings-navigation') ? { SETTINGS_GROUPS, searchSettings, settingsSectionKey }
    : name.includes('entries.json') ? { default: rawEntries } : name.includes('settings-field-keys') ? { SECTION_SETTING_KEYS }
    : name.includes('settings-request-types') ? { SETTINGS_REQUESTS } : { APP_SETTING_KEYS },
});
const { settingsCatalog, themeSettingsSearch, nativeSettingsTarget } = catalogModule.exports;
const catalog = settingsCatalog(t, false);
assert.equal(catalog.sections.some((section: any) => section.id === 'admin'), false);
assert.equal(settingsCatalog(t, true).sections.some((section: any) => section.id === 'admin'), true);
assert.equal(catalog.sections.find((section: any) => section.id === 'app').mode, 'fields');
assert.equal(catalog.sections.find((section: any) => section.id === 'voice').mode, 'fields');
assert.equal(themeSettingsSearch('масштаб', russian, false)[0].fieldId, 'zoom');
assert.ok(themeSettingsSearch('пароль', russian, false).some((result: any) => result.sectionId === 'account' && result.operationId === 'changePassword' && result.native === false));
assert.equal(themeSettingsSearch('PRIVATE_VALUE', t, false).length, 0);
assert.equal(nativeSettingsTarget('admin', undefined, false, t), null);
assert.equal(nativeSettingsTarget('account', 'arbitrary_script', false, t), null);
assert.equal(nativeSettingsTarget('app', 'appearance.title', false, t).result.title, t('appearance.title'));

function fixture() {
  const values: any = { language: 'system', theme: 'light', lightFrom: '07:00', darkFrom: '21:00', zoom: 100, renderPerf: 'low', showTokens: true, diceRoll: false };
  const writes: any[] = []; let fail: string | null = null, failRead = false, reading: Promise<any> | null = null;
  const controller = new ThemeSettingsController({ catalog,
    search: (query: string) => themeSettingsSearch(query, t, false), error: (code: string) => 'error:' + code,
    sections: { app: {
    fields: (draft: any, saved: any) => appSettingsFields(draft, saved, t), groups: () => [], links: () => [],
    actions: () => [{ id: 'fixture', label: 'Fixture action', disabled: false, active: false }], run: async () => {},
    read: async () => { if (failRead) throw new Error('fixture read'); return reading ? await reading : { ...values }; },
    write: async (id: string, value: any, current: () => boolean) => {
      if (id === fail) throw new Error('fixture write');
      assert.equal(current(), true); writes.push([id, value]); values[id] = id === 'zoom' ? Number(value) : value; return values[id];
    },
    } },
  });
  const action = (kind: string, extras: any = {}) => controller.handle({ type: 'settingsAction', action: kind, sectionId: 'app', editorId: controller.getState().editor?.id, ...extras });
  return { controller, action, values, writes, fail: (id: string | null) => { fail = id; }, failRead: (value: boolean) => { failRead = value; }, blockRead: (value: Promise<any> | null) => { reading = value; } };
}
const f = fixture(); await f.action('open');
const continuousZoom = fixture(); continuousZoom.values.zoom = 144; await continuousZoom.action('open');
assert.equal(continuousZoom.controller.getState().editor.fields.some((field: any) => field.error), false, 'native continuous zoom must not invalidate an untouched draft');
await continuousZoom.action('edit', { fieldId: 'showTokens', value: false });
assert.equal(await continuousZoom.action('save'), true); assert.deepEqual(continuousZoom.writes, [['showTokens', false]]); continuousZoom.controller.dispose();
const originalId = f.controller.getState().editor.id;
await f.action('edit', { fieldId: 'zoom', value: '' });
assert.ok(f.controller.getState().editor.fields.find((field: any) => field.id === 'zoom').error);
assert.equal(await f.action('save'), false); assert.equal(f.writes.length, 0);
await f.action('discard'); assert.equal(f.controller.getState().editor.dirty, false);
await f.action('edit', { fieldId: 'theme', value: 'schedule' });
assert.equal(f.controller.getState().editor.fields.find((field: any) => field.id === 'darkFrom').visible, true);
await f.action('open'); assert.equal(f.controller.getState().editor.id, originalId, 'reopening preserves drafts');
assert.equal(await f.action('reload'), false, 'reloading cannot discard a dirty draft');
assert.equal(await f.action('edit', { fieldId: 'browser_confirm_click', value: false }), false);
assert.equal(f.writes.length, 0, 'draft changes never persist before Save');
await f.action('save'); assert.deepEqual(f.writes, [['theme', 'schedule']]); assert.equal(f.controller.getState().editor.dirty, false);
assert.equal(await f.controller.handle({ type: 'settingsAction', action: 'open', sectionId: 'voice' }), false);

await f.action('edit', { fieldId: 'theme', value: 'dark' }); f.values.theme = 'system';
assert.equal(await f.action('save'), false); assert.equal(f.controller.getState().editor.error, 'error:conflict');
assert.equal(f.controller.getState().editor.fields.find((field: any) => field.id === 'theme').value, 'dark');
await f.action('discard'); await f.action('reload'); assert.equal(f.controller.getState().editor.dirty, false);
assert.equal(await f.controller.handle({ type: 'settingsAction', action: 'discard', sectionId: 'app', editorId: originalId }), false);
await f.action('edit', { fieldId: 'theme', value: 'light' }); await f.action('edit', { fieldId: 'renderPerf', value: 'high' }); f.fail('renderPerf');
assert.equal(await f.action('save'), false);
assert.equal(f.controller.getState().editor.fields.find((field: any) => field.id === 'theme').dirty, false, 'successful writes remain committed');
assert.equal(f.controller.getState().editor.fields.find((field: any) => field.id === 'renderPerf').dirty, true, 'failed writes remain editable');
f.fail(null); await f.action('save'); assert.equal(f.controller.getState().editor.dirty, false);
const failedRead = fixture(); failedRead.failRead(true); await failedRead.action('open'); assert.equal(failedRead.controller.getState().editor.error, 'error:load');
failedRead.failRead(false); await failedRead.action('reload'); assert.equal(failedRead.controller.getState().editor.fields.length, 8);
const late = fixture(); let finish!: (value: any) => void;
late.blockRead(new Promise(resolve => { finish = resolve; })); const loading = late.action('open'); late.controller.dispose(); finish(late.values); await loading;
assert.equal(late.controller.getState().editor.loading, true, 'obsolete async results do not publish into a new scope');
const concurrent = fixture(); await concurrent.action('open'); await concurrent.action('edit', { fieldId: 'showTokens', value: false });
let finishCheck!: (value: any) => void; concurrent.blockRead(new Promise(resolve => { finishCheck = resolve; }));
const saving = concurrent.action('save'); assert.equal(await concurrent.action('save'), false); assert.equal(await concurrent.action('edit', { fieldId: 'zoom', value: 120 }), false);
finishCheck(concurrent.values); await saving; assert.equal(concurrent.writes.length, 1);
console.log('PASS: existing localized catalog/search and role checks, uniform field metadata, explicit draft/save/discard, validation, conflict preservation, partial writes, stale editor/scope rejection and serialized saves');

let exposed: any, active = false;
const events = new Map(), sent: any[] = [];
const bridgeSandbox = vm.createContext({
  exports: {}, URL, URLSearchParams, setTimeout, clearTimeout, console,
  navigator: { userActivation: { get isActive() { return active; } } }, window: { addEventListener() {} },
  require: () => ({ contextBridge: { exposeInMainWorld: (_: string, api: any) => { exposed = api; } }, ipcRenderer: { on: (name: string, handler: any) => events.set(name, handler), send: (...args: any[]) => sent.push(args) } }),
});
vm.runInContext(compile(fs.readFileSync(new URL('../src/main/appearance-shell-preload.ts', import.meta.url), 'utf8')), bridgeSandbox);
const state = { activeChatId: 2, messages: [], settings: f.controller.getState() };
const update = () => events.get('appearance-shell:state')({}, { ...state, settings: f.controller.getState() });
update(); assert.equal(exposed.getSettingsSections().length, catalog.sections.length);
assert.equal(exposed.runSettingsAction('app', 'fixture'), false, 'settings operations require a genuine gesture');
active = true; assert.equal(exposed.runSettingsAction('app', 'fixture'), true); assert.equal(parse(sent.at(-1)[1]).actionId, 'fixture');
assert.equal(allowed(state, parse(sent.at(-1)[1])), true); assert.equal(exposed.runSettingsAction('app', 'invented'), false); active = false;
assert.equal(exposed.searchSettings('zoom'), true); assert.equal(parse(sent.at(-1)[1]).query, 'zoom');
assert.equal(exposed.openSettingsSection('models'), false);
assert.equal(exposed.setSettingValue('app', 'showTokens', false), true);
const edit = parse(sent.at(-1)[1]); assert.equal(allowed({ ...state, settings: f.controller.getState() }, edit), true); await f.controller.handle(edit); update();
assert.equal(exposed.saveSettingsSection('app'), false, 'persisting requires a genuine gesture'); active = true;
assert.equal(exposed.saveSettingsSection('app'), true); assert.equal(allowed({ ...state, settings: f.controller.getState() }, parse(sent.at(-1)[1])), true);
assert.equal(exposed.openSettings('admin'), false); assert.equal(exposed.openSettings('voice'), true); assert.equal(parse(sent.at(-1)[1]).sectionId, 'voice');
assert.equal(parse({ type: 'settingsAction', action: 'edit', sectionId: 'app', editorId: edit.editorId, fieldId: 'zoom', value: NaN }), null);
assert.equal(allowed({ ...state, settings: f.controller.getState() }, { ...edit, editorId: 'obsolete' }), false);
assert.equal(allowed(state, { type: 'openSettings', sectionId: 'admin' }), false);
const accountState = { activeChatId: null, messages: [], settings: { ...f.controller.getState(), editor: {
  ...f.controller.getState().editor, sectionId: 'account', requests: settingsOperations('account', t), busy: false, loading: false,
} } };
events.get('appearance-shell:state')({}, accountState); active = false;
await assert.rejects(exposed.requestSettings('account', 'changePassword', { currentPassword: 'PRIVATE_CURRENT', newPassword: 'PRIVATE_NEW_PASSWORD' }), /unavailable/);
active = true;
const credentials = exposed.requestSettings('account', 'changePassword', { currentPassword: 'PRIVATE_CURRENT', newPassword: 'PRIVATE_NEW_PASSWORD' });
const credentialRequest = sent.at(-1)[1]; assert.ok(parseSettingsRequest(credentialRequest));
assert.equal(vm.runInContext('JSON.stringify([...documentRequests.values()].map(item=>item.request)).includes("PRIVATE_")', bridgeSandbox), false, 'pending sandbox requests retain scope metadata without credentials');
events.get('appearance-shell:state')({}, { ...accountState, activeChatId: 123 });
events.get('appearance-shell:result')({}, { requestId: credentialRequest.requestId, result: { ok: true } }); assert.equal((await credentials).ok, true, 'settings requests are independent of chat navigation');
active = false; const canceledRead = exposed.requestSettings('account', 'getAccount');
const canceled = assert.rejects(canceledRead, /settings_request_canceled/); assert.equal(exposed.cancelSettingsRequests('account'), true); await canceled;
f.controller.dispose(); failedRead.controller.dispose(); concurrent.controller.dispose();
console.log('PASS: isolated settings bridge, native deep links, genuine-save gating, host role/field/editor validation and automatic opaque draft IDs');
