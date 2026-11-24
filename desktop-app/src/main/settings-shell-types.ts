export type SettingValue = string | number | boolean;
export type ThemeSettingField = { id: string; groupId: string; label: string; help: string; type: 'select' | 'toggle' | 'number' | 'time';
  value: SettingValue; savedValue: SettingValue; dirty: boolean; error: string | null; visible: boolean;
  options?: { value: string; label: string }[]; min?: number; max?: number; step?: number };
export type ThemeSettingsSection = { id: string; groupId: string; label: string; mode: 'native' | 'hybrid' | 'fields' };
export type ThemeSettingsSearchResult = { sectionId: string; key: string; title: string; sectionTitle: string; fieldId: string | null; native: boolean };
export type ThemeSettingsState = {
  groups: { id: string; label: string }[]; sections: ThemeSettingsSection[];
  query: string; results: ThemeSettingsSearchResult[]; hasMoreResults: boolean;
  editor: { id: string; sectionId: string; loading: boolean; busy: boolean; dirty: boolean; error: string | null;
    fields: ThemeSettingField[]; groups: { id: string; label: string }[];
    links: { id: string; label: string; sectionId: string; target: string }[] } | null;
};
export type ThemeSettingsAction = { type: 'settingsAction'; action: 'search'; query: string }
  | { type: 'settingsAction'; action: 'open'; sectionId: string }
  | { type: 'settingsAction'; action: 'edit'; sectionId: string; editorId: string; fieldId: string; value: SettingValue }
  | { type: 'settingsAction'; action: 'save' | 'discard' | 'reload'; sectionId: string; editorId: string };
export type NativeSettingsAction = { type: 'openSettings'; sectionId?: string; target?: string };

const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
export function parseThemeSettingsAction(input: Record<string, unknown>): ThemeSettingsAction | null {
  if (input.action === 'search' && typeof input.query === 'string' && input.query.length <= 200)
    return { type: 'settingsAction', action: 'search', query: input.query };
  if (!id(input.sectionId)) return null;
  if (input.action === 'open') return { type: 'settingsAction', action: 'open', sectionId: input.sectionId };
  if (!id(input.editorId)) return null;
  const base = { type: 'settingsAction' as const, sectionId: input.sectionId, editorId: input.editorId };
  if (input.action === 'edit' && id(input.fieldId) && (typeof input.value === 'boolean'
      || typeof input.value === 'number' && Number.isFinite(input.value)
      || typeof input.value === 'string' && input.value.length <= 500))
    return { ...base, action: 'edit', fieldId: input.fieldId, value: input.value as SettingValue };
  if (input.action === 'save' || input.action === 'discard' || input.action === 'reload') return { ...base, action: input.action };
  return null;
}
export function canUseThemeSettings(state: ThemeSettingsState | undefined, action: ThemeSettingsAction): boolean {
  if (!state) return false;
  if (action.action === 'search') return true;
  if (!state.sections.some(section => section.id === action.sectionId && section.mode !== 'native')) return false;
  const editor = state.editor;
  if (action.action === 'open') return !editor?.busy && (!editor?.dirty || editor.sectionId === action.sectionId);
  if (!editor || editor.id !== action.editorId || editor.sectionId !== action.sectionId || editor.loading || editor.busy) return false;
  if (action.action === 'edit') return editor.fields.some(field => field.id === action.fieldId);
  if (action.action === 'save') return editor.dirty && !editor.fields.some(field => field.error);
  if (action.action === 'reload') return !editor.dirty;
  return true;
}
