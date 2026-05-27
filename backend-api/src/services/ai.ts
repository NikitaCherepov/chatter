import OpenAI from 'openai';
import dotenv from 'dotenv';
import { tavily } from '@tavily/core';
import type { AiSendResult, DesktopActionPayload, DisplayStatePayload, MapUpdatePayload, TaskNotifyMode, TaskRecurrenceType, TaskType, UserPlan, UserRecord } from '../types.js';
import { appendChatMessage, ensureActiveChat, getHistoryForAi, getUserById, resolveEffectiveContextWindow, setUserTimezone, trimUserHistoryByChat } from './chats.js';
import { resolvePromptForUser, COLD_MEMORY_PROMPT_HINT, AVATAR_PROMPT_HINT } from './prompts.js';
import { createNote, deleteNote, getNoteById, listNotes } from './notes.js';
import { createTask, deletePendingTask, getPendingTaskCount, listTasks } from './tasks.js';
import { listMapPinsForBot } from './map-pins.js';
import { runSmartHomeControl, type SmartHomeArgs, SMART_HOME_DEVICE_OPTIONS_TEXT } from './smart-home.js';
import { runEmailCheck, runEmailRead, runEmailSend } from './mail.js';
import { runCoreMemoryMerge } from './memory.js';
import { VectorMemoryService } from './vector-memory.js';
import { getCleanTextFromUrl } from './web-reader.js';
import { runImageGeneration } from './image-generation.js';
import { findTransitRoute, searchNearby } from './transit.js';
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

const parseProProviders = (): LiteProvider[] => {
  const defaultBase = (process.env.TIMEWEB_BASE_URL || '').trim();
  const defaultKey = (process.env.TIMEWEB_API_KEY || '').trim();
  const defaultModels = PRO_MODEL_CHAIN;
  const raw = (process.env.TIMEWEB_PRO_ENDPOINTS || '').trim();

  if (!raw) {
    if (!defaultBase || !defaultKey) return [];
    return [{
      name: 'pro-1',
      baseURL: defaultBase,
      client: PRO_CLIENT,
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
      name: `pro-${i + 1}`,
      baseURL: base,
      client: new OpenAI({ apiKey: key, baseURL: base }),
      modelChain: models
    });
  }
  return providers;
};

const PRO_PROVIDERS = parseProProviders();

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

const parseVisionProviders = (): { pro: LiteProvider[]; lite: LiteProvider[] } => {
  const proDefaultBase = (process.env.TIMEWEB_VISION_BASE_URL || process.env.TIMEWEB_BASE_URL || '').trim();
  const proDefaultKey = (process.env.TIMEWEB_VISION_API_KEY || process.env.TIMEWEB_API_KEY || '').trim();
  const proDefaultModels = parseModelChain(process.env.TIMEWEB_VISION_MODEL, [PRO_MODEL_CHAIN[0] || 'glm-4v']);

  const proProviders: LiteProvider[] = [];
  if (proDefaultBase && proDefaultKey) {
    proProviders.push({
      name: 'vision-pro-1',
      baseURL: proDefaultBase,
      client: new OpenAI({ apiKey: proDefaultKey, baseURL: proDefaultBase }),
      modelChain: proDefaultModels
    });
  }

  const liteDefaultBase = (process.env.TIMEWEB_LITE_VISION_BASE_URL || process.env.TIMEWEB_LITE_BASE_URL || process.env.TIMEWEB_VISION_BASE_URL || process.env.TIMEWEB_BASE_URL || '').trim();
  const liteDefaultKey = (process.env.TIMEWEB_LITE_VISION_API_KEY || process.env.TIMEWEB_LITE_API_KEY || process.env.TIMEWEB_VISION_API_KEY || process.env.TIMEWEB_API_KEY || '').trim();
  const liteDefaultModels = parseModelChain(process.env.TIMEWEB_LITE_VISION_MODEL, [...proDefaultModels, parseModelChain(process.env.TIMEWEB_LITE_MODEL, ['gemini-2.5-flash-lite'])[0] || 'glm-4v']);

  const liteProviders: LiteProvider[] = [];
  if (liteDefaultBase && liteDefaultKey) {
    liteProviders.push({
      name: 'vision-lite-1',
      baseURL: liteDefaultBase,
      client: new OpenAI({ apiKey: liteDefaultKey, baseURL: liteDefaultBase }),
      modelChain: liteDefaultModels
    });
  }

  return { pro: proProviders, lite: liteProviders };
};

const VISION_PROVIDERS = parseVisionProviders();

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

const getProviderErrorSummary = (err: any) => {
  const status = Number(err?.status || err?.response?.status || 0) || undefined;
  const code = `${err?.code || err?.error?.code || err?.response?.data?.error?.code || ''}`.trim() || undefined;
  const type = `${err?.type || err?.error?.type || err?.response?.data?.error?.type || ''}`.trim() || undefined;
  const message = `${err?.message || err?.error?.message || err?.response?.data?.error?.message || ''}`.trim() || undefined;
  const data = err?.response?.data;

  return {
    status,
    code,
    type,
    message,
    data: typeof data === 'object' && data ? JSON.stringify(data).slice(0, 1500) : undefined
  };
};

const createCompletionWithModelFallback = async (
  client: OpenAI,
  modelChain: string[],
  requestBody: Record<string, unknown>,
  providerName = 'default',
  baseURL = ''
) => {
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
        const summary = getProviderErrorSummary(err);
        console.warn('[ai] model failed', {
          provider: providerName,
          baseURL,
          model,
          attempt,
          attempts,
          retryable: isRetryable(err),
          ...summary
        });
        if (isRetryable(err) && attempt < attempts) {
          await sleep(RETRY_SECONDS * 1000);
          continue;
        }
        break;
      }
    }
    failedModels.push(model);
  }

  throw Object.assign(new Error('model_chain_failed'), {
    failedModels,
    cause: lastError,
    providerError: getProviderErrorSummary(lastError)
  });
};

const createCompletionWithProProviderFallback = async (requestBody: Record<string, unknown>) => {
  const failedProviders: string[] = [];
  const failedModels: string[] = [];

  for (const provider of PRO_PROVIDERS) {
    try {
      console.warn('[ai] trying pro provider', {
        provider: provider.name,
        baseURL: provider.baseURL,
        models: provider.modelChain
      });
      const completion = await createCompletionWithModelFallback(provider.client, provider.modelChain, requestBody, provider.name, provider.baseURL);
      if (completion.failedModels.length) {
        failedModels.push(...completion.failedModels.map(m => `${provider.name}:${m}`));
      }
      console.warn('[ai] pro provider succeeded', {
        provider: provider.name,
        baseURL: provider.baseURL,
        model: completion.modelUsed
      });
      return {
        response: completion.response,
        modelUsed: completion.modelUsed,
        providerUsed: provider.name,
        baseURLUsed: provider.baseURL,
        failedProviders,
        failedModels
      };
    } catch (err: any) {
      console.warn('[ai] pro provider failed', {
        provider: provider.name,
        baseURL: provider.baseURL,
        models: provider.modelChain,
        failedModels: Array.isArray(err?.failedModels) ? err.failedModels : [],
        providerError: err?.providerError
      });
      failedProviders.push(provider.name);
      if (Array.isArray(err?.failedModels)) {
        failedModels.push(...err.failedModels.map((m: string) => `${provider.name}:${m}`));
      }
    }
  }

  throw Object.assign(new Error('pro_providers_failed'), { failedProviders, failedModels });
};

const createCompletionWithLiteProviderFallback = async (requestBody: Record<string, unknown>) => {
  const failedProviders: string[] = [];
  const failedModels: string[] = [];

  for (const provider of LITE_PROVIDERS) {
    try {
      console.warn('[ai] trying lite provider', {
        provider: provider.name,
        baseURL: provider.baseURL,
        models: provider.modelChain
      });
      const completion = await createCompletionWithModelFallback(provider.client, provider.modelChain, requestBody, provider.name, provider.baseURL);
      if (completion.failedModels.length) {
        failedModels.push(...completion.failedModels.map(m => `${provider.name}:${m}`));
      }
      console.warn('[ai] lite provider succeeded', {
        provider: provider.name,
        baseURL: provider.baseURL,
        model: completion.modelUsed
      });
      return {
        response: completion.response,
        modelUsed: completion.modelUsed,
        providerUsed: provider.name,
        baseURLUsed: provider.baseURL,
        failedProviders,
        failedModels
      };
    } catch (err: any) {
      console.warn('[ai] lite provider failed', {
        provider: provider.name,
        baseURL: provider.baseURL,
        models: provider.modelChain,
        failedModels: Array.isArray(err?.failedModels) ? err.failedModels : [],
        providerError: err?.providerError
      });
      failedProviders.push(provider.name);
      if (Array.isArray(err?.failedModels)) {
        failedModels.push(...err.failedModels.map((m: string) => `${provider.name}:${m}`));
      }
    }
  }

  throw Object.assign(new Error('lite_providers_failed'), { failedProviders, failedModels });
};

const buildSystemPrompt = (prompt: string, userName: string, coreMemory: string) => {
  return `${prompt}\n\nИмя {{user}}: ${userName}\n\n[ПОСТОЯННЫЕ ЗНАНИЯ О ПОЛЬЗОВАТЕЛЕ]\n${(coreMemory || '').trim() || 'Пока пусто.'}${COLD_MEMORY_PROMPT_HINT}`;
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

export const toolDefinitions = [
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
      description: 'Статический профиль (паспорт) пользователя. Используй ТОЛЬКО для неизменных, сухих фактов: ФИО,, возраст, город проживания, работа/стек, состав семьи, статус отношений, друзья, здоровье, глобальные цели. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО сохранять сюда истории, сюжеты, переменчивые драмы или подробные детали отношений — для любых событий и "биографического лора" используй СТРОГО save_to_cold_memory.',
      parameters: {
        type: 'object',
        properties: {
          new_fact: { type: 'string', description: 'Новый анкетный факт, кратко.' },
          explicit_request: { type: 'boolean', description: 'true, если пользователь явно попросил "запомни".' }
        },
        required: ['new_fact']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_cold_memory',
      description: 'Поиск по векторному архиву. Обязателен при любых вопросах о прошлом.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Смысловой запрос для поиска.' },
          top_k: { type: 'number', description: 'Количество фрагментов (3-8, обычно 5).' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_to_cold_memory',
      description: 'Сохранение данных в архив. Используй для фиксации важных фактов, и идей.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Текст: плотный, без местоимений. Используй конкретные имена, названия и детали, чтобы текст был понятен сам по себе.' },
          source: { type: 'string', description: 'Специфичный заголовок/тег (напр. "D&D: Билд Локадина", "Прогулка и арест полицией с Катей"). Дата должна быть ВСЕГДА! Текущая или ту, которую указал {{user}}' }
        },
        required: ['text', 'source']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_from_cold_memory',
      description: 'Удаление записи по ID. Требует предварительного поиска ID.',
      parameters: {
        type: 'object',
        properties: {
          chunk_id: { type: 'string', description: 'Точный ID из результатов поиска (например: fact_123_chunk_0).' }
        },
        required: ['chunk_id']
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
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Генерация изображения по текстовому описанию. Вызывай ТОЛЬКО если пользователь напрямую попросил "нарисуй", "создай изображение", "сгенерируй картинку" и т.п. Если пользователь пишет на русском — переведи промпт на английский для лучшего качества, но ответь пользователю на русском. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО писать JSON с action/actioninput/dalle в текст ответа — используй ТОЛЬКО tool call.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Детальное описание того, что нужно изобразить (на английском языке для лучшего качества генерации).'
          }
        },
        required: ['prompt']
      }
    }
  }
] as const;

/** Build set_display_state tool with dynamic enums from client manifest */
const buildDisplayStateTool = (manifest?: { moods?: string[]; reactions?: string[] } | null) => {
  const moods = manifest?.moods?.length ? manifest.moods : ['idle'];
  const reactions = manifest?.reactions?.length ? manifest.reactions : [];
  return {
    type: 'function' as const,
    function: {
      name: 'set_display_state',
      description: 'Управление пиксельным аватаром на экране пользователя. Используй для эмоциональных реакций (удивление, радость, грусть и т.д.), смены базового настроения или включения медиа-режима (заставка lofi и т.п.). Вызывай проактивно, когда это уместно по контексту разговора.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['face', 'media'],
            description: 'face — обычный режим аватара (настроение + реакции). media — показать произвольное изображение/GIF по ссылке вместо лица.'
          },
          base_mood: {
            type: 'string',
            enum: moods,
            description: `Базовое настроение аватара. Доступные: ${moods.join(', ')}. Работает только при mode=face.`
          },
          reactions: {
            type: 'array',
            items: {
              type: 'string',
              ...(reactions.length ? { enum: reactions } : {})
            },
            description: reactions.length
              ? `Очередь временных анимаций-реакций. Доступные: ${reactions.join(', ')}. Проигрываются по порядку, затем аватар возвращается к base_mood.`
              : 'Очередь временных анимаций-реакций. Сейчас нет доступных реакций.'
          },
          media_url: {
            type: 'string',
            description: 'Прямая ссылка на изображение/GIF для mode=media. Игнорируется при mode=face.'
          },
          loop_reaction: {
            type: 'string',
            description: reactions.length
              ? `Запустить зацикленную реакцию, которая играет бесконечно пока не будет остановлена. Доступные: ${reactions.join(', ')}.`
              : 'Запустить зацикленную реакцию. Сейчас нет доступных реакций.'
          },
          clear_loop: {
            type: 'boolean',
            description: 'Остановить текущую зацикленную реакцию (loop_reaction). Передай true чтобы остановить.'
          }
        }
      }
    }
  };
};

/** Build desktop_action tool — only available on desktop client */
const buildDesktopActionTool = () => {
  return {
    type: 'function' as const,
    function: {
      name: 'desktop_action',
      description: `Управление интерфейсом десктопного приложения Chatter. Позволяет открывать/закрывать виджеты, создавать черновики заметок, открывать конкретные записи, читать текущее состояние виджетов.
Используй когда:
- Пользователь просит создать черновик заметки (не сразу сохранить, а открыть для редактирования) — action=set_widget_data, target=notebook, value={title,content}
- Нужно открыть блокнот чтобы показать что-то — action=open_widget, target=notebook
- Нужно открыть конкретную запись в блокноте — action=open_note, target=notebook, value={note_id}
- Нужно прочитать что сейчас написано в открытом черновике — action=read_widget_state, target=notebook
- Нужно открыть/закрыть панель инструментов — action=toggle_panel
- Нужно закрыть конкретный виджет — action=close_widget, target=notebook
- Нужно открыть задачи — action=open_widget, target=tasks`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['open_widget', 'close_widget', 'set_widget_data', 'open_note', 'read_widget_state', 'toggle_panel'],
            description: 'Тип действия. open_widget — открыть виджет, close_widget — закрыть, set_widget_data — передать данные в виджет (например текст черновика), open_note — открыть конкретную запись в блокноте по ID, read_widget_state — прочитать текущее состояние виджета, toggle_panel — открыть/закрыть панель инструментов.'
          },
          target: {
            type: 'string',
            enum: ['notebook', 'tasks'],
            description: 'Целевой виджет. notebook — блокнот/заметки, tasks — задачи.'
          },
          value: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Заголовок (для блокнота)' },
              content: { type: 'string', description: 'Текст содержимого (для блокнота)' },
              note_id: { type: 'number', description: 'ID записи для открытия (используется с action=open_note).' }
            },
            description: 'Данные для передачи в виджет. Используется с action=set_widget_data или action=open_note.'
          }
        },
        required: ['action']
      }
    }
  };
};

/** Build map_control tool — only available on desktop client */
const buildMapControlTool = () => {
  return {
    type: 'function' as const,
    function: {
      name: 'map_control',
      description: `Управление картой в десктопном приложении. Показывает место на карте или прокладывает маршрут между двумя точками.
Используй когда:
- Пользователь просит показать место на карте — action=show_place, query="Город, улица"
- Пользователь просит проложить маршрут — action=draw_route, from_query="откуда", to_query="куда"
Важно: НЕ угадывай координаты сам. Передавай текстовые адреса — бэкенд сам геокодирует.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['show_place', 'draw_route'],
            description: 'Показать точку на карте или проложить маршрут.'
          },
          query: {
            type: 'string',
            description: 'Название или адрес места (для action=show_place). Например "Москва, Красная площадь".'
          },
          from_query: {
            type: 'string',
            description: 'Адрес точки отправления (для action=draw_route).'
          },
          to_query: {
            type: 'string',
            description: 'Адрес точки назначения (для action=draw_route).'
          }
        },
        required: ['action']
      }
    }
  };
};

/** Build get_map_pins tool — bot reads user's saved map pins */
const buildGetMapPinsTool = () => {
  return {
    type: 'function' as const,
    function: {
      name: 'get_map_pins',
      description: `Получить список сохранённых меток пользователя на карте. Возвращает массив меток с координатами и названиями. Используй, когда пользователь спрашивает про свои сохранённые места, точки, локации.`,
      parameters: {
        type: 'object',
        properties: {},
        required: [] as string[],
      },
    },
  };
};

/** Build find_transit_route tool — searches public transit routes via Overpass API */
const buildFindTransitRouteTool = () => {
  return {
    type: 'function' as const,
    function: {
      name: 'find_transit_route',
      description: `Поиск маршрутов общественного транспорта (автобусы, маршрутки, троллейбусы, трамваи) между двумя точками. Находит маршруты OSM через Overpass API.
Используй когда:
- Пользователь спрашивает как добраться на общественном транспорте
- Нужно найти автобус/маршрутку от точки А до точки Б
Важно: передавай точные координаты (lat, lon) обеих точек. Если пользователь дал адреса — сначала геокодируй через map_control(show_place) или используй уже известные координаты.`,
      parameters: {
        type: 'object',
        properties: {
          from_lat: {
            type: 'number',
            description: 'Широта точки отправления (например 56.4977)',
          },
          from_lon: {
            type: 'number',
            description: 'Долгота точки отправления (например 84.9744)',
          },
          to_lat: {
            type: 'number',
            description: 'Широта точки назначения',
          },
          to_lon: {
            type: 'number',
            description: 'Долгота точки назначения',
          },
          radius_meters: {
            type: 'integer',
            description: 'Радиус поиска маршрутов в метрах. По умолчанию 500. Если точка на окраине/за городом — используй 1000-1500.',
          },
        },
        required: ['from_lat', 'from_lon', 'to_lat', 'to_lon'] as string[],
      },
    },
  };
};

/** Build search_nearby tool — searches named POIs via Overpass API */
const buildSearchNearbyTool = () => {
  return {
    type: 'function' as const,
    function: {
      name: 'search_nearby',
      description: `Поиск заведений, организаций и объектов рядом с указанной точкой. Находит любые POI (Points of Interest) по названию через OpenStreetMap: рестораны, аптеки, магазины, заправки, банки, аэропорты и т.д.
Используй когда:
- Пользователь спрашивает "найди все KFC рядом", "где ближайшая аптека", "покажи заправки в радиусе 2км"
- Нужно найти конкретную сеть или тип заведения по названию
Важно: query — это текст для поиска по названию (KFC, Аптека, Вкусно и точка). Для поиска по типу (аптеки вообще) тоже используй название — "Аптека".`,
      parameters: {
        type: 'object',
        properties: {
          latitude: {
            type: 'number',
            description: 'Широта центра поиска',
          },
          longitude: {
            type: 'number',
            description: 'Долгота центра поиска',
          },
          query: {
            type: 'string',
            description: 'Что искать по названию. Например: "KFC", "Аэропорт", "Аптека", "Вкусно и точка", "Сбербанк".',
          },
          radius_meters: {
            type: 'integer',
            description: 'Радиус поиска в метрах. Для городских заведений: 2000-5000. Для крупных объектов за городом (аэропорты): 50000.',
          },
        },
        required: ['latitude', 'longitude', 'query'] as string[],
      },
    },
  };
};

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
const runCompletion = async (mode: 'pro' | 'lite' | 'vision-pro' | 'vision-lite', requestPayload: Record<string, unknown>): Promise<CompletionMeta> => {
  if (mode === 'vision-pro' || mode === 'vision-lite') {
    const providers = mode === 'vision-pro' ? VISION_PROVIDERS.pro : VISION_PROVIDERS.lite;
    if (!providers.length) {
      return runCompletion(mode === 'vision-pro' ? 'pro' : 'lite', requestPayload);
    }
    const failedProviders: string[] = [];
    const failedModels: string[] = [];
    for (const provider of providers) {
      try {
        const completion = await createCompletionWithModelFallback(provider.client, provider.modelChain, requestPayload);
        if (completion.failedModels.length) {
          failedModels.push(...completion.failedModels.map(m => `${provider.name}:${m}`));
        }
        return {
          response: completion.response,
          usedModel: completion.modelUsed,
          usedProvider: provider.name,
          baseURLUsed: provider.baseURL,
          failedModels,
          failedProviders
        };
      } catch (err: any) {
        failedProviders.push(provider.name);
        if (Array.isArray(err?.failedModels)) {
          failedModels.push(...err.failedModels.map((m: string) => `${provider.name}:${m}`));
        }
      }
    }
    throw Object.assign(new Error('vision_providers_failed'), { failedProviders, failedModels });
  }
  if (mode === 'pro') {
    if (PRO_PROVIDERS.length > 0) {
      const res = await createCompletionWithProProviderFallback(requestPayload);
      return {
        response: res.response,
        usedModel: res.modelUsed,
        usedProvider: res.providerUsed,
        baseURLUsed: res.baseURLUsed,
        failedModels: res.failedModels,
        failedProviders: res.failedProviders
      };
    }
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

const hasImageGenIntent = (text: string) => /\b(нарисуй|сгенерируй\s*(картинк|изображен|фото|рисун)|создай\s*(изображен|картинк|рисун|фото|график)|generate\s*image|draw|paint|сделай\s*(картинк|изображен|рисун|фото)|придумай\s*(картинк|изображен|рисун)|покажи\s*(как|что)|изобрази|нарис|сгенерируй\s*изобр|сделай\s*мне\s*карт|сгенер[\w]*\s*карт|сгенер[\w]*\s*изобр|созд[\w]*\s*изобр|созд[\w]*\s*карт|draw\s*me|paint\s*me|make\s*a\s*picture|generate\s*a\s*picture|create\s*an?\s*image|create\s*a\s*picture)\b/i.test(text);

const getTaskByUserAndId = (userId: number, taskId: number) => db.prepare(`
  SELECT id, status
  FROM tasks
  WHERE user_id = ? AND id = ?
`).get(userId, taskId) as { id: number; status: string } | undefined;

const runTool = async (user: UserRecord, timezoneOffset: number, toolName: string, argsRaw: string, aiCall: (requestPayload: Record<string, unknown>) => Promise<CompletionMeta>, generatedImages?: Array<{ image_base64: string; image_url?: string; prompt_used: string }>, displayStateSink?: { value: DisplayStatePayload | null }, desktopActionSink?: { value: DesktopActionPayload | null }, mapUpdateSink?: { value: MapUpdatePayload | null }) => {
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
  if (toolName === 'search_cold_memory') {
    const query = typeof parsed.query === 'string' ? parsed.query : '';
    const topK = Number.isFinite(Number(parsed.top_k)) ? Number(parsed.top_k) : 5;
    const result = await VectorMemoryService.search(user.id, query, topK);
    if (!result.matches.length) return `По запросу "${query}" в памяти ничего не найдено.`;
    return `Найдено в архиве:\n${result.text}`;
  }
  if (toolName === 'save_to_cold_memory') {
    const textToSave = typeof parsed.text === 'string' ? parsed.text : '';
    const source = typeof parsed.source === 'string' ? parsed.source : 'manual';
    const result = await VectorMemoryService.saveFactBatched(user.id, textToSave, source);
    return `Успешно сохранено в архив (${result.chunks_saved} фрагментов).`;
  }
  if (toolName === 'delete_from_cold_memory') {
    const chunkId = typeof parsed.chunk_id === 'string' ? parsed.chunk_id : '';
    await VectorMemoryService.deleteChunk(user.id, chunkId);
    return `Фрагмент [${chunkId}] успешно удален из памяти.`;
  }
  if (toolName === 'update_core_memory') return runCoreMemoryMerge(aiCall, user.id, typeof parsed.new_fact === 'string' ? parsed.new_fact : '', Boolean(parsed.explicit_request));

  if (toolName === 'generate_image') {
    const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : '';
    if (!prompt) return 'Ошибка: пустой промпт для генерации изображения.';
    const result = await runImageGeneration(user.id, prompt);
    if (!result.ok) return `Ошибка генерации изображения: ${(result as any).error || 'unknown'}`;
    // base64 НЕ возвращаем в tool_content — он сохраняется в массив generatedImages
    // LLM получает текстовую заглушку, чтобы не забивать контекст мегабайтами base64
    if (Array.isArray(generatedImages)) {
      // Save to disk and get URL
      let imageUrl: string | undefined;
      try {
        const { saveGeneratedImage } = await import('./image-storage.js');
        const saved = await saveGeneratedImage(result.image_base64);
        imageUrl = saved.url;
      } catch (err) {
        console.error('[generate_image] failed to save generated image to disk:', err);
      }
      generatedImages.push({ image_base64: result.image_base64, image_url: imageUrl, prompt_used: result.prompt_used });
    }
    return JSON.stringify({ status: 'success', message: 'Изображение успешно сгенерировано и будет отправлено пользователю. Опиши результат своими словами.' });
  }

  if (toolName === 'set_display_state') {
    const state: DisplayStatePayload = {};
    if (parsed.mode === 'face' || parsed.mode === 'media') state.mode = parsed.mode;
    if (typeof parsed.base_mood === 'string' && parsed.base_mood.trim()) state.base_mood = parsed.base_mood.trim();
    if (Array.isArray(parsed.reactions) && parsed.reactions.length > 0) state.reactions = parsed.reactions.filter((r: any) => typeof r === 'string');
    if (typeof parsed.media_url === 'string' && parsed.media_url.trim()) state.media_url = parsed.media_url.trim();
    if (typeof parsed.loop_reaction === 'string' && parsed.loop_reaction.trim()) state.loop_reaction = parsed.loop_reaction.trim();
    if (parsed.clear_loop === true) state.clear_loop = true;
    if (displayStateSink) displayStateSink.value = state;
    return JSON.stringify({ status: 'success', message: 'Состояние аватара обновлено.' });
  }

  if (toolName === 'map_control') {
    const action: string = typeof parsed.action === 'string' ? parsed.action : '';
    if (!action) return JSON.stringify({ status: 'error', message: 'action is required' });

    try {
      if (action === 'show_place') {
        const query = `${parsed.query || ''}`.trim();
        if (!query) return JSON.stringify({ status: 'error', message: 'query is required for show_place' });
        const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`, {
          headers: { 'User-Agent': 'ChatterBot/1.0' },
        });
        const geoData = await geoRes.json() as any[];
        if (!geoData.length) return JSON.stringify({ status: 'error', message: `Не удалось найти место: ${query}` });
        const lat = parseFloat(geoData[0].lat);
        const lng = parseFloat(geoData[0].lon);
        if (mapUpdateSink) mapUpdateSink.value = { action: 'show_place', lat, lng, label: query };
        return JSON.stringify({ status: 'success', lat, lng, label: query });
      }

      if (action === 'draw_route') {
        const fromQuery = `${parsed.from_query || ''}`.trim();
        const toQuery = `${parsed.to_query || ''}`.trim();
        if (!fromQuery || !toQuery) return JSON.stringify({ status: 'error', message: 'from_query and to_query are required for draw_route' });

        const [fromRes, toRes] = await Promise.all([
          fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(fromQuery)}&format=json&limit=1`, { headers: { 'User-Agent': 'ChatterBot/1.0' } }).then(r => r.json()).then(d => d as any[]),
          fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(toQuery)}&format=json&limit=1`, { headers: { 'User-Agent': 'ChatterBot/1.0' } }).then(r => r.json()).then(d => d as any[]),
        ]);
        if (!fromRes.length) return JSON.stringify({ status: 'error', message: `Не удалось найти: ${fromQuery}` });
        if (!toRes.length) return JSON.stringify({ status: 'error', message: `Не удалось найти: ${toQuery}` });

        const fromLat = parseFloat(fromRes[0].lat);
        const fromLng = parseFloat(fromRes[0].lon);
        const toLat = parseFloat(toRes[0].lat);
        const toLng = parseFloat(toRes[0].lon);

        // OSRM expects [lng,lat] order
        const routeUrl = `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?geometries=geojson`;
        const routeRes = await fetch(routeUrl);
        const routeData = await routeRes.json() as any;
        if (!routeData.routes?.length) return JSON.stringify({ status: 'error', message: 'Не удалось построить маршрут' });

        // Convert [lng,lat] → [lat,lng] for Leaflet
        const coords: [number, number][] = routeData.routes[0].geometry.coordinates.map(
          (c: number[]) => [c[1], c[0]] as [number, number]
        );

        if (mapUpdateSink) mapUpdateSink.value = {
          action: 'draw_route',
          lat: (fromLat + toLat) / 2,
          lng: (fromLng + toLng) / 2,
          from: { lat: fromLat, lng: fromLng, label: fromQuery },
          to: { lat: toLat, lng: toLng, label: toQuery },
          route: coords,
        };
        return JSON.stringify({ status: 'success', from: fromQuery, to: toQuery, points: coords.length });
      }

      return JSON.stringify({ status: 'error', message: `Unknown action: ${action}` });
    } catch (err: any) {
      return JSON.stringify({ status: 'error', message: `Map error: ${err?.message || String(err)}` });
    }
  }

  if (toolName === 'get_map_pins') {
    const pins = listMapPinsForBot(user.id);
    if (pins.length === 0) return JSON.stringify({ status: 'success', pins: [], message: 'У пользователя нет сохранённых меток.' });
    return JSON.stringify({ status: 'success', pins, count: pins.length });
  }

  if (toolName === 'find_transit_route') {
    const fromLat = typeof parsed.from_lat === 'number' ? parsed.from_lat : NaN;
    const fromLon = typeof parsed.from_lon === 'number' ? parsed.from_lon : NaN;
    const toLat = typeof parsed.to_lat === 'number' ? parsed.to_lat : NaN;
    const toLon = typeof parsed.to_lon === 'number' ? parsed.to_lon : NaN;

    if ([fromLat, fromLon, toLat, toLon].some(isNaN)) {
      return JSON.stringify({ status: 'error', message: 'from_lat, from_lon, to_lat, to_lon — обязательные числовые координаты' });
    }

    const radius = typeof parsed.radius_meters === 'number' ? parsed.radius_meters : 500;

    try {
      const variants = await findTransitRoute(fromLat, fromLon, toLat, toLon, radius);

      if (variants.length === 0) {
        return JSON.stringify({
          status: 'success',
          message: 'Общественный транспорт не найден в этом районе. Попробуйте указать более точные координаты, увеличить радиус или другой район.',
          variants: [],
        });
      }

      // Send the best variant (sliced segment) to the map via SSE for desktop
      if (mapUpdateSink && variants[0]) {
        const best = variants[0];
        const midIdx = Math.floor(best.slicedPath.length / 2);
        mapUpdateSink.value = {
          action: 'transit_route',
          lat: best.slicedPath[midIdx]?.[0] ?? (fromLat + toLat) / 2,
          lng: best.slicedPath[midIdx]?.[1] ?? (fromLon + toLon) / 2,
          routeName: best.routeName,
          path: best.slicedPath,
          stops: best.slicedStops,
        };
      }

      // Return enriched description for the AI — just the ride segment, not the whole route
      const descriptions = variants.map((v) => ({
        routeName: v.routeName,
        routeType: v.routeType,
        totalWalkingDistanceMeters: v.totalWalkingMeters,
        pickupStop: {
          name: v.pickupStop.name,
          distanceFromUserMeters: v.pickupStop.distanceMeters,
        },
        dropoffStop: {
          name: v.dropoffStop.name,
          distanceToDestinationMeters: v.dropoffStop.distanceMeters,
        },
        stopsToRideCount: v.stopsToRideCount,
        stopsToRideList: v.stopsToRideList,
        direction: v.direction === 1 ? 'forward' : 'reverse',
      }));

      const best = variants[0];
      return JSON.stringify({
        status: 'success',
        variantsFound: variants.length,
        variants: descriptions,
        message: `Найдено ${variants.length} маршрут(ов). Лучший: ${best.routeName} — идти пешком ${best.totalWalkingMeters}м, ехать ${best.stopsToRideCount} остановок от "${best.pickupStop.name}" до "${best.dropoffStop.name}".`,
      });
    } catch (err: any) {
      return JSON.stringify({ status: 'error', message: `Ошибка поиска транспорта: ${err?.message || String(err)}` });
    }
  }

  if (toolName === 'search_nearby') {
    const lat = typeof parsed.latitude === 'number' ? parsed.latitude : NaN;
    const lng = typeof parsed.longitude === 'number' ? parsed.longitude : NaN;
    const query = typeof parsed.query === 'string' ? parsed.query.trim() : '';
    const radius = typeof parsed.radius_meters === 'number' ? parsed.radius_meters : 3000;

    if (isNaN(lat) || isNaN(lng)) {
      return JSON.stringify({ status: 'error', message: 'latitude и longitude — обязательные числовые координаты' });
    }
    if (!query) {
      return JSON.stringify({ status: 'error', message: 'query — обязательный параметр (что искать)' });
    }

    try {
      const places = await searchNearby(lat, lng, query, radius);

      if (places.length === 0) {
        return JSON.stringify({
          status: 'success',
          message: `Ничего не найдено по запросу "${query}" в радиусе ${radius}м. Попробуйте увеличить радиус или изменить запрос.`,
          places: [],
        });
      }

      // Send places to the map via SSE for desktop
      if (mapUpdateSink) {
        mapUpdateSink.value = {
          action: 'poi_search',
          lat,
          lng,
          query,
          places,
        };
      }

      // Return text description for the AI
      const descriptions = places.map((p, i) => ({
        index: i + 1,
        name: p.name,
        address: p.address,
        hours: p.hours,
        category: p.category,
        lat: Math.round(p.lat * 10000) / 10000,
        lng: Math.round(p.lng * 10000) / 10000,
      }));

      return JSON.stringify({
        status: 'success',
        query,
        radius,
        placesFound: places.length,
        places: descriptions,
        message: `Найдено ${places.length} объектов по запросу "${query}".`,
      });
    } catch (err: any) {
      return JSON.stringify({ status: 'error', message: `Ошибка поиска: ${err?.message || String(err)}` });
    }
  }

  if (toolName === 'desktop_action') {
    const action: string = typeof parsed.action === 'string' ? parsed.action : '';
    const target: string | undefined = typeof parsed.target === 'string' ? parsed.target : undefined;
    const value = parsed.value ?? undefined;

    if (!action) return JSON.stringify({ status: 'error', message: 'action is required' });

    const payload: DesktopActionPayload = { action: action as DesktopActionPayload['action'] };
    if (target) payload.target = target;
    if (value) payload.value = value;

    if (desktopActionSink) desktopActionSink.value = payload;

    return JSON.stringify({ status: 'success', message: `Команда ${action} выполнена.`, target });
  }

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
  if (toolName === 'generate_image') return 'Генерирую изображение...';
  if (toolName === 'map_control') return 'Ищу на карте...';
  if (toolName === 'get_map_pins') return 'Читаю сохранённые метки...';
  if (toolName === 'find_transit_route') return 'Ищу маршруты общественного транспорта...';
  if (toolName === 'search_nearby') return 'Ищу места поблизости...';
  if (toolName === 'desktop_action') {
    try {
      const parsed = JSON.parse(argsRaw || '{}');
      const a = parsed.action || '';
      if (a === 'open_widget') {
        const t = parsed.target;
        const label = t === 'notebook' ? 'блокнот' : t === 'tasks' ? 'задачи' : 'виджет';
        return `Открываю ${label}...`;
      }
      if (a === 'close_widget') {
        const t = parsed.target;
        const label = t === 'notebook' ? 'блокнот' : t === 'tasks' ? 'задачи' : 'виджет';
        return `Закрываю ${label}...`;
      }
      if (a === 'set_widget_data') return `Готовлю черновик...`;
      if (a === 'open_note') return `Открываю запись в блокноте...`;
      if (a === 'read_widget_state') return `Читаю состояние виджета...`;
      if (a === 'toggle_panel') return 'Открываю панель инструментов...';
    } catch { /* */ }
    return 'Выполняю действие...';
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
    displayManifest?: { moods?: string[]; reactions?: string[] } | null;
    isDesktop?: boolean;
    isVoice?: boolean;
    onDesktopAction?: (action: DesktopActionPayload) => Promise<void> | void;
    images?: Array<{ base64: string; mimeType: string }>;
    userImages?: Array<{ url: string; type: 'user_photo' }> | null;
    promptUserId?: number;
    onIntermediateMessage?: (text: string) => Promise<void> | void;
    onStateChange?: (state: DisplayStatePayload) => Promise<void> | void;
    onToolStatus?: (text: string) => Promise<void> | void;
    onMapUpdate?: (data: MapUpdatePayload) => Promise<void> | void;
  }
): Promise<AiSendResult> => {
  const user = getUserById(userId);
  if (!user) throw new Error('user_not_found');
  if (user.status !== 'approved' && user.is_admin !== 1) throw new Error('user_not_approved');

  const images = options?.images?.filter(img => img.base64) ?? [];
  const hasImages = images.length > 0;
  let text = (inputText || '').trim();
  if (!text && !hasImages) throw new Error('empty_text');
  if (!text) text = hasImages ? (images.length === 1 ? 'Что на этой картинке?' : `Что на этих ${images.length} картинках?`) : '';
  const forceProRoute = Boolean(options?.forcePro) || text.startsWith('!!!') || hasImages;
  if (forceProRoute && !options?.forcePro && !hasImages) {
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
  const avatarPromptHint = options?.displayManifest ? AVATAR_PROMPT_HINT : '';
  const promptUser = options?.promptUserId ? getUserById(options.promptUserId) ?? user : user;
  const voicePromptHint = options?.isVoice ? `\n\n[ГОЛОСОВОЙ РЕЖИМ]\nТЕКУЩЕЕ сообщение пользователя ВВЕДЕНО ГОЛОСОМ, и твой ответ БУДЕТ ОЗВУЧЕН через TTS. СТРОГО, ОБЯЗАТЕЛЬНО БЛЯТЬ СЕЙЧАС, ОБЯЗАТЕЛЬНО!!! соблюдай:\n1. Отвечай максимально кратко и естественно, как в устном диалоге.\n2. Никаких длинных списков, Markdown-таблиц или блоков кода, если только об этом не попросили напрямую.\n3. Используй разговорный стиль. Максимально краткий, удобный к прослушиванию и содержательный. ОБЯЗАТЕЛЬНО используй ТЕКСТ вместо знаков. Например: "проценты" вместо "%", или "градусов по цельсию" вместо "°C", "метров в секунде" вместо "м/с".` : '';
  const proSystemPrompt = `${buildSystemPrompt(resolvePromptForUser(promptUser).content, user.name || user.tg_username || 'Пользователь', user.core_memory || '')}${buildTimeContext(timezone)}${avatarPromptHint}${voicePromptHint}${hasImages ? '\n\nЕсли пользователь прислал изображение(я), анализируй его/их и отвечай конкретно по запросу пользователя.' : ''}`;

  let executionMode: 'pro' | 'lite' | 'vision-pro' | 'vision-lite' = hasImages
    ? (user.plan === 'pro' ? 'vision-pro' : 'vision-lite')
    : 'pro';
  let executionTools: any[] = [...toolDefinitions, buildDisplayStateTool(options?.displayManifest), ...(options?.isDesktop ? [buildDesktopActionTool(), buildMapControlTool(), buildGetMapPinsTool(), buildFindTransitRouteTool(), buildSearchNearbyTool()] : [])] as any[];
  let executionHistory = history;
  let executionSystemPrompt = proSystemPrompt;
  let totalTokens = 0;

if (!forceProRoute) {
  const routerPrompt = `Ты — маршрутизатор запросов. Твоя цель — определить категорию запроса. ВСЁ, что не укладывается в тип запроса, или он выбивается из твоих доступных категорий, перенаправляй в PRO. Даже если это ругань или простая беседа.
Верни ТОЛЬКО ОДНО СЛОВО из списка ниже.

[ПРОСТЫЕ КАТЕГОРИИ - не требуют истории чата]:
- SMART_HOME (управление светом, розетками)
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

  if (!hasSchedulingIntent(text) && !hasImageGenIntent(text)) {
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

  const userMessageContent: any = hasImages
    ? [
        { type: 'text', text },
        ...images.map(img => ({
          type: 'image_url',
          image_url: { url: `data:${img.mimeType};base64,${img.base64}` }
        }))
      ]
    : text;

  const currentMessages: any[] = [
    { role: 'system', content: executionSystemPrompt },
    ...executionHistory,
    { role: 'user', content: userMessageContent }
  ];

  let answer = FALLBACK_ANSWER;
  let usedModel = '';
  let usedProvider = '';
  let loop = 0;
  const toolOutputsForFallback: string[] = [];
  const toolUserMessages: string[] = [];
  const generatedImages: Array<{ image_base64: string; image_url?: string; prompt_used: string }> = [];
  const displayStateSink: { value: DisplayStatePayload | null } = { value: null };
  const desktopActionSink: { value: DesktopActionPayload | null } = { value: null };
  const mapUpdateSink: { value: MapUpdatePayload | null } = { value: null };
  let modelFallbackNotice: string | null = null;
  let modelFallbackNoticeSent = false;

  // Буферы для корректной сборки ответа агентского цикла
  let fullDbHistory = '';  // Весь текст от нейросети (для сохранения контекста в БД)
  let finalAnswer = '';    // Только последний текст (чтобы не дублировать отправку)

  while (loop < MAX_TOOL_LOOPS) {
    loop += 1;
    const completion = await runCompletion(executionMode, {
      messages: currentMessages,
      tools: executionTools,
      tool_choice: 'auto',
      max_tokens: 16384,
      thinking: { type: executionMode === 'lite' ? 'disabled' : 'enabled' },
      clear_thinking: false
    });
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
    if (!modelFallbackNoticeSent && executionMode === 'pro' && ((completion.failedModels?.length || 0) > 0 || (completion.failedProviders?.length || 0) > 0)) {
      modelFallbackNoticeSent = true;
      const parts: string[] = [];
      if (completion.failedProviders?.length) {
        parts.push(`Провайдер(ы) ${completion.failedProviders.join(', ')} не ответил(и).`);
      }
      if (completion.failedModels?.length) {
        parts.push(`Модель(и) ${completion.failedModels.join(', ')} были недоступны.`);
      }
      parts.push(`Ответ получен от ${completion.usedProvider}/${completion.usedModel}.`);
      modelFallbackNotice = `⚙️ ${parts.join(' ')}`;
    }
    usedModel = completion.usedModel;
    usedProvider = completion.usedProvider;
    const response = completion.response;
    totalTokens += extractTokens(response);
    const message = response?.choices?.[0]?.message || {};
    currentMessages.push(message);

    // --- УМНАЯ ОБРАБОТКА ТЕКСТА ---
    const stepContent = `${message.content || ''}`.trim();

    if (stepContent) {
      // Всегда собираем полную историю для базы данных
      fullDbHistory += (fullDbHistory ? '\n\n' : '') + stepContent;

      if (message.tool_calls?.length) {
        // Модель вызывает тулз + написала текст (промежуточное сообщение)
        if (options?.onIntermediateMessage) {
          // Если есть обработчик — отправляем юзеру прямо сейчас
          await options.onIntermediateMessage(stepContent);
        }
        // Коллбэка нет — текст останется в fullDbHistory для финальной отправки
      } else {
        // Это финальный ответ (тулзов больше нет)
        finalAnswer = stepContent;
      }
    }

    if (!message.tool_calls?.length) {
      const finishReason = response?.choices?.[0]?.finish_reason;

      // Формируем ответ на выход из функции
      if (finalAnswer) {
        // Был финальный текст — возвращаем его
        answer = finalAnswer;
      } else if (fullDbHistory && options?.onIntermediateMessage) {
        // Текст ушел через коллбэк, но финального текста нет (наш баг с улыбкой),
        // возвращаем пустоту, чтобы роутер не дублировал сообщение
        answer = '';
      } else if (fullDbHistory) {
        // Коллбэка не было, отдаем юзеру всё склеенное разом
        answer = fullDbHistory;
      } else if (toolOutputsForFallback.length) {
        answer = toolOutputsForFallback[toolOutputsForFallback.length - 1] || FALLBACK_ANSWER;
      }

      if (finishReason === 'length') {
        console.warn(`[AI TRUNCATE] finish_reason=length, model=${completion.usedModel}, provider=${completion.usedProvider}, content_len=${stepContent.length}`);
      }
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
    executionTools = [...toolDefinitions, buildDisplayStateTool(options?.displayManifest), ...(options?.isDesktop ? [buildDesktopActionTool()] : [])] as any[];
    executionTools = [...toolDefinitions, buildDisplayStateTool(options?.displayManifest), ...(options?.isDesktop ? [buildDesktopActionTool()] : [])] as any[];
    currentMessages.length = 0;
    currentMessages.push(
      { role: 'system', content: proSystemPrompt },
      ...history,
      { role: 'user', content: originalQuery }
    );

    escalatedToPro = true;
    break;
  }

  const toolUserMessage = getToolUserMessage(toolName, toolCall.function?.arguments || '{}');
  if (toolUserMessage) {
    toolUserMessages.push(toolUserMessage);
    if (options?.onToolStatus) await options.onToolStatus(toolUserMessage);
  }

  let toolContent = '';
  try {
    toolContent = await runTool(
      user,
      timezone,
      toolName,
      toolCall.function?.arguments || '{}',
      (payload) => runCompletion('pro', payload),
      generatedImages,
      displayStateSink,
      desktopActionSink,
      mapUpdateSink
    );

    // Если тулз изменил состояние аватара — прокидываем наружу в реалтайме
    if (toolName === 'set_display_state' && displayStateSink.value && options?.onStateChange) {
      await options.onStateChange(displayStateSink.value);
    }

    // Если тулз вызвал desktop_action — прокидываем наружу в реалтайме
    if (toolName === 'desktop_action' && desktopActionSink.value && options?.onDesktopAction) {
      await options.onDesktopAction(desktopActionSink.value);
    }

    // Если тулз вызвал map_control или find_transit_route — прокидываем данные карты
    if ((toolName === 'map_control' || toolName === 'find_transit_route' || toolName === 'search_nearby') && mapUpdateSink.value && options?.onMapUpdate) {
      await options.onMapUpdate(mapUpdateSink.value);
    }
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
    const userMessageImages = options?.userImages?.length ? options.userImages : null;
    appendChatMessage(userId, chatId, 'user', userTextForHistory, userTelegramChatId, userTelegramMessageId, userMessageImages);
  }
  const assistantTelegramChatId = Number.isFinite(Number(options?.assistantTelegramChatId))
    ? Math.floor(Number(options?.assistantTelegramChatId))
    : null;
  // Сохраняем в БД полную историю, даже если она ушла через коллбэк
  const textToSave = fullDbHistory || answer;
  // Collect generated image URLs for assistant message
  const assistantMessageImages = generatedImages.length > 0
    ? generatedImages.filter(img => img.image_url).map(img => ({ url: img.image_url!, type: 'generated' as const }))
    : null;
  const assistantMessageId = options?.skipHistory
    ? 0
    : appendChatMessage(userId, chatId, 'assistant', textToSave, assistantTelegramChatId, null, assistantMessageImages);

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
    generated_images: generatedImages.length > 0 ? generatedImages : undefined,
    display_state: displayStateSink.value ?? undefined,
    desktop_action: desktopActionSink.value ?? undefined,
    usage: {
      tokens_used: totalTokens,
      used_model: usedModel,
      used_provider: usedProvider
    }
  };
};

export const generateAdminOutreach = async (targetUserId: number, adminInstruction: string) => {
  const instruction = adminInstruction.trim();
  if (!instruction) throw new Error('empty_instruction');

  const aiTask = `[СИСТЕМНОЕ ЗАДАНИЕ ОТ АДМИНА]: Администратор просит передать этому пользователю информацию.
Твоя задача: взять "мысль админа" и написать сообщение от своего лица, строго сохраняя свой текущий характер и стиль.
НЕ пиши "Админ просил передать", просто вплети эту мысль в разговор от себя. НЕ выдавай админа.
Если нужно — используй инструменты (поиск, архив, заметки).

ВАЖНО: Если в мысли админа есть просьба сгенерировать/нарисовать картинку — используй инструмент generate_image. НЕ пиши JSON вручную в текст сообщения, НЕ выводи никакие технические данные (action, actioninput, dalle и т.д.). Просто вызови tool и результат отправится автоматически.

Мысль админа: "${instruction}"`;

  const result = await sendMessageThroughAi(targetUserId, aiTask, undefined, {
    forcePro: true,
    ignoreDailyLimit: true,
    skipHistory: true,
    countAsUserMessage: false
  });

  return {
    reply_text: result.reply_text,
    generated_images: result.generated_images,
    tokens_used: result.usage.tokens_used,
    used_model: result.usage.used_model,
    used_provider: result.usage.used_provider
  };
};
