import { db, toUnix } from '../db.js';
import type { ChatDto, MessageDto, ChatRole, UserRecord } from '../types.js';

export const getUserById = (userId: number) => db
  .prepare('SELECT * FROM users WHERE id = ?')
  .get(userId) as UserRecord | undefined;

export const upsertUserFromTelegram = (userId: number, username: string | null, name: string | null) => db.prepare(`
  INSERT INTO users (id, name, role, status, plan, tg_username)
  VALUES (?, ?, 'user', 'none', 'free', ?)
  ON CONFLICT(id) DO UPDATE SET
    tg_username = COALESCE(excluded.tg_username, users.tg_username),
    name = COALESCE(users.name, excluded.name)
`).run(userId, name, username);

const createChat = (userId: number, title: string) => db.prepare(`
  INSERT INTO user_chats (user_id, title)
  VALUES (?, ?)
`).run(userId, title);

export const ensureActiveChat = (userId: number) => {
  const user = db.prepare('SELECT active_chat_id FROM users WHERE id = ?').get(userId) as { active_chat_id: number | null } | undefined;

  if (user?.active_chat_id) {
    const exists = db.prepare('SELECT id FROM user_chats WHERE user_id = ? AND id = ?').get(userId, user.active_chat_id) as { id: number } | undefined;
    if (exists) return exists.id;
  }

  const firstChat = db.prepare('SELECT id FROM user_chats WHERE user_id = ? ORDER BY id ASC LIMIT 1').get(userId) as { id: number } | undefined;
  const chatId = firstChat?.id ?? Number(createChat(userId, 'Основной').lastInsertRowid);
  db.prepare('UPDATE users SET active_chat_id = ? WHERE id = ?').run(chatId, userId);
  return chatId;
};

export const listUserChats = (userId: number): ChatDto[] => {
  const activeId = ensureActiveChat(userId);
  const rows = db.prepare(`
    SELECT id, title, created_at, updated_at
    FROM user_chats
    WHERE user_id = ?
    ORDER BY updated_at DESC, id DESC
  `).all(userId) as Array<{ id: number; title: string; created_at: string; updated_at: string }>;

  return rows.map(row => ({
    id: row.id,
    title: row.title,
    created_at: toUnix(row.created_at),
    updated_at: toUnix(row.updated_at),
    is_active: row.id === activeId
  }));
};

export const createUserChat = (userId: number, title: string) => {
  const normalized = (title || '').trim() || `Чат ${Math.floor(Date.now() / 1000)}`;
  const result = createChat(userId, normalized.slice(0, 120));
  const chatId = Number(result.lastInsertRowid);
  db.prepare('UPDATE users SET active_chat_id = ? WHERE id = ?').run(chatId, userId);
  return chatId;
};

export const activateUserChat = (userId: number, chatId: number) => {
  const exists = db.prepare('SELECT id FROM user_chats WHERE user_id = ? AND id = ?').get(userId, chatId) as { id: number } | undefined;
  if (!exists) return false;
  db.prepare('UPDATE users SET active_chat_id = ? WHERE id = ?').run(chatId, userId);
  return true;
};

export const getChatMessages = (userId: number, chatId: number, limit = 20, offset = 0): MessageDto[] => {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  const rows = db.prepare(`
    SELECT id, chat_id, role, content, created_at
    FROM chat_messages
    WHERE user_id = ? AND chat_id = ?
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(userId, chatId, safeLimit, safeOffset) as Array<{ id: number; chat_id: number; role: ChatRole; content: string; created_at: string }>;

  return rows.reverse().map(row => ({
    id: row.id,
    chat_id: row.chat_id,
    role: row.role,
    content: row.content,
    created_at: toUnix(row.created_at)
  }));
};

export const appendChatMessage = (userId: number, chatId: number, role: ChatRole, content: string) => {
  const inserted = db.prepare(`
    INSERT INTO chat_messages (user_id, role, content, chat_id)
    VALUES (?, ?, ?, ?)
  `).run(userId, role, content, chatId);
  db.prepare('UPDATE user_chats SET updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?').run(userId, chatId);
  return Number(inserted.lastInsertRowid);
};

export const getHistoryForAi = (userId: number, chatId: number, limit: number) => db.prepare(`
  SELECT role, content
  FROM chat_messages
  WHERE user_id = ? AND chat_id = ?
  ORDER BY id DESC
  LIMIT ?
`).all(userId, chatId, limit).reverse() as Array<{ role: ChatRole; content: string }>;

export const resolveEffectiveContextWindow = (user: UserRecord) => {
  const maxWindow = Number.isFinite(user.context_window_max) && user.context_window_max > 0 ? Math.floor(user.context_window_max) : 10;
  const current = Number.isFinite(user.context_window) && user.context_window > 0 ? Math.floor(user.context_window) : maxWindow;
  return Math.max(1, Math.min(current, maxWindow));
};

export const getPromptForUser = (user: UserRecord) => {
  if (user.selected_prompt_id === -1 && (user.custom_prompt_content || '').trim()) {
    return (user.custom_prompt_content || '').trim();
  }
  if (user.selected_prompt_id) {
    const selected = db.prepare('SELECT content FROM prompts WHERE id = ?').get(user.selected_prompt_id) as { content: string } | undefined;
    if (selected?.content) return selected.content;
  }
  const defaultPrompt = db.prepare('SELECT content FROM prompts WHERE is_default = 1 LIMIT 1').get() as { content: string } | undefined;
  return defaultPrompt?.content || 'Ты полезный ассистент.';
};
