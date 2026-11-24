import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url), ts = require('typescript');
const { ThemeSettingsController } = require('../src/renderer/lib/theme-settings-controller.ts');
const { parseSettingsRequest, settingsOperations, canRequestSettings } = require('../src/main/settings-request-types.ts');
const schema = require('../src/main/appearance-schema.ts');
const dictionary = require('../src/renderer/i18n/locales/en/translation.json');
const t = (key: string) => key.split('.').reduce((value: any, part: string) => value?.[part], dictionary) ?? key;
const calls: any[] = [], changes: any[] = [], cached: any[] = [];
let active = true, authCurrent = true, loggedOut = 0, accountFailure: string | null = null, buildFailed = false;
let spaces = [{ id: 1, name: 'General', kind: 'general', is_default: 1, is_primary: 1 }, { id: 2, name: 'Other', kind: 'general', is_default: 0, is_primary: 0 }, { id: 3, name: 'Private chat', kind: 'chat', is_default: 0, is_primary: 0 }];
let records = [{ id: 'record-1', memory_space_id: 1, text: 'x'.repeat(1000), source: 'Fixture', updated_at: 10 }];
Object.assign(spaces[0], { user_id: 99 }); Object.assign(records[0], { private_embedding: [1, 2, 3] });
let snapshot = { appearance: { version: 1, revision: 3, activeId: 'one', profiles: [{ ...schema.newAppearance('one'), revision: 1 }] },
  workspace: { directory: '/fixture', draftsDirectory: '/fixture/.drafts', documentation: '/fixture/THEMES.md', activeId: 'one', profiles: [], drafts: [{ id: 'draft-one', directory: '/fixture/.drafts/draft-one' }], migrationComplete: true, migrationErrors: [], issues: [] } };
const drafts: any = { 'draft-one': schema.newAppearance('draft-one') };
const copy = (value: any) => JSON.parse(JSON.stringify(value));
let intuitionConfig:any={revision:0,settings:{mode:'disabled',historyMessages:null,questions:null},available:false,
  defaults:[{id:'humor',name:'Humor',question:'Is the user joking?',enabled:true}],effective:{enabled:false,historyMessages:2,questions:[]}};
const intuitionModule:any={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/renderer/lib/intuition-service.ts',import.meta.url),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
  exports:intuitionModule.exports,require:()=>({apiFetch:async(path:string,options:any={})=>{
    calls.push(['intuition',path,options]);
    if(path.endsWith('/suggest'))return {questions:[{id:'new_signal',name:'New',question:'New question?',enabled:true}]};
    if(options.method==='PUT'){
      const body=JSON.parse(options.body);
      if(body.revision!==intuitionConfig.revision)throw Object.assign(new Error('conflict'),{data:{error:'intuition_settings_changed'}});
      intuitionConfig={...intuitionConfig,revision:intuitionConfig.revision+1,settings:body.settings};
    }
    return copy(intuitionConfig);
  }})});
let pendingRead: Promise<any> | null = null, observedSignal: AbortSignal | null = null;
const api = {
  fetchMe: async () => ({ id: 4, name: 'Fixture', username: null, plan: 'pro', role: 'user', identities: [{ provider: 'password', provider_subject: 'fixture-user', username: null }] }),
  changeAccountPassword: async (current: string, next: string) => { calls.push(['password', current, next]); if (accountFailure) throw new Error(accountFailure); return { ok: true }; },
  changeAccountLogin: async (current: string, login: string) => { calls.push(['login', current, login]); if (accountFailure) throw new Error(accountFailure); return { ok: true, login: login.toLowerCase() }; },
  getSubagentCatalog: async (locale: string) => ({ agents: [{ id: 'search', name: locale + ' Search', description: 'Find information', icon: 'globe', privatePrompt: 'never expose' }] }),
  fetchQuota: async () => ({ billing_mode: 'tokens', percent: 12, tokens: { used: 12, quota: 100 }, cost: { used: 1, quota: 10 }, resets_at: 100000, quota: null }),
  apiFetch: async () => ({ configured: true }),
};
const memory = {
  listMemorySpaces: async () => ({ spaces: copy(spaces) }),
  createMemorySpace: async (name: string) => { const space = { id: 4, name, kind: 'general', is_default: 0, is_primary: 0 }; spaces.push(space); changes.push('create'); return { space }; },
  activateMemorySpace: async (id: number) => { spaces = spaces.map(space => ({ ...space, is_default: space.kind === 'general' && space.id === id ? 1 : 0 })); changes.push('activate'); return { space: copy(spaces.find(space => space.id === id)) }; },
  renameMemorySpace: async (id: number, name: string) => { const space = spaces.find(space => space.id === id)!; space.name = name; return { space: copy(space) }; },
  deleteMemorySpace: async (id: number) => { if (id === 1) throw new Error('memory_primary_space'); spaces = spaces.filter(space => space.id !== id); return { active_space: spaces[0] }; },
  listGeneralMemoryRecords: async (spaceId: number, query: string, limit: number, offset: number, signal: AbortSignal) => { calls.push(['records', spaceId, query, limit, offset]); observedSignal = signal; if (pendingRead) return pendingRead; return { records: copy(records), total: records.length, nextOffset: null }; },
  searchGeneralMemoryRecords: async (_space: number, query: string) => { calls.push(['semantic', query]); return { records: copy(records) }; },
  updateMemoryRecord: async (id: string, text: string, source?: string) => { const record = records.find(record => record.id === id)!; record.text = text; if (source !== undefined) record.source = source; return { record: copy(record) }; },
  deleteMemoryRecord: async (id: string) => { records = records.filter(record => record.id !== id); return { deleted: true }; },
  loadMemoryMapData: async () => ({ records: copy(records), total: records.length, vectors: [] }),
};
const localAppearance = async (operation: string, params: any = {}) => {
  calls.push(['appearance', operation]);
  if (operation === 'read-draft') return copy(drafts[params.id]);
  if (operation === 'write-draft') { drafts[params.profile.id] = copy(params.profile); return { written: true }; }
  if (operation === 'prepare') { drafts[params.id] ??= schema.newAppearance(params.id); return { prepared: true }; }
  if (operation === 'image') return { image: 'chatter-theme://fixture/image.png' };
  if (operation === 'export-bundle') return new Uint8Array([1, 2, 3]);
  if (operation === 'import-bundle') return schema.newAppearance('imported');
  return copy(snapshot);
};
const module: any = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/renderer/lib/theme-settings-requests.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: module.exports, AbortController, atob, Uint8Array, crypto: { randomUUID }, window: { electronAPI: { saveFile: async (name: string, bytes: ArrayBuffer) => { calls.push(['saveFile', name, bytes.byteLength]); return { canceled: false }; } } }, require: (name: string) => {
  if (name === './api') return api;
  if (name.endsWith('settings-request-types')) return { settingsOperations };
  if (name === './memory-settings-service') return memory;
  if (name === './intuition-service') return intuitionModule.exports;
  if (name === './theme-profile-settings') return {createThemeProfileRequests:()=>({})}; // Covered by theme-profile-settings.test.mts.
  if (name === './memory-queries') return { memoryPageUrl: (path: string, params: any) => path + '?' + new URLSearchParams(params), computeMemoryProjection: async () => ({ points: [{ id: 'record-1', position: [0, 1, 2] }], spaces: 1 }) };
  if (name === './appearance-schema') return schema;
  if (name === './appearance-runtime') return { previewAppearance: (profile: any) => changes.push(['preview', profile?.id ?? null]) };
  if (name === './appearance-validation') return { validateAppearanceCode: async () => { if (buildFailed) throw Object.assign(new Error('appearance_build_failed'), { diagnostics: [{ file: 'App.tsx', line: 1, column: 2, message: 'Fixture error' }] }); } };
  if (name === './appearance-service') return { localAppearance, readLocalDraft: async (id: string) => copy(drafts[id]), fetchAppearance: async () => copy(snapshot),
    updateAppearance: async (command: any) => { calls.push(['changeAppearance', copy(command)]);
      if (command.action !== 'save' && command.revision !== snapshot.appearance.revision) throw new Error('appearance_conflict');
      if (command.action === 'save' && command.profile.revision !== (snapshot.appearance.profiles.find(profile => profile.id === command.profile.id)?.revision ?? 0)) throw new Error('appearance_conflict');
      if (command.action === 'activate') snapshot.appearance.activeId = command.id;
      if (command.action === 'save') snapshot.appearance.profiles = [{ ...command.profile, revision: command.profile.revision + 1 }];
      if (command.action === 'delete') snapshot.appearance.profiles = snapshot.appearance.profiles.filter(profile => profile.id !== command.id);
      snapshot.appearance.revision++; return copy(snapshot);
    } };
  throw new Error(name);
} });
const adapters = module.exports.createThemeSettingsRequests({ client: { fetchQuery: async ({ queryFn }: any) => queryFn(), invalidateQueries: async (key: any) => { cached.push(key); }, setQueryData: (...args: any[]) => cached.push(args) },
  base: 'fixture', userId: 4, current: () => active, t, locale: () => 'ru', reauthenticate: () => { if (authCurrent) loggedOut++; } });
const values = { preference: false };
const controller = new ThemeSettingsController({ catalog: { groups: [], sections: Object.keys(adapters).map(id => ({ id, label: id, groupId: '', mode: 'fields' })) },
  sections: Object.fromEntries(Object.entries(adapters).map(([id, adapter]) => [id, { fields: (draft: any, saved: any) => [{ id: 'preference', value: draft.preference, savedValue: saved.preference, dirty: draft.preference !== saved.preference, error: null }],
    groups: () => [], links: () => [], read: async () => ({ ...values }), write: async (_id: string, value: boolean) => value, ...adapter as any }])), search: () => [], error: (code: string) => code });
let sequence = 0;
const open = (sectionId: string) => controller.handle({ type: 'settingsAction', action: 'open', sectionId });
const raw = (sectionId: string, operation: string, params: any = {}) => ({ method: 'settings', requestId: String(++sequence), sectionId, operation, params, editorId: controller.getState().editor.id });
const request = async (section: string, operation: string, params: any = {}) => { const input = raw(section, operation, params); const result = await controller.request(input); controller.completeRequest(input.requestId); return result; };
await open('intuition');
const config={mode:'enabled',historyMessages:0,questions:[]};
await assert.rejects(request('intuition','saveIntuitionConfig',{settings:config}),/settings_read_required/);
assert.equal(parseSettingsRequest(raw('intuition','saveIntuitionConfig',{settings:{...config,mode:'inherit'}})),null);
assert.equal(parseSettingsRequest(raw('intuition','saveIntuitionConfig',{settings:{...config,historyMessages:51}})),null);
assert.equal(parseSettingsRequest(raw('intuition','saveIntuitionConfig',{settings:{...config,questions:[{id:'bad-id',name:'x',question:'y',enabled:true}]}})),null);
const intuitionRead=await request('intuition','getIntuitionConfig');assert.equal(intuitionRead.available,false);assert.equal(intuitionRead.revision,undefined);
await request('intuition','saveIntuitionConfig',{settings:config});assert.equal(intuitionConfig.settings.mode,'enabled');
assert.equal(calls.at(-1)[1],'/api/v1/intuition');
const suggestions=await request('intuition','suggestIntuitionQuestions',{brief:'Understand humor'});
assert.equal(suggestions.questions[0].id,'new_signal');assert.deepEqual(intuitionConfig.settings.questions,[],'suggestions never change active settings');
assert.equal(JSON.parse(calls.at(-1)[2].body).includeHistory,false);
intuitionConfig.revision++;await assert.rejects(request('intuition','saveIntuitionConfig',{settings:config}),/intuition_settings_changed/);
await assert.rejects(request('intuition','saveIntuitionConfig',{settings:config}),/settings_read_required/);
await request('intuition','getIntuitionConfig');await request('intuition','saveIntuitionConfig',{settings:{...config,questions:null,historyMessages:null}});
assert.equal(intuitionConfig.settings.questions,null);
assert.ok(cached.some(entry=>entry.queryKey?.[0]==='intuition'),'native and per-chat intuition caches are invalidated');
await open('account'); const oldEditorId = controller.getState().editor.id;
assert.equal((await request('account', 'getAccount')).login, 'fixture-user');
assert.equal(parseSettingsRequest(raw('account', 'fetch', { url: '/arbitrary' })), null);
assert.equal(parseSettingsRequest(raw('account', 'changePassword', { currentPassword: 'old', newPassword: 'short' })), null);
assert.ok(parseSettingsRequest(raw('account', 'changePassword', { currentPassword: '        ', newPassword: '        ' })), 'match native password semantics without trimming');
const password = raw('account', 'changePassword', { currentPassword: 'SECRET_CURRENT', newPassword: 'SECRET_NEW_PASSWORD' });
const success = await controller.request(password); assert.equal(success.reauthenticationRequired, true); assert.equal(loggedOut, 0, 'reauth follows the bridge reply');
assert.ok(!JSON.stringify(controller.getState()).includes('SECRET')); controller.completeRequest(password.requestId); controller.completeRequest(password.requestId); assert.equal(loggedOut, 1);
accountFailure = 'wrong_current_password'; await assert.rejects(request('account', 'changeLogin', { currentPassword: 'wrong', newLogin: 'NEW.USER' }), /wrong_current_password/);
accountFailure = 'SECRET_CURRENT'; await assert.rejects(request('account', 'changePassword', password.params), /settings_operation_failed/); assert.ok(!JSON.stringify(controller.getState()).includes('SECRET')); accountFailure = null;
await open('memory'); assert.equal((await request('memory', 'getMemoryStatus')).configured, true);
await assert.rejects(request('memory', 'listRecords', { spaceId: 1 }), /settings_entity_unavailable/);
const list = await request('memory', 'listSpaces'); assert.equal(list.spaces.length, 2); assert.equal(list.spaces.some((space: any) => space.kind === 'chat'), false);
assert.equal('user_id' in list.spaces[0], false);
await request('memory', 'createSpace', { name: 'Created' }); assert.deepEqual(changes.slice(-2), ['create', 'activate']);
await request('memory', 'renameSpace', { spaceId: 2, name: 'Renamed' }); assert.equal(spaces[1].name, 'Renamed');
const recordPage = await request('memory', 'listRecords', { spaceId: 1, query: 'literal words', limit: 50, offset: 0 }); assert.equal(calls.at(-1)[2], 'literal words'); assert.equal('private_embedding' in recordPage.records[0], false);
await request('memory', 'searchRecords', { spaceId: 1, query: 'meaning' }); assert.equal(calls.at(-1)[0], 'semantic');
const map = await request('memory', 'getMemoryMap', { spaceId: 1, limit: 100, confirmed: true }); assert.equal(map.records[0].text.length, 400); assert.equal(map.records[0].textTruncated, true);
assert.equal((await request('memory', 'getRecord', { recordId: 'record-1' })).record.text.length, 1000);
await controller.handle({ type: 'settingsAction', action: 'edit', sectionId: 'memory', editorId: controller.getState().editor.id, fieldId: 'preference', value: true });
await request('memory', 'updateRecord', { recordId: 'record-1', text: 'Changed' }); assert.equal(records[0].text, 'Changed'); assert.equal(controller.getState().editor.dirty, true, 'resource operations never implicitly save preference drafts');
assert.equal(parseSettingsRequest(raw('memory', 'deleteRecord', { recordId: 'record-1' })), null);
await request('memory', 'deleteRecord', { recordId: 'record-1', confirmed: true }); await assert.rejects(request('memory', 'getRecord', { recordId: 'record-1' }), /unavailable/);
await request('memory', 'deleteSpace', { spaceId: 2, confirmed: true }); assert.equal(spaces.some(space => space.id === 2), false);
await assert.rejects(request('memory', 'deleteSpace', { spaceId: 1, confirmed: true }), /memory_primary_space/);
await controller.handle({ type: 'settingsAction', action: 'discard', sectionId: 'memory', editorId: controller.getState().editor.id });
let release!: (value: any) => void; pendingRead = new Promise(resolve => { release = resolve; }); const obsolete = request('memory', 'listRecords', { spaceId: 1 });
await controller.handle({ type: 'settingsAction', action: 'cancelRequests', sectionId: 'memory', editorId: controller.getState().editor.id });
assert.equal(observedSignal!.aborted, true); release({ records: [], total: 0, nextOffset: null }); await assert.rejects(obsolete, /scope_changed/); pendingRead = null;
assert.equal(controller.getState().editor.dirty, false);
pendingRead = new Promise(resolve => { release = resolve; }); const switched = request('memory', 'listRecords', { spaceId: 1 });
await open('agents'); assert.equal(observedSignal!.aborted, true); release({ records: [], total: 0, nextOffset: null }); await assert.rejects(switched, /scope_changed/); pendingRead = null;
const agents = await request('agents', 'listAgents'); assert.equal(agents.agents[0].name, 'ru Search'); assert.equal('privatePrompt' in agents.agents[0], false);
await open('limits'); assert.equal((await request('limits', 'getQuota')).resets_at, 100000);
await open('app'); assert.equal((await request('app', 'getAppearanceSchema')).template.geometry.radius, 8);
await request('app', 'listThemes'); snapshot.appearance.revision++;
await assert.rejects(request('app', 'activateTheme', { id: null }), /appearance_conflict/); await request('app', 'listThemes');
await request('app', 'activateTheme', { id: null }); assert.equal(snapshot.appearance.activeId, null);
await request('app', 'prepareDraft', { id: 'created', project: true }); assert.ok(drafts.created);
const draft = (await request('app', 'readDraft', { id: 'draft-one' })).profile;
draft.name = 'Edited draft'; await request('app', 'writeDraft', { profile: draft }); assert.equal(drafts['draft-one'].name, 'Edited draft');
buildFailed = true; const diagnostics = await request('app', 'checkTheme', { profile: draft }); assert.equal(diagnostics.valid, false); assert.equal(diagnostics.diagnostics[0].file, 'App.tsx'); buildFailed = false;
await request('app', 'previewDraft', { id: 'draft-one' }); assert.equal(changes.at(-1)[0], 'preview'); await request('app', 'cancelPreview'); assert.equal(changes.at(-1)[1], null);
await request('app', 'storeThemeImage', { base64: 'aGVsbG8=' }); await request('app', 'exportTheme', { id: 'one' }); assert.equal(calls.at(-1)[0], 'saveFile');
await request('app', 'importTheme', { format: 'json', content: JSON.stringify(schema.newAppearance('import-json')) });
assert.equal((await request('app', 'importTheme', { format: 'zip', content: 'aGVsbG8=' })).profile.id, 'imported');
const saved = (await request('app', 'getTheme', { id: 'one' })).profile; saved.name = 'Saved edit';
assert.equal((await request('app', 'saveTheme', { profile: saved, apply: false })).saved, true);
await assert.rejects(request('app', 'saveTheme', { profile: saved }), /appearance_conflict/);
await request('app', 'rollbackTheme', { id: 'one' }); assert.equal(calls.at(-1)[1].action, 'rollback');
assert.equal((await request('app', 'chooseThemesDirectory')).workspace.directory, '/fixture');
await request('app', 'retryThemeMigration'); await request('app', 'openThemeFiles', { id: 'draft-one' });
await request('app', 'deleteTheme', { id: 'one', confirmed: true }); assert.equal(snapshot.appearance.profiles.length, 0);
assert.equal(parseSettingsRequest(raw('app', 'openThemeFiles', { id: '../../secret' })), null);
await assert.rejects(request('app', 'openThemeFiles', { id: 'missing' }), /appearance_not_found/);
assert.ok(cached.some(entry => entry.queryKey?.[0] === 'memory')); assert.ok(cached.some(entry => Array.isArray(entry) && entry[0][0] === 'appearance'));
assert.equal(canRequestSettings(controller.getState(), { ...raw('app', 'listThemes'), editorId: oldEditorId }), false);
for (const adapter of Object.values(adapters) as any[]) for (const operation of adapter.requests()) assert.notEqual(operation.label, operation.id);
active = false; await assert.rejects(request('app', 'listThemes'), /scope_changed/); controller.dispose();
console.log('PASS: request allowlists, private credential submissions/error redaction and reauth completion; memory spaces/records/search/map/cancellation/cache; catalogs/quotas; appearance drafts/schema/validation/preview/export/revisions and scope rejection');
