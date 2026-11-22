/// <reference lib="dom" />
import { contextBridge, ipcRenderer } from 'electron';
import type { AppearanceShellState } from './appearance-shell-types';

// This preload exposes only the appearance navigator contract in its isolated renderer.
let state: AppearanceShellState | undefined;
const listeners = new Set<(state: AppearanceShellState) => void>();
let confirmationSubscribers = 0;
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
const messageAction = (messageId: number, action: string, extra: Record<string, unknown> = {}) => {
  if (!navigator.userActivation.isActive) return false;
  const message = state?.messages.find(message => message.id === messageId);
  if (!message?.actions.includes(action as any)) return false;
  send({ type: 'messageAction', chatId: state!.activeChatId, messageId, variantIndex: message.variantIndex, action, ...extra });
  return true;
};
const speechAction = (action: string) => {
  if (!navigator.userActivation.isActive || !state?.speech?.messageId) return false;
  if (action === 'pause' && state.speech.status === 'paused') return false;
  if (action === 'resume' && state.speech.status !== 'paused') return false;
  send({ type: 'speechAction', chatId: state.activeChatId, action });
  return true;
};
contextBridge.exposeInMainWorld('chatter', {
  subscribe: (listener: (state: AppearanceShellState) => void, options?: { navigation?: boolean; confirmations?: boolean }) => {
    if (options?.navigation) ipcRenderer.send('appearance-shell:navigation', true);
    if (options?.confirmations && ++confirmationSubscribers === 1) ipcRenderer.send('appearance-shell:confirmations', true);
    listeners.add(listener);
    if (state) listener(state);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners.delete(listener);
      if (options?.confirmations && --confirmationSubscribers === 0) ipcRenderer.send('appearance-shell:confirmations', false);
    };
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
  copyMessage: (id: number) => messageAction(id, 'copy'),
  downloadMessageDocx: (id: number) => messageAction(id, 'downloadDocx'),
  sendMessageToTelegram: (id: number) => messageAction(id, 'sendTelegram'),
  forkFromMessage: (id: number) => messageAction(id, 'fork'),
  editMessage: (id: number, text: string, variantIndex?: number) => typeof text === 'string' && Boolean(text.trim()) && text.length <= 100000
    && (variantIndex === undefined || state?.messages.find(item => item.id === id)?.variantIndex === variantIndex) && messageAction(id, 'edit', {
    text, ...(variantIndex === undefined ? {} : { variantIndex }),
  }),
  openMessageEditor: (id: number) => messageAction(id, 'edit', { nativeEditor: true }),
  deleteMessage: (id: number) => messageAction(id, 'delete'),
  regenerateMessage: (id: number, hint?: string) => messageAction(id, 'regenerate', hint === undefined ? {} : { hint }),
  requestRegenerationHint: (id: number) => messageAction(id, 'regenerateHint'),
  activateMessageVariant: (id: number, index: number) => messageAction(id, 'activateVariant', { index }),
  speakMessage: (id: number) => messageAction(id, 'speak'),
  pauseSpeech: () => speechAction('pause'),
  resumeSpeech: () => speechAction('resume'),
  stopSpeech: () => speechAction('stop'),
  reviewConfirmation: (id: string) => {
    if (!navigator.userActivation.isActive || !state?.confirmations?.some(item => item.id === id)) return false;
    send({ type: 'reviewConfirmation', id });
    return true;
  },
  runConfirmationAction: (id: string, actionId: string, revision: number, comment?: string) => {
    if (!navigator.userActivation.isActive) return false;
    const card = state?.confirmations.find(item => item.id === id);
    if (!card?.ready || !card.customizable || card.busy || card.revision !== revision
        || !card.actions.some(item => item.id === actionId && !item.disabled)) return false;
    send({ type: 'confirmationAction', id, actionId, revision, ...(comment === undefined ? {} : { comment }) });
    return true;
  },
  setConfirmationField: (id: string, fieldId: string, value: string | boolean) => {
    if (!navigator.userActivation.isActive) return false;
    const card = state?.confirmations.find(item => item.id === id);
    if (!card?.ready || !card.customizable || card.busy || !card.fields.some(item => item.id === fieldId && !item.disabled)) return false;
    send({ type: 'confirmationField', id, fieldId, value });
    return true;
  },
  reportError: () => ipcRenderer.send('appearance-shell:failed'),
});
window.addEventListener('error', () => ipcRenderer.send('appearance-shell:failed'));
window.addEventListener('unhandledrejection', () => ipcRenderer.send('appearance-shell:failed'));
