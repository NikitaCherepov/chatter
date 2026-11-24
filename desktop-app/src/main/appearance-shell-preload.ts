/// <reference lib="dom" />
import { contextBridge, ipcRenderer } from 'electron';
import type { AppearanceShellState, AppearanceDocumentRequest } from './appearance-shell-types';

// This preload exposes only the appearance navigator contract in its isolated renderer.
let state: AppearanceShellState | undefined;
let pasteEpoch = 0;
let pasteBusy = false;
let currentPaste: { event: ClipboardEvent; files: File[]; epoch: number; claimed: boolean } | undefined;
const listeners = new Set<(state: AppearanceShellState) => void>();
let confirmationSubscribers = 0;
let navigationSubscribers = 0;
let documentSequence = 0;
const documentRequests = new Map<string, { request: AppearanceDocumentRequest; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
ipcRenderer.on('appearance-shell:result', (_event, reply: { requestId: string; result?: unknown; error?: string }) => {
  const pending = documentRequests.get(reply.requestId); if (!pending) return;
  clearTimeout(pending.timer); documentRequests.delete(reply.requestId);
  if (reply.error) pending.reject(new Error(reply.error)); else pending.resolve(reply.result);
});
ipcRenderer.on('appearance-shell:state', (_event, next: AppearanceShellState) => {
  if (next.activeChatId !== state?.activeChatId) { pasteEpoch++; currentPaste = undefined; }
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
const chatMenuAction = (id: number, action: string, extra: Record<string, unknown> = {}) => {
  const chat = state?.chats.find(chat => chat.id === id);
  if (!navigator.userActivation.isActive || state?.library?.busy || !chat?.actions?.includes(action as any)) return false;
  if (action === 'move' && extra.folderId !== null && !state?.folders.some(folder => folder.id === extra.folderId)) return false;
  if ((action === 'delete' || action === 'leave') && extra.confirmed !== true) return false;
  send({ type: 'chatMenuAction', id, action, ...extra }); return true;
};
const folderMenuAction = (id: number | null, action: string, extra: Record<string, unknown> = {}) => {
  if (!navigator.userActivation.isActive || state?.library?.busy) return false;
  if (action === 'create' ? !state?.library?.canCreateFolder
      : !state?.folders.find(folder => folder.id === id)?.actions?.includes(action as any)) return false;
  if (action === 'delete' && extra.confirmed !== true) return false;
  send({ type: 'folderMenuAction', id, action, ...extra }); return true;
};
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
const voiceAction = (action: 'start' | 'stop' | 'cancel') => {
  const voice = state?.voice;
  if (!navigator.userActivation.isActive || !state?.activeChatId || !voice || pasteBusy) return false;
  if (action === 'start' ? !voice.canStart : action === 'stop' ? voice.status !== 'recording' : voice.status === 'idle') return false;
  send({ type: 'voiceAction', chatId: state.activeChatId, action }); return true;
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
  if (!navigator.userActivation.isActive || !state?.activeChatId || state.sending || state.composer?.busy || pasteBusy) return false;
  if (action === 'choose' ? !state.canSend : action === 'clear' ? !state.composer?.items.length : !state.composer?.items.some(item => item.id === id)) return false;
  send({ type: 'composerAction', chatId: state.activeChatId, action, ...(id ? { id } : {}) }); return true;
};
// Capture files in the isolated world. Do not expose arbitrary clipboard reads, paths or File objects.
window.addEventListener('paste', event => {
  if (!event.isTrusted) return;
  const files = Array.from(event.clipboardData?.files ?? []);
  if (!files.length) return;
  const paste = { event, files, epoch: pasteEpoch, claimed: false };
  currentPaste = paste;
  // A microtask can run between DOM listeners; keep the event until dispatch has finished.
  setTimeout(() => { if (currentPaste === paste) currentPaste = undefined; }, 0);
}, true);
const attachPastedFiles = () => {
  const paste = currentPaste;
  if (!paste || !paste.event.eventPhase || paste.claimed || paste.epoch !== pasteEpoch || pasteBusy
      || !state?.activeChatId || !state.canSend || state.sending || state.composer?.busy) return false;
  paste.claimed = true; pasteBusy = true;
  const chatId = state.activeChatId;
  // Bound the transport, matching the existing raw-image ceiling. Oversized/unreadable files
  // travel as failed reads so the usual composer error is visible instead of a silent failure.
  void (async () => {
    const files = [];
    let total = 0;
    for (const file of paste.files.slice(0, 256)) {
      if (paste.epoch !== pasteEpoch || state?.activeChatId !== chatId) return;
      let bytes: ArrayBuffer | null = null;
      if (file.size <= 50 * 1024 * 1024 - total) {
        total += file.size;
        try { bytes = await file.arrayBuffer(); } catch { /* Report through the shared preparation flow. */ }
      }
      files.push({ name: file.name, type: file.type, bytes });
    }
    if (paste.epoch === pasteEpoch && state?.activeChatId === chatId)
      ipcRenderer.send('appearance-shell:paste', { chatId, files });
  })().finally(() => { pasteBusy = false; });
  return true;
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
const settingsAction = (action: 'open' | 'edit' | 'save' | 'discard' | 'reload', sectionId: string, fieldId?: string, value?: unknown) => {
  const settings = state?.settings, editor = settings?.editor;
  if (!settings?.sections.some(section => section.id === sectionId && section.mode !== 'native')) return false;
  if (action === 'open') {
    if (editor?.busy || editor?.dirty && editor.sectionId !== sectionId) return false;
    send({ type: 'settingsAction', action, sectionId }); return true;
  }
  if (!editor || editor.sectionId !== sectionId || editor.busy || editor.loading) return false;
  if (action === 'save' && (!navigator.userActivation.isActive || !editor.dirty || editor.fields.some(field => field.error))) return false;
  if (action === 'reload' && editor.dirty) return false;
  if (action === 'edit' && (!editor.fields.some(field => field.id === fieldId) || !(typeof value === 'boolean'
      || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 500))) return false;
  send({ type: 'settingsAction', action, sectionId, editorId: editor.id, ...(action === 'edit' ? { fieldId, value } : {}) }); return true;
};
contextBridge.exposeInMainWorld('chatter', {
  getSettingsSections: () => state?.settings?.sections ?? [],
  searchSettings: (query: string) => {
    if (!state?.settings || typeof query !== 'string' || query.length > 200) return false;
    send({ type: 'settingsAction', action: 'search', query }); return true;
  },
  openSettingsSection: (sectionId: string) => settingsAction('open', sectionId),
  setSettingValue: (sectionId: string, fieldId: string, value: unknown) => settingsAction('edit', sectionId, fieldId, value),
  saveSettingsSection: (sectionId: string) => settingsAction('save', sectionId),
  discardSettingsSection: (sectionId: string) => settingsAction('discard', sectionId),
  reloadSettingsSection: (sectionId: string) => settingsAction('reload', sectionId),
  selectModel: (id: string | null) => {
    if (!navigator.userActivation.isActive || !state?.models || state.models.loading || state.models.busy
        || id !== null && !state.models.items.some(model => model.id === id)) return false;
    send({ type: 'selectModel', id }); return true;
  },
  startVoiceRecording: () => voiceAction('start'),
  stopVoiceRecording: () => voiceAction('stop'),
  cancelVoiceRecording: () => voiceAction('cancel'),
  getChatMenu: (id: number) => (state?.chats.find(chat => chat.id === id)?.actions ?? []).map(action => ({
    id: action, disabled: Boolean(state?.library?.busy), dangerous: action === 'delete' || action === 'leave',
    requiresConfirmation: action === 'delete' || action === 'leave',
    label: action === 'setBotHidden' ? state!.labels[state!.chats.find(chat => chat.id === id)?.botHidden ? 'showInBot' : 'hideFromBot'] ?? action
      : state!.labels[{ rename: 'renameChat', downloadDocx: 'downloadDocx', move: 'moveChat', delete: 'delete', leave: 'leaveChat' }[action] ?? action] ?? action,
  })),
  getFolderMenu: (id: number) => (state?.folders.find(folder => folder.id === id)?.actions ?? []).map(action => ({
    id: action, disabled: Boolean(state?.library?.busy), dangerous: action === 'delete', requiresConfirmation: action === 'delete',
    label: state!.labels[action === 'rename' ? 'renameFolder' : 'deleteFolder'] ?? action,
  })),
  renameChat: (id: number, title: string) => typeof title === 'string' && Boolean(title.trim()) && title.trim().length <= 120 && chatMenuAction(id, 'rename', { title: title.trim() }),
  downloadChatDocx: (id: number) => chatMenuAction(id, 'downloadDocx'),
  moveChat: (id: number, folderId: number | null) => chatMenuAction(id, 'move', { folderId }),
  setChatBotHidden: (id: number, hidden: boolean) => typeof hidden === 'boolean' && chatMenuAction(id, 'setBotHidden', { hidden }),
  deleteChat: (id: number, confirmed: boolean) => chatMenuAction(id, 'delete', { confirmed }),
  leaveChat: (id: number, confirmed: boolean) => chatMenuAction(id, 'leave', { confirmed }),
  createFolder: (name: string) => typeof name === 'string' && Boolean(name.trim()) && name.trim().length <= 80 && folderMenuAction(null, 'create', { name: name.trim() }),
  renameFolder: (id: number, name: string) => typeof name === 'string' && Boolean(name.trim()) && name.trim().length <= 80 && folderMenuAction(id, 'rename', { name: name.trim() }),
  deleteFolder: (id: number, confirmed: boolean) => folderMenuAction(id, 'delete', { confirmed }),
  imageSource: (messageId: number, source: string, width = 560) =>
    imageSource(messageId, source, Math.max(64, Math.min(1600, Math.round(Number(width) || 560)))),
  fullImageSource: (messageId: number, source: string) => imageSource(messageId, source, 0),
  readAttachment: (id: number, index: number) => documentRequest('readAttachment', id, index),
  renderAttachmentPage: (id: number, index: number, page: number, width = 1000) => {
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000) return Promise.reject(new Error('attachment_page_unavailable'));
    return documentRequest('renderAttachmentPage', id, index, page, Math.max(128, Math.min(1600, Math.round(Number(width) || 1000))));
  },
  chooseAttachments: () => composerAction('choose'),
  attachPastedFiles,
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
    const navigation = options?.navigation === true, confirmations = options?.confirmations === true;
    if (navigation && ++navigationSubscribers === 1) ipcRenderer.send('appearance-shell:navigation', true);
    if (confirmations && ++confirmationSubscribers === 1) ipcRenderer.send('appearance-shell:confirmations', true);
    listeners.add(listener);
    if (state) listener(state);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners.delete(listener);
      if (navigation && --navigationSubscribers === 0) ipcRenderer.send('appearance-shell:navigation', false);
      if (confirmations && --confirmationSubscribers === 0) ipcRenderer.send('appearance-shell:confirmations', false);
    };
  },
  openChat: (id: number) => send({ type: 'openChat', id }),
  newChat: () => send({ type: 'newChat' }),
  sendMessage: (text: string) => {
    if (!navigator.userActivation.isActive || !state?.canSend || pasteBusy || typeof text !== 'string' || text.length > 100000 || !text.trim() && !state.attachmentCount) return false;
    send({ type: 'sendMessage', chatId: state.activeChatId, text });
    return true;
  },
  stopGeneration: () => send({ type: 'stopGeneration', chatId: state?.activeChatId }),
  loadOlderMessages: () => send({ type: 'loadOlderMessages', chatId: state?.activeChatId }),
  openConversation: () => send({ type: 'openConversation' }),
  showHome: () => send({ type: 'home' }),
  attachFiles: () => composerAction('choose'),
  openLibrary: () => send({ type: 'openLibrary' }),
  openSettings: (sectionId?: string, target?: string) => {
    if (sectionId !== undefined && (!navigator.userActivation.isActive || !state?.settings?.sections.some(section => section.id === sectionId))) return false;
    if (target !== undefined && (sectionId === undefined || typeof target !== 'string' || target.length > 200)) return false;
    send({ type: 'openSettings', ...(sectionId === undefined ? {} : { sectionId }), ...(target === undefined ? {} : { target }) }); return true;
  },
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
// Observe the modal before theme listeners/browser default actions can close it. A dialog's
// cancel event is distinct from keydown: consuming cancel need not prevent that keydown.
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const modal = document.querySelector('dialog:modal');
  setTimeout(() => {
    if (!modal && !event.defaultPrevented) ipcRenderer.send('appearance-shell:escape');
  }, 0);
}, true);
