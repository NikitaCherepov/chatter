import OpenAI from 'openai';
import { tavily } from '@tavily/core';
import type { TaskRecurrenceType } from '../types.js';
import { getPromptForUser, getUserById } from './chats.js';
import { runEmailCheck } from './mail.js';
import { runSmartHomeControl, type SmartHomeArgs } from './smart-home.js';
import { getDueTasks, updateTaskNextExecution, updateTaskStatus } from './tasks.js';
import { sendMessageThroughAi } from './ai.js';
import { db } from '../db.js';

const PRO_MODEL_CHAIN = (process.env.TIMEWEB_MODEL || 'gemini/gemini-3.1-flash-lite-preview')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);
const PRO_CLIENT = new OpenAI({
  apiKey: process.env.TIMEWEB_API_KEY,
  baseURL: process.env.TIMEWEB_BASE_URL
});
const tvly = process.env.TAVILY_API_KEY ? tavily({ apiKey: process.env.TAVILY_API_KEY }) : null;
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

const safeSendToUser = async (chatId: number, text: string) => {
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

const runScheduledWebSearchTask = async (task: { user_id: number; payload: string }) => {
  const query = task.payload.trim();
  if (!query) return 'Не получилось выполнить поиск: пустой запрос в задаче.';
  if (!tvly) return `Запрос: ${query}\n\nОшибка: web search отключен (нет TAVILY_API_KEY).`;

  const webResult = await tvly.search(query, { searchDepth: 'basic', maxResults: 5, includeAnswer: true });
  const sources = (webResult.results || []).map((r: any, i: number) => `${i + 1}. ${r.title}\n${r.content}\nИсточник: ${r.url}`).join('\n\n');
  const raw = `${webResult.answer ? `Сводка: ${webResult.answer}\n\n` : ''}${sources || 'Ничего не найдено.'}`;

  const userRecord = getUserById(task.user_id);
  if (!userRecord) return `Запрос: ${query}\n\n${raw}`;
  const prompt = getPromptForUser(userRecord);
  const userName = userRecord.name || userRecord.tg_username || 'Пользователь';

  try {
    const response = await createCompletionWithFallback({
      messages: [
        { role: 'system', content: `${prompt}\n\nИмя {{user}}: ${userName}` },
        { role: 'user', content: `Сработала отложенная задача веб-поиска.\nЗапрос пользователя: "${query}".\n\nРезультаты поиска:\n${raw}\n\nСформулируй итог для пользователя на русском: кратко, 3-6 пунктов, затем блок "Источники:".` }
      ],
      thinking: { type: 'enabled' }
    });
    const tokens = Number(response?.usage?.total_tokens || 0);
    incrementUserTokenUsage(task.user_id, tokens);
    const final = `${response?.choices?.[0]?.message?.content || ''}`.trim();
    return final || `Запрос: ${query}\n\n${raw}`;
  } catch {
    return `Запрос: ${query}\n\n${raw}`;
  }
};

const runScheduledEmailCheckTask = async (task: { user_id: number; payload: string }) => {
  let searchQuery = '';
  let limit = 5;
  let provider = '';
  let offset = 0;
  let dateFrom = '';
  let dateTo = '';

  const raw = task.payload.trim();
  if (raw) {
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw) as { provider?: string; search_query?: string; limit?: number; offset?: number; date_from?: string; date_to?: string };
        provider = typeof parsed.provider === 'string' ? parsed.provider : '';
        searchQuery = typeof parsed.search_query === 'string' ? parsed.search_query : '';
        limit = typeof parsed.limit === 'number' ? parsed.limit : 5;
        offset = typeof parsed.offset === 'number' ? parsed.offset : 0;
        dateFrom = typeof parsed.date_from === 'string' ? parsed.date_from : '';
        dateTo = typeof parsed.date_to === 'string' ? parsed.date_to : '';
      } catch {
        searchQuery = raw;
      }
    } else {
      searchQuery = raw;
    }
  }

  const result = await runEmailCheck(task.user_id, searchQuery, limit, provider, offset, dateFrom, dateTo);
  const title = searchQuery
    ? `📬 *Запланированная проверка почты*${provider ? ` (${provider})` : ''} (запрос: ${searchQuery})`
    : `📬 *Запланированная проверка почты*${provider ? ` (${provider})` : ''}`;
  return `${title}\n\n${result}`;
};

const runScheduledAiInstructionTask = async (task: { user_id: number; payload: string }) => {
  const instruction = task.payload.trim();
  if (!instruction) return 'Не получилось выполнить AI-инструкцию: пустой payload задачи.';
  const result = await sendMessageThroughAi(task.user_id, `!!! ${instruction}`, undefined, {
    forcePro: true,
    ignoreDailyLimit: true,
    countAsUserMessage: false,
    skipHistory: true,
    persistUserText: `[AI-инструкция по расписанию] ${instruction}`
  });
  return (result.reply_text || '').trim();
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
      if (task.task_type === 'message') {
        successMessage = `🔔 *Напоминание:*\n\n${task.payload}`;
      } else if (task.task_type === 'smart_home') {
        const smartHomeArgs = JSON.parse(task.payload) as SmartHomeArgs;
        const result = await runSmartHomeControl(task.user_id, smartHomeArgs);
        successMessage = `🤖 *Автоматизация сработала:*\n${result}`;
      } else if (task.task_type === 'web_search') {
        const result = await runScheduledWebSearchTask(task);
        successMessage = `🔎 *Запланированный поиск выполнен:*\n\n${result}`;
      } else if (task.task_type === 'email_check') {
        successMessage = await runScheduledEmailCheckTask(task);
      } else if (task.task_type === 'ai_instruction') {
        const result = await runScheduledAiInstructionTask(task);
        successMessage = result ? `🤖 *Запланированная AI-инструкция выполнена:*\n\n${result}` : '';
      }

      if (successMessage && await shouldNotifyTaskResult(task, successMessage)) {
        await safeSendToUser(task.user_id, successMessage);
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
      daily_web_search_count = 0
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
};
