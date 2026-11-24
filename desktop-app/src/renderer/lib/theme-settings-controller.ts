import { canUseThemeSettings, type SettingValue, type ThemeSettingsAction, type ThemeSettingsState, type ThemeSettingField } from '../../main/settings-shell-types';

type Values = Record<string, SettingValue>;
export type ThemeSettingsSectionAdapter = {
  fields: (draft: Values, saved: Values) => ThemeSettingField[];
  groups: () => { id: string; label: string }[];
  links: () => NonNullable<ThemeSettingsState['editor']>['links'];
  read: () => Promise<Values>;
  write: (id: string, value: SettingValue, current: () => boolean) => Promise<SettingValue>;
};
type Options = {
  catalog: Pick<ThemeSettingsState, 'groups' | 'sections'>;
  sections: Record<string, ThemeSettingsSectionAdapter>;
  search: (query: string) => ThemeSettingsState['results'];
  error: (code: 'invalid' | 'conflict' | 'save' | 'load') => string;
};

/** Draft lifecycle is independent of markup. Only explicit save reaches the shared native writers. */
export class ThemeSettingsController {
  private state: ThemeSettingsState;
  private saved: Values = {};
  private draft: Values = {};
  private generation = 0;
  private disposed = false;
  private listeners = new Set<() => void>();
  constructor(private options: Options) {
    this.state = { ...options.catalog, query: '', results: [], hasMoreResults: false, editor: null };
  }
  getState = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  dispose() { this.disposed = true; this.generation++; this.listeners.clear(); }
  activate() { this.disposed = false; }
  configure(catalog: Options['catalog']) {
    this.options = { ...this.options, catalog };
    const results = this.state.query ? this.options.search(this.state.query) : [];
    this.publish({ ...this.state, ...catalog, results: results.slice(0, 50), hasMoreResults: results.length > 50,
      editor: this.state.editor ? this.editor({}) : null });
  }
  private publish(state: ThemeSettingsState) { if (!this.disposed) { this.state = state; this.listeners.forEach(listener => listener()); } }
  private editor(patch: Partial<NonNullable<ThemeSettingsState['editor']>>) {
    const adapter = this.options.sections[this.state.editor!.sectionId];
    const fields = adapter.fields(this.draft, this.saved);
    return { ...this.state.editor!, ...patch, fields, dirty: fields.some(field => field.dirty), groups: adapter.groups(), links: adapter.links() };
  }
  private update(patch: Partial<NonNullable<ThemeSettingsState['editor']>>) {
    this.publish({ ...this.state, editor: this.editor(patch) });
  }
  async handle(action: ThemeSettingsAction): Promise<boolean> {
    if (this.disposed || !canUseThemeSettings(this.state, action)) return false;
    if (action.action === 'search') {
      const results = this.options.search(action.query);
      this.publish({ ...this.state, query: action.query, results: results.slice(0, 50), hasMoreResults: results.length > 50 }); return true;
    }
    if (action.action === 'open') {
      if (!this.options.sections[action.sectionId]) return false;
      if (this.state.editor?.sectionId === action.sectionId) return true;
      return this.load(action.sectionId);
    }
    if (action.action === 'reload') return this.load(action.sectionId);
    if (action.action === 'discard') { this.draft = { ...this.saved }; this.update({ error: null }); return true; }
    if (action.action === 'edit') {
      this.draft = { ...this.draft, [action.fieldId]: action.value }; this.update({ error: null }); return true;
    }
    return this.save();
  }
  private async load(sectionId: string) {
    const adapter = this.options.sections[sectionId];
    if (!adapter) return false;
    const generation = ++this.generation;
    this.saved = {}; this.draft = {};
    this.publish({ ...this.state, editor: { id: crypto.randomUUID(), sectionId, loading: true, busy: false, dirty: false,
      error: null, fields: [], groups: adapter.groups(), links: adapter.links() } });
    try {
      const values = await adapter.read();
      if (this.disposed || generation !== this.generation) return false;
      this.saved = { ...values }; this.draft = { ...values }; this.update({ loading: false, error: null }); return true;
    } catch {
      if (!this.disposed && generation === this.generation) this.update({ loading: false, error: this.options.error('load') });
      return false;
    }
  }
  private async save() {
    const editor = this.state.editor!;
    const adapter = this.options.sections[editor.sectionId];
    if (editor.fields.some(field => field.error)) { this.update({ error: this.options.error('invalid') }); return false; }
    const generation = ++this.generation;
    const current = () => !this.disposed && generation === this.generation;
    const changes = editor.fields.filter(field => field.dirty);
    this.update({ busy: true, error: null });
    try {
      const latest = await adapter.read();
      if (!current()) return false;
      if (changes.some(field => latest[field.id] !== this.saved[field.id] && latest[field.id] !== this.draft[field.id])) {
        this.update({ error: this.options.error('conflict') }); return false;
      }
      for (const field of editor.fields.filter(field => !field.dirty)) this.saved[field.id] = this.draft[field.id] = latest[field.id];
      for (const field of changes) {
        if (!current()) return false;
        const value = latest[field.id] === this.draft[field.id] ? latest[field.id]
          : await adapter.write(field.id, this.draft[field.id], current);
        if (!current()) return false;
        this.saved[field.id] = this.draft[field.id] = value;
        this.update({});
      }
      return true;
    } catch { if (current()) this.update({ error: this.options.error('save') }); return false; }
    finally { if (current()) this.update({ busy: false }); }
  }
}
