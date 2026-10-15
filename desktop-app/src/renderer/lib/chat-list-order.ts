/** Promote an existing chat within its folder without changing other sections. */
export function promoteChatInFolder<T extends { id: number; folder_id: number | null }>(chats: T[], chatId: number): T[] {
  const index = chats.findIndex(chat => chat.id === chatId);
  if (index < 0) return chats;
  const folderId = chats[index].folder_id ?? null;
  const firstIndex = chats.findIndex(chat => (chat.folder_id ?? null) === folderId);
  if (index === firstIndex) return chats;
  const next = [...chats];
  const [chat] = next.splice(index, 1);
  next.splice(firstIndex, 0, chat);
  return next;
}
