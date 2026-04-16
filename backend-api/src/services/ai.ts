import OpenAI from 'openai';
import dotenv from 'dotenv';
import type { AiSendResult, UserPlan } from '../types.js';
import { appendChatMessage, ensureActiveChat, getHistoryForAi, getPromptForUser, getUserById, resolveEffectiveContextWindow } from './chats.js';
import { db } from '../db.js';

dotenv.config();

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

export const sendMessageThroughAi = async (userId: number, inputText: string, targetChatId?: number): Promise<AiSendResult> => {
  const user = getUserById(userId);
  if (!user) throw new Error('user_not_found');
  if (user.status !== 'approved' && user.role !== 'admin') throw new Error('user_not_approved');

  const text = (inputText || '').trim();
  if (!text) throw new Error('empty_text');

  const chatId = targetChatId && Number.isFinite(targetChatId)
    ? targetChatId
    : ensureActiveChat(userId);

  const contextWindow = resolveEffectiveContextWindow(user);
  const history = getHistoryForAi(userId, chatId, contextWindow);
  const systemPrompt = `${buildSystemPrompt(getPromptForUser(user), user.name || user.tg_username || 'Пользователь', user.core_memory || '')}${buildTimeContext(7)}`;

  const requestPayload: Record<string, unknown> = {
    messages: [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: text }
    ],
    thinking: { type: 'disabled' }
  };

  let replyText = 'Слушай, чет я завис. Попробуй еще раз?';
  let usedModel = '';
  let usedProvider = '';
  let tokensUsed = 0;

  if (isLitePlan(user.plan)) {
    const liteRes = await createCompletionWithLiteProviderFallback(requestPayload);
    const response = liteRes.response;
    replyText = `${response?.choices?.[0]?.message?.content || ''}`.trim() || replyText;
    usedModel = liteRes.modelUsed;
    usedProvider = liteRes.providerUsed;
    tokensUsed = extractTokens(response);
  } else {
    const proRes = await createCompletionWithModelFallback(PRO_CLIENT, PRO_MODEL_CHAIN, requestPayload);
    const response = proRes.response;
    replyText = `${response?.choices?.[0]?.message?.content || ''}`.trim() || replyText;
    usedModel = proRes.modelUsed;
    usedProvider = 'pro-main';
    tokensUsed = extractTokens(response);
  }

  appendChatMessage(userId, chatId, 'user', text);
  const assistantMessageId = appendChatMessage(userId, chatId, 'assistant', replyText);

  db.prepare(`
    UPDATE users
    SET daily_tokens_used = COALESCE(daily_tokens_used, 0) + ?,
        total_tokens_used = COALESCE(total_tokens_used, 0) + ?
    WHERE id = ?
  `).run(tokensUsed, tokensUsed, userId);

  return {
    reply_text: replyText,
    chat_id: chatId,
    message_id: assistantMessageId,
    usage: {
      tokens_used: tokensUsed,
      used_model: usedModel,
      used_provider: usedProvider
    }
  };
};
