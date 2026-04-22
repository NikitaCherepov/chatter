import OpenAI from 'openai';
import dotenv from 'dotenv';
import { appendChatMessage, ensureActiveChat, getHistoryForAi, getPromptForUser, getUserById, resolveEffectiveContextWindow, trimUserHistoryByChat } from './chats.js';
import { db } from '../db.js';

dotenv.config();

const FALLBACK_ANSWER = 'Слушай, чет я завис. Попробуй еще раз?';
const MAX_TELEGRAM_PHOTO_BYTES = 20 * 1024 * 1024;
const TOKENS_PER_PRICE_BLOCK = 500_000;
const PRICE_PER_PRICE_BLOCK_RUB = 102;
const RUB_PER_TOKEN = PRICE_PER_PRICE_BLOCK_RUB / TOKENS_PER_PRICE_BLOCK;
const DEBUG_AI_RAW_MAIN_RESPONSE = process.env.DEBUG_AI_RAW_MAIN_RESPONSE === '1';
const DEBUG_AI_RAW_LITE_RESPONSE = process.env.DEBUG_AI_RAW_LITE_RESPONSE === '1';

const parseModelChain = (raw: string | undefined, fallback: string[]) => {
  const parsed = (raw || '').split(',').map(v => v.trim()).filter(Boolean);
  return parsed.length ? parsed : fallback;
};

const MODEL_CHAIN = parseModelChain(process.env.TIMEWEB_MODEL, ['gemini-3.1-flash-lite-preview']);
const LITE_MODEL_CHAIN = parseModelChain(process.env.TIMEWEB_LITE_MODEL, ['gemini-2.5-flash-lite']);
const VISION_MODEL_CHAIN = parseModelChain(process.env.TIMEWEB_VISION_MODEL, [MODEL_CHAIN[0] || 'glm-4v']);
const LITE_VISION_MODEL_CHAIN = parseModelChain(
  process.env.TIMEWEB_LITE_VISION_MODEL,
  [...VISION_MODEL_CHAIN, LITE_MODEL_CHAIN[0] || 'glm-4v']
);

const aiVision = new OpenAI({
  apiKey: process.env.TIMEWEB_VISION_API_KEY || process.env.TIMEWEB_API_KEY,
  baseURL: process.env.TIMEWEB_VISION_BASE_URL || process.env.TIMEWEB_BASE_URL
});

const aiVisionLite = new OpenAI({
  apiKey: process.env.TIMEWEB_LITE_VISION_API_KEY || process.env.TIMEWEB_LITE_API_KEY || process.env.TIMEWEB_VISION_API_KEY || process.env.TIMEWEB_API_KEY,
  baseURL: process.env.TIMEWEB_LITE_VISION_BASE_URL || process.env.TIMEWEB_LITE_BASE_URL || process.env.TIMEWEB_VISION_BASE_URL || process.env.TIMEWEB_BASE_URL
});

const normalizeDailyMessageLimit = (value: number | null | undefined) => {
  if (!Number.isFinite(Number(value))) return 0;
  return Math.max(0, Math.floor(Number(value)));
};

const extractTotalTokens = (response: any) => Number(response?.usage?.total_tokens || 0);

const buildSystemPrompt = (prompt: string, userName: string, coreMemory: string) => {
  return `${prompt}\n\nИмя {{user}}: ${userName}\n\n[ПОСТОЯННЫЕ ЗНАНИЯ О ПОЛЬЗОВАТЕЛЕ]\n${coreMemory || 'Пока пусто.'}`;
};

const buildTimeContext = (timezoneOffset: number) => {
  const now = new Date();
  const localTime = new Date(now.getTime() + timezoneOffset * 3600 * 1000);
  const sign = timezoneOffset >= 0 ? '+' : '';
  return `\n\n[СИСТЕМНАЯ ИНФОРМАЦИЯ]\nТекущее Unix-время (в секундах): ${Math.floor(now.getTime() / 1000)}.\nЛокальное время пользователя: ${localTime.toISOString().replace('T', ' ').slice(0, 19)} (UTC${sign}${timezoneOffset}).`;
};

export const runPhotoAnalyzeTurn = async (
  userId: number,
  imageBase64: string,
  imageMimeType: string,
  caption: string,
  chatId?: number,
  options?: {
    userTelegramChatId?: number | null;
    userTelegramMessageId?: number | null;
  }
) => {
  const user = getUserById(userId);
  if (!user) throw new Error('user_not_found');
  if (user.status !== 'approved' && user.is_admin !== 1) throw new Error('user_not_approved');

  const dailyLimit = normalizeDailyMessageLimit(user.daily_message_limit);
  const dailyCount = Math.max(0, Math.floor(Number(user.daily_message_count || 0)));
  if (user.is_admin !== 1 && dailyLimit > 0 && dailyCount >= dailyLimit) {
    throw new Error('daily_message_limit_reached');
  }

  const normalizedImage = `${imageBase64 || ''}`.trim();
  if (!normalizedImage) throw new Error('empty_image');

  const imageBuffer = Buffer.from(normalizedImage, 'base64');
  if (!imageBuffer.length) throw new Error('empty_image');
  if (imageBuffer.length > MAX_TELEGRAM_PHOTO_BYTES) {
    throw new Error('image_too_large');
  }

  const safeMime = `${imageMimeType || 'image/jpeg'}`.trim() || 'image/jpeg';
  const userPrompt = `${caption || ''}`.trim() || 'Что на этой картинке?';
  const selectedChatId = chatId && Number.isFinite(chatId) ? chatId : ensureActiveChat(userId);
  const contextWindow = resolveEffectiveContextWindow(user);
  const history = getHistoryForAi(userId, selectedChatId, contextWindow);

  const timezoneOffset = Number.isFinite(Number(user.timezone_offset)) ? Number(user.timezone_offset) : 5;
  const userName = user.name || user.tg_username || 'Пользователь';
  const systemPrompt = `${buildSystemPrompt(getPromptForUser(user), userName, user.core_memory || '')}${buildTimeContext(timezoneOffset)}\n\nЕсли пользователь прислал изображение, анализируй его и отвечай конкретно по запросу пользователя.`;

  const useLiteVision = user.plan !== 'pro';
  const visionClient = useLiteVision ? aiVisionLite : aiVision;
  const visionModels = useLiteVision ? LITE_VISION_MODEL_CHAIN : VISION_MODEL_CHAIN;
  const visionMessages = [
    { role: 'system', content: systemPrompt },
    ...history,
    {
      role: 'user',
      content: [
        { type: 'text', text: userPrompt },
        { type: 'image_url', image_url: { url: `data:${safeMime};base64,${normalizedImage}` } }
      ]
    }
  ];

  let response: any = null;
  let usedVisionModel = '';
  let lastVisionError: unknown = null;
  const failedModels: string[] = [];

  for (const modelName of visionModels) {
    try {
      response = await visionClient.chat.completions.create({
        model: modelName,
        messages: visionMessages as any,
        max_tokens: 16384,
        thinking: useLiteVision ? { type: 'disabled' } : { type: 'enabled' },
        clear_thinking: false
      } as any);
      usedVisionModel = modelName;
      break;
    } catch (visionErr) {
      failedModels.push(modelName);
      lastVisionError = visionErr;
      console.warn(`[VISION_FALLBACK] Модель ${modelName} вернула ошибку, пробую следующую...`, visionErr);
    }
  }

  if (!response) {
    throw (lastVisionError || new Error('vision_models_failed'));
  }

  if (DEBUG_AI_RAW_MAIN_RESPONSE && !useLiteVision) {
    try {
      console.log(`[DEBUG_AI_RAW_MAIN_RESPONSE][vision][model=${usedVisionModel}]`, JSON.stringify(response, null, 2));
    } catch (err) {
      console.warn('[DEBUG_AI_RAW_MAIN_RESPONSE][vision] Не удалось сериализовать ответ:', err);
    }
  }
  if (DEBUG_AI_RAW_LITE_RESPONSE && useLiteVision) {
    try {
      console.log(`[DEBUG_AI_RAW_LITE_RESPONSE][vision][model=${usedVisionModel}]`, JSON.stringify(response, null, 2));
    } catch (err) {
      console.warn('[DEBUG_AI_RAW_LITE_RESPONSE][vision] Не удалось сериализовать ответ:', err);
    }
  }

  const answerRaw = response?.choices?.[0]?.message?.content;
  const answer = typeof answerRaw === 'string' && answerRaw.trim() ? answerRaw.trim() : FALLBACK_ANSWER;
  const totalTokens = extractTotalTokens(response);
  const userHistoryText = caption ? `[Фото] ${caption}` : '[Фото] Что на этой картинке?';

  db.prepare(`
    UPDATE users
    SET daily_message_count = COALESCE(daily_message_count, 0) + 1,
        total_message_length = COALESCE(total_message_length, 0) + ?,
        daily_tokens_used = COALESCE(daily_tokens_used, 0) + ?,
        total_tokens_used = COALESCE(total_tokens_used, 0) + ?,
        daily_cost_rub = COALESCE(daily_cost_rub, 0) + ?,
        total_cost_rub = COALESCE(total_cost_rub, 0) + ?
    WHERE id = ?
  `).run(
    userHistoryText.length,
    totalTokens,
    totalTokens,
    Math.max(0, totalTokens) * RUB_PER_TOKEN,
    Math.max(0, totalTokens) * RUB_PER_TOKEN,
    userId
  );

  appendChatMessage(
    userId,
    selectedChatId,
    'user',
    userHistoryText,
    Number.isFinite(Number(options?.userTelegramChatId)) ? Math.floor(Number(options?.userTelegramChatId)) : null,
    Number.isFinite(Number(options?.userTelegramMessageId)) ? Math.floor(Number(options?.userTelegramMessageId)) : null
  );
  const assistantMessageId = appendChatMessage(userId, selectedChatId, 'assistant', answer, null, null);
  trimUserHistoryByChat(userId, selectedChatId, contextWindow);

  const modelFallbackNotice = failedModels.length
    ? `⚙️ Vision-модель(и) ${failedModels.join(', ')} были недоступны. Ответ получен от ${usedVisionModel}.`
    : null;

  return {
    reply_text: answer,
    used_model: usedVisionModel,
    used_provider: useLiteVision ? 'vision-lite' : 'vision-main',
    tokens_used: totalTokens,
    model_fallback_notice: modelFallbackNotice,
    message_id: assistantMessageId,
    chat_id: selectedChatId
  };
};

