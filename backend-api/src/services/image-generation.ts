import dotenv from 'dotenv';
import { getUserById } from './chats.js';
import { db } from '../db.js';
import type { UserPlan, UserRecord } from '../types.js';

dotenv.config();

// Provider switch: "proxyapi" (default) or "openrouter"
const IMAGE_GEN_PROVIDER = `${process.env.IMAGE_GEN_PROVIDER || 'proxyapi'}`.trim().toLowerCase();

// ProxyAPI settings (provider=proxyapi)
const PROXYAPI_KEY = `${process.env.PROXYAPI_KEY || ''}`.trim();
const PROXYAPI_BASE_URL = `${process.env.PROXYAPI_BASE_URL || 'https://api.proxyapi.ru/openai/v1'}`.trim();

// Shared / defaults
const IMAGE_GEN_MODEL = `${process.env.IMAGE_GEN_MODEL || 'gpt-image-1.5'}`.trim();
const IMAGE_GEN_QUALITY = `${process.env.IMAGE_GEN_QUALITY || 'low'}`.trim();
const IMAGE_GEN_SIZE = `${process.env.IMAGE_GEN_SIZE || '1024x1024'}`.trim();

// OpenRouter settings (provider=openrouter)
const OPENROUTER_API_KEY = `${process.env.OPENROUTER_API_KEY || ''}`.trim();
const OPENROUTER_BASE_URL = `${process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'}`.trim();

const postJson = async (url: string, body: unknown, apiKey: string): Promise<any> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const responseData = await response.json() as any;
  if (!response.ok) {
    const error = new Error(responseData?.error?.message || `HTTP ${response.status}`) as any;
    error.response = { status: response.status, data: responseData };
    throw error;
  }
  return responseData;
};

const normalizeDailyImageGenLimit = (value: number | null | undefined) => {
  if (!Number.isFinite(Number(value))) return 0;
  return Math.max(0, Math.floor(Number(value)));
};

const checkImageGenLimit = (user: UserRecord) => {
  const limit = normalizeDailyImageGenLimit(user.daily_image_gen_limit);
  const count = Math.max(0, Math.floor(Number(user.daily_image_gen_count || 0)));
  if (limit <= 0) return { allowed: false, count, limit, reason: 'По твоему плану генерация изображений отключена.' };
  if (count >= limit) return { allowed: false, count, limit, reason: `Лимит генерации изображений на сегодня исчерпан (${count}/${limit}).` };
  return { allowed: true, count, limit, reason: '' };
};

const incrementUserImageGenUsage = (userId: number, count = 1) => {
  const safeCount = Math.max(0, Math.floor(count));
  if (safeCount <= 0) return;
  db.prepare(`
    UPDATE users
    SET daily_image_gen_count = COALESCE(daily_image_gen_count, 0) + ?,
        total_image_gen_count = COALESCE(total_image_gen_count, 0) + ?
    WHERE id = ?
  `).run(safeCount, safeCount, userId);
};

export type ImageGenResult = {
  ok: true;
  image_base64: string;
  prompt_used: string;
};

export type ImageGenError = {
  ok: false;
  error: string;
};

/**
 * ProxyAPI provider — OpenAI /images/generations endpoint.
 * Expects response.data[0].b64_json in response.
 */
const generateProxyApi = async (prompt: string): Promise<ImageGenResult | ImageGenError> => {
  if (!PROXYAPI_KEY) {
    return { ok: false, error: 'Генерация изображений не настроена (нет PROXYAPI_KEY).' };
  }

  const responseData = await postJson(
    `${PROXYAPI_BASE_URL}/images/generations`,
    {
      model: IMAGE_GEN_MODEL,
      prompt,
      quality: IMAGE_GEN_QUALITY,
      size: IMAGE_GEN_SIZE
    },
    PROXYAPI_KEY,
  );

  const base64Data = responseData?.data?.[0]?.b64_json;
  if (!base64Data) {
    return { ok: false, error: 'API не вернул данные изображения.' };
  }

  return {
    ok: true,
    image_base64: base64Data,
    prompt_used: prompt
  };
};

/**
 * OpenRouter provider — /images endpoint (Grok Imagine).
 * Supports input_references for image-to-image generation (up to 3 images).
 * Expects response.data[0].b64_json.
 */
const generateOpenRouter = async (
  prompt: string,
  inputImages?: Array<{ base64: string; mimeType: string }>
): Promise<ImageGenResult | ImageGenError> => {
  if (!OPENROUTER_API_KEY) {
    return { ok: false, error: 'Генерация изображений не настроена (нет OPENROUTER_API_KEY).' };
  }

  const body: Record<string, unknown> = {
    model: IMAGE_GEN_MODEL,
    prompt,
  };

  // Attach reference images
  if (inputImages && inputImages.length > 0) {
    body.input_references = inputImages.slice(0, 10).map(img => ({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.base64}` }
    }));
  }

  const responseData = await postJson(
    `${OPENROUTER_BASE_URL}/images`,
    body,
    OPENROUTER_API_KEY,
  );

  const base64Data = responseData?.data?.[0]?.b64_json;
  if (!base64Data) {
    return { ok: false, error: 'OpenRouter API не вернул данные изображения.' };
  }

  return {
    ok: true,
    image_base64: base64Data,
    prompt_used: prompt
  };
};

export const runImageGeneration = async (
  userId: number,
  prompt: string,
  inputImages?: Array<{ base64: string; mimeType: string }>
): Promise<ImageGenResult | ImageGenError> => {
  const user = getUserById(userId);
  if (!user) return { ok: false, error: 'user_not_found' };
  if (user.status !== 'approved' && user.is_admin !== 1) return { ok: false, error: 'user_not_approved' };

  const limitCheck = checkImageGenLimit(user);
  if (!limitCheck.allowed && user.is_admin !== 1) {
    return { ok: false, error: limitCheck.reason };
  }

  const trimmedPrompt = (prompt || '').trim();
  if (!trimmedPrompt) return { ok: false, error: 'Пустой промпт для генерации изображения.' };

  try {
    let result: ImageGenResult | ImageGenError;

    switch (IMAGE_GEN_PROVIDER) {
      case 'openrouter':
        result = await generateOpenRouter(trimmedPrompt, inputImages);
        break;
      case 'proxyapi':
      default:
        result = await generateProxyApi(trimmedPrompt);
        break;
    }

    if (result.ok) {
      incrementUserImageGenUsage(userId, 1);
    }

    return result;
  } catch (err: any) {
    const status = err?.response?.status || 0;
    const message = err?.response?.data?.error?.message || err?.message || String(err);
    console.error(`[image-generation] Ошибка генерации (${IMAGE_GEN_PROVIDER}, status=${status}):`, message);
    return { ok: false, error: `Ошибка генерации изображения: ${message}` };
  }
};
