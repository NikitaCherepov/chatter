import OpenAI from 'openai';
import dotenv from 'dotenv';
import { tavily } from '@tavily/core';
import type { AiSendResult, TaskNotifyMode, TaskRecurrenceType, TaskType, UserPlan, UserRecord } from '../types.js';
import { appendChatMessage, ensureActiveChat, getHistoryForAi, getPromptForUser, getUserById, resolveEffectiveContextWindow, setUserTimezone } from './chats.js';
import { createNote, deleteNote, getNoteById, listNotes } from './notes.js';
import { createTask, deletePendingTask, getPendingTaskCount, listTasks } from './tasks.js';
import { runSmartHomeControl, type SmartHomeArgs } from './smart-home.js';
import { runEmailCheck, runEmailRead, runEmailSend } from './mail.js';
import { runCoreMemoryMerge } from './memory.js';
import { getCleanTextFromUrl } from './web-reader.js';
import { db } from '../db.js';

dotenv.config();

const FALLBACK_ANSWER = 'Слушай, чет я завис. Попробуй еще раз?';
const MAX_TOOL_LOOPS = 6;
const MAX_PENDING_TASKS_PER_USER = 10;
const DEFAULT_MAIL_CHECK_LIMIT = 10;
const TOKENS_PER_PRICE_BLOCK = 500_000;
const PRICE_PER_PRICE_BLOCK_RUB = 102;
const RUB_PER_TOKEN = PRICE_PER_PRICE_BLOCK_RUB / TOKENS_PER_PRICE_BLOCK;
const tvly = process.env.TAVILY_API_KEY ? tavily({ apiKey: process.env.TAVILY_API_KEY }) : null;

const parseModelChain = (raw: string | undefined, fallback: string[]) => {
  const parsed = (raw || '').split(',').map(v => v.trim()).filter(Boolean);
  return parsed.length ? parsed : fallback;
};

type LiteProvider = {
  name: string;
  baseURL: string;
  client: OpenAI;
  modelChain: string[];
};

type CompletionMeta = {
  response: any;
  usedModel: string;
  usedProvider: string;
  failedModels?: string[];
  failedProviders?: string[];
};

const PRO_MODEL_CHAIN = parseModelChain(process.env.TIMEWEB_MODEL, ['gemini/gemini-3.1-flash-lite-preview']);
const PRO_CLIENT = new OpenAI({
  apiKey: process.env.TIMEWEB_API_KEY,
  baseURL: process.env.TIMEWEB_BASE_URL
});

const parseLiteProviders = (): LiteProvider[] => {
  const defaultBase = (process.env.TIMEWEB_LITE_BASE_URL || process.env.TIMEWEB_BASE_URL || '').trim();
  const defaultKey = (process.env.TIMEWEB_LITE_API_KEY || process.env.TIMEWEB_API_KEY || '').trim();
  const defaultModels = parseModelChain(process.env.TIMEWEB_LITE_MODEL, ['gemini/gemini-2.5-flash-lite']);
  const raw = (process.env.TIMEWEB_LITE_ENDPOINTS || '').trim();

  if (!raw) {
    if (!defaultBase || !defaultKey) return [];
    return [{
      name: 'lite-1',
      baseURL: defaultBase,
      client: new OpenAI({ apiKey: defaultKey, baseURL: defaultBase }),
      modelChain: defaultModels
    }];
  }

  const chunks = raw.split(';').map(v => v.trim()).filter(Boolean);
  const providers: LiteProvider[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const [baseRaw, keyRaw, modelsRaw] = chunks[i].split('|').map(v => `${v || ''}`.trim());
    const base = baseRaw || defaultBase;
    const key = keyRaw || defaultKey;
    const models = parseModelChain(modelsRaw, defaultModels);
    if (!base || !key || !models.length) continue;
    providers.push({
      name: `lite-${i + 1}`,
      baseURL: base,
      client: new OpenAI({ apiKey: key, baseURL: base }),
      modelChain: models
    });
  }
  return providers;
};

const LITE_PROVIDERS = parseLiteProviders();
const DEBUG_AI_RAW_MAIN_RESPONSE = process.env.DEBUG_AI_RAW_MAIN_RESPONSE === '1';
const DEBUG_AI_RAW_LITE_RESPONSE = process.env.DEBUG_AI_RAW_LITE_RESPONSE === '1';

const extractTokens = (response: any) => Number(response?.usage?.total_tokens || 0);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const RETRY_SECONDS = Math.max(0, Number.parseInt(process.env.TIMEWEB_MODEL_RETRY_SECONDS || '3', 10) || 3);
const RETRIES_PER_MODEL = Math.max(0, Number.parseInt(process.env.TIMEWEB_MODEL_RETRIES_PER_MODEL || '1', 10) || 1);

const isRetryable = (err: any) => {
  const status = Number(err?.status || err?.response?.status || 0) || 0;
  const code = `${err?.code || err?.error?.code || ''}`;
  const message = `${err?.message || err?.error?.message || ''}`.toLowerCase();
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  if (code === '1305') return true;
  return message.includes('overloaded') || message.includes('try again later') || message.includes('timeout') || message.includes('rate limit');
};

const createCompletionWithModelFallback = async (client: OpenAI, modelChain: string[], requestBody: Record<string, unknown>) => {
  const failedModels: string[] = [];
  let lastError: unknown = null;

  for (const model of modelChain) {
    const attempts = RETRIES_PER_MODEL + 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await client.chat.completions.create({ ...requestBody, model } as any);
        return { response, modelUsed: model, failedModels };
      } catch (err) {
        lastError = err;
        if (isRetryable(err) && attempt < attempts) {
          await sleep(RETRY_SECONDS * 1000);
          continue;
        }
        break;
      }
    }
    failedModels.push(model);
  }

  throw Object.assign(new Error('model_chain_failed'), { failedModels, cause: lastError });
};

const createCompletionWithLiteProviderFallback = async (requestBody: Record<string, unknown>) => {
  const failedProviders: string[] = [];
  const failedModels: string[] = [];

  for (const provider of LITE_PROVIDERS) {
    try {
      const completion = await createCompletionWithModelFallback(provider.client, provider.modelChain, requestBody);
      if (completion.failedModels.length) {
        failedModels.push(...completion.failedModels.map(m => `${provider.name}:${m}`));
      }
      return {
        response: completion.response,
        modelUsed: completion.modelUsed,
        providerUsed: provider.name,
        failedProviders,
        failedModels
      };
    } catch (err: any) {
      failedProviders.push(provider.name);
      if (Array.isArray(err?.failedModels)) {
        failedModels.push(...err.failedModels.map((m: string) => `${provider.name}:${m}`));
      }
    }
  }

  throw Object.assign(new Error('lite_providers_failed'), { failedProviders, failedModels });
};

const buildSystemPrompt = (prompt: string, userName: string, coreMemory: string) => {
  return `${prompt}\n\nИмя {{user}}: ${userName}\n\n[ПОСТОЯННЫЕ ЗНАНИЯ О ПОЛЬЗОВАТЕЛЕ]\n${coreMemory || 'Пока пусто.'}`;
};

const buildTimeContext = (timezoneOffset: number) => {
  const now = new Date();
  const localTime = new Date(now.getTime() + timezoneOffset * 3600 * 1000);
  const sign = timezoneOffset >= 0 ? '+' : '';
  return `\n\n[СИСТЕМНАЯ ИНФОРМАЦИЯ]\nТекущее Unix-время (в секундах): ${Math.floor(now.getTime() / 1000)}.\nЛокальное время пользователя: ${localTime.toISOString().replace('T', ' ').slice(0, 19)} (UTC${sign}${timezoneOffset}).`;
};

const isLitePlan = (plan: UserPlan) => plan === 'free' || plan === 'standart';
const toRubFromTokens = (tokens: number) => Math.max(0, tokens) * RUB_PER_TOKEN;

const normalizeDailyMessageLimit = (value: number | null | undefined) => {
  if (!Number.isFinite(Number(value))) return 0;
  return Math.max(0, Math.floor(Number(value)));
};

const normalizeDailyWebSearchLimit = (value: number | null | undefined) => {
  if (!Number.isFinite(Number(value))) return 0;
  return Math.max(0, Math.floor(Number(value)));
};

const getIsoWeekday = (date: Date) => {
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
};

const parseLocalTime = (value: string) => {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
};

const computeExecuteAtFromLocalTime = (
  localTime: string,
  timezoneOffset: number,
  recurrenceType: TaskRecurrenceType,
  recurrenceWeekday: number | null
) => {
  const parsed = parseLocalTime(localTime);
  if (!parsed) throw new Error('Некорректный local_time. Ожидаю формат HH:MM, например 02:07.');

  const nowUnix = Math.floor(Date.now() / 1000);
  const localNow = new Date((nowUnix + timezoneOffset * 3600) * 1000);
  const targetLocal = new Date(localNow.getTime());
  targetLocal.setUTCHours(parsed.hours, parsed.minutes, 0, 0);

  if (recurrenceType === 'weekly') {
    if (!recurrenceWeekday || recurrenceWeekday < 1 || recurrenceWeekday > 7) {
      throw new Error('Для weekly укажи recurrence_weekday от 1 до 7 (1=понедельник).');
    }
    const currentWeekday = getIsoWeekday(targetLocal);
    let deltaDays = (recurrenceWeekday - currentWeekday + 7) % 7;
    if (deltaDays === 0 && targetLocal.getTime() <= localNow.getTime()) deltaDays = 7;
    if (deltaDays > 0) targetLocal.setUTCDate(targetLocal.getUTCDate() + deltaDays);
  } else if (targetLocal.getTime() <= localNow.getTime()) {
    targetLocal.setUTCDate(targetLocal.getUTCDate() + 1);
  }

  return Math.floor(targetLocal.getTime() / 1000 - timezoneOffset * 3600);
};

const computeExecuteAtFromScheduleArgs = (
  parsed: Record<string, any>,
  timezoneOffset: number,
  recurrenceType: TaskRecurrenceType,
  recurrenceWeekday: number | null
) => {
  if (typeof parsed.local_time === 'string' && parsed.local_time.trim()) {
    return computeExecuteAtFromLocalTime(parsed.local_time, timezoneOffset, recurrenceType, recurrenceWeekday);
  }
  if (typeof parsed.delay_seconds === 'number') {
    if (!Number.isFinite(parsed.delay_seconds) || parsed.delay_seconds < 0) throw new Error('Некорректный delay_seconds (ожидаю число >= 0).');
    return Math.floor(Date.now() / 1000) + Math.floor(parsed.delay_seconds);
  }
  const executeAt = Number(parsed.execute_at);
  if (Number.isFinite(executeAt) && executeAt > 0) return Math.floor(executeAt);
  throw new Error('Не указано время задачи. Передай local_time (HH:MM), delay_seconds или execute_at.');
};

const formatUnixForTimezone = (unixSeconds: number, timezoneOffset: number) => {
  const local = new Date((unixSeconds + timezoneOffset * 3600) * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const utc = new Date(unixSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const sign = timezoneOffset >= 0 ? '+' : '';
  return { local, utc, tzLabel: `UTC${sign}${timezoneOffset}` };
};

const checkWebSearchLimit = (user: UserRecord) => {
  const limit = normalizeDailyWebSearchLimit(user.daily_web_search_limit);
  const count = Math.max(0, Math.floor(Number(user.daily_web_search_count || 0)));
  if (limit <= 0) return { allowed: false, count, limit, reason: 'По твоему плану web-поиск отключен на сегодня.' };
  if (count >= limit) return { allowed: false, count, limit, reason: `Лимит web-поиска на сегодня исчерпан (${count}/${limit}).` };
  return { allowed: true, count, limit, reason: '' };
};

const incrementUserWebSearchUsage = (userId: number, count = 1) => {
  const safeCount = Math.max(0, Math.floor(count));
  if (safeCount <= 0) return;
  db.prepare(`
    UPDATE users
    SET daily_web_search_count = COALESCE(daily_web_search_count, 0) + ?,
        total_web_search_count = COALESCE(total_web_search_count, 0) + ?
    WHERE id = ?
  `).run(safeCount, safeCount, userId);
};

const formatTasksList = (tasks: ReturnType<typeof listTasks>, timezoneOffset: number) => {
  if (!tasks.length) return 'Задач нет.';
  return tasks.map((t) => {
    const when = formatUnixForTimezone(t.execute_at, t.timezone_offset ?? timezoneOffset);
    const notifyText = (t.notify_mode === 'on_match' || t.notify_mode === 'on_condition')
      ? `${t.notify_mode}: ${t.notify_condition || '(пусто)'}`
      : t.notify_mode;
    return `#${t.id} | ${t.task_type} | ${t.status}\nКогда: ${when.local} (${when.tzLabel})\nКогда (UTC): ${when.utc} UTC\nРасписание: ${t.recurrence_type}\nУведомления: ${notifyText}\nДанные: ${t.payload.slice(0, 180)}`;
  }).join('\n\n');
};

const runSaveNoteTool = (user: UserRecord, contentRaw: string, titleRaw = '') => {
  const created = createNote(user.id, user.plan, `${titleRaw || ''}`, `${contentRaw || ''}`);
  if (!created.ok) {
    if (created.error === 'notes_limit') return 'Ошибка: достигнут лимит заметок по плану.';
    if (created.error === 'content_too_long') return 'Ошибка: текст заметки слишком длинный для текущего плана.';
    if (created.error === 'title_too_long') return 'Ошибка: заголовок слишком длинный (макс 120 символов).';
    return `Ошибка: ${created.error}`;
  }
  return `Заметка сохранена: #${created.id}`;
};

const runListNotesTool = (userId: number, queryRaw = '', limitRaw?: number, offsetRaw?: number) => {
  const limit = Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 20;
  const offset = Number.isFinite(Number(offsetRaw)) ? Number(offsetRaw) : 0;
  const notes = listNotes(userId, limit, offset, `${queryRaw || ''}`);
  if (!notes.length) return 'Заметок не найдено.';
  return notes.map(n => `#${n.id} | ${n.title || '(без заголовка)'}\n${n.content}`).join('\n\n');
};

const runReadNoteTool = (userId: number, noteIdRaw?: number) => {
  const noteId = Number(noteIdRaw);
  if (!Number.isFinite(noteId) || noteId <= 0) return 'Ошибка: note_id должен быть положительным числом.';
  const note = getNoteById(userId, Math.floor(noteId));
  if (!note) return `Заметка #${Math.floor(noteId)} не найдена.`;
  return `#${note.id}\nЗаголовок: ${note.title || '(без заголовка)'}\nСоздано: ${new Date(note.created_at * 1000).toISOString()}\nОбновлено: ${new Date(note.updated_at * 1000).toISOString()}\n\n${note.content}`;
};

const runDeleteNoteTool = (userId: number, noteIdRaw?: number) => {
  const noteId = Number(noteIdRaw);
  if (!Number.isFinite(noteId) || noteId <= 0) return 'Ошибка: note_id должен быть положительным числом.';
  const ok = deleteNote(userId, Math.floor(noteId));
  if (!ok) return `Заметка #${Math.floor(noteId)} не найдена.`;
  const updated = runListNotesTool(userId, '', 20, 0);
  return `Заметка #${Math.floor(noteId)} удалена.\n\nОбновлённый список:\n${updated}`;
};

const toolDefinitions = [
  { type: 'function', function: { name: 'search_web', description: 'Поиск актуальной информации в интернете.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'read_webpage', description: 'Читает и очищает текст веб-страницы по URL.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'control_smart_home', description: 'Управление устройствами умного дома.', parameters: { type: 'object', properties: { device_name: { type: 'string' }, action: { type: 'string', enum: ['on', 'off', 'set_color', 'set_brightness'] }, color: { type: 'string' }, brightness: { type: 'number' } }, required: ['device_name', 'action'] } } },
  { type: 'function', function: { name: 'set_user_timezone', description: 'Установка часового пояса пользователя в формате UTC offset.', parameters: { type: 'object', properties: { timezone_offset: { type: 'number' } }, required: ['timezone_offset'] } } },
  { type: 'function', function: { name: 'random_roll', description: 'Подбросить монетку или бросить кубик.', parameters: { type: 'object', properties: { roll_type: { type: 'string', enum: ['coin', 'dice'] }, dice_notation: { type: 'string' } } } } },
  { type: 'function', function: { name: 'save_note', description: 'Сохранить заметку пользователя.', parameters: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } }, required: ['content'] } } },
  { type: 'function', function: { name: 'list_my_notes', description: 'Показать заметки пользователя.', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } } } } },
  { type: 'function', function: { name: 'read_note', description: 'Прочитать одну заметку по id.', parameters: { type: 'object', properties: { note_id: { type: 'number' } }, required: ['note_id'] } } },
  { type: 'function', function: { name: 'delete_note', description: 'Удалить заметку по id.', parameters: { type: 'object', properties: { note_id: { type: 'number' } }, required: ['note_id'] } } },
  { type: 'function', function: { name: 'get_my_tasks', description: 'Показать задачи пользователя.', parameters: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'done', 'error', 'all'] }, limit: { type: 'number' } } } } },
  { type: 'function', function: { name: 'schedule_task', description: 'Создать задачу/напоминание.', parameters: { type: 'object', properties: { task_type: { type: 'string', enum: ['message', 'web_search', 'email_check', 'ai_instruction', 'smart_home'] }, payload: { type: 'string' }, local_time: { type: 'string' }, execute_at: { type: 'number' }, delay_seconds: { type: 'number' }, recurrence_type: { type: 'string', enum: ['once', 'daily', 'weekly'] }, recurrence_weekday: { type: 'number' }, notify_mode: { type: 'string', enum: ['always', 'never', 'on_match', 'on_condition'] }, notify_condition: { type: 'string' } }, required: ['task_type', 'payload'] } } },
  { type: 'function', function: { name: 'delete_my_task', description: 'Удалить pending-задачу по id.', parameters: { type: 'object', properties: { task_id: { type: 'number' } }, required: ['task_id'] } } },
  { type: 'function', function: { name: 'check_emails', description: 'Проверить почту пользователя (поиск, фильтр по датам, пагинация).', parameters: { type: 'object', properties: { provider: { type: 'string', enum: ['yandex', 'google'] }, search_query: { type: 'string' }, date_from: { type: 'string' }, date_to: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } } } } },
  { type: 'function', function: { name: 'read_email_content', description: 'Прочитать текст письма по части темы.', parameters: { type: 'object', properties: { provider: { type: 'string', enum: ['yandex', 'google'] }, subject_part: { type: 'string' } }, required: ['subject_part'] } } },
  { type: 'function', function: { name: 'send_email', description: 'Отправить письмо от имени пользователя.', parameters: { type: 'object', properties: { provider: { type: 'string', enum: ['yandex', 'google'] }, to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] } } },
  { type: 'function', function: { name: 'update_core_memory', description: 'Обновить постоянную память пользователя важным фактом.', parameters: { type: 'object', properties: { new_fact: { type: 'string' }, explicit_request: { type: 'boolean' } }, required: ['new_fact'] } } },
  { type: 'function', function: { name: 'escalate_to_pro', description: 'Эскалация в старшую модель. Используй только если запрос сложный и требует PRO.', parameters: { type: 'object', properties: { original_query: { type: 'string' } }, required: ['original_query'] } } }
] as const;

const runCompletion = async (mode: 'pro' | 'lite', requestPayload: Record<string, unknown>): Promise<CompletionMeta> => {
  if (mode === 'pro') {
    const res = await createCompletionWithModelFallback(PRO_CLIENT, PRO_MODEL_CHAIN, requestPayload);
    return {
      response: res.response,
      usedModel: res.modelUsed,
      usedProvider: 'pro-main',
      failedModels: res.failedModels
    };
  }
  const res = await createCompletionWithLiteProviderFallback(requestPayload);
  return {
    response: res.response,
    usedModel: res.modelUsed,
    usedProvider: res.providerUsed,
    failedModels: res.failedModels,
    failedProviders: res.failedProviders
  };
};

const hasSchedulingIntent = (text: string) => /\b(напомн|напоминани|таймер|по\s+расписанию|отложи|позже|завтра|послезавтра|ежедневно|еженедельно|кажд(ый|ую|ое|ые)|every\s+day|every\s+week)\b/i.test(text)
  || /\bв\s*\d{1,2}:\d{2}\b/i.test(text)
  || /через\s+[^.,!?]{0,24}\b(секунд|секунду|секунды|сек|минут|минуту|минута|мин|час|часа|часов|ч|день|дня|дней|сутк|недел|месяц|месяца|месяцев)\b/i.test(text);

const runTool = async (user: UserRecord, timezoneOffset: number, toolName: string, argsRaw: string, aiCall: (requestPayload: Record<string, unknown>) => Promise<CompletionMeta>) => {
  const parsed = JSON.parse(argsRaw || '{}');

  if (toolName === 'search_web') {
    const query = `${parsed.query || ''}`.trim();
    if (!query) return 'Ошибка: пустой query.';
    if (!tvly) return 'Ошибка: web search отключен (нет TAVILY_API_KEY).';
    const webLimit = checkWebSearchLimit(user);
    if (!webLimit.allowed) return webLimit.reason;
    const res = await tvly.search(query, { searchDepth: 'basic', maxResults: 3, includeAnswer: true });
    incrementUserWebSearchUsage(user.id, 1);
    const list = (res.results || []).map((item: any, idx: number) => `${idx + 1}. ${item.title}\n${item.content}\nИсточник: ${item.url}`).join('\n\n');
    return `${res.answer ? `Сводка: ${res.answer}\n\n` : ''}${list || 'Ничего не найдено.'}`;
  }

  if (toolName === 'read_webpage') {
    const url = `${parsed.url || ''}`.trim();
    if (!url) return 'Ошибка инструмента: пустой URL.';
    try { return await getCleanTextFromUrl(url); } catch (err: any) { return `Ошибка инструмента read_webpage: ${err?.message || String(err)}`; }
  }
  if (toolName === 'control_smart_home') return runSmartHomeControl(user.id, parsed as SmartHomeArgs);
  if (toolName === 'set_user_timezone') {
    const tz = Number(parsed.timezone_offset);
    if (!Number.isFinite(tz) || tz < -12 || tz > 14) return 'Ошибка: timezone_offset должен быть от -12 до 14.';
    setUserTimezone(user.id, Math.floor(tz));
    const sign = tz >= 0 ? '+' : '';
    return `Часовой пояс обновлён: UTC${sign}${Math.floor(tz)}.`;
  }
  if (toolName === 'random_roll') return `${parsed.roll_type || 'coin'}` === 'dice' ? `Кубик: ${1 + Math.floor(Math.random() * 6)}` : (Math.random() < 0.5 ? 'Монетка: орёл' : 'Монетка: решка');
  if (toolName === 'save_note') return runSaveNoteTool(user, typeof parsed.content === 'string' ? parsed.content : '', typeof parsed.title === 'string' ? parsed.title : '');
  if (toolName === 'list_my_notes') return runListNotesTool(user.id, typeof parsed.query === 'string' ? parsed.query : '', Number(parsed.limit), Number(parsed.offset));
  if (toolName === 'read_note') return runReadNoteTool(user.id, Number(parsed.note_id));
  if (toolName === 'delete_note') return runDeleteNoteTool(user.id, Number(parsed.note_id));
  if (toolName === 'get_my_tasks') {
    const status = ['pending', 'done', 'error', 'all'].includes(`${parsed.status || ''}`) ? parsed.status : 'pending';
    const limit = Number.isFinite(Number(parsed.limit)) ? Number(parsed.limit) : 20;
    return formatTasksList(listTasks(user.id, limit, status), timezoneOffset);
  }
  if (toolName === 'schedule_task') {
    if (user.timezone_confirmed !== 1) return 'Ошибка планирования: часовой пояс пользователя не настроен. Сначала вызови set_user_timezone.';
    const taskType = `${parsed.task_type || ''}` as TaskType;
    if (!['message', 'smart_home', 'web_search', 'email_check', 'ai_instruction'].includes(taskType)) return 'Ошибка: Некорректный task_type';
    let payload = `${parsed.payload || ''}`.trim();
    if (!payload) return 'Ошибка: payload_required';
    const recurrenceType = `${parsed.recurrence_type || 'once'}` as TaskRecurrenceType;
    if (!['once', 'daily', 'weekly'].includes(recurrenceType)) return 'Ошибка: Некорректный recurrence_type';
    const recurrenceWeekday = Number.isFinite(Number(parsed.recurrence_weekday)) ? Math.floor(Number(parsed.recurrence_weekday)) : null;
    if (recurrenceType === 'weekly' && (!recurrenceWeekday || recurrenceWeekday < 1 || recurrenceWeekday > 7)) return 'Ошибка: Для weekly укажи recurrence_weekday от 1 до 7 (1=понедельник).';
    const notifyMode = `${parsed.notify_mode || 'always'}` as TaskNotifyMode;
    if (!['always', 'never', 'on_match', 'on_condition'].includes(notifyMode)) return 'Ошибка: Некорректный notify_mode';
    const notifyCondition = parsed.notify_condition == null ? null : `${parsed.notify_condition}`.trim();
    if ((notifyMode === 'on_match' || notifyMode === 'on_condition') && !notifyCondition) return 'Ошибка: Для notify_mode=on_match/on_condition укажи notify_condition.';
    if (getPendingTaskCount(user.id) >= MAX_PENDING_TASKS_PER_USER) return `Лимит активных задач: ${MAX_PENDING_TASKS_PER_USER}. Удали лишние через delete_my_task.`;
    if (taskType === 'smart_home') payload = JSON.stringify(JSON.parse(payload) as SmartHomeArgs);
    const executeAt = computeExecuteAtFromScheduleArgs(parsed, timezoneOffset, recurrenceType, recurrenceWeekday);
    const taskId = createTask(user.id, executeAt, taskType, payload, recurrenceType, recurrenceType === 'weekly' ? recurrenceWeekday : null, timezoneOffset, notifyMode, (notifyMode === 'on_match' || notifyMode === 'on_condition') ? notifyCondition : null);
    const planned = formatUnixForTimezone(executeAt, timezoneOffset);
    return `Задача создана: #${taskId}. Следующий запуск: ${planned.local} (${planned.tzLabel}), UTC: ${planned.utc}.`;
  }
  if (toolName === 'delete_my_task') {
    const taskId = Number(parsed.task_id);
    if (!Number.isFinite(taskId) || taskId <= 0) return 'Ошибка: bad task_id';
    const ok = deletePendingTask(user.id, Math.floor(taskId));
    if (!ok) return 'Задача не найдена или уже не pending.';
    const updated = listTasks(user.id, 20, 'pending');
    return `Задача #${Math.floor(taskId)} удалена.\n\nОбновлённый список активных задач (${updated.length}/${MAX_PENDING_TASKS_PER_USER}):\n${formatTasksList(updated, timezoneOffset)}`;
  }
  if (toolName === 'check_emails') return runEmailCheck(user.id, typeof parsed.search_query === 'string' ? parsed.search_query : '', Number.isFinite(Number(parsed.limit)) ? Number(parsed.limit) : (Number(user.mail_check_limit) || DEFAULT_MAIL_CHECK_LIMIT), typeof parsed.provider === 'string' ? parsed.provider : '', Number.isFinite(Number(parsed.offset)) ? Number(parsed.offset) : 0, typeof parsed.date_from === 'string' ? parsed.date_from : '', typeof parsed.date_to === 'string' ? parsed.date_to : '');
  if (toolName === 'read_email_content') return runEmailRead(user.id, typeof parsed.subject_part === 'string' ? parsed.subject_part : '', typeof parsed.provider === 'string' ? parsed.provider : '');
  if (toolName === 'send_email') return runEmailSend(user.id, typeof parsed.to === 'string' ? parsed.to : '', typeof parsed.subject === 'string' ? parsed.subject : '', typeof parsed.body === 'string' ? parsed.body : '', typeof parsed.provider === 'string' ? parsed.provider : '');
  if (toolName === 'update_core_memory') return runCoreMemoryMerge(aiCall, user.id, typeof parsed.new_fact === 'string' ? parsed.new_fact : '', Boolean(parsed.explicit_request));
  if (toolName === 'escalate_to_pro') return '__ESCALATE_TO_PRO__';
  return `Ошибка: неизвестный инструмент ${toolName}`;
};

export const sendMessageThroughAi = async (
  userId: number,
  inputText: string,
  targetChatId?: number,
  options?: {
    forcePro?: boolean;
    ignoreDailyLimit?: boolean;
    countAsUserMessage?: boolean;
    skipHistory?: boolean;
    persistUserText?: string;
  }
): Promise<AiSendResult> => {
  const user = getUserById(userId);
  if (!user) throw new Error('user_not_found');
  if (user.status !== 'approved' && user.is_admin !== 1) throw new Error('user_not_approved');

  let text = (inputText || '').trim();
  if (!text) throw new Error('empty_text');
  const forceProRoute = Boolean(options?.forcePro) || text.startsWith('!!!');
  if (forceProRoute) {
    text = text.replace(/^!{3,}/, '').trim();
    if (!text) throw new Error('empty_text');
  }

  const dailyLimit = normalizeDailyMessageLimit(user.daily_message_limit);
  const dailyCount = Math.max(0, Math.floor(Number(user.daily_message_count || 0)));
  if (!options?.ignoreDailyLimit && user.is_admin !== 1 && dailyLimit > 0 && dailyCount >= dailyLimit) throw new Error('daily_message_limit_reached');

  const chatId = targetChatId && Number.isFinite(targetChatId) ? targetChatId : ensureActiveChat(userId);
  const contextWindow = resolveEffectiveContextWindow(user);
  const history = getHistoryForAi(userId, chatId, contextWindow);
  const timezone = Number.isFinite(Number(user.timezone_offset)) ? Number(user.timezone_offset) : 7;
  const baseSystemPrompt = `${buildSystemPrompt(getPromptForUser(user), user.name || user.tg_username || 'Пользователь', user.core_memory || '')}${buildTimeContext(timezone)}`;

  let executionMode: 'pro' | 'lite' = isLitePlan(user.plan) ? 'lite' : 'pro';
  let executionTools: any[] = [...toolDefinitions] as any[];
  let executionHistory = history;
  let executionSystemPrompt = baseSystemPrompt;

  if (!forceProRoute && executionMode === 'lite') {
    const routerPrompt = `Ты - маршрутизатор запросов. Твоя цель - определить категорию запроса. ВСЕ, что не укладывается в тип запроса, перенаправляй в PRO. Верни только одно слово: SMART_HOME, QUICK_SEARCH, TIMEZONE, RANDOM, PRO. Запрос: "${text}"`;
    let route = 'PRO';
    if (!hasSchedulingIntent(text)) {
      try {
        const routed = await runCompletion('lite', { messages: [{ role: 'user', content: routerPrompt }], temperature: 0, max_tokens: 8, thinking: { type: 'disabled' } });
        if (DEBUG_AI_RAW_LITE_RESPONSE) {
          try {
            console.log('[DEBUG_AI_RAW_LITE_RESPONSE][router]', JSON.stringify(routed.response, null, 2));
          } catch (err) {
            console.warn('[DEBUG_AI_RAW_LITE_RESPONSE][router] serialization failed:', err);
          }
        }
        if ((routed.failedProviders?.length || 0) > 0 || (routed.failedModels?.length || 0) > 0) {
          console.warn(
            `[LITE router fallback] providers_failed=${routed.failedProviders?.join(',') || '-'} models_failed=${routed.failedModels?.join(',') || '-'} used=${routed.usedProvider}/${routed.usedModel}`
          );
        }
        route = `${routed.response?.choices?.[0]?.message?.content || ''}`.toUpperCase();
      } catch {
        route = 'PRO';
      }
    }

    if (!route.includes('PRO')) {
      const cheapMap: Record<string, string[]> = { SMART_HOME: ['control_smart_home'], QUICK_SEARCH: ['search_web'], TIMEZONE: ['set_user_timezone'], RANDOM: ['random_roll'] };
      const matched = Object.keys(cheapMap).find(k => route.includes(k));
      if (matched) {
        const allowed = new Set(cheapMap[matched]);
        executionTools = toolDefinitions.filter(t => allowed.has(`${(t as any)?.function?.name || ''}`)) as any[];
        executionHistory = [];
        executionSystemPrompt = 'Ты ассистент. Выполни задачу пользователя, используя доступные функции. Отвечай максимально коротко.';
      } else {
        executionMode = 'pro';
      }
    } else {
      executionMode = 'pro';
    }
  } else {
    executionMode = 'pro';
  }

  const currentMessages: any[] = [
    { role: 'system', content: executionSystemPrompt },
    ...executionHistory,
    { role: 'user', content: text }
  ];

  let answer = FALLBACK_ANSWER;
  let totalTokens = 0;
  let usedModel = '';
  let usedProvider = '';
  let loop = 0;
  const toolOutputsForFallback: string[] = [];

  while (loop < MAX_TOOL_LOOPS) {
    loop += 1;
    const completion = await runCompletion(executionMode, { messages: currentMessages, tools: executionTools, tool_choice: 'auto', thinking: { type: executionMode === 'lite' ? 'disabled' : 'enabled' }, clear_thinking: false });
    if (DEBUG_AI_RAW_MAIN_RESPONSE) {
      try {
        console.log('[DEBUG_AI_RAW_MAIN_RESPONSE]', JSON.stringify(completion.response, null, 2));
      } catch (err) {
        console.warn('[DEBUG_AI_RAW_MAIN_RESPONSE] serialization failed:', err);
      }
    }
    if (DEBUG_AI_RAW_LITE_RESPONSE && completion.usedProvider.startsWith('lite-')) {
      try {
        console.log('[DEBUG_AI_RAW_LITE_RESPONSE][chat]', JSON.stringify(completion.response, null, 2));
      } catch (err) {
        console.warn('[DEBUG_AI_RAW_LITE_RESPONSE][chat] serialization failed:', err);
      }
    }
    if ((completion.failedProviders?.length || 0) > 0 || (completion.failedModels?.length || 0) > 0) {
      console.warn(
        `[${completion.usedProvider.startsWith('lite-') ? 'LITE main fallback' : 'PRO main fallback'}] providers_failed=${completion.failedProviders?.join(',') || '-'} models_failed=${completion.failedModels?.join(',') || '-'} used=${completion.usedProvider}/${completion.usedModel}`
      );
    }
    usedModel = completion.usedModel;
    usedProvider = completion.usedProvider;
    const response = completion.response;
    totalTokens += extractTokens(response);
    const message = response?.choices?.[0]?.message || {};
    currentMessages.push(message);

    if (!message.tool_calls?.length) {
      const content = `${message.content || ''}`.trim();
      if (content) answer = content;
      else if (toolOutputsForFallback.length) answer = toolOutputsForFallback[toolOutputsForFallback.length - 1] || FALLBACK_ANSWER;
      break;
    }

    for (const toolCall of message.tool_calls) {
      if (toolCall.type !== 'function') continue;
      const toolName = `${toolCall.function?.name || ''}`;
      let toolContent = '';
      try {
        toolContent = await runTool(user, timezone, toolName, toolCall.function?.arguments || '{}', (payload) => runCompletion('pro', payload));
        if (toolContent === '__ESCALATE_TO_PRO__') {
          executionMode = 'pro';
          toolContent = 'Эскалация на PRO-модель выполнена.';
        }
      } catch (err: any) {
        toolContent = `Ошибка инструмента ${toolName}: ${err?.message || String(err)}`;
      }
      currentMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolContent });
      if (toolContent.trim()) toolOutputsForFallback.push(toolContent.trim());
    }
  }

  const userTextForHistory = options?.persistUserText?.trim() || text;
  if (!options?.skipHistory) {
    appendChatMessage(userId, chatId, 'user', userTextForHistory);
  }
  const assistantMessageId = options?.skipHistory ? 0 : appendChatMessage(userId, chatId, 'assistant', answer);

  const safeTokens = Math.max(0, Math.floor(totalTokens));
  const costRub = toRubFromTokens(safeTokens);
  const countAsUserMessage = options?.countAsUserMessage !== false;
  if (countAsUserMessage) {
    db.prepare(`
    UPDATE users
    SET daily_tokens_used = COALESCE(daily_tokens_used, 0) + ?,
        total_tokens_used = COALESCE(total_tokens_used, 0) + ?,
        daily_message_count = COALESCE(daily_message_count, 0) + 1,
        daily_cost_rub = COALESCE(daily_cost_rub, 0) + ?,
        total_cost_rub = COALESCE(total_cost_rub, 0) + ?
    WHERE id = ?
  `).run(safeTokens, safeTokens, costRub, costRub, userId);
  } else {
    db.prepare(`
      UPDATE users
      SET daily_tokens_used = COALESCE(daily_tokens_used, 0) + ?,
          total_tokens_used = COALESCE(total_tokens_used, 0) + ?,
          daily_cost_rub = COALESCE(daily_cost_rub, 0) + ?,
          total_cost_rub = COALESCE(total_cost_rub, 0) + ?
      WHERE id = ?
    `).run(safeTokens, safeTokens, costRub, costRub, userId);
  }

  return {
    reply_text: answer,
    chat_id: chatId,
    message_id: assistantMessageId,
    usage: {
      tokens_used: totalTokens,
      used_model: usedModel,
      used_provider: usedProvider
    }
  };
};
