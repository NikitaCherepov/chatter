import { db, toUnix } from '../db.js';
import type { ChatDto, MessageDto, MessageImage, MessageAudio, ChatRole, UserRecord } from '../types.js';
import type { ToolIteration } from './ai.js';
import { countTokens, countMessageTokens, countToolCallTokens, countToolResultTokens } from './tokenizer.js';
import { buildBaseSystemPromptForUser } from './system-prompt.js';
import { resolvePromptForUser } from './prompts.js';
import { getEnabledMacros } from './macros.js';

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

export const listUserChats = (userId: number, limit = 50, offset = 0): ChatDto[] => {
  const activeId = ensureActiveChat(userId);
  const parsedLimit = Number.isFinite(limit) ? Math.floor(limit) : 50;
  const parsedOffset = Number.isFinite(offset) ? Math.floor(offset) : 0;
  const safeLimit = Math.max(1, Math.min(100, parsedLimit));
  const safeOffset = Math.max(0, parsedOffset);
  const rows = db.prepare(`
    SELECT id, title, created_at, updated_at
    FROM user_chats
    WHERE user_id = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(userId, safeLimit, safeOffset) as Array<{ id: number; title: string; created_at: string; updated_at: string }>;

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

export const renameUserChat = (userId: number, chatId: number, title: string): boolean => {
  const exists = db.prepare('SELECT id FROM user_chats WHERE user_id = ? AND id = ?').get(userId, chatId) as { id: number } | undefined;
  if (!exists) return false;
  db.prepare('UPDATE user_chats SET title = ? WHERE id = ? AND user_id = ?').run(title.slice(0, 120), chatId, userId);
  return true;
};

export const deleteUserChat = (userId: number, chatId: number): boolean => {
  const exists = db.prepare('SELECT id FROM user_chats WHERE user_id = ? AND id = ?').get(userId, chatId) as { id: number } | undefined;
  if (!exists) return false;
  db.prepare('DELETE FROM chat_messages WHERE user_id = ? AND chat_id = ?').run(userId, chatId);
  db.prepare('DELETE FROM user_chats WHERE id = ? AND user_id = ?').run(chatId, userId);
  // If deleted chat was active, reset to another chat
  const user = db.prepare('SELECT active_chat_id FROM users WHERE id = ?').get(userId) as { active_chat_id: number | null } | undefined;
  if (user?.active_chat_id === chatId) {
    const firstChat = db.prepare('SELECT id FROM user_chats WHERE user_id = ? ORDER BY id ASC LIMIT 1').get(userId) as { id: number } | undefined;
    db.prepare('UPDATE users SET active_chat_id = ? WHERE id = ?').run(firstChat?.id ?? null, userId);
  }
  return true;
};

export const deleteUserMessage = (userId: number, chatId: number, messageId: number): boolean => {
  const result = db.prepare(
    'DELETE FROM chat_messages WHERE id = ? AND user_id = ? AND chat_id = ?'
  ).run(messageId, userId, chatId);
  return result.changes > 0;
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

export const getChatMessages = (userId: number, chatId: number, limit = 20, offset = 0): MessageDto[] => {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  const rows = db.prepare(`
    SELECT id, chat_id, role, content, reasoning_content, tool_calls_json, images, audio, telegram_chat_id, telegram_message_id, created_at, archived, token_count, reasoning_tokens
    FROM chat_messages
    WHERE user_id = ? AND chat_id = ?
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(userId, chatId, safeLimit, safeOffset) as Array<{ id: number; chat_id: number; role: ChatRole; content: string; reasoning_content: string | null; tool_calls_json: string | null; images: string | null; audio: string | null; telegram_chat_id: number | null; telegram_message_id: number | null; created_at: string; archived: number; token_count: number; reasoning_tokens: number }>;

  return rows.reverse().map(row => {
    let parsedImages: MessageImage[] | null = null;
    if (row.images) {
      try { parsedImages = JSON.parse(row.images); } catch { parsedImages = null; }
    }
    let parsedAudio: MessageAudio | null = null;
    if (row.audio) {
      try { parsedAudio = JSON.parse(row.audio); } catch { parsedAudio = null; }
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
      role: row.role,
      content: row.content,
      reasoning_content: row.reasoning_content,
      tool_calls: parsedToolCalls,
      images: parsedImages,
      audio: parsedAudio,
      telegram_chat_id: row.telegram_chat_id,
      telegram_message_id: row.telegram_message_id,
      created_at: toUnix(row.created_at),
      archived: row.archived === 1,
      token_count: row.token_count ?? 0,
      reasoning_tokens: row.reasoning_tokens ?? 0
    };
  });
};

export const appendChatMessage = (
  userId: number,
  chatId: number,
  role: ChatRole,
  content: string,
  telegramChatId: number | null = null,
  telegramMessageId: number | null = null,
  images: MessageImage[] | null = null,
  reasoningContent: string | null = null,
  toolCallsJson: string | null = null
) => {
  const imagesJson = images && images.length > 0 ? JSON.stringify(images) : null;
  const reasoning = role === 'assistant' && reasoningContent?.trim() ? reasoningContent.trim() : null;
  const tcJson = role === 'assistant' && toolCallsJson?.trim() ? toolCallsJson.trim() : null;

  // ── Token accounting ────────────────────────────────────────────────────
  // token_count = вес сообщения в AI-контексте (не включает reasoning).
  // reasoning_tokens = отдельный счётчик для reasoning_content (для UI-бейджа).
  let tokenCount = 0;
  let reasoningTokens = 0;

  if (role === 'user') {
    // Для user-сообщений считаем просто текст (images не уходят в контекст,
    // только text-based [Фото]caption из getHistoryForAi).
    tokenCount = countMessageTokens('user', content);
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
  }

  const inserted = db.prepare(`
    INSERT INTO chat_messages (user_id, role, content, chat_id, telegram_chat_id, telegram_message_id, images, reasoning_content, tool_calls_json, token_count, reasoning_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, role, content, chatId, telegramChatId, telegramMessageId, imagesJson, reasoning, tcJson, tokenCount, reasoningTokens);
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

export const updateChatMessageAudio = (
  userId: number,
  messageId: number,
  audio: MessageAudio
) => db.prepare(`
  UPDATE chat_messages
  SET audio = ?
  WHERE id = ? AND user_id = ?
`).run(JSON.stringify(audio), messageId, userId);

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
};

export const getChatMedia = (userId: number, chatId: number, limit = 100, offset = 0): ChatMediaItem[] => {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  const rows = db.prepare(`
    SELECT id, images, created_at
    FROM chat_messages
    WHERE user_id = ? AND chat_id = ? AND images IS NOT NULL AND images != ''
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(userId, chatId, safeLimit, safeOffset) as Array<{ id: number; images: string; created_at: string }>;

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
  return items;
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
      messages.push({ role: 'assistant', content: iter.content });
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
export const getHistoryForAi = (userId: number, chatId: number, limit?: number): any[] => {
  // LIMIT больше не используется для ограничения контекста —
  // Epoch Trimming (trimUserHistoryByChat) контролирует размер через архивацию по токенам.
  // Параметр limit оставлен для обратной совместимости, но игнорируется.
  const rows = db.prepare(`
    SELECT role, content, tool_calls_json
    FROM chat_messages
    WHERE user_id = ? AND chat_id = ? AND archived = 0
    ORDER BY id DESC
  `).all(userId, chatId).reverse() as Array<{ role: ChatRole; content: string; tool_calls_json: string | null }>;

  const messages: any[] = [];

  for (const row of rows) {
    if (row.role === 'user') {
      messages.push({ role: row.role, content: row.content });
      continue;
    }
    // role === 'assistant'
    messages.push(...expandAssistantMessage(row.content, row.tool_calls_json));
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

  // 2. Считаем системный промпт (динамический).
  let systemPromptTokens = 0;
  const user = getUserById(userId);
  if (user) {
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
  const totalMessageTokens = rows.reduce((sum, r) => sum + (r.token_count || 0), 0);
  const totalContextTokens = totalMessageTokens + systemPromptTokens;

  // 4. Если контекст в пределах лимита — ничего не делаем.
  if (totalContextTokens <= tokenLimit) {
    return { archived_count: 0, tokens_before: totalContextTokens, tokens_after: totalContextTokens };
  }

  // 5. Схлопываем до 50% лимита.
  const targetTokens = Math.floor(tokenLimit * 0.5);
  // Сколько токенов нужно срезать (минимум, чтобы оказаться в районе target).
  const tokensToArchive = totalMessageTokens - Math.max(0, targetTokens - systemPromptTokens);

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

  return { archived_count: idsToArchive.length, tokens_before: totalContextTokens, tokens_after: Math.max(0, tokensAfter) };
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
  const maxWindow = Number.isFinite(user.context_window_max) && user.context_window_max > 0 ? Math.floor(user.context_window_max) : 9999;
  const current = Number.isFinite(user.context_window) && user.context_window > 0 ? Math.floor(user.context_window) : maxWindow;
  return Math.max(1, Math.min(current, maxWindow));
};

/**
 * Резолвит эффективный лимит контекста в токенах для пользователя.
 * Берёт min(max_context_tokens, max_context_tokens_limit).
 * Fallback на константу из PLAN_LIMITS для плана пользователя.
 */
export const resolveMaxContextTokens = (user: UserRecord): number => {
  const planLimit = PLAN_LIMITS[user.plan]?.max_context_tokens ?? PLAN_LIMITS['free'].max_context_tokens;
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

const PLAN_LIMITS: Record<string, { context_window_max: number; daily_message_limit: number; daily_web_search_limit: number; daily_image_gen_limit: number; max_images_per_request: number; max_context_tokens: number }> = {
  free:     { context_window_max: 9999, daily_message_limit: 0, daily_web_search_limit: 0,  daily_image_gen_limit: 0, max_images_per_request: 0,  max_context_tokens: 30_000 },
  standart: { context_window_max: 9999, daily_message_limit: 0, daily_web_search_limit: 5,  daily_image_gen_limit: 2, max_images_per_request: 5,  max_context_tokens: 60_000 },
  pro:      { context_window_max: 9999, daily_message_limit: 0, daily_web_search_limit: 20, daily_image_gen_limit: 5, max_images_per_request: 10, max_context_tokens: 1_000_000 }
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
      context_window_max, daily_message_limit, daily_web_search_limit, daily_image_gen_limit,
      max_context_tokens_limit, max_context_tokens)
    VALUES (?, ?, ?, ?, ?, 'free', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      role = excluded.role,
      is_admin = CASE WHEN users.is_admin = 1 THEN 1 ELSE excluded.is_admin END,
      status = excluded.status,
      tg_username = COALESCE(excluded.tg_username, users.tg_username),
      selected_prompt_id = COALESCE(users.selected_prompt_id, excluded.selected_prompt_id)
  `).run(tgId, name, effectiveRole, effectiveIsAdmin, status, tgUsername, defaultPromptId,
    limits.context_window_max, limits.daily_message_limit, limits.daily_web_search_limit, limits.daily_image_gen_limit,
    limits.max_context_tokens, limits.max_context_tokens);

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
      context_window_max, daily_message_limit, daily_web_search_limit, daily_image_gen_limit,
      max_context_tokens_limit, max_context_tokens)
    VALUES (?, ?, 'user', 0, 'none', 'free', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      tg_username = COALESCE(excluded.tg_username, users.tg_username),
      name = COALESCE(excluded.name, users.name),
      selected_prompt_id = COALESCE(users.selected_prompt_id, excluded.selected_prompt_id)
  `).run(tgId, name, tgUsername, defaultPromptId,
    limits.context_window_max, limits.daily_message_limit, limits.daily_web_search_limit, limits.daily_image_gen_limit,
    limits.max_context_tokens, limits.max_context_tokens);

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
        max_context_tokens_limit = ?,
        max_context_tokens = CASE
          WHEN COALESCE(max_context_tokens, 0) <= 0 THEN ?
          WHEN max_context_tokens > ? THEN ?
          ELSE max_context_tokens
        END
    WHERE id = ?
  `).run(plan, limits.context_window_max, limits.daily_message_limit, limits.daily_web_search_limit, limits.daily_image_gen_limit,
    limits.max_context_tokens, limits.max_context_tokens, limits.max_context_tokens, limits.max_context_tokens, userId);
};

export const syncAllUsersPlanLimits = () => {
  for (const [plan, limits] of Object.entries(PLAN_LIMITS)) {
    db.prepare(`
      UPDATE users
      SET context_window_max = ?,
          daily_message_limit = ?,
          daily_web_search_limit = ?,
          daily_image_gen_limit = ?,
          max_context_tokens_limit = ?,
          max_context_tokens = CASE
            WHEN COALESCE(max_context_tokens, 0) <= 0 THEN ?
            WHEN max_context_tokens > ? THEN ?
            ELSE max_context_tokens
          END
      WHERE plan = ?
    `).run(limits.context_window_max, limits.daily_message_limit, limits.daily_web_search_limit, limits.daily_image_gen_limit,
      limits.max_context_tokens, limits.max_context_tokens, limits.max_context_tokens, limits.max_context_tokens, plan);
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

// ── FTS5 full-text search ────────────────────────────────────────────────────

export type SearchResult = {
  chat_id: number;
  chat_title: string;
  created_at: number;
  snippet: string;
  rank: number;
};

export const searchUserChats = (userId: number, query: string, limit = 20): SearchResult[] => {
  // Sanitize: strip FTS5 special chars, keep word chars + cyrillic
  const safeQuery = query.replace(/[^\w\sа-яА-ЯёЁ]/g, ' ').trim();
  if (safeQuery.length < 3) return [];

  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));

  // Use MATCH with prefix search (trailing *) for partial word matches
  const ftsQuery = safeQuery.split(/\s+/).filter(Boolean).map(w => `${w}*`).join(' ');

  // Step 1: get distinct chat_ids sorted by rank
  const chatHits = db.prepare(`
    SELECT chat_id, MIN(rank) as best_rank
    FROM messages_fts
    WHERE user_id = ? AND messages_fts MATCH ?
    GROUP BY chat_id
    ORDER BY best_rank
    LIMIT ?
  `).all(userId, ftsQuery, safeLimit) as Array<{ chat_id: number; best_rank: number }>;

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
    const chat = db.prepare('SELECT title, created_at FROM user_chats WHERE id = ? AND user_id = ?').get(hit.chat_id, userId) as { title: string; created_at: string } | undefined;
    if (!chat) continue;
    const snip = snippetStmt.get(userId, hit.chat_id, ftsQuery) as { snippet: string } | undefined;
    results.push({
      chat_id: hit.chat_id,
      chat_title: chat.title || 'Чат',
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
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN archived = 0 THEN token_count ELSE 0 END), 0) AS messages_tokens,
      COALESCE(SUM(CASE WHEN archived = 0 THEN reasoning_tokens ELSE 0 END), 0) AS reasoning_tokens,
      COALESCE(SUM(CASE WHEN archived = 1 THEN token_count ELSE 0 END), 0) AS archived_tokens,
      COALESCE(SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END), 0) AS active_messages,
      COALESCE(SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END), 0) AS archived_messages
    FROM chat_messages
    WHERE user_id = ? AND chat_id = ?
  `).get(userId, chatId) as Omit<ChatContextTokens, 'system_prompt_tokens'>;

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

  return { ...row, system_prompt_tokens };
};

/**
 * Backfill token_count / reasoning_tokens для существующих сообщений.
 * Запускается один раз при старте сервера (если есть строки без подсчёта).
 * Работает порциями по BATCH, чтобы не блокировать event loop надолго.
 *
 * Возвращает количество обработанных строк.
 */
export const backfillMessageTokens = (batchSize = 500): number => {
  // Берём строки, где token_count = 0 (default), начиная со старых.
  // token_count=0 у нормальных сообщений практически невозможен (минимум 4 токена на обёртку).
  const rows = db.prepare(`
    SELECT id, role, content, reasoning_content, tool_calls_json
    FROM chat_messages
    WHERE token_count = 0
    ORDER BY id ASC
    LIMIT ?
  `).all(batchSize) as Array<{ id: number; role: ChatRole; content: string; reasoning_content: string | null; tool_calls_json: string | null }>;

  if (rows.length === 0) return 0;

  const updateStmt = db.prepare(`
    UPDATE chat_messages SET token_count = ?, reasoning_tokens = ? WHERE id = ?
  `);
  const tx = db.transaction(() => {
    for (const row of rows) {
      let tokenCount = 0;
      let reasoningTokens = 0;

      if (row.role === 'user') {
        tokenCount = countMessageTokens('user', row.content);
      } else {
        const expanded = expandAssistantMessage(row.content, row.tool_calls_json);
        for (const msg of expanded) {
          if (msg.role === 'assistant') {
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
        if (row.reasoning_content) {
          reasoningTokens = countTokens(row.reasoning_content);
        }
      }
      updateStmt.run(tokenCount, reasoningTokens, row.id);
    }
  });
  tx();
  return rows.length;
};
