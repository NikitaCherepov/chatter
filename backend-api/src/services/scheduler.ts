import type { TaskDto, TaskRecurrenceType } from '../types.js';
import { getUserById, ensureActiveChat, createChat, appendChatMessage } from './chats.js';
import { runSmartHomeControl, type SmartHomeArgs } from './smart-home.js';
import { getDueTasks, updateTaskNextExecution, updateTaskStatus, updateTaskTargetChat } from './tasks.js';
import { sendMessageThroughAi } from './ai.js';
import { db } from '../db.js';
import { fetchAndSaveCurrencyRates } from './currency.js';
import { sendToDesktop, isDesktopOnline } from '../ws-clients.js';
import { sendTelegramMessage } from './telegram-send.js';
import { getTelegramIdentityForAccount } from './accounts.js';
import { ensureUserMonthlyUsageWindow, resetExpiredMonthlyUsageWindows } from './monthly-usage.js';
import { translateForLanguage } from '../i18n/index.js';

const SCHEDULER_INTERVAL_MS = Math.max(5_000, Number.parseInt(process.env.BACKEND_SCHEDULER_INTERVAL_MS || '30000', 10) || 30_000);

// ── Delivery: unified push for task results ─────────────────────────────────

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

  const telegramIdentity = getTelegramIdentityForAccount(userId);
  const telegramChatId = Number(telegramIdentity?.provider_subject);
  if (Number.isFinite(telegramChatId) && telegramChatId > 0) {
    sendTelegramMessage(telegramChatId, text);
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

// ── Task target routing ─────────────────────────────────────────────────────
//
// target_mode = 'id'           → deliver to the saved target_chat_id (own,
//                                non-room chat). If the chat was deleted or
//                                became a room, self-heal: create a fresh
//                                personal chat and re-point the task.
// target_mode = 'current_chat' → deliver to the user's active chat at run time.
//                                Rooms are forbidden targets: if the active
//                                chat is a room, skip delivery and notify.
// target_mode = 'new_chat'     → create a fresh personal chat on every run.

type TaskChatResolution =
  | { ok: true; chatId: number; isNewChat: boolean }
  | { ok: false; reason: 'room' };

const resolveTaskChat = (task: TaskDto & { user_id: number }, titleText: string): TaskChatResolution => {
  if (task.target_mode === 'new_chat') {
    const res = createChat(task.user_id, titleText.slice(0, 60));
    return { ok: true, chatId: Number(res.lastInsertRowid), isNewChat: true };
  }

  if (task.target_mode === 'id' && task.target_chat_id) {
    const chat = db.prepare('SELECT id, user_id, room_enabled FROM user_chats WHERE id = ?')
      .get(task.target_chat_id) as { id: number; user_id: number; room_enabled: number } | undefined;
    if (chat && chat.user_id === task.user_id && !chat.room_enabled) {
      return { ok: true, chatId: chat.id, isNewChat: false };
    }
    // Self-healing: the saved target died or turned into a room — create a
    // fresh personal chat, deliver there and re-point the task at it.
    const res = createChat(task.user_id, titleText.slice(0, 60));
    const chatId = Number(res.lastInsertRowid);
    updateTaskTargetChat(task.id, chatId);
    return { ok: true, chatId, isNewChat: true };
  }

  // current_chat (and the defensive fallback for inconsistent rows)
  const activeChatId = ensureActiveChat(task.user_id);
  const active = db.prepare('SELECT room_enabled FROM user_chats WHERE id = ?')
    .get(activeChatId) as { room_enabled: number } | undefined;
  if (active?.room_enabled) return { ok: false, reason: 'room' };
  return { ok: true, chatId: activeChatId, isNewChat: false };
};

const notifyTaskRoomRefused = (task: TaskDto & { user_id: number }) => {
  deliverTaskResult(
    task.user_id,
    translateForLanguage(getUserById(task.user_id)?.language, 'tasks.roomRefused', { id: task.id }),
    0,
    false,
  );
};

/** Payload is plain instruction text since the target_mode migration; keep a
 *  tolerant unwrap for any pre-migration JSON wrapper that may have slipped in. */
const extractInstructionText = (payload: string): string => {
  const raw = payload.trim();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const inner = typeof parsed.instruction === 'string' ? parsed.instruction
        : (typeof parsed._instruction === 'string' ? parsed._instruction : '');
      if (inner.trim()) return inner.trim();
    }
  } catch {
    // plain text — use as-is
  }
  return raw;
};

const runScheduledAiInstructionTask = async (
  task: { user_id: number; payload: string },
  chatId: number,
  isNewChat: boolean
): Promise<{ reply_text: string; chat_id: number; is_new_chat: boolean }> => {
  const instruction = extractInstructionText(task.payload);
  const language = getUserById(task.user_id)?.language;
  if (!instruction) throw new Error(translateForLanguage(language, 'tasks.emptyInstruction'));

  const aiTask = `[SCHEDULED TASK]: A scheduled task has fired for this user according to their own instruction.
Execute the instruction using tools if needed.
If, per the instruction's own conditions, there is nothing to report to the user — return a completely EMPTY answer (no text at all): an empty answer means the user will not be notified.
Answer in the user's language.

User's instruction: "${instruction}"`;

  const result = await sendMessageThroughAi(task.user_id, aiTask, chatId, {
    forcePro: true,
    countAsUserMessage: false,
    persistUserText: translateForLanguage(language, 'tasks.aiInstructionRun', { text: instruction }),
    autoRejectHitl: true,
    isBackgroundTask: true,
  });

  return {
    reply_text: (result.reply_text || '').trim(),
    chat_id: result.chat_id || chatId,
    is_new_chat: isNewChat,
  };
};

// Smart home reports failures as error strings, not exceptions.
const SMART_HOME_ERROR_RE = /^(Tool error|MQTT error):/;

/**
 * Finishes a task run. One-shot tasks are closed ('done' on success, 'error'
 * on failure). Recurring tasks never die from a single failed delivery —
 * the run is skipped and the next occurrence is scheduled as usual; only an
 * inability to compute the next occurrence marks the task as broken.
 */
const finishTaskRun = (task: TaskDto & { user_id: number }, success: boolean) => {
  if (task.recurrence_type === 'once') {
    updateTaskStatus(task.id, success ? 'done' : 'error');
    return;
  }
  const nextExecuteAt = computeNextRecurringExecuteAt(task);
  if (!nextExecuteAt) {
    console.error(`[backend-scheduler] cannot compute next run for recurring task #${task.id}, marking as error`);
    updateTaskStatus(task.id, 'error');
    return;
  }
  updateTaskNextExecution(task.id, nextExecuteAt);
};

const tick = async () => {
  const nowUnix = Math.floor(Date.now() / 1000);
  const pendingTasks = getDueTasks(nowUnix);

  for (const task of pendingTasks) {
    let resolvedChatId: number | null = null;
    let resolvedIsNewChat = false;
    try {
      const language = getUserById(task.user_id)?.language;
      // Resolve the destination chat first — rooms refuse delivery outright.
      const titleText = task.task_type === 'ai_instruction'
        ? extractInstructionText(task.payload)
        : task.payload;
      const target = resolveTaskChat(task, titleText);
      if (!target.ok) {
        notifyTaskRoomRefused(task);
        finishTaskRun(task, false);
        continue;
      }
      resolvedChatId = target.chatId;
      resolvedIsNewChat = target.isNewChat;

      let successMessage = '';

      if (task.task_type === 'message') {
        successMessage = translateForLanguage(language, 'tasks.reminder', { text: task.payload });
        await appendChatMessage(task.user_id, resolvedChatId, 'assistant', successMessage);
      } else if (task.task_type === 'smart_home') {
        const smartHomeArgs = JSON.parse(task.payload) as SmartHomeArgs;
        const result = await runSmartHomeControl(task.user_id, smartHomeArgs);
        if (SMART_HOME_ERROR_RE.test(result)) throw new Error(result);
        successMessage = translateForLanguage(language, 'tasks.smartHomeDone', { result });
        await appendChatMessage(task.user_id, resolvedChatId, 'assistant', successMessage);
      } else if (task.task_type === 'ai_instruction') {
        const result = await runScheduledAiInstructionTask(task, resolvedChatId, resolvedIsNewChat);
        successMessage = result.reply_text
          ? translateForLanguage(language, 'tasks.aiInstructionDone', { text: result.reply_text })
          : '';
        resolvedChatId = result.chat_id;
        resolvedIsNewChat = result.is_new_chat;
      }

      // 'always' and NULL (ai_instruction: the model decides — empty answer = silence)
      // deliver every non-empty result; 'on_error' and 'never' stay silent on success.
      if (successMessage && (task.notify_mode === null || task.notify_mode === 'always')) {
        deliverTaskResult(task.user_id, successMessage, resolvedChatId, resolvedIsNewChat);
      }

      finishTaskRun(task, true);
    } catch (err) {
      console.error(`[backend-scheduler] task #${task.id} failed:`, err);
      if (task.notify_mode === 'on_error') {
        const detail = err instanceof Error ? err.message : String(err);
        const chatId = resolvedChatId ?? ensureActiveChat(task.user_id);
        deliverTaskResult(
          task.user_id,
          translateForLanguage(getUserById(task.user_id)?.language, 'tasks.failed', { id: task.id, error: detail }),
          chatId,
          resolvedIsNewChat,
        );
      }
      finishTaskRun(task, false);
    }
  }
};

let timer: NodeJS.Timeout | null = null;
let running = false;

// ── Daily message reset + monthly usage windows + plan expiry ─────────────

const resetDailyMessageCounters = () => db.prepare(`
  UPDATE users
  SET daily_message_count = 0
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

    ensureUserMonthlyUsageWindow(row.user_id);
  }

  if (processedUsers.size > 0) {
    console.log(`[backend-scheduler] expired ${processedUsers.size} plan subscription(s), reverted to free.`);
  }
};

let dailyResetTimer: NodeJS.Timeout | null = null;
let planExpiryTimer: NodeJS.Timeout | null = null;

const scheduleDailyCounterReset = () => {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  const delay = Math.max(1000, next.getTime() - now.getTime());

  dailyResetTimer = setTimeout(() => {
    try {
      resetDailyMessageCounters();
      resetExpiredMonthlyUsageWindows();
      console.log('[backend-scheduler] daily counters reset.');
    } catch (err) {
      console.error('[backend-scheduler] daily reset error:', err);
    } finally {
      scheduleDailyCounterReset();
    }
  }, delay);
};

export const startTaskScheduler = () => {
  // Plan expiry is account maintenance, not an optional scheduled-task feature.
  // It must keep working even when BACKEND_SCHEDULER_ENABLED is disabled.
  if (!planExpiryTimer) {
    try { expireFinishedPlanSubscriptions(); } catch (err) {
      console.error('[backend-scheduler] plan expiry check error:', err);
    }
    planExpiryTimer = setInterval(() => {
      try { expireFinishedPlanSubscriptions(); } catch (err) {
        console.error('[backend-scheduler] plan expiry check error:', err);
      }
    }, 30 * 60 * 1000);
    planExpiryTimer.unref();
  }

  const enabled = `${process.env.BACKEND_SCHEDULER_ENABLED || '1'}`.trim() === '1';
  if (!enabled) {
    console.log('[backend-scheduler] disabled (BACKEND_SCHEDULER_ENABLED=0)');
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

  // Start daily counter reset
  scheduleDailyCounterReset();

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
