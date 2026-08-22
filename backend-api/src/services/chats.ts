import fs from 'node:fs';
import path from 'node:path';
import { db, toUnix } from '../db.js';
import type { ChatDto, MessageDto, MessageImage, MessageAudio, MessageAttachment, ChatRole, UserRecord, MessageUsage } from '../types.js';
import { copyAttachmentFile, deleteAttachmentFile } from './attachment-storage.js';
import { deleteImageFile, filenameFromUrl, resolveImageFile } from './image-storage.js';
import type { ToolIteration } from './ai.js';
import { countTokens, countMessageTokens, countToolCallTokens, countToolResultTokens } from './tokenizer.js';
import { buildBaseSystemPromptForUser } from './system-prompt.js';
import { resolvePromptForUser } from './prompts.js';
import { getEnabledMacros } from './macros.js';
import { listRoomReaderUserIds, canReadChatMessages } from './chat-rooms.js';
import {
  allocateAccountId,
  createPasswordIdentity,
  ensureTelegramIdentity,
  getAccountIdentities,
  getPasswordIdentityByLogin,
  resolveAccountId,
  resolveTelegramAccountForUpsert,
} from './accounts.js';
import { normalizeSupportedLanguage } from '../i18n/languages.js';
import { formatAutomaticChatTitle } from '../i18n/index.js';
import { getPlanLimits, getDefaultUserPlanLimits, loadPlanLimitsFromDb } from './plan-limits.js';
import { withAttachmentMetadata } from './chat-attachments.js';

export const getRawUserById = (userId: number) => db
  .prepare('SELECT * FROM users WHERE id = ?')
  .get(userId) as UserRecord | undefined;

export const getUserById = (userId: number) => getRawUserById(resolveAccountId(userId));

export const upsertUserFromTelegram = (
  userId: number,
  username: string | null,
  name: string | null,
  language?: string | null,
) => db.transaction(() => {
  const accountId = resolveTelegramAccountForUpsert(userId);
  const normalizedLanguage = normalizeSupportedLanguage(language);
  const limits = getDefaultUserPlanLimits();
  const weeklyCostQuota = limits.budget_usd > 0 ? limits.budget_usd / 4 : 0;
  const result = db.prepare(`
    INSERT INTO users (id, name, role, is_admin, status, plan, language,
      daily_web_search_limit, daily_image_gen_limit,
      max_context_tokens_limit, max_context_tokens,
      weekly_tokens_quota, weekly_cost_quota, weekly_cost_quota_limit)
    VALUES (?, ?, ?, ?, 'none', 'free', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = COALESCE(users.name, excluded.name),
      language = COALESCE(users.language, excluded.language),
      is_admin = CASE WHEN users.is_admin = 1 THEN 1 ELSE excluded.is_admin END,
      role = CASE WHEN users.role = 'admin' THEN 'admin' ELSE excluded.role END
  `).run(accountId, name, 'user', 0, normalizedLanguage,
    limits.daily_web_search_limit, limits.daily_image_gen_limit,
    limits.max_context_tokens, limits.max_context_tokens,
    limits.weekly_token_quota, weeklyCostQuota, weeklyCostQuota);
  ensureTelegramIdentity(accountId, userId, username);
  return result;
})();

export const createOrUpdateUserForApiRegistration = (name: string | null = null) => {
  const userId = allocateAccountId();
  db.prepare(`
    INSERT INTO users (id, name, role, is_admin, status, plan)
    VALUES (?, ?, 'user', 0, 'approved', 'free')
  `).run(userId, name);
  // Apply free plan limits (quota, context, dailies) immediately.
  updateUserPlan(userId, 'free');
  ensureActiveChat(userId);
  return userId;
};
export const setUserTimezone = (userId: number, timezoneOffset: number) => db.prepare(`
  UPDATE users
  SET timezone_offset = ?, timezone_confirmed = 1
  WHERE id = ?
`).run(timezoneOffset, userId);

export const getPasswordAccountByLogin = (login: string) => {
  const identity = getPasswordIdentityByLogin(login);
  if (!identity?.password_salt || !identity.password_hash) return undefined;
  return {
    id: identity.id,
    user_id: resolveAccountId(identity.account_id),
    login: identity.provider_subject,
    password_salt: identity.password_salt,
    password_hash: identity.password_hash,
  };
};

export const createPasswordAccount = (userId: number, login: string, passwordSalt: string, passwordHash: string) =>
  createPasswordIdentity(userId, login, passwordSalt, passwordHash);

export const createChat = (userId: number, title: string) => db.prepare(`
  INSERT INTO user_chats (user_id, title)
  VALUES (?, ?)
`).run(userId, title);

export const getUserChatById = (userId: number, chatId: number) => db.prepare(`
  SELECT id, user_id, title, created_at, updated_at
  FROM user_chats
  WHERE user_id = ? AND id = ?
`).get(userId, chatId) as { id: number; user_id: number; title: string; created_at: string; updated_at: string } | undefined;

export const ensureActiveChat = (userId: number) => {
  const user = db.prepare('SELECT active_chat_id, language FROM users WHERE id = ?').get(userId) as { active_chat_id: number | null; language: string | null } | undefined;

  if (user?.active_chat_id) {
    const exists = db.prepare('SELECT id FROM user_chats WHERE user_id = ? AND id = ?').get(userId, user.active_chat_id) as { id: number } | undefined;
    if (exists) return exists.id;
  }

  const firstChat = db.prepare('SELECT id FROM user_chats WHERE user_id = ? ORDER BY id ASC LIMIT 1').get(userId) as { id: number } | undefined;
  const chatId = firstChat?.id ?? createUserChat(userId, '');
  db.prepare('UPDATE users SET active_chat_id = ? WHERE id = ?').run(chatId, userId);
  return chatId;
};

export type ChatListFilters = {
  promptId?: number;
  modelName?: string;
  hasFiles?: boolean;
  hasImages?: boolean;
  folderId?: number | null;
};

const buildUserChatFilter = (userId: number, filters: ChatListFilters) => {
  // Owned chats + rooms the user has joined as a member.
  const conditions = [`(uc.user_id = ? OR EXISTS (SELECT 1 FROM chat_members um WHERE um.chat_id = uc.id AND um.user_id = ?))`];
  const params: Array<string | number> = [userId, userId];
  // Message-based filters match on chat_id only: in shared rooms messages may
  // belong to other authors.
  if (Number.isSafeInteger(filters.promptId) && filters.promptId !== 0) {
    conditions.push(`EXISTS (
      SELECT 1 FROM chat_messages cm
      WHERE cm.chat_id = uc.id AND cm.prompt_id = ?
    )`);
    params.push(Number(filters.promptId));
  }
  if (filters.modelName) {
    conditions.push(`EXISTS (
      SELECT 1 FROM chat_messages cm
      WHERE cm.chat_id = uc.id AND cm.model_name = ?
    )`);
    params.push(filters.modelName);
  }
  if (filters.hasFiles) {
    conditions.push(`EXISTS (
      SELECT 1 FROM chat_messages cm
      WHERE cm.chat_id = uc.id
        AND cm.attachments IS NOT NULL
        AND TRIM(cm.attachments) NOT IN ('', '[]', 'null')
    )`);
  }
  if (filters.hasImages) {
    conditions.push(`EXISTS (
      SELECT 1 FROM chat_messages cm
      WHERE cm.chat_id = uc.id
        AND cm.images IS NOT NULL
        AND TRIM(cm.images) NOT IN ('', '[]', 'null')
    )`);
  }
  // Folder placement is per-user: owner → user_chats.folder_id, room member →
  // chat_members.folder_id. An owner-side folder move must not affect members.
  if (filters.folderId === null) {
    conditions.push(`(
      (uc.user_id = ? AND uc.folder_id IS NULL)
      OR (uc.user_id <> ? AND NOT EXISTS (
        SELECT 1 FROM chat_members um2 WHERE um2.chat_id = uc.id AND um2.user_id = ? AND um2.folder_id IS NOT NULL
      ))
    )`);
    params.push(userId, userId, userId);
  } else if (Number.isSafeInteger(filters.folderId) && Number(filters.folderId) > 0) {
    conditions.push(`(
      (uc.user_id = ? AND uc.folder_id = ?)
      OR EXISTS (
        SELECT 1 FROM chat_members um2 WHERE um2.chat_id = uc.id AND um2.user_id = ? AND um2.folder_id = ?
      )
    )`);
    params.push(userId, Number(filters.folderId), userId, Number(filters.folderId));
  }
  return { where: conditions.join('\n      AND '), params };
};

export const listUserChats = (userId: number, limit = 50, offset = 0, filters: ChatListFilters = {}): ChatDto[] => {
  const activeId = ensureActiveChat(userId);
  const parsedLimit = Number.isFinite(limit) ? Math.floor(limit) : 50;
  const parsedOffset = Number.isFinite(offset) ? Math.floor(offset) : 0;
  const safeLimit = Math.max(1, Math.min(100, parsedLimit));
  const safeOffset = Math.max(0, parsedOffset);
  const { where, params } = buildUserChatFilter(userId, filters);
  const rows = db.prepare(`
    SELECT uc.id, uc.title, uc.created_at, uc.updated_at, uc.bot_hidden,
           (uc.user_id = ?) AS is_owner,
           CASE
             WHEN uc.user_id = ? THEN uc.folder_id
             ELSE (SELECT um.folder_id FROM chat_members um WHERE um.chat_id = uc.id AND um.user_id = ?)
           END AS folder_id
    FROM user_chats uc
    WHERE ${where}
    ORDER BY uc.updated_at DESC, uc.id DESC
    LIMIT ? OFFSET ?
  `).all(userId, userId, userId, ...params, safeLimit, safeOffset) as Array<{ id: number; title: string; folder_id: number | null; created_at: string; updated_at: string; bot_hidden: number; is_owner: number }>;

  return rows.map(row => ({
    id: row.id,
    title: row.title,
    folder_id: row.folder_id,
    created_at: toUnix(row.created_at),
    updated_at: toUnix(row.updated_at),
    is_active: row.id === activeId,
    bot_hidden: row.bot_hidden === 1,
    is_owner: row.is_owner === 1
  }));
};

export const getUserChatListItem = (userId: number, chatId: number): ChatDto | undefined => {
  const activeId = ensureActiveChat(userId);
  const row = db.prepare(`
    SELECT uc.id, uc.title, uc.created_at, uc.updated_at, uc.bot_hidden,
           (uc.user_id = ?) AS is_owner,
           CASE
             WHEN uc.user_id = ? THEN uc.folder_id
             ELSE (SELECT um.folder_id FROM chat_members um WHERE um.chat_id = uc.id AND um.user_id = ?)
           END AS folder_id
    FROM user_chats uc
    WHERE uc.id = ?
      AND (uc.user_id = ? OR EXISTS (SELECT 1 FROM chat_members um2 WHERE um2.chat_id = uc.id AND um2.user_id = ?))
  `).get(userId, userId, userId, chatId, userId, userId) as { id: number; title: string; folder_id: number | null; created_at: string; updated_at: string; bot_hidden: number; is_owner: number } | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    title: row.title,
    folder_id: row.folder_id,
    created_at: toUnix(row.created_at),
    updated_at: toUnix(row.updated_at),
    is_active: row.id === activeId,
    bot_hidden: row.bot_hidden === 1,
    is_owner: row.is_owner === 1,
  };
};

export const countUserChats = (userId: number, filters: ChatListFilters = {}): number => {
  const { where, params } = buildUserChatFilter(userId, filters);
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM user_chats uc
    WHERE ${where}
  `).get(...params) as { count: number };
  return Number(row.count) || 0;
};

export type ChatFilterOptions = {
  prompts: Array<{ id: number; name: string }>;
  models: string[];
};

export const listChatFilterOptions = (userId: number): ChatFilterOptions => {
  const prompts = db.prepare(`
    SELECT cm.prompt_id AS id, cm.prompt_name AS name
    FROM chat_messages cm
    INNER JOIN (
      SELECT prompt_id, MAX(id) AS message_id
      FROM chat_messages
      WHERE user_id = ? AND prompt_id IS NOT NULL
      GROUP BY prompt_id
    ) latest ON latest.message_id = cm.id
    ORDER BY cm.prompt_name COLLATE NOCASE ASC, cm.prompt_id ASC
  `).all(userId) as Array<{ id: number; name: string | null }>;
  const models = db.prepare(`
    SELECT DISTINCT cm.model_name AS value
    FROM chat_messages cm
    INNER JOIN user_chats uc ON uc.id = cm.chat_id AND uc.user_id = cm.user_id
    WHERE cm.user_id = ? AND cm.model_name IS NOT NULL AND TRIM(cm.model_name) != ''
    ORDER BY cm.model_name COLLATE NOCASE ASC
  `).all(userId) as Array<{ value: string }>;
  return {
    prompts: prompts.map((row) => ({ id: row.id, name: row.name?.trim() || `Prompt ${row.id}` })),
    models: models.map((row) => row.value),
  };
};

export type ChatFolderDto = {
  id: number;
  name: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
  chat_count: number;
};

export const listChatFolders = (userId: number, filters: ChatListFilters = {}): {
  folders: ChatFolderDto[];
  unfiled_count: number;
  total_count: number;
} => {
  const { where, params } = buildUserChatFilter(userId, filters);
  // Folder placement is per-user (owner → user_chats.folder_id, member →
  // chat_members.folder_id), so counts must use the same resolution.
  const countRows = db.prepare(`
    SELECT CASE
      WHEN uc.user_id = ? THEN uc.folder_id
      ELSE (SELECT um.folder_id FROM chat_members um WHERE um.chat_id = uc.id AND um.user_id = ?)
    END AS folder_id, COUNT(*) AS count
    FROM user_chats uc
    WHERE ${where}
    GROUP BY folder_id
  `).all(userId, userId, ...params) as Array<{ folder_id: number | null; count: number }>;
  const counts = new Map<number | null, number>(countRows.map((row) => [row.folder_id, Number(row.count) || 0]));
  const rows = db.prepare(`
    SELECT id, name, sort_order, created_at, updated_at
    FROM chat_folders
    WHERE user_id = ?
    ORDER BY sort_order ASC, id ASC
  `).all(userId) as Array<{ id: number; name: string; sort_order: number; created_at: string; updated_at: string }>;
  const folders = rows.map((row) => ({
    id: row.id,
    name: row.name,
    sort_order: row.sort_order,
    created_at: toUnix(row.created_at),
    updated_at: toUnix(row.updated_at),
    chat_count: counts.get(row.id) || 0,
  }));
  return {
    folders,
    unfiled_count: counts.get(null) || 0,
    total_count: [...counts.values()].reduce((total, count) => total + count, 0),
  };
};

export const createChatFolder = (userId: number, name: string): ChatFolderDto => {
  const normalizedName = name.trim().slice(0, 80);
  const nextOrder = (db.prepare(`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
    FROM chat_folders
    WHERE user_id = ?
  `).get(userId) as { next_order: number }).next_order;
  const result = db.prepare(`
    INSERT INTO chat_folders (user_id, name, sort_order)
    VALUES (?, ?, ?)
  `).run(userId, normalizedName, nextOrder);
  const row = db.prepare(`
    SELECT id, name, sort_order, created_at, updated_at
    FROM chat_folders
    WHERE id = ? AND user_id = ?
  `).get(Number(result.lastInsertRowid), userId) as { id: number; name: string; sort_order: number; created_at: string; updated_at: string };
  return {
    ...row,
    created_at: toUnix(row.created_at),
    updated_at: toUnix(row.updated_at),
    chat_count: 0,
  };
};

export const renameChatFolder = (userId: number, folderId: number, name: string): boolean => {
  const result = db.prepare(`
    UPDATE chat_folders
    SET name = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(name.trim().slice(0, 80), folderId, userId);
  return result.changes > 0;
};

export const deleteChatFolder = (userId: number, folderId: number): boolean => db.transaction(() => {
  const folder = db.prepare('SELECT id FROM chat_folders WHERE id = ? AND user_id = ?')
    .get(folderId, userId) as { id: number } | undefined;
  if (!folder) return false;
  db.prepare('UPDATE user_chats SET folder_id = NULL WHERE user_id = ? AND folder_id = ?').run(userId, folderId);
  // Per-member placements (rooms) must be cleaned up too.
  db.prepare('UPDATE chat_members SET folder_id = NULL WHERE user_id = ? AND folder_id = ?').run(userId, folderId);
  db.prepare('DELETE FROM chat_folders WHERE id = ? AND user_id = ?').run(folderId, userId);
  return true;
})();

export const moveUserChatToFolder = (userId: number, chatId: number, folderId: number | null): boolean => {
  const chat = db.prepare('SELECT id, user_id FROM user_chats WHERE id = ?')
    .get(chatId) as { id: number; user_id: number } | undefined;
  if (!chat) return false;
  const isOwner = chat.user_id === userId;
  if (!isOwner) {
    // Rooms: a member files the chat into their OWN folder — the owner's
    // placement is untouched.
    const member = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id = ?')
      .get(chatId, userId) as { user_id: number } | undefined;
    if (!member) return false;
  }
  if (folderId !== null) {
    const folder = db.prepare('SELECT id FROM chat_folders WHERE id = ? AND user_id = ?')
      .get(folderId, userId) as { id: number } | undefined;
    if (!folder) return false;
  }
  if (isOwner) {
    db.prepare('UPDATE user_chats SET folder_id = ? WHERE id = ? AND user_id = ?').run(folderId, chatId, userId);
  } else {
    db.prepare('UPDATE chat_members SET folder_id = ? WHERE chat_id = ? AND user_id = ?').run(folderId, chatId, userId);
  }
  return true;
};

export const createUserChat = (userId: number, title: string) => {
  const language = (db.prepare('SELECT language FROM users WHERE id = ?').get(userId) as { language: string | null } | undefined)?.language;
  const chatCount = (db.prepare('SELECT COUNT(*) AS count FROM user_chats WHERE user_id = ?').get(userId) as { count: number }).count;
  const normalized = (title || '').trim() || formatAutomaticChatTitle(language, chatCount + 1);
  const result = createChat(userId, normalized.slice(0, 120));
  const chatId = Number(result.lastInsertRowid);
  db.prepare('UPDATE users SET active_chat_id = ? WHERE id = ?').run(chatId, userId);
  return chatId;
};

/**
 * Build a forked chat title by prepending a "[N]" index.
 *
 * Rules (matches UI expectations):
 *   "Report"              -> "[2] Report"
 *   "[2] Report"          -> "[3] Report"
 *   "[5] [important] x"   -> "[2] [5] [important] x"  (existing [N] at start is replaced,
 *                                                      other bracketed tokens preserved as-is)
 *   "[note] x"            -> "[2] [note] x"            (non-numeric brackets are left alone)
 *
 * The index is computed only from a leading "[<digits>]" token; if present,
 * it is stripped before re-prefixing with index+1. Anything else in the title
 * (including non-numeric bracketed fragments) is kept verbatim.
 */
const buildForkTitle = (origTitle: string, language: unknown): string => {
  const trimmed = (origTitle || '').trim();
  const m = trimmed.match(/^\[(\d+)\]\s*(.*)$/);
  const nextIndex = m ? Number(m[1]) + 1 : 2;
  const rest = m ? m[2] : trimmed;
  const baseTitle = rest || formatAutomaticChatTitle(language, Math.floor(Date.now() / 1000));
  return `[${nextIndex}] ${baseTitle}`.slice(0, 120);
};

/**
 * Fork a chat: create a new chat and copy all messages from the source chat
 * up to (and including) `fromMessageId` into it.
 *
 * - Attachments: physical files are COPIED on disk (new random filename) so
 *   that deletion in either chat never orphans the other. If a source file
 *   is missing, that attachment entry is dropped from the new message's JSON.
 * - Images / audio: references are shared (no file copy). Today there is no
 *   delete endpoint for these assets, so sharing is safe.
 * - `token_count` / `reasoning_tokens` are copied as-is — they are
 *   deterministic for the same content and avoid recomputation cost.
 * - `telegram_chat_id` / `telegram_message_id` are NULLed in the copies —
 *   the new chat has no Telegram binding.
 * - FTS index is updated automatically by the `trg_chat_messages_fts_ai`
 *   trigger on INSERT.
 * - The new chat becomes the user's active chat.
 *
 * Returns the new chat id and the number of copied messages, or null if the
 * source chat/message is not found.
 */
export const forkChat = (
  userId: number,
  sourceChatId: number,
  fromMessageId: number,
  customTitle?: string
): { chat_id: number; forked_messages: number } | null => {
  // Verify the source chat belongs to the user.
  const sourceChat = db.prepare(`
    SELECT id, title, room_enabled, room_response_mode, room_auto_respond,
           room_next_agent_id, default_prompt_id
    FROM user_chats
    WHERE id = ? AND user_id = ?
  `).get(sourceChatId, userId) as {
    id: number;
    title: string;
    room_enabled: number;
    room_response_mode: string;
    room_auto_respond: number;
    room_next_agent_id: number | null;
    default_prompt_id: number | null;
  } | undefined;
  if (!sourceChat) return null;

  // Verify the anchor message exists in the source chat. The anchor may be
  // authored by anyone (e.g. a former member of an emptied room) — the
  // endpoint above only lets effectively single-reader chats through.
  const anchor = db.prepare(
    'SELECT id FROM chat_messages WHERE id = ? AND chat_id = ?'
  ).get(fromMessageId, sourceChatId) as { id: number } | undefined;
  if (!anchor) return null;

  // Resolve title.
  const userLanguage = (db.prepare('SELECT language FROM users WHERE id = ?').get(userId) as { language: string | null } | undefined)?.language;
  const title = (customTitle && customTitle.trim())
    ? customTitle.trim().slice(0, 120)
    : buildForkTitle(sourceChat.title, userLanguage);

  const tx = db.transaction(() => {
    // 1. Create the new chat and activate it.
    const newChatId = createUserChat(userId, title);

    // A room branch needs its own agents: message.agent_id values cannot keep
    // pointing at agents that belong to the source chat. Copy both active and
    // removed agents so historical speaker names remain intact, then remap all
    // copied messages to the new agent ids.
    const sourceAgents = db.prepare(`
      SELECT id, owner_user_id, source_prompt_id, name, prompt_content,
             sort_order, is_active, created_at, updated_at, deleted_at
      FROM chat_agents
      WHERE chat_id = ?
      ORDER BY id ASC
    `).all(sourceChatId) as Array<{
      id: number;
      owner_user_id: number;
      source_prompt_id: number | null;
      name: string;
      prompt_content: string;
      sort_order: number;
      is_active: number;
      created_at: string;
      updated_at: string;
      deleted_at: string | null;
    }>;
    const agentIdMap = new Map<number, number>();
    const insertAgent = db.prepare(`
      INSERT INTO chat_agents (
        chat_id, owner_user_id, source_prompt_id, name, prompt_content,
        sort_order, is_active, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const agent of sourceAgents) {
      const inserted = insertAgent.run(
        newChatId,
        agent.owner_user_id,
        agent.source_prompt_id,
        agent.name,
        agent.prompt_content,
        agent.sort_order,
        agent.is_active,
        agent.created_at,
        agent.updated_at,
        agent.deleted_at,
      );
      agentIdMap.set(agent.id, Number(inserted.lastInsertRowid));
    }

    const nextAgentId = sourceChat.room_next_agent_id === null
      ? null
      : (agentIdMap.get(sourceChat.room_next_agent_id) ?? null);
    db.prepare(`
      UPDATE user_chats
      SET room_enabled = ?,
          room_response_mode = ?,
          room_auto_respond = ?,
          room_next_agent_id = ?,
          default_prompt_id = ?
      WHERE id = ? AND user_id = ?
    `).run(
      sourceChat.room_enabled,
      sourceChat.room_response_mode,
      sourceChat.room_auto_respond,
      nextAgentId,
      sourceChat.default_prompt_id,
      newChatId,
      userId,
    );

    // Fork keeps the forking user's own room membership (as admin of the new chat).
    const forkingMember = db.prepare(`
      SELECT response_mode, auto_respond, next_agent_id, sort_order
      FROM chat_members WHERE chat_id = ? AND user_id = ?
    `).get(sourceChatId, userId) as {
      response_mode: string; auto_respond: number; next_agent_id: number | null; sort_order: number;
    } | undefined;
    if (forkingMember) {
      db.prepare(`
        INSERT INTO chat_members (chat_id, user_id, role, response_mode, auto_respond, next_agent_id, sort_order)
        VALUES (?, ?, 'admin', ?, ?, ?, ?)
      `).run(
        newChatId,
        userId,
        forkingMember.response_mode,
        forkingMember.auto_respond,
        forkingMember.next_agent_id === null ? null : (agentIdMap.get(forkingMember.next_agent_id) ?? null),
        forkingMember.sort_order,
      );
    }

    // 2. Select ALL source messages up to the anchor (inclusive), oldest
    // first — regardless of author (e.g. former room members' messages in an
    // emptied room). Copied rows are re-attributed to the forking user below,
    // because single-reader chats filter messages by user_id on read.
    const rows = db.prepare(`
      SELECT id, role, content, images, audio, reasoning_content,
             tool_calls_json, token_count, reasoning_tokens,
             attachments, subagents_json, usage_json, prompt_id, prompt_name, model_name, provider_name,
             agent_id, archived, created_at
      FROM chat_messages
      WHERE chat_id = ? AND id <= ?
      ORDER BY id ASC
    `).all(sourceChatId, fromMessageId) as Array<{
      id: number;
      role: ChatRole;
      content: string;
      created_at: string;
      images: string | null;
      audio: string | null;
      reasoning_content: string | null;
      tool_calls_json: string | null;
      token_count: number;
      reasoning_tokens: number;
      attachments: string | null;
      subagents_json: string | null;
      usage_json: string | null;
      prompt_id: number | null;
      prompt_name: string | null;
      model_name: string | null;
      provider_name: string | null;
      agent_id: number | null;
      archived: number;
    }>;

    const insertStmt = db.prepare(`
      INSERT INTO chat_messages (
        user_id, role, content, chat_id,
        telegram_chat_id, telegram_message_id,
        images, audio, reasoning_content, tool_calls_json,
        token_count, reasoning_tokens, attachments, subagents_json,
        usage_json, prompt_id, prompt_name, model_name, provider_name, agent_id, archived, created_at
      )
      VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const row of rows) {
      // Rewrite attachments JSON: copy each file on disk, drop missing ones.
      let newAttachmentsJson: string | null = row.attachments;
      if (row.attachments) {
        try {
          const parsed = JSON.parse(row.attachments) as MessageAttachment[];
          if (Array.isArray(parsed)) {
            const rewritten: MessageAttachment[] = [];
            for (const att of parsed) {
              const copied = copyAttachmentFile(att.filename);
              if (!copied) continue; // source file missing → drop entry
              rewritten.push({
                ...att,
                filename: copied.filename,
                url: copied.url
              });
            }
            newAttachmentsJson = rewritten.length > 0 ? JSON.stringify(rewritten) : null;
          }
        } catch {
          // Invalid JSON — leave as-is (defensive; should not happen).
        }
      }

      insertStmt.run(
        userId,
        row.role,
        row.content,
        newChatId,
        row.images,            // shared references — no copy
        row.audio,             // shared reference — no copy
        row.reasoning_content,
        row.tool_calls_json,
        row.token_count,       // already computed, deterministic
        row.reasoning_tokens,
        newAttachmentsJson,
        row.subagents_json,
        row.usage_json,
        row.prompt_id,
        row.prompt_name,
        row.model_name,
        row.provider_name,
        row.agent_id === null ? null : (agentIdMap.get(row.agent_id) ?? null),
        row.archived,          // preserve archived state
        row.created_at         // preserve original timestamps
      );
    }

    // 3. Bump the new chat's updated_at.
    db.prepare('UPDATE user_chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
      .run(newChatId, userId);

    return { chat_id: newChatId, forked_messages: rows.length };
  });

  return tx();
};

export const activateUserChat = (userId: number, chatId: number) => {
  // Own chat OR shared room membership: owner-created rooms live in the
  // owner's user_chats row, members join via chat_members.
  const exists = canReadChatMessages(userId, chatId);
  if (!exists) return false;
  db.prepare('UPDATE users SET active_chat_id = ? WHERE id = ?').run(chatId, userId);
  return true;
};

export const renameUserChat = (userId: number, chatId: number, title: string): boolean => {
  const exists = db.prepare('SELECT id FROM user_chats WHERE user_id = ? AND id = ?').get(userId, chatId) as { id: number } | undefined;
  if (!exists) return false;
  db.prepare('UPDATE user_chats SET title = ? WHERE id = ? AND user_id = ?').run(title.slice(0, 120), chatId, userId);
  return true;
};

export const deleteUserChat = (userId: number, chatId: number): boolean => {
  const exists = db.prepare('SELECT id FROM user_chats WHERE user_id = ? AND id = ?').get(userId, chatId) as { id: number } | undefined;
  if (!exists) return false;
  const imageFilenames = cleanupMessageFiles(userId, chatId);
  db.prepare('DELETE FROM chat_messages WHERE user_id = ? AND chat_id = ?').run(userId, chatId);
  cleanupUnreferencedImages(imageFilenames);
  db.prepare('DELETE FROM chat_agents WHERE chat_id = ?').run(chatId);
  db.prepare('DELETE FROM chat_members WHERE chat_id = ?').run(chatId);
  db.prepare('DELETE FROM user_chats WHERE id = ? AND user_id = ?').run(chatId, userId);
  // If deleted chat was active, reset to another chat
  const user = db.prepare('SELECT active_chat_id FROM users WHERE id = ?').get(userId) as { active_chat_id: number | null } | undefined;
  if (user?.active_chat_id === chatId) {
    const firstChat = db.prepare('SELECT id FROM user_chats WHERE user_id = ? ORDER BY id ASC LIMIT 1').get(userId) as { id: number } | undefined;
    db.prepare('UPDATE users SET active_chat_id = ? WHERE id = ?').run(firstChat?.id ?? null, userId);
  }
  return true;
};

export const clearUserChatMessages = (userId: number, chatId: number): boolean => {
  if (!getUserChatById(userId, chatId)) return false;
  const imageFilenames = cleanupMessageFiles(userId, chatId);
  db.prepare('DELETE FROM chat_messages WHERE user_id = ? AND chat_id = ?').run(userId, chatId);
  cleanupUnreferencedImages(imageFilenames);
  db.prepare('UPDATE user_chats SET updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?').run(userId, chatId);
  return true;
};

export const clearAllUserMessages = (userId: number) => {
  const chats = db.prepare('SELECT id FROM user_chats WHERE user_id = ?').all(userId) as Array<{ id: number }>;
  const imageFilenames = new Set<string>();
  for (const chat of chats) {
    for (const filename of cleanupMessageFiles(userId, chat.id)) imageFilenames.add(filename);
  }
  const changes = db.prepare('DELETE FROM chat_messages WHERE user_id = ?').run(userId).changes;
  cleanupUnreferencedImages(imageFilenames);
  return changes;
};

export const getRecentUserHistory = (userId: number, limit = 20) => {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  return db.prepare(`
    SELECT id, chat_id, role, content, telegram_message_id, created_at
    FROM chat_messages
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(userId, safeLimit) as Array<{
    id: number;
    chat_id: number | null;
    role: ChatRole;
    content: string;
    telegram_message_id: number | null;
    created_at: string;
  }>;
};

export const deleteUserHistoryByRole = (userId: number, role: ChatRole | 'all') => {
  if (role === 'all') return clearAllUserMessages(userId);
  const rows = db.prepare('SELECT id, chat_id FROM chat_messages WHERE user_id = ? AND role = ?')
    .all(userId, role) as Array<{ id: number; chat_id: number | null }>;
  const imageFilenames = new Set<string>();
  for (const row of rows) {
    if (row.chat_id) {
      for (const filename of cleanupMessageFiles(userId, row.chat_id, row.id)) imageFilenames.add(filename);
    }
  }
  const changes = db.prepare('DELETE FROM chat_messages WHERE user_id = ? AND role = ?').run(userId, role).changes;
  cleanupUnreferencedImages(imageFilenames);
  return changes;
};

export const deleteUserHistoryMessage = (userId: number, messageId: number, mode: 'db' | 'tg') => {
  const idColumn = mode === 'tg' ? 'telegram_message_id' : 'id';
  const rows = db.prepare(`SELECT id, chat_id FROM chat_messages WHERE user_id = ? AND ${idColumn} = ?`)
    .all(userId, messageId) as Array<{ id: number; chat_id: number | null }>;
  const imageFilenames = new Set<string>();
  for (const row of rows) {
    if (row.chat_id) {
      for (const filename of cleanupMessageFiles(userId, row.chat_id, row.id)) imageFilenames.add(filename);
    }
  }
  const changes = db.prepare(`DELETE FROM chat_messages WHERE user_id = ? AND ${idColumn} = ?`).run(userId, messageId).changes;
  cleanupUnreferencedImages(imageFilenames);
  return changes;
};

export const deleteUserMessage = (userId: number, chatId: number, messageId: number): boolean => {
  const imageFilenames = cleanupMessageFiles(userId, chatId, messageId);
  const result = db.prepare(
    'DELETE FROM chat_messages WHERE id = ? AND user_id = ? AND chat_id = ?'
  ).run(messageId, userId, chatId);
  if (result.changes > 0) cleanupUnreferencedImages(imageFilenames);
  return result.changes > 0;
};

/**
 * Collects image filenames for a later reference check and immediately deletes unique attachments.
 * Best-effort: file cleanup errors do not block database deletion.
 */
const cleanupMessageFiles = (userId: number, chatId: number, messageId?: number): Set<string> => {
  const imageFilenames = new Set<string>();
  try {
    const query = messageId
      ? 'SELECT images, attachments FROM chat_messages WHERE id = ? AND user_id = ? AND chat_id = ?'
      : 'SELECT images, attachments FROM chat_messages WHERE user_id = ? AND chat_id = ?';
    const params = messageId ? [messageId, userId, chatId] : [userId, chatId];
    const rows = db.prepare(query).all(...params) as Array<{ images: string | null; attachments: string | null }>;

    for (const row of rows) {
      // Картинки
      if (row.images) {
        try {
          const imgs = JSON.parse(row.images) as MessageImage[];
          if (Array.isArray(imgs)) {
            for (const img of imgs) {
              const fn = filenameFromUrl(img?.url);
              if (fn) imageFilenames.add(fn);
            }
          }
        } catch { /* skip */ }
      }
      // Вложения
      if (row.attachments) {
        try {
          const atts = JSON.parse(row.attachments) as MessageAttachment[];
          for (const att of atts) {
            if (att.filename) deleteAttachmentFile(att.filename);
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* best-effort */ }
  return imageFilenames;
};

const isImageFilenameReferenced = (filename: string): boolean => {
  try {
    const rows = db.prepare(`
      SELECT images
      FROM chat_messages
      WHERE images IS NOT NULL AND images != '' AND images LIKE ?
    `).all(`%${filename}%`) as Array<{ images: string }>;

    return rows.some(row => {
      try {
        const images = JSON.parse(row.images) as MessageImage[];
        return Array.isArray(images)
          && images.some(image => filenameFromUrl(image?.url) === filename);
      } catch {
        return false;
      }
    });
  } catch {
    // Keeping an orphaned file is safer than deleting an image that may still be referenced.
    return true;
  }
};

const cleanupUnreferencedImages = (filenames: Iterable<string>): void => {
  for (const filename of new Set(filenames)) {
    if (!isImageFilenameReferenced(filename)) deleteImageFile(filename);
  }
};

export const editUserMessage = (
  userId: number,
  chatId: number,
  messageId: number,
  newContent: string
): { ok: boolean; token_count?: number } => {
  const row = db.prepare(
    'SELECT role FROM chat_messages WHERE id = ? AND user_id = ? AND chat_id = ?'
  ).get(messageId, userId, chatId) as { role: ChatRole } | undefined;
  if (!row) return { ok: false };

  // Пересчитываем токены для нового content
  const tokenCount = countMessageTokens(row.role, newContent);

  db.prepare(
    'UPDATE chat_messages SET content = ?, token_count = ? WHERE id = ? AND user_id = ? AND chat_id = ?'
  ).run(newContent, tokenCount, messageId, userId, chatId);

  // FTS: триггеры покрывают только INSERT/DELETE, обновляем вручную
  db.prepare(
    'UPDATE messages_fts SET content = ? WHERE message_id = ?'
  ).run(newContent, messageId);

  return { ok: true, token_count: tokenCount };
};

/**
 * List all attachments in a chat (for ToolsPanel "Documents" view).
 * Returns newest first.
 */
export const getChatAttachments = (
  userId: number,
  chatId: number
): Array<{ message_id: number; name: string; size_bytes: number; mime_type: string; url: string; filename: string; created_at: number }> => {
  const rows = db.prepare(`
    SELECT id, attachments, created_at
    FROM chat_messages
    WHERE user_id = ? AND chat_id = ? AND attachments IS NOT NULL
    ORDER BY id DESC
  `).all(userId, chatId) as Array<{ id: number; attachments: string; created_at: string }>;

  const result: Array<{ message_id: number; name: string; size_bytes: number; mime_type: string; url: string; filename: string; created_at: number }> = [];
  for (const row of rows) {
    try {
      const atts = JSON.parse(row.attachments) as MessageAttachment[];
      if (!Array.isArray(atts)) continue;
      for (const a of atts) {
        result.push({
          message_id: row.id,
          name: a.name,
          size_bytes: a.size_bytes,
          mime_type: a.mime_type,
          url: a.url,
          filename: a.filename,
          created_at: toUnix(row.created_at),
        });
      }
    } catch { /* skip */ }
  }
  return result;
};

/**
 * Delete a single attachment from a message by filename.
 * Removes the file from disk, removes the entry from the JSON array,
 * and recalculates token_count for the message.
 *
 * Returns { ok: true } if found & deleted, { ok: false } otherwise.
 */
export const deleteMessageAttachment = (
  userId: number,
  chatId: number,
  messageId: number,
  filename: string
): { ok: boolean; token_count?: number } => {
  const row = db.prepare(
    'SELECT role, content, attachments FROM chat_messages WHERE id = ? AND user_id = ? AND chat_id = ?'
  ).get(messageId, userId, chatId) as { role: ChatRole; content: string; attachments: string | null } | undefined;

  if (!row || !row.attachments) return { ok: false };

  let atts: MessageAttachment[];
  try {
    atts = JSON.parse(row.attachments);
  } catch {
    return { ok: false };
  }

  const target = atts.find(a => a.filename === filename);
  if (!target) return { ok: false };

  // 1. Remove file from disk
  try {
    deleteAttachmentFile(target.filename);
  } catch { /* best-effort */ }

  // 2. Remove from array
  const remaining = atts.filter(a => a.filename !== filename);
  const newJson = remaining.length > 0 ? JSON.stringify(remaining) : null;

  // 3. Recalculate token_count for user messages (attachments affect token count)
  let newTokenCount: number | undefined;
  if (row.role === 'user') {
    const injected = remaining.length > 0 ? injectAttachments(remaining) : '';
    newTokenCount = countMessageTokens('user', row.content + (injected ? '\n\n' + injected : ''));
  }

  // 4. UPDATE
  if (newTokenCount !== undefined) {
    db.prepare(
      'UPDATE chat_messages SET attachments = ?, token_count = ? WHERE id = ? AND user_id = ? AND chat_id = ?'
    ).run(newJson, newTokenCount, messageId, userId, chatId);
  } else {
    db.prepare(
      'UPDATE chat_messages SET attachments = ? WHERE id = ? AND user_id = ? AND chat_id = ?'
    ).run(newJson, messageId, userId, chatId);
  }

  return { ok: true, token_count: newTokenCount };
};

/**
 * Удаляет одно изображение из messages.images (JSON-колонка).
 * Удаляет файл с диска + убирает URL из массива.
 */
export const deleteMessageImage = (
  userId: number,
  messageId: number,
  imageUrl: string
): { ok: boolean } => {
  const row = db.prepare(
    'SELECT images FROM chat_messages WHERE id = ? AND user_id = ?'
  ).get(messageId, userId) as { images: string | null } | undefined;

  if (!row || !row.images) return { ok: false };

  let imgs: MessageImage[];
  try {
    imgs = JSON.parse(row.images);
  } catch {
    return { ok: false };
  }

  const target = imgs.find(a => a.url === imageUrl);
  if (!target) return { ok: false };

  // 1. Remove the reference from the array first.
  const remaining = imgs.filter(a => a.url !== imageUrl);
  const newJson = remaining.length > 0 ? JSON.stringify(remaining) : null;

  // 2. Persist the updated image list.
  db.prepare(
    'UPDATE chat_messages SET images = ? WHERE id = ? AND user_id = ?'
  ).run(newJson, messageId, userId);

  // 3. Delete the file only when neither the original message nor another branch still uses it.
  const filename = filenameFromUrl(target.url);
  if (filename) cleanupUnreferencedImages([filename]);

  return { ok: true };
};

export const getChatMessages = (userId: number, chatId: number, limit = 20, offset = 0): MessageDto[] => {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  // Access: owner or room member. In a multi-user room everyone reads all
  // chat messages regardless of authorship; a personal chat stays user-scoped.
  const readerIds = listRoomReaderUserIds(chatId);
  if (!readerIds) return [];
  if (!readerIds.includes(userId)) return [];
  const multiUserRoom = readerIds.length > 1;
  const placeholders = readerIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT m.id, m.chat_id, m.user_id, m.role, m.content, m.reasoning_content, m.tool_calls_json, m.images,
           cma.audio AS viewer_audio,
           m.telegram_chat_id, m.telegram_message_id, m.created_at, m.archived, m.token_count,
           m.reasoning_tokens, m.attachments, m.subagents_json, m.usage_json, m.prompt_id, m.prompt_name,
           m.model_name, m.provider_name, m.agent_id
    FROM chat_messages m
    LEFT JOIN chat_message_audio cma ON cma.message_id = m.id AND cma.user_id = ?
    WHERE ${multiUserRoom ? `m.user_id IN (${placeholders})` : 'm.user_id = ?'} AND m.chat_id = ?
    ORDER BY m.id DESC
    LIMIT ? OFFSET ?
  `).all(userId, ...(multiUserRoom ? readerIds : [userId]), chatId, safeLimit, safeOffset) as Array<{ id: number; chat_id: number; user_id: number; role: ChatRole; content: string; reasoning_content: string | null; tool_calls_json: string | null; images: string | null; viewer_audio: string | null; telegram_chat_id: number | null; telegram_message_id: number | null; created_at: string; archived: number; token_count: number; reasoning_tokens: number; attachments: string | null; subagents_json: string | null; usage_json: string | null; prompt_id: number | null; prompt_name: string | null; model_name: string | null; provider_name: string | null; agent_id: number | null }>;

  return rows.reverse().map(row => {
    let parsedImages: MessageImage[] | null = null;
    if (row.images) {
      try { parsedImages = JSON.parse(row.images); } catch { parsedImages = null; }
    }
    let parsedAttachments: MessageAttachment[] | null = null;
    if (row.attachments) {
      try { parsedAttachments = JSON.parse(row.attachments); } catch { parsedAttachments = null; }
    }
    // TTS audio is per-viewer: each user hears their own voice/provider.
    let parsedAudio: MessageAudio | null = null;
    if (row.viewer_audio) {
      try { parsedAudio = JSON.parse(row.viewer_audio); } catch { parsedAudio = null; }
    }
    let parsedToolCalls: Array<{ id?: string; name: string; arguments: any; result_preview?: string }> | null = null;
    if (row.tool_calls_json) {
      try {
        const raw = JSON.parse(row.tool_calls_json);
        // Поддержка двух форматов:
        //   - Старый (плоский): [{ id, name, arguments, result_preview }, ...]
        //   - Новый (trace):     [{ step, content, tool_calls, results, is_final? }, ...]
        // Новый разворачиваем обратно в плоский массив для UI popover.
        if (Array.isArray(raw) && raw.length > 0 && raw[0] && typeof raw[0].step === 'number') {
          const flat: Array<{ id?: string; name: string; arguments: any; result_preview?: string }> = [];
          for (const iter of raw as ToolIteration[]) {
            const calls = Array.isArray(iter.tool_calls) ? iter.tool_calls : [];
            const results = Array.isArray(iter.results) ? iter.results : [];
            for (const tc of calls) {
              // Ищем результат по id (приоритет) или по name
              const r = results.find(x => (tc.id && x.id === tc.id) || (!tc.id && x.name === tc.name));
              flat.push({
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
                // result_preview обрезаем так же, как formatToolResultPreview в ai.ts
                result_preview: r?.content ? r.content.slice(0, 250) : undefined
              });
            }
          }
          parsedToolCalls = flat.length > 0 ? flat : null;
        } else {
          parsedToolCalls = raw;
        }
      } catch { parsedToolCalls = null; }
    }
    return {
      id: row.id,
      chat_id: row.chat_id,
      user_id: row.user_id,
      role: row.role,
      content: row.content,
      reasoning_content: row.reasoning_content,
      tool_calls: parsedToolCalls,
      images: parsedImages,
      attachments: parsedAttachments,
      audio: parsedAudio,
      telegram_chat_id: row.telegram_chat_id,
      telegram_message_id: row.telegram_message_id,
      created_at: toUnix(row.created_at),
      archived: row.archived === 1,
      token_count: row.token_count ?? 0,
      reasoning_tokens: row.reasoning_tokens ?? 0,
      prompt_id: row.prompt_id,
      prompt_name: row.prompt_name,
      agent_id: row.agent_id,
      model_name: row.model_name,
      provider_name: row.provider_name,
      usage: (() => {
        if (!row.usage_json) return null;
        try {
          const parsed = JSON.parse(row.usage_json);
          return parsed && typeof parsed === 'object' ? parsed as MessageUsage : null;
        } catch {
          return null;
        }
      })(),
      subagents: (() => {
        if (!row.subagents_json) return null;
        try { const arr = JSON.parse(row.subagents_json); return Array.isArray(arr) ? arr : null; } catch { return null; }
      })()
    };
  });
};

/** Build a metadata-only manifest. File content is available through tools. */
export const injectAttachments = (
  attachments: MessageAttachment[],
  _maxTokens = 0
): string => {
  if (!attachments || attachments.length === 0) return '';
  return attachments
    .filter(att => Boolean(att.url))
    .map(raw => {
      const att = withAttachmentMetadata(raw);
      return [
        '[ATTACHED_DOCUMENT]',
        `name: ${att.name}`,
        `attachment_url: ${att.url}`,
        `size_bytes: ${att.size_bytes}`,
        `char_count: ${att.char_count}`,
        `estimated_tokens: ${att.estimated_tokens}`,
        `chunks: ${att.chunk_count}`,
        'Use read_attachment_file or search_attachment_file to inspect this document.',
        '[/ATTACHED_DOCUMENT]',
      ].join('\n');
    })
    .join('\n\n');
};

/**
 * Оценка токенов изображения по тайловому алгоритму (де-факто стандарт OpenAI).
 * Маленькие скриншоты ~250 токенов, большие ~1100.
 */
function estimateImageTokens(width: number, height: number): number {
  const scale = Math.min(2048 / Math.max(width, height), 768 / Math.min(width, height), 1);
  const scaledW = width * scale;
  const scaledH = height * scale;
  const tilesW = Math.ceil(scaledW / 512);
  const tilesH = Math.ceil(scaledH / 512);
  return (tilesW * tilesH * 170) + 85;
}

/**
 * Читает размеры изображения с диска через sharp.metadata() и считает токены.
 * Fallback: 1000 токенов если файл не читается.
 */
async function estimateImageTokensFromFile(url: string): Promise<number> {
  try {
    const filename = filenameFromUrl(url);
    if (!filename) return 1000;
    const filepath = resolveImageFile(filename);
    if (!filepath) return 1000;
    const sharp = (await import('sharp')).default;
    const metadata = await sharp(filepath).metadata();
    const width = metadata.width || 1920;
    const height = metadata.height || 1080;
    return estimateImageTokens(width, height);
  } catch {
    return 1000;
  }
}

export const appendChatMessage = async (
  userId: number,
  chatId: number,
  role: ChatRole,
  content: string,
  telegramChatId: number | null = null,
  telegramMessageId: number | null = null,
  images: MessageImage[] | null = null,
  reasoningContent: string | null = null,
  toolCallsJson: string | null = null,
  attachments: MessageAttachment[] | null = null,
  subagentsJson: string | null = null,
  metadata?: {
    usage?: MessageUsage | null;
    promptId?: number | null;
    promptName?: string | null;
    modelName?: string | null;
    providerName?: string | null;
    agentId?: number | null;
  }
) => {
  const imagesJson = images && images.length > 0 ? JSON.stringify(images) : null;
  const attachmentsJson = attachments && attachments.length > 0 ? JSON.stringify(attachments) : null;
  const reasoning = role === 'assistant' && reasoningContent?.trim() ? reasoningContent.trim() : null;
  const tcJson = role === 'assistant' && toolCallsJson?.trim() ? toolCallsJson.trim() : null;
  const saj = role === 'assistant' && subagentsJson?.trim() ? subagentsJson.trim() : null;
  const usageJson = role === 'assistant' && metadata?.usage ? JSON.stringify(metadata.usage) : null;
  const promptId = role === 'assistant' && Number.isSafeInteger(metadata?.promptId) ? Number(metadata?.promptId) : null;
  const promptName = role === 'assistant' ? metadata?.promptName?.trim() || null : null;
  const modelName = role === 'assistant' ? metadata?.modelName?.trim() || null : null;
  const providerName = role === 'assistant' ? metadata?.providerName?.trim() || null : null;
  const agentId = role === 'assistant' && Number.isSafeInteger(metadata?.agentId) ? Number(metadata?.agentId) : null;

  // ── Token accounting ────────────────────────────────────────────────────
  // token_count = вес сообщения в AI-контексте (не включает reasoning).
  // reasoning_tokens = отдельный счётчик для reasoning_content (для UI-бейджа).
  let tokenCount = 0;
  let reasoningTokens = 0;

  if (role === 'user') {
    // Для user-сообщений считаем текст + инъекцию attachments + images.
    const injected = attachments && attachments.length > 0 ? injectAttachments(attachments) : '';
    const fullContent = content + (injected ? '\n\n' + injected : '');
    tokenCount = countMessageTokens('user', fullContent);

    if (images && images.length > 0) {
      for (const img of images) {
        tokenCount += await estimateImageTokensFromFile(img.url);
      }
    }
  } else {
    // assistant: считаем по развёрнутому trace (как в getHistoryForAi),
    // чтобы оценка совпадала с реальным payload в API.
    const expanded = expandAssistantMessage(content, tcJson);
    for (const msg of expanded) {
      if (msg.role === 'assistant') {
        // assistant(content=null, tool_calls=[...]) или assistant(content=text)
        let msgTokens = countMessageTokens('assistant', msg.content);
        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            msgTokens += countToolCallTokens(
              tc.function?.name ?? '',
              tc.function?.arguments,
              tc.id ?? ''
            );
          }
        }
        tokenCount += msgTokens;
      } else if (msg.role === 'tool') {
        tokenCount += countToolResultTokens(
          msg.name ?? '',
          msg.tool_call_id ?? '',
          msg.content ?? ''
        );
      }
    }
    // Reasoning считается отдельно — он не уходит в контекст, но нужен для UI-бейджа.
    if (reasoning) {
      reasoningTokens = countTokens(reasoning);
    }
    const providerReasoningTokens = Math.max(0, Math.floor(Number(metadata?.usage?.aggregate?.reasoning_tokens || 0)));
    if (providerReasoningTokens > 0) {
      reasoningTokens = providerReasoningTokens;
    }

    // Assistant images (скриншоты, generate_image) не отправляются в AI-контекст,
    // поэтому их токены не учитываются.

    // Subagent trace tokens: считаем вес subagents_json (tool calls + results
    // каждого субагента), чтобы оценка контекста сообщения была точной.
    // В AI-контекст не отправляется (как reasoning), но нужен для подсчёта
    // общего "веса" сообщения и отображения в UI.
    if (saj) {
      try {
        const saParsed = JSON.parse(saj);
        if (Array.isArray(saParsed)) {
          for (const sa of saParsed) {
            // Считаем task + system_prompt + answer
            tokenCount += countTokens(String(sa.task || ''));
            tokenCount += countTokens(String(sa.system_prompt || ''));
            tokenCount += countTokens(String(sa.answer || ''));
            // Считаем iterations (tool calls + results)
            if (Array.isArray(sa.iterations)) {
              for (const iter of sa.iterations) {
                if (Array.isArray(iter.tool_calls)) {
                  for (const tc of iter.tool_calls) {
                    tokenCount += countToolCallTokens(
                      tc.name ?? '',
                      typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
                      tc.id ?? ''
                    );
                  }
                }
                if (Array.isArray(iter.results)) {
                  for (const res of iter.results) {
                    tokenCount += countToolResultTokens(
                      res.name ?? '',
                      res.id ?? '',
                      res.content ?? ''
                    );
                  }
                }
              }
            }
            // Fallback: старый формат с плоским trace
            if (Array.isArray(sa.trace)) {
              for (const t of sa.trace) {
                tokenCount += countToolCallTokens(t.tool ?? '', JSON.stringify(t.args ?? {}), '');
                tokenCount += countToolResultTokens(t.tool ?? '', '', String(t.result ?? ''));
              }
            }
          }
        }
      } catch { /* skip invalid JSON */ }
    }
  }

  const inserted = db.prepare(`
    INSERT INTO chat_messages (
      user_id, role, content, chat_id, telegram_chat_id, telegram_message_id,
      images, reasoning_content, tool_calls_json, token_count, reasoning_tokens,
      attachments, subagents_json, usage_json, prompt_id, prompt_name, model_name, provider_name, agent_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId, role, content, chatId, telegramChatId, telegramMessageId,
    imagesJson, reasoning, tcJson, tokenCount, reasoningTokens,
    attachmentsJson, saj, usageJson, promptId, promptName, modelName, providerName, agentId
  );
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

/**
 * TTS audio is INDIVIDUAL: stored per (message, user). Room members each get
 * their own voice/provider; nobody overwrites anyone else's audio.
 */
export const updateChatMessageAudio = (
  userId: number,
  messageId: number,
  audio: MessageAudio
) => db.prepare(`
  INSERT INTO chat_message_audio (message_id, user_id, audio)
  VALUES (?, ?, ?)
  ON CONFLICT(message_id, user_id) DO UPDATE SET audio = excluded.audio
`).run(messageId, userId, JSON.stringify(audio));

export const getChatMessageOwner = (messageId: number): number | null => {
  const row = db.prepare('SELECT user_id FROM chat_messages WHERE id = ?').get(messageId) as { user_id: number } | undefined;
  return row?.user_id ?? null;
};

/**
 * Возвращает token_count и reasoning_tokens конкретного сообщения.
 * Используется в sendMessageThroughAi для добавления токенов в AiSendResult,
 * чтобы клиент получил их в `done` событии без повторного запроса.
 */
export const getMessageTokens = (messageId: number): { token_count: number; reasoning_tokens: number } => {
  const row = db.prepare('SELECT token_count, reasoning_tokens FROM chat_messages WHERE id = ?').get(messageId) as { token_count: number; reasoning_tokens: number } | undefined;
  return { token_count: row?.token_count ?? 0, reasoning_tokens: row?.reasoning_tokens ?? 0 };
};

export type ChatMediaItem = {
  message_id: number;
  url: string;
  type: 'user_photo' | 'generated';
  created_at: number;
  chat_id?: number;
  chat_title?: string;
};

export const getChatMedia = (userId: number, chatId: number, limit = 100, offset = 0): ChatMediaItem[] => {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  // Access + scope mirror getChatMessages: in a multi-user room every reader
  // sees ALL room images (not only their own); personal chats stay user-scoped.
  const readerIds = listRoomReaderUserIds(chatId);
  if (!readerIds || !readerIds.includes(userId)) return [];
  const multiUserRoom = readerIds.length > 1;
  // Берём с запасом по строкам — одна строка может содержать несколько картинок
  const rowLimit = safeOffset + safeLimit + 50;
  const rows = db.prepare(`
    SELECT id, images, created_at
    FROM chat_messages
    WHERE user_id ${multiUserRoom ? `IN (${readerIds.map(() => '?').join(', ')})` : '= ?'} AND chat_id = ? AND images IS NOT NULL AND images != ''
    ORDER BY id DESC
    LIMIT ?
  `).all(...(multiUserRoom ? readerIds : [userId]), chatId, rowLimit) as Array<{ id: number; images: string; created_at: string }>;

  const items: ChatMediaItem[] = [];
  for (const row of rows) {
    try {
      const imgs = JSON.parse(row.images) as MessageImage[];
      for (const img of imgs) {
        if (img.url) {
          items.push({
            message_id: row.id,
            url: img.url,
            type: img.type,
            created_at: toUnix(row.created_at),
          });
        }
      }
    } catch { /* skip invalid JSON */ }
  }
  // Обрезаем по реальному количеству изображений
  return items.slice(safeOffset, safeOffset + safeLimit);
};

/**
 * Возвращает медиа (изображения) из всех чатов пользователя.
 * JOIN с user_chats для получения названия чата.
 * Пагинация по итоговым изображениям, а не по строкам chat_messages.
 */
export const getAllUserMedia = (userId: number, limit = 100, offset = 0): ChatMediaItem[] => {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  // Expand image arrays before pagination and keep the oldest surviving
  // reference for each URL. Forks share image files, so this prevents one
  // physical image from appearing multiple times in the all-chats gallery.
  const rows = db.prepare(`
    WITH expanded_media AS (
      SELECT
        cm.id AS message_id,
        cm.chat_id,
        cm.created_at,
        uc.title AS chat_title,
        json_extract(image.value, '$.url') AS url,
        json_extract(image.value, '$.type') AS type
      FROM chat_messages cm
      LEFT JOIN user_chats uc ON uc.id = cm.chat_id AND uc.user_id = ?
      JOIN json_each(CASE WHEN json_valid(cm.images) THEN cm.images ELSE '[]' END) image
      WHERE (cm.user_id = ? OR cm.chat_id IN (
          SELECT rc.id FROM user_chats rc
          WHERE rc.room_enabled = 1
            AND (rc.user_id = ? OR EXISTS (
              SELECT 1 FROM chat_members m WHERE m.chat_id = rc.id AND m.user_id = ?
            ))
        ))
        AND cm.images IS NOT NULL
        AND cm.images != ''
        AND json_type(image.value) = 'object'
        AND COALESCE(json_extract(image.value, '$.url'), '') != ''
    ), ranked_media AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY url
        ORDER BY message_id ASC
      ) AS reference_rank
      FROM expanded_media
    )
    SELECT message_id, chat_id, created_at, chat_title, url, type
    FROM ranked_media
    WHERE reference_rank = 1
    ORDER BY message_id DESC
    LIMIT ? OFFSET ?
  `).all(userId, userId, userId, userId, safeLimit, safeOffset) as Array<{
    message_id: number;
    chat_id: number;
    created_at: string;
    chat_title: string | null;
    url: string;
    type: MessageImage['type'];
  }>;

  const userLanguage = (db.prepare('SELECT language FROM users WHERE id = ?').get(userId) as { language: string | null } | undefined)?.language;
  return rows.map(row => ({
    message_id: row.message_id,
    url: row.url,
    type: row.type,
    created_at: toUnix(row.created_at),
    chat_id: row.chat_id,
    chat_title: row.chat_title || formatAutomaticChatTitle(userLanguage, row.chat_id),
  }));
};

/**
 * Разворачивает одну строку chat_messages (role + content + tool_calls_json)
 * в массив OpenAI-совместимых сообщений. Используется и в getHistoryForAi()
 * (сборка контекста для API), и в подсчёте token_count (чтобы оценка совпадала
 * с реальным payload).
 *
 * Возвращает массив сообщений {role, content?, tool_calls?, tool_call_id?, name?}.
 */
function expandAssistantMessage(content: string, toolCallsJson: string | null): any[] {
  // Нет tool_calls — обычное текстовое сообщение
  let parsed: any = null;
  if (toolCallsJson) {
    try { parsed = JSON.parse(toolCallsJson); } catch { parsed = null; }
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return [{ role: 'assistant', content }];
  }

  // Маркер нового формата: первый элемент содержит поле `step`
  const isNewFormat = parsed[0] && typeof parsed[0].step === 'number';

  if (!isNewFormat) {
    // Старый плоский формат — нет данных о результатах.
    return [{ role: 'assistant', content }];
  }

  const iterations = parsed as ToolIteration[];
  const messages: any[] = [];

  for (const iter of iterations) {
    const hasToolCalls = Array.isArray(iter.tool_calls) && iter.tool_calls.length > 0;

    if (hasToolCalls) {
      messages.push({
        role: 'assistant',
        content: iter.content && iter.content.length > 0 ? iter.content : null,
        tool_calls: iter.tool_calls.map(tc => ({
          id: tc.id ?? `call_${iter.step}_${tc.name}`,
          type: 'function',
          function: {
            name: tc.name,
            arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {})
          }
        }))
      });

      const results = Array.isArray(iter.results) ? iter.results : [];
      for (const tc of iter.tool_calls) {
        const result = results.find(r =>
          (tc.id && r.id === tc.id) || (!tc.id && r.name === tc.name)
        );
        messages.push({
          role: 'tool',
          tool_call_id: tc.id ?? `call_${iter.step}_${tc.name}`,
          name: tc.name,
          content: result?.content ?? '(нет результата)'
        });
      }
    }

    if (!hasToolCalls && iter.content && iter.content.length > 0) {
      // Для финальной итерации берём content из колонки БД — он мог быть
      // отредактирован пользователем через editUserMessage, который обновляет
      // только chat_messages.content, но не tool_calls_json.
      const isLast = iter === iterations[iterations.length - 1];
      const text = isLast ? content : iter.content;
      if (text && text.length > 0) {
        messages.push({ role: 'assistant', content: text });
      }
    }
  }

  return messages;
}

/**
 * История сообщений для отправки в AI.
 *
 * Разворачивает tool_calls_json (новый формат с `step`-итерациями) в корректную
 * последовательность OpenAI-совместимых сообщений:
 *   assistant(tool_calls) → tool(results) → assistant(tool_calls) → tool(results) → ... → assistant(text)
 *
 * Старый формат (плоский массив без `step`) и сообщения без tool_calls_json
 * обрабатываются как fallback — отдаётся только {role, content}.
 *
 * Reasoning в API не отправляется (односторонний вывод модели).
 */
/** True when the chat is a room with more than one participant (reader). */
export const isMultiUserRoomChat = (chatId: number): boolean =>
  (listRoomReaderUserIds(chatId)?.length ?? 0) > 1;

export const getHistoryForAi = (
  userId: number,
  chatId: number,
  attachmentMaxTokens = 0,
  supportsVision = false,
  attachmentBudgetState?: { remaining: number },
  responseAgentId: number | null = null,
  /** Virtual truncation budget (tokens) for multi-user rooms: keep newest
   *  messages while they fit, drop the rest. No DB archivation involved. */
  roomHistoryTokenBudget = 0,
): any[] => {
  const activeRoomAgents = responseAgentId !== null
    ? db.prepare(`
        SELECT id, name
        FROM chat_agents
        WHERE chat_id = ? AND is_active = 1
        ORDER BY sort_order ASC, id ASC
      `).all(chatId) as Array<{ id: number; name: string }>
    : [];
  const shouldSeparateRoomAgents = activeRoomAgents.length > 1;
  const primaryRoomAgent = activeRoomAgents[0] ?? null;
  // Multi-user room: history spans all participants' messages. Personal chat:
  // only the user's own messages.
  const readerIds = listRoomReaderUserIds(chatId) ?? [userId];
  const multiUserRoom = readerIds.includes(userId) && readerIds.length > 1;
  const historyUserIds = multiUserRoom ? readerIds : [userId];
  const placeholders = historyUserIds.map(() => '?').join(', ');
  const rowsQuery = db.prepare(`
    SELECT cm.id, cm.role, cm.content, cm.tool_calls_json, cm.attachments, cm.images,
           cm.agent_id, ca.name AS agent_name, u.name AS author_name, cm.token_count
    FROM chat_messages cm
    LEFT JOIN chat_agents ca ON ca.id = cm.agent_id
    LEFT JOIN users u ON u.id = cm.user_id
    WHERE cm.user_id IN (${placeholders}) AND cm.chat_id = ? AND cm.archived = 0
    ORDER BY cm.id DESC
  `);
  let rows = rowsQuery.all(...historyUserIds, chatId) as Array<{ id: number; role: ChatRole; content: string; tool_calls_json: string | null; attachments: string | null; images: string | null; agent_id: number | null; agent_name: string | null; author_name: string | null; token_count: number | null }>;

  // Multi-user rooms: virtual truncation — walk from the newest message back,
  // keep messages while they fit into the budget. The newest message is always
  // kept even if it alone exceeds the budget. No DB rows are modified.
  if (multiUserRoom && roomHistoryTokenBudget > 0 && rows.length > 0) {
    let used = 0;
    let keep = 1; // newest message is always kept
    for (let i = 0; i < rows.length; i += 1) {
      const cost = Math.max(0, rows[i].token_count ?? countTokens(rows[i].content || ''));
      if (i > 0 && used + cost > roomHistoryTokenBudget) break;
      used += cost;
      keep = i + 1;
    }
    rows = rows.slice(0, keep);
  }
  rows.reverse();

  const messages: any[] = [];
  const attachmentBudget = attachmentBudgetState ?? { remaining: attachmentMaxTokens };
  const attachmentInjectionByMessage = new Map<number, string>();

  // Newest documents have priority when the global document budget is tight.
  if (attachmentMaxTokens > 0) {
    for (let index = rows.length - 1; index >= 0 && attachmentBudget.remaining > 0; index -= 1) {
      const row = rows[index];
      if (row.role !== 'user' || !row.attachments) continue;
      try {
        const parsed = JSON.parse(row.attachments) as MessageAttachment[];
        if (!Array.isArray(parsed) || parsed.length === 0) continue;
        const injected = injectAttachments(parsed, attachmentBudget.remaining);
        if (!injected) continue;
        attachmentInjectionByMessage.set(row.id, injected);
        attachmentBudget.remaining = Math.max(0, attachmentBudget.remaining - countTokens(injected));
      } catch {
        // Ignore malformed legacy attachment JSON.
      }
    }
  }

  for (const row of rows) {
    if (row.role === 'user') {
      // Достаём attachments (если есть) и инъектируем в content.
      let injected = attachmentInjectionByMessage.get(row.id) || '';
      if (attachmentMaxTokens <= 0 && row.attachments) {
        try {
          const parsedAttachments = JSON.parse(row.attachments) as MessageAttachment[];
          injected = Array.isArray(parsedAttachments) ? injectAttachments(parsedAttachments, 0) : '';
        } catch {
          injected = '';
        }
      }

      // Достаём images (если есть) — user_photo и generated обрабатываем одинаково.
      let parsedImages: MessageImage[] | null = null;
      if (row.images) {
        try { parsedImages = JSON.parse(row.images); } catch { parsedImages = null; }
      }
      const allImages = parsedImages ?? [];

      let textContent = row.content;
      if (injected) textContent += '\n\n' + injected;
      // Multi-user room: label human messages with the author's name so room
      // agents can tell participants apart (same convention as agent messages).
      if (multiUserRoom && row.author_name) {
        textContent = `[ROOM MESSAGE FROM ${JSON.stringify(row.author_name)}]\n${textContent}`;
      }

      if (allImages.length > 0 && supportsVision) {
        // Vision: загружаем файлы с диска, формируем content как массив text + image_url.
        // Маркеры с URL добавляются в text — чтобы модель могла передать их в generate_image / describe_image.
        const imageMarker = allImages.map((img, i) => `[Attached image ${i + 1}: ${img.url}]`).join('\n');
        const textWithMarkers = textContent + (imageMarker ? '\n' + imageMarker : '');

        const imageBlocks: any[] = [];
        for (const img of allImages) {
          try {
            const filename = filenameFromUrl(img.url);
            if (!filename) continue;
            const filepath = resolveImageFile(filename);
            if (!filepath) continue;
            const buf = fs.readFileSync(filepath);
            const ext = path.extname(filename).toLowerCase();
            const mimeType = ext === '.webp' ? 'image/webp' : ext === '.png' ? 'image/png' : 'image/jpeg';
            imageBlocks.push({
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${buf.toString('base64')}` }
            });
          } catch { /* skip unreadable */ }
        }

        if (imageBlocks.length > 0) {
          messages.push({
            role: row.role,
            content: [
              { type: 'text', text: textWithMarkers },
              ...imageBlocks,
            ]
          });
        } else {
          // Файлы не читаются — fallback на маркер
          messages.push({ role: row.role, content: textWithMarkers });
        }
      } else if (allImages.length > 0) {
        // Не-vision: текстовый маркер с URL
        const imageMarker = allImages.map((img, i) => `[Attached image ${i + 1}: ${img.url}]`).join('\n');
        messages.push({ role: row.role, content: textContent + '\n' + imageMarker });
      } else {
        // Нет фото — обычный content
        messages.push({ role: row.role, content: textContent });
      }
      continue;
    }
    // role === 'assistant'
    const effectiveAgentId = row.agent_id ?? primaryRoomAgent?.id ?? null;
    const effectiveAgentName = row.agent_name ?? (row.agent_id === null ? primaryRoomAgent?.name : null);
    if (
      shouldSeparateRoomAgents
      && effectiveAgentId !== null
      && effectiveAgentId !== responseAgentId
      && effectiveAgentName
    ) {
      const participantText = row.content.trim();
      if (participantText) {
        messages.push({
          role: 'user',
          content: `[ROOM MESSAGE FROM ${JSON.stringify(effectiveAgentName)}]\n${participantText}`,
        });
      }
      continue;
    }
    const expanded = expandAssistantMessage(row.content, row.tool_calls_json);

    // Assistant images (скриншоты, generate_image) не добавляются в AI-контекст.
    // image_url в role: 'assistant' не поддерживается многими провайдерами,
    // а текстовые маркеры модель путает со своим ответом.
    // Картинки остаются в БД и UI; модель может получить к ним доступ через describe_image.

    messages.push(...expanded);
  }

  return messages;
};

/**
 * Epoch Trimming — архивация по токенам, а не по количеству сообщений.
 *
 * Алгоритм:
 * 1. Считаем SUM(token_count) всех неархивных сообщений + system_prompt_tokens.
 * 2. Если сумма ≤ maxContextTokens — ничего не делаем.
 * 3. Если превышено — архивируем самые старые сообщения, пока контекст
 *    не схлопнется до ~50% от лимита. Один UPDATE, минимум дёрганья кэша.
 *
 * возвращает { archived_count, tokens_before, tokens_after } для логирования.
 */
const getProviderContextEstimateForUsers = (userIds: number[], chatId: number): number | null => {
  if (userIds.length === 0) return null;
  const placeholders = userIds.map(() => '?').join(', ');
  const latestAssistant = db.prepare(`
    SELECT id, created_at, usage_json
    FROM chat_messages
    WHERE user_id IN (${placeholders}) AND chat_id = ? AND role = 'assistant' AND usage_json IS NOT NULL
    ORDER BY id DESC
    LIMIT 1
  `).get(...userIds, chatId) as { id: number; created_at: string; usage_json: string | null } | undefined;

  if (!latestAssistant?.usage_json) return null;

  try {
    const usage = JSON.parse(latestAssistant.usage_json) as MessageUsage;
    const latest = usage?.latest;
    if (!latest || latest.prompt_tokens <= 0) return null;

    const activeLocal = db.prepare(`
      SELECT COALESCE(SUM(token_count), 0) AS tokens
      FROM chat_messages
      WHERE user_id IN (${placeholders}) AND chat_id = ? AND archived = 0
    `).get(...userIds, chatId) as { tokens: number };

    if (
      Number.isFinite(usage.context_estimate_tokens)
      && Number.isFinite(usage.context_local_tokens)
    ) {
      return Math.max(
        0,
        Number(usage.context_estimate_tokens)
          + Number(activeLocal?.tokens || 0)
          - Number(usage.context_local_tokens)
      );
    }

    // Provider prompt already contains system prompt, tools, history and tool-loop.
    // The visible final answer is added because it becomes part of the next request;
    // hidden reasoning is not persisted into the AI context.
    const visibleCompletionTokens = Math.max(0, latest.completion_tokens - latest.reasoning_tokens);
    const providerContextAtResponse = latest.prompt_tokens + visibleCompletionTokens;

    // Messages archived after this response are no longer in the current context.
    const archivedAfter = db.prepare(`
      SELECT COALESCE(SUM(token_count), 0) AS tokens
      FROM chat_messages
      WHERE user_id IN (${placeholders}) AND chat_id = ? AND archived = 1
        AND id <= ? AND archived_at >= ?
    `).get(...userIds, chatId, latestAssistant.id, latestAssistant.created_at) as { tokens: number };

    // Defensive support for persisted rows added after the latest assistant message.
    const activeAfter = db.prepare(`
      SELECT COALESCE(SUM(token_count), 0) AS tokens
      FROM chat_messages
      WHERE user_id IN (${placeholders}) AND chat_id = ? AND archived = 0 AND id > ?
    `).get(...userIds, chatId, latestAssistant.id) as { tokens: number };

    return Math.max(
      0,
      providerContextAtResponse - Number(archivedAfter?.tokens || 0) + Number(activeAfter?.tokens || 0)
    );
  } catch {
    return null;
  }
};

export const getProviderContextEstimate = (userId: number, chatId: number): number | null =>
  getProviderContextEstimateForUsers([userId], chatId);

const saveProviderContextAnchor = (
  userId: number,
  chatId: number,
  contextEstimate: number,
  localTokens: number
) => {
  const latestAssistant = db.prepare(`
    SELECT id, usage_json
    FROM chat_messages
    WHERE user_id = ? AND chat_id = ? AND role = 'assistant' AND usage_json IS NOT NULL
    ORDER BY id DESC
    LIMIT 1
  `).get(userId, chatId) as { id: number; usage_json: string | null } | undefined;

  if (!latestAssistant?.usage_json) return;
  try {
    const usage = JSON.parse(latestAssistant.usage_json) as MessageUsage;
    usage.context_estimate_tokens = Math.max(0, Math.floor(contextEstimate));
    usage.context_local_tokens = Math.max(0, Math.floor(localTokens));
    db.prepare('UPDATE chat_messages SET usage_json = ? WHERE id = ? AND user_id = ?')
      .run(JSON.stringify(usage), latestAssistant.id, userId);
  } catch {
    // Ignore malformed legacy usage JSON.
  }
};

export const trimUserHistoryByChat = (userId: number, chatId: number, maxContextTokens: number): { archived_count: number; tokens_before: number; tokens_after: number } => {
  const tokenLimit = Math.max(1000, Math.floor(maxContextTokens));

  // 1. Берём все неархивные сообщения (id, token_count), старые → новые.
  const rows = db.prepare(`
    SELECT id, token_count
    FROM chat_messages
    WHERE user_id = ? AND chat_id = ? AND archived = 0
    ORDER BY id ASC
  `).all(userId, chatId) as Array<{ id: number; token_count: number }>;

  if (rows.length === 0) return { archived_count: 0, tokens_before: 0, tokens_after: 0 };

  // Provider usage is the source of truth for total context size. Local
  // token_count remains only as a per-message weight for selecting old rows.
  const providerContextEstimate = getProviderContextEstimate(userId, chatId);
  const providerAnchored = providerContextEstimate !== null;

  // Fallback for chats without provider usage yet.
  let systemPromptTokens = 0;
  const user = providerAnchored ? null : getUserById(userId);
  if (!providerAnchored && user) {
    const promptContent = resolvePromptForUser(user).content;
    const coreMemory = user.core_memory || '';
    const pinnedMacros = getEnabledMacros(userId).filter(m => m.pinned);
    const pinnedMacrosHint = pinnedMacros.length > 0
      ? `\n\n[ЗАКРЕПЛЁННЫЕ МАКРОСЫ]\nУ пользователя есть часто используемые макросы: ${pinnedMacros.map(m => `"${m.title}"`).join(', ')}. Если запрос пользователя явно совпадает с назначением одного из них — вызови list_my_macros чтобы посмотреть подробности, затем execute_macro для запуска.`
      : '';
    const systemPrompt = buildBaseSystemPromptForUser(user, promptContent, coreMemory, pinnedMacrosHint, false);
    systemPromptTokens = countMessageTokens('system', systemPrompt);
  }

  // 3. Сумма токенов всех неархивных сообщений.
  let totalMessageTokens = rows.reduce((sum, r) => sum + (r.token_count || 0), 0);
  let totalContextTokens = providerContextEstimate ?? (totalMessageTokens + systemPromptTokens);

  // 3b. РАЗАРХИВАЦИЯ: если лимит позволяет, возвращаем свежие архивные сообщения.
  // Критически важно чтобы пользователь мог увеличить лимит и получить историю назад.
  // Используем 80% лимита как порог разархивации (буфер, чтобы не разархивировать
  // и тут же заархивировать в одном проходе).
  if (totalContextTokens < tokenLimit) {
    const unarchiveThreshold = Math.floor(tokenLimit * 0.8);
    const availableBudget = unarchiveThreshold - totalContextTokens;

    if (availableBudget > 0) {
      // Берём архивные сообщения, свежие → старые (id DESC).
      const archivedRows = db.prepare(`
        SELECT id, token_count
        FROM chat_messages
        WHERE user_id = ? AND chat_id = ? AND archived = 1
        ORDER BY id DESC
      `).all(userId, chatId) as Array<{ id: number; token_count: number }>;

      if (archivedRows.length > 0) {
        const idsToUnarchive: number[] = [];
        let unarchiveAccumulated = 0;

        for (const row of archivedRows) {
          if (unarchiveAccumulated + (row.token_count || 0) > availableBudget) break;
          idsToUnarchive.push(row.id);
          unarchiveAccumulated += row.token_count || 0;
        }

        if (idsToUnarchive.length > 0) {
          const ph = idsToUnarchive.map(() => '?').join(',');
          db.prepare(`
            UPDATE chat_messages
            SET archived = 0,
                archived_at = NULL
            WHERE id IN (${ph})
          `).run(...idsToUnarchive);
          totalMessageTokens += unarchiveAccumulated;
          totalContextTokens += unarchiveAccumulated;
        }
      }
    }
  }

  // 4. Если контекст в пределах лимита — ничего не делаем.
  if (totalContextTokens <= tokenLimit) {
    if (providerAnchored) {
      saveProviderContextAnchor(userId, chatId, totalContextTokens, totalMessageTokens);
    }
    return { archived_count: 0, tokens_before: totalContextTokens, tokens_after: totalContextTokens };
  }

  // 5. Схлопываем до 50% лимита.
  const targetTokens = Math.floor(tokenLimit * 0.5);
  // Сколько токенов нужно срезать (минимум, чтобы оказаться в районе target).
  const tokensToArchive = providerAnchored
    ? Math.max(0, totalContextTokens - targetTokens)
    : totalMessageTokens - Math.max(0, targetTokens - systemPromptTokens);

  // 6. Идём от самых старых, собираем ID для архивации.
  const idsToArchive: number[] = [];
  let accumulated = 0;
  for (const row of rows) {
    if (accumulated >= tokensToArchive) break;
    idsToArchive.push(row.id);
    accumulated += row.token_count || 0;
  }

  // Гарантия: всегда оставляем хотя бы 1 сообщение активным.
  if (idsToArchive.length >= rows.length) {
    idsToArchive.pop(); // оставляем самое свежее из тех, что попали в список
  }

  if (idsToArchive.length === 0) {
    if (providerAnchored) {
      saveProviderContextAnchor(userId, chatId, totalContextTokens, totalMessageTokens);
    }
    return { archived_count: 0, tokens_before: totalContextTokens, tokens_after: totalContextTokens };
  }

  // 7. Один пакетный UPDATE.
  const placeholders = idsToArchive.map(() => '?').join(',');
  db.prepare(`
    UPDATE chat_messages
    SET archived = 1,
        archived_at = CURRENT_TIMESTAMP
    WHERE id IN (${placeholders})
  `).run(...idsToArchive);

  const tokensAfter = totalContextTokens - accumulated;
  if (providerAnchored) {
    saveProviderContextAnchor(
      userId,
      chatId,
      Math.max(0, tokensAfter),
      Math.max(0, totalMessageTokens - accumulated)
    );
  }

  return { archived_count: idsToArchive.length, tokens_before: totalContextTokens, tokens_after: Math.max(0, tokensAfter) };
};

export const resetDailyMessageCounters = () => db.prepare(`
  UPDATE users
  SET daily_message_count = 0,
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

/**
 * Резолвит эффективный лимит контекста в токенах для пользователя.
 * Берёт min(max_context_tokens, max_context_tokens_limit).
 * Fallback на единый конфиг тарифов.
 */
export const resolveMaxContextTokens = (user: UserRecord): number => {
  const planLimit = getPlanLimits(user.plan).max_context_tokens;
  const hardLimit = Number.isFinite(user.max_context_tokens_limit) && user.max_context_tokens_limit! > 0
    ? Math.floor(user.max_context_tokens_limit!) : planLimit;
  const userChoice = Number.isFinite(user.max_context_tokens) && user.max_context_tokens! > 0
    ? Math.floor(user.max_context_tokens!) : hardLimit;
  return Math.max(1000, Math.min(userChoice, hardLimit));
};

export const updateUserMaxContextTokens = (userId: number, maxContextTokens: number) => {
  const safeValue = Math.max(1000, Math.floor(maxContextTokens));
  return db.prepare(`
    UPDATE users
    SET max_context_tokens = ?
    WHERE id = ?
  `).run(safeValue, userId);
};

/**
 * Резолвит эффективный лимит токенов для инъекции attachments.
 * - 0 = авто: 90% от max_context_tokens.
 * - Иначе — значение юзера, но не больше 90% от max_context_tokens.
 */
export const resolveAttachmentMaxTokens = (user: UserRecord): number => {
  const maxCtx = resolveMaxContextTokens(user);
  const hardCap = Math.floor(maxCtx * 0.9);
  const userChoice = Number.isFinite(user.attachment_max_tokens) && user.attachment_max_tokens! > 0
    ? Math.floor(user.attachment_max_tokens!) : hardCap;
  return Math.max(0, Math.min(userChoice, hardCap));
};

export const updateUserAttachmentMaxTokens = (userId: number, attachmentMaxTokens: number) => {
  const safeValue = Math.max(0, Math.floor(attachmentMaxTokens));
  return db.prepare(`
    UPDATE users
    SET attachment_max_tokens = ?
    WHERE id = ?
  `).run(safeValue, userId);
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

export const upsertTelegramUser = (
  tgId: number,
  name: string,
  role: string,
  status: UserStatus,
  tgUsername: string | null,
  defaultPromptId: number | null,
  language?: string | null,
) => db.transaction(() => {
  const accountId = resolveTelegramAccountForUpsert(tgId);
  const normalizedLanguage = normalizeSupportedLanguage(language);
  const effectiveRole = role === 'admin' ? 'admin' : 'user';
  const effectiveIsAdmin = effectiveRole === 'admin' ? 1 : 0;
  const limits = getDefaultUserPlanLimits();
  const weeklyCostQuota = limits.budget_usd > 0 ? limits.budget_usd / 4 : 0;

  const result = db.prepare(`
    INSERT INTO users (id, name, role, is_admin, status, plan, language, selected_prompt_id,
      daily_web_search_limit, daily_image_gen_limit, max_context_tokens_limit, max_context_tokens,
      weekly_tokens_quota, weekly_cost_quota, weekly_cost_quota_limit)
    VALUES (?, ?, ?, ?, ?, 'free', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      role = excluded.role,
      is_admin = CASE WHEN users.is_admin = 1 THEN 1 ELSE excluded.is_admin END,
      status = excluded.status,
      language = COALESCE(users.language, excluded.language),
      selected_prompt_id = COALESCE(users.selected_prompt_id, excluded.selected_prompt_id)
  `).run(accountId, name, effectiveRole, effectiveIsAdmin, status, normalizedLanguage, defaultPromptId,
    limits.daily_web_search_limit, limits.daily_image_gen_limit, limits.max_context_tokens, limits.max_context_tokens,
    limits.weekly_token_quota, weeklyCostQuota, weeklyCostQuota);

  ensureTelegramIdentity(accountId, tgId, tgUsername);
  ensureActiveChat(accountId);
  return result;
})();

export const createPendingTelegramUser = (
  tgId: number,
  name: string | null,
  tgUsername: string | null,
  defaultPromptId: number | null,
  language?: string | null,
) => db.transaction(() => {
  const accountId = resolveTelegramAccountForUpsert(tgId);
  const normalizedLanguage = normalizeSupportedLanguage(language);
  const limits = getDefaultUserPlanLimits();
  const weeklyCostQuota = limits.budget_usd > 0 ? limits.budget_usd / 4 : 0;
  const result = db.prepare(`
    INSERT INTO users (id, name, role, is_admin, status, plan, language, selected_prompt_id,
      daily_web_search_limit, daily_image_gen_limit, max_context_tokens_limit, max_context_tokens,
      weekly_tokens_quota, weekly_cost_quota, weekly_cost_quota_limit)
    VALUES (?, ?, 'user', 0, 'none', 'free', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = COALESCE(excluded.name, users.name),
      language = COALESCE(users.language, excluded.language),
      selected_prompt_id = COALESCE(users.selected_prompt_id, excluded.selected_prompt_id)
  `).run(accountId, name, normalizedLanguage, defaultPromptId,
    limits.daily_web_search_limit, limits.daily_image_gen_limit, limits.max_context_tokens, limits.max_context_tokens,
    limits.weekly_token_quota, weeklyCostQuota, weeklyCostQuota);

  ensureTelegramIdentity(accountId, tgId, tgUsername);
  ensureActiveChat(accountId);
  return result;
})();

export const updateUserStatus = (userId: number, status: UserStatus) => {
  const updateStatus = db.prepare(`
    UPDATE users
    SET status = ?,
        auth_token_version = auth_token_version + CASE WHEN ? = 'approved' THEN 0 ELSE 1 END
    WHERE id = ?
  `);
  return updateStatus.run(status, status, resolveAccountId(userId));
};

export const revokeUserAuthTokens = (userId: number) => db.transaction(() => {
  const accountId = resolveAccountId(userId);
  db.prepare(`
    UPDATE users
    SET auth_token_version = auth_token_version + 1
    WHERE id = ?
  `).run(accountId);
  db.prepare(`
    UPDATE account_redirects
    SET source_auth_token_version = source_auth_token_version + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE target_account_id = ?
  `).run(accountId);
})();

export const updateUserRole = (userId: number, role: string) => db
  .prepare('UPDATE users SET role = ?, is_admin = ? WHERE id = ?')
  .run(role, role === 'admin' ? 1 : 0, resolveAccountId(userId));

export const updateUserName = (userId: number, name: string) => db
  .prepare('UPDATE users SET name = ? WHERE id = ?')
  .run(name, resolveAccountId(userId));

export const updateUserTelegramUsername = (userId: number, tgUsername: string | null) => db.transaction(() => {
  const accountId = resolveAccountId(userId);
  db.prepare(`
    UPDATE account_identities
    SET username = ?, updated_at = CURRENT_TIMESTAMP
    WHERE account_id = ? AND provider = 'telegram'
  `).run(tgUsername, accountId);
})();

export const removeUser = (userId: number) => {
  userId = resolveAccountId(userId);
  db.prepare(`DELETE FROM chat_agents WHERE chat_id IN (SELECT id FROM user_chats WHERE user_id = ?)`).run(userId);
  db.prepare(`DELETE FROM chat_members WHERE chat_id IN (SELECT id FROM user_chats WHERE user_id = ?)`).run(userId);
  db.prepare(`
    UPDATE chat_agents
    SET is_active = 0, deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE owner_user_id = ? AND is_active = 1
  `).run(userId);
  db.prepare('DELETE FROM chat_messages WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM chat_members WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM user_chats WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM chat_folders WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM notes WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM tasks WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM mail_accounts WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM user_plan_subscriptions WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM account_identities WHERE account_id = ?').run(userId);
  db.prepare('DELETE FROM account_namespace_migrations WHERE source_account_id = ? OR target_account_id = ?').run(userId, userId);
  db.prepare('DELETE FROM account_redirects WHERE source_account_id = ? OR target_account_id = ?').run(userId, userId);
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
  userId = resolveAccountId(userId);
  const limits = getPlanLimits(plan);
  const weeklyCostLimit = limits.budget_usd > 0 ? limits.budget_usd / 4 : 0;
  return db.prepare(`
    UPDATE users
    SET plan = ?,
        daily_web_search_limit = ?,
        daily_image_gen_limit = ?,
        max_context_tokens_limit = ?,
        max_context_tokens = ?,
        weekly_tokens_quota = ?,
        weekly_cost_quota_limit = ?,
        weekly_cost_quota = ?
    WHERE id = ?
  `).run(plan, limits.daily_web_search_limit, limits.daily_image_gen_limit,
    limits.max_context_tokens, limits.max_context_tokens,
    limits.weekly_token_quota, weeklyCostLimit, weeklyCostLimit, userId);
};

/**
 * Hard-syncs all plan-derived fields on users with current plan_limits_config.
 *
 * Per-user overrides (max_context_tokens, weekly_cost_quota) are OVERWRITTEN by
 * the plan value — this is intentional. If admin raises OR lowers a plan limit,
 * every user on that plan must reflect it immediately. Per-user tuning happens
 * via dedicated endpoints AFTER sync, not by preserving stale values.
 *
 * Use resetUserWeeklyCost() / resetAllUsersWeeklyCost() to zero usage counters.
 */
export const syncAllUsersPlanLimits = () => {
  for (const [plan, limits] of Object.entries(loadPlanLimitsFromDb())) {
    const weeklyCostLimit = limits.budget_usd > 0 ? limits.budget_usd / 4 : 0;
    db.prepare(`
      UPDATE users
      SET daily_web_search_limit = ?,
          daily_image_gen_limit = ?,
          max_context_tokens_limit = ?,
          max_context_tokens = ?,
          weekly_tokens_quota = ?,
          weekly_cost_quota_limit = ?,
          weekly_cost_quota = ?
      WHERE plan = ?
    `).run(limits.daily_web_search_limit, limits.daily_image_gen_limit,
      limits.max_context_tokens, limits.max_context_tokens,
      limits.weekly_token_quota, weeklyCostLimit, weeklyCostLimit, plan);
  }
};

/** Reset weekly usage counters (tokens + cost) for a single user (admin action). */
export const resetUserWeeklyUsage = (userId: number): void => {
  userId = resolveAccountId(userId);
  db.prepare(`UPDATE users SET weekly_cost_used = 0, weekly_tokens_used = 0 WHERE id = ?`).run(userId);
};

/** Reset weekly usage counters (tokens + cost) for all users (admin action). Returns affected row count. */
export const resetAllUsersWeeklyUsage = (): number => {
  const result = db.prepare(`
    UPDATE users
    SET weekly_cost_used = 0, weekly_tokens_used = 0
    WHERE weekly_cost_used <> 0 OR weekly_tokens_used <> 0
  `).run();
  return result.changes;
};

/** Per-user override of weekly_cost_quota (admin can lower/raise within plan ceiling). */
export const updateUserWeeklyCostQuota = (userId: number, quota: number): void => {
  userId = resolveAccountId(userId);
  const safe = Number.isFinite(quota) && quota >= 0 ? quota : 0;
  db.prepare(`UPDATE users SET weekly_cost_quota = ? WHERE id = ?`).run(safe, userId);
};

// ---------- Telegram link codes ----------

import crypto from 'node:crypto';

export const generateLinkCode = (userId: number): { code: string; expires_in: number } => {
  userId = resolveAccountId(userId);
  // Cleanup expired first
  db.prepare('DELETE FROM telegram_link_codes WHERE expires_at < unixepoch()').run();

  // Invalidate any existing codes for this user
  db.prepare('DELETE FROM telegram_link_codes WHERE user_id = ?').run(userId);

  const code = String(crypto.randomInt(100000, 1_000_000));
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

// ── Password reset codes ──────────────────────────────────────────────────

/** Rate-limit: max 3 password-reset code requests per account per 10 minutes. */
const PASSWORD_RESET_RATE_LIMIT_WINDOW_SEC = 600;
const PASSWORD_RESET_RATE_LIMIT_MAX = 3;
const PASSWORD_RESET_CODE_TTL_SEC = 300; // 5 min
const PASSWORD_RESET_MAX_ATTEMPTS = 3;

const passwordResetRequestCounts = new Map<number, { count: number; windowStart: number }>();

const getPasswordResetRequestState = (accountId: number) => {
  const now = Math.floor(Date.now() / 1000);
  let state = passwordResetRequestCounts.get(accountId);
  if (!state || state.windowStart + PASSWORD_RESET_RATE_LIMIT_WINDOW_SEC < now) {
    state = { count: 0, windowStart: now };
    passwordResetRequestCounts.set(accountId, state);
  }
  // Clean stale entries periodically
  if (passwordResetRequestCounts.size > 1000) {
    for (const [key, st] of passwordResetRequestCounts) {
      if (st.windowStart + PASSWORD_RESET_RATE_LIMIT_WINDOW_SEC * 2 < now) passwordResetRequestCounts.delete(key);
    }
  }
  return state;
};

export const generatePasswordResetCode = (accountId: number): { code: string; expires_in: number } | { error: string; retry_after?: number } => {
  accountId = resolveAccountId(accountId);
  const state = getPasswordResetRequestState(accountId);
  state.count += 1;
  if (state.count > PASSWORD_RESET_RATE_LIMIT_MAX) {
    const retryAfter = state.windowStart + PASSWORD_RESET_RATE_LIMIT_WINDOW_SEC - Math.floor(Date.now() / 1000);
    return { error: 'too_many_requests', retry_after: Math.max(1, retryAfter) };
  }

  // Cleanup expired codes
  db.prepare('DELETE FROM password_reset_codes WHERE expires_at < unixepoch()').run();
  // Invalidate existing pending codes for this account
  db.prepare('DELETE FROM password_reset_codes WHERE account_id = ?').run(accountId);

  const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + PASSWORD_RESET_CODE_TTL_SEC;

  db.prepare('INSERT INTO password_reset_codes (account_id, code, expires_at, attempts) VALUES (?, ?, ?, 0)')
    .run(accountId, code, expiresAt);

  return { code, expires_in: PASSWORD_RESET_CODE_TTL_SEC };
};

export const verifyPasswordResetCode = (accountId: number, code: string): { ok: boolean; error?: string; attempts_left?: number } => {
  accountId = resolveAccountId(accountId);

  // Atomic verify-and-increment to avoid race condition where parallel
  // requests could exceed PASSWORD_RESET_MAX_ATTEMPTS.
  return db.transaction(() => {
    // Cleanup expired
    db.prepare('DELETE FROM password_reset_codes WHERE expires_at < unixepoch()').run();

    const row = db.prepare('SELECT code, expires_at, attempts FROM password_reset_codes WHERE account_id = ?')
      .get(accountId) as { code: string; expires_at: number; attempts: number } | undefined;

    if (!row) return { ok: false, error: 'no_code' };
    if (row.expires_at < Math.floor(Date.now() / 1000)) {
      db.prepare('DELETE FROM password_reset_codes WHERE account_id = ?').run(accountId);
      return { ok: false, error: 'expired' };
    }
    if (row.attempts >= PASSWORD_RESET_MAX_ATTEMPTS) {
      db.prepare('DELETE FROM password_reset_codes WHERE account_id = ?').run(accountId);
      return { ok: false, error: 'too_many_attempts' };
    }
    if (row.code !== code) {
      db.prepare('UPDATE password_reset_codes SET attempts = attempts + 1 WHERE account_id = ?').run(accountId);
      const remaining = PASSWORD_RESET_MAX_ATTEMPTS - row.attempts - 1;
      return { ok: false, error: 'wrong_code', attempts_left: Math.max(0, remaining) };
    }

    // Success — delete the code
    db.prepare('DELETE FROM password_reset_codes WHERE account_id = ?').run(accountId);
    return { ok: true };
  })();
};

/**
 * Generate a signed reset token valid for 5 minutes.
 * Allows the user to call reset-password without re-entering the code.
 */
export const signPasswordResetToken = (accountId: number): string => {
  const JWT_SECRET = process.env.API_JWT_SECRET || '';
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ sub: accountId, typ: 'pwd_reset', exp: now + 300, iat: now });
  const content = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(content).digest('base64url');
  return `${content}.${sig}`;
};

/** Verify and decode a password reset token. Returns account_id or null. */
export const verifyPasswordResetToken = (token: string): number | null => {
  const JWT_SECRET = process.env.API_JWT_SECRET || '';
  const dotIndex = token.lastIndexOf('.');
  if (dotIndex <= 0) return null;
  const content = token.slice(0, dotIndex);
  const sig = token.slice(dotIndex + 1);
  const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(content).digest('base64url');
  if (sig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;

  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(content, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (payload.typ !== 'pwd_reset' || !Number.isFinite(payload.sub) || !Number.isFinite(payload.exp)) return null;
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload.sub;
};

/** Admin action: generate a new random password for the user.
 *  Caller passes the already-computed scrypt salt+hash (so we reuse
 *  makePasswordHash from auth.js as the single source of truth).
 *  Sets `must_change_password=1` so the desktop client forces a password
 *  change on next sign-in. Returns the plaintext password generated by caller.
 */
export const adminApplyGeneratedPassword = (accountId: number, plainPassword: string, passwordSalt: string, passwordHash: string): { new_password: string } => {
  accountId = resolveAccountId(accountId);
  const identities = getAccountIdentities(accountId);
  const passwordIdentity = identities.find(i => i.provider === 'password');
  if (!passwordIdentity) throw new Error('no_password_identity');

  db.prepare('UPDATE account_identities SET password_salt = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(passwordSalt, passwordHash, passwordIdentity.id);

  // Force password change on next desktop sign-in.
  db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(accountId);

  // Revoke all existing tokens so only the new password works.
  revokeUserAuthTokens(accountId);
  return { new_password: plainPassword };
};

// ── FTS5 full-text search ────────────────────────────────────────────────────

export type SearchResult = {
  chat_id: number;
  chat_title: string;
  folder_id: number | null;
  created_at: number;
  snippet: string;
  rank: number;
};

export const searchUserChats = (userId: number, query: string, limit = 20): SearchResult[] => {
  // Sanitize: strip FTS5 special chars, keep word chars + cyrillic
  const safeQuery = query.replace(/[^\w\sа-яА-ЯёЁ]/g, ' ').trim();
  if (safeQuery.length < 3) return [];

  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const userLanguage = (db.prepare('SELECT language FROM users WHERE id = ?').get(userId) as { language: string | null } | undefined)?.language;

  // Use MATCH with prefix search (trailing *) for partial word matches
  const ftsQuery = safeQuery.split(/\s+/).filter(Boolean).map(w => `${w}*`).join(' ');

  // Step 1: get distinct chat_ids sorted by the latest message in each chat.
  // Relevance is still used below to choose the best matching snippet.
  // Desktop UI search returns ALL chats (including bot_hidden) so users
  // can find their own conversations. The bot tool uses searchChatHistory()
  // which applies the bot_hidden filter separately.
  // NOTE: FTS5 MATCH requires the bare table name on the left side;
  // table aliases (e.g. "messages_fts mfts ... mfts MATCH") are NOT supported.
  const chatHits = db.prepare(`
    SELECT
      chat_id,
      MIN(rank) AS best_rank,
      COALESCE((
        SELECT cm.created_at
        FROM chat_messages cm
        WHERE cm.chat_id = messages_fts.chat_id
        ORDER BY cm.created_at DESC, cm.id DESC
        LIMIT 1
      ), '') AS last_message_at
    FROM messages_fts
    WHERE user_id = ? AND messages_fts MATCH ?
    GROUP BY chat_id
    ORDER BY last_message_at DESC, chat_id DESC
    LIMIT ?
  `).all(userId, ftsQuery, safeLimit) as Array<{
    chat_id: number;
    best_rank: number;
    last_message_at: string;
  }>;

  if (chatHits.length === 0) return [];

  // Step 2: for each chat, get snippet from the best matching message
  const snippetStmt = db.prepare(`
    SELECT snippet(messages_fts, 0, '<<', '>>', '...', 10) as snippet
    FROM messages_fts
    WHERE user_id = ? AND chat_id = ? AND messages_fts MATCH ?
    ORDER BY rank
    LIMIT 1
  `);

  const results: SearchResult[] = [];
  for (const hit of chatHits) {
    const chat = db.prepare('SELECT title, folder_id, created_at FROM user_chats WHERE id = ? AND user_id = ?').get(hit.chat_id, userId) as { title: string; folder_id: number | null; created_at: string } | undefined;
    if (!chat) continue;
    const snip = snippetStmt.get(userId, hit.chat_id, ftsQuery) as { snippet: string } | undefined;
    results.push({
      chat_id: hit.chat_id,
      chat_title: chat.title || formatAutomaticChatTitle(userLanguage, hit.chat_id),
      folder_id: chat.folder_id,
      created_at: toUnix(chat.created_at),
      snippet: snip?.snippet || '',
      rank: hit.best_rank,
    });
  }

  return results;
};

export type ChatContextTokens = {
  /** Токены суммы неархивных сообщений (user + assistant, без reasoning). */
  messages_tokens: number;
  /** Токены reasoning_content (для info-цели, в контекст AI не входят). */
  reasoning_tokens: number;
  /** Токены архивных сообщений (для статистики, в контекст не входят). */
  archived_tokens: number;
  /** Количество неархивных сообщений. */
  active_messages: number;
  /** Количество архивных сообщений. */
  archived_messages: number;
  /**
   * Оценка токенов базового системного промпта (без надбавок за голос/аватар/изображения).
   * Динамический — пересчитывается при каждом запросе, т.к. зависит от
   * core_memory, pinned macros, timezone, выбранного промпта.
   */
  system_prompt_tokens: number;
  latest_prompt_tokens: number;
  latest_completion_tokens: number;
  latest_total_tokens: number;
  latest_cache_hit_tokens: number;
  latest_cache_miss_tokens: number;
  latest_reasoning_tokens: number;
  latest_model_name: string | null;
  current_context_tokens: number;
};

/**
 * Суммарные токены контекста чата.
 *
 * messages_tokens = SUM(token_count) WHERE archived = 0 — базовая оценка
 * веса истории сообщений для AI-контекста.
 *
 * system_prompt_tokens = оценка базового системного промпта (без голоса/аватара).
 * Эти токены НЕ плюсуются в messages_tokens — отображаются отдельно,
 * т.к. промпт динамический и его размер меняется между запросами.
 *
 * Полный контекст запроса к AI ≈ messages_tokens + system_prompt_tokens
 * (+ возможные надбавки за голос/аватар/изображения, которые здесь не учтены).
 */
export const getChatContextTokens = (userId: number, chatId: number): ChatContextTokens => {
  // Personal chats are stored under one user_id. Shared room messages are
  // stored under their human sender or bot owner, so the counter must use the
  // same room-wide reader scope as getChatMessages()/getHistoryForAi().
  const readerIds = listRoomReaderUserIds(chatId);
  const scopedUserIds = readerIds?.includes(userId) ? readerIds : [];
  const placeholders = scopedUserIds.map(() => '?').join(', ');
  if (scopedUserIds.length === 0) throw new Error('chat_not_found');

  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN archived = 0 THEN token_count ELSE 0 END), 0) AS messages_tokens,
      COALESCE(SUM(CASE WHEN archived = 0 THEN reasoning_tokens ELSE 0 END), 0) AS reasoning_tokens,
      COALESCE(SUM(CASE WHEN archived = 1 THEN token_count ELSE 0 END), 0) AS archived_tokens,
      COALESCE(SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END), 0) AS active_messages,
      COALESCE(SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END), 0) AS archived_messages
    FROM chat_messages
    WHERE user_id IN (${placeholders}) AND chat_id = ?
  `).get(...scopedUserIds, chatId) as Pick<
    ChatContextTokens,
    'messages_tokens' | 'reasoning_tokens' | 'archived_tokens' | 'active_messages' | 'archived_messages'
  >;

  const latestAssistant = db.prepare(`
    SELECT usage_json, model_name
    FROM chat_messages
    WHERE user_id IN (${placeholders}) AND chat_id = ? AND role = 'assistant' AND usage_json IS NOT NULL
    ORDER BY id DESC
    LIMIT 1
  `).get(...scopedUserIds, chatId) as { usage_json: string | null; model_name: string | null } | undefined;

  let latestUsage: MessageUsage['latest'] | null = null;
  if (latestAssistant?.usage_json) {
    try {
      const parsed = JSON.parse(latestAssistant.usage_json) as MessageUsage;
      if (parsed?.latest) latestUsage = parsed.latest;
    } catch {
      // Ignore old or malformed usage rows.
    }
  }

  // Считаем базовый системный промпт (динамический).
  // Надбавки за голос/аватар/изображения не включены — они появляются только
  // при конкретных типах запросов и не относятся к "базовому" контексту чата.
  let system_prompt_tokens = 0;
  const user = getUserById(userId);
  if (user) {
    const promptUser = user; // Для отображения используется тот же user, что и для запроса
    const promptContent = resolvePromptForUser(promptUser).content;
    const coreMemory = user.core_memory || '';
    const pinnedMacros = getEnabledMacros(userId).filter(m => m.pinned);
    const pinnedMacrosHint = pinnedMacros.length > 0
      ? `\n\n[ЗАКРЕПЛЁННЫЕ МАКРОСЫ]\nУ пользователя есть часто используемые макросы: ${pinnedMacros.map(m => `"${m.title}"`).join(', ')}. Если запрос пользователя явно совпадает с назначением одного из них — вызови list_my_macros чтобы посмотреть подробности, затем execute_macro для запуска.`
      : '';
    const systemPrompt = buildBaseSystemPromptForUser(user, promptContent, coreMemory, pinnedMacrosHint, false);
    system_prompt_tokens = countMessageTokens('system', systemPrompt);
  }

  return {
    ...row,
    system_prompt_tokens,
    latest_prompt_tokens: latestUsage?.prompt_tokens ?? 0,
    latest_completion_tokens: latestUsage?.completion_tokens ?? 0,
    latest_total_tokens: latestUsage?.total_tokens ?? 0,
    latest_cache_hit_tokens: latestUsage?.cache_hit_tokens ?? 0,
    latest_cache_miss_tokens: latestUsage?.cache_miss_tokens ?? 0,
    latest_reasoning_tokens: latestUsage?.reasoning_tokens ?? 0,
    latest_model_name: latestAssistant?.model_name ?? null,
    current_context_tokens: getProviderContextEstimateForUsers(scopedUserIds, chatId)
      ?? (row.messages_tokens + system_prompt_tokens),
  };
};

// ── Bot chat search tool helpers ─────────────────────────────────────────────

export type ChatMessageSearchHit = {
  message_id: number;
  chat_id: number;
  chat_title: string;
  role: ChatRole;
  snippet: string;
  created_at: number;
  rank: number;
};

/**
 * Search across all non-bot-hidden chats at message level.
 * Returns individual matching messages (not just chats) with FTS snippets.
 * Used by the `search_chat_history` AI tool.
 */
export const searchChatHistory = (
  userId: number,
  query: string,
  limit = 20,
): ChatMessageSearchHit[] => {
  const safeQuery = query.normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  if (safeQuery.length < 2) return [];

  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const ftsQuery = safeQuery
    .split(/\s+/)
    .filter(Boolean)
    .map(word => `"${word.replace(/"/g, '""')}"*`)
    .join(' ');

  // Filter bot-hidden chats before LIMIT so hidden hits cannot displace visible ones.
  // FTS5 MATCH requires the bare virtual-table name on the left side.
  const rawHits = db.prepare(`
    SELECT
      messages_fts.chat_id,
      messages_fts.message_id,
      snippet(messages_fts, 0, '<<', '>>', '...', 12) as snippet,
      messages_fts.rank
    FROM messages_fts
    JOIN user_chats
      ON user_chats.id = messages_fts.chat_id
      AND user_chats.user_id = messages_fts.user_id
    WHERE messages_fts.user_id = ?
      AND user_chats.bot_hidden = 0
      AND messages_fts MATCH ?
    ORDER BY messages_fts.rank
    LIMIT ?
  `).all(userId, ftsQuery, safeLimit) as Array<{
    chat_id: number;
    message_id: number;
    snippet: string;
    rank: number;
  }>;

  if (rawHits.length === 0) return [];

  const messageIds = rawHits.map(h => h.message_id);
  const msgMetaRows = db.prepare(`SELECT id, role, created_at FROM chat_messages WHERE id IN (${messageIds.map(() => '?').join(',')})`)
    .all(...messageIds) as Array<{ id: number; role: string; created_at: string }>;
  const msgMeta = new Map(msgMetaRows.map(r => [r.id, r]));

  // Cache chat titles to avoid repeated lookups.
  const titleCache = new Map<number, string>();
  const userLanguage = (db.prepare('SELECT language FROM users WHERE id = ?').get(userId) as { language: string | null } | undefined)?.language;

  return rawHits.map(hit => {
    let title = titleCache.get(hit.chat_id);
    if (title === undefined) {
      const chat = db.prepare('SELECT title FROM user_chats WHERE id = ? AND user_id = ?').get(hit.chat_id, userId) as { title: string } | undefined;
      title = chat?.title || formatAutomaticChatTitle(userLanguage, hit.chat_id);
      titleCache.set(hit.chat_id, title);
    }
    const meta = msgMeta.get(hit.message_id);
    return {
      message_id: hit.message_id,
      chat_id: hit.chat_id,
      chat_title: title,
      role: (meta?.role ?? 'user') as ChatRole,
      snippet: hit.snippet,
      created_at: meta ? toUnix(meta.created_at) : 0,
      rank: hit.rank,
    };
  });
};

export type ChatContextMessage = {
  id: number;
  role: ChatRole;
  content: string;
  created_at: number;
};

export type ChatContextResult = {
  chat_id: number;
  chat_title: string;
  anchor_message_id: number | null;
  messages: ChatContextMessage[];
  has_more_before: boolean;
  has_more_after: boolean;
};

/**
 * Get ±n messages around a given message ID (or the latest messages if no anchor).
 * Used by the `read_chat_context` AI tool to navigate chat history.
 */
export const getChatMessagesAround = (
  userId: number,
  chatId: number,
  fromMessageId: number | null,
  before = 5,
  after = 5,
): ChatContextResult | null => {
  // Validate chat belongs to user and is not bot_hidden.
  const chat = db.prepare('SELECT title, bot_hidden FROM user_chats WHERE id = ? AND user_id = ?').get(chatId, userId) as { title: string; bot_hidden: number } | undefined;
  if (!chat || chat.bot_hidden === 1) return null;

  const safeBefore = Math.max(0, Math.min(50, Math.floor(before)));
  const safeAfter = Math.max(0, Math.min(50, Math.floor(after)));

  let anchorId = fromMessageId;

  // If no anchor provided, use the latest message in the chat.
  if (anchorId === null) {
    const latest = db.prepare(`
      SELECT id FROM chat_messages
      WHERE user_id = ? AND chat_id = ?
      ORDER BY id DESC LIMIT 1
    `).get(userId, chatId) as { id: number } | undefined;
    anchorId = latest?.id ?? null;
  }

  const messages: ChatContextMessage[] = [];

  if (anchorId !== null) {
    // Messages AFTER the anchor (newer, ascending). Fetch LIMIT+1 to detect has_more.
    const afterRows = db.prepare(`
      SELECT id, role, content, created_at
      FROM chat_messages
      WHERE user_id = ? AND chat_id = ? AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(userId, chatId, anchorId, safeAfter + 1) as Array<{ id: number; role: string; content: string; created_at: string }>;

    // The anchor message itself.
    const anchorRow = db.prepare(`
      SELECT id, role, content, created_at
      FROM chat_messages
      WHERE user_id = ? AND chat_id = ? AND id = ?
    `).get(userId, chatId, anchorId) as { id: number; role: string; content: string; created_at: string } | undefined;

    // Messages BEFORE the anchor (older, descending → then reversed). Fetch LIMIT+1 to detect has_more.
    const beforeRows = db.prepare(`
      SELECT id, role, content, created_at
      FROM chat_messages
      WHERE user_id = ? AND chat_id = ? AND id < ?
      ORDER BY id DESC
      LIMIT ?
    `).all(userId, chatId, anchorId, safeBefore + 1) as Array<{ id: number; role: string; content: string; created_at: string }>;

    // Detect if there are more messages beyond what was requested.
    const hasMoreBefore = safeBefore > 0 && beforeRows.length > safeBefore;
    const hasMoreAfter = safeAfter > 0 && afterRows.length > safeAfter;

    // Trim the extra row used for has_more detection.
    const trimmedBefore = beforeRows.slice(0, safeBefore);
    const trimmedAfter = afterRows.slice(0, safeAfter);

    // Assemble: [..before (reversed), anchor, after..]
    const beforeMsgs: ChatContextMessage[] = trimmedBefore.reverse().map(r => ({
      id: r.id,
      role: r.role as ChatRole,
      content: r.content,
      created_at: toUnix(r.created_at),
    }));

    const afterMsgs: ChatContextMessage[] = trimmedAfter.map(r => ({
      id: r.id,
      role: r.role as ChatRole,
      content: r.content,
      created_at: toUnix(r.created_at),
    }));

    if (anchorRow) {
      messages.push(...beforeMsgs, {
        id: anchorRow.id,
        role: anchorRow.role as ChatRole,
        content: anchorRow.content,
        created_at: toUnix(anchorRow.created_at),
      }, ...afterMsgs);
    } else {
      // Anchor not found in this chat — just use what we have.
      messages.push(...beforeMsgs, ...afterMsgs);
    }

    return {
      chat_id: chatId,
      chat_title: chat.title,
      anchor_message_id: anchorId,
      messages,
      has_more_before: hasMoreBefore,
      has_more_after: hasMoreAfter,
    };
  }

  // No messages in chat at all.
  return {
    chat_id: chatId,
    chat_title: chat.title,
    anchor_message_id: null,
    messages: [],
    has_more_before: false,
    has_more_after: false,
  };
};

/**
 * Toggle the bot_hidden flag on a chat.
 * When bot_hidden = 1, the chat is excluded from the bot's search_chat_history tool.
 */
export const setChatBotHidden = (userId: number, chatId: number, hidden: boolean): boolean => {
  const result = db.prepare(`
    UPDATE user_chats SET bot_hidden = ? WHERE id = ? AND user_id = ?
  `).run(hidden ? 1 : 0, chatId, userId);
  return result.changes > 0;
};


