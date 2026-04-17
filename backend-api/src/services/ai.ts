import OpenAI from 'openai';
import dotenv from 'dotenv';
import { tavily } from '@tavily/core';
import type { AiSendResult, TaskNotifyMode, TaskRecurrenceType, TaskType, UserPlan, UserRecord } from '../types.js';
import { appendChatMessage, ensureActiveChat, getHistoryForAi, getPromptForUser, getUserById, resolveEffectiveContextWindow, setUserTimezone, trimUserHistoryByChat } from './chats.js';
import { createNote, deleteNote, getNoteById, listNotes } from './notes.js';
import { createTask, deletePendingTask, getPendingTaskCount, listTasks } from './tasks.js';
import { runSmartHomeControl, type SmartHomeArgs, SMART_HOME_DEVICE_OPTIONS_TEXT } from './smart-home.js';
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
  baseURLUsed?: string;
  failedModels?: string[];
  failedProviders?: string[];
};

type SetTimezoneArgs = {
  timezone_offset?: number;
  location?: string;
  city?: string;
  country?: string;
};

const PRO_MODEL_CHAIN = parseModelChain(process.env.TIMEWEB_MODEL, ['gemini-3.1-flash-lite-preview']);
const PRO_CLIENT = new OpenAI({
  apiKey: process.env.TIMEWEB_API_KEY,
  baseURL: process.env.TIMEWEB_BASE_URL
});

const parseLiteProviders = (): LiteProvider[] => {
  const defaultBase = (process.env.TIMEWEB_LITE_BASE_URL || process.env.TIMEWEB_BASE_URL || '').trim();
  const defaultKey = (process.env.TIMEWEB_LITE_API_KEY || process.env.TIMEWEB_API_KEY || '').trim();
  const defaultModels = parseModelChain(process.env.TIMEWEB_LITE_MODEL, ['gemini-2.5-flash-lite']);
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
        baseURLUsed: provider.baseURL,
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
  return `\n\n[СИСТЕМНАЯ ИНФОРМАЦИЯ]\nТекущее Unix-время (в секундах): ${Math.floor(now.getTime() / 1000)}.\nЛокальное время пользователя: ${localTime.toISOString().replace('T', ' ').slice(0, 19)} (UTC${sign}${timezoneOffset}). При планировании задач используй local_time (HH:MM) или delay_seconds.`;
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

const clampTimezoneOffset = (offset: number) => {
  if (!Number.isFinite(offset)) return null;
  const rounded = Math.round(offset);
  if (rounded < -12 || rounded > 14) return null;
  return rounded;
};

const parseUtcOffsetFromText = (raw: string) => {
  const text = raw.trim().toLowerCase();
  const utcMatch = text.match(/utc\s*([+-]\s*\d{1,2})/i);
  if (utcMatch) {
    const value = Number.parseInt(utcMatch[1].replace(/\s+/g, ''), 10);
    return clampTimezoneOffset(value);
  }

  const gmtMatch = text.match(/gmt\s*([+-]\s*\d{1,2})/i);
  if (gmtMatch) {
    const value = Number.parseInt(gmtMatch[1].replace(/\s+/g, ''), 10);
    return clampTimezoneOffset(value);
  }

  return null;
};

const estimateOffsetByLongitude = (longitude: number) => {
  const estimated = Math.round(longitude / 15);
  if (estimated < -12) return -12;
  if (estimated > 14) return 14;
  return estimated;
};

const resolveOffsetFromLocationText = async (locationText: string) => {
  const inlineOffset = parseUtcOffsetFromText(locationText);
  if (inlineOffset !== null) return inlineOffset;

  try {
    const endpoint = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(locationText)}`;
    const response = await fetch(endpoint, {
      headers: { 'User-Agent': 'chatter-bot/1.0 (timezone resolver)' }
    });
    if (!response.ok) return null;
    const data = await response.json() as Array<{ lon?: string }>;
    const lon = Number.parseFloat(data?.[0]?.lon ?? '');
    if (!Number.isFinite(lon)) return null;
    return estimateOffsetByLongitude(lon);
  } catch {
    return null;
  }
};

const runSetUserTimezone = async (userId: number, args: SetTimezoneArgs) => {
  let resolvedOffset: number | null = null;

  if (typeof args.timezone_offset === 'number') {
    resolvedOffset = clampTimezoneOffset(args.timezone_offset);
  }

  if (resolvedOffset === null) {
    const locationText = [
      args.location?.trim(),
      args.city?.trim(),
      args.country?.trim()
    ].filter(Boolean).join(', ');

    if (locationText) {
      resolvedOffset = await resolveOffsetFromLocationText(locationText);
    }
  }

  if (resolvedOffset === null) {
    return 'Не удалось определить часовой пояс. Попроси пользователя указать смещение явно, например: UTC+7.';
  }

  setUserTimezone(userId, resolvedOffset);
  const sign = resolvedOffset >= 0 ? '+' : '';
  return `Часовой пояс пользователя установлен: UTC${sign}${resolvedOffset}.`;
};

const ALLOWED_DICE_SIDES = new Set([4, 6, 8, 10, 12, 20, 100]);
const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

const parseDiceNotation = (input: string) => {
  const normalized = input.replace(/\s+/g, '').toLowerCase().replace('д', 'd');
  const match = normalized.match(/^(\d{1,3})d(4|6|8|10|12|20|100)([+-]\d{1,4})?$/);
  if (!match) return null;
  const count = Number.parseInt(match[1], 10);
  const sides = Number.parseInt(match[2], 10);
  const modifier = match[3] ? Number.parseInt(match[3], 10) : 0;
  if (!Number.isFinite(count) || count <= 0 || count > 100) return null;
  if (!ALLOWED_DICE_SIDES.has(sides)) return null;
  if (!Number.isFinite(modifier) || Math.abs(modifier) > 10000) return null;
  return { count, sides, modifier, normalized };
};
const rollDiceExpression = (count: number, sides: number, modifier: number) => {
  const rolls = Array.from({ length: count }, () => randomInt(1, sides));
  const rollsSum = rolls.reduce((acc, value) => acc + value, 0);
  const total = rollsSum + modifier;
  return { rolls, rollsSum, modifier, total };
};

const formatRollLine = (roll: { rolls: number[]; rollsSum: number; modifier: number; total: number }) => {
  const modifierText = roll.modifier === 0 ? '' : roll.modifier > 0 ? ` + ${roll.modifier}` : ` - ${Math.abs(roll.modifier)}`;
  return `броски [${roll.rolls.join(', ')}] => ${roll.rollsSum}${modifierText} = ${roll.total}`;
};

const runRandomRoll = (parsed: Record<string, any>) => {
  const rollType = `${parsed.roll_type || ''}`;
  if (rollType !== 'coin' && rollType !== 'dice') return 'Ошибка инструмента: roll_type должен быть coin или dice.';
  if (rollType === 'coin') return `Монетка: ${Math.random() < 0.5 ? 'Орёл' : 'Решка'}.`;

  const parsedDice = parseDiceNotation(`${parsed.dice_notation || ''}`);
  if (!parsedDice) return 'Ошибка инструмента: некорректная нотация кубиков. Пример: 2d20+5.';

  const mode = parsed.mode && ['normal', 'advantage', 'disadvantage'].includes(parsed.mode)
    ? parsed.mode
    : 'normal';

  if (mode === 'normal') {
    const roll = rollDiceExpression(parsedDice.count, parsedDice.sides, parsedDice.modifier);
    return `Кубики ${parsedDice.normalized}: ${formatRollLine(roll)}.`;
  }

  const first = rollDiceExpression(parsedDice.count, parsedDice.sides, parsedDice.modifier);
  const second = rollDiceExpression(parsedDice.count, parsedDice.sides, parsedDice.modifier);
  const pickMax = mode === 'advantage';
  const chosen = pickMax
    ? (first.total >= second.total ? first : second)
    : (first.total <= second.total ? first : second);
  const modeText = pickMax ? 'преимущество' : 'помеха';
  return `Кубики ${parsedDice.normalized} (${modeText}):\n1) ${formatRollLine(first)}\n2) ${formatRollLine(second)}\nИтог: ${chosen.total}.`;
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

const runWebSearch = async (query: string) => {
  if (!tvly) return 'Ошибка инструмента: поисковый сервис временно недоступен.';

  try {
    const response = await tvly.search(query, {
      searchDepth: 'basic',
      maxResults: 3,
      includeAnswer: true
    });

    if (!response.results.length) {
      return `По запросу "${query}" ничего не найдено.`;
    }

    let resultText = response.answer ? `Сводка: ${response.answer}\n\n` : '';
    resultText += response.results.map((item: any, index: number) => `${index + 1}. ${item.title}\n${item.content}\nИсточник: ${item.url}`).join('\n\n');
    return resultText;
  } catch {
    return 'Ошибка инструмента: поисковый сервис временно недоступен.';
  }
};

const formatTasksList = (tasks: ReturnType<typeof listTasks>, timezoneOffset: number, emptyText = 'Задач не найдено.') => {
  if (!tasks.length) return emptyText;
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
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: 'Поиск актуальной/проверяемой информации в интернете. Используй, когда нужны свежие данные или факты из сети. После вызова опирайся на результаты поиска в ответе.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Поисковый запрос' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_webpage',
      description: 'Читает и очищает текст веб-страницы через backend-читалку (Browserless). Используй, когда нужно извлечь содержание конкретной страницы по URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Полный URL страницы (http/https).' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'control_smart_home',
      description: 'Управляет устройствами умного дома. Используй ТОЛЬКО при явной просьбе включить/выключить устройство или изменить цвет/яркость.',
      parameters: {
        type: 'object',
        properties: {
          device_name: {
            type: 'string',
            description: `Название устройства. Доступные варианты: ${SMART_HOME_DEVICE_OPTIONS_TEXT}.`
          },
          action: {
            type: 'string',
            enum: ['on', 'off', 'set_color', 'set_brightness'],
            description: 'on - включить, off - выключить, set_color - изменить цвет, set_brightness - изменить яркость.'
          },
          color: {
            type: 'string',
            description: 'Цвет в формате #RRGGBB или имя цвета (красный, синий и т.д.). Только для set_color.'
          },
          brightness: {
            type: 'number',
            description: 'Уровень яркости от 1 до 100. Используется только с action=set_brightness.'
          }
        },
        required: ['device_name', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'schedule_task',
      description: 'Создает задачу по времени (одноразовую или по расписанию): напоминания, отложенные команды дома, запланированный веб-поиск, регулярная проверка почты. Для времени предпочитай local_time (HH:MM) или delay_seconds, не вычисляй Unix timestamp вручную.',
      parameters: {
        type: 'object',
        properties: {
          local_time: { type: 'string', description: 'Локальное время пользователя в формате HH:MM, например 02:07.' },
          delay_seconds: { type: 'number', description: 'Задержка в секундах от текущего момента, например 60.' },
          execute_at: { type: 'number', description: 'Legacy-поле: Unix timestamp в секундах. Используй только если local_time/delay_seconds не подходят.' },
          task_type: { type: 'string', enum: ['message', 'smart_home', 'web_search', 'email_check', 'ai_instruction'], description: 'message - напоминание, smart_home - команда умного дома, web_search - запланированный поиск в интернете, email_check - запланированная проверка почты, ai_instruction - запуск AI-инструкции по расписанию.' },
          payload: { type: 'string', description: 'Для message: текст. Для smart_home: JSON-строка с параметрами умного дома. Для web_search: поисковый запрос. Для email_check: JSON-строка {"provider":"yandex|google","search_query":"...", "limit":10, "offset":10, "date_from":"2026-04-01","date_to":"2026-04-30"} или просто строка запроса. Для ai_instruction: текст инструкции, которую AI выполнит по расписанию.' },
          recurrence_type: { type: 'string', enum: ['once', 'daily', 'weekly'], description: 'Тип расписания: once - один раз, daily - каждый день, weekly - каждую неделю.' },
          recurrence_weekday: { type: 'number', description: 'День недели для weekly: 1=понедельник ... 7=воскресенье.' },
          notify_mode: { type: 'string', enum: ['always', 'never', 'on_match', 'on_condition'], description: 'Режим уведомлений: always - всегда писать о результате, never - никогда не писать, on_match - писать только если результат содержит notify_condition как подстроку, on_condition - ИИ проверит условие notify_condition и решит, отправлять уведомление или нет.' },
          notify_condition: { type: 'string', description: 'Условие для notify_mode=on_match/on_condition. Для on_match: короткая строка/ключевое слово. Для on_condition: осмысленное условие ("есть важные письма от X", "найдены тревожные новости", и т.д.).' }
        },
        required: ['task_type', 'payload']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_user_timezone',
      description: 'Устанавливает часовой пояс пользователя. Передай timezone_offset напрямую или location/city/country для автоопределения по локации.',
      parameters: {
        type: 'object',
        properties: {
          timezone_offset: { type: 'number', description: 'Смещение от UTC (целое число от -12 до +14). Если известно — передай его.' },
          location: { type: 'string', description: 'Локация в свободной форме, например: "Город, Страна".' },
          city: { type: 'string', description: 'Город пользователя, если отдельно.' },
          country: { type: 'string', description: 'Страна пользователя, если отдельно.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_my_tasks',
      description: 'Возвращает список задач текущего пользователя. Никогда не запрашивай задачи другого пользователя.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'done', 'error', 'all'], description: 'Фильтр по статусу задач.' },
          limit: { type: 'number', description: 'Сколько задач вернуть, от 1 до 50.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_my_task',
      description: 'Удаляет ОДНУ активную задачу текущего пользователя по точному ID (для отмены конкретного напоминания/задачи) и возвращает обновлённый список.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'number', description: 'ID задачи для удаления.' }
        },
        required: ['task_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_emails',
      description: 'Ищет письма в почте пользователя: последние входящие, поиск по отправителю/теме/ключевому слову, фильтр по датам, пагинация. Если пользователь явно указывает yandex/google — передавай provider.',
      parameters: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: ['yandex', 'google'], description: 'Какой ящик использовать.' },
          search_query: { type: 'string', description: 'Поисковая строка (имя, домен, тема, ключевое слово).' },
          date_from: { type: 'string', description: 'Начальная дата (включительно) в формате YYYY-MM-DD.' },
          date_to: { type: 'string', description: 'Конечная дата (включительно) в формате YYYY-MM-DD.' },
          limit: { type: 'number', description: 'Количество результатов. Если не указано, берётся пользовательский лимит из настроек почты.' },
          offset: { type: 'number', description: 'Сдвиг для пагинации. Пример: сначала offset=0, потом offset=10 для следующих 10 писем.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_email_content',
      description: 'Читает содержимое конкретного письма по части темы. Обычно используй после check_emails, когда нужно открыть найденное письмо.',
      parameters: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: ['yandex', 'google'], description: 'Какой ящик использовать.' },
          subject_part: { type: 'string', description: 'Часть темы письма для поиска.' }
        },
        required: ['subject_part']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'send_email',
      description: 'Отправляет письмо от имени пользователя. Используй, когда пользователь явно просит отправить email. Если пользователь явно указывает yandex/google — передавай provider.',
      parameters: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: ['yandex', 'google'], description: 'Какой ящик использовать.' },
          to: { type: 'string', description: 'Email получателя.' },
          subject: { type: 'string', description: 'Тема письма.' },
          body: { type: 'string', description: 'Текст письма. Можно передавать HTML-разметку (<b>, <h1>, <ul>, <a> и т.д.) для красивого письма.' }
        },
        required: ['to', 'subject', 'body']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_note',
      description: 'Сохраняет запись в личную записную книжку пользователя. Используй, когда пользователь просит "запиши"/"сохрани в заметки". Это заметки, а не долговременная память.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Короткий заголовок заметки (необязательно).' },
          content: { type: 'string', description: 'Текст заметки, который нужно сохранить.' }
        },
        required: ['content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_my_notes',
      description: 'Показывает заметки пользователя из записной книжки. Поддерживает поиск и пагинацию.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Поисковая строка по заголовку и тексту.' },
          limit: { type: 'number', description: 'Сколько заметок вернуть за запрос (1..50).' },
          offset: { type: 'number', description: 'Сдвиг для пагинации. Пример: 0, затем 10.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_note',
      description: 'Читает одну заметку пользователя целиком по точному ID.',
      parameters: {
        type: 'object',
        properties: {
          note_id: { type: 'number', description: 'ID заметки.' }
        },
        required: ['note_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_note',
      description: 'Удаляет одну заметку пользователя по точному ID и возвращает обновлённый список.',
      parameters: {
        type: 'object',
        properties: {
          note_id: { type: 'number', description: 'ID заметки для удаления.' }
        },
        required: ['note_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_core_memory',
      description: 'Критически важная долговременная память о пользователе. Используй ТОЛЬКО для важных биографических фактов (возраст, профессия, семья, переезд, устойчивые долгосрочные предпочтения). Не используй для рутины или одноразовых событий. Для записей в блокнот используй save_note.',
      parameters: {
        type: 'object',
        properties: {
          new_fact: { type: 'string', description: 'Новый важный факт о пользователе, кратко и конкретно.' },
          explicit_request: { type: 'boolean', description: 'true, если пользователь явно попросил "запомни".' }
        },
        required: ['new_fact']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'random_roll',
      description: 'Случайный бросок: монетка или кубики (d4,d6,d8,d10,d12,d20,d100). Используй для запросов "подбрось монетку/брось кубик/случайный результат". Для кубиков поддерживает обычный режим, преимущество и помеху.',
      parameters: {
        type: 'object',
        properties: {
          roll_type: { type: 'string', enum: ['coin', 'dice'], description: 'coin - монетка, dice - кубики.' },
          dice_notation: { type: 'string', description: 'Нотация кубиков, например: 1d20, 2d6+3, 2д20 + 5.' },
          mode: { type: 'string', enum: ['normal', 'advantage', 'disadvantage'], description: 'Режим для dice: обычный, с преимуществом, с помехой.' }
        },
        required: ['roll_type']
      }
    }
  }
] as const;
const LITE_ROUTER_INSTRUCTIONS = `
Ты — быстрый ассистент-диспетчер.
Твоя главная задача: управление устройствами, быстрый web-поиск, установка часового пояса, случайные броски и короткие бытовые ответы.

ПРАВИЛО ЭСКАЛАЦИИ:
если запрос сложный (творчество, глубокий анализ, длинная структурированная расшифровка, программирование, большой текст, почта, заметки, память, планирование, многошаговая задача),
ты ОБЯЗАН немедленно вызвать инструмент escalate_to_pro и передать исходный запрос пользователя в original_query.
`;

const ESCALATE_TO_PRO_TOOL = {
  type: 'function',
  function: {
    name: 'escalate_to_pro',
    description: 'Используй ТОЛЬКО если запрос требует глубокого анализа, творческого мышления, сложного структурирования, написания кода или длинного рассказа. Передай исходный запрос пользователя.',
    parameters: {
      type: 'object',
      properties: {
        original_query: {
          type: 'string',
          description: 'Изначальный запрос пользователя для передачи в старшую модель.'
        }
      },
      required: ['original_query']
    }
  }
} as const;

const buildLiteExecutionTools = (allowedToolNames: string[]) => {
  const allowed = new Set(allowedToolNames);
  const filtered = toolDefinitions.filter(t => allowed.has(`${(t as any)?.function?.name || ''}`)) as any[];
  return [...filtered, ESCALATE_TO_PRO_TOOL as any];
};
const runCompletion = async (mode: 'pro' | 'lite', requestPayload: Record<string, unknown>): Promise<CompletionMeta> => {
  if (mode === 'pro') {
    const res = await createCompletionWithModelFallback(PRO_CLIENT, PRO_MODEL_CHAIN, requestPayload);
    return {
      response: res.response,
      usedModel: res.modelUsed,
      usedProvider: 'pro-main',
      baseURLUsed: process.env.TIMEWEB_BASE_URL || '',
      failedModels: res.failedModels
    };
  }
  const res = await createCompletionWithLiteProviderFallback(requestPayload);
  return {
    response: res.response,
    usedModel: res.modelUsed,
    usedProvider: res.providerUsed,
    baseURLUsed: res.baseURLUsed,
    failedModels: res.failedModels,
    failedProviders: res.failedProviders
  };
};

const hasSchedulingIntent = (text: string) => /\b(напомн|напоминани|таймер|по\s+расписанию|отложи|позже|завтра|послезавтра|ежедневно|еженедельно|кажд(ый|ую|ое|ые)|every\s+day|every\s+week)\b/i.test(text)
  || /\bв\s*\d{1,2}:\d{2}\b/i.test(text)
  || /через\s+[^.,!?]{0,24}\b(секунд|секунду|секунды|сек|минут|минуту|минута|мин|час|часа|часов|ч|день|дня|дней|сутк|недел|месяц|месяца|месяцев)\b/i.test(text);

const getTaskByUserAndId = (userId: number, taskId: number) => db.prepare(`
  SELECT id, status
  FROM tasks
  WHERE user_id = ? AND id = ?
`).get(userId, taskId) as { id: number; status: string } | undefined;

const runTool = async (user: UserRecord, timezoneOffset: number, toolName: string, argsRaw: string, aiCall: (requestPayload: Record<string, unknown>) => Promise<CompletionMeta>) => {
  const parsed = JSON.parse(argsRaw || '{}');

  if (toolName === 'search_web') {
    const query = `${parsed.query || ''}`.trim();
    if (!query) return 'Ошибка инструмента: пустой поисковый запрос.';
    const webLimit = checkWebSearchLimit(user);
    if (!webLimit.allowed) return webLimit.reason;
    incrementUserWebSearchUsage(user.id, 1);
    return runWebSearch(query);
  }

  if (toolName === 'read_webpage') {
    const url = `${parsed.url || ''}`.trim();
    if (!url) return 'Ошибка инструмента: пустой URL.';
    try {
      return await getCleanTextFromUrl(url);
    } catch (err: any) {
      return `Ошибка инструмента read_webpage: ${err?.message || String(err)}`;
    }
  }

  if (toolName === 'control_smart_home') return runSmartHomeControl(user.id, parsed as SmartHomeArgs);
  if (toolName === 'set_user_timezone') return runSetUserTimezone(user.id, parsed as SetTimezoneArgs);
  if (toolName === 'random_roll') return runRandomRoll(parsed);
  if (toolName === 'save_note') return runSaveNoteTool(user, typeof parsed.content === 'string' ? parsed.content : '', typeof parsed.title === 'string' ? parsed.title : '');
  if (toolName === 'list_my_notes') return runListNotesTool(user.id, typeof parsed.query === 'string' ? parsed.query : '', Number(parsed.limit), Number(parsed.offset));
  if (toolName === 'read_note') return runReadNoteTool(user.id, Number(parsed.note_id));
  if (toolName === 'delete_note') return runDeleteNoteTool(user.id, Number(parsed.note_id));

  if (toolName === 'get_my_tasks') {
    const status = ['pending', 'done', 'error', 'all'].includes(`${parsed.status || ''}`) ? parsed.status : 'pending';
    const limit = Number.isFinite(Number(parsed.limit)) ? Number(parsed.limit) : 20;
    return formatTasksList(listTasks(user.id, limit, status), timezoneOffset, 'Задач не найдено.');
  }

  if (toolName === 'schedule_task') {
    if (user.timezone_confirmed !== 1) return 'Ошибка планирования: часовой пояс пользователя не настроен. Попроси пользователя назвать город/страну или указать UTC-смещение, затем вызови set_user_timezone.';

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

    if (getPendingTaskCount(user.id) >= MAX_PENDING_TASKS_PER_USER) {
      return `Лимит активных задач: ${MAX_PENDING_TASKS_PER_USER}. Удали лишние через delete_my_task или /task_delete <id>.`;
    }

    if (taskType === 'smart_home') payload = JSON.stringify(JSON.parse(payload) as SmartHomeArgs);

    const executeAt = computeExecuteAtFromScheduleArgs(parsed, timezoneOffset, recurrenceType, recurrenceWeekday);
    createTask(user.id, executeAt, taskType, payload, recurrenceType, recurrenceType === 'weekly' ? recurrenceWeekday : null, timezoneOffset, notifyMode, (notifyMode === 'on_match' || notifyMode === 'on_condition') ? notifyCondition : null);
    const planned = formatUnixForTimezone(executeAt, timezoneOffset);
    const notifyInfo = (notifyMode === 'on_match' || notifyMode === 'on_condition') ? `${notifyMode} (${notifyCondition})` : notifyMode;
    return `Успешно запланировано. Следующий запуск: ${planned.local} (${planned.tzLabel}). UTC-время: ${planned.utc}. Тип расписания: ${recurrenceType}. Режим уведомлений: ${notifyInfo}.`;
  }

  if (toolName === 'delete_my_task') {
    const taskId = Number(parsed.task_id);
    if (!Number.isFinite(taskId) || taskId <= 0) return 'Ошибка: Некорректный task_id';

    const normalizedTaskId = Math.floor(taskId);
    const task = getTaskByUserAndId(user.id, normalizedTaskId);
    if (!task) return `Ошибка инструмента delete_my_task: Задача #${normalizedTaskId} не найдена.`;
    if (task.status !== 'pending') return `Ошибка инструмента delete_my_task: Задача #${normalizedTaskId} уже не активна (status: ${task.status}).`;

    const ok = deletePendingTask(user.id, normalizedTaskId);
    if (!ok) return `Ошибка инструмента delete_my_task: Не удалось удалить задачу #${normalizedTaskId}.`;

    const updated = listTasks(user.id, 20, 'pending');
    return `Задача #${normalizedTaskId} удалена.\n\nОбновлённый список активных задач (${updated.length}/${MAX_PENDING_TASKS_PER_USER}):\n${formatTasksList(updated, timezoneOffset, 'Активных задач больше нет.')}`;
  }

  if (toolName === 'check_emails') {
    const limit = Number.isFinite(Number(parsed.limit)) ? Number(parsed.limit) : 5;
    return runEmailCheck(user.id, typeof parsed.search_query === 'string' ? parsed.search_query : '', limit, typeof parsed.provider === 'string' ? parsed.provider : '', Number.isFinite(Number(parsed.offset)) ? Number(parsed.offset) : 0, typeof parsed.date_from === 'string' ? parsed.date_from : '', typeof parsed.date_to === 'string' ? parsed.date_to : '');
  }

  if (toolName === 'read_email_content') return runEmailRead(user.id, typeof parsed.subject_part === 'string' ? parsed.subject_part : '', typeof parsed.provider === 'string' ? parsed.provider : '');
  if (toolName === 'send_email') return runEmailSend(user.id, typeof parsed.to === 'string' ? parsed.to : '', typeof parsed.subject === 'string' ? parsed.subject : '', typeof parsed.body === 'string' ? parsed.body : '', typeof parsed.provider === 'string' ? parsed.provider : '');
  if (toolName === 'update_core_memory') return runCoreMemoryMerge(aiCall, user.id, typeof parsed.new_fact === 'string' ? parsed.new_fact : '', Boolean(parsed.explicit_request));

  return `Ошибка: неизвестный инструмент ${toolName}`;
};

const getToolUserMessage = (toolName: string, argsRaw: string) => {
  if (toolName === 'search_web') return 'Ищу информацию в сети...';
  if (toolName === 'read_webpage') return 'Открываю страницу и извлекаю текст...';
  if (toolName === 'control_smart_home') return '🏠 Выполняю команду умного дома...';
  if (toolName === 'random_roll') {
    try {
      const parsed = JSON.parse(argsRaw || '{}');
      const target = parsed.roll_type === 'coin'
        ? 'монетку'
        : parsed.dice_notation
          ? `кубики ${parsed.dice_notation}`
          : 'кубики';
      return `Подкидываем ${target}...`;
    } catch {
      return 'Подкидываем кубики...';
    }
  }
  return null;
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
    userTelegramChatId?: number | null;
    userTelegramMessageId?: number | null;
    assistantTelegramChatId?: number | null;
  }
): Promise<AiSendResult> => {
  const user = getUserById(userId);
  if (!user) throw new Error('user_not_found');
  if (user.status !== 'approved' && user.is_admin !== 1) throw new Error('user_not_approved');

  let text = (inputText || '').trim();
  if (!text) throw new Error('empty_text');
  const forceProRoute = Boolean(options?.forcePro) || text.startsWith('!!!');
  if (forceProRoute && !options?.forcePro) {
    text = text.replace(/^!{3,}/, '').trim();
    if (!text) throw new Error('empty_text');
  }

  const dailyLimit = normalizeDailyMessageLimit(user.daily_message_limit);
  const dailyCount = Math.max(0, Math.floor(Number(user.daily_message_count || 0)));
  if (!options?.ignoreDailyLimit && user.is_admin !== 1 && dailyLimit > 0 && dailyCount >= dailyLimit) throw new Error('daily_message_limit_reached');

  const chatId = targetChatId && Number.isFinite(targetChatId) ? targetChatId : ensureActiveChat(userId);
  const contextWindow = resolveEffectiveContextWindow(user);
  const history = getHistoryForAi(userId, chatId, contextWindow);
  const timezone = Number.isFinite(Number(user.timezone_offset)) ? Number(user.timezone_offset) : 5;
  const baseSystemPrompt = `${buildSystemPrompt(getPromptForUser(user), user.name || user.tg_username || 'Пользователь', user.core_memory || '')}${buildTimeContext(timezone)}`;

  let executionMode: 'pro' | 'lite' = 'pro';
  let executionTools: any[] = [...toolDefinitions] as any[];
  let executionHistory = history;
  let executionSystemPrompt = baseSystemPrompt;
  let totalTokens = 0;

if (!forceProRoute) {
  const routerPrompt = `Ты — маршрутизатор запросов. Твоя цель — определить категорию запроса. ВСЁ, что не укладывается в тип запроса, или он выбивается из твоих доступных категорий, перенаправляй в PRO. Даже если это ругань или простая беседа.
Верни ТОЛЬКО ОДНО СЛОВО из списка ниже.

[ПРОСТЫЕ КАТЕГОРИИ - не требуют истории чата]:
- SMART_HOME (управление светом, розетками)
- QUICK_SEARCH (узнать погоду, курс валют, быстрый факт из сети)
- TIMEZONE (установить часовой пояс)
- RANDOM (бросить кубик, монетку)

[СЛОЖНАЯ КАТЕГОРИЯ]:
- PRO (любой сложный вопрос, любая простая беседа, программирование, анализ, почта (email), расписания, работа с памятью, заметки/блокнот, длинные беседы)

[ПРИМЕРЫ СТРОГОГО ВЫВОДА]:
Запрос: Включи свет на кухне
SMART_HOME
Запрос: Подбрось монетку
RANDOM
Запрос: Включи свет через 10 минут
PRO
Запрос: Да пошел ты
PRO
Запрос: Как дела?
PRO
Запрос: Напиши код на TS
PRO

ВАЖНО: если в запросе есть отложенное/регулярное действие по времени ("через ...", "завтра", "в 10:30", "напомни", "каждый день"), выбирай ТОЛЬКО PRO, даже если там есть погода/поиск.

Запрос пользователя: "${text}"`;

  type CheapRoute = 'SMART_HOME' | 'QUICK_SEARCH' | 'TIMEZONE' | 'RANDOM' | 'PRO';

  const cheapMap: Record<Exclude<CheapRoute, 'PRO'>, string[]> = {
    SMART_HOME: ['control_smart_home'],
    QUICK_SEARCH: ['search_web'],
    TIMEZONE: ['set_user_timezone'],
    RANDOM: ['random_roll']
  };

  let routeLabel: CheapRoute = 'PRO';

  if (!hasSchedulingIntent(text)) {
    try {
      const routed = await runCompletion('lite', {
        messages: [{ role: 'user', content: routerPrompt }],
        temperature: 0,
        max_tokens: 8,
        thinking: { type: 'disabled' }
      });

      totalTokens += extractTokens(routed.response);

      if (DEBUG_AI_RAW_LITE_RESPONSE) {
        try {
          console.log('[DEBUG_AI_RAW_LITE_RESPONSE][router]', JSON.stringify(routed.response, null, 2));
        } catch (err) {
          console.warn('[DEBUG_AI_RAW_LITE_RESPONSE][router] serialization failed:', err);
        }
      }

      if ((routed.failedProviders?.length || 0) > 0 || (routed.failedModels?.length || 0) > 0) {
        console.warn(
          `[LITE router fallback] providers_failed=${routed.failedProviders?.join(',') || '-'} models_failed=${routed.failedModels?.join(',') || '-'} used=${routed.usedProvider}/${routed.usedModel} (${routed.baseURLUsed || '-'})`
        );
      }

      const rawRoute = `${routed.response?.choices?.[0]?.message?.content || ''}`.toUpperCase();
      const matchedRoute = rawRoute.match(/\b(SMART_HOME|QUICK_SEARCH|TIMEZONE|RANDOM|PRO)\b/);

      if (
        matchedRoute?.[1] === 'SMART_HOME'
        || matchedRoute?.[1] === 'QUICK_SEARCH'
        || matchedRoute?.[1] === 'TIMEZONE'
        || matchedRoute?.[1] === 'RANDOM'
        || matchedRoute?.[1] === 'PRO'
      ) {
        routeLabel = matchedRoute[1];
      }
    } catch {
      routeLabel = 'PRO';
    }
  }

  if (routeLabel !== 'PRO') {
    const allowedToolNames = cheapMap[routeLabel];

    if (allowedToolNames.length) {
      executionTools = buildLiteExecutionTools(allowedToolNames);
      executionHistory = [];
      executionSystemPrompt = `${LITE_ROUTER_INSTRUCTIONS}${buildTimeContext(timezone)}`;
      executionMode = 'lite';
    }
  }
}

  const currentMessages: any[] = [
    { role: 'system', content: executionSystemPrompt },
    ...executionHistory,
    { role: 'user', content: text }
  ];

  let answer = FALLBACK_ANSWER;
  let usedModel = '';
  let usedProvider = '';
  let loop = 0;
  const toolOutputsForFallback: string[] = [];
  const toolUserMessages: string[] = [];
  let modelFallbackNotice: string | null = null;
  let modelFallbackNoticeSent = false;

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
        `[${completion.usedProvider.startsWith('lite-') ? 'LITE main fallback' : 'PRO main fallback'}] providers_failed=${completion.failedProviders?.join(',') || '-'} models_failed=${completion.failedModels?.join(',') || '-'} used=${completion.usedProvider}/${completion.usedModel} (${completion.baseURLUsed || '-'})`
      );
    }
    if (!modelFallbackNoticeSent && executionMode === 'pro' && (completion.failedModels?.length || 0) > 0) {
      modelFallbackNoticeSent = true;
      modelFallbackNotice = `⚙️ Модель(и) ${completion.failedModels?.join(', ')} были недоступны. Ответ получен от ${completion.usedModel}.`;
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

let escalatedToPro = false;

for (const toolCall of message.tool_calls) {
  if (toolCall.type !== 'function') continue;

  const toolName = `${toolCall.function?.name || ''}`;

  if (toolName === 'escalate_to_pro') {
    let originalQuery = text;

    try {
      const parsed = JSON.parse(toolCall.function?.arguments || '{}');
      if (typeof parsed.original_query === 'string' && parsed.original_query.trim()) {
        originalQuery = parsed.original_query.trim();
      }
    } catch {
      // ignore
    }

    executionMode = 'pro';
    executionTools = [...toolDefinitions] as any[];
    currentMessages.length = 0;
    currentMessages.push(
      { role: 'system', content: baseSystemPrompt },
      ...history,
      { role: 'user', content: originalQuery }
    );

    escalatedToPro = true;
    break;
  }

  const toolUserMessage = getToolUserMessage(toolName, toolCall.function?.arguments || '{}');
  if (toolUserMessage) toolUserMessages.push(toolUserMessage);

  let toolContent = '';
  try {
    toolContent = await runTool(
      user,
      timezone,
      toolName,
      toolCall.function?.arguments || '{}',
      (payload) => runCompletion('pro', payload)
    );
  } catch (err: any) {
    toolContent = `Ошибка инструмента ${toolName}: ${err?.message || String(err)}`;
  }

  currentMessages.push({
    role: 'tool',
    tool_call_id: toolCall.id,
    content: toolContent
  });

  if (toolContent.trim()) {
    toolOutputsForFallback.push(toolContent.trim());
  }
}

if (escalatedToPro) {
  continue;
}
  }

  const userTextForHistory = options?.persistUserText?.trim() || text;
  if (!options?.skipHistory) {
    const userTelegramChatId = Number.isFinite(Number(options?.userTelegramChatId))
      ? Math.floor(Number(options?.userTelegramChatId))
      : null;
    const userTelegramMessageId = Number.isFinite(Number(options?.userTelegramMessageId))
      ? Math.floor(Number(options?.userTelegramMessageId))
      : null;
    appendChatMessage(userId, chatId, 'user', userTextForHistory, userTelegramChatId, userTelegramMessageId);
  }
  const assistantTelegramChatId = Number.isFinite(Number(options?.assistantTelegramChatId))
    ? Math.floor(Number(options?.assistantTelegramChatId))
    : null;
  const assistantMessageId = options?.skipHistory
    ? 0
    : appendChatMessage(userId, chatId, 'assistant', answer, assistantTelegramChatId, null);

  const safeTokens = Math.max(0, Math.floor(totalTokens));
  const costRub = toRubFromTokens(safeTokens);
  const countAsUserMessage = options?.countAsUserMessage !== false;
  if (countAsUserMessage) {
    db.prepare(`
    UPDATE users
    SET daily_tokens_used = COALESCE(daily_tokens_used, 0) + ?,
        total_tokens_used = COALESCE(total_tokens_used, 0) + ?,
        daily_message_count = COALESCE(daily_message_count, 0) + 1,
        total_message_length = COALESCE(total_message_length, 0) + ?,
        daily_cost_rub = COALESCE(daily_cost_rub, 0) + ?,
        total_cost_rub = COALESCE(total_cost_rub, 0) + ?
    WHERE id = ?
  `).run(safeTokens, safeTokens, userTextForHistory.length, costRub, costRub, userId);
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

  trimUserHistoryByChat(userId, chatId, contextWindow);

  return {
    reply_text: answer,
    chat_id: chatId,
    message_id: assistantMessageId,
    model_fallback_notice: modelFallbackNotice,
    tool_user_messages: toolUserMessages,
    usage: {
      tokens_used: totalTokens,
      used_model: usedModel,
      used_provider: usedProvider
    }
  };
};
