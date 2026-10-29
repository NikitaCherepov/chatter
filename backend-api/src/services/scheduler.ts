import type { AiSendResult, TaskDto, TaskRecurrenceType } from '../types.js';
import { getUserById, ensureActiveChat, createChat, appendChatMessage } from './chats.js';
import { runSmartHomeControl, type SmartHomeArgs } from './smart-home.js';
import { getDueTasks, updateTaskNextExecution, updateTaskStatus, updateTaskTargetChat, startTaskRun, completeTaskRun, isOwnNonRoomChat } from './tasks.js';
import { parseTaskCompletion } from './task-completion.js';
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
 * Unified delivery: push task result to desktop (if online) AND Telegram.
 * `telegram: false` skips the external messenger duplication (desktop push is
 * never skipped — the desktop itself decides whether to show a notification).
 */
const deliverTaskResult = (
  userId: number,
  text: string,
  chatId: number,
  isNewChat: boolean,
  { telegram = true }: { telegram?: boolean } = {},
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

  if (!telegram) return;

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
// target_mode = 'chat'     → deliver to the saved target_chat_id (own,
//                            non-room chat). Legacy rows with NULL
//                            target_chat_id fall back to the active chat.
//                            Safety net: if at run time the target turned out
//                            to be a room (or is gone), self-heal — create a
//                            fresh personal chat, re-point the task and, for
//                            rooms, warn the user in the new chat.
// target_mode = 'new_chat' → create a fresh personal chat on every run.

type TaskChatResolution = {
  chatId: number;
  isNewChat: boolean;
  /** True when the previous target turned out to be a room and the result was
   *  redirected into a freshly created chat (triggers the user warning). */
  roomRedirect: boolean;
};

const resolveTaskChat = (task: TaskDto & { user_id: number }, titleText: string): TaskChatResolution => {
  if (task.target_mode === 'new_chat') {
    const res = createChat(task.user_id, titleText.slice(0, 60));
    return { chatId: Number(res.lastInsertRowid), isNewChat: true, roomRedirect: false };
  }

  if (task.target_mode === 'chat' && task.target_chat_id) {
    const chat = db.prepare('SELECT id, user_id, room_enabled FROM user_chats WHERE id = ?')
      .get(task.target_chat_id) as { id: number; user_id: number; room_enabled: number } | undefined;
    if (chat && chat.user_id === task.user_id && !chat.room_enabled) {
      return { chatId: chat.id, isNewChat: false, roomRedirect: false };
    }
    // Safety net: the pinned target died or turned out to be a room — create a
    // fresh personal chat, deliver there and re-point the task at it.
    const isRoom = Boolean(chat && chat.user_id === task.user_id && chat.room_enabled);
    const res = createChat(task.user_id, titleText.slice(0, 60));
    const chatId = Number(res.lastInsertRowid);
    updateTaskTargetChat(task.id, chatId);
    return { chatId, isNewChat: true, roomRedirect: isRoom };
  }

  // Legacy 'chat' rows without a pinned chat: the user's active chat at run
  // time. Rooms trigger the same safety net as above.
  const activeChatId = ensureActiveChat(task.user_id);
  const active = db.prepare('SELECT room_enabled FROM user_chats WHERE id = ?')
    .get(activeChatId) as { room_enabled: number } | undefined;
  if (!active?.room_enabled) {
    return { chatId: activeChatId, isNewChat: false, roomRedirect: false };
  }
  const res = createChat(task.user_id, titleText.slice(0, 60));
  return { chatId: Number(res.lastInsertRowid), isNewChat: true, roomRedirect: true };
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

/** Resolve execution context without creating or redirecting a delivery chat. */
const taskContextChat = (task: TaskDto & { user_id: number }): number | undefined => {
  if (task.target_mode !== 'chat') return undefined;
  const active = db.prepare('SELECT active_chat_id FROM users WHERE id = ?').get(task.user_id) as { active_chat_id: number | null } | undefined;
  const candidate = task.target_chat_id ?? active?.active_chat_id;
  return candidate && isOwnNonRoomChat(task.user_id, candidate) ? candidate : undefined;
};

const runScheduledAiInstructionTask = async (
  task: TaskDto & { user_id: number },
): Promise<AiSendResult> => {
  const instruction = extractInstructionText(task.payload);
  const language = getUserById(task.user_id)?.language;
  if (!instruction) throw new Error(translateForLanguage(language, 'tasks.emptyInstruction'));
  const aiTask = `[SCHEDULED TASK]: Execute this user's scheduled instruction, using tools if needed.
When the work is complete, call finish_task on its own to provide the delivery decision.
If there is an update that meets the user's conditions, set notify_user=true and put it in message, in the user's language.
Otherwise set notify_user=false and message="". Progress text and tool results stay in the internal execution history.

User's instruction: ${JSON.stringify(instruction)}`;
  const result = await sendMessageThroughAi(task.user_id, aiTask, taskContextChat(task), {
    forcePro: true, countAsUserMessage: false, skipHistory: true,
    autoRejectHitl: true, isBackgroundTask: true, scheduledTask: true,
    allowedTools: task.allowed_tools ?? null,
  });
  if (result.aborted) throw new Error('task_aborted');
  result.task_result = parseTaskCompletion(result.task_result);
  return result;
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

const chatTitleById = (chatId: number | null): string | null => {
  if (!chatId) return null;
  const row = db.prepare('SELECT title FROM user_chats WHERE id = ?').get(chatId) as
    | { title: string | null }
    | undefined;
  return row?.title ?? null;
};

export type TaskRunSummary = {
  ok: boolean;
  chatId: number | null;
  chatTitle: string | null;
  isNewChat: boolean;
  roomRedirect: boolean;
  resultText: string;
  delivered: boolean;
  error: string | null;
};

/** advanceSchedule=false = test run: everything executes, but the schedule is left untouched. */
export const runScheduledTask = async (
  task: TaskDto & { user_id: number },
  { advanceSchedule = true }: { advanceSchedule?: boolean } = {},
): Promise<TaskRunSummary> => {
  const tag = advanceSchedule ? 'backend-scheduler' : 'backend-scheduler-test';
  const runId = startTaskRun(task.id, task.user_id, !advanceSchedule);
  let resolvedChatId: number | null = null;
  let resolvedIsNewChat = false;
  let roomRedirect = false;
  let notifyUser: boolean | null = null;
  let aiResult: AiSendResult | undefined;
  let successMessage = '';
  const resolveDelivery = async () => {
    const target = resolveTaskChat(task, task.task_type === 'ai_instruction' ? extractInstructionText(task.payload) : task.payload);
    resolvedChatId = target.chatId;
    resolvedIsNewChat = target.isNewChat;
    roomRedirect = target.roomRedirect;
    if (target.roomRedirect) {
      const warnText = translateForLanguage(getUserById(task.user_id)?.language, 'tasks.roomRedirected', { id: task.id });
      await appendChatMessage(task.user_id, target.chatId, 'assistant', warnText);
      deliverTaskResult(task.user_id, warnText, target.chatId, true, { telegram: task.redirect_notify });
    }
    return target.chatId;
  };
  try {
    const language = getUserById(task.user_id)?.language;
    if (task.task_type === 'ai_instruction') {
      aiResult = await runScheduledAiInstructionTask(task);
      notifyUser = aiResult.task_result!.notify_user;
      successMessage = aiResult.task_result!.message;
    } else {
      // Ordinary reminders and smart-home tasks retain their existing history.
      await resolveDelivery();
      notifyUser = true;
      if (task.task_type === 'message') {
        successMessage = translateForLanguage(language, 'tasks.reminder', { text: task.payload });
      } else if (task.task_type === 'smart_home') {
        const result = await runSmartHomeControl(task.user_id, JSON.parse(task.payload) as SmartHomeArgs);
        if (SMART_HOME_ERROR_RE.test(result)) throw new Error(result);
        successMessage = translateForLanguage(language, 'tasks.smartHomeDone', { result });
      }
      await appendChatMessage(task.user_id, resolvedChatId!, 'assistant', successMessage);
    }

    let delivered = false;
    if (notifyUser && successMessage && (task.notify_mode === null || task.notify_mode === 'always')) {
      if (aiResult) {
        const chatId = await resolveDelivery();
        const instruction = extractInstructionText(task.payload);
        await appendChatMessage(task.user_id, chatId, 'user', translateForLanguage(language, 'tasks.aiInstructionRun', { text: instruction }));
        const images = aiResult.response_images ?? aiResult.generated_images?.filter(image => image.image_url).map(image => ({ url: image.image_url!, type: 'generated' as const }));
        await appendChatMessage(task.user_id, chatId, 'assistant', successMessage, null, null, images, aiResult.reasoning_content, null,
          aiResult.response_attachments, null, { usage: aiResult.message_usage, modelName: aiResult.model_name, providerName: aiResult.provider_name });
      }
      deliverTaskResult(task.user_id, successMessage, resolvedChatId!, resolvedIsNewChat);
      delivered = true;
    }
    if (advanceSchedule) finishTaskRun(task, true);
    const summary = { ok: true, chatId: resolvedChatId, chatTitle: chatTitleById(resolvedChatId), isNewChat: resolvedIsNewChat,
      roomRedirect, resultText: successMessage, delivered, error: null };
    completeTaskRun(runId, { ...summary, notifyUser, trace: aiResult?.task_trace, usage: aiResult?.message_usage });
    return summary;
  } catch (err) {
    console.error(`[${tag}] task #${task.id} failed:`, err);
    const detail = err instanceof Error ? err.message : String(err);
    let errorDelivered = false;
    if (task.notify_mode === 'on_error') {
      try {
        const chatId = resolvedChatId ?? await resolveDelivery();
        const errorText = translateForLanguage(getUserById(task.user_id)?.language, 'tasks.failed', { id: task.id, error: detail });
        await appendChatMessage(task.user_id, chatId, 'assistant', errorText);
        deliverTaskResult(task.user_id, errorText, chatId, resolvedIsNewChat);
        errorDelivered = true;
      } catch (deliveryError) { console.error(`[${tag}] error delivery failed for task #${task.id}`, deliveryError); }
    }
    if (advanceSchedule) finishTaskRun(task, false);
    const summary = { ok: false, chatId: resolvedChatId, chatTitle: chatTitleById(resolvedChatId), isNewChat: resolvedIsNewChat,
      roomRedirect, resultText: '', delivered: errorDelivered, error: detail };
    completeTaskRun(runId, { ...summary, notifyUser, trace: aiResult?.task_trace, usage: aiResult?.message_usage });
    return summary;
  }
};

const tick = async () => {
  const nowUnix = Math.floor(Date.now() / 1000);
  const pendingTasks = getDueTasks(nowUnix);

  for (const task of pendingTasks) {
    await runScheduledTask(task);
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
