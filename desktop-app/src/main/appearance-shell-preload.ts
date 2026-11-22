/// <reference lib="dom" />
import { contextBridge, ipcRenderer } from 'electron';
import type { AppearanceShellState } from './appearance-shell-types';

// This preload exposes only the appearance navigator contract in its isolated renderer.
let state: AppearanceShellState | undefined;
const listeners = new Set<(state: AppearanceShellState) => void>();
ipcRenderer.on('appearance-shell:state', (_event, next: AppearanceShellState) => {
  state = next;
  for (const listener of listeners) {
    try {
      listener(next);
    } catch (error) {
      console.error('Appearance shell update failed', error);
    }
  }
});
const send = (action: unknown) => ipcRenderer.send('appearance-shell:action', action);
contextBridge.exposeInMainWorld('chatter', {
  subscribe: (listener: (state: AppearanceShellState) => void, options?: { navigation?: boolean }) => {
    if (options?.navigation) ipcRenderer.send('appearance-shell:navigation', true);
    listeners.add(listener);
    if (state) listener(state);
    return () => listeners.delete(listener);
  },
  openChat: (id: number) => send({ type: 'openChat', id }),
  newChat: () => send({ type: 'newChat' }),
  sendMessage: (text: string) => {
    if (!navigator.userActivation.isActive || !state?.canSend) return false;
    send({ type: 'sendMessage', chatId: state.activeChatId, text });
    return true;
  },
  stopGeneration: () => send({ type: 'stopGeneration', chatId: state?.activeChatId }),
  loadOlderMessages: () => send({ type: 'loadOlderMessages', chatId: state?.activeChatId }),
  openConversation: () => send({ type: 'openConversation' }),
  showHome: () => send({ type: 'home' }),
  attachFiles: () => send({ type: 'attachFiles' }),
  openLibrary: () => send({ type: 'openLibrary' }),
  openSettings: () => send({ type: 'openSettings' }),
  loadMore: (folderId: number | null) => send({ type: 'loadMore', folderId }),
  search: (query: string) => send({ type: 'search', query }),
  reportError: () => ipcRenderer.send('appearance-shell:failed'),
});
window.addEventListener('error', () => ipcRenderer.send('appearance-shell:failed'));
window.addEventListener('unhandledrejection', () => ipcRenderer.send('appearance-shell:failed'));
