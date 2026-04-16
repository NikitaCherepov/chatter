import OpenAI from 'openai';
import dotenv from 'dotenv';
import { tavily } from '@tavily/core';
import type { AiSendResult, TaskNotifyMode, TaskRecurrenceType, TaskType, UserPlan } from '../types.js';
import { appendChatMessage, ensureActiveChat, getHistoryForAi, getPromptForUser, getUserById, resolveEffectiveContextWindow, setUserTimezone } from './chats.js';
import { createNote, deleteNote, listNotes } from './notes.js';
import { createTask, deletePendingTask, listTasks } from './tasks.js';
import { runSmartHomeControl, type SmartHomeArgs } from './smart-home.js';
import { runEmailCheck, runEmailRead, runEmailSend } from './mail.js';
import { runCoreMemoryMerge } from './memory.js';
import { db } from '../db.js';

dotenv.config();

const FALLBACK_ANSWER = 'Слушай, чет я завис. Попробуй еще раз?';
const MAX_TOOL_LOOPS = 6;
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

const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: 'Поиск актуальной информации в интернете.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'control_smart_home',
      description: 'Управление устройствами умного дома.',
      parameters: {
        type: 'object',
        properties: {
          device_name: { type: 'string' },
          action: { type: 'string', enum: ['on', 'off', 'set_color', 'set_brightness'] },
          color: { type: 'string' },
          brightness: { type: 'number' }
        },
        required: ['device_name', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_user_timezone',
      description: 'Установка часового пояса пользователя в формате UTC offset.',
      parameters: {
        type: 'object',
        properties: { timezone_offset: { type: 'number' } },
        required: ['timezone_offset']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'random_roll',
      description: 'Подбросить монетку или бросить кубик.',
      parameters: {
        type: 'object',
        properties: {
          roll_type: { type: 'string', enum: ['coin', 'dice'] },
          dice_notation: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_note',
      description: 'Сохранить заметку пользователя.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_my_notes',
      description: 'Показать заметки пользователя.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' },
          offset: { type: 'number' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_note',
      description: 'Удалить заметку по id.',
      parameters: {
        type: 'object',
        properties: { note_id: { type: 'number' } },
        required: ['note_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_my_tasks',
      description: 'Показать задачи пользователя.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'done', 'error', 'all'] },
          limit: { type: 'number' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'schedule_task',
      description: 'Создать задачу/напоминание.',
      parameters: {
        type: 'object',
        properties: {
          task_type: { type: 'string', enum: ['message', 'web_search', 'email_check', 'ai_instruction', 'smart_home'] },
          payload: { type: 'string' },
          execute_at: { type: 'number' },
          delay_seconds: { type: 'number' },
          recurrence_type: { type: 'string', enum: ['once', 'daily', 'weekly'] },
          recurrence_weekday: { type: 'number' },
          notify_mode: { type: 'string', enum: ['always', 'never', 'on_match', 'on_condition'] },
          notify_condition: { type: 'string' }
        },
        required: ['task_type', 'payload']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_my_task',
      description: 'Удалить pending-задачу по id.',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'number' } },
        required: ['task_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_emails',
      description: 'Проверить почту пользователя (поиск, фильтр по датам, пагинация).',
      parameters: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: ['yandex', 'google'] },
          search_query: { type: 'string' },
          date_from: { type: 'string' },
          date_to: { type: 'string' },
          limit: { type: 'number' },
          offset: { type: 'number' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_email_content',
      description: 'Прочитать текст письма по части темы.',
      parameters: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: ['yandex', 'google'] },
          subject_part: { type: 'string' }
        },
        required: ['subject_part']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'send_email',
      description: 'Отправить письмо от имени пользователя.',
      parameters: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: ['yandex', 'google'] },
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' }
        },
        required: ['to', 'subject', 'body']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_core_memory',
      description: 'Обновить постоянную память пользователя важным фактом.',
      parameters: {
        type: 'object',
        properties: {
          new_fact: { type: 'string' },
          explicit_request: { type: 'boolean' }
        },
        required: ['new_fact']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_pro',
      description: 'Эскалация в старшую модель. Используй только если запрос сложный и требует PRO.',
      parameters: {
        type: 'object',
        properties: { original_query: { type: 'string' } },
        required: ['original_query']
      }
    }
  }
] as const;

const runCompletion = async (mode: 'pro' | 'lite', requestPayload: Record<string, unknown>): Promise<CompletionMeta> => {
  if (mode === 'pro') {
    const res = await createCompletionWithModelFallback(PRO_CLIENT, PRO_MODEL_CHAIN, requestPayload);
    return { response: res.response, usedModel: res.modelUsed, usedProvider: 'pro-main' };
  }
  const res = await createCompletionWithLiteProviderFallback(requestPayload);
  return { response: res.response, usedModel: res.modelUsed, usedProvider: res.providerUsed };
};

const hasSchedulingIntent = (text: string) => /\b(напомн|напоминани|таймер|по\s+расписанию|отложи|позже|завтра|послезавтра|ежедневно|еженедельно|кажд(ый|ую|ое|ые)|every\s+day|every\s+week)\b/i.test(text)
  || /\bв\s*\d{1,2}:\d{2}\b/i.test(text)
  || /через\s+[^.,!?]{0,24}\b(секунд|секунду|секунды|сек|минут|минуту|минута|мин|час|часа|часов|ч|день|дня|дней|сутк|недел|месяц|месяца|месяцев)\b/i.test(text);

const formatTasksList = (tasks: ReturnType<typeof listTasks>) => {
  if (!tasks.length) return 'Задач нет.';
  return tasks.map(t => `#${t.id} | ${t.task_type} | ${t.status} | ${t.execute_at}`).join('\n');
};

const runTool = async (userId: number, toolName: string, argsRaw: string, aiCall: (requestPayload: Record<string, unknown>) => Promise<CompletionMeta>) => {
  const parsed = JSON.parse(argsRaw || '{}');

  if (toolName === 'search_web') {
    const query = `${parsed.query || ''}`.trim();
    if (!query) return 'Ошибка: пустой query.';
    if (!tvly) return 'Ошибка: web search отключен (нет TAVILY_API_KEY).';
    const res = await tvly.search(query, { searchDepth: 'basic', maxResults: 3, includeAnswer: true });
    const list = (res.results || []).map((item: any, idx: number) => `${idx + 1}. ${item.title}\n${item.content}\nИсточник: ${item.url}`).join('\n\n');
    return `${res.answer ? `Сводка: ${res.answer}\n\n` : ''}${list || 'Ничего не найдено.'}`;
  }

  if (toolName === 'control_smart_home') {
    return runSmartHomeControl(userId, parsed as SmartHomeArgs);
  }

  if (toolName === 'set_user_timezone') {
    const timezoneOffset = Number(parsed.timezone_offset);
    if (!Number.isFinite(timezoneOffset) || timezoneOffset < -12 || timezoneOffset > 14) {
      return 'Ошибка: timezone_offset должен быть от -12 до 14.';
    }
    setUserTimezone(userId, Math.floor(timezoneOffset));
    const sign = timezoneOffset >= 0 ? '+' : '';
    return `Часовой пояс обновлён: UTC${sign}${Math.floor(timezoneOffset)}.`;
  }

  if (toolName === 'random_roll') {
    const rollType = `${parsed.roll_type || 'coin'}`;
    if (rollType === 'dice') {
      const v = 1 + Math.floor(Math.random() * 6);
      return `Кубик: ${v}`;
    }
    return Math.random() < 0.5 ? 'Монетка: орёл' : 'Монетка: решка';
  }

  if (toolName === 'save_note') {
    const user = getUserById(userId);
    if (!user) return 'Ошибка: user_not_found';
    const content = `${parsed.content || ''}`;
    const title = `${parsed.title || ''}`;
    const created = createNote(userId, user.plan, title, content);
    if (!created.ok) return `Ошибка: ${created.error}`;
    return `Заметка сохранена: #${created.id}`;
  }

  if (toolName === 'list_my_notes') {
    const query = `${parsed.query || ''}`;
    const limit = Number(parsed.limit);
    const offset = Number(parsed.offset);
    const notes = listNotes(userId, Number.isFinite(limit) ? limit : 20, Number.isFinite(offset) ? offset : 0, query);
    if (!notes.length) return 'Заметок не найдено.';
    return notes.map(n => `#${n.id} ${n.title || '(без заголовка)'}\n${n.content}`).join('\n\n');
  }

  if (toolName === 'delete_note') {
    const noteId = Number(parsed.note_id);
    if (!Number.isFinite(noteId) || noteId <= 0) return 'Ошибка: bad note_id';
    return deleteNote(userId, Math.floor(noteId)) ? `Заметка #${Math.floor(noteId)} удалена.` : 'Заметка не найдена.';
  }

  if (toolName === 'get_my_tasks') {
    const status = ['pending', 'done', 'error', 'all'].includes(`${parsed.status || ''}`)
      ? parsed.status
      : 'pending';
    const limit = Number(parsed.limit);
    return formatTasksList(listTasks(userId, Number.isFinite(limit) ? limit : 50, status));
  }

  if (toolName === 'schedule_task') {
    const taskType = `${parsed.task_type || ''}` as TaskType;
    const payload = `${parsed.payload || ''}`.trim();
    if (!payload) return 'Ошибка: payload_required';
    const recurrenceType = `${parsed.recurrence_type || 'once'}` as TaskRecurrenceType;
    const recurrenceWeekday = Number.isFinite(Number(parsed.recurrence_weekday)) ? Math.floor(Number(parsed.recurrence_weekday)) : null;
    const notifyMode = `${parsed.notify_mode || 'always'}` as TaskNotifyMode;
    const notifyCondition = parsed.notify_condition == null ? null : `${parsed.notify_condition}`;

    let executeAt = Number(parsed.execute_at);
    if (!Number.isFinite(executeAt) || executeAt <= 0) {
      const delay = Number(parsed.delay_seconds);
      if (Number.isFinite(delay) && delay >= 0) {
        executeAt = Math.floor(Date.now() / 1000) + Math.floor(delay);
      }
    }
    if (!Number.isFinite(executeAt) || executeAt <= 0) return 'Ошибка: bad execute_at';

    const taskId = createTask(userId, Math.floor(executeAt), taskType, payload, recurrenceType, recurrenceWeekday, null, notifyMode, notifyCondition);
    return `Задача создана: #${taskId}`;
  }

  if (toolName === 'delete_my_task') {
    const taskId = Number(parsed.task_id);
    if (!Number.isFinite(taskId) || taskId <= 0) return 'Ошибка: bad task_id';
    return deletePendingTask(userId, Math.floor(taskId)) ? `Задача #${Math.floor(taskId)} удалена.` : 'Задача не найдена или уже не pending.';
  }

  if (toolName === 'check_emails') {
    return runEmailCheck(
      userId,
      typeof parsed.search_query === 'string' ? parsed.search_query : '',
      Number.isFinite(Number(parsed.limit)) ? Number(parsed.limit) : 5,
      typeof parsed.provider === 'string' ? parsed.provider : '',
      Number.isFinite(Number(parsed.offset)) ? Number(parsed.offset) : 0,
      typeof parsed.date_from === 'string' ? parsed.date_from : '',
      typeof parsed.date_to === 'string' ? parsed.date_to : ''
    );
  }

  if (toolName === 'read_email_content') {
    return runEmailRead(
      userId,
      typeof parsed.subject_part === 'string' ? parsed.subject_part : '',
      typeof parsed.provider === 'string' ? parsed.provider : ''
    );
  }

  if (toolName === 'send_email') {
    return runEmailSend(
      userId,
      typeof parsed.to === 'string' ? parsed.to : '',
      typeof parsed.subject === 'string' ? parsed.subject : '',
      typeof parsed.body === 'string' ? parsed.body : '',
      typeof parsed.provider === 'string' ? parsed.provider : ''
    );
  }

  if (toolName === 'update_core_memory') {
    return runCoreMemoryMerge(
      aiCall,
      userId,
      typeof parsed.new_fact === 'string' ? parsed.new_fact : '',
      Boolean(parsed.explicit_request)
    );
  }

  if (toolName === 'escalate_to_pro') {
    return '__ESCALATE_TO_PRO__';
  }

  return `Ошибка: неизвестный инструмент ${toolName}`;
};

export const sendMessageThroughAi = async (userId: number, inputText: string, targetChatId?: number): Promise<AiSendResult> => {
  const user = getUserById(userId);
  if (!user) throw new Error('user_not_found');
  if (user.status !== 'approved' && user.is_admin !== 1) throw new Error('user_not_approved');

  const text = (inputText || '').trim();
  if (!text) throw new Error('empty_text');

  const chatId = targetChatId && Number.isFinite(targetChatId)
    ? targetChatId
    : ensureActiveChat(userId);

  const contextWindow = resolveEffectiveContextWindow(user);
  const history = getHistoryForAi(userId, chatId, contextWindow);
  const timezone = Number.isFinite(Number(user.timezone_offset)) ? Number(user.timezone_offset) : 7;
  const baseSystemPrompt = `${buildSystemPrompt(getPromptForUser(user), user.name || user.tg_username || 'Пользователь', user.core_memory || '')}${buildTimeContext(timezone)}`;

  const currentMessages: any[] = [
    { role: 'system', content: baseSystemPrompt },
    ...history,
    { role: 'user', content: text }
  ];

  let executionMode: 'pro' | 'lite' = isLitePlan(user.plan) ? 'lite' : 'pro';
  let tools: any[] = [...toolDefinitions] as any[];

  if (executionMode === 'lite') {
    const routerPrompt = `Ты — маршрутизатор запросов. Верни только одно слово: SMART_HOME, QUICK_SEARCH, TIMEZONE, RANDOM, PRO. Если сомневаешься — PRO. Запрос: "${text}"`;
    let route = 'PRO';
    if (!hasSchedulingIntent(text)) {
      try {
        const routed = await runCompletion('lite', {
          messages: [{ role: 'user', content: routerPrompt }],
          temperature: 0,
          max_tokens: 8,
          thinking: { type: 'disabled' }
        });
        route = `${routed.response?.choices?.[0]?.message?.content || ''}`.toUpperCase();
      } catch {
        route = 'PRO';
      }
    }

    if (!route.includes('PRO')) {
      const cheapMap: Record<string, string[]> = {
        SMART_HOME: ['control_smart_home'],
        QUICK_SEARCH: ['search_web'],
        TIMEZONE: ['set_user_timezone'],
        RANDOM: ['random_roll']
      };
      const matched = Object.keys(cheapMap).find(k => route.includes(k));
      if (matched) {
        const allowed = new Set(cheapMap[matched]);
        tools = toolDefinitions.filter(t => allowed.has(`${(t as any)?.function?.name || ''}`)) as any[];
      } else {
        executionMode = 'pro';
      }
    } else {
      executionMode = 'pro';
    }
  }

  let answer = FALLBACK_ANSWER;
  let totalTokens = 0;
  let usedModel = '';
  let usedProvider = '';
  let loop = 0;
  const toolOutputsForFallback: string[] = [];

  while (loop < MAX_TOOL_LOOPS) {
    loop += 1;
    const completion = await runCompletion(executionMode, {
      messages: currentMessages,
      tools,
      tool_choice: 'auto',
      thinking: { type: executionMode === 'lite' ? 'disabled' : 'enabled' },
      clear_thinking: false
    });

    usedModel = completion.usedModel;
    usedProvider = completion.usedProvider;

    const response = completion.response;
    totalTokens += extractTokens(response);

    const message = response?.choices?.[0]?.message || {};
    currentMessages.push(message);

    if (!message.tool_calls?.length) {
      const content = `${message.content || ''}`.trim();
      if (content) {
        answer = content;
      } else if (toolOutputsForFallback.length) {
        answer = toolOutputsForFallback[toolOutputsForFallback.length - 1] || FALLBACK_ANSWER;
      }
      break;
    }

    let escalated = false;
    for (const toolCall of message.tool_calls) {
      if (toolCall.type !== 'function') continue;
      const toolName = `${toolCall.function?.name || ''}`;
      let toolContent = '';
      try {
        toolContent = await runTool(userId, toolName, toolCall.function?.arguments || '{}', (payload) => runCompletion('pro', payload));
        if (toolContent === '__ESCALATE_TO_PRO__') {
          executionMode = 'pro';
          toolContent = 'Эскалация на PRO-модель выполнена.';
          escalated = true;
        }
      } catch (err: any) {
        toolContent = `Ошибка инструмента ${toolName}: ${err?.message || String(err)}`;
      }

      currentMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toolContent
      });
      if (toolContent.trim()) toolOutputsForFallback.push(toolContent.trim());
    }

    if (escalated) continue;
  }

  appendChatMessage(userId, chatId, 'user', text);
  const assistantMessageId = appendChatMessage(userId, chatId, 'assistant', answer);

  db.prepare(`
    UPDATE users
    SET daily_tokens_used = COALESCE(daily_tokens_used, 0) + ?,
        total_tokens_used = COALESCE(total_tokens_used, 0) + ?,
        daily_message_count = COALESCE(daily_message_count, 0) + 1
    WHERE id = ?
  `).run(totalTokens, totalTokens, userId);

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
