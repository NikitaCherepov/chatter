import OpenAI from 'openai';
import dotenv from 'dotenv';
import type { AiSendResult, DesktopActionPayload, DisplayStatePayload, MapUpdatePayload, TaskNotifyMode, TaskRecurrenceType, TaskType, UserPlan, UserRecord, MessageAttachment } from '../types.js';
import { appendChatMessage, ensureActiveChat, getHistoryForAi, getMessageTokens, getUserById, renameUserChat, resolveEffectiveContextWindow, resolveMaxContextTokens, resolveAttachmentMaxTokens, injectAttachments, setUserTimezone, trimUserHistoryByChat } from './chats.js';
import { resolvePromptForUser, AVATAR_PROMPT_HINT } from './prompts.js';
import { createNote, deleteNote, getNoteById, listNotes } from './notes.js';
import { createTask, deletePendingTask, getPendingTaskCount, listTasks } from './tasks.js';
import { listMapPinsForBot } from './map-pins.js';
import { runSmartHomeControl, type SmartHomeArgs, listSmartDevicesForAi } from './smart-home.js';
import { runEmailCheck, runEmailRead } from './mail.js';
import { runCoreMemoryMerge } from './memory.js';
import { VectorMemoryService } from './vector-memory.js';
import { getCleanTextFromUrl } from './web-reader.js';
import { runImageGeneration } from './image-generation.js';
import { sendIpcToDesktop, isDesktopOnline, sendToDesktop } from '../ws-clients.js';
import { findTransitRoute, searchNearby } from './transit.js';
import { getCurrencyRates, formatRateForAi } from './currency.js';
import { db } from '../db.js';
import { listSubagentNames, buildSubagentListDescription } from './subagents/registry.js';

dotenv.config();

const FALLBACK_ANSWER = 'Слушай, чет я завис. Попробуй еще раз?';
const MAX_TOOL_LOOPS = 80;
const MAX_TOOL_LOOPS_VOICE = 10;
const MAX_PARALLEL_SPAWN_SUBAGENTS = 3;
const TOOL_RESULT_PREVIEW_MAX = 250;
const PC_COMMAND_OUTPUT_MAX = 15_000;
// Лимит на сохраняемый полный результат инструмента в trace (для отправки в AI-контекст).
// Всё что длиннее — обрезается с пометкой, чтобы tool_calls_json не разрастался бесконечно.
const TOOL_RESULT_FULL_MAX = 40_000;

/**
 * Одна итерация агентского цикла (один runCompletion + последующие tool calls).
 * Используется для сохранения полного trace в tool_calls_json,
 * чтобы getHistoryForAi() могла развернуть его в корректную последовательность
 * assistant(tool_calls) → tool(results) → assistant(tool_calls) → ...
 *
 * Поле `step` служит маркером нового формата: старые записи (плоский массив без step)
 * обрабатываются как fallback для обратной совместимости.
 */
export type ToolIteration = {
  step: number;
  /** Текст, который модель сгенерила на этой итерации (intermediate content). Может быть "". */
  content: string;
  tool_calls: Array<{ id?: string; name: string; arguments: any }>;
  /** Полные результаты runTool для каждого tool_call этой итерации. */
  results: Array<{ id?: string; name: string; content: string }>;
  /** true у финальной итерации без tool_calls (только текстовый ответ). */
  is_final?: boolean;
};

// Реестр активных генераций для остановки по userId
export const activeGenerations = new Map<number, AbortController>();
export const activeHitlWaits = new Set<number>();
const MAX_PENDING_TASKS_PER_USER = 10;
const DEFAULT_MAIL_CHECK_LIMIT = 10;
const TOKENS_PER_PRICE_BLOCK = 500_000;
const PRICE_PER_PRICE_BLOCK_RUB = 102;
const RUB_PER_TOKEN = PRICE_PER_PRICE_BLOCK_RUB / TOKENS_PER_PRICE_BLOCK;
const TAVILY_API_KEY = `${process.env.TAVILY_API_KEY || ''}`.trim();
const TAVILY_API_BASE_URL = `${process.env.TAVILY_API_BASE_URL || 'https://api.tavily.com'}`.replace(/\/+$/, '');

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

type ManualModelEntry = {
  id: string;
  apiModelName: string;
  name: string;
  description: string;
  client: OpenAI;
  baseURL: string;
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

// ── MODELS_MANUAL: ручной выбор модели пользователем ──────────────────────────
// Формат env: base_url|api_key|api_model_name|display_name|description|unique_id;...
const parseManualModels = (): ManualModelEntry[] => {
  const raw = (process.env.MODELS_MANUAL || '').trim();
  if (!raw) return [];
  const chunks = raw.split(';').map(v => v.trim()).filter(Boolean);
  const models: ManualModelEntry[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const parts = chunks[i].split('|').map(v => `${v || ''}`.trim());
    const [baseURL, apiKey, apiModelName, displayName, description, uniqueId] = parts;
    if (!baseURL || !apiKey || !apiModelName || !uniqueId) continue;
    models.push({
      id: uniqueId,
      apiModelName,
      name: displayName || apiModelName,
      description: description || '',
      client: new OpenAI({ apiKey, baseURL }),
      baseURL,
    });
  }
  return models;
};

const MANUAL_MODELS = parseManualModels();
const MANUAL_MODELS_MAP = new Map(MANUAL_MODELS.map(m => [m.id, m]));

export const getModelsCatalog = () => MANUAL_MODELS.map(m => ({
  id: m.id,
  name: m.name,
  description: m.description,
  reasoning_levels: getReasoningLevelsForBaseURL(m.baseURL),
  supported_params: [...getProviderSupportedParams(m.baseURL)],
}));

export const resolveManualModel = (modelId: string): ManualModelEntry | undefined =>
  MANUAL_MODELS_MAP.get(modelId);

const ALL_REASONING_LEVELS: ReasoningLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

/**
 * Определяет доступные уровни reasoning по baseURL провайдера.
 * Возвращает null если reasoning control не поддерживается (ползунок скрыт).
 */
export const getReasoningLevelsForBaseURL = (baseURL: string): ReasoningLevel[] | null => {
  const url = (baseURL || '').toLowerCase();

  if (url.includes('openrouter.ai')) {
    return ALL_REASONING_LEVELS; // none | minimal | low | medium | high | xhigh
  }

  if (url.includes('deepseek.com')) {
    return ['none', 'high', 'xhigh']; // low/medium маппятся в high, xhigh → max
  }

  return null; // неизвестный провайдер — ползунок не показываем
};

/**
 * Доступные уровни в auto-режиме (когда провайдер заранее неизвестен).
 * Показываем все — адаптер на месте разберётся.
 */
export const getAutoReasoningLevels = (): ReasoningLevel[] => ALL_REASONING_LEVELS;

const DEBUG_AI_RAW_MAIN_RESPONSE = process.env.DEBUG_AI_RAW_MAIN_RESPONSE === '1';
const DEBUG_AI_RAW_LITE_RESPONSE = process.env.DEBUG_AI_RAW_LITE_RESPONSE === '1';
const LITE_ROUTER_ENABLED = process.env.TIMEWEB_LITE_ROUTER_ENABLED !== '0';

const extractTokens = (response: any) => Number(response?.usage?.total_tokens || 0);
const createAbortError = () => new DOMException('The user aborted a request.', 'AbortError');

const isAbortError = (err: any) =>
  err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || `${err?.message || ''}` === 'AbortError';

export const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw createAbortError();
};

const abortableSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  throwIfAborted(signal);
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  const onAbort = () => {
    clearTimeout(timer);
    reject(createAbortError());
  };
  signal?.addEventListener('abort', onAbort, { once: true });
});

export const withAbort = async <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  throwIfAborted(signal);
  if (!signal) return promise;

  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(createAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
};
const RETRY_SECONDS = Math.max(0, Number.parseInt(process.env.TIMEWEB_MODEL_RETRY_SECONDS || '3', 10) || 3);
const RETRIES_PER_MODEL = Math.max(0, Number.parseInt(process.env.TIMEWEB_MODEL_RETRIES_PER_MODEL || '1', 10) || 1);

const isRetryable = (err: any) => {
  const status = Number(err?.status || err?.response?.status || 0) || 0;
  const code = `${err?.code || err?.error?.code || ''}`;
  const message = `${err?.message || err?.error?.message || ''}`.toLowerCase();
  if ([408, 409, 425, 500, 502, 503, 504].includes(status)) return true;
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

export type ReasoningLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'auto';

/**
 * Per-model generation settings (temperature, penalties, etc.).
 * Применяются только для ручных моделей. Каждое поле опционально.
 */
export type ModelSettings = {
  temperature?: number | null;
  top_p?: number | null;
  top_k?: number | null;
  frequency_penalty?: number | null;
  presence_penalty?: number | null;
  repetition_penalty?: number | null;
  max_tokens?: number | null;
};

/**
 * Параметры, которые поддерживает каждый провайдер.
 * Параметры не из списка для данного провайдера отбрасываются.
 */
const PROVIDER_SUPPORTED_PARAMS: Record<string, Set<string>> = {
  openrouter: new Set(['temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'max_tokens']),
  deepseek:   new Set(['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'max_tokens']),
  default:    new Set(['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'max_tokens']),
};

const getProviderSupportedParams = (baseURL: string): Set<string> => {
  const url = (baseURL || '').toLowerCase();
  if (url.includes('openrouter.ai')) return PROVIDER_SUPPORTED_PARAMS.openrouter;
  if (url.includes('deepseek.com')) return PROVIDER_SUPPORTED_PARAMS.deepseek;
  return PROVIDER_SUPPORTED_PARAMS.default;
};

/**
 * Мёрджит per-model settings в requestBody, фильтруя по поддержке провайдера.
 * null/undefined значения пропускаются (используется серверный дефолт).
 */
const applyModelSettingsToBody = (
  requestBody: Record<string, unknown>,
  baseURL: string,
  settings?: ModelSettings | null
): Record<string, unknown> => {
  if (!settings) return requestBody;
  const supported = getProviderSupportedParams(baseURL);
  const body = { ...requestBody };
  for (const [key, val] of Object.entries(settings)) {
    if (val === null || val === undefined) continue;
    if (supported.has(key)) {
      body[key] = val;
    }
  }
  return body;
};

/**
 * Адаптирует requestBody под конкретного провайдера перед отправкой.
 * Только OpenRouter и DeepSeek direct получают специальные параметры.
 * Все остальные провайдеры — текущая логика без изменений.
 */
const adaptRequestBodyForProvider = (
  requestBody: Record<string, unknown>,
  baseURL: string,
  model: string,
  level?: ReasoningLevel | null,
  modelSettings?: ModelSettings | null
): Record<string, unknown> => {
  const url = (baseURL || '').toLowerCase();

  // ── OpenRouter: reasoning.effort по стандартной шкале ──
  if (url.includes('openrouter.ai')) {
    const { thinking: _t, clear_thinking: _ct, reasoning_effort: _re, ...body } = requestBody as any;
    if (level && level !== 'auto') {
      body.reasoning = { effort: level };
    }
    return modelSettings ? applyModelSettingsToBody(body, baseURL, modelSettings) : body;
  }

  // ── DeepSeek direct ──
  if (url.includes('deepseek.com')) {
    const { thinking: _t, clear_thinking: _ct, reasoning_effort: _re, ...body } = requestBody as any;
    if (!level || level === 'auto') {
      return modelSettings ? applyModelSettingsToBody(body, baseURL, modelSettings) : body;
    }
    if (level === 'none' || level === 'minimal') {
      body.thinking = { type: 'disabled' };
    } else if (level === 'low' || level === 'medium') {
      // DeepSeek маппит low/medium в high — отправляем high напрямую
      body.reasoning_effort = 'high';
    } else if (level === 'xhigh') {
      body.reasoning_effort = 'max';
    } else {
      // high → high
      body.reasoning_effort = level;
    }
    return modelSettings ? applyModelSettingsToBody(body, baseURL, modelSettings) : body;
  }

  // ── Все остальные провайдеры: не трогаем reasoning, но применяем model settings ──
  return modelSettings ? applyModelSettingsToBody(requestBody, baseURL, modelSettings) : requestBody;
};

/**
 * Опциональные колбеки для токен-стриминга.
 * Если хотя бы один передан — createCompletionWithModelFallback включает stream:true
 * и прокидывает токены в колбеки, одновременно собирая assembled-сообщение для возврата.
 */
export type StreamCallbacks = {
  /** Вызывается по мере получения текстовых токенов (уже оттроттлено по времени). */
  onToken?: (text: string) => void;
  /** Вызывается по мере получения reasoning-токенов (уже оттроттлено). */
  onReasoningToken?: (text: string) => void;
};

/**
 * Частота flush-а накопленных токенов в колбеки (мс).
 * ~20 FPS — баланс между плавностью печати и нагрузкой на WS/React.
 */
const STREAM_FLUSH_INTERVAL_MS = 50;

/**
 * Превращает стрим от OpenAI-совместимого API в собранное assistant-сообщение,
 * одновременно прокидывая токены в колбеки (оттроттленно по времени).
 *
 * Возвращает объект того же формата, что client.chat.completions.create() —
 * { choices: [{ message }] }, чтобы вызывающий код ничего не заметил.
 *
 * Поддерживает:
 * - content (текст)
 * - reasoning_content / reasoning (DeepSeek, OpenRouter)
 * - tool_calls (собирается из дельт по index)
 * - AbortSignal через SDK options + ручная проверка
 */
const streamAndAssemble = async (
  client: OpenAI,
  payload: Record<string, unknown>,
  model: string,
  callbacks: StreamCallbacks | undefined,
  signal?: AbortSignal
): Promise<{ choices: Array<{ message: any }> }> => {
  const wantCallbacks = !!(callbacks?.onToken || callbacks?.onReasoningToken);

  // ── Без колбеков — обычный стрим, только собираем сообщение ──
  // Это полезно для совместимости (например, если хочешь stream:true без пуша в WS)
  // Но сейчас мы вызываем streamAndAssemble только когда есть колбеки.

  console.log('[streamAndAssemble] START', {
    model,
    hasOnToken: !!callbacks?.onToken,
    hasOnReasoningToken: !!callbacks?.onReasoningToken,
    payloadKeys: Object.keys(payload),
  });

  const stream = await client.chat.completions.create(
    { ...payload, model, stream: true } as any,
    signal ? { signal } : {}
  );

  // Буферы для throttle
  let textBuffer = '';
  let reasoningBuffer = '';
  let flushTimer: NodeJS.Timeout | null = null;
  let lastTextFlush = 0;
  let lastReasoningFlush = 0;

  const flush = (final = false) => {
    flushTimer = null;
    const now = Date.now();
    if (textBuffer && callbacks?.onToken) {
      // Минимальный интервал между flush-ами, кроме финального
      if (final || now - lastTextFlush >= STREAM_FLUSH_INTERVAL_MS) {
        callbacks.onToken(textBuffer);
        textBuffer = '';
        lastTextFlush = now;
      }
    }
    if (reasoningBuffer && callbacks?.onReasoningToken) {
      if (final || now - lastReasoningFlush >= STREAM_FLUSH_INTERVAL_MS) {
        callbacks.onReasoningToken(reasoningBuffer);
        reasoningBuffer = '';
        lastReasoningFlush = now;
      }
    }
  };

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => flush(false), STREAM_FLUSH_INTERVAL_MS);
  };

  // Собираем сообщение
  const assembledMessage: any = {
    role: 'assistant',
    content: '',
    reasoning_content: '',
    tool_calls: [] as any[],
  };
  // Временное хранилище для tool_calls по index
  const toolCallMap = new Map<number, { id?: string; type: 'function'; function: { name: string; arguments: string } }>();

  try {
    for await (const chunk of stream as any) {
      // Ручная проверка abort (дополнительно к SDK-abort, для надёжности)
      if (signal?.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }

      const choice = chunk?.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (!delta) continue;

      // 1. Контент
      if (typeof delta.content === 'string' && delta.content) {
        assembledMessage.content += delta.content;
        if (callbacks?.onToken) {
          textBuffer += delta.content;
          scheduleFlush();
        }
      }

      // 2. Reasoning (DeepSeek: reasoning_content, OpenRouter: reasoning)
      const reasoningChunk = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoningChunk === 'string' && reasoningChunk) {
        assembledMessage.reasoning_content += reasoningChunk;
        if (callbacks?.onReasoningToken) {
          reasoningBuffer += reasoningChunk;
          scheduleFlush();
        }
      }

      // 3. Tool calls — собираем по index
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === 'number' ? tc.index : 0;
          if (!toolCallMap.has(idx)) {
            toolCallMap.set(idx, { id: undefined, type: 'function', function: { name: '', arguments: '' } });
          }
          const slot = toolCallMap.get(idx)!;
          if (tc.id) slot.id = tc.id;
          if (tc.type) slot.type = tc.type;
          if (tc.function?.name) slot.function.name += tc.function.name;
          if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
        }
      }
    }

    // Финальный flush — отправляем всё что накопилось
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flush(true);
  } catch (err: any) {
    // Гарантируем flush перед пробросом ошибки, чтобы юзер увидел то что уже сгенерировалось
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flush(true);
    throw err;
  }

  // Собираем tool_calls в массив по порядку index
  if (toolCallMap.size > 0) {
    const sortedIndices = Array.from(toolCallMap.keys()).sort((a, b) => a - b);
    assembledMessage.tool_calls = sortedIndices.map(i => toolCallMap.get(i)!);
  }

  // Если content пустой — null (некоторые провайдеры требуют именно null, не пустую строку)
  if (!assembledMessage.content && assembledMessage.tool_calls.length > 0) {
    assembledMessage.content = null;
  }

  return { choices: [{ message: assembledMessage }] };
};

const createCompletionWithModelFallback = async (
  client: OpenAI,
  modelChain: string[],
  requestBody: Record<string, unknown>,
  providerName = 'default',
  baseURL = '',
  signal?: AbortSignal,
  reasoningLevel?: ReasoningLevel | null,
  modelSettings?: ModelSettings | null,
  streamCallbacks?: StreamCallbacks
) => {
  const failedModels: string[] = [];
  let lastError: unknown = null;

  for (const model of modelChain) {
    const attempts = RETRIES_PER_MODEL + 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const providerRequestBody = adaptRequestBodyForProvider(requestBody, baseURL, model, reasoningLevel, modelSettings);
        if (modelSettings) {
          console.log('[ai][model-settings]', {
            provider: providerName,
            model,
            temperature: providerRequestBody.temperature,
            top_p: providerRequestBody.top_p,
            top_k: providerRequestBody.top_k,
            frequency_penalty: providerRequestBody.frequency_penalty,
            presence_penalty: providerRequestBody.presence_penalty,
            repetition_penalty: providerRequestBody.repetition_penalty,
            max_tokens: providerRequestBody.max_tokens,
          });
        }
        // Если есть streamCallbacks — стримим и собираем, иначе обычный запрос
        const response = streamCallbacks
          ? await streamAndAssemble(client, providerRequestBody, model, streamCallbacks, signal)
          : await client.chat.completions.create({ ...providerRequestBody, model } as any, signal ? { signal } : {});
        return { response, modelUsed: model, failedModels };
      } catch (err) {
        if (isAbortError(err)) throw err;
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
          await abortableSleep(RETRY_SECONDS * 1000, signal);
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

const createCompletionWithProProviderFallback = async (requestBody: Record<string, unknown>, signal?: AbortSignal, reasoningLevel?: ReasoningLevel | null, modelSettings?: ModelSettings | null, streamCallbacks?: StreamCallbacks) => {
  const failedProviders: string[] = [];
  const failedModels: string[] = [];

  for (const provider of PRO_PROVIDERS) {
    try {
      console.warn('[ai] trying pro provider', {
        provider: provider.name,
        baseURL: provider.baseURL,
        models: provider.modelChain
      });
      const completion = await createCompletionWithModelFallback(provider.client, provider.modelChain, requestBody, provider.name, provider.baseURL, signal, reasoningLevel, modelSettings, streamCallbacks);
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
      if (isAbortError(err)) throw err;
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

const createCompletionWithLiteProviderFallback = async (requestBody: Record<string, unknown>, signal?: AbortSignal, reasoningLevel?: ReasoningLevel | null, modelSettings?: ModelSettings | null, streamCallbacks?: StreamCallbacks) => {
  const failedProviders: string[] = [];
  const failedModels: string[] = [];

  for (const provider of LITE_PROVIDERS) {
    try {
      console.warn('[ai] trying lite provider', {
        provider: provider.name,
        baseURL: provider.baseURL,
        models: provider.modelChain
      });
      const completion = await createCompletionWithModelFallback(provider.client, provider.modelChain, requestBody, provider.name, provider.baseURL, signal, reasoningLevel, modelSettings, streamCallbacks);
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
      if (isAbortError(err)) throw err;
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

/**
 * Lightweight AI call — single-turn, no tools, no DB, no streaming.
 * Uses LITE providers for speed. Returns the text content of the first choice.
 */
export const callLiteAi = async (systemPrompt: string, userPrompt: string): Promise<string> => {
  const requestBody: Record<string, unknown> = {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    max_tokens: 4096,
    temperature: 0.7
  };

  const meta = await createCompletionWithLiteProviderFallback(requestBody, undefined, 'none');
  const msg = meta.response?.choices?.[0]?.message;
  const content = msg?.content;
  if (typeof content !== 'string' || !content.trim()) {
    console.warn('[callLiteAi] empty response', { content: msg?.content, reasoning: (msg as any)?.reasoning, model: meta.modelUsed, provider: meta.providerUsed });
    throw new Error('empty_lite_response');
  }
  return content.trim();
};

// Сборка system prompt вынесена в system-prompt.ts (используется также в chats.ts
// для подсчёта токенов — без циклической зависимости).
import { buildSystemPrompt } from './system-prompt.js';

const isLitePlan = (plan: UserPlan) => plan === 'free' || plan === 'standart';
const toRubFromTokens = (tokens: number) => Math.max(0, tokens) * RUB_PER_TOKEN;

const extractReasoning = (message: any, response?: any): string | null => {
  if (!message) return null;
  // DeepSeek native / vLLM style
  if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) return message.reasoning_content;
  // OpenRouter normalized / vLLM
  if (typeof message.reasoning === 'string' && message.reasoning.trim()) return message.reasoning;
  // Anthropic-style content blocks (if proxied into message.content array)
  if (Array.isArray(message.content)) {
    const thinking = message.content
      .filter((p: any) => p?.type === 'thinking' && typeof p.thinking === 'string')
      .map((p: any) => p.thinking)
      .join('\n\n');
    if (thinking.trim()) return thinking;
  }
  // OpenAI Responses API shape, if proxied into the raw response.
  if (Array.isArray(response?.output)) {
    const reasoning = response.output
      .filter((item: any) => item?.type === 'reasoning')
      .map((item: any) => {
        if (typeof item.summary === 'string') return item.summary;
        if (Array.isArray(item.summary)) return item.summary.map((s: any) => s?.text ?? '').join('\n');
        return '';
      })
      .join('\n\n');
    if (reasoning.trim()) return reasoning;
  }
  return null;
};

const formatToolResultPreview = (value: string): string | undefined => {
  const text = `${value || ''}`.trim();
  if (!text) return undefined;
  if (text.length <= TOOL_RESULT_PREVIEW_MAX) return text;
  return `${text.slice(0, TOOL_RESULT_PREVIEW_MAX)}\n\n...[truncated ${text.length - TOOL_RESULT_PREVIEW_MAX} chars]`;
};

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

const getUserTimePayload = (timezoneOffset: number) => {
  const now = new Date();
  const localTime = new Date(now.getTime() + timezoneOffset * 3600 * 1000);
  const sign = timezoneOffset >= 0 ? '+' : '';
  return {
    unix_time_seconds: Math.floor(now.getTime() / 1000),
    local_time: localTime.toISOString().replace('T', ' ').slice(0, 19),
    timezone_offset: timezoneOffset,
    timezone_label: `UTC${sign}${timezoneOffset}`,
    scheduling_hint: 'Для schedule_task предпочитай local_time (HH:MM) или delay_seconds.'
  };
};

/** Промпт для Dice Roll Mode. Держим в конце system prompt, потому что значение меняется каждый запрос. */
const buildDiceRollPrompt = (diceRoll: number) => `
[DICE ROLL MODE: ACTIVE]
The user rolled a d20 dice for this specific message.
Dice Roll Result: ${diceRoll} out of 20.

You MUST adapt the narrative tone and flavor of your response based strictly on this result:
- 1 (Critical Failure): Describe the attempt as an epic, ridiculous, or hilarious disaster. Let the tone be dramatic, absurd, sarcastic, or darkly humorous as appropriate to the scene.
- 2–9 (Failure): The action failed, ran into annoying obstacles, or turned out clumsy and poorly executed.
- 10–19 (Success): Everything went smoothly. Standard, successful and clean execution.
- 20 (Critical Success): Absolute triumph! Execute the task with epic grandeur, highly praise the user, or drop a fun easter egg.

It MUST SEVERELY affect the story. This is the PRIORITY.

CRITICAL SYSTEM RULE: Regardless of the roll result (even on a 1), if a tool call is required to fulfill the user's request, you MUST still initiate and execute the tool call normally to process actual data. The dice roll affects ONLY your narrative style and how you flavor the outcome, but it MUST NOT sabotage, block, or bypass the actual system mechanics or tool execution.
`;

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

const runWebSearch = async (query: string, signal?: AbortSignal) => {
  if (!TAVILY_API_KEY) return 'Ошибка инструмента: поисковый сервис временно недоступен.';

  try {
    throwIfAborted(signal);
    const response = await fetch(`${TAVILY_API_BASE_URL}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TAVILY_API_KEY}`,
        'X-Client-Source': 'chatter-backend'
      },
      body: JSON.stringify({
        query,
        search_depth: 'basic',
        max_results: 3,
        include_answer: true
      }),
      signal
    });

    if (!response.ok) {
      throw new Error(`tavily_http_${response.status}`);
    }

    const data = await response.json() as {
      answer?: string;
      results?: Array<{ title?: string; content?: string; url?: string }>;
    };
    const results = Array.isArray(data.results) ? data.results : [];

    if (!results.length) {
      return `По запросу "${query}" ничего не найдено.`;
    }

    let resultText = data.answer ? `Сводка: ${data.answer}\n\n` : '';
    resultText += results.map((item, index) => `${index + 1}. ${item.title || 'Без названия'}\n${item.content || ''}\nИсточник: ${item.url || '-'}`).join('\n\n');
    return resultText;
  } catch (err) {
    if (isAbortError(err)) throw err;
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

const getRejectionComment = (err: any): string | undefined => {
  const raw = typeof err?.message === 'string' ? err.message : '';
  if (!raw.startsWith('rejected_by_user')) return undefined;
  const comment = raw.slice('rejected_by_user'.length).replace(/^:/, '').trim();
  return comment || undefined;
};

const withRejectionComment = <T extends Record<string, unknown>>(payload: T, err: any): T => {
  const comment = getRejectionComment(err);
  return comment ? { ...payload, user_comment: comment } : payload;
};

const waitForHitlConfirmation = async <T>(userId: number, promise: Promise<T>): Promise<T> => {
  activeHitlWaits.add(userId);
  try {
    return await promise;
  } finally {
    activeHitlWaits.delete(userId);
  }
};

export const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'get_user_time',
      description: 'Возвращает текущее Unix-время и локальное время пользователя. Используй, когда нужно узнать текущую дату/время или перед планированием задач.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_avatar_state',
      description: 'Возвращает текущее состояние пиксельного аватара и доступные mood/reaction значения. Используй, когда нужно узнать состояние аватара перед изменением или синхронизацией.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
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
      name: 'get_smart_devices',
      description: 'Возвращает список всех устройств умного дома пользователя с их ID, названиями, комнатами и возможностями. ВЫЗЫВАЙ ПЕРВЫМ, если не знаешь точный device_id устройства.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'control_smart_home',
      description: 'Управляет устройством умного дома по его device_id. Сначала вызови get_smart_devices, чтобы получить ID нужного устройства.',
      parameters: {
        type: 'object',
        properties: {
          device_id: {
            type: 'string',
            description: 'ID устройства, полученный из get_smart_devices (например, "yandex_group_d3866e23-..." или "yandex_device_65b9c366-...").'
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
        required: ['device_id', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'schedule_task',
      description: 'Создает задачу по времени (одноразовую или по расписанию): напоминания, отложенные команды умного дома, запуск AI-инструкций. Для времени предпочитай local_time (HH:MM) или delay_seconds, не вычисляй Unix timestamp вручную.',
      parameters: {
        type: 'object',
        properties: {
          local_time: { type: 'string', description: 'Локальное время пользователя в формате HH:MM, например 02:07.' },
          delay_seconds: { type: 'number', description: 'Задержка в секундах от текущего момента, например 60.' },
          execute_at: { type: 'number', description: 'Legacy-поле: Unix timestamp в секундах. Используй только если local_time/delay_seconds не подходят.' },
          task_type: { type: 'string', enum: ['message', 'smart_home', 'ai_instruction'], description: 'message - напоминание, smart_home - команда умного дома, ai_instruction - запуск AI-инструкции по расписанию (поиск в интернете, проверка почты, анализ данных и т.д. — AI сам вызовет нужные инструменты).' },
          payload: { type: 'string', description: 'Для message: текст напоминания. Для smart_home: JSON-строка вида {"device_id":"yandex_group_...","action":"on"|"off"|"set_color"|"set_brightness","color":"#RRGGBB","brightness":50}. Для ai_instruction: текст инструкции, которую AI выполнит по расписанию.' },
          target_chat_id: { type: 'number', description: 'ID чата, в который будет сохранён и отправлен результат задачи (только для ai_instruction). Если не указан — используется активный чат.' },
          create_new_chat: { type: 'boolean', description: 'Создать новый чат для результата задачи (только для ai_instruction). Если true — будет создан новый чат. target_chat_id игнорируется.' },
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
  },
  {
    type: 'function',
    function: {
      name: 'get_exchange_rates',
      description: 'Получить актуальный курс валют ЦБ РФ (доллар, евро, юань и т.д.) и динамику изменения по сравнению с предыдущим днём. Используй когда пользователь спрашивает про курс валют, конвертацию, стоимость доллара/евро и т.п.',
      parameters: {
        type: 'object',
        properties: {
          currency_codes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Массив трехбуквенных кодов валют: USD, EUR, CNY, KZT и т.д. Если пользователь не указал конкретную валюту — верни USD и EUR.'
          }
        }
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

/** Build list_my_macros tool — lets AI discover user's available macros */
const buildListMyMacrosTool = () => {
  return {
    type: 'function' as const,
    function: {
      name: 'list_my_macros',
      description: `Показывает список макросов пользователя (наборов консольных команд). Вызывай когда пользователь просит выполнить макрос, спрашивает какие макросы есть, или когда нужно выяснить есть ли подходящий макрос для задачи. После получения списка используй execute_macro для запуска конкретного макроса.`,
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  };
};

/** Build execute_macro tool — lets AI run a user-defined macro via desktop_action SSE */
const buildExecuteMacroTool = () => {
  return {
    type: 'function' as const,
    function: {
      name: 'execute_macro',
      description: `Запускает пользовательский макрос (набор консольных команд) по его названию или идентификатору. Макрос выполняется на стороне десктоп-клиента. Используй, когда пользователь просит выполнить ранее сохранённый макрос или серию команд.`,
      parameters: {
        type: 'object',
        properties: {
          macro_id: {
            type: 'number',
            description: 'Идентификатор макроса (если известен).'
          },
          macro_name: {
            type: 'string',
            description: 'Название макроса для поиска.'
          }
        },
        required: []
      }
    }
  };
};

/** Build explore_fs tool — lets AI request directory listing from desktop */
const buildExploreFsTool = () => {
  return {
    type: 'function' as const,
    function: {
      name: 'explore_fs',
      description: `Читает содержимое директории на компьютере пользователя. Возвращает список файлов и папок с информацией о размере. Используй когда нужно узнать структуру каталога, найти файл или помочь пользователю с навигацией по файловой системе. Работает только в режиме чтения (ls).`,
      parameters: {
        type: 'object',
        properties: {
          target_path: {
            type: 'string',
            description: 'Абсолютный путь к директории для чтения (например, "C:\\Users" или "/home/user").'
          }
        },
        required: ['target_path']
      }
    }
  };
};

/** Build suggest_macro tool — lets AI offer user to save a new macro */
const buildSuggestMacroTool = () => {
  return {
    type: 'function' as const,
    function: {
      name: 'suggest_macro',
      description: `Предлагает пользователю сохранить новый макрос (набор команд). Используй когда помогаешь пользователю составить скрипт/серию команд и хочешь предложить сохранить это как макрос для повторного использования.`,
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Предлагаемое название макроса (короткое, до 5 слов).'
          },
          description: {
            type: 'string',
            description: 'Описание макроса (1-2 предложения).'
          },
          commands: {
            type: 'array',
            items: { type: 'string' },
            description: 'Массив команд макроса.'
          }
        },
        required: ['title', 'commands']
      }
    }
  };
};

// ── DevOps tools (desktop-only) ──────────────────────────────────────────────

const buildListDevopsServersTool = () => {
  return {
    type: 'function' as const,
    function: {
      name: 'list_devops_servers',
      description: `Показывает список серверов пользователя (id, name, host, username). Используй, когда пользователь упоминает сервер или просит выполнить команду на удалённом сервере.`,
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  };
};

const buildExecuteSshCommandTool = () => {
  return {
    type: 'function' as const,
    function: {
      name: 'execute_ssh_command',
      description: `Выполняет команду на удалённом сервере через SSH. Бэкенд подключается к серверу, выполняет команду и возвращает stdout/stderr.
Используй когда пользователь просит:
- Выполнить команду на сервере (ls, pm2 status, systemctl status, df -h и т.д.)
- Проверить состояние сервера или сервисов
- Посмотреть логи, процессы, дисковое пространство

Важно: если команда неизвестна или может быть опасной — пользователь должен подтвердить выполнение на десктопе.`,
      parameters: {
        type: 'object',
        properties: {
          server_id: {
            type: 'number',
            description: 'ID сервера (получи из list_devops_servers если не известен).'
          },
          command: {
            type: 'string',
            description: 'Команда для выполнения на сервере (например "ls -la /var/log" или "pm2 status").'
          }
        },
        required: ['server_id', 'command']
      }
    }
  };
};

/** Build execute_pc_command tool — lets AI execute commands on user's PC via desktop IPC */
const buildExecutePcCommandTool = () => {
  return {
    type: 'function' as const,
    function: {
      name: 'execute_pc_command',
      description: `Выполняет команду на компьютере пользователя (не на сервере!). Команда запускается через терминал/консоль на ПК пользователя.
Используй когда:
- Пользователь просит выполнить что-то локально на его компьютере (открыть программу, посмотреть файлы, запустить скрипт)
- Нужно узнать информацию о системе (ipconfig, systeminfo, tasklist, dir и т.д.)
- Пользователь просит помочь с файлами на его ПК

Важно: неизвестные или потенциально опасные команды требуют подтверждения пользователя на десктопе.`,
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Команда для выполнения на ПК пользователя (например "dir C:\\Users", "tasklist", "ipconfig").'
          },
          background: {
            type: 'boolean',
            description: 'Set to true ONLY if opening a UI application (like notepad, browser) where you do not need to read the console output. Default is false.'
          }
        },
        required: ['command']
      }
    }
  };
};

/** Build read_file tool — reads a file on user's PC natively via Node.js fs (no terminal) */
const buildReadFileTool = () => {
  return {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: `Читает содержимое файла на компьютере пользователя нативно через Node.js fs (в обход терминала, без проблем с кодировками).
Поддерживает текстовые файлы (.txt, .md, .log, .json, .js, .ts, .py, .yaml, .xml и т.д.) и документы Word (.docx).
Для .docx текст извлекается через mammoth — возвращается чистый текст без форматирования.
Используй когда:
- Нужно прочитать содержимое файла (код, конфиг, лог, текст, Word-документ)
- Пользователь просит показать или проанализировать файл
- Нужно прочитать часть большого файла (постранично)
- Нужно узнать точные номера строк перед использованием edit_file_lines

Возвращает UTF-8 текст с указанием номера начальной строки и общего количества строк.
Поддерживает пагинацию: если файл большой, читай его частями через start_line/max_lines.

ВАЖНО для edit_file_lines: Перед редактированием ВСЕГДА вызывай read_file с line_numbers=true и нужным start_line/max_lines, чтобы увидеть точные номера строк. Это исключит ошибки при указании start_line/end_line в edit_file_lines.`,
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Полный путь к файлу на ПК пользователя (например "C:\\\\Users\\\\user\\\\file.txt" или "/home/user/file.txt").'
          },
          start_line: {
            type: 'number',
            description: 'С какой строки начинать чтение (нумерация с 1). По умолчанию 1. Используй для чтения конкретного фрагмента файла.'
          },
          max_lines: {
            type: 'number',
            description: 'Сколько строк прочитать (по умолчанию 500, максимум 2000). Чтобы прочитать строки 10–25: start_line=10, max_lines=16.'
          },
          line_numbers: {
            type: 'boolean',
            description: 'Если true — каждая строка в контенте будет иметь префикс с номером строки (формат: "     1\\tсодержимое"). Обязательно используй true перед edit_file_lines, чтобы увидеть точные номера строк. По умолчанию false.'
          }
        },
        required: ['file_path']
      }
    }
  };
};

/** Build search_file_keywords tool — searches matching lines in a file on user's PC */
const buildSearchFileKeywordsTool = () => {
  return {
    type: 'function' as const,
    function: {
      name: 'search_file_keywords',
      description: `Ищет ключевые слова или фразы в конкретном файле на компьютере пользователя и возвращает только строки с совпадениями и их номерами.
Используй, когда файл слишком большой, чтобы читать его целиком через read_file, или когда нужно быстро найти место в логе/коде/тексте.
Поиск регистронезависимый. Для чтения контекста вокруг найденных строк после этого используй read_file со start_line/max_lines.`,
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Полный путь к файлу на ПК пользователя.'
          },
          query: {
            type: 'string',
            description: 'Ключевое слово или фраза для поиска.'
          },
          max_matches: {
            type: 'number',
            description: 'Максимум совпадений вернуть (по умолчанию 100, максимум 500).'
          }
        },
        required: ['file_path', 'query']
      }
    }
  };
};

/** Build get_file_info tool — returns metadata for a path on user's PC without reading content */
const buildGetFileInfoTool = () => {
  return {
    type: 'function' as const,
    function: {
      name: 'get_file_info',
      description: `Возвращает метаданные файла или папки на компьютере пользователя без чтения содержимого: существует ли путь, тип, размер в байтах, даты изменения/создания, расширение.
Используй перед read_file/search_file_keywords, когда нужно понять размер файла или проверить путь без загрузки содержимого.`,
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Полный путь к файлу или папке на ПК пользователя.'
          },
          include_line_count: {
            type: 'boolean',
            description: 'Если true и путь указывает на файл, дополнительно посчитать количество строк. Это читает файл построчно, поэтому используй только когда число строк действительно нужно.'
          }
        },
        required: ['file_path']
      }
    }
  };
};

/** Build write_file tool — writes content to a file on user's PC natively via Node.js fs (no terminal) */
const buildWriteFileTool = () => {
  return {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: `Записывает содержимое в файл на компьютере пользователя нативно через Node.js fs (в обход терминала, без лимитов длины команды).
Поддерживает запись в .docx — создаёт валидный Word-документ из переданного текста (каждая строка = отдельный абзац).
ВНИМАНИЕ: Для файлов .docx поддерживается ТОЛЬКО режим 'overwrite'. Если нужно дописать текст в существующий .docx, сначала полностью прочитай его через read_file, добавь нужный текст и вызови write_file с режимом 'overwrite'.
Используй когда:
- Нужно создать или перезаписать файл (код, конфиг, текст, Word-документ)
- Пользователь просит сохранить что-то в файл
- Нужно дописать данные в конец существующего текстового файла (mode: append)

Всегда требует подтверждения пользователя (HitL-карточка).
Запись в системные директории (C:\\Windows, /etc, /usr, /bin) заблокирована.`,
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Полный путь к файлу на ПК пользователя (например "C:\\\\Users\\\\user\\\\new_file.txt" или "/home/user/script.sh").'
          },
          content: {
            type: 'string',
            description: 'Содержимое для записи в файл (UTF-8 текст).'
          },
          mode: {
            type: 'string',
            enum: ['overwrite', 'append'],
            description: 'Режим записи: "overwrite" (перезаписать файл целиком, по умолчанию) или "append" (дописать в конец).'
          }
        },
        required: ['file_path', 'content']
      }
    }
  };
};

/** Build edit_file_lines tool — surgically replace specific lines in a file */
const buildEditFileLinesTool = () => {
  return {
    type: 'function' as const,
    function: {
      name: 'edit_file_lines',
      description: `Точечно заменяет строки в файле на новый текст. Работает как хирургический скальпель — не перезаписывает файл целиком.
Поддерживает текстовые файлы (.txt, .md, .log, .json, .js, .ts, .py и т.д.). Для .docx используй read_file + write_file (overwrite).

ВАЖНО: Сначала ВСЕГДА используй read_file (с start_line и max_lines), чтобы узнать точные номера строк. Нумерация строк начинается с 1.

Сценарии:
- Заменить строки 10-15 на новый текст: start_line=10, end_line=15, new_content="новый текст"
- Вставить текст после строки 5 (без удаления): start_line=6, end_line=5, new_content="вставленный текст"
- Удалить строки 20-30: start_line=20, end_line=30, new_content=""

Всегда требует подтверждения пользователя (HitL-карточка с diff-превью).`,
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Полный путь к файлу на ПК пользователя.'
          },
          start_line: {
            type: 'number',
            description: 'Номер строки, с которой начать замену (включительно, нумерация с 1).'
          },
          end_line: {
            type: 'number',
            description: 'Номер строки, на которой закончить замену (включительно). Чтобы вставить текст без удаления, укажи end_line = start_line - 1.'
          },
          new_content: {
            type: 'string',
            description: 'Новый текст для вставки вместо старых строк. Пустая строка = удаление строк.'
          }
        },
        required: ['file_path', 'start_line', 'end_line', 'new_content']
      }
    }
  };
};

/** Build capture_screen tool — captures screenshot, sends to vision model with purpose */
const buildCaptureScreenTool = () => {
  return {
    type: 'function' as const,
    function: {
      name: 'capture_screen',
      description: `Делает скриншот экрана пользователя и отправляет его vision-модели для анализа.
Используй когда:
- Нужно найти элемент на экране и получить его координаты
- Нужно описать что находится на экране
- Нужно определить текущее состояние интерфейса

В параметре purpose укажи чёткую задачу для vision-модели.
В ответ получишь текстовый результат (координаты, описание и т.д.).
Координаты возвращаются в нормализованном виде (0.0–1.0) — используй их в execute_visual_click.`,
      parameters: {
        type: 'object',
        properties: {
          purpose: {
            type: 'string',
            description: 'Задача для vision-модели. Например: "Найди кнопку Сохранить и верни её координаты" или "Опиши подробно что открыто на экране" или "Найди поле ввода поиска".'
          }
        },
        required: ['purpose']
      }
    }
  };
};

/** Build execute_visual_click tool — lets AI click at normalized coordinates */
const buildExecuteVisualClickTool = () => {
  return {
    type: 'function' as const,
    function: {
      name: 'execute_visual_click',
      description: `Кликает мышкой по указанной точке на экране пользователя. Координаты — нормализованные (0.0–1.0), где (0,0) — левый верхний угол монитора, (1,1) — правый нижний.
Сначала вызови capture_screen чтобы получить display_id и скриншоты, затем определи точку клика по скриншоту и вызови этот инструмент.
Требует подтверждения пользователя (через Telegram inline-кнопки).

Параметры:
- display_id: ID монитора из capture_screen
- x: нормализованная X координата (0.0–1.0)
- y: нормализованная Y координата (0.0–1.0)
- button: "left" (по умолчанию) или "right"
- reason: короткое объяснение зачем клик (показывается пользователю в карточке подтверждения)`,
      parameters: {
        type: 'object',
        properties: {
          display_id: {
            type: 'string',
            description: 'ID монитора (из ответа capture_screen).'
          },
          x: {
            type: 'number',
            description: 'Нормализованная X координата клика (0.0 = левый край, 1.0 = правый край).'
          },
          y: {
            type: 'number',
            description: 'Нормализованная Y координата клика (0.0 = верх, 1.0 = низ).'
          },
          button: {
            type: 'string',
            enum: ['left', 'right'],
            description: 'Кнопка мыши: left или right. По умолчанию left.'
          },
          reason: {
            type: 'string',
            description: 'Короткое объяснение зачем этот клик (показывается пользователю для подтверждения). Например: "Нажать кнопку Сохранить".'
          }
        },
        required: ['display_id', 'x', 'y']
      }
    }
  };
};

const buildListRunbooksTool = () => {
  return {
    type: 'function' as const,
    function: {
      name: 'list_devops_runbooks',
      description: `Показывает список сохранённых инструкций (runbooks) пользователя. Runbook — это пошаговое руководство для типовых DevOps-задач. Используй перед выполнением сложных операций, чтобы проверить нет ли готовой инструкции.`,
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  };
};

const buildReadRunbookTool = () => {
  return {
    type: 'function' as const,
    function: {
      name: 'read_devops_runbook',
      description: `Читает содержимое конкретного runbook (инструкции). Возвращает пошаговое руководство в Markdown. Следуй инструкции шаг за шагом, вызывая execute_ssh_command для каждого шага.`,
      parameters: {
        type: 'object',
        properties: {
          runbook_id: {
            type: 'number',
            description: 'ID runbook (получи из list_devops_runbooks).'
          }
        },
        required: ['runbook_id']
      }
    }
  };
};

const buildSuggestRunbookTool = () => {
  return {
    type: 'function' as const,
    function: {
      name: 'suggest_devops_runbook',
      description: `Предлагает пользователю сохранить DevOps-инструкцию (runbook). Используй когда составил план действий на сервере — последовательность команд для типовой задачи. Пользователь может сохранить её и привязать к серверу.`,
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Название инструкции (короткое, до 5 слов).'
          },
          content: {
            type: 'string',
            description: 'Текст инструкции в Markdown с пошаговым описанием.'
          },
          commands: {
            type: 'array',
            items: { type: 'string' },
            description: 'Массив shell-команд из инструкции.'
          }
        },
        required: ['title', 'content', 'commands']
      }
    }
  };
};

const buildInstallSshPublicKeyTool = () => {
  return {
    type: 'function' as const,
    function: {
      name: 'install_ssh_public_key',
      description: `Устанавливает SSH-публичный ключ в authorized_keys указанного пользователя на сервере. Создаёт .ssh директорию, добавляет ключ, выставляет правильные права. Если key_id не указан — используется ключ по умолчанию для этого сервера.`,
      parameters: {
        type: 'object',
        properties: {
          server_id: {
            type: 'number',
            description: 'ID сервера (из list_devops_servers).'
          },
          key_id: {
            type: 'number',
            description: 'ID SSH-ключа для установки (опционально, по умолчанию берётся с сервера).'
          },
          target_user: {
            type: 'string',
            description: 'Имя пользователя на сервере, которому устанавливается ключ (например "root", "deploy").'
          }
        },
        required: ['server_id', 'target_user']
      }
    }
  };
};

const buildSuggestServerCredsUpdateTool = () => {
  return {
    type: 'function' as const,
    function: {
      name: 'suggest_server_creds_update',
      description: `Предлагает пользователю обновить учётные данные для подключения к серверу. Используй когда:
- Бот создал нового пользователя на сервере и хочет переключиться на него
- SSH-ключ установлен на нового пользователя, и нужно заходить по ключу вместо пароля
- Старый пользователь (например root) заблокирован, и нужно переключиться
Бот описывает предлагаемые изменения, пользователь подтверждает через HitL.`,
      parameters: {
        type: 'object',
        properties: {
          server_id: {
            type: 'number',
            description: 'ID сервера (из list_devops_servers).'
          },
          new_username: {
            type: 'string',
            description: 'Новый пользователь для SSH-подключения.'
          },
          reason: {
            type: 'string',
            description: 'Причина смены (например: "Создан новый пользователь deployer, root заблокирован").'
          },
          use_ssh_key: {
            type: 'boolean',
            description: 'Если true — включить вход по SSH-ключу (дефолтному ключу сервера), а не по паролю. Старое имя параметра, совместимо с use_ssh_key_for_login.'
          },
          use_ssh_key_for_login: {
            type: 'boolean',
            description: 'Если true — включить вход по SSH-ключу. Если false — оставить вход по паролю, но default SSH key останется выбранным для установки.'
          },
          remove_password: {
            type: 'boolean',
            description: 'Если true — удалить сохранённый пароль (оставить только SSH-ключ для входа).'
          }
        },
        required: ['server_id', 'new_username', 'reason']
      }
    }
  };
};

const buildCreateServerUserTool = () => {
  return {
    type: 'function' as const,
    function: {
      name: 'create_server_user',
      description: `Создаёт нового пользователя на удалённом сервере с sudo-правами. Использует sudo_password сервера как пароль для нового пользователя; если sudo_password не сохранён — пользователь введёт его в карточке подтверждения. NOPASSWD не включается по умолчанию: передавай nopasswd_sudo=true только если пользователь явно попросил sudo без пароля.`,
      parameters: {
        type: 'object',
        properties: {
          server_id: {
            type: 'number',
            description: 'ID сервера (из list_devops_servers).'
          },
          username: {
            type: 'string',
            description: 'Имя нового пользователя (например "deployer", "admin").'
          },
          install_ssh_key: {
            type: 'boolean',
            description: 'Установить дефолтный SSH-ключ сервера в authorized_keys нового пользователя (по умолчанию true).'
          },
          key_id: {
            type: 'number',
            description: 'ID SSH-ключа для установки (опционально, по умолчанию берётся ключ сервера).'
          },
          nopasswd_sudo: {
            type: 'boolean',
            description: 'Если true — добавить sudoers правило NOPASSWD для нового пользователя. По умолчанию false.'
          }
        },
        required: ['server_id', 'username']
      }
    }
  };
};

const buildChangeServerUserPasswordTool = () => {
  return {
    type: 'function' as const,
    function: {
      name: 'change_server_user_password',
      description: `Меняет пароль существующего Linux-пользователя на сервере. Пароль НЕ передаётся ботом в аргументах: пользователь вводит новый пароль в карточке подтверждения. Используй, когда пользователь просит сменить/задать пароль существующему пользователю.`,
      parameters: {
        type: 'object',
        properties: {
          server_id: {
            type: 'number',
            description: 'ID сервера (из list_devops_servers).'
          },
          username: {
            type: 'string',
            description: 'Имя существующего пользователя, которому нужно сменить пароль.'
          }
        },
        required: ['server_id', 'username']
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

const buildInvokeSubagentTool = () => {
  const names = listSubagentNames();
  if (names.length === 0) return null; // no subagents configured

  return {
    type: 'function' as const,
    function: {
      name: 'invoke_subagent',
      description:
        'Передай задачу специализированному агенту (субагенту). Субагент имеет свой промпт, ' +
        'набор инструментов и ограничения. Используй для узкоспециализированных задач, ' +
        'где нужна экспертиза конкретного агента.\n\n' +
        'ВАЖНО: Сначала выполни общие задачи сам (установка ПО, создание юзеров, настройка сервера), ' +
        'затем вызови субагента для специфичной части.\n\n' +
        'Доступные субагенты:\n' + buildSubagentListDescription(),
      parameters: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            description: 'Имя субагента',
            enum: names,
          },
          task: {
            type: 'string',
            description: 'Чёткое описание задачи для субагента',
          },
          context: {
            type: 'object',
            description: 'Дополнительные данные для субагента (JSON-объект с контекстом)',
          },
        },
        required: ['agent', 'task'],
      },
    },
  };
};

/**
 * Build the `spawn_subagent` tool — lets the main agent create an ad-hoc subagent
 * with a custom system prompt, a subset of tools, and iteration limit.
 *
 * Unlike `invoke_subagent` (which uses the static registry), this tool creates a
 * brand new subagent on the fly. The main agent specifies exactly which tools the
 * subagent can use, what its system prompt is, and how many iterations it may take.
 */
const buildSpawnSubagentTool = (availableToolDefs?: any[]): any => {
  // Build a list of all available tool names (excluding recursive spawning).
  // If availableToolDefs (the full runtime executionTools) is provided, use it;
  // otherwise fall back to the static toolDefinitions array.
  const source = availableToolDefs || toolDefinitions;
  const availableToolNames = source
    .map((t: any) => t?.function?.name)
    .filter((n: string | undefined) => n && n !== 'spawn_subagent' && n !== 'invoke_subagent');

  return {
    type: 'function' as const,
    function: {
      name: 'spawn_subagent',
      description:
        'Создай и запусти нового субагента «на лету» с твоим собственным системным промптом, ' +
        'опциональным набором инструментов и лимитом итераций. Субагент выполнит узкую задачу и вернёт результат.\n\n' +
        'Используй когда: задача требует специализированного подхода, отдельного анализа или конкретного набора инструментов, ' +
        'и нет готового субагента в реестре. Субагент НЕ может вызывать других субагентов.\n\n' +
        `Доступные инструменты для передачи субагенту: ${availableToolNames.join(', ')}`,
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'Чёткое описание задачи для субагента',
          },
          system_prompt: {
            type: 'string',
            description: 'Системный промпт субагента — его роль, инструкции, ограничения. Если опустить — будет использован дефолтный промпт общего ассистента.',
          },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Опциональный массив имён инструментов которые субагент может использовать. Если не указан или пустой, субагент работает без инструментов.',
          },
          max_loops: {
            type: 'number',
            description: 'Максимум итераций цикла субагента (1–50, по умолчанию 20)',
          },
        },
        required: ['task'],
      },
    },
  };
};

const buildLiteExecutionTools = (allowedToolNames: string[]) => {
  const allowed = new Set(allowedToolNames);
  const filtered = toolDefinitions.filter(t => allowed.has(`${(t as any)?.function?.name || ''}`)) as any[];
  return [...filtered, ESCALATE_TO_PRO_TOOL as any];
};
export const runCompletion = async (mode: 'pro' | 'lite' | 'vision-pro' | 'vision-lite', requestPayload: Record<string, unknown>, manualModel?: ManualModelEntry, signal?: AbortSignal, reasoningLevel?: ReasoningLevel | null, modelSettings?: ModelSettings | null, streamCallbacks?: StreamCallbacks): Promise<CompletionMeta & { manualFallback?: boolean }> => {
  // Если юзер выбрал конкретную модель — шлём напрямую, игнорируя mode
  if (manualModel) {
    try {
      const completion = await createCompletionWithModelFallback(manualModel.client, [manualModel.apiModelName], requestPayload, 'manual', manualModel.baseURL, signal, reasoningLevel, modelSettings, streamCallbacks);
      return {
        response: completion.response,
        usedModel: completion.modelUsed,
        usedProvider: 'manual',
        baseURLUsed: manualModel.baseURL,
        failedModels: completion.failedModels,
        manualFallback: false,
      };
    } catch (err: any) {
      if (isAbortError(err)) throw err;
      console.warn(`[ai] manual model "${manualModel.apiModelName}" failed, falling back to auto`, err?.message || err);
      // Не бросаем ошибку — fallback на обычный роутинг
      // Продолжаем выполнение ниже как будто manualModel не задан
      // При fallback на auto — modelSettings не применяются (только для ручной модели)
      // При fallback на auto — стримКолбеки тоже не пробрасываем (см. ниже)
    }
  }

  if (mode === 'vision-pro' || mode === 'vision-lite') {
    const providers = mode === 'vision-pro' ? VISION_PROVIDERS.pro : VISION_PROVIDERS.lite;
    if (!providers.length) {
      // Vision без провайдеров → fallback на обычный режим, стрим не нужен
      return runCompletion(mode === 'vision-pro' ? 'pro' : 'lite', requestPayload, undefined, signal, reasoningLevel);
    }
    const failedProviders: string[] = [];
    const failedModels: string[] = [];
    for (const provider of providers) {
      try {
        // Vision-запросы не стримим (анализ фото — не диалог)
        const completion = await createCompletionWithModelFallback(provider.client, provider.modelChain, requestPayload, provider.name, provider.baseURL, signal, reasoningLevel);
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
        if (isAbortError(err)) throw err;
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
      const res = await createCompletionWithProProviderFallback(requestPayload, signal, reasoningLevel, modelSettings, streamCallbacks);
      return {
        response: res.response,
        usedModel: res.modelUsed,
        usedProvider: res.providerUsed,
        baseURLUsed: res.baseURLUsed,
        failedModels: res.failedModels,
        failedProviders: res.failedProviders
      };
    }
    const res = await createCompletionWithModelFallback(PRO_CLIENT, PRO_MODEL_CHAIN, requestPayload, 'pro-main', '', signal, reasoningLevel, modelSettings, streamCallbacks);
    return {
      response: res.response,
      usedModel: res.modelUsed,
      usedProvider: 'pro-main',
      baseURLUsed: process.env.TIMEWEB_BASE_URL || '',
      failedModels: res.failedModels
    };
  }
  const res = await createCompletionWithLiteProviderFallback(requestPayload, signal, reasoningLevel, modelSettings, streamCallbacks);
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

export const runTool = async (user: UserRecord, timezoneOffset: number, toolName: string, argsRaw: string, aiCall: (requestPayload: Record<string, unknown>) => Promise<CompletionMeta>, generatedImages?: Array<{ image_base64: string; image_url?: string; prompt_used: string }>, displayStateSink?: { value: DisplayStatePayload | null }, desktopActionSink?: { value: DesktopActionPayload | null }, mapUpdateSink?: { value: MapUpdatePayload | null }, activeMacros?: Array<{ id: number; title: string; description?: string; commands: string[]; pinned?: boolean; return_output?: boolean }>, signal?: AbortSignal, subagentExtra?: { manualModel?: any; subagentMode?: 'auto' | 'manual'; subagentReasoningLevel?: ReasoningLevel | null; onToolStatus?: (text: string) => Promise<void> | void; onDesktopAction?: (action: any) => Promise<void> | void; displayManifest?: { moods?: string[]; reactions?: string[] } | null; currentDisplayState?: DisplayStatePayload | null; onSubagentTrace?: (trace: any) => void; availableToolDefs?: any[] }, autoRejectHitl?: boolean) => {
  throwIfAborted(signal);
  const parsed = JSON.parse(argsRaw || '{}');

  if (toolName === 'get_user_time') {
    return JSON.stringify(getUserTimePayload(timezoneOffset), null, 2);
  }

  if (toolName === 'get_avatar_state') {
    return JSON.stringify({
      current_state: displayStateSink?.value ?? subagentExtra?.currentDisplayState ?? null,
      state_source: displayStateSink?.value ? 'current_request' : (subagentExtra?.currentDisplayState ? 'client_snapshot' : 'unknown'),
      available_moods: subagentExtra?.displayManifest?.moods ?? [],
      available_reactions: subagentExtra?.displayManifest?.reactions ?? []
    }, null, 2);
  }

  if (toolName === 'search_web') {
    const query = `${parsed.query || ''}`.trim();
    if (!query) return 'Ошибка инструмента: пустой поисковый запрос.';
    const webLimit = checkWebSearchLimit(user);
    if (!webLimit.allowed) return webLimit.reason;
    incrementUserWebSearchUsage(user.id, 1);
    return runWebSearch(query, signal);
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

  if (toolName === 'get_smart_devices') return listSmartDevicesForAi(user.id);
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
    if (!['message', 'smart_home', 'ai_instruction'].includes(taskType)) return 'Ошибка: Некорректный task_type';
    let payload = `${parsed.payload || ''}`.trim();
    if (!payload) return 'Ошибка: payload_required';

    // Для ai_instruction: упаковываем target_chat_id / create_new_chat в payload JSON
    if (taskType === 'ai_instruction') {
      const targetChatId = Number.isFinite(Number(parsed.target_chat_id)) ? Math.floor(Number(parsed.target_chat_id)) : null;
      const createNewChat = parsed.create_new_chat === true;
      if (targetChatId !== null || createNewChat) {
        try {
          const payloadObj = JSON.parse(payload);
          if (targetChatId !== null) payloadObj._target_chat_id = targetChatId;
          if (createNewChat) payloadObj._create_new_chat = true;
          payload = JSON.stringify(payloadObj);
        } catch {
          // payload — не JSON, оборачиваем
          const payloadObj: Record<string, unknown> = { instruction: payload };
          if (targetChatId !== null) payloadObj._target_chat_id = targetChatId;
          if (createNewChat) payloadObj._create_new_chat = true;
          payload = JSON.stringify(payloadObj);
        }
      }
    }

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
  if (toolName === 'send_email') {
    const to: string = typeof parsed.to === 'string' ? parsed.to.trim() : '';
    const subject: string = typeof parsed.subject === 'string' ? parsed.subject.trim() : '';
    const body: string = typeof parsed.body === 'string' ? parsed.body : '';
    const provider: string = typeof parsed.provider === 'string' ? parsed.provider : '';

    // Basic validation before asking user
    if (!to || !subject || !body) return JSON.stringify({ status: 'error', message: 'Нужны to, subject и body.' });

    // Determine sender address for preview — same logic as runEmailSend uses
    let fromAddress = '';
    try {
      const { resolveUserMailAccount } = await import('./mail.js');
      const acct = resolveUserMailAccount(user.id, provider);
      fromAddress = acct?.imap_user || '';
    } catch { /* ignore — non-critical preview */ }

    // HitL confirmation: push via SSE callback (TG) and/or WS (desktop)
    const { randomUUID } = await import('node:crypto');
    const confirmationId = randomUUID();

    const emailAction = {
      type: 'desktop_action',
      action: 'email_confirmation' as const,
      target: 'email',
      value: {
        confirmation_id: confirmationId,
        from: fromAddress,
        to,
        subject,
        body,
        provider
      }
    };

    let emailSent = false;
    if (subagentExtra?.onDesktopAction) {
      await subagentExtra.onDesktopAction(emailAction);
      emailSent = true;
    } else if (isDesktopOnline(user.id)) {
      sendToDesktop(user.id, emailAction);
      emailSent = true;
    }
    if (!emailSent) {
      return JSON.stringify({ status: 'error', message: 'Ни один клиент не подключён. Подтверждение отправки письма невозможно.' });
    }

    // Auto-reject in scheduler mode
    if (autoRejectHitl) return JSON.stringify({ status: 'rejected', message: 'Task is running in auto-mode. Email sending confirmation was automatically rejected.', to, subject });

    // Wait for user response via WS/SSE → POST /api/v1/email/approve or /internal/email/approve
    const { registerPendingEmailConfirmation } = await import('./email-confirmations.js');
    try {
      // Email is sent by /approve endpoint (server.ts) which resolves this Promise with the result.
      // We must NOT call runEmailSend here — that would send the email a second time.
      const result = await new Promise<any>((resolve, reject) => {
        registerPendingEmailConfirmation(confirmationId, {
          userId: user.id,
          to,
          subject,
          body,
          provider,
          resolve,
          reject,
          createdAt: Date.now()
        });
      });
      return typeof result === 'string' ? result : JSON.stringify({ status: 'success', message: 'Письмо отправлено.', to, subject });
    } catch (err: any) {
      if (err?.message?.startsWith('rejected_by_user')) {
        return JSON.stringify(withRejectionComment({ status: 'rejected', message: 'Пользователь отклонил отправку письма.', to, subject }, err));
      }
      if (err?.message === 'confirmation_timeout' || err?.message === 'confirmation_expired') {
        return JSON.stringify({ status: 'timeout', message: 'Время ожидания подтверждения истекло (5 минут).', to, subject });
      }
      return JSON.stringify({ status: 'error', message: `Ошибка подтверждения: ${err?.message || String(err)}`, to, subject });
    }
  }
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

  // ── Macro tools (desktop-only) ──

  if (toolName === 'list_my_macros') {
    if (!activeMacros || activeMacros.length === 0) {
      return JSON.stringify({ macros: [], message: 'У пользователя нет активных макросов.' });
    }
    return JSON.stringify({
      macros: activeMacros.map(m => ({
        id: m.id,
        title: m.title,
        description: m.description || '',
        commands: m.commands,
      })),
      message: `Найдено ${activeMacros.length} макросов. Используй execute_macro чтобы запустить нужный.`
    });
  }

  if (toolName === 'execute_macro') {
    const macroId: number | undefined = typeof parsed.macro_id === 'number' ? parsed.macro_id : (typeof parsed.macro_id === 'string' ? Number(parsed.macro_id) : undefined);
    const macroName: string | undefined = typeof parsed.macro_name === 'string' ? parsed.macro_name : undefined;

    if (!macroId && !macroName) {
      return JSON.stringify({ status: 'error', message: 'macro_id или macro_name обязателен' });
    }

    // Find the macro to include its commands in the payload
    let matchedMacro = activeMacros?.find(m => m.id === macroId);
    if (!matchedMacro && macroName) {
      matchedMacro = activeMacros?.find(m => m.title?.toLowerCase() === macroName?.toLowerCase());
    }

    if (!matchedMacro) {
      return JSON.stringify({ status: 'error', message: `Макрос не найден${macroId ? ` (id=${macroId})` : macroName ? ` (${macroName})` : ''}` });
    }

    // If macro requires output — must have desktop online via WS
    if (matchedMacro.return_output) {
      if (isDesktopOnline(user.id)) {
        try {
          const result = await sendIpcToDesktop(user.id, 'execute_commands', { commands: matchedMacro.commands }, 30000, signal);
          const safeOutput = String(result || '').slice(-3000);
          return JSON.stringify({ status: 'success', logs: safeOutput, macro_id: matchedMacro.id, macro_name: matchedMacro.title });
        } catch (err: any) {
          return JSON.stringify({ status: 'error', message: err.message, macro_id: matchedMacro.id, macro_name: matchedMacro.title });
        }
      } else {
        return JSON.stringify({ status: 'error', message: 'Десктоп-клиент не в сети. Невозможно выполнить макрос с возвратом вывода — попроси пользователя запустить приложение на ПК.', macro_id: matchedMacro.id, macro_name: matchedMacro.title });
      }
    }

    // Fire-and-forget — send via desktopActionSink (SSE or WS callback)
    const payload: DesktopActionPayload = { action: 'execute_macro' };
    payload.target = String(matchedMacro.id);
    payload.value = { macro_name: matchedMacro.title, commands: matchedMacro.commands };

    if (desktopActionSink) desktopActionSink.value = payload;

    return JSON.stringify({ status: 'success', message: `Макрос "${matchedMacro.title}" отправлен на выполнение.`, macro_id: matchedMacro.id, macro_name: matchedMacro.title });
  }

  if (toolName === 'explore_fs') {
    const targetPath: string = typeof parsed.target_path === 'string' ? parsed.target_path : '';
    if (!targetPath) return JSON.stringify({ status: 'error', message: 'target_path обязателен' });

    // Check if user has enabled fs scan
    const { getPcCommandsSettings } = await import('./pc-commands.js');
    const pcSettings = getPcCommandsSettings(user.id);
    if (!pcSettings.fs_scan_enabled) {
      return JSON.stringify({ status: 'error', message: 'Чтение файловой системы отключено в настройках "Управление ПК". Попроси пользователя включить галочку "Разрешить ИИ сканировать файловую систему".' });
    }

    // If desktop is connected via WS — wait for result
    if (isDesktopOnline(user.id)) {
      try {
        const result = await sendIpcToDesktop(user.id, 'read_directory', { target_path: targetPath }, 30000, signal);
        return JSON.stringify({ status: 'success', entries: result, target_path: targetPath });
      } catch (err: any) {
        return JSON.stringify({ status: 'error', message: err.message, target_path: targetPath });
      }
    }

    // Fallback: fire-and-forget via desktopActionSink (SSE)
    const payload: DesktopActionPayload = { action: 'execute_macro', target: '__explore_fs__', value: { target_path: targetPath } };
    if (desktopActionSink) desktopActionSink.value = payload;

    return JSON.stringify({ status: 'success', message: `Запрос на чтение директории "${targetPath}" отправлен. Результат чтения будет доступен после подключения десктопа через WebSocket.`, target_path: targetPath });
  }

  if (toolName === 'get_file_info') {
    const filePath: string = typeof parsed.file_path === 'string' ? parsed.file_path.trim() : '';
    if (!filePath) return JSON.stringify({ status: 'error', message: 'file_path обязателен' });
    const includeLineCount = parsed.include_line_count === true;

    const { getPcCommandsSettings } = await import('./pc-commands.js');
    const pcSettings = getPcCommandsSettings(user.id);
    if (!pcSettings.fs_scan_enabled) {
      return JSON.stringify({ status: 'error', message: 'Чтение файловой системы отключено в настройках "Управление ПК". Попроси пользователя включить галочку "Разрешить ИИ сканировать файловую систему".' });
    }

    if (!isDesktopOnline(user.id)) {
      return JSON.stringify({ status: 'error', message: 'Десктоп-клиент не в сети. Получение информации о файле невозможно — попроси пользователя запустить приложение.' });
    }

    try {
      const result = await sendIpcToDesktop(user.id, 'get_file_info', { file_path: filePath, include_line_count: includeLineCount }, 30000, signal);
      return JSON.stringify({ status: 'success', file_path: filePath, ...(typeof result === 'object' && result !== null ? result : {}) });
    } catch (err: any) {
      return JSON.stringify({ status: 'error', message: err.message, file_path: filePath });
    }
  }

  // ── Visual Control: capture screen → vision model analysis ─────────────────

  if (toolName === 'capture_screen') {
    const purpose: string = typeof parsed.purpose === 'string' ? parsed.purpose.trim() : '';
    if (!purpose) return JSON.stringify({ status: 'error', message: 'purpose обязателен — укажи что найти или описать на экране.' });

    if (!isDesktopOnline(user.id)) {
      return JSON.stringify({ status: 'error', message: 'Десктоп-клиент не в сети. Скриншот невозможен — попроси пользователя запустить приложение.' });
    }
    try {
      // 1. Capture screenshots from desktop
      const result = await sendIpcToDesktop(user.id, 'capture_screen', {}, 30000, signal);
      const displays: any[] = result.displays || [];
      if (displays.length === 0) {
        return JSON.stringify({ status: 'error', message: 'Не удалось получить скриншоты мониторов.' });
      }

      // 2. Compress via sharp → JPEG
      const { default: sharpLib } = await import('sharp');
      const { saveGeneratedImage } = await import('./image-storage.js');
      const captures: Array<{ display_id: string; name: string; data_url: string; compressed_b64: string }> = [];

      for (const disp of displays) {
        try {
          const buf = Buffer.from(disp.screenshot_base64, 'base64');
          const compressed = await sharpLib(buf, { failOn: 'none' })
            .resize(1280, 720, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 70 })
            .toBuffer();
          const compressedB64 = compressed.toString('base64');
          const dataUrl = `data:image/jpeg;base64,${compressedB64}`;
          captures.push({ display_id: disp.display_id, name: disp.name || disp.display_id, data_url: dataUrl, compressed_b64: compressedB64 });

          // Save to disk → show in chat (same as generate_image)
          if (Array.isArray(generatedImages)) {
            try {
              const saved = await saveGeneratedImage(compressedB64);
              generatedImages.push({
                image_base64: compressedB64,
                image_url: saved.url,
                prompt_used: `Скриншот экрана: ${disp.name || disp.display_id}`,
              });
            } catch (err) {
              console.error('[capture_screen] failed to save screenshot:', err);
            }
          }
        } catch {
          // skip failed screenshot
        }
      }

      if (captures.length === 0) {
        return JSON.stringify({ status: 'error', message: 'Не удалось обработать скриншоты.' });
      }

      // 3. Send each screenshot to vision model with purpose
      const visionResults: any[] = [];
      for (const cap of captures) {
        try {
          const visionMessages = [
            {
              role: 'system',
              content: `Ты — vision-аналитик. Проанализируй скриншот экрана пользователя и выполни задачу.
Если нужно найти элемент — верни координаты в нормализованном виде (0.0–1.0), где (0,0) левый верхний угол, (1,1) правый нижний.
Формат ответа для координат: {"display_id": "...", "x": 0.5, "y": 0.5, "description": "..."}
Если задача — описание, верни подробный текстовый ответ.`
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: purpose },
                { type: 'image_url', image_url: { url: cap.data_url } }
              ]
            }
          ];

          const visionResp = await runCompletion('vision-pro', {
            messages: visionMessages,
            max_tokens: 1000,
          });

          const visionText = visionResp.response?.choices?.[0]?.message?.content || '';
          visionResults.push({ display_id: cap.display_id, name: cap.name, result: visionText });
        } catch (err: any) {
          visionResults.push({ display_id: cap.display_id, name: cap.name, result: `Ошибка vision: ${err.message}` });
        }
      }

      // 4. Return text summary to main model (no images in context)
      const displayInfo = displays.map((d: any) => ({
        display_id: d.display_id,
        name: d.name,
        bounds: d.bounds,
      }));

      return JSON.stringify({
        status: 'success',
        displays: displayInfo,
        vision_results: visionResults,
        message: `Скриншоты сделаны и проанализированы. Используй координаты из vision_results для execute_visual_click если нужен клик.`,
      });
    } catch (err: any) {
      return JSON.stringify({ status: 'error', message: `Ошибка скриншота: ${err.message}` });
    }
  }

  // ── Visual Control: execute click (with HitL confirmation) ──────────────────

  if (toolName === 'execute_visual_click') {
    const displayId: string = typeof parsed.display_id === 'string' ? parsed.display_id : '';
    const clickX: number = typeof parsed.x === 'number' ? parsed.x : NaN;
    const clickY: number = typeof parsed.y === 'number' ? parsed.y : NaN;
    const clickButton: string = parsed.button === 'right' ? 'right' : 'left';
    const reason: string = typeof parsed.reason === 'string' ? parsed.reason : 'Клик по экрану';

    if (!displayId) return JSON.stringify({ status: 'error', message: 'display_id обязателен. Сначала вызови capture_screen.' });
    if (!Number.isFinite(clickX) || !Number.isFinite(clickY)) return JSON.stringify({ status: 'error', message: 'x и y обязательны (0.0–1.0)' });

    // Validate ranges
    if (clickX < 0 || clickX > 1 || clickY < 0 || clickY > 1) {
      return JSON.stringify({ status: 'error', message: 'Координаты должны быть в диапазоне 0.0–1.0' });
    }

    if (!isDesktopOnline(user.id)) {
      return JSON.stringify({ status: 'error', message: 'Десктоп-клиент не в сети. Клик невозможен.' });
    }

    // Needs user confirmation — HitL
    // Take a fresh screenshot and draw a targeting circle for the confirmation card
    let previewImageUrl: string | undefined;
    let previewImageBase64: string | undefined;
    try {
      const { default: sharpLib } = await import('sharp');
      const { saveGeneratedImage } = await import('./image-storage.js');
      const freshResult = await sendIpcToDesktop(user.id, 'capture_screen', {}, 15000, signal);
      const freshDisplays: any[] = freshResult.displays || [];
      const targetDisp = freshDisplays.find((d: any) => d.display_id === displayId) || freshDisplays[0];
      if (targetDisp) {
        const buf = Buffer.from(targetDisp.screenshot_base64, 'base64');
        const imgMeta = await sharpLib(buf, { failOn: 'none' }).metadata();
        const imgWidth = imgMeta.width || 1280;
        const imgHeight = imgMeta.height || 720;
        const drawW = imgWidth > 1280 ? 1280 : imgWidth;
        const drawH = imgHeight > 720 ? 720 : imgHeight;
        const cx = Math.round(clickX * drawW);
        const cy = Math.round(clickY * drawH);
        const circleRadius = Math.max(20, Math.round(Math.min(drawW, drawH) * 0.03));

        const annotated = await sharpLib(buf, { failOn: 'none' })
          .resize(1280, 720, { fit: 'inside', withoutEnlargement: true })
          .composite([{
            input: Buffer.from(
              `<svg width="${drawW}" height="${drawH}" xmlns="http://www.w3.org/2000/svg">
                <circle cx="${cx}" cy="${cy}" r="${circleRadius}" fill="none" stroke="red" stroke-width="4"/>
                <circle cx="${cx}" cy="${cy}" r="${circleRadius + 6}" fill="none" stroke="red" stroke-width="2" opacity="0.5"/>
                <line x1="${cx - circleRadius - 10}" y1="${cy}" x2="${cx + circleRadius + 10}" y2="${cy}" stroke="red" stroke-width="2"/>
                <line x1="${cx}" y1="${cy - circleRadius - 10}" x2="${cx}" y2="${cy + circleRadius + 10}" stroke="red" stroke-width="2"/>
              </svg>`
            ),
            blend: 'over',
          }])
          .jpeg({ quality: 80 })
          .toBuffer();
        const annotatedB64 = annotated.toString('base64');
        const saved = await saveGeneratedImage(annotatedB64);
        previewImageUrl = saved.url;
        previewImageBase64 = annotatedB64;
      }
    } catch (err) {
      console.error('[visual_click] failed to create preview:', err);
    }

    const { randomUUID } = await import('node:crypto');
    const confirmationId = randomUUID();

    // Auto-reject in scheduler mode
    if (autoRejectHitl) return JSON.stringify({ status: 'rejected', message: 'Task is running in auto-mode. Visual click confirmation was automatically rejected.' });

    const { registerPendingVisualClick, deletePendingVisualClick } = await import('./visual-click-confirmations.js');
    const confirmationPromise = new Promise<any>((resolve, reject) => {
      registerPendingVisualClick(confirmationId, {
        userId: user.id,
        display_id: displayId,
        x: clickX,
        y: clickY,
        button: clickButton,
        reason,
        resolve,
        reject,
        createdAt: Date.now(),
      });
    });

    const confirmationAction: DesktopActionPayload = {
      action: 'visual_click_confirmation' as any,
      value: {
        confirmation_id: confirmationId,
        display_id: displayId,
        x: clickX,
        y: clickY,
        button: clickButton,
        reason,
        preview_image_url: previewImageUrl,
        preview_image_base64: previewImageBase64,
      }
    };

    let sent = false;
    try {
      if (subagentExtra?.onDesktopAction) {
        await subagentExtra.onDesktopAction(confirmationAction);
        sent = true;
        if (isDesktopOnline(user.id)) {
          sendToDesktop(user.id, { type: 'desktop_action', ...confirmationAction });
        }
      } else {
        sent = sendToDesktop(user.id, { type: 'desktop_action', ...confirmationAction });
      }
    } catch (err) {
      console.error('[visual_click] failed to send confirmation:', err);
    }

    if (!sent) {
      deletePendingVisualClick(confirmationId);
      return JSON.stringify({ status: 'error', message: 'Не удалось доставить подтверждение. Ни один клиент не доступен.' });
    }

    try {
      const result = await waitForHitlConfirmation(user.id, confirmationPromise);
      return JSON.stringify({ status: 'success', message: `Клик выполнен: ${reason}`, x: result.x, y: result.y, button: result.button });
    } catch (err: any) {
      if (err?.message?.startsWith('rejected_by_user')) {
        return JSON.stringify(withRejectionComment({ status: 'rejected', message: 'Пользователь отклонил клик.' }, err));
      }
      if (err?.message === 'confirmation_expired') {
        return JSON.stringify({ status: 'timeout', message: 'Время ожидания подтверждения истекло (60 секунд).' });
      }
      return JSON.stringify({ status: 'error', message: `Ошибка: ${err?.message || String(err)}` });
    }
  }

  if (toolName === 'suggest_macro') {
    const title: string = typeof parsed.title === 'string' ? parsed.title : '';
    const description: string = typeof parsed.description === 'string' ? parsed.description : '';
    const commands: string[] = Array.isArray(parsed.commands) ? parsed.commands.filter((c: unknown) => typeof c === 'string') : [];

    if (!title || commands.length === 0) {
      return JSON.stringify({ status: 'error', message: 'title и commands обязательны' });
    }

    const payload: DesktopActionPayload = {
      action: 'suggest_macro',
      value: { title, description, commands }
    };
    if (desktopActionSink) desktopActionSink.value = payload;

    return JSON.stringify({ status: 'success', message: `Предложение макроса "${title}" отправлено.`, title, commands });
  }

  // ── DevOps: list servers ────────────────────────────────────────────────────

  if (toolName === 'list_devops_servers') {
    const { listServers, listSshKeys } = await import('./devops.js');
    const servers = listServers(user.id);
    const sshKeys = listSshKeys(user.id);
    if (servers.length === 0) {
      return JSON.stringify({ status: 'info', message: 'У пользователя нет добавленных серверов. Попроси его добавить сервер в настройках (вкладка "Серверы").' });
    }
    return JSON.stringify({
      status: 'success',
      servers: servers.map(s => ({ id: s.id, name: s.name, host: s.host, port: s.port, username: s.username, default_ssh_key_id: s.default_ssh_key_id, use_ssh_key_for_login: s.use_ssh_key_for_login })),
      ssh_keys: sshKeys.map(k => ({ id: k.id, name: k.name }))
    });
  }

  // ── DevOps: execute SSH command (with HitL confirmation) ────────────────────

  if (toolName === 'execute_ssh_command') {
    const serverId: number | undefined = typeof parsed.server_id === 'number' ? parsed.server_id : undefined;
    const command: string = typeof parsed.command === 'string' ? parsed.command.trim() : '';

    if (!serverId) return JSON.stringify({ status: 'error', message: 'server_id обязателен' });
    if (!command) return JSON.stringify({ status: 'error', message: 'command обязательна' });

    const { getServerById, isAutoApproved, serverHasSudoPassword } = await import('./devops.js');
    const server = getServerById(user.id, serverId);
    if (!server) return JSON.stringify({ status: 'error', message: `Сервер с id=${serverId} не найден. Вызови list_devops_servers для списка доступных.` });

    // Check if command is auto-approved: by policy or by server-level auto_approve_all flag
    const autoOk = server.auto_approve_all || isAutoApproved(user.id, serverId, command);

    // Check if command needs sudo but server has no stored sudo password
    const needsSudoPasswordPrompt = server.username !== 'root' && /\bsudo\b/.test(command) && !serverHasSudoPassword(user.id, serverId);

    if (autoOk && !needsSudoPasswordPrompt) {
      // Execute immediately — no confirmation needed
      try {
        const { execSshCommand } = await import('./ssh.js');
        const result = await execSshCommand(user.id, serverId, command);
        return JSON.stringify({
          status: 'success',
          server: server.name,
          command,
          stdout: result.stdout.slice(-3000),
          stderr: result.stderr.slice(-1000),
          exit_code: result.exitCode
        });
      } catch (err: any) {
        return JSON.stringify({ status: 'error', message: `SSH ошибка: ${err?.message || String(err)}`, server: server.name, command });
      }
    }

    // Auto-reject in scheduler mode
    if (autoRejectHitl) return JSON.stringify({ status: 'rejected', message: 'Task is running in auto-mode. This command is not in the auto-approve policies for this server, so it was automatically rejected.', server: server.name, command });

    // Needs user confirmation — push via SSE callback (TG) and/or WS (desktop)
    const { randomUUID } = await import('node:crypto');
    const confirmationId = randomUUID();

    const devopsAction = {
      type: 'desktop_action',
      action: 'devops_confirmation',
      target: String(serverId),
      value: { confirmation_id: confirmationId, server_name: server.name, server_id: serverId, host: server.host, command, needs_sudo_password: needsSudoPasswordPrompt }
    };

    let devopsSent = false;
    if (subagentExtra?.onDesktopAction) {
      await subagentExtra.onDesktopAction(devopsAction);
      devopsSent = true;
    } else if (isDesktopOnline(user.id)) {
      sendToDesktop(user.id, devopsAction);
      devopsSent = true;
    }
    if (!devopsSent) {
      return JSON.stringify({ status: 'error', message: 'Ни один клиент не подключён. Подтверждение команды невозможно.' });
    }

    // Wait for user response via WS → POST /api/v1/devops/approve
    const { registerPendingConfirmation } = await import('./devops-confirmations.js');
    try {
      const result = await new Promise<any>((resolve, reject) => {
        registerPendingConfirmation(confirmationId, {
          userId: user.id,
          serverId,
          command,
          resolve,
          reject,
          createdAt: Date.now()
        });
      });

      return JSON.stringify({
        status: 'success',
        server: server.name,
        command,
        stdout: result.stdout?.slice(-3000) || '',
        stderr: result.stderr?.slice(-1000) || '',
        exit_code: result.exitCode
      });
    } catch (err: any) {
      if (err?.message?.startsWith('rejected_by_user')) {
        return JSON.stringify(withRejectionComment({ status: 'rejected', message: 'Пользователь отклонил выполнение команды.', server: server.name, command }, err));
      }
      if (err?.message === 'confirmation_timeout' || err?.message === 'confirmation_expired') {
        return JSON.stringify({ status: 'timeout', message: 'Время ожидания подтверждения истекло (5 минут).', server: server.name, command });
      }
      return JSON.stringify({ status: 'error', message: `SSH ошибка: ${err?.message || String(err)}`, server: server.name, command });
    }
  }

  // ── PC Command: execute on user's desktop (with HitL confirmation) ────────

  if (toolName === 'execute_pc_command') {
    const command: string = typeof parsed.command === 'string' ? parsed.command.trim() : '';
    const background = parsed.background === true;
    if (!command) return JSON.stringify({ status: 'error', message: 'command обязательна' });

    // Block dangerous commands (Linux + Windows)
    const dangerousPcPatterns = [
      /rm\s+(-\w*r\w*f\w*\s+|.*--no-preserve-root)/i,
      /\bmkfs\b/i,
      /\bdd\s+.*of=\/dev\//i,
      /\bshutdown\b/i,
      /\binit\s+[06]\b/i,
      />\s*\/dev\/sda/i,
      /\bchmod\s+(-R\s+)?000\s+\//i,
      /\bchown\s+(-R\s+)?\w+\s+\//i,
      /\bformat\s+[a-z]:/i,
      /\bdel\s+\/f\s+\/s\s+\/q\s+c:/i,
      /\brd\s+\/s\s+\/q\s+[a-z]:/i,
      /\brmdir\s+\/s\s+\/q/i,
    ];
    if (dangerousPcPatterns.some(p => p.test(command))) {
      return JSON.stringify({ status: 'error', message: 'Команда заблокирована как потенциально опасная. Это ограничение безопасности, его нельзя обойти.' });
    }

    // Desktop must be online
    if (!isDesktopOnline(user.id)) {
      return JSON.stringify({ status: 'error', message: 'Десктоп-клиент не в сети. Выполнение команды на ПК невозможно — попроси пользователя запустить приложение.' });
    }

    // Check auto-approve: settings + policies
    const { getPcCommandsSettings, isPcCommandAutoApproved } = await import('./pc-commands.js');
    console.log('[pc_command] checking approval policy', { userId: user.id, command: command.slice(0, 300) });
    const settings = getPcCommandsSettings(user.id);
    const policyAutoOk = isPcCommandAutoApproved(user.id, command);
    const autoOk = settings.auto_approve_all || policyAutoOk;
    console.log('[pc_command] approval policy result', {
      userId: user.id,
      autoApproveAll: settings.auto_approve_all,
      policyAutoOk,
      autoOk,
    });

    if (autoOk) {
      // Execute immediately via WS IPC
      try {
        const result = await sendIpcToDesktop(user.id, 'execute_commands', { commands: [command], background }, 60000, signal);
        // result is a string (stdout/stderr joined by \n---\n)
        const output = typeof result === 'string' ? result : JSON.stringify(result);
        return JSON.stringify({
          status: 'success',
          command,
          background,
          output: output.slice(-PC_COMMAND_OUTPUT_MAX),
        });
      } catch (err: any) {
        return JSON.stringify({ status: 'error', message: `Ошибка выполнения: ${err?.message || String(err)}`, command });
      }
    }

    // Auto-reject in scheduler mode
    if (autoRejectHitl) return JSON.stringify({ status: 'rejected', message: 'Task is running in auto-mode. This command is not in the auto-approve policies, so it was automatically rejected.', command });

    // Needs user confirmation — push to desktop via WS
    const { randomUUID } = await import('node:crypto');
    const confirmationId = randomUUID();

    // Wait for user response via WS -> POST /api/v1/pc-commands/approve.
    // Register before sending so a very fast approval cannot race the pending store.
    const { registerPendingPcConfirmation, deletePendingPcConfirmation } = await import('./pc-command-confirmations.js');
    const confirmationPromise = new Promise<any>((resolve, reject) => {
      registerPendingPcConfirmation(confirmationId, {
        userId: user.id,
        kind: 'pc_command',
        label: command,
        payload: { ipcType: 'execute_commands', ipcPayload: { commands: [command], background } },
        resolve,
        reject,
        createdAt: Date.now()
      });
    });

    const confirmationAction: DesktopActionPayload = {
      action: 'pc_command_confirmation',
      value: { confirmation_id: confirmationId, command, background }
    };

    let sent = false;
    try {
      if (subagentExtra?.onDesktopAction) {
        // SSE callback (e.g. TG streaming) — confirmation goes to TG
        await subagentExtra.onDesktopAction(confirmationAction);
        sent = true;
        // Also push to desktop WS if it's online — so both clients can confirm
        if (isDesktopOnline(user.id)) {
          sendToDesktop(user.id, { type: 'desktop_action', ...confirmationAction });
        }
      } else {
        sent = sendToDesktop(user.id, {
          type: 'desktop_action',
          ...confirmationAction
        });
      }
    } catch (err) {
      console.error('[pc_command] failed to send confirmation action:', err);
    }

    console.log('[pc_command] confirmation dispatch', {
      userId: user.id,
      confirmationId,
      via: subagentExtra?.onDesktopAction ? 'callback+ws' : 'ws_registry',
      sent,
    });

    if (!sent) {
      deletePendingPcConfirmation(confirmationId);
      return JSON.stringify({
        status: 'error',
        message: 'Не удалось доставить подтверждение. Ни один клиент не доступен.',
        command,
      });
    }

    try {
      const result = await waitForHitlConfirmation(user.id, confirmationPromise);

      const output = typeof result === 'string' ? result : JSON.stringify(result);
      return JSON.stringify({
        status: 'success',
        command,
        background,
        output: output.slice(-PC_COMMAND_OUTPUT_MAX),
      });
    } catch (err: any) {
      if (err?.message?.startsWith('rejected_by_user')) {
        return JSON.stringify(withRejectionComment({ status: 'rejected', message: 'Пользователь отклонил выполнение команды.', command }, err));
      }
      if (err?.message === 'confirmation_expired') {
        return JSON.stringify({ status: 'timeout', message: 'Время ожидания подтверждения истекло (5 минут).', command });
      }
      return JSON.stringify({ status: 'error', message: `Ошибка выполнения: ${err?.message || String(err)}`, command });
    }
  }

  // ── File Action: read_file (native fs, optional HitL) ─────────────────────

  if (toolName === 'read_file') {
    const filePath: string = typeof parsed.file_path === 'string' ? parsed.file_path.trim() : '';
    if (!filePath) return JSON.stringify({ status: 'error', message: 'file_path обязателен' });

    const startLine = typeof parsed.start_line === 'number' && parsed.start_line > 0 ? Math.floor(parsed.start_line) : 1;
    const maxLines = typeof parsed.max_lines === 'number' && parsed.max_lines > 0 ? Math.min(Math.floor(parsed.max_lines), 2000) : 500;
    const lineNumbers = parsed.line_numbers === true;

    // Desktop must be online
    if (!isDesktopOnline(user.id)) {
      return JSON.stringify({ status: 'error', message: 'Десктоп-клиент не в сети. Чтение файла невозможно — попроси пользователя запустить приложение.' });
    }

    // Check if reads without confirmation are allowed
    const { getPcCommandsSettings } = await import('./pc-commands.js');
    const settings = getPcCommandsSettings(user.id);

    if (settings.file_read_enabled) {
      // Execute immediately via WS IPC
      try {
        const result = await sendIpcToDesktop(user.id, 'read_file', { file_path: filePath, start_line: startLine, max_lines: maxLines, line_numbers: lineNumbers }, 30000, signal);
        return JSON.stringify({
          status: 'success',
          file_path: filePath,
          ...(typeof result === 'object' && result !== null ? result : { content: typeof result === 'string' ? result : JSON.stringify(result) }),
        });
      } catch (err: any) {
        return JSON.stringify({ status: 'error', message: `Ошибка чтения файла: ${err?.message || String(err)}`, file_path: filePath });
      }
    }

    // Auto-reject in scheduler mode
    if (autoRejectHitl) return JSON.stringify({ status: 'rejected', message: 'Task is running in auto-mode. File read confirmation was automatically rejected.', file_path: filePath });

    // Needs user confirmation — same HitL flow as pc_command
    const { randomUUID } = await import('node:crypto');
    const confirmationId = randomUUID();

    const { registerPendingPcConfirmation, deletePendingPcConfirmation } = await import('./pc-command-confirmations.js');
    const confirmationPromise = new Promise<any>((resolve, reject) => {
      registerPendingPcConfirmation(confirmationId, {
        userId: user.id,
        kind: 'file_action',
        label: `read: ${filePath}`,
        payload: { ipcType: 'read_file', ipcPayload: { file_path: filePath, start_line: startLine, max_lines: maxLines, line_numbers: lineNumbers } },
        resolve,
        reject,
        createdAt: Date.now()
      });
    });

    const confirmationAction: DesktopActionPayload = {
      action: 'file_action_confirmation',
      value: {
        confirmation_id: confirmationId,
        action_type: 'read',
        file_path: filePath,
        start_line: startLine,
        max_lines: maxLines,
      }
    };

    let sent = false;
    try {
      if (subagentExtra?.onDesktopAction) {
        await subagentExtra.onDesktopAction(confirmationAction);
        sent = true;
        if (isDesktopOnline(user.id)) {
          sendToDesktop(user.id, { type: 'desktop_action', ...confirmationAction });
        }
      } else {
        sent = sendToDesktop(user.id, { type: 'desktop_action', ...confirmationAction });
      }
    } catch (err) {
      console.error('[read_file] failed to send confirmation action:', err);
    }

    if (!sent) {
      deletePendingPcConfirmation(confirmationId);
      return JSON.stringify({ status: 'error', message: 'Не удалось доставить подтверждение. Ни один клиент не доступен.', file_path: filePath });
    }

    try {
      const result = await waitForHitlConfirmation(user.id, confirmationPromise);
      return JSON.stringify({
        status: 'success',
        file_path: filePath,
        ...(typeof result === 'object' && result !== null ? result : { content: typeof result === 'string' ? result : JSON.stringify(result) }),
      });
    } catch (err: any) {
      if (err?.message?.startsWith('rejected_by_user')) {
        return JSON.stringify(withRejectionComment({ status: 'rejected', message: 'Пользователь отклонил чтение файла.', file_path: filePath }, err));
      }
      if (err?.message === 'confirmation_expired') {
        return JSON.stringify({ status: 'timeout', message: 'Время ожидания подтверждения истекло (5 минут).', file_path: filePath });
      }
      return JSON.stringify({ status: 'error', message: `Ошибка чтения файла: ${err?.message || String(err)}`, file_path: filePath });
    }
  }

  // ── File Action: search_file_keywords (native fs, optional HitL) ──────────

  if (toolName === 'search_file_keywords') {
    const filePath: string = typeof parsed.file_path === 'string' ? parsed.file_path.trim() : '';
    const query: string = typeof parsed.query === 'string' ? parsed.query.trim() : '';
    if (!filePath) return JSON.stringify({ status: 'error', message: 'file_path обязателен' });
    if (!query) return JSON.stringify({ status: 'error', message: 'query обязателен' });

    const maxMatches = typeof parsed.max_matches === 'number' && parsed.max_matches > 0 ? Math.min(Math.floor(parsed.max_matches), 500) : 100;

    if (!isDesktopOnline(user.id)) {
      return JSON.stringify({ status: 'error', message: 'Десктоп-клиент не в сети. Поиск по файлу невозможен — попроси пользователя запустить приложение.' });
    }

    const { getPcCommandsSettings } = await import('./pc-commands.js');
    const settings = getPcCommandsSettings(user.id);
    const ipcPayload = { file_path: filePath, query, max_matches: maxMatches };

    if (settings.file_read_enabled) {
      try {
        const result = await sendIpcToDesktop(user.id, 'search_file_keywords', ipcPayload, 30000, signal);
        return JSON.stringify({
          status: 'success',
          file_path: filePath,
          query,
          ...(typeof result === 'object' && result !== null ? result : { content: typeof result === 'string' ? result : JSON.stringify(result) }),
        });
      } catch (err: any) {
        return JSON.stringify({ status: 'error', message: `Ошибка поиска по файлу: ${err?.message || String(err)}`, file_path: filePath, query });
      }
    }

    const { randomUUID } = await import('node:crypto');
    const confirmationId = randomUUID();

    const { registerPendingPcConfirmation, deletePendingPcConfirmation } = await import('./pc-command-confirmations.js');
    const confirmationPromise = new Promise<any>((resolve, reject) => {
      registerPendingPcConfirmation(confirmationId, {
        userId: user.id,
        kind: 'file_action',
        label: `search "${query}": ${filePath}`,
        payload: { ipcType: 'search_file_keywords', ipcPayload },
        resolve,
        reject,
        createdAt: Date.now()
      });
    });

    const confirmationAction: DesktopActionPayload = {
      action: 'file_action_confirmation',
      value: {
        confirmation_id: confirmationId,
        action_type: 'read',
        file_path: filePath,
        max_lines: maxMatches,
        content_preview: `Поиск: ${query}`,
      }
    };

    let sent = false;
    try {
      if (subagentExtra?.onDesktopAction) {
        await subagentExtra.onDesktopAction(confirmationAction);
        sent = true;
        if (isDesktopOnline(user.id)) {
          sendToDesktop(user.id, { type: 'desktop_action', ...confirmationAction });
        }
      } else {
        sent = sendToDesktop(user.id, { type: 'desktop_action', ...confirmationAction });
      }
    } catch (err) {
      console.error('[search_file_keywords] failed to send confirmation action:', err);
    }

    if (!sent) {
      deletePendingPcConfirmation(confirmationId);
      return JSON.stringify({ status: 'error', message: 'Не удалось доставить подтверждение. Ни один клиент не доступен.', file_path: filePath });
    }

    try {
      const result = await waitForHitlConfirmation(user.id, confirmationPromise);
      return JSON.stringify({
        status: 'success',
        file_path: filePath,
        query,
        ...(typeof result === 'object' && result !== null ? result : { content: typeof result === 'string' ? result : JSON.stringify(result) }),
      });
    } catch (err: any) {
      if (err?.message?.startsWith('rejected_by_user')) {
        return JSON.stringify(withRejectionComment({ status: 'rejected', message: 'Пользователь отклонил поиск по файлу.', file_path: filePath, query }, err));
      }
      if (err?.message === 'confirmation_expired') {
        return JSON.stringify({ status: 'timeout', message: 'Время ожидания подтверждения истекло (5 минут).', file_path: filePath, query });
      }
      return JSON.stringify({ status: 'error', message: `Ошибка поиска по файлу: ${err?.message || String(err)}`, file_path: filePath, query });
    }
  }

  // ── File Action: write_file (native fs, always HitL) ──────────────────────

  if (toolName === 'write_file') {
    const filePath: string = typeof parsed.file_path === 'string' ? parsed.file_path.trim() : '';
    if (!filePath) return JSON.stringify({ status: 'error', message: 'file_path обязателен' });

    const content: string = typeof parsed.content === 'string' ? parsed.content : '';
    const mode: 'overwrite' | 'append' = parsed.mode === 'append' ? 'append' : 'overwrite';

    // Size limit: 5 MB
    const WRITE_FILE_MAX_SIZE = 5 * 1024 * 1024;
    if (Buffer.byteLength(content, 'utf-8') > WRITE_FILE_MAX_SIZE) {
      return JSON.stringify({ status: 'error', message: `Контент слишком большой (лимит 5 МБ). Используй меньший объём данных.`, file_path: filePath });
    }

    // Block writes to system directories
    const blockedPathPatterns = [
      /^[cC]:[\\/]Windows[\\/]/i,
      /^[cC]:[\\/]Program Files[\\/]/i,
      /^[cC]:[\\/]Program Files \(x86\)[\\/]/i,
      /^\/etc[\\/]/i,
      /^\/usr[\\/]/i,
      /^\/bin[\\/]/i,
      /^\/sbin[\\/]/i,
      /^\/boot[\\/]/i,
      /^\/dev[\\/]/i,
      /^\/proc[\\/]/i,
      /^\/sys[\\/]/i,
    ];
    if (blockedPathPatterns.some(p => p.test(filePath))) {
      return JSON.stringify({ status: 'error', message: 'Запись в системные директории заблокирована. Это ограничение безопасности, его нельзя обойти.', file_path: filePath });
    }

    // Desktop must be online
    if (!isDesktopOnline(user.id)) {
      return JSON.stringify({ status: 'error', message: 'Десктоп-клиент не в сети. Запись файла невозможна — попроси пользователя запустить приложение.' });
    }

    // Auto-reject in scheduler mode
    if (autoRejectHitl) return JSON.stringify({ status: 'rejected', message: 'Task is running in auto-mode. File write confirmation was automatically rejected.', file_path: filePath });

    // Always requires user confirmation — HitL
    const { randomUUID } = await import('node:crypto');
    const confirmationId = randomUUID();

    const { registerPendingPcConfirmation, deletePendingPcConfirmation } = await import('./pc-command-confirmations.js');
    const confirmationPromise = new Promise<any>((resolve, reject) => {
      registerPendingPcConfirmation(confirmationId, {
        userId: user.id,
        kind: 'file_action',
        label: `write ${mode}: ${filePath}`,
        payload: { ipcType: 'write_file', ipcPayload: { file_path: filePath, content, mode } },
        resolve,
        reject,
        createdAt: Date.now()
      });
    });

    // Build a short preview for the confirmation card
    const contentPreview = content.slice(0, 2000);
    const sizeBytes = Buffer.byteLength(content, 'utf-8');

    const confirmationAction: DesktopActionPayload = {
      action: 'file_action_confirmation',
      value: {
        confirmation_id: confirmationId,
        action_type: 'write',
        file_path: filePath,
        mode,
        size_bytes: sizeBytes,
        content_preview: contentPreview,
      }
    };

    let sent = false;
    try {
      if (subagentExtra?.onDesktopAction) {
        await subagentExtra.onDesktopAction(confirmationAction);
        sent = true;
        if (isDesktopOnline(user.id)) {
          sendToDesktop(user.id, { type: 'desktop_action', ...confirmationAction });
        }
      } else {
        sent = sendToDesktop(user.id, { type: 'desktop_action', ...confirmationAction });
      }
    } catch (err) {
      console.error('[write_file] failed to send confirmation action:', err);
    }

    console.log('[write_file] confirmation dispatch', {
      userId: user.id,
      confirmationId,
      filePath,
      mode,
      sizeBytes,
      via: subagentExtra?.onDesktopAction ? 'callback+ws' : 'ws_registry',
      sent,
    });

    if (!sent) {
      deletePendingPcConfirmation(confirmationId);
      return JSON.stringify({ status: 'error', message: 'Не удалось доставить подтверждение. Ни один клиент не доступен.', file_path: filePath });
    }

    try {
      const result = await waitForHitlConfirmation(user.id, confirmationPromise);
      return JSON.stringify({
        status: 'success',
        file_path: filePath,
        mode,
        ...(typeof result === 'object' && result !== null ? result : {}),
        message: `Файл ${mode === 'append' ? 'обновлён (добавлено в конец)' : 'записан'}: ${filePath}`,
      });
    } catch (err: any) {
      if (err?.message?.startsWith('rejected_by_user')) {
        return JSON.stringify(withRejectionComment({ status: 'rejected', message: 'Пользователь отклонил запись файла.', file_path: filePath }, err));
      }
      if (err?.message === 'confirmation_expired') {
        return JSON.stringify({ status: 'timeout', message: 'Время ожидания подтверждения истекло (5 минут).', file_path: filePath });
      }
      return JSON.stringify({ status: 'error', message: `Ошибка записи файла: ${err?.message || String(err)}`, file_path: filePath });
    }
  }

  // ── File Action: edit_file_lines (surgical line replacement, always HitL) ──

  if (toolName === 'edit_file_lines') {
    const filePath: string = typeof parsed.file_path === 'string' ? parsed.file_path.trim() : '';
    if (!filePath) return JSON.stringify({ status: 'error', message: 'file_path обязателен' });

    const startLine = typeof parsed.start_line === 'number' ? Math.floor(parsed.start_line) : 0;
    const endLine = typeof parsed.end_line === 'number' ? Math.floor(parsed.end_line) : 0;
    const newContent: string = typeof parsed.new_content === 'string' ? parsed.new_content : '';

    if (startLine < 1) return JSON.stringify({ status: 'error', message: 'start_line должен быть >= 1' });
    if (endLine < 0) return JSON.stringify({ status: 'error', message: 'end_line должен быть >= 0' });
    if (endLine !== 0 && endLine < startLine - 1) {
      return JSON.stringify({ status: 'error', message: 'end_line должен быть >= start_line - 1 (для вставки укажи end_line = start_line - 1)' });
    }

    // Block .docx — use read_file + write_file instead
    const ext = filePath.toLowerCase().split('.').pop();
    if (ext === 'docx') {
      return JSON.stringify({ status: 'error', message: 'edit_file_lines не поддерживает .docx. Используй read_file + write_file (overwrite).' });
    }

    // Desktop must be online
    if (!isDesktopOnline(user.id)) {
      return JSON.stringify({ status: 'error', message: 'Десктоп-клиент не в сети. Редактирование файла невозможно.' });
    }

    // Pre-read only the affected range for diff preview. read_file has a
    // pagination cap, so reading from line 1 would make large-file edits look
    // out of bounds even when the target lines exist.
    let oldLinesPreview = '';
    try {
      const previewLineCount = endLine >= startLine
        ? Math.max(1, Math.min(endLine - startLine + 1, 2000))
        : 1;
      const readResult = await sendIpcToDesktop(user.id, 'read_file', { file_path: filePath, start_line: startLine, max_lines: previewLineCount }, 30000, signal);
      const previewContent = typeof readResult === 'object' && readResult !== null && 'content' in readResult
        ? String((readResult as any).content)
        : typeof readResult === 'string' ? readResult : '';
      const totalLines = typeof readResult === 'object' && readResult !== null && typeof (readResult as any).total_lines === 'number'
        ? Math.floor((readResult as any).total_lines)
        : startLine + (previewContent ? previewContent.split('\n').length : 0) - 1;

      if (startLine > totalLines + 1) {
        return JSON.stringify({ status: 'error', message: `start_line (${startLine}) выходит за пределы файла (всего строк: ${totalLines}).` });
      }

      oldLinesPreview = endLine >= startLine ? previewContent : '';
    } catch (err: any) {
      return JSON.stringify({ status: 'error', message: `Не удалось прочитать файл для diff: ${err?.message || String(err)}`, file_path: filePath });
    }

    // Auto-reject in scheduler mode
    if (autoRejectHitl) return JSON.stringify({ status: 'rejected', message: 'Task is running in auto-mode. File edit confirmation was automatically rejected.', file_path: filePath });

    // Always requires user confirmation — HitL
    const { randomUUID } = await import('node:crypto');
    const confirmationId = randomUUID();

    const { registerPendingPcConfirmation, deletePendingPcConfirmation } = await import('./pc-command-confirmations.js');
    const confirmationPromise = new Promise<any>((resolve, reject) => {
      registerPendingPcConfirmation(confirmationId, {
        userId: user.id,
        kind: 'file_action',
        label: `edit lines ${startLine}-${endLine}: ${filePath}`,
        payload: { ipcType: 'edit_file_lines', ipcPayload: { file_path: filePath, start_line: startLine, end_line: endLine, new_content: newContent } },
        resolve,
        reject,
        createdAt: Date.now()
      });
    });

    const newContentPreview = newContent.slice(0, 2000);
    const oldLinesPreviewTruncated = oldLinesPreview.slice(0, 2000);

    const confirmationAction: DesktopActionPayload = {
      action: 'edit_file_lines_confirmation',
      value: {
        confirmation_id: confirmationId,
        file_path: filePath,
        start_line: startLine,
        end_line: endLine,
        old_content_preview: oldLinesPreviewTruncated,
        new_content_preview: newContentPreview,
      }
    };

    let sent = false;
    try {
      if (subagentExtra?.onDesktopAction) {
        await subagentExtra.onDesktopAction(confirmationAction);
        sent = true;
        if (isDesktopOnline(user.id)) {
          sendToDesktop(user.id, { type: 'desktop_action', ...confirmationAction });
        }
      } else {
        sent = sendToDesktop(user.id, { type: 'desktop_action', ...confirmationAction });
      }
    } catch (err) {
      console.error('[edit_file_lines] failed to send confirmation action:', err);
    }

    console.log('[edit_file_lines] confirmation dispatch', {
      userId: user.id,
      confirmationId,
      filePath,
      startLine,
      endLine,
      via: subagentExtra?.onDesktopAction ? 'callback+ws' : 'ws_registry',
      sent,
    });

    if (!sent) {
      deletePendingPcConfirmation(confirmationId);
      return JSON.stringify({ status: 'error', message: 'Не удалось доставить подтверждение. Ни один клиент не доступен.', file_path: filePath });
    }

    try {
      const result = await waitForHitlConfirmation(user.id, confirmationPromise);
      return JSON.stringify({
        status: 'success',
        file_path: filePath,
        ...(typeof result === 'object' && result !== null ? result : {}),
        message: `Строки ${startLine}-${endLine} заменены в файле: ${filePath}`,
      });
    } catch (err: any) {
      if (err?.message?.startsWith('rejected_by_user')) {
        return JSON.stringify(withRejectionComment({ status: 'rejected', message: 'Пользователь отклонил редактирование файла.', file_path: filePath }, err));
      }
      if (err?.message === 'confirmation_expired') {
        return JSON.stringify({ status: 'timeout', message: 'Время ожидания подтверждения истекло (5 минут).', file_path: filePath });
      }
      return JSON.stringify({ status: 'error', message: `Ошибка редактирования файла: ${err?.message || String(err)}`, file_path: filePath });
    }
  }

  // ── DevOps: list runbooks ──────────────────────────────────────────────────

  if (toolName === 'list_devops_runbooks') {
    const { listRunbooks } = await import('./devops.js');
    const runbooks = listRunbooks(user.id);
    if (runbooks.length === 0) {
      return JSON.stringify({ status: 'info', message: 'У пользователя нет сохранённых инструкций (runbooks).' });
    }
    return JSON.stringify({
      status: 'success',
      runbooks: runbooks.map(r => ({ id: r.id, title: r.title, updated_at: r.updated_at }))
    });
  }

  // ── DevOps: read runbook ───────────────────────────────────────────────────

  if (toolName === 'read_devops_runbook') {
    const runbookId: number | undefined = typeof parsed.runbook_id === 'number' ? parsed.runbook_id : undefined;
    if (!runbookId) return JSON.stringify({ status: 'error', message: 'runbook_id обязателен' });

    const { getRunbookById } = await import('./devops.js');
    const runbook = getRunbookById(user.id, runbookId);
    if (!runbook) return JSON.stringify({ status: 'error', message: `Runbook с id=${runbookId} не найден.` });

    return JSON.stringify({
      status: 'success',
      id: runbook.id,
      title: runbook.title,
      content: runbook.content
    });
  }

  // ── DevOps: suggest runbook ──────────────────────────────────────────────────

  if (toolName === 'suggest_devops_runbook') {
    const title: string = typeof parsed.title === 'string' ? parsed.title : '';
    const content: string = typeof parsed.content === 'string' ? parsed.content : '';
    const commands: string[] = Array.isArray(parsed.commands) ? parsed.commands.filter((c: unknown) => typeof c === 'string') : [];

    if (!title || !content) {
      return JSON.stringify({ status: 'error', message: 'title и content обязательны' });
    }

    const payload: DesktopActionPayload = {
      action: 'suggest_devops_runbook',
      value: { title, content, commands }
    };
    if (desktopActionSink) desktopActionSink.value = payload;

    return JSON.stringify({ status: 'success', message: `Предложение инструкции "${title}" отправлено.` });
  }

  // ── DevOps: install SSH public key ───────────────────────────────────────────

  if (toolName === 'install_ssh_public_key') {
    const serverId: number | undefined = typeof parsed.server_id === 'number' ? parsed.server_id : undefined;
    const explicitKeyId: number | undefined = typeof parsed.key_id === 'number' ? parsed.key_id : undefined;
    const targetUser: string = typeof parsed.target_user === 'string' ? parsed.target_user.trim() : '';

    if (!serverId || !targetUser) {
      return JSON.stringify({ status: 'error', message: 'server_id и target_user обязательны' });
    }

    // Validate target_user (no shell injection)
    if (!/^[a-zA-Z0-9._-]+$/.test(targetUser)) {
      return JSON.stringify({ status: 'error', message: 'target_user содержит недопустимые символы' });
    }

    const { getSshPublicKey, buildInstallKeyScript, getServerById } = await import('./devops.js');

    const server = getServerById(user.id, serverId);
    if (!server) {
      return JSON.stringify({ status: 'error', message: `Сервер с id=${serverId} не найден.` });
    }

    // Resolve key_id: explicit > server default
    const keyId = explicitKeyId ?? server.default_ssh_key_id;
    if (!keyId) {
      return JSON.stringify({ status: 'error', message: `У сервера "${server.name}" нет ключа по умолчанию. Укажи key_id или настрой default в настройках сервера.` });
    }

    const publicKey = getSshPublicKey(user.id, keyId);
    if (!publicKey) {
      return JSON.stringify({ status: 'error', message: `SSH-ключ с id=${keyId} не найден.` });
    }

    // Build the install script
    const script = buildInstallKeyScript(targetUser, publicKey);

    // Use the existing SSH executor — respects HitL confirmation
    const { execSshCommand } = await import('./ssh.js');
    try {
      const result = await execSshCommand(user.id, serverId, script);
      return JSON.stringify({
        status: 'success',
        message: `SSH-ключ установлен для пользователя ${targetUser} на сервере ${server.name}`,
        exitCode: result.exitCode,
        stderr: result.stderr || undefined,
      });
    } catch (err: any) {
      return JSON.stringify({ status: 'error', message: `Ошибка установки ключа: ${err.message}` });
    }
  }

  // ── DevOps: create server user ─────────────────────────────────────────────

  if (toolName === 'create_server_user') {
    const serverId: number | undefined = typeof parsed.server_id === 'number' ? parsed.server_id : undefined;
    const username: string = typeof parsed.username === 'string' ? parsed.username.trim() : '';
    const installSshKey: boolean = parsed.install_ssh_key !== false;
    const explicitKeyId: number | undefined = typeof parsed.key_id === 'number' ? parsed.key_id : undefined;
    const nopasswdSudo: boolean = parsed.nopasswd_sudo === true;

    if (!serverId || !username) {
      return JSON.stringify({ status: 'error', message: 'server_id и username обязательны' });
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
      return JSON.stringify({ status: 'error', message: 'username содержит недопустимые символы' });
    }

    const { getServerById, getSshPublicKey, serverHasSudoPassword } = await import('./devops.js');
    const server = getServerById(user.id, serverId);
    if (!server) {
      return JSON.stringify({ status: 'error', message: `Сервер с id=${serverId} не найден.` });
    }

    let publicKey: string | undefined;
    let keyId: number | null | undefined;
    if (installSshKey) {
      keyId = explicitKeyId ?? server.default_ssh_key_id;
      if (!keyId) {
        return JSON.stringify({ status: 'error', message: `У сервера "${server.name}" нет SSH-ключа по умолчанию. Укажи key_id или вызови tool с install_ssh_key=false.` });
      }
      const resolvedPublicKey = getSshPublicKey(user.id, keyId);
      if (!resolvedPublicKey) {
        return JSON.stringify({ status: 'error', message: `SSH-ключ с id=${keyId} не найден.` });
      }
      publicKey = resolvedPublicKey;
    }

    const needsSudoPasswordPrompt = !serverHasSudoPassword(user.id, serverId);
    const previewCommand = [
      'create_server_user',
      `username=${username}`,
      'password=***',
      `sudo_group=true`,
      `nopasswd_sudo=${nopasswdSudo}`,
      `install_ssh_key=${installSshKey}`,
      keyId ? `key_id=${keyId}` : '',
    ].filter(Boolean).join(' ');

    const { randomUUID } = await import('node:crypto');
    const confirmationId = randomUUID();

    const createUserAction = {
      type: 'desktop_action',
      action: 'devops_confirmation',
      target: String(serverId),
      value: {
        confirmation_id: confirmationId,
        server_name: server.name,
        server_id: serverId,
        host: server.host,
        command: previewCommand,
        needs_sudo_password: needsSudoPasswordPrompt,
        new_username: username,
      }
    };

    let createUserSent = false;
    if (subagentExtra?.onDesktopAction) {
      await subagentExtra.onDesktopAction(createUserAction);
      createUserSent = true;
    } else if (isDesktopOnline(user.id)) {
      sendToDesktop(user.id, createUserAction);
      createUserSent = true;
    }
    if (!createUserSent) {
      return JSON.stringify({ status: 'error', message: 'Ни один клиент не подключён. Подтверждение невозможно.' });
    }

    // Auto-reject in scheduler mode
    if (autoRejectHitl) return JSON.stringify({ status: 'rejected', message: 'Task is running in auto-mode. Create server user confirmation was automatically rejected.' });

    const { registerPendingConfirmation } = await import('./devops-confirmations.js');
    try {
      const result = await new Promise<any>((resolve, reject) => {
        registerPendingConfirmation(confirmationId, {
          userId: user.id,
          serverId,
          command: previewCommand,
          needsSudoPassword: needsSudoPasswordPrompt,
          execute: async (execOptions?: { sudoPasswordOverride?: string; newPasswordOverride?: string }) => {
            const { createServerUser } = await import('./ssh.js');
            return createServerUser(user.id, serverId, {
              username,
              password: execOptions?.sudoPasswordOverride,
              publicKey,
              installSshKey,
              nopasswdSudo,
              sudoPasswordOverride: execOptions?.sudoPasswordOverride,
            });
          },
          resolve,
          reject,
          createdAt: Date.now()
        });
      });

      return JSON.stringify({
        status: 'success',
        message: `Пользователь ${username} создан на сервере ${server.name}.`,
        server: server.name,
        username,
        sudo_group: result.sudoGroup,
        ssh_key_installed: result.sshKeyInstalled,
        nopasswd_sudo: result.nopasswdSudo
      });
    } catch (err: any) {
      if (err?.message?.startsWith('rejected_by_user')) {
        return JSON.stringify(withRejectionComment({ status: 'rejected', message: 'Пользователь отклонил создание server user.', server: server.name, username }, err));
      }
      if (err?.message === 'confirmation_timeout' || err?.message === 'confirmation_expired') {
        return JSON.stringify({ status: 'timeout', message: 'Время ожидания подтверждения истекло (5 минут).', server: server.name, username });
      }
      return JSON.stringify({ status: 'error', message: `Ошибка создания пользователя: ${err?.message || String(err)}`, server: server.name, username });
    }
  }

  // ── DevOps: change server user password ───────────────────────────────────

  if (toolName === 'change_server_user_password') {
    const serverId: number | undefined = typeof parsed.server_id === 'number' ? parsed.server_id : undefined;
    const username: string = typeof parsed.username === 'string' ? parsed.username.trim() : '';

    if (!serverId || !username) {
      return JSON.stringify({ status: 'error', message: 'server_id и username обязательны' });
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
      return JSON.stringify({ status: 'error', message: 'username содержит недопустимые символы' });
    }

    const { getServerById, serverHasSudoPassword } = await import('./devops.js');
    const server = getServerById(user.id, serverId);
    if (!server) {
      return JSON.stringify({ status: 'error', message: `Сервер с id=${serverId} не найден.` });
    }

    const needsSudoPasswordPrompt = server.username !== 'root' && !serverHasSudoPassword(user.id, serverId);
    const previewCommand = [
      'change_server_user_password',
      `username=${username}`,
      'password=***',
    ].join(' ');

    const { randomUUID } = await import('node:crypto');
    const confirmationId = randomUUID();

    const changePwdAction = {
      type: 'desktop_action',
      action: 'devops_confirmation',
      target: String(serverId),
      value: {
        confirmation_id: confirmationId,
        server_name: server.name,
        server_id: serverId,
        host: server.host,
        command: previewCommand,
        needs_sudo_password: needsSudoPasswordPrompt,
        needs_new_password: true,
        new_username: username,
      }
    };

    let changePwdSent = false;
    if (subagentExtra?.onDesktopAction) {
      await subagentExtra.onDesktopAction(changePwdAction);
      changePwdSent = true;
    } else if (isDesktopOnline(user.id)) {
      sendToDesktop(user.id, changePwdAction);
      changePwdSent = true;
    }
    if (!changePwdSent) {
      return JSON.stringify({ status: 'error', message: 'Ни один клиент не подключён. Подтверждение невозможно.' });
    }

    // Auto-reject in scheduler mode
    if (autoRejectHitl) return JSON.stringify({ status: 'rejected', message: 'Task is running in auto-mode. Change server user password confirmation was automatically rejected.' });

    const { registerPendingConfirmation } = await import('./devops-confirmations.js');
    try {
      const result = await new Promise<any>((resolve, reject) => {
        registerPendingConfirmation(confirmationId, {
          userId: user.id,
          serverId,
          command: previewCommand,
          needsSudoPassword: needsSudoPasswordPrompt,
          needsNewPassword: true,
          execute: async (execOptions?: { sudoPasswordOverride?: string; newPasswordOverride?: string }) => {
            const { changeServerUserPassword } = await import('./ssh.js');
            return changeServerUserPassword(user.id, serverId, {
              username,
              newPassword: execOptions?.newPasswordOverride,
              sudoPasswordOverride: execOptions?.sudoPasswordOverride,
            });
          },
          resolve,
          reject,
          createdAt: Date.now()
        });
      });

      return JSON.stringify({
        status: 'success',
        message: `Пароль пользователя ${username} изменён на сервере ${server.name}.`,
        server: server.name,
        username,
        changed: result.changed === true
      });
    } catch (err: any) {
      if (err?.message?.startsWith('rejected_by_user')) {
        return JSON.stringify(withRejectionComment({ status: 'rejected', message: 'Пользователь отклонил смену пароля.', server: server.name, username }, err));
      }
      if (err?.message === 'confirmation_timeout' || err?.message === 'confirmation_expired') {
        return JSON.stringify({ status: 'timeout', message: 'Время ожидания подтверждения истекло (5 минут).', server: server.name, username });
      }
      return JSON.stringify({ status: 'error', message: `Ошибка смены пароля: ${err?.message || String(err)}`, server: server.name, username });
    }
  }

  // ── DevOps: suggest server creds update ──────────────────────────────────

  if (toolName === 'suggest_server_creds_update') {
    const serverId: number | undefined = typeof parsed.server_id === 'number' ? parsed.server_id : undefined;
    const newUsername: string = typeof parsed.new_username === 'string' ? parsed.new_username.trim() : '';
    const reason: string = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
    const useSshKey: boolean = parsed.use_ssh_key_for_login === true || parsed.use_ssh_key === true;
    const removePassword: boolean = parsed.remove_password === true;

    if (!serverId || !newUsername || !reason) {
      return JSON.stringify({ status: 'error', message: 'server_id, new_username и reason обязательны' });
    }

    const { getServerById } = await import('./devops.js');
    const server = getServerById(user.id, serverId);
    if (!server) {
      return JSON.stringify({ status: 'error', message: `Сервер с id=${serverId} не найден.` });
    }

    const payload: DesktopActionPayload = {
      action: 'suggest_server_creds_update',
      value: {
        confirmation_id: '',
        server_id: serverId,
        server_name: server.name,
        current_username: server.username,
        new_username: newUsername,
        reason,
        use_ssh_key: useSshKey,
        use_ssh_key_for_login: useSshKey,
        remove_password: removePassword,
      }
    };

    const { randomUUID } = await import('node:crypto');
    const confirmationId = randomUUID();
    payload.value = { ...(payload.value as Record<string, unknown>), confirmation_id: confirmationId };

    const credsAction = {
      type: 'desktop_action',
      action: 'suggest_server_creds_update',
      target: String(serverId),
      value: payload.value
    };

    let credsSent = false;
    if (subagentExtra?.onDesktopAction) {
      await subagentExtra.onDesktopAction(credsAction);
      credsSent = true;
    } else if (isDesktopOnline(user.id)) {
      sendToDesktop(user.id, credsAction);
      credsSent = true;
    }
    if (!credsSent) {
      return JSON.stringify({ status: 'error', message: 'Ни один клиент не подключён. Подтверждение невозможно.' });
    }

    // Auto-reject in scheduler mode
    if (autoRejectHitl) return JSON.stringify({ status: 'rejected', message: 'Task is running in auto-mode. Server credentials update confirmation was automatically rejected.' });

    const { registerPendingConfirmation } = await import('./devops-confirmations.js');
    try {
      const result = await new Promise<any>((resolve, reject) => {
        registerPendingConfirmation(confirmationId, {
          userId: user.id,
          serverId,
          command: `suggest_server_creds_update username=${newUsername} use_ssh_key_for_login=${useSshKey} remove_password=${removePassword}`,
          execute: async () => {
            const { updateServer } = await import('./devops.js');
            const updateResult = updateServer(user.id, serverId, {
              username: newUsername,
              useSshKeyForLogin: useSshKey,
              ...(removePassword ? { password: '' } : {}),
            });
            if (!updateResult.ok) throw new Error((updateResult as { ok: false; error: string }).error);
            return { ok: true, username: newUsername, use_ssh_key_for_login: useSshKey, remove_password: removePassword };
          },
          resolve,
          reject,
          createdAt: Date.now()
        });
      });

      return JSON.stringify({ status: 'success', message: `Credentials для "${server.name}" обновлены.`, result });
    } catch (err: any) {
      if (err?.message?.startsWith('rejected_by_user')) {
        return JSON.stringify(withRejectionComment({ status: 'rejected', message: 'Пользователь отклонил обновление credentials.', server: server.name }, err));
      }
      if (err?.message === 'confirmation_timeout' || err?.message === 'confirmation_expired') {
        return JSON.stringify({ status: 'timeout', message: 'Время ожидания подтверждения истекло (5 минут).', server: server.name });
      }
      return JSON.stringify({ status: 'error', message: `Ошибка обновления credentials: ${err?.message || String(err)}`, server: server.name });
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

  if (toolName === 'get_exchange_rates') {
    const codes: string[] = Array.isArray(parsed.currency_codes)
      ? parsed.currency_codes.filter((c: any) => typeof c === 'string' && c.trim())
      : [];
    const requestedCodes = codes.length > 0 ? codes.map((c: string) => c.toUpperCase().trim()) : ['USD', 'EUR'];
    const rows = getCurrencyRates(requestedCodes);
    if (rows.length === 0) {
      return 'Курсы валют пока недоступны. Данные ещё не загружены с ЦБ РФ — попробуй позже.';
    }
    const lines = rows.map(formatRateForAi);
    const missingCodes = requestedCodes.filter(c => !rows.some(r => r.code === c));
    const parts = [`Курсы ЦБ РФ на сегодня:`, ...lines];
    if (missingCodes.length > 0) {
      parts.push(`Валюта не найдена: ${missingCodes.join(', ')}`);
    }
    return parts.join('\n');
  }

  // --- invoke_subagent (desktop-only, delegates to a specialized subagent) ---
  if (toolName === 'invoke_subagent') {
    const agentName: string = typeof parsed.agent === 'string' ? parsed.agent.trim() : '';
    const task: string = typeof parsed.task === 'string' ? parsed.task.trim() : '';
    const contextData = parsed.context ?? undefined;

    if (!agentName) return JSON.stringify({ status: 'error', message: 'agent (имя субагента) обязательно' });
    if (!task) return JSON.stringify({ status: 'error', message: 'task (описание задачи) обязательно' });

    try {
      const { runSubagent } = await import('./subagents/runner.js');
      const result = await runSubagent({
        agentName,
        task,
        context: contextData,
        ctx: {
          userId: user.id,
          user,
          isDesktop: !!desktopActionSink,
          timezoneOffset,
          signal,
          desktopActionSink: desktopActionSink || undefined,
          onDesktopAction: subagentExtra?.onDesktopAction,
          onToolStatus: subagentExtra?.onToolStatus,
          manualModel: subagentExtra?.manualModel,
          subagentMode: subagentExtra?.subagentMode,
          subagentReasoningLevel: subagentExtra?.subagentReasoningLevel,
          runtimeToolDefs: subagentExtra?.availableToolDefs,
        },
      });

      return JSON.stringify({
        status: 'success',
        answer: result.answer,
        summary: result.summary,
        tools_used: result.toolCallsHistory.map(t => t.tool),
      });
    } catch (err: any) {
      console.warn('[ai] invoke_subagent error:', err?.message || err);
      return JSON.stringify({
        status: 'error',
        message: `Ошибка субагента ${agentName}: ${err?.message || String(err)}`,
      });
    }
  }

  // --- spawn_subagent (desktop-only, ad-hoc subagent created by the main agent) ---
  if (toolName === 'spawn_subagent') {
    const task: string = typeof parsed.task === 'string' ? parsed.task.trim() : '';
    const systemPrompt: string = typeof parsed.system_prompt === 'string' ? parsed.system_prompt.trim() : '';
    const requestedTools: string[] = Array.isArray(parsed.tools)
      ? parsed.tools.filter((t: any) => typeof t === 'string').map((t: string) => t.trim()).filter(Boolean)
      : [];
    const requestedMaxLoops: number = typeof parsed.max_loops === 'number'
      ? Math.min(Math.max(1, Math.floor(parsed.max_loops)), 50)
      : 20;

    if (!task) return JSON.stringify({ status: 'error', message: 'task (описание задачи) обязательно' });

    // Если бот не передал промпт — используем дефолтный
    const effectivePrompt = systemPrompt || 'Ты специализированный AI-ассистент. Выполни поставленную задачу, используя предоставленные тебе инструменты. Действуй последовательно и эффективно.';

    // Validate tools against the known tool set — reject unknown names early.
    // Use availableToolDefs (full runtime set) if provided, otherwise fall back to toolDefinitions.
    const runtimeDefs = subagentExtra?.availableToolDefs;
    const runtimeNames = (runtimeDefs && runtimeDefs.length > 0)
      ? runtimeDefs.map((t: any) => t?.function?.name).filter(Boolean)
      : null;
    const knownToolNames = new Set(
      runtimeNames || toolDefinitions.map((t: any) => t?.function?.name).filter(Boolean)
    );
    // Deny recursive spawning (already excluded by availableToolDefs, but double-check for fallback).
    knownToolNames.delete('spawn_subagent');
    knownToolNames.delete('invoke_subagent');

    const validTools = requestedTools.filter(t => knownToolNames.has(t));
    const rejectedTools = requestedTools.filter(t => !knownToolNames.has(t));
    if (requestedTools.length > 0 && validTools.length === 0) {
      return JSON.stringify({
        status: 'error',
        message: `Ни один из запрошенных инструментов не существует. Неизвестные: ${rejectedTools.join(', ')}`,
      });
    }

    try {
      const { buildAdhocSubagent } = await import('./subagents/registry.js');
      const { runSubagent } = await import('./subagents/runner.js');

      const agent = buildAdhocSubagent({
        systemPrompt: effectivePrompt.slice(0, 16384), // hard cap 16KB
        sharedTools: validTools,
        maxLoops: requestedMaxLoops,
      });

      const result = await runSubagent({
        agent,
        task,
        ctx: {
          userId: user.id,
          user,
          isDesktop: !!desktopActionSink,
          timezoneOffset,
          signal,
          desktopActionSink: desktopActionSink || undefined,
          onDesktopAction: subagentExtra?.onDesktopAction,
          onToolStatus: subagentExtra?.onToolStatus,
          manualModel: subagentExtra?.manualModel,
          subagentMode: subagentExtra?.subagentMode,
          subagentReasoningLevel: subagentExtra?.subagentReasoningLevel,
          onSubagentTrace: subagentExtra?.onSubagentTrace,
          runtimeToolDefs: subagentExtra?.availableToolDefs,
        },
      });

      const subagentTrace = {
        task,
        system_prompt: effectivePrompt.slice(0, 2000),
        tools: validTools,
        tools_used: result.toolCallsHistory.map(t => t.tool),
        answer: result.answer,
        summary: result.summary,
        aborted: result.aborted,
        iterations: result.iterations || [],
      };

      const response: any = {
        status: 'success',
        answer: result.answer,
        summary: result.summary,
        tools_used: result.toolCallsHistory.map(t => t.tool),
        tools_granted: validTools,
        subagentTrace,
      };
      if (rejectedTools.length > 0) {
        response.tools_rejected = rejectedTools;
      }
      if (result.aborted) {
        response.aborted = true;
      }

      // Push full trace for UI display via callback
      if (subagentExtra?.onSubagentTrace) {
        try {
          subagentExtra.onSubagentTrace({
            task,
            system_prompt: effectivePrompt.slice(0, 2000),
            tools: validTools,
            tools_used: result.toolCallsHistory.map(t => t.tool),
            answer: result.answer,
            summary: result.summary,
            aborted: result.aborted,
            iterations: result.iterations || [],
          });
        } catch {}
      }

      return JSON.stringify(response);
    } catch (err: any) {
      console.warn('[ai] spawn_subagent error:', err?.message || err);
      return JSON.stringify({
        status: 'error',
        message: `Ошибка ad-hoc субагента: ${err?.message || String(err)}`,
      });
    }
  }

  return `Ошибка: неизвестный инструмент ${toolName}`;
};

const getToolUserMessage = (toolName: string, argsRaw: string) => {
  if (toolName === 'search_web') return 'Ищу информацию в сети...';
  if (toolName === 'read_webpage') return 'Открываю страницу и извлекаю текст...';
  if (toolName === 'get_smart_devices') return '🏠 Получаю список устройств...';
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
  if (toolName === 'list_my_macros') return 'Ищу ваши макросы...';
  if (toolName === 'execute_macro') return 'Запускаю макрос...';
  if (toolName === 'explore_fs') return 'Читаю директорию...';
  if (toolName === 'suggest_macro') return 'Предлагаю сохранить макрос...';
  if (toolName === 'list_devops_servers') return 'Получаю список серверов...';
  if (toolName === 'execute_ssh_command') return 'Выполняю команду на сервере...';
  if (toolName === 'execute_pc_command') return 'Выполняю команду на ПК...';
  if (toolName === 'get_file_info') return 'Проверяю файл...';
  if (toolName === 'read_file') return 'Читаю файл...';
  if (toolName === 'search_file_keywords') return 'Ищу в файле...';
  if (toolName === 'write_file') return 'Записываю файл...';
  if (toolName === 'edit_file_lines') return 'Редактирую файл...';
  if (toolName === 'capture_screen') return 'Делаю скриншот экрана...';
  if (toolName === 'execute_visual_click') return 'Жду подтверждения клика...';
  if (toolName === 'list_devops_runbooks') return 'Ищу инструкции...';
  if (toolName === 'read_devops_runbook') return 'Читаю инструкцию...';
  if (toolName === 'suggest_devops_runbook') return 'Предлагаю сохранить инструкцию...';
  if (toolName === 'install_ssh_public_key') return 'Устанавливаю SSH-ключ...';
  if (toolName === 'create_server_user') return 'Создаю пользователя на сервере...';
  if (toolName === 'change_server_user_password') return 'Запрашиваю смену пароля пользователя...';
  if (toolName === 'suggest_server_creds_update') return 'Предлагаю обновить учётные данные...';
  if (toolName === 'get_exchange_rates') return 'Запрашиваю курсы валют...';
  if (toolName === 'invoke_subagent') {
    try {
      const parsed = JSON.parse(argsRaw || '{}');
      const agent = parsed.agent || '';
      return `Вызываю субагента "${agent}"...`;
    } catch { return 'Вызываю субагента...'; }
  }
  if (toolName === 'spawn_subagent') {
    try {
      const parsed = JSON.parse(argsRaw || '{}');
      const task = String(parsed.task || '').slice(0, 60);
      return task ? `🧠 Запускаю субагента: ${task}...` : '🧠 Запускаю субагента...';
    } catch { return '🧠 Запускаю субагента...'; }
  }
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
    skipUserHistory?: boolean;
    persistUserText?: string;
    userTelegramChatId?: number | null;
    userTelegramMessageId?: number | null;
    assistantTelegramChatId?: number | null;
    displayManifest?: { moods?: string[]; reactions?: string[] } | null;
    currentDisplayState?: DisplayStatePayload | null;
    isDesktop?: boolean;
    isVoice?: boolean;
    diceRollMode?: boolean;
    diceRollForceValue?: number;
    onDesktopAction?: (action: DesktopActionPayload) => Promise<void> | void;
    images?: Array<{ base64: string; mimeType: string }>;
    userImages?: Array<{ url: string; type: 'user_photo' }> | null;
    userAttachments?: MessageAttachment[] | null;
    promptUserId?: number;
    onIntermediateMessage?: (text: string) => Promise<void> | void;
    onStateChange?: (state: DisplayStatePayload) => Promise<void> | void;
    onToolStatus?: (text: string) => Promise<void> | void;
    onMapUpdate?: (data: MapUpdatePayload) => Promise<void> | void;
    onDiceRoll?: (roll: number) => Promise<void> | void;
    /** Стрим токенов контента в реальном времени (уже оттроттлено в streamAndAssemble). */
    onStreamToken?: (text: string) => Promise<void> | void;
    /** Стрим reasoning-токенов в реальном времени. */
    onReasoningStream?: (text: string) => Promise<void> | void;
    activeMacros?: Array<{ id: number; title: string; description?: string; commands: string[]; pinned?: boolean; return_output?: boolean }>;
    preferredModel?: string | null;
    featureFlags?: {
      disable_memory_write?: boolean;
      disable_pc_control_lite?: boolean;
      disable_pc_control_full?: boolean;
      disable_pc_commands?: boolean;
      disable_internet?: boolean;
      disable_personal?: boolean;
      disable_specialized_subagents?: boolean;
      disable_adhoc_subagents?: boolean;
    } | null;
    regenerateHint?: string;
    regenerateFromHistory?: boolean;
    reasoningLevel?: ReasoningLevel | null;
    autoRejectHitl?: boolean;
    isBackgroundTask?: boolean;
  }
): Promise<AiSendResult> => {
  const user = getUserById(userId);
  if (!user) throw new Error('user_not_found');
  if (user.status !== 'approved' && user.is_admin !== 1) throw new Error('user_not_approved');

  const images = options?.images?.filter(img => img.base64) ?? [];
  const hasImages = images.length > 0;
  const requestedRegenerateFromHistory = Boolean(options?.regenerateFromHistory);
  let text = (inputText || '').trim();
  if (!text && !hasImages) throw new Error('empty_text');
  if (!text) text = hasImages ? (images.length === 1 ? 'Что на этой картинке?' : `Что на этих ${images.length} картинках?`) : '';
  const forceProRoute = Boolean(options?.forcePro) || text.startsWith('!!!') || hasImages;
  if (forceProRoute && !options?.forcePro && !hasImages) {
    text = text.replace(/^!{3,}/, '').trim();
    if (!text) throw new Error('empty_text');
  }

  // Резолв preferred model: из options (явный запрос) или из профиля юзера
  const preferredModelId = options?.preferredModel || user.preferred_model || null;
  let manualModel = preferredModelId ? resolveManualModel(preferredModelId) : undefined;
  if (preferredModelId && !manualModel) {
    console.warn(`[ai] preferred_model "${preferredModelId}" not found in MODELS_MANUAL, falling back to auto`);
  }
  const subagentModelId = user.subagent_mode && user.subagent_mode !== 'auto' ? user.subagent_mode : null;
  const subagentManualModel = subagentModelId ? resolveManualModel(subagentModelId) : undefined;
  if (subagentModelId && !subagentManualModel) {
    console.warn(`[ai] subagent_model "${subagentModelId}" not found in MODELS_MANUAL, falling back to auto`);
  }
  const subagentMode: 'auto' | 'manual' = subagentManualModel ? 'manual' : 'auto';

  // Резолв reasoning level: из options (явный запрос) или из профиля юзера
  const reasoningLevel: ReasoningLevel | null = options?.reasoningLevel ?? (user as any).reasoning_level ?? null;
  const subagentReasoningLevel: ReasoningLevel | null = ((user as any).subagent_reasoning_level || null) as ReasoningLevel | null;

  // Резолв model settings: per-model настройки генерации (temperature, penalties, etc.).
  // Применяются только для ручной модели (preferred_model). В lite-режиме и при fallback на auto — игнорируются.
  let resolvedModelSettings: ModelSettings | null = null;
  if (preferredModelId) {
    try {
      const raw = (user as any).model_settings as string | null | undefined;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed[preferredModelId]) {
          resolvedModelSettings = parsed[preferredModelId] as ModelSettings;
        }
      }
    } catch {
      // broken JSON — игнорируем, используем серверные дефолты
    }
  }

  // Daily message limit removed — switched to token-based context limits.
  // Token counting remains for statistics only.

  const previousController = activeGenerations.get(userId);
  if (previousController && !previousController.signal.aborted) {
    if (activeHitlWaits.has(userId)) {
      const waitingChatId = targetChatId && Number.isFinite(targetChatId) ? targetChatId : ensureActiveChat(userId);
      return {
        reply_text: 'Я жду твоего ответа на карточку подтверждения выше. Нажми «Разрешить», «Отклонить» или «Отклонить с комментарием» — и я продолжу тот запрос.',
        chat_id: waitingChatId,
        message_id: 0,
        usage: {
          tokens_used: 0,
          used_model: 'system',
          used_provider: 'local'
        }
      };
    }
    previousController.abort();
  }

  const abortController = new AbortController();
  if (!options?.isBackgroundTask) {
    activeGenerations.set(userId, abortController);
  }

  // ── Стрим-колбеки для токен-стриминга в реальном времени ──
  const streamCallbacks: StreamCallbacks | undefined =
    (options?.onStreamToken || options?.onReasoningStream)
      ? {
          onToken: options?.onStreamToken
            ? (t) => { Promise.resolve(options.onStreamToken!(t)).catch(e => console.warn('[stream onToken]', e)); }
            : undefined,
          onReasoningToken: options?.onReasoningStream
            ? (t) => { Promise.resolve(options.onReasoningStream!(t)).catch(e => console.warn('[stream onReasoningToken]', e)); }
            : undefined,
        }
      : undefined;

  console.log('[sendMessageThroughAi] streamCallbacks', {
    hasOptions: !!options,
    hasOnStreamToken: !!options?.onStreamToken,
    hasOnReasoningStream: !!options?.onReasoningStream,
    streamCallbacksBuilt: !!streamCallbacks,
    hasOnToken: !!streamCallbacks?.onToken,
    hasOnReasoningToken: !!streamCallbacks?.onReasoningToken,
  });

  let chatId = 0;
  let totalTokens = 0;
  let usedModel = '';
  let usedProvider = '';
  let diceRollValue: number | null = null;

  // ── Soft-abort buffers: объявляем ВНЕ try, чтобы catch имел к ним доступ ──
  let answer = FALLBACK_ANSWER;
  let fullDbHistory = '';
  let finalAnswer = '';
  const reasoningParts: string[] = [];
  const toolCallsHistory: Array<{ id?: string; name: string; arguments: any; result_preview?: string }> = [];
  const iterations: ToolIteration[] = [];
  const toolUserMessages: string[] = [];
  const generatedImages: Array<{ image_base64: string; image_url?: string; prompt_used: string }> = [];
  let assistantTelegramChatId: number | null = null;
  let userMessageId = 0;

  // Subagent traces — полные trace ad-hoc субагентов для отдельного UI-блока.
  // Не уходят в AI-контекст, только для отображения в сообщении.
  const subagentTraces: Array<{
    task: string;
    system_prompt: string;
    tools: string[];
    tools_used: string[];
    answer: string;
    summary: string;
    aborted?: boolean;
    iterations: Array<{
      step: number;
      content: string;
      tool_calls: Array<{ id?: string; name: string; arguments: any }>;
      results: Array<{ id?: string; name: string; content: string }>;
      is_final?: boolean;
    }>;
  }> = [];

  try {
  chatId = targetChatId && Number.isFinite(targetChatId) ? targetChatId : ensureActiveChat(userId);
  const contextWindow = resolveEffectiveContextWindow(user);
  const maxContextTokens = resolveMaxContextTokens(user);
  const attachmentMaxTokens = resolveAttachmentMaxTokens(user);
  let history = getHistoryForAi(userId, chatId, contextWindow, attachmentMaxTokens);
  let regenerateUserText: string | null = null;
  if (requestedRegenerateFromHistory) {
    history = [...history];
    while (history.length > 0 && history[history.length - 1]?.role === 'assistant') {
      history.pop();
    }
    if (history[history.length - 1]?.role === 'user') {
      regenerateUserText = history.pop()?.content || null;
    }
  }
  const isRegeneratingFromHistory = Boolean(regenerateUserText);
  const timezone = Number.isFinite(Number(user.timezone_offset)) ? Number(user.timezone_offset) : 5;
  const dynamicContextToolHint = `\n\n[ДИНАМИЧЕСКИЙ КОНТЕКСТ]\nТекущее время пользователя доступно через tool get_user_time. Не угадывай текущую дату/время: вызывай get_user_time, когда это важно для ответа или планирования.\nТекущее состояние пиксельного аватара доступно через tool get_avatar_state. Для изменения эмоций используй set_display_state.`;
  const avatarPromptHint = options?.displayManifest ? AVATAR_PROMPT_HINT : '';
  const promptUser = options?.promptUserId ? getUserById(options.promptUserId) ?? user : user;
  const voicePromptHint = options?.isVoice ? `\n\nСТРОГО, ОБЯЗАТЕЛЬНО СЕЙЧАС, ОБЯЗАТЕЛЬНО!!! соблюдай:\n1. Отвечай МАКСИМАЛЬНО кратко. МАКСИМАЛЬНО КРАТКО и естественно, как в устном диалоге.\n2. НИКАКИХ длинных списков, Markdown-таблиц или блоков кода, если только об этом не попросили напрямую.\n3. Используй разговорный стиль. МАКСИМАЛЬНО краткий, УДОБНЫЙ к прослушиванию и содержательный. 4. Замена символов словами: Заменяй любые технические знаки, аббревиатуры и единицы измерения их полными словесными названиями. 
   - Запрещено: "%", "°C", "м/с", "км/ч", "$", "руб."
   - Обязательно писать: "процентов", "градусов Цельсия", "метров в секунду", "километров в час", "долларов", "рублей".` : '';
  const pinnedMacros = options?.activeMacros?.filter(m => m.pinned) ?? [];
  const pinnedHint = pinnedMacros.length > 0
    ? `\n\n[ЗАКРЕПЛЁННЫЕ МАКРОСЫ]\nУ пользователя есть часто используемые макросы: ${pinnedMacros.map(m => `"${m.title}"`).join(', ')}. Если запрос пользователя явно совпадает с назначением одного из них — вызови list_my_macros чтобы посмотреть подробности, затем execute_macro для запуска.`
    : '';

  // ── Feature flags → disabled tools ──
  const flags = options?.featureFlags;
  const disabledToolSet = new Set<string>();
  if (flags?.disable_memory_write) {
    disabledToolSet.add('save_to_cold_memory');
    disabledToolSet.add('delete_from_cold_memory');
    disabledToolSet.add('save_note');
    disabledToolSet.add('delete_note');
  }
  // Команды на ПК: отключает только execute_pc_command
  if (flags?.disable_pc_commands) {
    disabledToolSet.add('execute_pc_command');
    disabledToolSet.add('get_file_info');
    disabledToolSet.add('read_file');
    disabledToolSet.add('search_file_keywords');
    disabledToolSet.add('write_file');
    disabledToolSet.add('edit_file_lines');
    disabledToolSet.add('capture_screen');
    disabledToolSet.add('execute_visual_click');
  }
  // Лайт: отключает опасное, оставляет read-only
  if (flags?.disable_pc_control_lite) {
    disabledToolSet.add('execute_ssh_command');
    disabledToolSet.add('list_devops_servers');
    disabledToolSet.add('list_devops_runbooks');
    disabledToolSet.add('read_devops_runbook');
    disabledToolSet.add('suggest_devops_runbook');
    disabledToolSet.add('install_ssh_public_key');
    disabledToolSet.add('suggest_server_creds_update');
    disabledToolSet.add('create_server_user');
    disabledToolSet.add('change_server_user_password');
    disabledToolSet.add('execute_macro');
    disabledToolSet.add('suggest_macro');
    disabledToolSet.add('list_my_macros');
    disabledToolSet.add('send_email');
    disabledToolSet.add('schedule_task');
    disabledToolSet.add('delete_my_task');
  }
  // Полная блокировка: всё десктопное + управление
  if (flags?.disable_pc_control_full) {
    // Всё из лайта
    disabledToolSet.add('execute_ssh_command');
    disabledToolSet.add('execute_pc_command');
    disabledToolSet.add('get_file_info');
    disabledToolSet.add('read_file');
    disabledToolSet.add('search_file_keywords');
    disabledToolSet.add('write_file');
    disabledToolSet.add('edit_file_lines');
    disabledToolSet.add('suggest_devops_runbook');
    disabledToolSet.add('install_ssh_public_key');
    disabledToolSet.add('suggest_server_creds_update');
    disabledToolSet.add('create_server_user');
    disabledToolSet.add('change_server_user_password');
    disabledToolSet.add('execute_macro');
    disabledToolSet.add('suggest_macro');
    disabledToolSet.add('list_my_macros');
    disabledToolSet.add('send_email');
    disabledToolSet.add('schedule_task');
    disabledToolSet.add('delete_my_task');
    // Плюс read-only десктоп
    disabledToolSet.add('control_smart_home');
    disabledToolSet.add('get_smart_devices');
    disabledToolSet.add('check_emails');
    disabledToolSet.add('read_email_content');
    disabledToolSet.add('get_my_tasks');
    disabledToolSet.add('explore_fs');
    disabledToolSet.add('capture_screen');
    disabledToolSet.add('execute_visual_click');
    disabledToolSet.add('desktop_action');
    disabledToolSet.add('map_control');
    disabledToolSet.add('get_map_pins');
    disabledToolSet.add('find_transit_route');
    disabledToolSet.add('search_nearby');
    disabledToolSet.add('list_devops_servers');
    disabledToolSet.add('list_devops_runbooks');
    disabledToolSet.add('read_devops_runbook');
  }
  if (flags?.disable_internet) {
    disabledToolSet.add('search_web');
    disabledToolSet.add('read_webpage');
    disabledToolSet.add('generate_image');
  }
  if (flags?.disable_personal) {
    disabledToolSet.add('update_core_memory');
    disabledToolSet.add('search_cold_memory');
    disabledToolSet.add('save_to_cold_memory');
    disabledToolSet.add('delete_from_cold_memory');
    disabledToolSet.add('save_note');
    disabledToolSet.add('list_my_notes');
    disabledToolSet.add('read_note');
    disabledToolSet.add('delete_note');
    disabledToolSet.add('schedule_task');
    disabledToolSet.add('get_my_tasks');
    disabledToolSet.add('delete_my_task');
  }
  if (flags?.disable_specialized_subagents) {
    disabledToolSet.add('invoke_subagent');
  }
  if (flags?.disable_adhoc_subagents) {
    disabledToolSet.add('spawn_subagent');
  }
  if (disabledToolSet.size > 0) {
    console.log(`[feature-flags] user=${userId} disabled tools: ${[...disabledToolSet].join(', ')}`);
  }
  const isGuestMode = Boolean(flags?.disable_personal);
  const promptContent = isGuestMode ? '' : resolvePromptForUser(promptUser).content;
  const coreMemoryForPrompt = isGuestMode ? '' : (user.core_memory || '');
  const pinnedHintForPrompt = isGuestMode ? '' : pinnedHint;

  // ── Dice Roll Mode (d20 roleplay) ──
  // Бэкенд кидает кубик и сразу пушит результат клиентам через onDiceRoll
  // (клиент останавливает анимацию на значении). В AiSendResult.dice_roll
  // результат дублируется для восстановления в done-событии.
  let dicePromptHint = '';
  if (options?.diceRollMode) {
    const force = options?.diceRollForceValue;
    if (typeof force === 'number' && force >= 1 && force <= 20) {
      diceRollValue = Math.floor(force);
    } else {
      diceRollValue = Math.floor(Math.random() * 20) + 1; // 1..20
    }
    dicePromptHint = buildDiceRollPrompt(diceRollValue);
    // Отправляем результат сразу — клиент зафиксирует значение и остановит анимацию.
    try { await options?.onDiceRoll?.(diceRollValue); } catch { /* ignore */ }
  }

  const proSystemPrompt = `${voicePromptHint}${buildSystemPrompt(promptContent, user.name || user.tg_username || 'Пользователь', coreMemoryForPrompt)}${pinnedHintForPrompt}${dynamicContextToolHint}${avatarPromptHint}${hasImages ? '\n\nЕсли пользователь прислал изображение(я), анализируй его/их и отвечай конкретно по запросу пользователя.' : ''}${dicePromptHint}`;

  let executionMode: 'pro' | 'lite' | 'vision-pro' | 'vision-lite' = hasImages
    ? (user.plan === 'pro' ? 'vision-pro' : 'vision-lite')
    : 'pro';
  const subagentTool = options?.isDesktop ? buildInvokeSubagentTool() : null;
  // Tools that work from the server (SSH, maps, DevOps DB, PC command via WS) — available to ALL clients
  const serverOnlyTools = [
    buildMapControlTool(), buildGetMapPinsTool(), buildFindTransitRouteTool(), buildSearchNearbyTool(),
    buildListDevopsServersTool(), buildExecuteSshCommandTool(), buildListRunbooksTool(),
    buildReadRunbookTool(), buildSuggestRunbookTool(), buildInstallSshPublicKeyTool(),
    buildSuggestServerCredsUpdateTool(), buildCreateServerUserTool(), buildChangeServerUserPasswordTool(),
    buildExecutePcCommandTool(), buildGetFileInfoTool(),
    buildReadFileTool(), buildSearchFileKeywordsTool(), buildWriteFileTool(), buildEditFileLinesTool(),
    buildCaptureScreenTool(), buildExecuteVisualClickTool(),
  ];
  // Tools that require a desktop client UI — only when isDesktop
  const desktopOnlyTools = options?.isDesktop ? [
    buildDesktopActionTool(),
  ] : [];
  // Build spawn_subagent AFTER we know all available tools (including serverOnlyTools, desktopOnlyTools, etc.)
  // so the model can see and grant the full set.
  const allBaseToolDefs = [
    ...toolDefinitions, buildDisplayStateTool(options?.displayManifest),
    ...serverOnlyTools,
    ...desktopOnlyTools,
  ];
  const spawnSubagentTool = options?.isDesktop ? buildSpawnSubagentTool(allBaseToolDefs) : null;
  let executionTools: any[] = [
    ...allBaseToolDefs,
    ...(subagentTool ? [subagentTool] : []),
    ...(spawnSubagentTool ? [spawnSubagentTool] : []),
    ...(options?.activeMacros && options.activeMacros.length > 0 ? [buildListMyMacrosTool(), buildExecuteMacroTool(), buildExploreFsTool(), buildSuggestMacroTool()] : [])
  ].filter(t => !disabledToolSet.has(t?.function?.name || '')) as any[];

  let executionHistory = history;
  let executionSystemPrompt = proSystemPrompt;

if (!forceProRoute && !isRegeneratingFromHistory && LITE_ROUTER_ENABLED && !manualModel) {
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
    SMART_HOME: ['control_smart_home', 'get_smart_devices'],
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
      }, undefined, abortController.signal, 'none');

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
    } catch (err) {
      if (isAbortError(err)) throw err;
      routeLabel = 'PRO';
    }
  }

  if (routeLabel !== 'PRO') {
    const allowedToolNames = cheapMap[routeLabel];

    if (allowedToolNames.length && !allowedToolNames.some(n => disabledToolSet.has(n))) {
      executionTools = buildLiteExecutionTools(allowedToolNames);
      executionHistory = [];
      executionSystemPrompt = LITE_ROUTER_INSTRUCTIONS;
      executionMode = 'lite';
    }
  }
}

  let userMessageContent: any = hasImages
    ? [
        { type: 'text', text: regenerateUserText || text },
        ...images.map(img => ({
          type: 'image_url',
          image_url: { url: `data:${img.mimeType};base64,${img.base64}` }
        }))
      ]
    : (regenerateUserText || text);

  // Append regeneration hint to the current request (not saved to DB).
  if (options?.regenerateHint) {
    const hintText = `\n\n[УКАЗАНИЕ ДЛЯ ПЕРЕГЕНЕРАЦИИ: "${options.regenerateHint}"]`;
    if (typeof userMessageContent === 'string') {
      userMessageContent += hintText;
    } else if (Array.isArray(userMessageContent)) {
      userMessageContent = [...userMessageContent, { type: 'text', text: hintText }];
    }
  }

  // Append user attachments (documents) as text injection into the current request.
  // The same injection is replayed from history via getHistoryForAi, but for the
  // fresh message we add it here since it hasn't been saved yet.
  if (options?.userAttachments && options.userAttachments.length > 0) {
    const attText = injectAttachments(options.userAttachments, attachmentMaxTokens);
    if (attText) {
      if (typeof userMessageContent === 'string') {
        userMessageContent += '\n\n' + attText;
      } else if (Array.isArray(userMessageContent)) {
        userMessageContent = [...userMessageContent, { type: 'text', text: '\n\n' + attText }];
      }
    }
  }

  const currentMessages: any[] = [
    { role: 'system', content: executionSystemPrompt },
    ...executionHistory,
    { role: 'user', content: userMessageContent }
  ];

  let loop = 0;
  const effectiveMaxLoops = options?.isVoice ? MAX_TOOL_LOOPS_VOICE : MAX_TOOL_LOOPS;
  const toolOutputsForFallback: string[] = [];
  const displayStateSink: { value: DisplayStatePayload | null } = { value: null };
  const desktopActionSink: { value: DesktopActionPayload | null } = { value: null };
  const mapUpdateSink: { value: MapUpdatePayload | null } = { value: null };
  let modelFallbackNotice: string | null = null;
  let modelFallbackNoticeSent = false;

  while (loop < effectiveMaxLoops) {
    loop += 1;

    // Hint when approaching limit — nudge the model to wrap up
    if (loop === effectiveMaxLoops - 1) {
      currentMessages.push({
        role: 'system',
        content: `Внимание: остался один вызов инструмента. После него лимит будет исчерпан. Вызови последний инструмент если нужно, а затем ОБЯЗАТЕЛЬНО сформулируй итоговый ответ пользователю, подведя результаты всех вызовов.`
      });
    }
    const completion = await runCompletion(executionMode, {
      messages: currentMessages,
      tools: executionTools,
      tool_choice: 'auto',
      max_tokens: 16384,
      thinking: { type: executionMode === 'lite' ? 'disabled' : 'enabled' },
      clear_thinking: false
    }, manualModel, abortController.signal, executionMode === 'lite' ? 'none' : reasoningLevel, executionMode === 'lite' ? null : resolvedModelSettings, streamCallbacks);
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
    if (completion.manualFallback && !modelFallbackNoticeSent) {
      modelFallbackNoticeSent = true;
      modelFallbackNotice = `⚙️ Выбранная модель недоступна. Ответ получен автоматически от ${completion.usedProvider}/${completion.usedModel}.`;
      // Не пытаться снова стучаться в упавшую модель в последующих итерациях
      manualModel = undefined;
    }
    usedModel = completion.usedModel;
    usedProvider = completion.usedProvider;
    const response = completion.response;
    totalTokens += extractTokens(response);
    const message = response?.choices?.[0]?.message || {};
    const stepReasoning = extractReasoning(message, response);
    if (stepReasoning) reasoningParts.push(stepReasoning);
    // Collect tool calls for UI display
    if (message.tool_calls?.length) {
      for (const tc of message.tool_calls) {
        if (tc.type !== 'function') continue;
        let parsedArgs: any = tc.function?.arguments ?? tc.arguments;
        if (typeof parsedArgs === 'string') {
          try { parsedArgs = JSON.parse(parsedArgs); } catch { /* keep as string */ }
        }
        toolCallsHistory.push({ id: tc.id, name: tc.function?.name ?? tc.name ?? '', arguments: parsedArgs });
      }
    }
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

    // Создаём запись итерации для trace (наполнится results ниже в цикле tool_calls).
    // Используем оригинальные tool_call объекты из message — в том же порядке, как их вернула модель.
    const currentIteration: ToolIteration = {
      step: loop,
      content: stepContent,
      tool_calls: (message.tool_calls || [])
        .filter((tc: any) => tc.type === 'function')
        .map((tc: any) => ({
          id: tc.id,
          name: tc.function?.name ?? tc.name ?? '',
          arguments: (() => {
            let a: any = tc.function?.arguments ?? tc.arguments;
            if (typeof a === 'string') { try { a = JSON.parse(a); } catch { /* keep as string */ } }
            return a;
          })()
        })),
      results: []
    };

    if (!message.tool_calls?.length) {
      const finishReason = response?.choices?.[0]?.finish_reason;

      // Формируем ответ на выход из функции
      if (fullDbHistory) {
        // Всегда возвращаем полный текст (включая промежуточные шаги).
        // Раньше при наличии finalAnswer возвращался только последний кусок,
        // что приводило к перезаписи накопленного intermediate контента на десктопе.
        answer = fullDbHistory;
      } else if (toolOutputsForFallback.length) {
        answer = toolOutputsForFallback[toolOutputsForFallback.length - 1] || FALLBACK_ANSWER;
      }

      if (finishReason === 'length') {
        console.warn(`[AI TRUNCATE] finish_reason=length, model=${completion.usedModel}, provider=${completion.usedProvider}, content_len=${stepContent.length}`);
      }
      // Финальная итерация без tool_calls — фиксируем в trace.
      currentIteration.is_final = true;
      iterations.push(currentIteration);
      break;
    }

let escalatedToPro = false;

type ExecutedToolCall = {
  toolCall: any;
  toolName: string;
  toolContent: string;
};

const runOneToolCall = async (toolCall: any, emitStatus = true): Promise<ExecutedToolCall> => {
  throwIfAborted(abortController.signal);

  const toolName = `${toolCall.function?.name || ''}`;

  const toolUserMessage = getToolUserMessage(toolName, toolCall.function?.arguments || '{}');
  if (emitStatus && toolUserMessage) {
    toolUserMessages.push(toolUserMessage);
    if (options?.onToolStatus) await options.onToolStatus(toolUserMessage);
  }

  let toolContent = '';
  try {
    if (disabledToolSet.has(toolName)) {
      toolContent = `Инструмент "${toolName}" отключён текущими настройками ограничений.`;
    } else {
    toolContent = await withAbort(
      runTool(
        user,
        timezone,
        toolName,
        toolCall.function?.arguments || '{}',
        (payload) => runCompletion('pro', payload, undefined, abortController.signal),
        generatedImages,
        displayStateSink,
        desktopActionSink,
        mapUpdateSink,
        options?.activeMacros,
        abortController.signal,
        {
          manualModel: subagentManualModel,
          subagentMode,
          subagentReasoningLevel,
          onToolStatus: options?.onToolStatus,
          onDesktopAction: options?.onDesktopAction,
          displayManifest: options?.displayManifest,
          currentDisplayState: options?.currentDisplayState,
          availableToolDefs: executionTools.filter(
            (t: any) => t?.function?.name && t.function.name !== 'spawn_subagent' && t.function.name !== 'invoke_subagent'
          ),
        },
        options?.autoRejectHitl
      ),
      abortController.signal
    );

    // Если тулз изменил состояние аватара — прокидываем наружу в реалтайме
    if (toolName === 'set_display_state' && displayStateSink.value && options?.onStateChange) {
      await options.onStateChange(displayStateSink.value);
    }

    // Если тулз вызвал desktop_action / macro tools — прокидываем наружу в реалтайме
    if ((toolName === 'desktop_action' || toolName === 'execute_macro' || toolName === 'explore_fs' || toolName === 'get_file_info' || toolName === 'suggest_macro' || toolName === 'execute_ssh_command' || toolName === 'execute_pc_command' || toolName === 'read_file' || toolName === 'search_file_keywords' || toolName === 'write_file' || toolName === 'edit_file_lines' || toolName === 'suggest_devops_runbook' || toolName === 'install_ssh_public_key' || toolName === 'suggest_server_creds_update' || toolName === 'execute_visual_click') && desktopActionSink.value && options?.onDesktopAction) {
      await options.onDesktopAction(desktopActionSink.value);
    }

    // Если тулз вызвал map_control или find_transit_route — прокидываем данные карты
    if ((toolName === 'map_control' || toolName === 'find_transit_route' || toolName === 'search_nearby') && mapUpdateSink.value && options?.onMapUpdate) {
      await options.onMapUpdate(mapUpdateSink.value);
    }
    }
  } catch (err: any) {
    if (isAbortError(err)) throw err;
    toolContent = `Ошибка инструмента ${toolName}: ${err?.message || String(err)}`;
  }

  return { toolCall, toolName, toolContent };
};

const applyExecutedToolCall = (executed: ExecutedToolCall) => {
  const { toolCall, toolName, toolContent } = executed;
  const resultPreview = formatToolResultPreview(toolContent);
  if (resultPreview) {
    const historyEntry = [...toolCallsHistory]
      .reverse()
      .find(t => (toolCall.id && t.id === toolCall.id) || (!toolCall.id && t.name === toolName && !t.result_preview));
    if (historyEntry) historyEntry.result_preview = resultPreview;
  }

  // Сохраняем полный результат инструмента в trace итерации (для корректного разворота
  // в getHistoryForAi). Ограничиваем TOOL_RESULT_FULL_MAX, чтобы tool_calls_json не разрастался.
  const fullResultContent = toolContent.length > TOOL_RESULT_FULL_MAX
    ? toolContent.slice(0, TOOL_RESULT_FULL_MAX) + `\n\n[...результат обрезан, всего ${toolContent.length} символов]`
    : toolContent;
  currentIteration.results.push({ id: toolCall.id, name: toolName, content: fullResultContent });

  currentMessages.push({
    role: 'tool',
    tool_call_id: toolCall.id,
    content: toolContent
  });

  if (toolContent.trim()) {
    toolOutputsForFallback.push(toolContent.trim());
  }
  if (toolName === 'spawn_subagent') {
    try {
      const parsed = JSON.parse(toolContent);
      if (parsed?.subagentTrace && typeof parsed.subagentTrace === 'object') {
        subagentTraces.push(parsed.subagentTrace);
      }
    } catch {}
  }
};

const runSpawnBatch = async (batch: any[]) => {
  for (const toolCall of batch) {
    const toolUserMessage = getToolUserMessage('spawn_subagent', toolCall.function?.arguments || '{}');
    if (toolUserMessage) {
      toolUserMessages.push(toolUserMessage);
      if (options?.onToolStatus) await options.onToolStatus(toolUserMessage);
    }
  }

  const results: ExecutedToolCall[] = new Array(batch.length);
  let nextIndex = 0;
  const workerCount = Math.min(MAX_PARALLEL_SPAWN_SUBAGENTS, batch.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (!abortController.signal.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= batch.length) break;
      results[index] = await runOneToolCall(batch[index], false);
    }
  }));

  for (const result of results) {
    if (!result || abortController.signal.aborted) break;
    applyExecutedToolCall(result);
  }
};

const toolCalls = (message.tool_calls || []).filter((tc: any) => tc.type === 'function');
for (let toolCallIndex = 0; toolCallIndex < toolCalls.length; toolCallIndex += 1) {
  if (abortController.signal.aborted) break;

  const toolCall = toolCalls[toolCallIndex];
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
    currentMessages.length = 0;
    currentMessages.push(
      { role: 'system', content: proSystemPrompt },
      ...history,
      { role: 'user', content: originalQuery }
    );

    escalatedToPro = true;
    break;
  }

  if (toolName === 'spawn_subagent') {
    const batch = [toolCall];
    while (toolCallIndex + 1 < toolCalls.length) {
      const nextToolCall = toolCalls[toolCallIndex + 1];
      const nextToolName = `${nextToolCall.function?.name || ''}`;
      if (nextToolName !== 'spawn_subagent') break;
      batch.push(nextToolCall);
      toolCallIndex += 1;
    }
    await runSpawnBatch(batch);
    continue;
  }

  try {
    const result = await runOneToolCall(toolCall);
    if (abortController.signal.aborted) break;
    applyExecutedToolCall(result);
  } catch (err: any) {
    if (isAbortError(err)) break;
    const toolContent = `Ошибка инструмента ${toolName}: ${err?.message || String(err)}`;
    applyExecutedToolCall({ toolCall, toolName, toolContent });
  }
}

if (escalatedToPro) {
  // При эскалации в PRO история пересоздаётся с нуля — текущая итерация не валидна для trace.
  continue;
}

// Если были прерваны во время tool_calls — фиксируем partial-итерацию в trace
// и переходим к soft-save вместо throw (артефакты сохраняются).
if (abortController.signal.aborted) {
  // Сохраняем даже неполную итерацию — там могут быть уже выполненные tool_results
  if (currentIteration.tool_calls.length > 0 || currentIteration.results.length > 0) {
    iterations.push(currentIteration);
  }
  break;
}

// Итерация полностью выполнена (все tool_calls обработаны, не прервана, не эскалирована) —
// фиксируем её в trace.
iterations.push(currentIteration);
  }

  // ── Tool loops exhausted — force a final answer ───────────────────────
  // If we exited the while loop without break, the model still wants to call tools.
  // Inject a message telling it to answer now, then do one final completion.
  if (loop >= effectiveMaxLoops && !finalAnswer) {
    currentMessages.push({
      role: 'system',
      content: 'Лимит вызовов инструментов исчерпан. НЕ вызывай больше инструменты. Сформулируй финальный ответ пользователю прямо сейчас на основе имеющихся данных.'
    });

    // --- Sanitary block: clean up last assistant message ---
    // If the last assistant message has dangling tool_calls (no tool response),
    // the API will reject it. Strip them + clean any leaked pseudo-XML artifacts.
    for (let i = currentMessages.length - 1; i >= 0; i--) {
      if (currentMessages[i].role === 'assistant') {
        const lastAsst = currentMessages[i];
        if (lastAsst.tool_calls) {
          delete lastAsst.tool_calls;
        }
        if (typeof lastAsst.content === 'string') {
          lastAsst.content = lastAsst.content.split('<｜｜DSML｜｜')[0].trim();
        }
        break;
      }
    }

    try {
      const finalCompletion = await runCompletion(executionMode, {
        messages: currentMessages,
        tools: [],  // no tools — force text-only response
        max_tokens: 8192,
        thinking: { type: executionMode === 'lite' ? 'disabled' : 'enabled' },
        clear_thinking: false
      }, manualModel, abortController.signal, executionMode === 'lite' ? 'none' : reasoningLevel, executionMode === 'lite' ? null : resolvedModelSettings, streamCallbacks);
      const finalMessage = finalCompletion.response?.choices?.[0]?.message;
      if (finalMessage) {
        const finalReasoning = extractReasoning(finalMessage, finalCompletion.response);
        if (finalReasoning) reasoningParts.push(finalReasoning);
        currentMessages.push(finalMessage);
        const finalText = `${finalMessage.content || ''}`.trim();
        if (finalText) {
          fullDbHistory += (fullDbHistory ? '\n\n' : '') + finalText;
          finalAnswer = finalText;
          answer = finalAnswer;
        }
      }
      usedModel = finalCompletion.usedModel;
      usedProvider = finalCompletion.usedProvider;
      totalTokens += extractTokens(finalCompletion.response);
    } catch (err: any) {
      if (isAbortError(err)) throw err;
      console.error('[AI] Final answer after tool limit failed:', err?.message);
    }
  }

  const userTextForHistory = options?.persistUserText?.trim() || text;
  if (!options?.skipHistory && !options?.skipUserHistory) {
    const userTelegramChatId = Number.isFinite(Number(options?.userTelegramChatId))
      ? Math.floor(Number(options?.userTelegramChatId))
      : null;
    const userTelegramMessageId = Number.isFinite(Number(options?.userTelegramMessageId))
      ? Math.floor(Number(options?.userTelegramMessageId))
      : null;
    const userMessageImages = options?.userImages?.length ? options.userImages : null;
    const userMessageAttachments = options?.userAttachments?.length ? options.userAttachments : null;
    userMessageId = appendChatMessage(userId, chatId, 'user', userTextForHistory, userTelegramChatId, userTelegramMessageId, userMessageImages, null, null, userMessageAttachments);
  }
  assistantTelegramChatId = Number.isFinite(Number(options?.assistantTelegramChatId))
    ? Math.floor(Number(options?.assistantTelegramChatId))
    : null;
  // Сохраняем в БД полную историю, даже если она ушла через коллбэк
  const textToSave = fullDbHistory || answer;
  const reasoningContent = reasoningParts.length > 0 ? reasoningParts.join('\n\n').trim() : null;
  // Collect generated image URLs for assistant message
  const assistantMessageImages = generatedImages.length > 0
    ? generatedImages.filter(img => img.image_url).map(img => ({ url: img.image_url!, type: 'generated' as const }))
    : null;
  // В БД сохраняем НОВЫЙ формат: массив итераций с полными результатами.
  // getHistoryForAi() разворачивает его в корректную последовательность сообщений для API.
  // Старый плоский формат (без `step`) поддерживается как fallback при чтении.
  const tcJson = iterations.length > 0 ? JSON.stringify(iterations) : null;
  const subagentsJson = subagentTraces.length > 0 ? JSON.stringify(subagentTraces) : null;
  const assistantMessageId = options?.skipHistory
    ? 0
    : appendChatMessage(userId, chatId, 'assistant', textToSave, assistantTelegramChatId, null, assistantMessageImages, reasoningContent, tcJson, null, subagentsJson);

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

  trimUserHistoryByChat(userId, chatId, maxContextTokens);

  // Auto-title: if chat was empty, generate title via LITE AI (fire-and-forget)
  if (history.length === 0 && userTextForHistory.trim()) {
    const textForTitle = userTextForHistory.trim().slice(0, 200);
    const sendAction = options?.onDesktopAction;
    callLiteAi(
      'Придумай короткое название для чата (до 5 слов) на основе первого сообщения пользователя. Ответь ТОЛЬКО названием, без кавычек, без пояснений, без markdown. На русском языке.',
      textForTitle
    ).then(raw => {
      const title = raw.replace(/^["«]|["»]$/g, '').trim().slice(0, 120);
      if (title) {
        renameUserChat(userId, chatId, title);
        if (sendAction) sendAction({ action: 'chat_title_update', value: { chat_id: chatId, title } });
      }
    }).catch(() => { /* silent */ });
  }

  return {
    reply_text: answer,
    reasoning_content: reasoningContent,
    chat_id: chatId,
    message_id: assistantMessageId,
    user_message_id: userMessageId,
    model_fallback_notice: modelFallbackNotice,
    tool_user_messages: toolUserMessages,
    generated_images: generatedImages.length > 0 ? generatedImages : undefined,
    display_state: displayStateSink.value ?? undefined,
    desktop_action: desktopActionSink.value ?? undefined,
    tool_calls: toolCallsHistory.length > 0 ? toolCallsHistory : undefined,
    subagents: subagentTraces.length > 0 ? subagentTraces : undefined,
    usage: {
      tokens_used: totalTokens,
      used_model: usedModel,
      used_provider: usedProvider
    },
    ...((assistantMessageId > 0) ? getMessageTokens(assistantMessageId) : {}),
    ...(userMessageId > 0 ? { user_token_count: getMessageTokens(userMessageId).token_count } : {}),
    ...(diceRollValue !== null ? { dice_roll: diceRollValue } : {})
  };
  } catch (err: any) {
    if (isAbortError(err)) {
      // Генерация остановлена пользователем — soft abort.
      // Сохраняем всё что бот успел сделать (tool_calls, промежуточный текст, reasoning)
      // как обычное assistant-сообщение с пометкой aborted: true.
      console.log(`[AI] Generation aborted by user ${userId} (soft-save)`);

      const abortedAnswer = answer && answer !== FALLBACK_ANSWER
        ? answer + '\n\n_⏹ Генерация остановлена пользователем_'
        : (toolUserMessages.length > 0 ? '_⏹ Генерация остановлена пользователем_' : '');
      const abortedDbText = fullDbHistory || abortedAnswer;
      const abortedReasoning = reasoningParts.length > 0 ? reasoningParts.join('\n\n').trim() : null;
      const abortedTcJson = iterations.length > 0 ? JSON.stringify(iterations) : null;
      const abortedSubagentsJson = subagentTraces.length > 0 ? JSON.stringify(subagentTraces) : null;

      let abortedMessageId = 0;
      if (!options?.skipHistory) {
        try {
          abortedMessageId = appendChatMessage(
            userId, chatId, 'assistant',
            abortedDbText || '_Генерация остановлена_',
            assistantTelegramChatId, null, null,
            abortedReasoning, abortedTcJson, null, abortedSubagentsJson
          );
        } catch (saveErr) {
          console.warn(`[AI] soft-save failed:`, saveErr);
        }
      }

      return {
        reply_text: abortedAnswer,
        reasoning_content: abortedReasoning,
        chat_id: chatId,
        message_id: abortedMessageId,
        aborted: true,
        tool_calls: toolCallsHistory.length > 0 ? toolCallsHistory : undefined,
        subagents: subagentTraces.length > 0 ? subagentTraces : undefined,
        usage: { tokens_used: totalTokens, used_model: usedModel, used_provider: usedProvider },
        ...((abortedMessageId > 0) ? getMessageTokens(abortedMessageId) : {}),
        ...(userMessageId > 0 ? { user_token_count: getMessageTokens(userMessageId).token_count } : {}),
        ...(diceRollValue !== null ? { dice_roll: diceRollValue } : {})
      };
    }
    throw err;
  } finally {
    if (activeGenerations.get(userId) === abortController) {
      activeGenerations.delete(userId);
    }
  }
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
