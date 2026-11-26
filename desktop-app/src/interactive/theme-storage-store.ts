import {
  cloneThemeStorageValue,
  validThemeStorageKey,
  type ThemeStorageValue,
  type ThemeStorageSnapshot,
  type ThemeStorageRequest,
} from '../main/theme-storage-types';
type Update = { key: string; update: unknown | ((value: any) => unknown); remove?: boolean };
type Bridge = {
  requestThemeStorage(request: ThemeStorageRequest): Promise<ThemeStorageSnapshot>;
  subscribeThemeStorage(listener: (snapshot: ThemeStorageSnapshot) => void): () => void;
  subscribeThemeEnvironment?: (listener: (environment: { visible: boolean }) => void) => () => void;
};
export type ThemeStorageState = {
  ready: boolean;
  saving: boolean;
  dirty: boolean;
  error: string | null;
  values: Record<string, ThemeStorageValue>;
};

/** One cache/write queue for all components in one isolated theme renderer. */
export class ThemeStorageClient {
  private base: ThemeStorageSnapshot = { revision: 0, values: {} };
  private defaults = new Map<string, ThemeStorageValue>();
  private pending: Update[] = [];
  private listeners = new Set<() => void>();
  private state: ThemeStorageState = {
    ready: false,
    saving: false,
    dirty: false,
    error: null,
    values: {},
  };
  private started = false;
  private loading?: Promise<boolean>;
  private flushing?: Promise<boolean>;
  private newer?: ThemeStorageSnapshot;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private bridge: () => Bridge | undefined) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    this.start();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.pending.length) void this.flush();
    };
  };
  defaultValue(key: string, value: unknown) {
    if (!validThemeStorageKey(key)) throw new Error('theme_storage_invalid_key');
    if (!this.defaults.has(key)) this.defaults.set(key, cloneThemeStorageValue(value));
    return this.defaults.get(key)!;
  }
  private value(key: string, values = this.base.values): ThemeStorageValue {
    return Object.prototype.hasOwnProperty.call(values, key)
      ? values[key]
      : (this.defaults.get(key) ?? null);
  }
  private apply(value: ThemeStorageValue, operation: Update): ThemeStorageValue {
    if (operation.remove) return this.defaults.get(operation.key) ?? null;
    return cloneThemeStorageValue(
      typeof operation.update === 'function'
        ? operation.update(cloneThemeStorageValue(value))
        : operation.update,
    );
  }
  private publish(patch: Partial<ThemeStorageState> = {}) {
    const values = { ...this.base.values };
    for (const operation of this.pending) {
      if (operation.remove) delete values[operation.key];
      else {
        try {
          values[operation.key] = this.apply(this.value(operation.key, values), operation);
        } catch (error) {
          patch.error = this.error(error);
        }
      }
    }
    this.state = { ...this.state, ...patch, dirty: this.pending.length > 0, values };
    this.listeners.forEach((listener) => listener());
  }
  private error(error: unknown) {
    return error instanceof Error && /^theme_storage_[a-z_]+$/.test(error.message)
      ? error.message
      : 'theme_storage_unavailable';
  }
  private accept = (snapshot: ThemeStorageSnapshot) => {
    if (this.flushing) {
      if (!this.newer || snapshot.revision > this.newer.revision) this.newer = snapshot;
      return;
    }
    if (snapshot.revision <= this.base.revision) return;
    this.base = snapshot;
    this.publish();
  };
  private start() {
    if (this.started) return;
    this.started = true;
    const bridge = this.bridge();
    bridge?.subscribeThemeStorage(this.accept);
    let visible = false;
    bridge?.subscribeThemeEnvironment?.((environment) => {
      const resumed = environment.visible && !visible;
      visible = environment.visible;
      if (resumed && this.pending.length) void this.flush();
    });
    void this.reload();
  }
  reload = (): Promise<boolean> => {
    if (this.loading) return this.loading;
    this.loading = Promise.resolve().then(async () => {
      try {
        const bridge = this.bridge();
        if (!bridge) throw new Error('theme_storage_unavailable');
        const snapshot = await bridge.requestThemeStorage({ operation: 'read' });
        if (snapshot.revision >= this.base.revision) this.base = snapshot;
        this.publish({ ready: true, error: null });
        return true;
      } catch (error) {
        this.publish({ error: this.error(error) });
        return false;
      } finally {
        this.loading = undefined;
      }
    });
    return this.loading;
  };
  set(key: string, update: unknown | ((value: any) => unknown), remove = false) {
    this.start();
    try {
      if (!validThemeStorageKey(key)) throw new Error('theme_storage_invalid_key');
      const operation = {
        key,
        update: remove || typeof update === 'function' ? update : cloneThemeStorageValue(update),
        remove,
      };
      this.apply(this.value(key, this.state.values), operation);
      this.pending.push(operation);
      this.publish({ error: null });
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        void this.flush();
      }, 100);
    } catch (error) {
      this.publish({ error: this.error(error) });
    }
  }
  flush = (): Promise<boolean> => {
    clearTimeout(this.timer);
    if (this.flushing) return this.flushing;
    // Defer one microtask so even synchronous bridge callbacks see the in-flight queue.
    this.flushing = Promise.resolve()
      .then(async () => {
        if (!this.state.ready && !(await this.reload())) return false;
        this.publish({ saving: true, error: null });
        let conflicts = 0;
        try {
          while (this.pending.length) {
            const key = this.pending[0].key,
              batch = this.pending.filter((operation) => operation.key === key);
            let value = this.value(key);
            for (const operation of batch) value = this.apply(value, operation);
            const last = batch[batch.length - 1];
            try {
              const snapshot = await this.bridge()!.requestThemeStorage(
                last.remove
                  ? { operation: 'remove', key, revision: this.base.revision }
                  : { operation: 'set', key, value, revision: this.base.revision },
              );
              this.pending = this.pending.filter((operation) => !batch.includes(operation));
              if (snapshot.revision >= this.base.revision) this.base = snapshot;
              if (this.newer && this.newer.revision > this.base.revision) this.base = this.newer;
              this.newer = undefined;
              conflicts = 0;
              this.publish();
            } catch (error) {
              if (this.error(error) !== 'theme_storage_conflict' || ++conflicts > 3) throw error;
              this.base = await this.bridge()!.requestThemeStorage({ operation: 'read' });
            }
          }
          return true;
        } catch (error) {
          this.publish({ error: this.error(error) });
          return false;
        } finally {
          this.publish({ saving: false });
        }
      })
      .finally(() => {
        this.flushing = undefined;
        if (this.newer && this.newer.revision > this.base.revision) {
          this.base = this.newer;
          this.publish();
        }
        this.newer = undefined;
      });
    return this.flushing;
  };
}
