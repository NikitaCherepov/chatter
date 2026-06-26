import OpenAI from 'openai';
import type { TaskRecurrenceType } from '../types.js';
import { getUserById, ensureActiveChat, createChat, appendChatMessage } from './chats.js';
import { runSmartHomeControl, type SmartHomeArgs } from './smart-home.js';
import { getDueTasks, updateTaskNextExecution, updateTaskStatus } from './tasks.js';
import { sendMessageThroughAi } from './ai.js';
import { db } from '../db.js';
import { fetchAndSaveCurrencyRates } from './currency.js';
import { sendToDesktop, isDesktopOnline } from '../ws-clients.js';

const PRO_MODEL_CHAIN = (process.env.TIMEWEB_MODEL || 'gemini/gemini-3.1-flash-lite-preview')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);
const PRO_CLIENT = new OpenAI({
  apiKey: process.env.TIMEWEB_API_KEY,
  baseURL: process.env.TIMEWEB_BASE_URL
});
const TELEGRAM_TOKEN = `${process.env.TELEGRAM_TOKEN || ''}`.trim();
const SCHEDULER_INTERVAL_MS = Math.max(5_000, Number.parseInt(process.env.BACKEND_SCHEDULER_INTERVAL_MS || '30000', 10) || 30_000);

const toRubFromTokens = (tokens: number) => Math.max(0, tokens) * (102 / 500_000);

const createCompletionWithFallback = async (requestBody: Record<string, unknown>) => {
  let lastErr: unknown = null;
  for (const model of PRO_MODEL_CHAIN) {
    try {
      const response = await PRO_CLIENT.chat.completions.create({ ...(requestBody as any), model } as any);
      return response;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('pro_model_chain_failed');
};

const incrementUserTokenUsage = (userId: number, tokensUsed: number) => {
  const safeTokens = Math.max(0, Math.floor(tokensUsed || 0));
  if (safeTokens <= 0) return;
  const costRub = toRubFromTokens(safeTokens);
  db.prepare(`
    UPDATE users
    SET daily_tokens_used = COALESCE(daily_tokens_used, 0) + ?,
        total_tokens_used = COALESCE(total_tokens_used, 0) + ?,
        daily_cost_rub = COALESCE(daily_cost_rub, 0) + ?,
        total_cost_rub = COALESCE(total_cost_rub, 0) + ?
    WHERE id = ?
  `).run(safeTokens, safeTokens, costRub, costRub, userId);
};

// ── Delivery: unified push for task results ─────────────────────────────────

const sendToTelegram = async (chatId: number, text: string) => {
  if (!TELEGRAM_TOKEN) return;
  const payload = { chat_id: chatId, text, parse_mode: 'Markdown' };
  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text })
      });
    }
  } catch {
    // ignore
  }
};

/**
 * Unified delivery: push task result to desktop (if online) AND Telegram (always).
 */
const deliverTaskResult = (
  userId: number,
  text: string,
  chatId: number,
  isNewChat: boolean,
) => {
  // Push to desktop via WS (if connected)
  if (isDesktopOnline(userId)) {
    sendToDesktop(userId, {
      type: 'task_result',
      chat_id: chatId,
      text,
      is_new_chat: isNewChat,
    });
  }

  // Always push to Telegram
  sendToTelegram(userId, text);
};

const getIsoWeekday = (date: Date) => {
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
};

const computeNextRecurringExecuteAt = (
  task: {
    execute_at: number;
    recurrence_type: TaskRecurrenceType;
    recurrence_weekday: number | null;
    timezone_offset: number | null;
    user_id: number;
  }
) => {
  if (task.recurrence_type === 'once') return null;
  const user = getUserById(task.user_id);
  const fallbackOffset = Number.isFinite(Number(user?.timezone_offset)) ? Number(user?.timezone_offset) : 5;
  const timezoneOffset = typeof task.timezone_offset === 'number' ? task.timezone_offset : fallbackOffset;
  const localDate = new Date((task.execute_at + timezoneOffset * 3600) * 1000);
  const nowUnix = Math.floor(Date.now() / 1000);

  if (task.recurrence_type === 'daily') {
    do {
      localDate.setUTCDate(localDate.getUTCDate() + 1);
    } while (Math.floor(localDate.getTime() / 1000 - timezoneOffset * 3600) <= nowUnix);
    return Math.floor(localDate.getTime() / 1000 - timezoneOffset * 3600);
  }

  if (task.recurrence_type === 'weekly') {
    const targetWeekday = task.recurrence_weekday;
    if (!targetWeekday || targetWeekday < 1 || targetWeekday > 7) return null;
    const currentWeekday = getIsoWeekday(localDate);
    let deltaDays = (targetWeekday - currentWeekday + 7) % 7;
    if (deltaDays === 0) deltaDays = 7;
    localDate.setUTCDate(localDate.getUTCDate() + deltaDays);
    while (Math.floor(localDate.getTime() / 1000 - timezoneOffset * 3600) <= nowUnix) {
      localDate.setUTCDate(localDate.getUTCDate() + 7);
    }
    return Math.floor(localDate.getTime() / 1000 - timezoneOffset * 3600);
  }

  return null;
};

const runScheduledAiInstructionTask = async (task: { user_id: number; payload: string }): Promise<{ reply_text: string; chat_id: number; is_new_chat: boolean }> => {
  const rawPayload = task.payload.trim();
  if (!rawPayload) return { reply_text: 'Не получилось выполнить AI-инструкцию: пустой payload задачи.', chat_id: 0, is_new_chat: false };

  // Parse payload: may contain _target_chat_id / _create_new_chat metadata
  let instruction = rawPayload;
  let targetChatId: number | null = null;
  let createNewChat = false;

  try {
    const parsed = JSON.parse(rawPayload);
    if (parsed && typeof parsed === 'object') {
      instruction = typeof parsed.instruction === 'string' ? parsed.instruction : (typeof parsed._instruction === 'string' ? parsed._instruction : rawPayload);
      targetChatId = Number.isFinite(Number(parsed._target_chat_id)) ? Math.floor(Number(parsed._target_chat_id)) : null;
      createNewChat = parsed._create_new_chat === true;
    }
  } catch {
    // payload is plain text — use as-is
  }

  instruction = instruction.trim();
  if (!instruction) return { reply_text: 'Не получилось выполнить AI-инструкцию: пустая инструкция.', chat_id: 0, is_new_chat: false };

  // Determine chat: create new, use specified, or fallback to active
  let chatId: number | undefined;
  let isNewChat = false;

  if (createNewChat) {
    const chatTitle = instruction.slice(0, 60);
    const result = createChat(task.user_id, chatTitle);
    chatId = Number(result.lastInsertRowid);
    isNewChat = true;
  } else if (targetChatId) {
    // Verify chat belongs to user
    const chat = db.prepare('SELECT id FROM user_chats WHERE user_id = ? AND id = ?').get(task.user_id, targetChatId) as { id: number } | undefined;
    if (chat) {
      chatId = chat.id;
    }
  }

  if (!chatId) {
    chatId = ensureActiveChat(task.user_id);
  }

  const result = await sendMessageThroughAi(task.user_id, `!!! ${instruction}`, chatId, {
    forcePro: true,
    ignoreDailyLimit: true,
    countAsUserMessage: false,
    persistUserText: `[AI-инструкция по расписанию] ${instruction}`,
    autoRejectHitl: true,
  });

  return {
    reply_text: (result.reply_text || '').trim(),
    chat_id: result.chat_id || chatId,
    is_new_chat: isNewChat,
  };
};

const shouldNotifyByAiCondition = async (
  task: { user_id: number; task_type: string; notify_condition: string | null; payload: string },
  resultText: string
) => {
  const condition = (task.notify_condition || (task.task_type === 'ai_instruction' ? task.payload : '')).trim();
  if (!condition) return false;
  try {
    const completion = await createCompletionWithFallback({
      messages: [
        { role: 'system', content: 'Ты модуль принятия решения по уведомлению. Ответь строго одним словом: YES или NO.' },
        { role: 'user', content: `Условие уведомления:\n${condition}\n\nРезультат выполнения задачи:\n${resultText.slice(0, 6000)}\n\nНужно ли отправить уведомление пользователю? Ответь только YES или NO.` }
      ],
      thinking: { type: 'disabled' }
    });
    const tokens = Number(completion?.usage?.total_tokens || 0);
    incrementUserTokenUsage(task.user_id, tokens);
    const raw = `${completion?.choices?.[0]?.message?.content || ''}`.trim().toUpperCase();
    return raw.startsWith('YES') || raw.startsWith('ДА');
  } catch {
    return false;
  }
};

const shouldNotifyTaskResult = async (
  task: { notify_mode: string; notify_condition: string | null; payload: string; task_type: string; user_id: number },
  resultText: string
) => {
  if (task.notify_mode === 'never') return false;
  if (task.notify_mode === 'always') return true;
  const condition = (task.notify_condition || '').trim().toLowerCase();
  if (task.notify_mode === 'on_match') {
    if (!condition) return false;
    return resultText.toLowerCase().includes(condition);
  }
  if (task.notify_mode === 'on_condition') {
    return shouldNotifyByAiCondition(task, resultText);
  }
  return false;
};

const tick = async () => {
  const nowUnix = Math.floor(Date.now() / 1000);
  const pendingTasks = getDueTasks(nowUnix);

  for (const task of pendingTasks) {
    try {
      let successMessage = '';
      let chatId = 0;
      let isNewChat = false;

      if (task.task_type === 'message') {
        successMessage = `🔔 *Напоминание:*\n\n${task.payload}`;
        chatId = ensureActiveChat(task.user_id);
        appendChatMessage(task.user_id, chatId, 'assistant', successMessage);
      } else if (task.task_type === 'smart_home') {
        const smartHomeArgs = JSON.parse(task.payload) as SmartHomeArgs;
        const result = await runSmartHomeControl(task.user_id, smartHomeArgs);
        successMessage = `🤖 *Автоматизация сработала:*\n${result}`;
        chatId = ensureActiveChat(task.user_id);
        appendChatMessage(task.user_id, chatId, 'assistant', successMessage);
      } else if (task.task_type === 'ai_instruction') {
        const result = await runScheduledAiInstructionTask(task);
        successMessage = result.reply_text ? `🤖 *Запланированная AI-инструкция выполнена:*\n\n${result.reply_text}` : '';
        chatId = result.chat_id;
        isNewChat = result.is_new_chat;
      }

      if (successMessage && await shouldNotifyTaskResult(task, successMessage)) {
        deliverTaskResult(task.user_id, successMessage, chatId, isNewChat);
      }

      if (task.recurrence_type === 'once') {
        updateTaskStatus(task.id, 'done');
      } else {
        const nextExecuteAt = computeNextRecurringExecuteAt(task);
        if (!nextExecuteAt) throw new Error(`Не удалось вычислить следующий запуск для recurring-задачи #${task.id}`);
        updateTaskNextExecution(task.id, nextExecuteAt);
      }
    } catch (err) {
      console.error(`[backend-scheduler] task #${task.id} failed:`, err);
      updateTaskStatus(task.id, 'error');
    }
  }
};

let timer: NodeJS.Timeout | null = null;
let running = false;

// ── Daily reset + plan expiry ──────────────────────────────────────────────

const PLAN_CONTEXT_LIMITS: Record<string, number> = { free: 10, standart: 20, pro: 50 };
const PLAN_DAILY_MESSAGE_LIMITS: Record<string, number> = { free: 10, standart: 20, pro: 50 };
const PLAN_DAILY_WEB_SEARCH_LIMITS: Record<string, number> = { free: 0, standart: 5, pro: 20 };

const resetDailyMessageCounters = () => db.prepare(`
  UPDATE users
  SET daily_message_count = 0,
      daily_tokens_used = 0,
      daily_cost_rub = 0,
      daily_web_search_count = 0,
      daily_image_gen_count = 0
`).run();

const expireFinishedPlanSubscriptions = () => {
  const expiredRows = db.prepare(`
    SELECT id, user_id, plan, started_at, ends_at
    FROM user_plan_subscriptions
    WHERE is_current = 1 AND ends_at IS NOT NULL AND datetime(ends_at) <= CURRENT_TIMESTAMP
    ORDER BY user_id ASC, id ASC
  `).all() as Array<{ id: number; user_id: number; plan: string; started_at: string; ends_at: string | null }>;

  const processedUsers = new Set<number>();
  for (const row of expiredRows) {
    if (processedUsers.has(row.user_id)) continue;
    processedUsers.add(row.user_id);

    const plan = 'free';
    const limits = {
      context_window_max: PLAN_CONTEXT_LIMITS[plan],
      daily_message_limit: PLAN_DAILY_MESSAGE_LIMITS[plan],
      daily_web_search_limit: PLAN_DAILY_WEB_SEARCH_LIMITS[plan]
    };

    db.prepare(`
      UPDATE user_plan_subscriptions SET is_current = 0 WHERE user_id = ? AND is_current = 1
    `).run(row.user_id);

    db.prepare(`
      INSERT INTO user_plan_subscriptions (user_id, plan, started_at, ends_at, is_current, assigned_by)
      VALUES (?, ?, CURRENT_TIMESTAMP, NULL, 1, NULL)
    `).run(row.user_id, plan);

    db.prepare(`
      UPDATE users
      SET plan = ?,
          context_window_max = ?,
          daily_message_limit = ?,
          daily_web_search_limit = ?,
          context_window = CASE
            WHEN COALESCE(context_window, 0) <= 0 THEN ?
            WHEN context_window > ? THEN ?
            ELSE context_window
          END
      WHERE id = ?
    `).run(plan, limits.context_window_max, limits.daily_message_limit, limits.daily_web_search_limit,
           limits.context_window_max, limits.context_window_max, limits.context_window_max, row.user_id);
  }

  if (processedUsers.size > 0) {
    console.log(`[backend-scheduler] expired ${processedUsers.size} plan subscription(s), reverted to free.`);
  }
};

let dailyResetTimer: NodeJS.Timeout | null = null;

const scheduleDailyCounterReset = () => {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  const delay = Math.max(1000, next.getTime() - now.getTime());

  dailyResetTimer = setTimeout(() => {
    try {
      resetDailyMessageCounters();
      console.log('[backend-scheduler] daily counters reset.');
    } catch (err) {
      console.error('[backend-scheduler] daily reset error:', err);
    } finally {
      scheduleDailyCounterReset();
    }
  }, delay);
};

export const startTaskScheduler = () => {
  const enabled = `${process.env.BACKEND_SCHEDULER_ENABLED || '0'}`.trim() === '1';
  if (!enabled) {
    console.log('[backend-scheduler] disabled (BACKEND_SCHEDULER_ENABLED != 1)');
    return;
  }
  if (timer) return;
  console.log(`[backend-scheduler] enabled, interval=${SCHEDULER_INTERVAL_MS}ms`);

  // Start task tick
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (err) {
      console.error('[backend-scheduler] tick error:', err);
    } finally {
      running = false;
    }
  }, SCHEDULER_INTERVAL_MS);

  // Start daily counter reset + plan expiry check
  scheduleDailyCounterReset();
  try { expireFinishedPlanSubscriptions(); } catch (err) {
    console.error('[backend-scheduler] plan expiry check error:', err);
  }
  // Run plan expiry check every 30 minutes
  setInterval(() => {
    try { expireFinishedPlanSubscriptions(); } catch (err) {
      console.error('[backend-scheduler] plan expiry check error:', err);
    }
  }, 30 * 60 * 1000);

  // ── Currency rates (CBR) ── Fetch on startup, then daily at ~14:00 MSK (11:00 UTC)
  const scheduleCurrencyFetch = () => {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(11, 0, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    const delay = Math.max(60_000, next.getTime() - now.getTime());

    setTimeout(async () => {
      try {
        await fetchAndSaveCurrencyRates();
      } catch (err) {
        console.error('[backend-scheduler] currency fetch error:', err);
      }
      scheduleCurrencyFetch();
    }, delay);
  };

  // Initial fetch on startup (don't wait until 14:00)
  fetchAndSaveCurrencyRates().catch(err => {
    console.error('[backend-scheduler] initial currency fetch error:', err);
  });
  scheduleCurrencyFetch();
};
