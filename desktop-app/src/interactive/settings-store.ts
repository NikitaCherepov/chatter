export type SettingsResult<T = void> = { ok: true; value: T } | { ok: false; error: string };
export type TaskState<T> = {
  data: T | undefined;
  loading: boolean;
  busy: boolean;
  error: string | null;
  operation: string | null;
};
const copy = <T>(value: T): T => structuredClone(value);
const signature = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    typeof item === 'number' && !Number.isFinite(item)
      ? { invalidNumber: String(item) }
      : item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          )
        : item,
  );
const equal = (a: unknown, b: unknown) => signature(a) === signature(b);
export const settingsError = (error: unknown) =>
  error instanceof Error ? error.message : 'settings_operation_failed';

/** Shared per session, not per component. No DOM, storage, polling or server settings live here. */
export class SettingsTask<T> {
  protected state: TaskState<T> = {
    data: undefined,
    loading: false,
    busy: false,
    error: null,
    operation: null,
  };
  private listeners = new Set<() => void>();
  private pending: Promise<SettingsResult<T>> | undefined;
  private epoch = 0;
  private retried = false;
  constructor(protected current: () => boolean) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  protected publish(patch: Partial<TaskState<T>>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  receive(value: T) {
    this.retried = false;
    this.publish({ data: copy(value), error: null });
  }
  clearError = () => this.publish({ error: null });
  dispose() {
    this.epoch++;
    this.listeners.clear();
  }
  clear = () => this.publish({ data: undefined, error: null });
  load(loader: () => Promise<T>, force = false): Promise<SettingsResult<T>> {
    if (this.pending) return this.pending;
    if (!force && this.state.data !== undefined)
      return Promise.resolve({ ok: true, value: this.state.data });
    this.pending = this.run('load', loader, true).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  retry(loader: () => Promise<T>): Promise<SettingsResult<T>> {
    if (this.retried)
      return Promise.resolve({ ok: false, error: this.state.error ?? 'settings_request_canceled' });
    this.retried = true;
    return this.pending
      ? this.pending.then(() => this.load(loader, true))
      : this.load(loader, true);
  }
  async run(
    operation: string,
    task: () => Promise<T>,
    loading = false,
  ): Promise<SettingsResult<T>> {
    if (!this.current()) return { ok: false, error: 'settings_scope_changed' };
    if (this.state.busy) return { ok: false, error: 'settings_busy' };
    const epoch = this.epoch;
    this.publish({ busy: true, loading, error: null, operation });
    try {
      // Invoke before the first await: gesture-required operations must keep the user's activation.
      const value = await task();
      if (epoch !== this.epoch || !this.current())
        return { ok: false, error: 'settings_scope_changed' };
      this.retried = false;
      this.publish({ data: copy(value) });
      return { ok: true, value };
    } catch (reason) {
      const error = settingsError(reason);
      if (epoch === this.epoch && this.current()) this.publish({ error });
      return { ok: false, error };
    } finally {
      if (epoch === this.epoch && this.current())
        this.publish({ busy: false, loading: false, operation: null });
    }
  }
}

export type FormState<T> = {
  draft: T | undefined;
  saved: T | undefined;
  incoming: T | undefined;
  dirty: boolean;
  busy: boolean;
  error: string | null;
  conflict: boolean;
  errors: Partial<Record<keyof T, string>>;
};
export class SettingsFormStore<T extends object> {
  private state: FormState<T> = {
    draft: undefined,
    saved: undefined,
    incoming: undefined,
    dirty: false,
    busy: false,
    error: null,
    conflict: false,
    errors: {},
  };
  private listeners = new Set<() => void>();
  private epoch = 0;
  constructor(
    private current: () => boolean,
    private validate: (value: T) => Partial<Record<keyof T, string>> = () => ({}),
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<FormState<T>>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  private change(draft: T) {
    this.publish({
      draft: copy(draft),
      dirty: !equal(draft, this.state.saved),
      errors: this.validate(draft),
    });
  }
  receive(value: T) {
    if (this.state.busy) return;
    if (this.state.dirty && equal(value, this.state.draft)) {
      this.receiveReset(value);
      return;
    }
    if (this.state.dirty) {
      this.publish({ incoming: copy(value), conflict: !equal(value, this.state.saved) });
      return;
    }
    this.publish({
      draft: copy(value),
      saved: copy(value),
      incoming: undefined,
      dirty: false,
      conflict: false,
      error: null,
      errors: this.validate(value),
    });
  }
  set = <K extends keyof T>(key: K, value: T[K]) => {
    if (this.state.draft && !this.state.busy) this.change({ ...this.state.draft, [key]: value });
  };
  replace = (value: T) => {
    if (!this.state.busy) this.change(value);
  };
  discard = () => {
    if (!this.state.busy) {
      const value = this.state.incoming ?? this.state.saved;
      if (value) this.receiveReset(value);
    }
  };
  rebase = () => {
    if (!this.state.busy && this.state.draft) {
      const saved = this.state.incoming ?? this.state.saved;
      this.publish({
        saved: copy(saved),
        incoming: undefined,
        conflict: false,
        error: null,
        dirty: !equal(this.state.draft, saved),
      });
    }
  };
  private receiveReset(value: T) {
    this.publish({
      draft: copy(value),
      saved: copy(value),
      incoming: undefined,
      dirty: false,
      conflict: false,
      error: null,
      errors: this.validate(value),
    });
  }
  clearError = () => this.publish({ error: null });
  dispose() {
    this.epoch++;
    this.listeners.clear();
  }
  async save(writer: (draft: T) => Promise<T>): Promise<SettingsResult<T>> {
    if (!this.current()) return { ok: false, error: 'settings_scope_changed' };
    if (this.state.busy || !this.state.draft) return { ok: false, error: 'settings_busy' };
    const errors = this.validate(this.state.draft);
    const error = this.state.conflict
      ? 'settings_conflict'
      : Object.keys(errors).length
        ? 'settings_invalid'
        : null;
    if (error) {
      this.publish({ error, errors });
      return { ok: false, error };
    }
    if (!this.state.dirty && this.state.saved) return { ok: true, value: copy(this.state.saved) };
    const value = copy(this.state.draft),
      epoch = this.epoch;
    this.publish({ busy: true, error: null });
    try {
      const saved = await writer(value);
      if (epoch !== this.epoch || !this.current())
        return { ok: false, error: 'settings_scope_changed' };
      this.receiveReset(saved);
      return { ok: true, value: saved };
    } catch (reason) {
      const error = settingsError(reason);
      if (epoch === this.epoch && this.current()) this.publish({ error });
      return { ok: false, error };
    } finally {
      if (epoch === this.epoch && this.current()) this.publish({ busy: false });
    }
  }
}
