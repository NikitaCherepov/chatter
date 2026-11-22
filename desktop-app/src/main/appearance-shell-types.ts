export type AppearanceShellAction =
  | { type: 'openChat'; id: number }
  | { type: 'newChat' | 'openLibrary' | 'openSettings' | 'openConversation' | 'attachFiles' | 'home' }
  | { type: 'sendMessage'; chatId: number; text: string }
  | { type: 'stopGeneration' | 'loadOlderMessages'; chatId: number }
  | { type: 'loadMore'; folderId: number | null }
  | { type: 'search'; query: string };

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
  messages: Array<{ id: number; role: string; content: string; createdAt: number }>;
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
  >;
};

export type AppearanceShellEvent = { id: string; action: AppearanceShellAction };

export function parseAppearanceShellAction(value: unknown): AppearanceShellAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
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
