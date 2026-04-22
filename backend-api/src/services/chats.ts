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

export const updateUserContextWindow = (userId: number, contextWindow: number) => {
  const safeValue = Math.max(1, Math.floor(contextWindow));
  return db.prepare(`
    UPDATE users
    SET context_window = ?
    WHERE id = ?
  `).run(safeValue, userId);
};

export const updateUserContextWindowMax = (userId: number, contextWindowMax: number) => {
  const safeValue = Math.max(1, Math.floor(contextWindowMax));
  return db.prepare(`
    UPDATE users
    SET context_window_max = ?,
        context_window = CASE
            WHEN COALESCE(context_window, 0) <= 0 THEN ?
            WHEN context_window > ? THEN ?
            ELSE context_window
        END
    WHERE id = ?
  `).run(safeValue, safeValue, safeValue, safeValue, userId);
};

export const resetDailyMessageCounters = () => db.prepare(`
  UPDATE users
  SET daily_message_count = 0,
      daily_tokens_used = 0,
      daily_cost_rub = 0,
      daily_web_search_count = 0,
      daily_image_gen_count = 0
`).run();

export const updateUserPrompt = (userId: number, promptId: number) => db
  .prepare('UPDATE users SET selected_prompt_id = ? WHERE id = ?')
  .run(promptId, userId);

export const selectUserCustomPrompt = (userId: number) => db
  .prepare('UPDATE users SET selected_prompt_id = ? WHERE id = ?')
  .run(-1, userId);

export const updateUserCustomPrompt = (userId: number, content: string) => db
  .prepare('UPDATE users SET custom_prompt_content = ? WHERE id = ?')
  .run(content, userId);

export const resetUsersPromptIfDeleted = (promptId: number) => db
  .prepare('UPDATE users SET selected_prompt_id = NULL WHERE selected_prompt_id = ?')
  .run(promptId);

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

// ── User management ────────────────────────────────────────────────────────

export type UserStatus = 'none' | 'approved' | 'disapproved' | 'banned';
export type UserPlan = 'free' | 'standart' | 'pro';

const PLAN_LIMITS: Record<string, { context_window_max: number; daily_message_limit: number; daily_web_search_limit: number; daily_image_gen_limit: number; max_images_per_request: number }> = {
  free: { context_window_max: 10, daily_message_limit: 10, daily_web_search_limit: 0, daily_image_gen_limit: 0, max_images_per_request: 0 },
  standart: { context_window_max: 20, daily_message_limit: 20, daily_web_search_limit: 5, daily_image_gen_limit: 2, max_images_per_request: 5 },
  pro: { context_window_max: 50, daily_message_limit: 50, daily_web_search_limit: 20, daily_image_gen_limit: 5, max_images_per_request: 10 }
};

export const getMaxImagesForPlan = (plan: string): number => {
  return PLAN_LIMITS[plan]?.max_images_per_request ?? 0;
};

export const upsertTelegramUser = (
  tgId: number,
  name: string,
  role: string,
  status: UserStatus,
  tgUsername: string | null,
  defaultPromptId: number | null
) => {
  const isAdmin = ADMIN_IDS.has(tgId);
  const effectiveRole = isAdmin ? 'admin' : role;
  const effectiveIsAdmin = isAdmin ? 1 : 0;
  const limits = PLAN_LIMITS['free'];

  const result = db.prepare(`
    INSERT INTO users (id, name, role, is_admin, status, plan, tg_username, selected_prompt_id,
      context_window_max, daily_message_limit, daily_web_search_limit, daily_image_gen_limit)
    VALUES (?, ?, ?, ?, ?, 'free', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      role = excluded.role,
      is_admin = CASE WHEN users.is_admin = 1 THEN 1 ELSE excluded.is_admin END,
      status = excluded.status,
      tg_username = COALESCE(excluded.tg_username, users.tg_username),
      selected_prompt_id = COALESCE(users.selected_prompt_id, excluded.selected_prompt_id)
  `).run(tgId, name, effectiveRole, effectiveIsAdmin, status, tgUsername, defaultPromptId,
    limits.context_window_max, limits.daily_message_limit, limits.daily_web_search_limit, limits.daily_image_gen_limit);

  ensureActiveChat(tgId);
  return result;
};

export const createPendingTelegramUser = (
  tgId: number,
  name: string | null,
  tgUsername: string | null,
  defaultPromptId: number | null
) => {
  const limits = PLAN_LIMITS['free'];
  const result = db.prepare(`
    INSERT INTO users (id, name, role, is_admin, status, plan, tg_username, selected_prompt_id,
      context_window_max, daily_message_limit, daily_web_search_limit, daily_image_gen_limit)
    VALUES (?, ?, 'user', 0, 'none', 'free', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      tg_username = COALESCE(excluded.tg_username, users.tg_username),
      name = COALESCE(excluded.name, users.name),
      selected_prompt_id = COALESCE(users.selected_prompt_id, excluded.selected_prompt_id)
  `).run(tgId, name, tgUsername, defaultPromptId,
    limits.context_window_max, limits.daily_message_limit, limits.daily_web_search_limit, limits.daily_image_gen_limit);

  ensureActiveChat(tgId);
  return result;
};

export const updateUserStatus = (userId: number, status: UserStatus) => db
  .prepare('UPDATE users SET status = ? WHERE id = ?')
  .run(status, userId);

export const updateUserRole = (userId: number, role: string) => db
  .prepare('UPDATE users SET role = ?, is_admin = ? WHERE id = ?')
  .run(role, role === 'admin' ? 1 : 0, userId);

export const updateUserName = (userId: number, name: string) => db
  .prepare('UPDATE users SET name = ? WHERE id = ?')
  .run(name, userId);

export const updateUserTelegramUsername = (userId: number, tgUsername: string | null) => db
  .prepare('UPDATE users SET tg_username = ? WHERE id = ?')
  .run(tgUsername, userId);

export const removeUser = (userId: number) => {
  db.prepare('DELETE FROM chat_messages WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM user_chats WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM notes WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM tasks WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM mail_accounts WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM user_plan_subscriptions WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM api_accounts WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM bans WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
};

export const getAllUsers = () => db
  .prepare('SELECT * FROM users ORDER BY id ASC')
  .all() as UserRecord[];

export const getUsersCount = () => {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number };
  return row.cnt;
};

export const getUsersPage = (limit: number, offset: number) => {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  return db.prepare('SELECT * FROM users ORDER BY id ASC LIMIT ? OFFSET ?').all(safeLimit, safeOffset) as UserRecord[];
};

export const getPendingUsersCount = () => {
  const row = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE status = 'none'").get() as { cnt: number };
  return row.cnt;
};

export const getPendingUsersPage = (limit: number, offset: number) => {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  return db.prepare("SELECT * FROM users WHERE status = 'none' ORDER BY id ASC LIMIT ? OFFSET ?").all(safeLimit, safeOffset) as UserRecord[];
};

export const getBannedUsersCount = () => {
  const row = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE status = 'banned'").get() as { cnt: number };
  return row.cnt;
};

export const getBannedUsersPage = (limit: number, offset: number) => {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  return db.prepare(`
    SELECT u.*, b.reason as ban_reason, b.banned_at as ban_date, b.banned_by as ban_admin_id
    FROM users u
    LEFT JOIN bans b ON b.user_id = u.id
    WHERE u.status = 'banned'
    ORDER BY u.id ASC
    LIMIT ? OFFSET ?
  `).all(safeLimit, safeOffset);
};

export const updateUserPlan = (userId: number, plan: UserPlan) => {
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS['free'];
  return db.prepare(`
    UPDATE users
    SET plan = ?,
        context_window_max = ?,
        daily_message_limit = ?,
        daily_web_search_limit = ?,
        daily_image_gen_limit = ?,
        context_window = CASE
          WHEN COALESCE(context_window, 0) <= 0 THEN ?
          WHEN context_window > ? THEN ?
          ELSE context_window
        END
    WHERE id = ?
  `).run(plan, limits.context_window_max, limits.daily_message_limit, limits.daily_web_search_limit, limits.daily_image_gen_limit,
    limits.context_window_max, limits.context_window_max, limits.context_window_max, userId);
};

export const syncAllUsersPlanLimits = () => {
  for (const [plan, limits] of Object.entries(PLAN_LIMITS)) {
    db.prepare(`
      UPDATE users
      SET context_window_max = ?,
          daily_message_limit = ?,
          daily_web_search_limit = ?,
          daily_image_gen_limit = ?,
          context_window = CASE
            WHEN COALESCE(context_window, 0) <= 0 THEN ?
            WHEN context_window > ? THEN ?
            ELSE context_window
          END
      WHERE plan = ?
    `).run(limits.context_window_max, limits.daily_message_limit, limits.daily_web_search_limit, limits.daily_image_gen_limit,
      limits.context_window_max, limits.context_window_max, limits.context_window_max, plan);
  }
};

export { ADMIN_IDS };

// ---------- Telegram link codes ----------

import crypto from 'node:crypto';

export const generateLinkCode = (userId: number): { code: string; expires_in: number } => {
  // Cleanup expired first
  db.prepare('DELETE FROM telegram_link_codes WHERE expires_at < unixepoch()').run();

  // Invalidate any existing codes for this user
  db.prepare('DELETE FROM telegram_link_codes WHERE user_id = ?').run(userId);

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const now = Math.floor(Date.now() / 1000);
  const ttl = 600; // 10 minutes
  const expiresAt = now + ttl;

  db.prepare('INSERT INTO telegram_link_codes (code, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(code, userId, now, expiresAt);

  return { code, expires_in: ttl };
};

export const verifyLinkCode = (code: string): { ok: boolean; userId?: number } => {
  // Cleanup expired
  db.prepare('DELETE FROM telegram_link_codes WHERE expires_at < unixepoch()').run();

  const row = db.prepare('SELECT user_id, expires_at FROM telegram_link_codes WHERE code = ?')
    .get(code) as { user_id: number; expires_at: number } | undefined;

  if (!row) return { ok: false };
  if (row.expires_at < Math.floor(Date.now() / 1000)) {
    db.prepare('DELETE FROM telegram_link_codes WHERE code = ?').run(code);
    return { ok: false };
  }

  // Code is valid — delete it (one-time use)
  db.prepare('DELETE FROM telegram_link_codes WHERE code = ?').run(code);

  return { ok: true, userId: row.user_id };
};

export const getLinkCodeForUser = (userId: number) => {
  db.prepare('DELETE FROM telegram_link_codes WHERE expires_at < unixepoch()').run();
  return db.prepare('SELECT code, expires_at FROM telegram_link_codes WHERE user_id = ?')
    .get(userId) as { code: string; expires_at: number } | undefined;
};
