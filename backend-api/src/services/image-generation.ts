import { getUserById } from './chats.js';
import type { UserRecord } from '../types.js';
import {
  getImageGenerationSettings,
  IMAGE_ASPECT_RATIOS,
  type ImageAspectRatio,
  type ImageGenerationRuntimeSettings,
} from './image-generation-settings.js';
import { consumeUserQuota, getUserQuota } from './monthly-usage.js';

const normalizeAspectRatio = (value: unknown, allowed?: readonly string[]): ImageAspectRatio => {
  const normalized = `${value || 'auto'}`.trim();
  if (allowed && allowed.length > 0) {
    if (allowed.includes(normalized)) return normalized as ImageAspectRatio;
    return (allowed.includes('auto') ? 'auto' : allowed[0]) as ImageAspectRatio;
  }
  return (IMAGE_ASPECT_RATIOS as readonly string[]).includes(normalized)
    ? normalized as ImageAspectRatio
    : 'auto';
};

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
  const quota = getUserQuota(user.id, 'image_gen');
  const limit = normalizeDailyImageGenLimit(quota?.limit ?? 0);
  const count = Math.max(0, Math.floor(Number(quota?.used || 0)));
  if (limit <= 0) return { allowed: false, count, limit, reason: 'Image generation is disabled by your plan.' };
  if (count >= limit) return { allowed: false, count, limit, reason: `Monthly image generation limit reached (${count}/${limit}).` };
  return { allowed: true, count, limit, reason: '' };
};

const incrementUserImageGenUsage = (userId: number, count = 1) => {
  consumeUserQuota(userId, 'image_gen', count);
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
  settings: ImageGenerationRuntimeSettings,
  prompt: string,
  inputImages: Array<{ base64: string; mimeType: string }> | undefined,
  aspectRatio: ImageAspectRatio,
): Promise<ImageGenResult | ImageGenError> => {
  const { apiKey, baseUrl, model } = settings.openrouter;
  if (!apiKey) {
    return { ok: false, error: 'Image generation is not configured (missing OpenRouter API key).' };
  }

  const body: Record<string, unknown> = {
    model: model.id,
    prompt,
  };
  if (model.params.resolution) body.resolution = model.params.resolution.default;
  body.aspect_ratio = aspectRatio;
  if (model.params.quality) body.quality = model.params.quality.default;

  // Attach reference images (image-to-image)
  if (settings.img2imgEnabled && inputImages && inputImages.length > 0) {
    body.input_references = inputImages.slice(0, 3).map(img => ({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.base64}` }
    }));
  }

  const responseData = await postJson(
    `${baseUrl}/images`,
    body,
    apiKey,
  );

  const base64Data = responseData?.data?.[0]?.b64_json;
  if (!base64Data) {
    return { ok: false, error: 'OpenRouter API did not return image data.' };
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
  inputImages?: Array<{ base64: string; mimeType: string }>,
  aspectRatioRaw: unknown = 'auto',
): Promise<ImageGenResult | ImageGenError> => {
  const settings = getImageGenerationSettings();
  if (!settings.enabled) {
    return { ok: false, error: 'Image generation is disabled by the administrator.' };
  }
  const user = getUserById(userId);
  if (!user) return { ok: false, error: 'user_not_found' };
  if (user.status !== 'approved' && user.is_admin !== 1) return { ok: false, error: 'user_not_approved' };

  const limitCheck = checkImageGenLimit(user);
  if (!limitCheck.allowed && user.is_admin !== 1) {
    return { ok: false, error: limitCheck.reason };
  }

  const trimmedPrompt = (prompt || '').trim();
  if (!trimmedPrompt) return { ok: false, error: 'Empty prompt for image generation.' };
  const aspectRatio = normalizeAspectRatio(aspectRatioRaw, settings.openrouter.model.params.aspectRatio.allowed);

  try {
    let result: ImageGenResult | ImageGenError;
    switch (settings.provider) {
      case 'openrouter':
        result = await generateOpenRouter(settings, trimmedPrompt, inputImages, aspectRatio);
        break;
      default:
        return { ok: false, error: `Unknown image generation provider: ${settings.provider}` };
    }

    if (result.ok) {
      incrementUserImageGenUsage(userId, 1);
    }

    return result;
  } catch (err: any) {
    const status = err?.response?.status || 0;
    const message = err?.response?.data?.error?.message || err?.message || String(err);
    console.error(`[image-generation] ${settings.provider} generation failed (status=${status}):`, message);
    return { ok: false, error: `Image generation failed: ${message}` };
  }
};
