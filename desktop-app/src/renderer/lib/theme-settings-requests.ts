import type { QueryClient } from '@tanstack/react-query';
import { settingsOperations } from '../../main/settings-request-types';
import type { ThemeSettingsSectionAdapter } from './theme-settings-controller';
import type { SettingsTranslate } from './settings-fields';
import * as api from './api';
import * as memory from './memory-settings-service';
import { computeMemoryProjection, memoryPageUrl } from './memory-queries';
import type { MemoryRecord } from '../components/MemoryRecordsPanel';
import { APPEARANCE_CAPABILITIES, parseAppearanceProfile, newAppearance } from './appearance-schema';
import { fetchAppearance, localAppearance, updateAppearance, readLocalDraft } from './appearance-service';
import { previewAppearance } from './appearance-runtime';
import { validateAppearanceCode } from './appearance-validation';
import type { LocalAppearanceSnapshot } from '../../main/local-appearance';

type Context = { client: QueryClient; base: string; userId: number | undefined; current: () => boolean; t: SettingsTranslate;
  locale: () => string; reauthenticate: () => void; legacyAppearance?: () => unknown };
type RequestAdapter = Pick<ThemeSettingsSectionAdapter, 'requests' | 'request'>;
export function createThemeSettingsRequests(context: Context): Record<string, RequestAdapter> {
  const { client, base, userId, current, t } = context;
  const knownSpaces = new Map<number, memory.MemorySpace>(), knownRecords = new Map<string, MemoryRecord>();
  let observedThemeRevision: number | null = null;
  const publicSpace = ({ id, name, kind, is_default, is_primary }: memory.MemorySpace) => ({ id, name, kind, is_default, is_primary });
  const publicRecord = ({ id, memory_space_id, text, source, updated_at }: MemoryRecord) => ({ id, memory_space_id, text, source, updated_at });
  const remember = (records: MemoryRecord[]) => { for (const record of records) {
    knownRecords.delete(record.id); knownRecords.set(record.id, publicRecord(record));
    if (knownRecords.size > 5000) knownRecords.delete(knownRecords.keys().next().value!);
  } };
  const invalidateMemory = () => client.invalidateQueries({ queryKey: ['memory', base, userId] });
  const section = (id: string, handler: NonNullable<RequestAdapter['request']>): RequestAdapter => ({ requests: () => settingsOperations(id, t), request: handler });
  const safe = (operationCurrent: () => boolean) => () => { if (!current() || !operationCurrent() || userId == null) throw new Error('settings_scope_changed'); };
  const themes = async (guard: () => void) => { guard(); const result = await fetchAppearance(undefined, false); guard(); return result; };
  const summarizeThemes = (data: LocalAppearanceSnapshot) => ({ revision: data.appearance.revision, activeId: data.appearance.activeId,
    profiles: data.appearance.profiles.map(({ id, name, revision }) => ({ id, name, revision })), workspace: data.workspace });
  const decode = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0));
  return {
    account: section('account', async (operation, params, operationCurrent) => {
      const guard = safe(operationCurrent); guard();
      if (operation === 'getAccount') { const account = await api.fetchMe(); guard(); if (account.id !== userId) throw new Error('settings_scope_changed');
        const identity = account.identities?.find(item => item.provider === 'password');
        return { result: { name: account.name ?? null, username: account.username ?? null, login: identity?.username ?? identity?.provider_subject ?? null,
          plan: account.plan, role: account.role, canChangeCredentials: account.identities ? Boolean(identity) : true, timezoneOffset: account.timezone_offset ?? null,
          timezoneConfirmed: account.timezone_confirmed === true, passwordRules: { minLength: 8, maxLength: 128 }, loginRules: { minLength: 3, maxLength: 64, pattern: '^[-_.a-z0-9]+$', caseInsensitive: true } } }; }
      // Never publish credentials, their field values or server diagnostics into settings state.
      if (operation !== 'changePassword' && operation !== 'changeLogin') throw new Error('settings_bad_request');
      const result = operation === 'changePassword'
        ? await api.changeAccountPassword(String(params.currentPassword), String(params.newPassword))
        : await api.changeAccountLogin(String(params.currentPassword), String(params.newLogin));
      return { result: { ...result, reauthenticationRequired: true }, afterReply: context.reauthenticate };
    }),
    agents: section('agents', async (_operation, _params, operationCurrent) => {
      const guard = safe(operationCurrent); guard(); const locale = context.locale();
      const result = await client.fetchQuery({ queryKey: ['subagent-catalog', base, userId, locale],
        queryFn: () => { guard(); return api.getSubagentCatalog(locale); }, staleTime: 0 }); guard();
      return { result: { agents: result.agents.map(({ id, name, description, icon }) => ({ id, name, description, icon })) } };
    }),
    limits: section('limits', async (_operation, _params, operationCurrent, signal) => {
      const guard = safe(operationCurrent); guard(); const quota = await api.fetchQuota(signal); guard(); return { result: quota };
    }),
    memory: section('memory', async (operation, params, operationCurrent, signal) => {
      const guard = safe(operationCurrent); guard();
      const loadSpaces = async () => { guard(); const result = await memory.listMemorySpaces(signal); guard(); knownSpaces.clear();
        result.spaces.filter(space => space.kind === 'general').forEach(space => knownSpaces.set(space.id, publicSpace(space)));
        return { spaces: [...knownSpaces.values()] }; };
      const spaceId = Number(params.spaceId);
      if (operation === 'getMemoryStatus') { const status = await api.apiFetch<{ configured: boolean }>('/api/v1/memory/status', { signal }); guard(); return { result: { configured: status.configured } }; }
      if (operation === 'listSpaces') return { result: await loadSpaces() };
      if (operation === 'createSpace') {
        const result = await memory.createMemorySpace(String(params.name).trim()); guard();
        await memory.activateMemorySpace(result.space.id); guard(); await invalidateMemory(); guard();
        const refreshed = await loadSpaces(), created = knownSpaces.get(result.space.id);
        if (!created) throw new Error('settings_entity_unavailable'); return { result: { ...refreshed, space: created } };
      }
      if (['activateSpace', 'renameSpace', 'deleteSpace', 'listRecords', 'searchRecords', 'getMemoryMap'].includes(operation) && !knownSpaces.has(spaceId)) throw new Error('settings_entity_unavailable');
      if (operation === 'listRecords') {
        const result = await memory.listGeneralMemoryRecords(spaceId, String(params.query ?? ''), Number(params.limit ?? 50), Number(params.offset ?? 0), signal); guard();
        remember(result.records); return { result: { records: result.records.map(publicRecord), total: result.total, nextOffset: result.nextOffset } };
      }
      if (operation === 'searchRecords') { const result = await memory.searchGeneralMemoryRecords(spaceId, String(params.query).trim(), signal); guard(); remember(result.records);
        return { result: { records: result.records.map(publicRecord), groups: result.groups?.map(({ record_id }) => ({ record_id })) } }; }
      if (operation === 'getMemoryMap') {
        const data = await memory.loadMemoryMapData(memoryPageUrl('/api/v1/memory/records', { space_id: spaceId }), Number(params.limit), signal); guard();
        const projection = await computeMemoryProjection(data.vectors, signal); guard(); remember(data.records);
        return { result: { ...projection, total: data.total, records: data.records.map(record => ({ ...publicRecord(record), text: record.text.slice(0, 400), textTruncated: record.text.length > 400 })) } };
      }
      if (operation === 'getRecord') { const record = knownRecords.get(String(params.recordId)); if (!record) throw new Error('settings_entity_unavailable'); return { result: { record } }; }
      let result: unknown;
      if (operation === 'activateSpace') result = { space: publicSpace((await memory.activateMemorySpace(spaceId)).space) };
      else if (operation === 'renameSpace') result = { space: publicSpace((await memory.renameMemorySpace(spaceId, String(params.name).trim())).space) };
      else if (operation === 'deleteSpace') {
        result = { active_space: publicSpace((await memory.deleteMemorySpace(spaceId)).active_space) };
        if (current() && operationCurrent()) for (const [id, record] of knownRecords) if (record.memory_space_id === spaceId) knownRecords.delete(id);
      } else {
        const id = String(params.recordId), record = knownRecords.get(id); if (!record) throw new Error('settings_entity_unavailable');
        if (operation === 'updateRecord') { const updated = await memory.updateMemoryRecord(id, String(params.text).trim(), params.source as string | undefined); guard(); remember([updated.record]); result = { record: publicRecord(updated.record) }; }
        else if (operation === 'deleteRecord') { await memory.deleteMemoryRecord(id); guard(); knownRecords.delete(id); result = {}; }
        else throw new Error('settings_bad_request');
      }
      guard(); await invalidateMemory(); guard();
      return { result: { ...await loadSpaces(), ...(result as object) } };
    }),
    app: section('app', async (operation, params, operationCurrent) => {
      const guard = safe(operationCurrent); guard();
      if (operation === 'getAppearanceSchema') return { result: { capabilities: APPEARANCE_CAPABILITIES, template: newAppearance() } };
      if (operation === 'cancelPreview') return { result: { canceled: true }, afterReply: () => { if (current()) previewAppearance(null); } };
      if (operation === 'chooseThemesDirectory') { await localAppearance('choose-directory'); guard(); observedThemeRevision = null;
        const snapshot = await themes(guard);
        return { result: summarizeThemes(snapshot), afterReply: () => { if (current()) client.setQueryData(['appearance'], snapshot); } }; }
      if (operation === 'storeThemeImage') { const result = await localAppearance('image', { base64: params.base64 }); guard(); return { result }; }
      if (operation === 'checkTheme' || operation === 'writeDraft' || operation === 'saveTheme') {
        const profile = parseAppearanceProfile(params.profile);
        if (operation === 'checkTheme') {
          try { await validateAppearanceCode(profile); } catch (error: any) {
            guard(); return { result: { valid: false, error: 'appearance_build_failed', diagnostics: Array.isArray(error.diagnostics) ? error.diagnostics.slice(0, 200) : [] } };
          }
        } guard();
        if (operation === 'checkTheme') return { result: { valid: true, id: profile.id, diagnostics: [] } };
        if (operation === 'writeDraft') { await localAppearance('write-draft', { profile }); guard(); return { result: { written: true, id: profile.id },
          afterReply: () => { if (current()) void client.invalidateQueries({ queryKey: ['appearance'] }); } }; }
        const snapshot = await updateAppearance({ action: 'save', profile, apply: params.apply === true });
        if (current() && operationCurrent()) observedThemeRevision = snapshot.appearance.revision;
        return { result: { saved: true, id: profile.id, activeId: snapshot.appearance.activeId }, afterReply: () => { if (current()) client.setQueryData(['appearance'], snapshot); } };
      }
      if (operation === 'importTheme') {
        const profile = params.format === 'zip' ? parseAppearanceProfile(await localAppearance('import-bundle', { data: decode(String(params.content)) }))
          : { ...parseAppearanceProfile(JSON.parse(String(params.content).replace(/^\uFEFF/, ''))), id: crypto.randomUUID(), revision: 0 };
        guard(); await localAppearance('write-draft', { profile }); guard(); return { result: { profile }, afterReply: () => { if (current()) void client.invalidateQueries({ queryKey: ['appearance'] }); } };
      }
      const snapshot = await themes(guard), id = params.id as string;
      const profile = snapshot.appearance.profiles.find(theme => theme.id === id);
      const draftExists = snapshot.workspace.drafts.some(draft => draft.id === id);
      if (operation === 'listThemes' || operation === 'retryThemeMigration') {
        const data = operation === 'retryThemeMigration' ? await fetchAppearance(context.legacyAppearance?.()) : snapshot; guard();
        observedThemeRevision = data.appearance.revision;
        return { result: summarizeThemes(data),
          afterReply: operation === 'retryThemeMigration' ? () => { if (current()) client.setQueryData(['appearance'], data); } : undefined };
      }
      if (operation === 'getTheme') { if (!profile) throw new Error('appearance_not_found'); observedThemeRevision = snapshot.appearance.revision; return { result: { profile } }; }
      if (operation === 'prepareDraft') { await localAppearance('prepare', { id, project: params.project === true }); guard(); return { result: { prepared: true, id },
        afterReply: () => { if (current()) void client.invalidateQueries({ queryKey: ['appearance'] }); } }; }
      if (operation === 'openThemeFiles') {
        if (id && !draftExists) throw new Error('appearance_not_found');
        await localAppearance('open', id ? { id } : {}); guard(); return { result: { opened: true } };
      }
      if (operation === 'readDraft' || operation === 'previewDraft') {
        if (!draftExists) throw new Error('appearance_not_found');
        const draft = operation === 'previewDraft' ? await readLocalDraft(id) : parseAppearanceProfile(await localAppearance('read-draft', { id })); guard();
        return { result: { profile: draft }, afterReply: operation === 'previewDraft' ? () => { if (current()) previewAppearance(draft, id); } : undefined };
      }
      if (operation === 'exportTheme') {
        if (!profile) throw new Error('appearance_not_found');
        const bytes = await localAppearance('export-bundle', { id }); guard();
        const result = await window.electronAPI.saveFile(id + '.zip', new Uint8Array(bytes).buffer); guard();
        return { result: { canceled: result.canceled } };
      }
      if (operation !== 'activateTheme' && !profile) throw new Error('appearance_not_found');
      if (operation === 'activateTheme' && id !== null && !profile) throw new Error('appearance_not_found');
      const action = operation === 'activateTheme' ? 'activate' : operation === 'deleteTheme' ? 'delete' : operation === 'rollbackTheme' ? 'rollback' : null;
      if (!action) throw new Error('settings_bad_request');
      if (observedThemeRevision === null) throw new Error('settings_read_required');
      const changed = await updateAppearance({ action, id, revision: observedThemeRevision });
      if (current() && operationCurrent()) observedThemeRevision = changed.appearance.revision;
      return { result: { completed: true, activeId: changed.appearance.activeId }, afterReply: () => { if (current()) client.setQueryData(['appearance'], changed); } };
    }),
  };
}
