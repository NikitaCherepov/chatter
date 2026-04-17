import { db, toUnix } from '../db.js';
import type { ChatDto, MessageDto, ChatRole, UserRecord } from '../types.js';

const parseAdminId = (raw: string | undefined) => {
  if (!raw) return null;
  const normalized = raw.replace(/[^\d-]/g, '').trim();
  if (!normalized) return null;
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
};

const ADMIN_IDS = (() => {
  const ids = new Set<number>();
  for (const raw of (process.env.ADMIN_IDS || '').split(/[,\s;]+/)) {
    const id = parseAdminId(raw);
    if (id) ids.add(id);
  }
  const one = parseAdminId(process.env.ADMIN_ID);
  if (one) ids.add(one);
  return ids;
})();

export const getUserById = (userId: number) => db
  .prepare('SELECT * FROM users WHERE id = ?')
  .get(userId) as UserRecord | undefined;

export const upsertUserFromTelegram = (userId: number, username: string | null, name: string | null) => db.prepare(`
  INSERT INTO users (id, name, role, is_admin, status, plan, tg_username)
  VALUES (?, ?, ?, ?, 'none', 'free', ?)
  ON CONFLICT(id) DO UPDATE SET
    tg_username = COALESCE(excluded.tg_username, users.tg_username),
    name = COALESCE(users.name, excluded.name),
    is_admin = CASE WHEN users.is_admin = 1 THEN 1 ELSE excluded.is_admin END,
    role = CASE WHEN users.role = 'admin' THEN 'admin' ELSE excluded.role END
`).run(userId, name, ADMIN_IDS.has(userId) ? 'admin' : 'user', ADMIN_IDS.has(userId) ? 1 : 0, username);

export const createOrUpdateUserForApiRegistration = (name: string | null = null) => {
  const inserted = db.prepare(`
    INSERT INTO users (name, role, is_admin, status, plan)
    VALUES (?, 'user', 0, 'approved', 'free')
  `).run(name);
  const userId = Number(inserted.lastInsertRowid);
  ensureActiveChat(userId);
  return userId;
};

export const setUserTimezone = (userId: number, timezoneOffset: number) => db.prepare(`
  UPDATE users
  SET timezone_offset = ?, timezone_confirmed = 1
  WHERE id = ?
`).run(timezoneOffset, userId);

export const getApiAccountByLogin = (login: string) => db.prepare(`
  SELECT id, user_id, login, password_salt, password_hash
  FROM api_accounts
  WHERE login = ?
`).get(login) as { id: number; user_id: number; login: string; password_salt: string; password_hash: string } | undefined;

export const createApiAccount = (userId: number, login: string, passwordSalt: string, passwordHash: string) => db.prepare(`
  INSERT INTO api_accounts (user_id, login, password_salt, password_hash)
  VALUES (?, ?, ?, ?)
`).run(userId, login, passwordSalt, passwordHash);

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
    SELECT id, chat_id, role, content, telegram_chat_id, telegram_message_id, created_at
    FROM chat_messages
    WHERE user_id = ? AND chat_id = ?
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(userId, chatId, safeLimit, safeOffset) as Array<{ id: number; chat_id: number; role: ChatRole; content: string; telegram_chat_id: number | null; telegram_message_id: number | null; created_at: string }>;

  return rows.reverse().map(row => ({
    id: row.id,
    chat_id: row.chat_id,
    role: row.role,
    content: row.content,
    telegram_chat_id: row.telegram_chat_id,
    telegram_message_id: row.telegram_message_id,
    created_at: toUnix(row.created_at)
  }));
};

export const appendChatMessage = (
  userId: number,
  chatId: number,
  role: ChatRole,
  content: string,
  telegramChatId: number | null = null,
  telegramMessageId: number | null = null
) => {
  const inserted = db.prepare(`
    INSERT INTO chat_messages (user_id, role, content, chat_id, telegram_chat_id, telegram_message_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, role, content, chatId, telegramChatId, telegramMessageId);
  db.prepare('UPDATE user_chats SET updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?').run(userId, chatId);
  return Number(inserted.lastInsertRowid);
};

export const bindChatMessageTelegramMeta = (
  userId: number,
  messageId: number,
  telegramChatId: number | null,
  telegramMessageId: number | null
) => db.prepare(`
  UPDATE chat_messages
  SET telegram_chat_id = COALESCE(?, telegram_chat_id),
      telegram_message_id = COALESCE(?, telegram_message_id)
  WHERE id = ? AND user_id = ?
`).run(telegramChatId, telegramMessageId, messageId, userId);

export const getHistoryForAi = (userId: number, chatId: number, limit: number) => db.prepare(`
  SELECT role, content
  FROM chat_messages
  WHERE user_id = ? AND chat_id = ?
  ORDER BY id DESC
  LIMIT ?
`).all(userId, chatId, limit).reverse() as Array<{ role: ChatRole; content: string }>;

export const trimUserHistoryByChat = (userId: number, chatId: number, limit: number) => {
  const safeLimit = Math.max(1, Math.floor(limit));
  return db.prepare(`
    DELETE FROM chat_messages
    WHERE user_id = ?
      AND chat_id = ?
      AND id NOT IN (
        SELECT id
        FROM chat_messages
        WHERE user_id = ? AND chat_id = ?
        ORDER BY id DESC
        LIMIT ?
      )
  `).run(userId, chatId, userId, chatId, safeLimit);
};

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
