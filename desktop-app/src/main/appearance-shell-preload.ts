/// <reference lib="dom" />
import { contextBridge, ipcRenderer } from 'electron';
import type { AppearanceShellState, AppearanceDocumentRequest } from './appearance-shell-types';

// This preload exposes only the appearance navigator contract in its isolated renderer.
let state: AppearanceShellState | undefined;
const listeners = new Set<(state: AppearanceShellState) => void>();
let confirmationSubscribers = 0;
let documentSequence = 0;
const documentRequests = new Map<string, { request: AppearanceDocumentRequest; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
ipcRenderer.on('appearance-shell:result', (_event, reply: { requestId: string; result?: unknown; error?: string }) => {
  const pending = documentRequests.get(reply.requestId); if (!pending) return;
  clearTimeout(pending.timer); documentRequests.delete(reply.requestId);
  if (reply.error) pending.reject(new Error(reply.error)); else pending.resolve(reply.result);
});
ipcRenderer.on('appearance-shell:state', (_event, next: AppearanceShellState) => {
  state = next;
  for (const [id, pending] of documentRequests) {
    const request = pending.request;
    const file = next.messages.find(message => message.id === request.messageId && message.variantIndex === request.variantIndex)?.attachments?.[request.index];
    if (next.activeChatId !== request.chatId || file?.url !== request.url) {
      clearTimeout(pending.timer); documentRequests.delete(id); pending.reject(new Error('attachment_scope_changed'));
    }
  }
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
const contentAction = (messageId: number, action: string, extra: Record<string, unknown>) => {
  const message = state?.messages.find(message => message.id === messageId);
  if (!navigator.userActivation.isActive || !message) return false;
  send({ type: 'contentAction', chatId: state!.activeChatId, messageId, variantIndex: message.variantIndex, action, ...extra });
  return true;
};
const imageSource = (messageId: number, source: string, width: number) => {
  const message = state?.messages.find(message => message.id === messageId);
  if (!message || !state?.activeChatId || typeof source !== 'string' || !source || source.length > 8192) return '';
  const url = new URL('/_image', location.href);
  url.search = new URLSearchParams({ chatId: String(state.activeChatId), messageId: String(messageId), variantIndex: String(message.variantIndex),
    url: source, width: String(width) }).toString();
  return url.href;
};
const composerAction = (action: 'choose' | 'remove' | 'clear', id?: string) => {
  if (!navigator.userActivation.isActive || !state?.activeChatId || state.sending || state.composer?.busy) return false;
  if (action === 'choose' ? !state.canSend : action === 'clear' ? !state.composer?.items.length : !state.composer?.items.some(item => item.id === id)) return false;
  send({ type: 'composerAction', chatId: state.activeChatId, action, ...(id ? { id } : {}) }); return true;
};
const documentRequest = (method: AppearanceDocumentRequest['method'], messageId: number, index: number, page?: number, width?: number) => {
  const message = state?.messages.find(message => message.id === messageId), file = message?.attachments?.[index];
  if (!state?.activeChatId || !message || !file?.url || messageId <= 0 || !Number.isSafeInteger(index) || index < 0 || documentRequests.size >= 4)
    return Promise.reject(new Error('attachment_request_unavailable'));
  const request: AppearanceDocumentRequest = { requestId: String(++documentSequence), method, chatId: state.activeChatId,
    messageId, variantIndex: message.variantIndex, index, url: file.url, ...(method === 'renderAttachmentPage' ? { page, width } : {}) };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { documentRequests.delete(request.requestId); reject(new Error('attachment_request_timeout')); }, 30000);
    documentRequests.set(request.requestId, { request, resolve, reject, timer }); ipcRenderer.send('appearance-shell:request', request);
  });
};
contextBridge.exposeInMainWorld('chatter', {
  imageSource: (messageId: number, source: string, width = 560) =>
    imageSource(messageId, source, Math.max(64, Math.min(1600, Math.round(Number(width) || 560)))),
  fullImageSource: (messageId: number, source: string) => imageSource(messageId, source, 0),
  readAttachment: (id: number, index: number) => documentRequest('readAttachment', id, index),
  renderAttachmentPage: (id: number, index: number, page: number, width = 1000) => {
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000) return Promise.reject(new Error('attachment_page_unavailable'));
    return documentRequest('renderAttachmentPage', id, index, page, Math.max(128, Math.min(1600, Math.round(Number(width) || 1000))));
  },
  chooseAttachments: () => composerAction('choose'),
  removePendingAttachment: (id: string) => composerAction('remove', id),
  clearPendingAttachments: () => composerAction('clear'),
  pendingAttachmentSource: (id: string) => {
    if (!state?.activeChatId || !state.composer?.items.some(item => item.id === id && item.kind === 'image')) return '';
    const url = new URL('/_image', location.href);
    url.search = new URLSearchParams({ chatId: String(state.activeChatId), messageId: '0', variantIndex: '0', pendingId: id, url: 'pending:' + id, width: '560' }).toString();
    return url.href;
  },
  openImage: (id: number, url: string) => contentAction(id, 'openImage', { url }),
  downloadImage: (id: number, url: string) => contentAction(id, 'downloadImage', { url }),
  openAttachment: (id: number, index: number) => contentAction(id, 'openAttachment', { index }),
  downloadAttachment: (id: number, index: number) => contentAction(id, 'downloadAttachment', { index }),
  openLink: (id: number, url: string) => contentAction(id, 'openLink', { url }),
  copyText: (id: number, text: string) => contentAction(id, 'copyText', { text }),
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
    if (!navigator.userActivation.isActive || !state?.canSend || typeof text !== 'string' || text.length > 100000 || !text.trim() && !state.attachmentCount) return false;
    send({ type: 'sendMessage', chatId: state.activeChatId, text });
    return true;
  },
  stopGeneration: () => send({ type: 'stopGeneration', chatId: state?.activeChatId }),
  loadOlderMessages: () => send({ type: 'loadOlderMessages', chatId: state?.activeChatId }),
  openConversation: () => send({ type: 'openConversation' }),
  showHome: () => send({ type: 'home' }),
  attachFiles: () => composerAction('choose'),
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
// Let the theme consume Escape (for example, to close its own image viewer) before host navigation.
window.addEventListener('keydown', event => {
  if (event.key === 'Escape') setTimeout(() => {
    if (!event.defaultPrevented) ipcRenderer.send('appearance-shell:escape');
  }, 0);
});
