import {
  useCallback,
  useRef,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { ThemeStorageClient } from './theme-storage-store';
export type {
  ThemeStorageValue,
  ThemeStorageSnapshot,
  ThemeStorageRequest,
} from '../main/theme-storage-types';
export type ThemeStorageMeta = {
  ready: boolean;
  saving: boolean;
  dirty: boolean;
  error: string | null;
  reset: () => void;
  reload: () => Promise<boolean>;
  flush: () => Promise<boolean>;
};
const client = new ThemeStorageClient(() => (window as any).chatter);
let installed = false;

/** Device-local JSON state, shared by key and automatically scoped to this theme. */
export function useThemeStorage<T>(
  key: string,
  initialValue: T,
): readonly [T, Dispatch<SetStateAction<T>>, ThemeStorageMeta] {
  const fallback = useRef({ key, value: initialValue });
  if (fallback.current.key !== key) fallback.current = { key, value: initialValue };
  const defaultValue = client.defaultValue(key, fallback.current.value);
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  if (!installed) {
    installed = true;
    window.addEventListener('pagehide', () => {
      void client.flush();
    });
  }
  const setValue = useCallback<Dispatch<SetStateAction<T>>>(
    (value) => client.set(key, value),
    [key],
  );
  const reset = useCallback(() => client.set(key, null, true), [key]);
  return [
    Object.prototype.hasOwnProperty.call(state.values, key)
      ? (state.values[key] as T)
      : (defaultValue as T),
    setValue,
    {
      ready: state.ready,
      saving: state.saving,
      dirty: state.dirty,
      error: state.error,
      reset,
      reload: client.reload,
      flush: client.flush,
    },
  ];
}
