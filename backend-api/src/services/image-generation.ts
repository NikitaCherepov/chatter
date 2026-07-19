import dotenv from 'dotenv';
import { getUserById } from './chats.js';
import { db } from '../db.js';
import type { UserPlan, UserRecord } from '../types.js';

dotenv.config();

const OPENROUTER_API_KEY = `${process.env.OPENROUTER_API_KEY || ''}`.trim();
const OPENROUTER_BASE_URL = `${process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'}`.trim();
const IMAGE_GEN_MODEL = `${process.env.IMAGE_GEN_MODEL || 'x-ai/grok-imagine-image-quality'}`.trim();
const IMAGE_GEN_MAX_RESOLUTION = process.env.IMAGE_GEN_MAX_RESOLUTION === '1K' ? '1K' : '2K';
const IMAGE_GEN_QUALITY = ['low', 'medium', 'high'].includes(`${process.env.IMAGE_GEN_QUALITY || ''}`)
  ? process.env.IMAGE_GEN_QUALITY
  : 'auto';
const IMAGE_GEN_SUPPORTED_PARAMETERS = new Set(
  `${process.env.IMAGE_GEN_SUPPORTED_PARAMETERS === undefined
    ? 'resolution,input_references'
    : process.env.IMAGE_GEN_SUPPORTED_PARAMETERS}`
    .split(',')
    .map(value => value.trim())
    .filter(value => ['resolution', 'quality', 'input_references'].includes(value))
);

const postJson = async (url: string, body: unknown, apiKey: string): Promise<any> => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(360_000),
  });

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
  if (IMAGE_GEN_SUPPORTED_PARAMETERS.has('resolution')) body.resolution = IMAGE_GEN_MAX_RESOLUTION;
  if (IMAGE_GEN_SUPPORTED_PARAMETERS.has('quality')) body.quality = IMAGE_GEN_QUALITY;

  // Attach reference images
  if (IMAGE_GEN_SUPPORTED_PARAMETERS.has('input_references') && inputImages && inputImages.length > 0) {
    body.input_references = inputImages.slice(0, 3).map(img => ({
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
    const result = await generateOpenRouter(trimmedPrompt, inputImages);

    if (result.ok) {
      incrementUserImageGenUsage(userId, 1);
    }

    return result;
  } catch (err: any) {
    const status = err?.response?.status || 0;
    const message = err?.response?.data?.error?.message || err?.message || String(err);
    console.error(`[image-generation] Ошибка генерации OpenRouter (status=${status}):`, message);
    return { ok: false, error: `Ошибка генерации изображения: ${message}` };
  }
};
