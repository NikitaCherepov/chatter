type AppearanceNavigationAction =
  | { type: 'openChat'; id: number }
  | { type: 'newChat' | 'openLibrary' | 'openSettings' | 'openConversation' | 'attachFiles' | 'home' }
  | { type: 'sendMessage'; chatId: number; text: string }
  | { type: 'stopGeneration' | 'loadOlderMessages'; chatId: number }
  | { type: 'loadMore'; folderId: number | null }
  | { type: 'search'; query: string };
export type AppearanceMessageActionName = 'copy' | 'downloadDocx' | 'sendTelegram' | 'fork' | 'edit' | 'delete' | 'regenerate' | 'regenerateHint' | 'speak' | 'activateVariant';
export type AppearanceMessageAction = {
  type: 'messageAction'; chatId: number; messageId: number; variantIndex: number;
  action: AppearanceMessageActionName; hint?: string; index?: number; text?: string; nativeEditor?: boolean;
};
export type AppearanceConfirmationNode = { type: 'text' | 'code' | 'markdown' | 'json' | 'email'; text: string }
  | { type: 'group'; label?: string; children: AppearanceConfirmationNode[] }
  | { type: 'diff'; before: string; after: string } | { type: 'field'; fieldId: string } | { type: 'action'; actionId: string };
export type AppearanceConfirmationField = { id: string; label: string; type: string; value: string | boolean; disabled: boolean; options?: { value: string; label: string }[] };
export type AppearanceConfirmationAction = { id: string; label: string; disabled: boolean; group: 'primary' | 'review' | 'permissions' | 'content'; comment?: boolean };
export type AppearanceConfirmation = { id: string; title: string; summary: string; ready: boolean; revision: number; busy: boolean;
  customizable: boolean; content: AppearanceConfirmationNode[]; fields: AppearanceConfirmationField[]; actions: AppearanceConfirmationAction[] };
export type AppearanceConfirmationRequest = { type: 'confirmationAction'; id: string; actionId: string; revision: number; comment?: string }
  | { type: 'confirmationField'; id: string; fieldId: string; value: string | boolean };
export type AppearanceSpeechAction = { type: 'speechAction'; chatId: number; action: 'pause' | 'resume' | 'stop' };
export type AppearanceReviewAction = { type: 'reviewConfirmation'; id: string };
export type AppearanceShellAction = AppearanceNavigationAction | AppearanceMessageAction | AppearanceSpeechAction | AppearanceReviewAction
  | AppearanceConfirmationRequest
  | { type: 'confirmationPresentation'; custom: boolean };

export type AppearanceToolCall = {
  id?: string; name: string; label: string;
  kind: 'search' | 'note' | 'file' | 'terminal' | 'browser' | 'clock' | 'avatar' | 'tool';
  target: string; status: 'running' | 'error' | 'returned' | 'unknown';
  internal: boolean; confirmed: boolean; arguments: unknown; resultPreview?: string;
  children: AppearanceToolCall[];
};
export type AppearanceWorkLogStep = { type: 'message' | 'activity'; text: string }
  | { type: 'tool'; call: AppearanceToolCall };
export type AppearanceMessageContent = {
  content: string; reasoningContent: string; workLog: AppearanceWorkLogStep[];
  toolStatus: string | null; streaming: boolean;
};

export type AppearanceShellState = {
  chats: Array<{ id: number; title: string; folderId: number | null; updatedAt: number }>;
  folders: Array<{ id: number; name: string; count: number }>;
  sections: Array<{
    folderId: number | null;
    total: number;
    loaded: number;
    hasMore: boolean;
    loading: boolean;
  }>;
  view: 'home' | 'conversation';
  activeChatId: number | null;
  messages: Array<AppearanceMessageContent & { id: number; role: string; createdAt: number;
    variantIndex: number; variantCount: number; actions: AppearanceMessageActionName[]; editableContent?: string }>;
  speech: { messageId: number | null; status: 'idle' | 'loading' | 'playing' | 'paused' };
  confirmations: AppearanceConfirmation[];
  messagesLoading: boolean;
  hasOlderMessages: boolean;
  olderMessagesLoading: boolean;
  sending: boolean;
  canSend: boolean;
  attachmentCount: number;
  query: string;
  loading: boolean;
  locale: string;
  dark: boolean;
  palette: { background: string; text: string; accent: string; surface: string };
  labels: Record<
    'newChat' | 'allChats' | 'settings' | 'search' | 'loadMore' | 'loading' | 'empty',
    string
  > & Record<string, string>;
};

export type AppearanceShellEvent = { id: string; action: AppearanceShellAction };

export function parseAppearanceShellAction(value: unknown): AppearanceShellAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.id === 'string' && input.id.length > 0 && input.id.length <= 200) {
    if (input.type === 'confirmationAction' && typeof input.actionId === 'string' && /^[a-z0-9-]{1,160}$/.test(input.actionId)
        && Number.isSafeInteger(input.revision) && Number(input.revision) > 0
        && (input.comment === undefined || (typeof input.comment === 'string' && input.comment.length <= 10000)))
      return { type: 'confirmationAction', id: input.id, actionId: input.actionId, revision: Number(input.revision),
        ...(typeof input.comment === 'string' ? { comment: input.comment } : {}) };
    if (input.type === 'confirmationField' && typeof input.fieldId === 'string' && /^[a-z0-9-]{1,160}$/.test(input.fieldId)
        && (typeof input.value === 'boolean' || (typeof input.value === 'string' && input.value.length <= 100000)))
      return { type: 'confirmationField', id: input.id, fieldId: input.fieldId, value: input.value as string | boolean };
  }
  if (input.type === 'reviewConfirmation' && typeof input.id === 'string' && input.id.length > 0 && input.id.length <= 200)
    return { type: 'reviewConfirmation', id: input.id };
  if (input.type === 'openChat' && Number.isSafeInteger(input.id) && Number(input.id) > 0)
    return { type: 'openChat', id: Number(input.id) };
  if (
    input.type === 'loadMore' &&
    (input.folderId === null ||
      (Number.isSafeInteger(input.folderId) && Number(input.folderId) > 0))
  )
    return { type: 'loadMore', folderId: input.folderId as number | null };
  if (input.type === 'search' && typeof input.query === 'string' && input.query.length <= 200)
    return { type: 'search', query: input.query };
  if (Number.isSafeInteger(input.chatId) && Number(input.chatId) > 0) {
    if (input.type === 'speechAction' && ['pause', 'resume', 'stop'].includes(String(input.action)))
      return { type: 'speechAction', chatId: Number(input.chatId), action: input.action as AppearanceSpeechAction['action'] };
    if (input.type === 'messageAction' && Number.isSafeInteger(input.messageId) && Number(input.messageId) > 0
        && Number.isSafeInteger(input.variantIndex) && Number(input.variantIndex) >= 0
        && ['copy', 'downloadDocx', 'sendTelegram', 'fork', 'edit', 'delete', 'regenerate', 'regenerateHint', 'speak', 'activateVariant'].includes(String(input.action))) {
      if (input.hint !== undefined && (typeof input.hint !== 'string' || input.hint.length > 10000 || !input.hint.trim())) return null;
      if (input.action === 'activateVariant' && (!Number.isSafeInteger(input.index) || Number(input.index) < 0)) return null;
      if (input.text !== undefined && (input.action !== 'edit' || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 100000)) return null;
      if (input.nativeEditor !== undefined && (input.action !== 'edit' || input.nativeEditor !== true)) return null;
      if (input.action === 'edit' && input.text === undefined && input.nativeEditor !== true) return null;
      return { type: 'messageAction', chatId: Number(input.chatId), messageId: Number(input.messageId),
        variantIndex: Number(input.variantIndex), action: input.action as AppearanceMessageActionName,
        ...(typeof input.hint === 'string' ? { hint: input.hint } : {}),
        ...(typeof input.text === 'string' ? { text: input.text } : {}), ...(input.nativeEditor === true ? { nativeEditor: true } : {}),
        ...(input.action === 'activateVariant' ? { index: Number(input.index) } : {}) };
    }
    if (
      input.type === 'sendMessage' &&
      typeof input.text === 'string' &&
      input.text.trim() &&
      input.text.length <= 100_000
    )
      return { type: 'sendMessage', chatId: Number(input.chatId), text: input.text };
    if (input.type === 'stopGeneration' || input.type === 'loadOlderMessages')
      return { type: input.type, chatId: Number(input.chatId) };
  }
  if (
    input.type === 'newChat' ||
    input.type === 'openLibrary' ||
    input.type === 'openSettings' ||
    input.type === 'openConversation' ||
    input.type === 'attachFiles' ||
    input.type === 'home'
  )
    return { type: input.type };
  return null;
}

export function canRunAppearanceAction(state: AppearanceShellState, action: AppearanceShellAction): boolean {
  if ('chatId' in action && action.chatId !== state.activeChatId) return false;
  if (action.type === 'messageAction') {
    const message = state.messages.find(message => message.id === action.messageId);
    return Boolean(message && message.variantIndex === action.variantIndex && message.actions.includes(action.action)
      && (action.action !== 'activateVariant' || (action.index! < message.variantCount)));
  }
  if (action.type === 'reviewConfirmation') return Boolean(state.confirmations?.some(item => item.id === action.id));
  if (action.type === 'confirmationAction' || action.type === 'confirmationField') {
    const card = state.confirmations?.find(item => item.id === action.id);
    if (!card?.ready || !card.customizable || card.busy) return false;
    if (action.type === 'confirmationAction') return card.revision === action.revision
      && card.actions.some(item => item.id === action.actionId && !item.disabled && (!item.comment || Boolean(action.comment?.trim())));
    return card.fields.some(item => item.id === action.fieldId && !item.disabled);
  }
  if (action.type === 'speechAction') return state.speech?.messageId != null
    && (action.action === 'stop' || (action.action === 'resume' ? state.speech.status === 'paused' : state.speech.status !== 'paused'));
  return true;
}
