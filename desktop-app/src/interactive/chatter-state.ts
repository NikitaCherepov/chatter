import { useRef, useLayoutEffect, useCallback, useSyncExternalStore } from 'react';
import type { AppearanceShellState } from '../main/appearance-shell-types';
import { updateSettingsScope } from './settings-sdk';
import { updateChatState } from './chat-store';
export type ChatterStateOptions = { navigation?: boolean; confirmations?: boolean };
let snapshot: AppearanceShellState | undefined, unsubscribe: (() => void) | undefined;
let subscribedOptions: ChatterStateOptions | undefined;
const listeners = new Set<{ notify: () => void; options: { current: ChatterStateOptions } }>();
function updateSubscription() {
  if (!listeners.size) {
    const previous = unsubscribe;
    unsubscribe = undefined;
    subscribedOptions = undefined;
    previous?.();
    return;
  }
  const options = {
    navigation: [...listeners].some((item) => item.options.current.navigation),
    confirmations: [...listeners].some((item) => item.options.current.confirmations),
  };
  if (
    unsubscribe &&
    subscribedOptions?.navigation === options.navigation &&
    subscribedOptions.confirmations === options.confirmations
  )
    return;
  const bridge = (window as any).chatter;
  if (!bridge) return;
  const previous = unsubscribe;
  // Register the replacement first: unchanged capabilities must not briefly turn off.
  unsubscribe = bridge.subscribe((state: AppearanceShellState) => {
    snapshot = state;
    updateChatState(state);
    updateSettingsScope(state.settings);
    for (const listener of listeners) listener.notify();
  }, options);
  subscribedOptions = options;
  previous?.();
}
function subscribe(notify: () => void, options: { current: ChatterStateOptions }) {
  const listener = { notify, options };
  listeners.add(listener);
  updateSubscription();
  return () => {
    if (listeners.delete(listener)) updateSubscription();
  };
}
export function useChatterState({
  navigation = false,
  confirmations = false,
}: ChatterStateOptions = {}) {
  const options = useRef({ navigation, confirmations });
  useLayoutEffect(() => {
    options.current = { navigation, confirmations };
    updateSubscription();
  }, [navigation, confirmations]);
  const subscribeWithOptions = useCallback((notify: () => void) => subscribe(notify, options), []);
  return useSyncExternalStore(subscribeWithOptions, () => snapshot);
}

export const getChatterSnapshot = () => snapshot;
