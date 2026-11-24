import type { ThemeSettingsState } from './settings-shell-types';

export type SettingsOperation = { id: string; label: string; mutation: boolean; requiresGesture: boolean; requiresConfirmation: boolean };
export type ThemeSettingsRequest = { requestId: string; method: 'settings'; sectionId: string; editorId: string; operation: string; params: Record<string, unknown> };
// One allowlist is shared by IPC validation and the trusted section handlers.
export const SETTINGS_REQUESTS: Record<string, Record<string, { key: string; mutation?: boolean; gesture?: boolean; confirm?: boolean }>> = {
  account: { getAccount: { key: 'settings.sections.account' }, changePassword: { key: 'settings.account.changePassword', mutation: true }, changeLogin: { key: 'settings.account.changeLogin', mutation: true } },
  memory: {
    getMemoryStatus: { key: 'memorySetupNotice.title' },
    listSpaces: { key: 'chat.memory.globalSettings.spaceLabel' }, createSpace: { key: 'chat.memory.globalSettings.createSpaceAction', mutation: true },
    activateSpace: { key: 'chat.memory.globalSettings.spaceLabel', mutation: true }, renameSpace: { key: 'common.edit', mutation: true }, deleteSpace: { key: 'common.delete', mutation: true, confirm: true },
    listRecords: { key: 'memoryMap.list' }, getRecord: { key: 'common.edit' }, searchRecords: { key: 'chat.memory.search.placeholder', gesture: true }, getMemoryMap: { key: 'memoryMap.build', gesture: true, confirm: true },
    updateRecord: { key: 'common.edit', mutation: true }, deleteRecord: { key: 'common.delete', mutation: true, confirm: true },
  },
  agents: { listAgents: { key: 'settings.agents.specialists' } },
  limits: { getQuota: { key: 'quota.title' } },
  app: {
    listThemes: { key: 'appearance.title' }, getTheme: { key: 'appearance.title' }, getAppearanceSchema: { key: 'appearance.title' },
    saveTheme: { key: 'common.save', mutation: true }, activateTheme: { key: 'appearance.apply', mutation: true },
    deleteTheme: { key: 'common.delete', mutation: true, confirm: true }, rollbackTheme: { key: 'appearance.previousVersion', mutation: true },
    prepareDraft: { key: 'appearance.createProject', mutation: true }, readDraft: { key: 'appearance.localDrafts' }, writeDraft: { key: 'common.save', mutation: true },
    previewDraft: { key: 'appearance.preview', mutation: true }, cancelPreview: { key: 'common.cancel', mutation: true },
    checkTheme: { key: 'appearance.preview', gesture: true }, openThemeFiles: { key: 'appearance.openFiles', gesture: true },
    chooseThemesDirectory: { key: 'appearance.chooseDirectory', mutation: true }, retryThemeMigration: { key: 'appearance.retryMigration', mutation: true },
    importTheme: { key: 'appearance.import', mutation: true }, exportTheme: { key: 'appearance.export', gesture: true }, storeThemeImage: { key: 'appearance.upload', mutation: true },
  },
};
export function settingsOperations(section: string, t: (key: string) => string): SettingsOperation[] {
  return Object.entries(SETTINGS_REQUESTS[section] ?? {}).map(([id, definition]) => ({ id, label: t(definition.key), mutation: definition.mutation === true,
    requiresGesture: definition.mutation === true || definition.gesture === true, requiresConfirmation: definition.confirm === true }));
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown, max: number, blank = false) => typeof value === 'string' && value.length <= max && (blank || value.trim().length > 0);
const password = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max;
const positive = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const themeId = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
export function parseSettingsRequest(value: unknown): ThemeSettingsRequest | null {
  if (!object(value) || value.method !== 'settings' || !text(value.requestId, 100) || !themeId(value.editorId)
      || typeof value.sectionId !== 'string' || typeof value.operation !== 'string') return null;
  const definition = SETTINGS_REQUESTS[value.sectionId]?.[value.operation];
  if (!definition || !object(value.params)) return null;
  const p = value.params, op = value.operation;
  // Serialize once to reject cycles, unsupported objects and oversized input before any operation.
  try { if (JSON.stringify(p).length > (op === 'importTheme' || op === 'storeThemeImage' ? 17 * 1024 * 1024 : 2 * 1024 * 1024)) return null; } catch { return null; }
  let valid = false;
  if (op === 'changePassword') valid = password(p.currentPassword, 4096) && password(p.newPassword, 128) && (p.newPassword as string).length >= 8;
  else if (op === 'changeLogin') valid = password(p.currentPassword, 4096) && typeof p.newLogin === 'string' && /^[-_.a-z0-9]{3,64}$/i.test(p.newLogin.trim());
  else if (op === 'createSpace') valid = text(p.name, 100);
  else if (['activateSpace', 'renameSpace', 'deleteSpace'].includes(op)) valid = positive(p.spaceId) && (op !== 'renameSpace' || text(p.name, 100));
  else if (op === 'listRecords') valid = positive(p.spaceId) && (p.query === undefined || text(p.query, 300, true))
    && (p.limit === undefined || positive(p.limit) && Number(p.limit) <= 500) && (p.offset === undefined || Number.isSafeInteger(p.offset) && Number(p.offset) >= 0);
  else if (op === 'searchRecords') valid = positive(p.spaceId) && text(p.query, 300);
  else if (op === 'getMemoryMap') valid = positive(p.spaceId) && [100, 500, 1000, 2000, 5000].includes(Number(p.limit));
  else if (op === 'getRecord' || op === 'updateRecord' || op === 'deleteRecord') valid = text(p.recordId, 200) && (op !== 'updateRecord' || text(p.text, 4000)) && (p.source === undefined || text(p.source, 1000, true));
  else if (['getTheme', 'deleteTheme', 'rollbackTheme', 'readDraft', 'previewDraft', 'exportTheme'].includes(op)) valid = themeId(p.id);
  else if (op === 'prepareDraft') valid = themeId(p.id) && (p.project === undefined || typeof p.project === 'boolean');
  else if (op === 'openThemeFiles') valid = p.id === undefined || themeId(p.id);
  else if (op === 'activateTheme') valid = p.id === null || themeId(p.id);
  else if (op === 'saveTheme' || op === 'writeDraft' || op === 'checkTheme') valid = object(p.profile) && (p.apply === undefined || typeof p.apply === 'boolean');
  else if (op === 'importTheme') valid = ['json', 'zip'].includes(String(p.format)) && text(p.content, p.format === 'json' ? 2 * 1024 * 1024 : 17 * 1024 * 1024);
  else if (op === 'storeThemeImage') valid = text(p.base64, 12 * 1024 * 1024);
  else valid = ['getAccount', 'getMemoryStatus', 'listSpaces', 'listAgents', 'getQuota', 'listThemes', 'getAppearanceSchema', 'cancelPreview', 'chooseThemesDirectory', 'retryThemeMigration'].includes(op);
  if (!valid || definition.confirm && p.confirmed !== true) return null;
  // Credentials/params remain request-local; never copy them into settings state or diagnostic text.
  return { method: 'settings', requestId: value.requestId as string, sectionId: value.sectionId, editorId: value.editorId as string, operation: op, params: p };
}
export function settingsRequestScope(state: ThemeSettingsState | undefined, request: ThemeSettingsRequest): boolean {
  return Boolean(state?.editor && state.editor.id === request.editorId && state.editor.sectionId === request.sectionId
    && state.sections.some(section => section.id === request.sectionId && section.mode !== 'native'));
}
export function canRequestSettings(state: ThemeSettingsState | undefined, request: ThemeSettingsRequest): boolean {
  return settingsRequestScope(state, request) && !state!.editor!.loading && !state!.editor!.busy
    && Boolean(state!.editor!.requests?.some(operation => operation.id === request.operation));
}
