export const APPEARANCE_LABEL_KEYS = ["newChat", "allChats", "settings", "search", "loadMore", "loading", "empty", "workLog", "reasoning", "download", "image", "imageLoadFailed", "copy", "downloadDocx", "sendTelegram", "save", "cancel", "fork", "edit", "delete", "regenerate", "regenerateHint", "speak", "pauseSpeech", "resumeSpeech", "stopSpeech", "reviewConfirmation", "previousVariant", "nextVariant", "renameChat", "moveChat", "hideFromBot", "showInBot", "leaveChat", "createFolder", "renameFolder", "deleteFolder", "unfiled"] as const;
import { parseThemeSettingsAction, canUseThemeSettings, type ThemeSettingsAction, type ThemeSettingsState, type NativeSettingsAction } from './settings-shell-types';
export type AppearanceLabelKey = typeof APPEARANCE_LABEL_KEYS[number];
export type AppearanceLabels = Record<AppearanceLabelKey, string> & Partial<Record<string, string>>;
export type AppearanceChatMenuActionName = 'rename' | 'downloadDocx' | 'move' | 'setBotHidden' | 'delete' | 'leave';
export type AppearanceFolderMenuActionName = 'create' | 'rename' | 'delete';
export type AppearanceChatMenuAction = { type: 'chatMenuAction'; id: number; action: AppearanceChatMenuActionName;
  title?: string; folderId?: number | null; hidden?: boolean; confirmed?: true };
export type AppearanceFolderMenuAction = { type: 'folderMenuAction'; id: number | null; action: AppearanceFolderMenuActionName; name?: string; confirmed?: true };
export type AppearanceMenuItem = { id: string; label: string; disabled: boolean; dangerous: boolean; requiresConfirmation: boolean };

type AppearanceNavigationAction =
  | { type: 'openChat'; id: number }
  | { type: 'newChat' | 'openLibrary' | 'openConversation' | 'attachFiles' | 'home' }
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
export type AppearanceVoiceAction = { type: 'voiceAction'; chatId: number; action: 'start' | 'stop' | 'cancel' };
export type AppearanceModelAction = { type: 'selectModel'; id: string | null };
export type AppearanceTokenUsage = { promptTokens: number; completionTokens: number; totalTokens: number; cacheHitTokens: number; cacheMissTokens: number; reasoningTokens: number };
export type AppearanceMessageInfo = { modelName: string | null; providerName: string | null; tokenCount: number | null;
  tokenCountSource: 'provider' | 'estimate' | null; usage: AppearanceTokenUsage | null;
  performance: { firstTokenLatencyMs: number; generationMs: number; totalMs: number; tokensPerSecond: number } | null };
export type AppearanceModels = { loading: boolean; busy: boolean; error: string | null; selectedId: string | null; automaticLabel: string;
  automaticSupportsVision: boolean; contextLimit: number | null;
  items: { id: string; name: string; description: string; supportsVision: boolean; isFree: boolean; contextLength: number | null;
    averageTokensPerSecond: number | null; intelligenceTier: number | null; priceTier: number | null }[] };
export type AppearanceVoice = { status: 'idle' | 'requesting' | 'recording' | 'transcribing'; canStart: boolean; error: string | null;
  transcript: { id: number; text: string } | null };
export type AppearanceContext = { showTokens: boolean; limit: number | null; tokens: number | null; cachePercent: number | null;
  messagesTokens: number | null; reasoningTokens: number | null; systemPromptTokens: number | null; activeMessages: number | null; archivedMessages: number | null;
  latest: (AppearanceTokenUsage & { modelName: string | null }) | null };
export type AppearanceReviewAction = { type: 'reviewConfirmation'; id: string };
export type AppearanceContentAction = { type: 'contentAction'; chatId: number; messageId: number; variantIndex: number;
  action: 'openImage' | 'downloadImage' | 'openAttachment' | 'downloadAttachment' | 'openLink' | 'copyText'; url?: string; index?: number; text?: string };
export type AppearanceImageRequest = { id: string; requestId: string; chatId: number; messageId: number; variantIndex: number; url: string; width: number; pendingId?: string };
export type AppearanceDocumentRequest = { requestId: string; method: 'readAttachment' | 'renderAttachmentPage'; chatId: number; messageId: number;
  variantIndex: number; index: number; url: string; page?: number; width?: number };
export type AppearanceDocumentPreview = { kind: 'pdf' | 'docx' | 'spreadsheet' | 'text' | 'unsupported'; name: string; mimeType: string; sizeBytes: number;
  text: string; html?: string; pageCount?: number };
export type AppearanceDocumentPage = { source: string; width: number; height: number; page: number; pageCount: number };
export type AppearanceComposerAction = { type: 'composerAction'; chatId: number; action: 'choose' | 'remove' | 'clear'; id?: string };
export type AppearancePasteAction = { type: 'pasteAttachments'; chatId: number; files: { name: string; type: string; bytes: ArrayBuffer | null }[] };
export type AppearanceShellAction = AppearanceNavigationAction | AppearanceMessageAction | AppearanceSpeechAction | AppearanceReviewAction
  | AppearanceConfirmationRequest | AppearanceContentAction | AppearanceComposerAction | AppearancePasteAction | AppearanceChatMenuAction | AppearanceFolderMenuAction | AppearanceVoiceAction | AppearanceModelAction | ThemeSettingsAction | NativeSettingsAction
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
  images: { url: string; type: 'user_photo' | 'generated' | 'external' }[];
  attachments: { url: string; name: string; filename: string; mimeType: string; sizeBytes: number }[];
};

export type AppearanceShellState = {
  chats: Array<{ id: number; title: string; folderId: number | null; updatedAt: number;
    isOwner?: boolean | null; botHidden?: boolean; actions?: AppearanceChatMenuActionName[] }>;
  folders: Array<{ id: number; name: string; count: number; actions?: Exclude<AppearanceFolderMenuActionName, 'create'>[] }>;
  library?: { busy: boolean; operation: string | null; error: string | null; canCreateFolder: boolean;
    limits: { chatTitle: number; folderName: number } };
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
    variantIndex: number; variantCount: number; actions: AppearanceMessageActionName[]; editableContent?: string; info?: AppearanceMessageInfo }>;
  models?: AppearanceModels;
  context?: AppearanceContext;
  voice?: AppearanceVoice;
  settings?: ThemeSettingsState;
  speech: { messageId: number | null; status: 'idle' | 'loading' | 'playing' | 'paused' };
  confirmations: AppearanceConfirmation[];
  messagesLoading: boolean;
  hasOlderMessages: boolean;
  olderMessagesLoading: boolean;
  sending: boolean;
  canSend: boolean;
  attachmentCount: number;
  composer: { busy: boolean; error: string | null; items: { id: string; kind: 'image' | 'document'; name: string; mimeType: string; sizeBytes: number }[];
    limits: { maxImageCount: number; maxImageBytes: number; maxDocumentBytes: number; imageFormats: string[]; documentExtensions: string[] } };
  query: string;
  loading: boolean;
  locale: string;
  dark: boolean;
  palette: { background: string; text: string; accent: string; surface: string };
  labels: AppearanceLabels;
};

export type AppearanceShellEvent = { id: string; action: AppearanceShellAction };

// Only the isolated preload's genuine paste handler sends this channel; generic theme actions cannot.
export function parseAppearancePaste(value: unknown): AppearancePasteAction | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as AppearancePasteAction;
  if (!Number.isSafeInteger(input.chatId) || input.chatId <= 0 || !Array.isArray(input.files) || !input.files.length || input.files.length > 256) return null;
  let size = 0;
  for (const file of input.files) {
    if (!file || typeof file.name !== 'string' || !file.name || file.name.length > 255 || /[\\/\x00]/.test(file.name)
        || typeof file.type !== 'string' || file.type.length > 255 || file.bytes !== null && !(file.bytes instanceof ArrayBuffer)) return null;
    size += file.bytes?.byteLength ?? 0;
    if (size > 50 * 1024 * 1024) return null;
  }
  return { type: 'pasteAttachments', chatId: input.chatId, files: input.files.map(file => ({ name: file.name, type: file.type, bytes: file.bytes })) };
}

export function parseAppearanceShellAction(value: unknown): AppearanceShellAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.type === 'settingsAction') return parseThemeSettingsAction(input);
  if (input.type === 'openSettings') {
    if (input.sectionId === undefined && input.target === undefined) return { type: 'openSettings' };
    if (typeof input.sectionId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.sectionId)
        || input.target !== undefined && (typeof input.target !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(input.target))) return null;
    return { type: 'openSettings', sectionId: input.sectionId, ...(input.target ? { target: input.target as string } : {}) };
  }
  const validId = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
  if (input.type === 'selectModel' && (input.id === null || typeof input.id === 'string' && input.id.length > 0 && input.id.length <= 500))
    return { type: 'selectModel', id: input.id as string | null };
  if (input.type === 'chatMenuAction' && validId(input.id)) {
    const base = { type: 'chatMenuAction' as const, id: Number(input.id) };
    if (input.action === 'rename' && typeof input.title === 'string' && input.title.trim() && input.title.trim().length <= 120)
      return { ...base, action: 'rename', title: input.title.trim() };
    if (input.action === 'move' && (input.folderId === null || validId(input.folderId)))
      return { ...base, action: 'move', folderId: input.folderId as number | null };
    if (input.action === 'setBotHidden' && typeof input.hidden === 'boolean') return { ...base, action: 'setBotHidden', hidden: input.hidden };
    if (input.action === 'downloadDocx') return { ...base, action: 'downloadDocx' };
    if ((input.action === 'delete' || input.action === 'leave') && input.confirmed === true) return { ...base, action: input.action, confirmed: true };
    return null;
  }
  if (input.type === 'folderMenuAction') {
    if ((input.action === 'create' && input.id === null || input.action === 'rename' && validId(input.id))
        && typeof input.name === 'string' && input.name.trim() && input.name.trim().length <= 80)
      return { type: 'folderMenuAction', id: input.id as number | null, action: input.action as 'create' | 'rename', name: input.name.trim() };
    if (input.action === 'delete' && validId(input.id) && input.confirmed === true)
      return { type: 'folderMenuAction', id: Number(input.id), action: 'delete', confirmed: true };
    return null;
  }
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
    if (input.type === 'voiceAction' && ['start', 'stop', 'cancel'].includes(String(input.action)))
      return { type: 'voiceAction', chatId: Number(input.chatId), action: input.action as 'start' | 'stop' | 'cancel' };
    if (input.type === 'composerAction' && ['choose', 'remove', 'clear'].includes(String(input.action))) {
      if (input.action === 'remove' && (typeof input.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(input.id))) return null;
      return { type: 'composerAction', chatId: Number(input.chatId), action: input.action as 'choose' | 'remove' | 'clear',
        ...(input.action === 'remove' ? { id: input.id as string } : {}) };
    }
    if (input.type === 'contentAction' && Number.isSafeInteger(input.messageId) && Number(input.messageId) !== 0
        && Number.isSafeInteger(input.variantIndex) && Number(input.variantIndex) >= 0) {
      const base = { type: 'contentAction' as const, chatId: Number(input.chatId), messageId: Number(input.messageId), variantIndex: Number(input.variantIndex) };
      if (['openImage', 'downloadImage', 'openLink'].includes(String(input.action)) && typeof input.url === 'string' && input.url.length > 0 && input.url.length <= 8192)
        return { ...base, action: input.action as 'openImage' | 'downloadImage' | 'openLink', url: input.url };
      if (['openAttachment', 'downloadAttachment'].includes(String(input.action)) && Number.isSafeInteger(input.index) && Number(input.index) >= 0)
        return { ...base, action: input.action as 'openAttachment' | 'downloadAttachment', index: Number(input.index) };
      if (input.action === 'copyText' && typeof input.text === 'string' && input.text.length > 0 && input.text.length <= 100000)
        return { ...base, action: 'copyText', text: input.text };
      return null;
    }
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
      input.text.length <= 100_000
    )
      return { type: 'sendMessage', chatId: Number(input.chatId), text: input.text };
    if (input.type === 'stopGeneration' || input.type === 'loadOlderMessages')
      return { type: input.type, chatId: Number(input.chatId) };
  }
  if (
    input.type === 'newChat' ||
    input.type === 'openLibrary' ||
    input.type === 'openConversation' ||
    input.type === 'attachFiles' ||
    input.type === 'home'
  )
    return { type: input.type };
  return null;
}

export function canRunAppearanceAction(state: AppearanceShellState, action: AppearanceShellAction): boolean {
  if (action.type === 'settingsAction') return canUseThemeSettings(state.settings, action);
  if (action.type === 'openSettings') return !action.sectionId || Boolean(state.settings?.sections.some(section => section.id === action.sectionId));
  if (action.type === 'selectModel') return Boolean(state.models && !state.models.loading && !state.models.busy
    && (action.id === null || state.models.items.some(model => model.id === action.id)));
  if (action.type === 'chatMenuAction') {
    const chat = state.chats.find(chat => chat.id === action.id);
    return !state.library?.busy && Boolean(chat?.actions?.includes(action.action))
      && (action.action !== 'move' || action.folderId === null || state.folders.some(folder => folder.id === action.folderId))
      && (action.action !== 'delete' || chat?.isOwner === true && action.confirmed === true)
      && (action.action !== 'leave' || chat?.isOwner === false && action.confirmed === true);
  }
  if (action.type === 'folderMenuAction') return !state.library?.busy && (action.action === 'create'
    ? action.id === null && state.library?.canCreateFolder === true
    : Boolean(state.folders.find(folder => folder.id === action.id)?.actions?.includes(action.action))
      && (action.action !== 'delete' || action.confirmed === true));
  if ('chatId' in action && action.chatId !== state.activeChatId) return false;
  if (action.type === 'voiceAction') return Boolean(state.voice && (action.action === 'start' ? state.voice.canStart
    : action.action === 'stop' ? state.voice.status === 'recording' : state.voice.status !== 'idle'));
  if (action.type === 'sendMessage') return state.canSend && Boolean(action.text.trim() || state.attachmentCount);
  if (action.type === 'pasteAttachments') return state.canSend && !state.sending && !state.composer?.busy;
  if (action.type === 'composerAction') return !state.sending && !state.composer?.busy
    && (action.action === 'choose' ? state.canSend : action.action === 'clear' ? Boolean(state.composer?.items.length) : Boolean(state.composer?.items.some(item => item.id === action.id)));
  if (action.type === 'contentAction') {
    const message = state.messages.find(message => message.id === action.messageId);
    return Boolean(message && message.variantIndex === action.variantIndex
      && (action.index === undefined || message.attachments?.[action.index]));
  }
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

export function parseAppearanceDocumentRequest(value: unknown): AppearanceDocumentRequest | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as AppearanceDocumentRequest;
  if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(input.requestId) || !['readAttachment', 'renderAttachmentPage'].includes(input.method)
    || !Number.isSafeInteger(input.chatId) || input.chatId <= 0 || !Number.isSafeInteger(input.messageId) || input.messageId <= 0
    || !Number.isSafeInteger(input.variantIndex) || input.variantIndex < 0 || !Number.isSafeInteger(input.index) || input.index < 0
    || typeof input.url !== 'string' || !input.url || input.url.length > 8192) return null;
  if (input.method === 'renderAttachmentPage' && (!Number.isSafeInteger(input.page) || input.page! < 1 || input.page! > 100000
    || !Number.isSafeInteger(input.width) || input.width! < 128 || input.width! > 1600)) return null;
  return { requestId: input.requestId, method: input.method, chatId: input.chatId, messageId: input.messageId, variantIndex: input.variantIndex,
    index: input.index, url: input.url, ...(input.method === 'renderAttachmentPage' ? { page: input.page, width: input.width } : {}) };
}
export function canReadAppearanceDocument(state: AppearanceShellState, request: AppearanceDocumentRequest): boolean {
  return state.activeChatId === request.chatId && Boolean(state.messages.find(message => message.id === request.messageId
    && message.variantIndex === request.variantIndex)?.attachments?.[request.index]?.url === request.url);
}
