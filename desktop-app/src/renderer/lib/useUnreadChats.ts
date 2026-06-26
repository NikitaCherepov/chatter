import { useState, useCallback } from 'react';

/**
 * Tracks unread message counts per chat.
 * Can be used anywhere — sidebar badges, task results, push notifications, etc.
 */
export function useUnreadChats() {
  const [unreadByChat, setUnreadByChat] = useState<Record<number, number>>({});

  /** Increment unread count for a chat. */
  const incrementUnread = useCallback((chatId: number, count = 1) => {
    setUnreadByChat((prev) => ({ ...prev, [chatId]: (prev[chatId] || 0) + count }));
  }, []);

  /** Mark a chat as read (clear its unread count). */
  const markAsRead = useCallback((chatId: number) => {
    setUnreadByChat((prev) => {
      if (!prev[chatId]) return prev;
      const next = { ...prev };
      delete next[chatId];
      return next;
    });
  }, []);

  /** Get unread count for a specific chat. */
  const getUnread = useCallback((chatId: number) => unreadByChat[chatId] || 0, [unreadByChat]);

  /** Total unread across all chats. */
  const totalUnread = Object.values(unreadByChat).reduce((a, b) => a + b, 0);

  return { unreadByChat, incrementUnread, markAsRead, getUnread, totalUnread };
}
