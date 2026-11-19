import type { ChatFolderList, ChatInfo, ChatListFilters, getChatFolders, getChats } from './api';

export const CHAT_LIST_PAGE_SIZE = 25;
export type ChatSectionKey = `folder:${number}` | 'unfiled';
export type ChatSectionPaging = { offset: number; total: number; hasMore: boolean; loading: boolean };
export type ChatSectionPages = Partial<Record<ChatSectionKey, ChatSectionPaging>>;
type Source = { getChatFolders: typeof getChatFolders; getChats: typeof getChats };
export type ChatSidebarSnapshot = ChatFolderList & { chats: ChatInfo[]; paging: ChatSectionPages };

const count = (value: number) => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
const sectionKey = (folderId: number | null): ChatSectionKey => folderId === null ? 'unfiled' : `folder:${folderId}`;

/** Refresh complete loaded prefixes, keeping data independent of folder visibility. */
export async function loadChatSidebar(
  source: Source,
  filters: ChatListFilters,
  previous: ChatSectionPages = {},
  isCurrent: () => boolean = () => true,
): Promise<ChatSidebarSnapshot | null> {
  const metadata = await source.getChatFolders(filters, CHAT_LIST_PAGE_SIZE);
  if (!isCurrent()) return null;
  const previews = new Map<ChatSectionKey, ChatInfo[]>();
  for (const chat of metadata.chat_previews ?? []) {
    const key = sectionKey(chat.folder_id ?? null);
    const rows = previews.get(key) ?? [];
    rows.push({ ...chat, folder_id: chat.folder_id ?? null });
    previews.set(key, rows);
  }
  const sections = [
    ...metadata.folders.map(folder => ({ folderId: folder.id as number | null, total: count(folder.chat_count) })),
    { folderId: null, total: count(metadata.unfiled_count) },
  ];
  const pages = new Map<ChatSectionKey, ChatInfo[]>();
  const paging: ChatSectionPages = {};
  let next = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(4, sections.length) }, async () => {
    try {
      while (!failed && isCurrent() && next < sections.length) {
        const section = sections[next++];
        const key = sectionKey(section.folderId);
        const target = Math.min(section.total, Math.max(CHAT_LIST_PAGE_SIZE, count(previous[key]?.offset ?? 0)));
        const rows = (previews.get(key) ?? []).slice(0, target);
        let offset = rows.length;
        let exhausted = offset >= section.total;
        while (!failed && isCurrent() && !exhausted && offset < target) {
          const limit = Math.min(100, target - offset);
          const response = await source.getChats(limit, offset, { ...filters, folderId: section.folderId });
          if (!isCurrent()) return;
          rows.push(...response.chats.map(chat => ({ ...chat, folder_id: chat.folder_id ?? null })));
          offset += response.chats.length;
          if (Number.isFinite(response.total)) section.total = count(response.total);
          exhausted = response.chats.length < limit || offset >= section.total;
        }
        pages.set(key, rows);
        paging[key] = { offset, total: section.total, hasMore: !exhausted && offset < section.total, loading: false };
      }
    } catch (error) {
      failed = true;
      throw error;
    }
  });
  const settled = await Promise.allSettled(workers);
  if (!isCurrent()) return null;
  const failure = settled.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;

  const unique = new Map<number, ChatInfo>();
  for (const section of sections) {
    for (const chat of pages.get(sectionKey(section.folderId)) ?? []) unique.set(chat.id, chat);
  }
  const filtered = filters.promptId !== undefined || Boolean(filters.model || filters.hasFiles || filters.hasImages);
  // The selected chat can be outside a loaded prefix; it does not advance its pagination cursor.
  if (!filtered && metadata.active_chat && !unique.has(metadata.active_chat.id)) {
    unique.set(metadata.active_chat.id, { ...metadata.active_chat, folder_id: metadata.active_chat.folder_id ?? null });
  }
  const totals = new Map(sections.map(section => [sectionKey(section.folderId), section.total]));
  return {
    ...metadata,
    folders: metadata.folders.map(folder => ({ ...folder, chat_count: totals.get(sectionKey(folder.id)) ?? 0 })),
    unfiled_count: totals.get('unfiled') ?? 0,
    total_count: sections.reduce((total, section) => total + section.total, 0),
    chats: [...unique.values()],
    paging,
  };
}
