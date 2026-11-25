import * as React from 'react';
import type { AppearanceShellState } from '../main/appearance-shell-types';
import { useChatterState } from './chatter-state';
import { SettingsFormStore, type SettingsResult } from './settings-store';
import { scheduleSdkRead } from './settings-sdk';
import {
  chatScope,
  chatSnapshot,
  chatCurrent,
  chatStore,
  ComposerStore,
  ConfirmationFieldsStore,
  conversationTimeline,
  previewTask,
} from './chat-store';

type State = AppearanceShellState;
export type ChatMessage = State['messages'][number];
export type ChatMessageAction = ChatMessage['actions'][number];
export type ChatReasoningLevel = NonNullable<
  NonNullable<State['models']>['reasoning']
>['selectedLevel'];
export type ChatDocument = {
  kind: 'pdf' | 'docx' | 'spreadsheet' | 'text' | 'unsupported';
  name: string;
  mimeType: string;
  sizeBytes: number;
  text: string;
  html?: string;
  pageCount?: number;
};
export type ChatDocumentPage = {
  source: string;
  width: number;
  height: number;
  page: number;
  pageCount: number;
};
export type ChatResult<T = void> = SettingsResult<T>;

type Bridge = {
  sendMessage(text: string): boolean;
  stopGeneration(): void;
  loadOlderMessages(): void;
  chooseAttachments(): boolean;
  attachPastedFiles(): boolean;
  removePendingAttachment(id: string): boolean;
  clearPendingAttachments(): boolean;
  pendingAttachmentSource(id: string): string;
  selectModel(id: string | null): boolean;
  selectReasoning(level: ChatReasoningLevel): boolean;
  startVoiceRecording(): boolean;
  stopVoiceRecording(): boolean;
  cancelVoiceRecording(): boolean;
  pauseSpeech(): boolean;
  resumeSpeech(): boolean;
  stopSpeech(): boolean;
  copyMessage(id: number): boolean;
  downloadMessageDocx(id: number): boolean;
  sendMessageToTelegram(id: number): boolean;
  forkFromMessage(id: number): boolean;
  deleteMessage(id: number): boolean;
  speakMessage(id: number): boolean;
  editMessage(id: number, text: string, variant?: number): boolean;
  regenerateMessage(id: number, hint?: string): boolean;
  activateMessageVariant(id: number, index: number): boolean;
  openImage(id: number, url: string): boolean;
  downloadImage(id: number, url: string): boolean;
  imageSource(id: number, url: string, width?: number): string;
  fullImageSource(id: number, url: string): string;
  openAttachment(id: number, index: number): boolean;
  downloadAttachment(id: number, index: number): boolean;
  openLink(id: number, url: string): boolean;
  copyText(id: number, text: string): boolean;
  readAttachment(id: number, index: number): Promise<ChatDocument>;
  renderAttachmentPage(
    id: number,
    index: number,
    page: number,
    width?: number,
  ): Promise<ChatDocumentPage>;
  runConfirmationAction(id: string, action: string, revision: number, comment?: string): boolean;
  setConfirmationField(id: string, field: string, value: string | boolean): boolean;
  reviewConfirmation(id: string): boolean;
  openChat(id: number): void;
  newChat(): void;
  showHome(): void;
  openLibrary(): void;
  openConversation(): void;
  search(query: string): void;
  loadMore(folderId: number | null): void;
  getChatMenu(id: number): {
    id: string;
    label: string;
    disabled: boolean;
    dangerous: boolean;
    requiresConfirmation: boolean;
  }[];
  getFolderMenu(id: number): {
    id: string;
    label: string;
    disabled: boolean;
    dangerous: boolean;
    requiresConfirmation: boolean;
  }[];
  renameChat(id: number, title: string): boolean;
  downloadChatDocx(id: number): boolean;
  moveChat(id: number, folderId: number | null): boolean;
  setChatBotHidden(id: number, hidden: boolean): boolean;
  deleteChat(id: number, confirmed: boolean): boolean;
  leaveChat(id: number, confirmed: boolean): boolean;
  createFolder(name: string): boolean;
  renameFolder(id: number, name: string): boolean;
  deleteFolder(id: number, confirmed: boolean): boolean;
};
const bridge = () => (window as unknown as { chatter: Bridge }).chatter;
const messageAt = (id: number | null | undefined) =>
  chatSnapshot()?.messages.find((message) => message.id === id);
function messageOwner(state: State | undefined, message: ChatMessage | undefined) {
  const owner = chatScope(state),
    chatId = state?.activeChatId,
    id = message?.id,
    variant = message?.variantIndex;
  return () =>
    chatCurrent(owner, chatId) && id !== undefined && messageAt(id)?.variantIndex === variant;
}
const actionLabels: Record<ChatMessageAction, string> = {
  copy: 'copy',
  downloadDocx: 'downloadDocx',
  sendTelegram: 'sendTelegram',
  fork: 'fork',
  edit: 'edit',
  delete: 'delete',
  regenerate: 'regenerate',
  regenerateHint: 'regenerateHint',
  speak: 'speak',
  activateVariant: 'nextVariant',
};

export function useComposer({
  submitOnEnter = true,
  voiceTranscript = true,
}: { submitOnEnter?: boolean; voiceTranscript?: boolean } = {}) {
  const state = useChatterState(),
    owner = chatScope(state),
    chatId = state?.activeChatId;
  const draft = React.useMemo(
    () =>
      chatStore('composer:' + chatId, () => new ComposerStore(() => chatCurrent(owner, chatId))),
    [owner, chatId],
  );
  const local = React.useSyncExternalStore(draft.subscribe, draft.getSnapshot);
  React.useLayoutEffect(() => {
    if (voiceTranscript) draft.appendTranscript(state?.voice?.transcript);
  }, [draft, voiceTranscript, state?.voice?.transcript]);
  const current = () => chatCurrent(owner, chatId);
  const canSend =
    !!state?.canSend &&
    !state.sending &&
    !state.composer?.busy &&
    !!(local.text.trim() || state.attachmentCount);
  const send = (text?: string) =>
    draft.send(
      current() ? chatSnapshot() : undefined,
      (value) => bridge().sendMessage(value),
      text,
    );
  const submit = (event?: { preventDefault(): void }) => {
    event?.preventDefault();
    return send();
  };
  const choose = () => current() && bridge().chooseAttachments();
  const onPaste = (event: { preventDefault(): void }) => {
    if (!current() || !bridge().attachPastedFiles()) return false;
    event.preventDefault();
    return true;
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (
      submitOnEnter &&
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.defaultPrevented &&
      !event.nativeEvent.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      send();
    }
  };
  return {
    chatId: chatId ?? null,
    ready: !!state && !!chatId && !state.messagesLoading,
    text: local.text,
    setText: draft.setText,
    clear: () => draft.setText(''),
    canSend,
    send,
    submit,
    sending: state?.sending ?? false,
    busy: state?.composer?.busy ?? false,
    error: state?.composer?.error ?? null,
    limits: state?.composer?.limits,
    items: (state?.composer?.items ?? []).map((item) => ({
      ...item,
      source: item.kind === 'image' ? bridge().pendingAttachmentSource(item.id) : '',
      remove: () => current() && bridge().removePendingAttachment(item.id),
    })),
    chooseAttachments: choose,
    clearAttachments: () => current() && bridge().clearPendingAttachments(),
    onPaste,
    onKeyDown,
    stop: () => {
      if (!current() || !chatSnapshot()?.sending) return false;
      bridge().stopGeneration();
      return true;
    },
    bind: () => ({
      value: local.text,
      maxLength: 100000,
      disabled: !chatId || !!state?.messagesLoading,
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        draft.setText(event.currentTarget.value);
      },
      onPaste,
      onKeyDown,
    }),
  };
}

export function useVoice() {
  const state = useChatterState(),
    owner = chatScope(state),
    chatId = state?.activeChatId;
  const current = () => chatCurrent(owner, chatId);
  return {
    status: state?.voice?.status ?? 'idle',
    canStart: state?.voice?.canStart ?? false,
    error: state?.voice?.error ?? null,
    transcript: state?.voice?.transcript ?? null,
    start: () => current() && bridge().startVoiceRecording(),
    stop: () => current() && bridge().stopVoiceRecording(),
    cancel: () => current() && bridge().cancelVoiceRecording(),
  };
}
export function useSpeech() {
  const state = useChatterState(),
    owner = chatScope(state),
    chatId = state?.activeChatId;
  const current = () => chatCurrent(owner, chatId);
  return {
    messageId: state?.speech?.messageId ?? null,
    status: state?.speech?.status ?? 'idle',
    pause: () => current() && bridge().pauseSpeech(),
    resume: () => current() && bridge().resumeSpeech(),
    stop: () => current() && bridge().stopSpeech(),
  };
}
export function useModels() {
  const state = useChatterState(),
    owner = chatScope(state),
    models = state?.models;
  const current = () => chatCurrent(owner);
  const select = (id: string | null) => current() && bridge().selectModel(id);
  const setReasoning = (level: ChatReasoningLevel) => current() && bridge().selectReasoning(level);
  return {
    ready: !!models && !models.loading,
    loading: !models || models.loading,
    busy: models?.busy ?? false,
    error: models?.error ?? null,
    selectedId: models?.selectedId ?? null,
    items: models?.items ?? [],
    options: models
      ? [
          { value: '', label: models.automaticLabel },
          ...models.items.map((item) => ({ value: item.id, label: item.name })),
        ]
      : [],
    automaticSupportsVision: models?.automaticSupportsVision ?? false,
    contextLimit: models?.contextLimit ?? null,
    selected: models?.items.find((item) => item.id === models.selectedId) ?? null,
    select,
    bind: () => ({
      value: models?.selectedId ?? '',
      disabled: !models || models.loading || models.busy,
      onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
        select(event.currentTarget.value || null);
      },
    }),
    reasoning: {
      label: models?.reasoning?.label ?? '',
      value: models?.reasoning?.selectedLevel ?? null,
      available: (models?.reasoning?.options.length ?? 0) > 1,
      options: models?.reasoning?.options ?? [],
      select: setReasoning,
      bind: () => ({
        value: models?.reasoning?.selectedLevel ?? '',
        disabled: !models?.reasoning || models.loading || models.busy,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
          setReasoning((event.currentTarget.value || null) as ChatReasoningLevel);
        },
      }),
    },
  };
}
export function useConversation({ navigation = false }: { navigation?: boolean } = {}) {
  const state = useChatterState({ navigation }),
    owner = chatScope(state),
    chatId = state?.activeChatId;
  const context = state?.context;
  return {
    ready: !!state,
    chatId: chatId ?? null,
    view: state?.view ?? 'home',
    messages: state?.messages ?? [],
    timeline: React.useMemo(
      () => (state ? conversationTimeline(state) : []),
      [state?.messages, context?.summary],
    ),
    loading: state?.messagesLoading ?? true,
    sending: state?.sending ?? false,
    hasOlder: state?.hasOlderMessages ?? false,
    loadingOlder: state?.olderMessagesLoading ?? false,
    context,
    summary: context?.summary ?? null,
    loadOlder: () => {
      const live = chatSnapshot();
      if (
        !chatCurrent(owner, chatId) ||
        !live?.hasOlderMessages ||
        live.olderMessagesLoading ||
        live.messagesLoading
      )
        return false;
      bridge().loadOlderMessages();
      return true;
    },
  };
}

export type MessageActionInput = { text?: string; hint?: string; index?: number };
export function useMessage(id: number) {
  const state = useChatterState(),
    message = state?.messages.find((item) => item.id === id),
    current = messageOwner(state, message);
  const can = (action: ChatMessageAction) => current() && !!messageAt(id)?.actions.includes(action);
  const run = (action: ChatMessageAction, input: MessageActionInput = {}) => {
    if (!can(action)) return false;
    if (
      input.hint !== undefined &&
      (typeof input.hint !== 'string' || !input.hint.trim() || input.hint.length > 10000)
    )
      return false;
    const api = bridge();
    switch (action) {
      case 'copy':
        return api.copyMessage(id);
      case 'downloadDocx':
        return api.downloadMessageDocx(id);
      case 'sendTelegram':
        return api.sendMessageToTelegram(id);
      case 'fork':
        return api.forkFromMessage(id);
      case 'delete':
        return api.deleteMessage(id);
      case 'edit':
        return input.text !== undefined && api.editMessage(id, input.text, message!.variantIndex);
      case 'regenerate':
        return api.regenerateMessage(id, input.hint);
      case 'regenerateHint':
        return input.hint !== undefined && api.regenerateMessage(id, input.hint);
      case 'activateVariant':
        return (
          input.index !== undefined &&
          Number.isSafeInteger(input.index) &&
          input.index >= 0 &&
          input.index < (message?.variantCount ?? 0) &&
          api.activateMessageVariant(id, input.index)
        );
      case 'speak':
        return state?.speech?.messageId === id && state.speech.status === 'playing'
          ? api.pauseSpeech()
          : state?.speech?.messageId === id && state.speech.status === 'paused'
            ? api.resumeSpeech()
            : api.speakMessage(id);
    }
  };
  const hasBody = !!(
    message?.content.trim() ||
    message?.images.length ||
    message?.attachments.length
  );
  const steps = message?.workLog ?? [],
    status = message?.toolStatus;
  const currentActivity =
    status &&
    !steps.some(
      (step) =>
        (step.type === 'activity' && step.text === status) ||
        (step.type === 'tool' && step.call.status === 'running'),
    )
      ? status
      : null;
  return {
    message,
    exists: !!message,
    hasBody,
    streaming: message?.streaming ?? false,
    hasActivity: !!(
      message?.reasoningContent.trim() ||
      message?.workLog.length ||
      message?.toolStatus
    ),
    activity: { steps, status: currentActivity },
    info: message?.info,
    can,
    run,
    speechStatus: state?.speech?.messageId === id ? state.speech.status : ('idle' as const),
    actions: (message?.actions ?? []).map((action) => ({
      id: action,
      label:
        state?.labels[
          action === 'speak' && state.speech?.messageId === id
            ? state.speech.status === 'playing'
              ? 'pauseSpeech'
              : state.speech.status === 'paused'
                ? 'resumeSpeech'
                : state.speech.status === 'loading'
                  ? 'loading'
                  : 'speak'
            : actionLabels[action]
        ] ?? action,
      requiresInput: ['edit', 'regenerateHint', 'activateVariant'].includes(action),
      run: (input?: MessageActionInput) => run(action, input),
    })),
    variants: {
      index: message?.variantIndex ?? 0,
      count: message?.variantCount ?? 0,
      previous: () => run('activateVariant', { index: (message?.variantIndex ?? 0) - 1 }),
      next: () => run('activateVariant', { index: (message?.variantIndex ?? 0) + 1 }),
      select: (index: number) => run('activateVariant', { index }),
    },
    copy: () => run('copy'),
    edit: (text: string) => run('edit', { text }),
    regenerate: (hint?: string) =>
      run(hint === undefined ? 'regenerate' : 'regenerateHint', { hint }),
    speak: () => run('speak'),
    stopSpeech: () =>
      current() && chatSnapshot()?.speech?.messageId === id && bridge().stopSpeech(),
    copyText: (text: string) => current() && bridge().copyText(id, text),
    openLink: (url: string) => current() && bridge().openLink(id, url),
  };
}

function useTextForm(
  key: string,
  value: string | undefined,
  current: () => boolean,
  write: (text: string) => boolean,
  limit: number,
) {
  const owner = chatScope();
  const form = React.useMemo(
    () =>
      chatStore(
        key,
        () =>
          new SettingsFormStore<{ text: string }>(current, (draft) =>
            !draft.text.trim() || draft.text.length > limit ? { text: 'text_invalid' } : {},
          ),
      ),
    [owner, key],
  );
  const state = React.useSyncExternalStore(form.subscribe, form.getSnapshot);
  React.useLayoutEffect(() => {
    if (value !== undefined) form.receive({ text: value });
  }, [form, value]);
  const save = () =>
    form.save(async (draft) => {
      if (!current() || !write(draft.text)) throw new Error('chat_action_unavailable');
      return draft;
    });
  return {
    text: state.draft?.text ?? '',
    dirty: state.dirty,
    busy: state.busy,
    error: state.error,
    conflict: state.conflict,
    errors: state.errors,
    ready: !!state.draft,
    canSave:
      !!state.draft &&
      state.dirty &&
      !state.busy &&
      !state.conflict &&
      !Object.keys(state.errors).length &&
      current(),
    setText: (text: string) => {
      if (current()) form.set('text', text);
    },
    discard: () => {
      if (current()) form.discard();
    },
    rebase: () => {
      if (current()) form.rebase();
    },
    save,
    submit: (event?: { preventDefault(): void }) => {
      event?.preventDefault();
      return save();
    },
    bind: () => ({
      value: state.draft?.text ?? '',
      maxLength: limit,
      disabled: state.busy || !state.draft || !current(),
      'aria-invalid': !!state.errors.text,
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        if (current()) form.set('text', event.currentTarget.value);
      },
    }),
  };
}
export function useMessageEditor(id: number) {
  const state = useChatterState(),
    message = state?.messages.find((item) => item.id === id),
    current = messageOwner(state, message);
  return useTextForm(
    'message-edit:' + state?.activeChatId + ':' + id + ':' + message?.variantIndex,
    message?.editableContent ?? message?.content,
    () => current() && !!messageAt(id)?.actions.includes('edit'),
    (text) => bridge().editMessage(id, text, message!.variantIndex),
    100000,
  );
}

export function useImage(
  messageId: number | null,
  url: string | null,
  { fullSize = false, width = 560 }: { fullSize?: boolean; width?: number } = {},
) {
  const state = useChatterState(),
    message = state?.messages.find((item) => item.id === messageId),
    current = messageOwner(state, message);
  const identity =
    chatScope(state) +
    ':' +
    state?.activeChatId +
    ':' +
    messageId +
    ':' +
    message?.variantIndex +
    ':' +
    url +
    ':' +
    fullSize +
    ':' +
    width;
  const [failure, setFailure] = React.useState<string>(),
    [retry, setRetry] = React.useState(0);
  const source = React.useMemo(
    () =>
      messageId !== null && url && message
        ? fullSize
          ? bridge().fullImageSource(messageId, url)
          : bridge().imageSource(messageId, url, width)
        : '',
    [identity],
  );
  const failed = failure === identity;
  return {
    source,
    failed,
    key: identity + ':' + retry,
    onError: () => {
      if (current()) setFailure(identity);
    },
    onLoad: () => {
      if (current()) setFailure(undefined);
    },
    retry: () => {
      if (current()) {
        setFailure(undefined);
        setRetry((value) => value + 1);
      }
    },
    openNative: () => current() && !!url && bridge().openImage(messageId!, url),
    download: () => current() && !!url && bridge().downloadImage(messageId!, url),
    fullSource: () => (current() && url ? bridge().fullImageSource(messageId!, url) : ''),
  };
}
export function useImageViewer() {
  const state = useChatterState();
  const owner = chatScope(state);
  const [target, setTarget] = React.useState<{
    owner: string | undefined;
    chatId: number | null;
    messageId: number;
    variant: number;
    url: string;
    alt: string;
  }>();
  const valid =
    target &&
    chatCurrent(target.owner, target.chatId) &&
    messageAt(target.messageId)?.variantIndex === target.variant;
  const image = useImage(valid ? target.messageId : null, valid ? target.url : null, {
    fullSize: true,
  });
  return {
    ...image,
    visible: !!valid,
    alt: valid ? target.alt : '',
    close: () => setTarget(undefined),
    open: (messageId: number, url: string, alt = '') => {
      const message = messageAt(messageId);
      if (
        !state?.activeChatId ||
        !chatCurrent(owner, state.activeChatId) ||
        !message ||
        !bridge().fullImageSource(messageId, url)
      )
        return false;
      setTarget({
        owner: chatScope(state),
        chatId: state.activeChatId,
        messageId,
        variant: message.variantIndex,
        url,
        alt,
      });
      return true;
    },
  };
}

function usePreviewResource<T>(
  key: string,
  valid: () => boolean,
  read: () => Promise<T>,
  enabled: boolean,
) {
  const owner = chatScope();
  const task = React.useMemo(() => previewTask<T>(owner, key, valid), [owner, key]);
  const state = React.useSyncExternalStore(task.subscribe, task.getSnapshot);
  const load = () =>
    scheduleSdkRead(() => {
      if (!valid()) throw new Error('attachment_scope_changed');
      return read();
    });
  React.useEffect(() => {
    if (enabled && valid()) void task.load(load);
  }, [task, enabled]);
  return {
    data: state.data,
    loading: state.loading,
    busy: state.busy,
    error: state.error,
    read: () =>
      valid()
        ? task.load(load)
        : Promise.resolve({ ok: false, error: 'attachment_scope_changed' } as const),
    reload: () =>
      valid()
        ? task.load(load, true)
        : Promise.resolve({ ok: false, error: 'attachment_scope_changed' } as const),
  };
}
export function useDocument(
  messageId: number | null,
  index: number | null,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const state = useChatterState(),
    message = state?.messages.find((item) => item.id === messageId),
    current = messageOwner(state, message);
  const file = index === null ? undefined : message?.attachments[index];
  const valid = () =>
    current() &&
    messageId! > 0 &&
    !!file &&
    messageAt(messageId)?.attachments[index!]?.url === file.url;
  const resource = usePreviewResource<ChatDocument>(
    'document:' +
      state?.activeChatId +
      ':' +
      messageId +
      ':' +
      message?.variantIndex +
      ':' +
      index +
      ':' +
      file?.url,
    valid,
    () => bridge().readAttachment(messageId!, index!),
    enabled && !!file,
  );
  return {
    ...resource,
    file,
    available: !!file,
    openNative: () => valid() && bridge().openAttachment(messageId!, index!),
    download: () => valid() && bridge().downloadAttachment(messageId!, index!),
  };
}
export function useDocumentPage(
  messageId: number | null,
  index: number | null,
  page: number,
  { width = 1000, enabled = true }: { width?: number; enabled?: boolean } = {},
) {
  const state = useChatterState(),
    message = state?.messages.find((item) => item.id === messageId),
    current = messageOwner(state, message);
  const renderWidth = Math.max(128, Math.min(1600, Math.round(Number(width) || 1000)));
  const file = index === null ? undefined : message?.attachments[index];
  const valid = () =>
    current() &&
    messageId! > 0 &&
    !!file &&
    messageAt(messageId)?.attachments[index!]?.url === file.url &&
    Number.isInteger(page) &&
    page >= 1 &&
    page <= 100000;
  return usePreviewResource<ChatDocumentPage>(
    'page:' +
      state?.activeChatId +
      ':' +
      messageId +
      ':' +
      message?.variantIndex +
      ':' +
      index +
      ':' +
      file?.url +
      ':' +
      page +
      ':' +
      renderWidth,
    valid,
    () => bridge().renderAttachmentPage(messageId!, index!, page, renderWidth),
    enabled && !!file,
  );
}
export function useDocumentViewer() {
  const state = useChatterState();
  const owner = chatScope(state);
  const [target, setTarget] = React.useState<{
    owner: string | undefined;
    chatId: number | null;
    messageId: number;
    variant: number;
    index: number;
    url: string;
  }>();
  const [page, setPageValue] = React.useState(1);
  const valid =
    !!target &&
    chatCurrent(target.owner, target.chatId) &&
    messageAt(target.messageId)?.variantIndex === target.variant &&
    messageAt(target.messageId)?.attachments[target.index]?.url === target.url;
  const document = useDocument(valid ? target.messageId : null, valid ? target.index : null);
  const renderedPage = useDocumentPage(
    valid ? target.messageId : null,
    valid ? target.index : null,
    page,
    { enabled: document.data?.kind === 'pdf' },
  );
  return {
    ...document,
    visible: valid,
    page,
    renderedPage,
    setPage: (next: number) => {
      if (Number.isInteger(next) && next >= 1 && next <= (document.data?.pageCount ?? 1))
        setPageValue(next);
    },
    close: () => setTarget(undefined),
    open: (messageId: number, index: number) => {
      const message = messageAt(messageId),
        file = message?.attachments[index];
      if (
        !state?.activeChatId ||
        !chatCurrent(owner, state.activeChatId) ||
        messageId <= 0 ||
        !message ||
        !file
      )
        return false;
      setTarget({
        owner: chatScope(state),
        chatId: state.activeChatId,
        messageId,
        variant: message.variantIndex,
        index,
        url: file.url,
      });
      setPageValue(1);
      return true;
    },
  };
}

export function useConfirmations() {
  const state = useChatterState({ confirmations: true });
  return {
    ready: !!state,
    items: state?.confirmations ?? [],
    count: state?.confirmations?.length ?? 0,
  };
}
export function useConfirmation(id: string) {
  const state = useChatterState(),
    owner = chatScope(state),
    card = state?.confirmations.find((item) => item.id === id);
  const fieldsStore = React.useMemo(
    () =>
      chatStore(
        'confirmation:' + id,
        () =>
          new ConfirmationFieldsStore(
            () =>
              chatCurrent(owner) && !!chatSnapshot()?.confirmations.some((item) => item.id === id),
          ),
      ),
    [owner, id],
  );
  const pending = React.useSyncExternalStore(fieldsStore.subscribe, fieldsStore.getSnapshot);
  React.useLayoutEffect(() => {
    fieldsStore.sync(card);
  }, [fieldsStore, card]);
  const waiting = Object.keys(pending).length > 0;
  const current = () =>
    chatCurrent(owner) &&
    !!card &&
    chatSnapshot()?.confirmations.some((item) => item.id === id && item.revision === card.revision);
  const run = (actionId: string, comment?: string) => {
    const action = card?.actions.find((item) => item.id === actionId);
    if (
      !current() ||
      !card?.ready ||
      card.busy ||
      !card.customizable ||
      !action ||
      action.disabled ||
      Object.keys(fieldsStore.getSnapshot()).length > 0 ||
      (comment !== undefined && (typeof comment !== 'string' || comment.length > 10000)) ||
      (action.comment && !comment?.trim())
    )
      return false;
    return bridge().runConfirmationAction(id, actionId, card.revision, comment);
  };
  const set = (fieldId: string, value: string | boolean) => {
    const field = card?.fields.find((item) => item.id === fieldId);
    if (
      !current() ||
      !card?.ready ||
      card.busy ||
      !card.customizable ||
      !field ||
      field.disabled ||
      typeof value !== typeof field.value ||
      (field.options && !field.options.some((option) => option.value === value))
    )
      return false;
    if (value === field.value && fieldsStore.getSnapshot()[fieldId] === undefined) return true;
    return fieldsStore.set(fieldId, value, () => bridge().setConfirmationField(id, fieldId, value));
  };
  return {
    card,
    exists: !!card,
    ready: card?.ready ?? false,
    busy: !!card?.busy || waiting,
    waiting,
    content: card?.content ?? [],
    fields: (card?.fields ?? []).map((field) => ({
      ...field,
      value: pending[field.id] ?? field.value,
      disabled: field.disabled || !!card?.busy || waiting,
      set: (value: string | boolean) => set(field.id, value),
    })),
    actions: (card?.actions ?? []).map((action) => ({
      ...action,
      disabled: action.disabled || !card?.ready || !!card?.busy || waiting,
      run: (comment?: string) => run(action.id, comment),
    })),
    run,
    set,
    review: () => current() && bridge().reviewConfirmation(id),
    bind: (fieldId: string) => {
      const field = card?.fields.find((item) => item.id === fieldId),
        toggle = typeof field?.value === 'boolean';
      return {
        ...(toggle
          ? { checked: !!(pending[fieldId] ?? field?.value) }
          : { value: String(pending[fieldId] ?? field?.value ?? '') }),
        disabled:
          !card?.ready || card.busy || waiting || !card.customizable || !field || field.disabled,
        onChange: (
          event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
        ) => {
          set(
            fieldId,
            toggle ? (event.currentTarget as HTMLInputElement).checked : event.currentTarget.value,
          );
        },
      };
    },
  };
}

export function useChatLibrary({ navigation = false }: { navigation?: boolean } = {}) {
  const state = useChatterState({ navigation }),
    owner = chatScope(state),
    current = () => chatCurrent(owner);
  const chats = state?.chats ?? [],
    folders = state?.folders ?? [];
  const search = (query: string) => {
    if (!current() || typeof query !== 'string' || query.length > 200) return false;
    bridge().search(query);
    return true;
  };
  return {
    ready: !!state,
    chats,
    folders,
    activeChatId: state?.activeChatId ?? null,
    query: state?.query ?? '',
    loading: state?.loading ?? true,
    busy: state?.library?.busy ?? false,
    error: state?.library?.error ?? null,
    canCreateFolder: state?.library?.canCreateFolder ?? false,
    limits: state?.library?.limits,
    groups: (state?.sections ?? []).map((section) => ({
      ...section,
      name:
        section.folderId === null
          ? (state?.labels.unfiled ?? '')
          : (folders.find((folder) => folder.id === section.folderId)?.name ?? ''),
      chats: chats.filter((chat) => chat.folderId === section.folderId),
    })),
    search,
    bindSearch: () => ({
      value: state?.query ?? '',
      maxLength: 200,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
        search(event.currentTarget.value);
      },
    }),
    open: (id: number) => {
      if (!current() || !chatSnapshot()?.chats.some((chat) => chat.id === id)) return false;
      bridge().openChat(id);
      return true;
    },
    newChat: () => {
      if (!current()) return false;
      bridge().newChat();
      return true;
    },
    home: () => {
      if (!current()) return false;
      bridge().showHome();
      return true;
    },
    openNative: () => {
      if (!current()) return false;
      bridge().openLibrary();
      return true;
    },
    openNativeConversation: () => {
      if (!current()) return false;
      bridge().openConversation();
      return true;
    },
    loadMore: (folderId: number | null) => {
      const section = chatSnapshot()?.sections.find((item) => item.folderId === folderId);
      if (!current() || !section?.hasMore || section.loading) return false;
      bridge().loadMore(folderId);
      return true;
    },
  };
}
export function useChatMenu(id: number) {
  const state = useChatterState(),
    owner = chatScope(state),
    chat = state?.chats.find((item) => item.id === id);
  const current = () =>
    chatCurrent(owner) && !!chatSnapshot()?.chats.some((item) => item.id === id);
  return {
    chat,
    items: chat ? bridge().getChatMenu(id) : [],
    busy: state?.library?.busy ?? false,
    error: state?.library?.error ?? null,
    rename: (title: string) => current() && bridge().renameChat(id, title),
    download: () => current() && bridge().downloadChatDocx(id),
    move: (folderId: number | null) => current() && bridge().moveChat(id, folderId),
    setBotHidden: (hidden: boolean) => current() && bridge().setChatBotHidden(id, hidden),
    remove: (confirmed: boolean) =>
      current() && confirmed === true && bridge().deleteChat(id, true),
    leave: (confirmed: boolean) => current() && confirmed === true && bridge().leaveChat(id, true),
  };
}
export function useFolderMenu(id: number) {
  const state = useChatterState(),
    owner = chatScope(state),
    folder = state?.folders.find((item) => item.id === id);
  const current = () =>
    chatCurrent(owner) && !!chatSnapshot()?.folders.some((item) => item.id === id);
  return {
    folder,
    items: folder ? bridge().getFolderMenu(id) : [],
    busy: state?.library?.busy ?? false,
    error: state?.library?.error ?? null,
    rename: (name: string) => current() && bridge().renameFolder(id, name),
    remove: (confirmed: boolean) =>
      current() && confirmed === true && bridge().deleteFolder(id, true),
  };
}
export function useChatEditor(id: number) {
  const state = useChatterState(),
    owner = chatScope(state),
    chat = state?.chats.find((item) => item.id === id);
  const current = () =>
    chatCurrent(owner) &&
    !!chatSnapshot()?.chats.some((item) => item.id === id && item.actions?.includes('rename')) &&
    !chatSnapshot()?.library?.busy;
  return useTextForm(
    'chat-rename:' + id,
    chat?.title,
    current,
    (text) => bridge().renameChat(id, text),
    state?.library?.limits.chatTitle ?? 120,
  );
}
export function useFolderEditor(id: number | null) {
  const state = useChatterState(),
    owner = chatScope(state),
    folder = state?.folders.find((item) => item.id === id);
  const current = () =>
    chatCurrent(owner) &&
    !chatSnapshot()?.library?.busy &&
    (id === null
      ? !!chatSnapshot()?.library?.canCreateFolder
      : !!chatSnapshot()?.folders.some(
          (item) => item.id === id && item.actions?.includes('rename'),
        ));
  return useTextForm(
    'folder-edit:' + id,
    id === null ? '' : folder?.name,
    current,
    (text) => (id === null ? bridge().createFolder(text) : bridge().renameFolder(id, text)),
    state?.library?.limits.folderName ?? 80,
  );
}
