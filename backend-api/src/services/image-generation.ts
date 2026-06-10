import axios from 'axios';
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

  const response = await axios.post(
    `${PROXYAPI_BASE_URL}/images/generations`,
    {
      model: IMAGE_GEN_MODEL,
      prompt,
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

  return {
    ok: true,
    image_base64: base64Data,
    prompt_used: prompt
  };
};

/**
 * OpenRouter provider — chat/completions with image modality.
 * Expects choices[0].message.images[0].image_url.url (returns URL, downloads & converts to base64).
 */
const generateOpenRouter = async (prompt: string): Promise<ImageGenResult | ImageGenError> => {
  if (!OPENROUTER_API_KEY) {
    return { ok: false, error: 'Генерация изображений не настроена (нет OPENROUTER_API_KEY).' };
  }

  const response = await axios.post(
    `${OPENROUTER_BASE_URL}/chat/completions`,
    {
      model: IMAGE_GEN_MODEL,
      messages: [
        { role: 'user', content: prompt }
      ],
      modalities: ['image']
    },
    {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 120000
    }
  );

  // Extract image URL from response
  const images = response.data?.choices?.[0]?.message?.images;
  if (!images || !Array.isArray(images) || images.length === 0) {
    return { ok: false, error: 'OpenRouter API не вернул данные изображения.' };
  }

  const imageUrl = images[0]?.image_url?.url;
  if (!imageUrl) {
    return { ok: false, error: 'OpenRouter API не вернул URL изображения.' };
  }

  // Download image and convert to base64
  const imageResponse = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: 60000
  });

  const base64Data = Buffer.from(imageResponse.data, 'binary').toString('base64');

  return {
    ok: true,
    image_base64: base64Data,
    prompt_used: prompt
  };
};

export const runImageGeneration = async (
  userId: number,
  prompt: string
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
        result = await generateOpenRouter(trimmedPrompt);
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
