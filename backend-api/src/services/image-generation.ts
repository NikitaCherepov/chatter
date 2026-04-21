import axios from 'axios';
import dotenv from 'dotenv';
import { getUserById } from './chats.js';
import { db } from '../db.js';
import type { UserPlan, UserRecord } from '../types.js';

dotenv.config();

const PROXYAPI_KEY = `${process.env.PROXYAPI_KEY || ''}`.trim();
const PROXYAPI_BASE_URL = `${process.env.PROXYAPI_BASE_URL || 'https://api.proxyapi.ru/openai/v1'}`.trim();
const IMAGE_GEN_MODEL = `${process.env.IMAGE_GEN_MODEL || 'gpt-image-1.5'}`.trim();
const IMAGE_GEN_QUALITY = `${process.env.IMAGE_GEN_QUALITY || 'low'}`.trim();
const IMAGE_GEN_SIZE = `${process.env.IMAGE_GEN_SIZE || '1024x1024'}`.trim();

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

export const runImageGeneration = async (
  userId: number,
  prompt: string
): Promise<ImageGenResult | ImageGenError> => {
  if (!PROXYAPI_KEY) {
    return { ok: false, error: 'Генерация изображений не настроена (нет PROXYAPI_KEY).' };
  }

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
    const response = await axios.post(
      `${PROXYAPI_BASE_URL}/images/generations`,
      {
        model: IMAGE_GEN_MODEL,
        prompt: trimmedPrompt,
        quality: IMAGE_GEN_QUALITY,
        size: IMAGE_GEN_SIZE
      },
      {
        headers: {
          'Authorization': `Bearer ${PROXYAPI_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 120000
      }
    );

    const base64Data = response.data?.data?.[0]?.b64_json;
    if (!base64Data) {
      return { ok: false, error: 'API не вернул данные изображения.' };
    }

    incrementUserImageGenUsage(userId, 1);

    return {
      ok: true,
      image_base64: base64Data,
      prompt_used: trimmedPrompt
    };
  } catch (err: any) {
    const status = err?.response?.status || 0;
    const message = err?.response?.data?.error?.message || err?.message || String(err);
    console.error(`[image-generation] Ошибка генерации (status=${status}):`, message);
    return { ok: false, error: `Ошибка генерации изображения: ${message}` };
  }
};
