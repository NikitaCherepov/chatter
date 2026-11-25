import {
  canUseThemeSettings,
  type SettingValue,
  type ThemeSettingsAction,
  type ThemeSettingsState,
  type ThemeSettingField,
  type ThemeSettingCommand,
} from '../../main/settings-shell-types';
import {
  canRequestSettings,
  parseSettingsRequest,
  SETTINGS_REQUESTS,
  type SettingsOperation,
  type ThemeSettingsRequest,
} from '../../main/settings-request-types';

type Values = Record<string, SettingValue>;
export type ThemeSettingsSectionAdapter = {
  fields: (draft: Values, saved: Values) => ThemeSettingField[];
  groups: () => { id: string; label: string }[];
  links: () => NonNullable<ThemeSettingsState['editor']>['links'];
  read: () => Promise<Values>;
  edit?: (draft: Values, id: string, value: SettingValue) => Values;
  write: (
    id: string,
    value: SettingValue,
    current: () => boolean,
    draft: Readonly<Values>,
  ) => Promise<SettingValue>;
  refreshAfterSave?: boolean;
  actions?: (draft: Values, saved: Values, running: string | null) => ThemeSettingCommand[];
  run?: (id: string, draft: Readonly<Values>, signal: AbortSignal) => Promise<void>;
  requests?: () => SettingsOperation[];
  request?: (
    operation: string,
    params: Record<string, unknown>,
    current: () => boolean,
    signal: AbortSignal,
  ) => Promise<{ result: unknown; afterReply?: () => void }>;
};
type Options = {
  catalog: Pick<ThemeSettingsState, 'groups' | 'sections'>;
  sections: Record<string, ThemeSettingsSectionAdapter>;
  search: (query: string) => ThemeSettingsState['results'];
  error: (code: 'invalid' | 'conflict' | 'save' | 'load' | 'action') => string;
};

/** Draft lifecycle is independent of markup. Only explicit save reaches the shared native writers. */
class SettingsEditorController {
  private state: ThemeSettingsState;
  private saved: Values = {};
  private draft: Values = {};
  private generation = 0;
  private disposed = false;
  private operation: { id: string; abort: AbortController } | null = null;
  private completions = new Map<string, () => void>();
  private requests = new Map<string, AbortController>();
  private listeners = new Set<() => void>();
  constructor(private options: Options) {
    this.state = {
      ...options.catalog,
      query: '',
      results: [],
      hasMoreResults: false,
      editor: null,
    };
  }
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  dispose() {
    this.disposed = true;
    this.generation++;
    this.cancelRequests();
    this.cancelOperation();
    this.listeners.clear();
    const completions = [...this.completions.values()];
    this.completions.clear();
    completions.forEach((complete) => complete());
  }
  activate() {
    this.disposed = false;
  }
  configure(catalog: Options['catalog']) {
    this.options = { ...this.options, catalog };
    const results = this.state.query ? this.options.search(this.state.query) : [];
    this.publish({
      ...this.state,
      ...catalog,
      results: results.slice(0, 50),
      hasMoreResults: results.length > 50,
      editor: this.state.editor ? this.editor({}) : null,
    });
  }
  private publish(state: ThemeSettingsState) {
    if (!this.disposed) {
      this.state = state;
      this.listeners.forEach((listener) => listener());
    }
  }
  private editor(patch: Partial<NonNullable<ThemeSettingsState['editor']>>) {
    const adapter = this.options.sections[this.state.editor!.sectionId];
    const fields = adapter.fields(this.draft, this.saved);
    return {
      ...this.state.editor!,
      ...patch,
      fields,
      dirty: fields.some((field) => field.dirty),
      groups: adapter.groups(),
      links: adapter.links(),
      actions: adapter.actions?.(this.draft, this.saved, this.operation?.id ?? null) ?? [],
      requests: adapter.requests?.() ?? [],
    };
  }
  private update(patch: Partial<NonNullable<ThemeSettingsState['editor']>>) {
    this.publish({ ...this.state, editor: this.editor(patch) });
  }
  async handle(action: ThemeSettingsAction): Promise<boolean> {
    if (action.action === 'openSession') action = { ...action, action: 'open' };
    if (this.disposed || !canUseThemeSettings(this.state, action)) return false;
    if (action.action === 'search') {
      const results = this.options.search(action.query);
      this.publish({
        ...this.state,
        query: action.query,
        results: results.slice(0, 50),
        hasMoreResults: results.length > 50,
      });
      return true;
    }
    if (action.action === 'open') {
      if (!this.options.sections[action.sectionId]) return false;
      if (this.state.editor?.sectionId === action.sectionId) return true;
      return this.load(action.sectionId);
    }
    if (action.action === 'run') return this.run(action.actionId);
    if (action.action === 'cancelRequests') {
      this.cancelRequests();
      this.generation++;
      this.update({ error: null });
      return true;
    }
    this.cancelOperation();
    if (action.action === 'reload') return this.load(action.sectionId);
    if (action.action === 'discard') {
      this.draft = { ...this.saved };
      this.update({ error: null });
      return true;
    }
    if (action.action === 'edit') {
      const adapter = this.options.sections[action.sectionId];
      this.draft = adapter.edit
        ? adapter.edit({ ...this.draft }, action.fieldId, action.value)
        : { ...this.draft, [action.fieldId]: action.value };
      this.update({ error: null });
      return true;
    }
    return this.save();
  }
  private async load(sectionId: string) {
    const adapter = this.options.sections[sectionId];
    if (!adapter) return false;
    this.cancelOperation();
    const generation = ++this.generation;
    this.cancelRequests();
    this.saved = {};
    this.draft = {};
    this.publish({
      ...this.state,
      editor: {
        id: crypto.randomUUID(),
        sectionId,
        loading: true,
        busy: false,
        dirty: false,
        error: null,
        fields: [],
        groups: adapter.groups(),
        links: adapter.links(),
        actions: [],
        requests: [],
      },
    });
    try {
      const values = await adapter.read();
      if (this.disposed || generation !== this.generation) return false;
      this.saved = { ...values };
      this.draft = { ...values };
      this.update({ loading: false, error: null });
      return true;
    } catch {
      if (!this.disposed && generation === this.generation)
        this.update({ loading: false, error: this.options.error('load') });
      return false;
    }
  }
  completeRequest = (requestId: string) => {
    const complete = this.completions.get(requestId);
    this.completions.delete(requestId);
    complete?.();
  };
  async request(raw: ThemeSettingsRequest): Promise<unknown> {
    const request = parseSettingsRequest(raw);
    if (
      this.disposed ||
      !request ||
      !canRequestSettings(this.state, request) ||
      this.requests.size >= 4 ||
      this.completions.size >= 4 ||
      this.requests.has(request.requestId) ||
      this.completions.has(request.requestId)
    )
      throw new Error('settings_request_unavailable');
    const adapter = this.options.sections[request.sectionId];
    if (!adapter?.request) throw new Error('settings_request_unavailable');
    const mutation = SETTINGS_REQUESTS[request.sectionId][request.operation].mutation === true;
    if (mutation) {
      this.cancelOperation();
      this.cancelRequests();
      this.generation++;
    }
    const abort = new AbortController();
    this.requests.set(request.requestId, abort);
    const generation = this.generation,
      current = () =>
        !this.disposed &&
        generation === this.generation &&
        this.state.editor?.id === request.editorId;
    if (mutation) this.update({ busy: true, error: null });
    try {
      const outcome = await adapter.request(
        request.operation,
        request.params,
        current,
        abort.signal,
      );
      if (!current()) {
        outcome.afterReply?.();
        throw new Error('settings_scope_changed');
      }
      if (outcome.afterReply) this.completions.set(request.requestId, outcome.afterReply);
      return outcome.result;
    } catch (error: any) {
      if (current()) this.update({ error: this.options.error('action') });
      const code = error?.code ?? error?.data?.error ?? error?.message;
      if (
        request.sectionId === 'account' &&
        request.operation !== 'getAccount' &&
        ![
          'wrong_current_password',
          'no_password_identity',
          'password_required',
          'bad_password_length',
          'login_password_required',
          'bad_login',
          'login_already_exists',
          'settings_scope_changed',
        ].includes(code)
      )
        throw new Error('settings_operation_failed');
      throw new Error(
        typeof code === 'string' && /^[a-z][a-z0-9_]{0,100}$/.test(code)
          ? code
          : 'settings_operation_failed',
      );
    } finally {
      this.requests.delete(request.requestId);
      if (mutation && current()) this.update({ busy: false });
    }
  }
  private cancelRequests() {
    this.requests.forEach((request) => request.abort());
    this.requests.clear();
  }
  private cancelOperation() {
    this.operation?.abort.abort();
    this.operation = null;
  }
  private async run(id: string) {
    const adapter = this.options.sections[this.state.editor!.sectionId];
    if (!adapter.run) return false;
    this.cancelOperation();
    const operation = { id, abort: new AbortController() };
    this.operation = operation;
    this.update({ error: null });
    try {
      await adapter.run(id, { ...this.draft }, operation.abort.signal);
      return !operation.abort.signal.aborted;
    } catch {
      if (this.operation === operation && !this.disposed)
        this.update({ error: this.options.error('action') });
      return false;
    } finally {
      if (this.operation === operation && !this.disposed) {
        this.operation = null;
        this.update({});
      }
    }
  }
  private async save() {
    const editor = this.state.editor!;
    const adapter = this.options.sections[editor.sectionId];
    if (editor.fields.some((field) => field.error)) {
      this.update({ error: this.options.error('invalid') });
      return false;
    }
    const generation = ++this.generation;
    this.cancelRequests();
    const current = () => !this.disposed && generation === this.generation;
    const changes = editor.fields.filter((field) => field.dirty);
    this.update({ busy: true, error: null });
    try {
      const latest = await adapter.read();
      if (!current()) return false;
      if (
        changes.some(
          (field) =>
            latest[field.id] !== this.saved[field.id] && latest[field.id] !== this.draft[field.id],
        )
      ) {
        this.update({ error: this.options.error('conflict') });
        return false;
      }
      for (const field of editor.fields.filter((field) => !field.dirty))
        this.saved[field.id] = this.draft[field.id] = latest[field.id];
      // Availability, permissions and server caps may have changed during the read.
      if (adapter.fields(this.draft, this.saved).some((field) => field.error)) {
        this.update({ error: this.options.error('invalid') });
        return false;
      }
      for (const field of changes) {
        if (!current()) return false;
        const value =
          latest[field.id] === this.draft[field.id]
            ? latest[field.id]
            : await adapter.write(field.id, this.draft[field.id], current, { ...this.draft });
        if (!current()) return false;
        this.saved[field.id] = this.draft[field.id] = value;
        this.update({});
      }
      if (adapter.refreshAfterSave) {
        const values = await adapter.read();
        if (!current()) return false;
        this.saved = { ...values };
        this.draft = { ...values };
        this.update({});
      }
      return true;
    } catch {
      if (current()) this.update({ error: this.options.error('save') });
      return false;
    } finally {
      if (current()) this.update({ busy: false });
    }
  }
}

/** One canonical native controller per section; legacy navigation keeps its original draft rules. */
export class ThemeSettingsController {
  private state: ThemeSettingsState;
  private sections = new Map<string, SettingsEditorController>();
  private retained = new Set<string>();
  private active: string | null = null;
  private disposed = false;
  private listeners = new Set<() => void>();
  private pending = new Map<string, SettingsEditorController>();
  private inFlight = new Set<string>();
  constructor(private options: Options) {
    this.state = {
      ...options.catalog,
      scopeId: crypto.randomUUID(),
      query: '',
      results: [],
      hasMoreResults: false,
      editor: null,
      editors: {},
    };
  }
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish = () => {
    if (this.disposed) return;
    this.state = {
      ...this.state,
      editor: this.active ? (this.sections.get(this.active)?.getState().editor ?? null) : null,
      editors: Object.fromEntries(
        [...this.sections].flatMap(([id, section]) =>
          section.getState().editor ? [[id, section.getState().editor!]] : [],
        ),
      ),
    };
    this.listeners.forEach((listener) => listener());
  };
  private section(id: string) {
    let section = this.sections.get(id);
    if (!section) {
      section = new SettingsEditorController(this.options);
      section.subscribe(this.publish);
      this.sections.set(id, section);
    }
    return section;
  }
  private releaseReads(section: SettingsEditorController) {
    for (const [id, owner] of this.pending)
      if (owner === section && this.inFlight.has(id)) {
        this.inFlight.delete(id);
        this.pending.delete(id);
      }
  }
  async handle(action: ThemeSettingsAction): Promise<boolean> {
    if (this.disposed || !canUseThemeSettings(this.state, action)) return false;
    if (action.action === 'search') {
      const results = this.options.search(action.query);
      this.state = {
        ...this.state,
        query: action.query,
        results: results.slice(0, 50),
        hasMoreResults: results.length > 50,
      };
      this.publish();
      return true;
    }
    if (!this.options.sections[action.sectionId]) return false;
    if (action.action === 'open' || action.action === 'openSession') {
      if (action.action === 'openSession') this.retained.add(action.sectionId);
      else {
        if (this.active && this.active !== action.sectionId && !this.retained.has(this.active)) {
          const previous = this.sections.get(this.active);
          if (previous) this.releaseReads(previous);
          this.sections.get(this.active)?.dispose();
          this.sections.delete(this.active);
        }
        this.active = action.sectionId;
      }
      const section = this.section(action.sectionId);
      const result = await section.handle({ ...action, action: 'open' });
      this.publish();
      return result;
    }
    const section = this.sections.get(action.sectionId);
    if (section && ['cancelRequests', 'reload', 'save'].includes(action.action))
      this.releaseReads(section);
    return section?.handle(action) ?? false;
  }
  async request(raw: ThemeSettingsRequest) {
    if (
      this.disposed ||
      this.inFlight.size >= 4 ||
      this.pending.has(raw.requestId) ||
      !canRequestSettings(this.state, raw)
    )
      throw new Error('settings_request_unavailable');
    const section = this.sections.get(raw.sectionId);
    if (!section) throw new Error('settings_request_unavailable');
    this.pending.set(raw.requestId, section);
    this.inFlight.add(raw.requestId);
    try {
      return await section.request(raw);
    } catch (error) {
      this.pending.delete(raw.requestId);
      throw error;
    } finally {
      this.inFlight.delete(raw.requestId);
    }
  }
  completeRequest = (id: string) => {
    const section = this.pending.get(id);
    this.pending.delete(id);
    section?.completeRequest(id);
  };
  configure(catalog: Options['catalog']) {
    this.options = { ...this.options, catalog };
    this.state = { ...this.state, ...catalog };
    this.sections.forEach((section) => section.configure(catalog));
    if (this.state.query) {
      const results = this.options.search(this.state.query);
      this.state = {
        ...this.state,
        results: results.slice(0, 50),
        hasMoreResults: results.length > 50,
      };
    }
    this.publish();
  }
  dispose() {
    this.disposed = true;
    this.sections.forEach((section) => section.dispose());
    this.sections.clear();
    this.retained.clear();
    this.pending.clear();
    this.inFlight.clear();
    this.listeners.clear();
  }
  activate() {
    if (!this.disposed) return;
    this.disposed = false;
    this.active = null;
    this.state = { ...this.state, scopeId: crypto.randomUUID(), editor: null, editors: {} };
    this.publish();
  }
}
