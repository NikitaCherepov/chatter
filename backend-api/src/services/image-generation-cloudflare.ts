import type {
  ImageGenerationRuntimeSettings,
  ImageAspectRatio,
} from './image-generation-settings.js';
import type { ImageGenResult, ImageGenError } from './image-generation.js';
import sharp from 'sharp';

/**
 * Cloudflare Workers AI provider — FLUX.2 Klein models
 * (`@cf/black-forest-labs/flux-2-klein-4b` / `-9b`).
 *
 * Wire format (differs from OpenRouter):
 * - POST https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run/{model}
 * - ALWAYS multipart/form-data (even for plain text-to-image)
 * - width/height integers 256..1920 (defaults 1024x768), steps fixed at 4
 * - img2img via input_image_0..input_image_3 binary parts (max 4 refs);
 *   oversized references are normalized to fit within 512x512
 * - response envelope: { success, result: { image: '<base64>' }, errors? }
 *
 * The universal contract (prompt + aspect_ratio + quality) stays untouched:
 * the adapter converts aspect_ratio x quality into concrete width/height.
 */

export const CLOUDFLARE_KLEIN_CAPABILITIES = {
  img2img: true,
  maxReferences: 4,
  referenceMaxSide: 512,
  width: { min: 256, max: 1920, default: 1024 },
  height: { min: 256, max: 1920, default: 768 },
  guidance: true,
  seed: true,
  steps: { fixed: 4 },
} as const;

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
const CF_MIN_SIDE = CLOUDFLARE_KLEIN_CAPABILITIES.width.min;
const CF_MAX_SIDE = CLOUDFLARE_KLEIN_CAPABILITIES.width.max;

/** Long-side pixels per quality tier; `auto` keeps the model's default scale. */
const CF_QUALITY_LONG_SIDE: Record<string, number> = {
  auto: 1024,
  low: 512,
  medium: 1024,
  high: 1920,
};

const parseRatio = (value: string): { w: number; h: number } | null => {
  const match = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return null;
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { w, h };
};

const snapSide = (value: number): number => {
  // Snap to a multiple of 8 (FLUX-family convention) and clamp into 256..1920.
  const snapped = Math.round(value / 8) * 8;
  return Math.min(CF_MAX_SIDE, Math.max(CF_MIN_SIDE, snapped));
};

/**
 * Converts the universal `aspect_ratio` + `quality` into Cloudflare's
 * width/height. Pure function — covered by unit tests.
 *
 * - `auto` ratio keeps the model defaults (1024x768) regardless of quality
 * - otherwise the quality tier defines the long side (512/1024/1920) and the
 *   ratio defines the proportions (e.g. `16:9` + `high` -> 1920x1080)
 */
export const resolveCloudflareDimensions = (
  aspectRatio: ImageAspectRatio | string,
  quality: string,
): { width: number; height: number } => {
  const longSide = CF_QUALITY_LONG_SIDE[quality] ?? CF_QUALITY_LONG_SIDE.auto;
  if (aspectRatio === 'auto') {
    return {
      width: CLOUDFLARE_KLEIN_CAPABILITIES.width.default,
      height: CLOUDFLARE_KLEIN_CAPABILITIES.height.default,
    };
  }
  const ratio = parseRatio(aspectRatio);
  if (!ratio) {
    return {
      width: CLOUDFLARE_KLEIN_CAPABILITIES.width.default,
      height: CLOUDFLARE_KLEIN_CAPABILITIES.height.default,
    };
  }
  if (ratio.w >= ratio.h) {
    return { width: snapSide(longSide), height: snapSide(longSide * ratio.h / ratio.w) };
  }
  return { width: snapSide(longSide * ratio.w / ratio.h), height: snapSide(longSide) };
};

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
};

export const generateCloudflare = async (
  settings: ImageGenerationRuntimeSettings,
  prompt: string,
  inputImages: Array<{ base64: string; mimeType: string }> | undefined,
  aspectRatio: ImageAspectRatio,
): Promise<ImageGenResult | ImageGenError> => {
  const { apiToken, accountId, model } = settings.cloudflare;
  if (!apiToken || !accountId) {
    return { ok: false, error: 'Image generation is not configured (missing Cloudflare API token or Account ID).' };
  }

  const quality = model.params.quality?.default ?? 'auto';
  const { width, height } = resolveCloudflareDimensions(aspectRatio, quality);

  // Do NOT set Content-Type manually: fetch/FormData must generate the
  // multipart boundary themselves.
  const form = new FormData();
  form.append('prompt', prompt);
  form.append('width', String(width));
  form.append('height', String(height));

  if (settings.img2imgEnabled && inputImages && inputImages.length > 0) {
    const references = inputImages.slice(0, CLOUDFLARE_KLEIN_CAPABILITIES.maxReferences);
    for (const [index, image] of references.entries()) {
      const source = Buffer.from(image.base64, 'base64');
      const metadata = await sharp(source).metadata();
      const needsResize = (metadata.width ?? 0) > CLOUDFLARE_KLEIN_CAPABILITIES.referenceMaxSide
        || (metadata.height ?? 0) > CLOUDFLARE_KLEIN_CAPABILITIES.referenceMaxSide;
      const payload = needsResize
        ? await sharp(source)
            .rotate()
            .resize({
              width: CLOUDFLARE_KLEIN_CAPABILITIES.referenceMaxSide,
              height: CLOUDFLARE_KLEIN_CAPABILITIES.referenceMaxSide,
              fit: 'inside',
              withoutEnlargement: true,
            })
            .png()
            .toBuffer()
        : source;
      const mimeType = needsResize ? 'image/png' : image.mimeType;
      const extension = MIME_EXTENSIONS[mimeType] ?? 'jpg';
      const blobBytes = new Uint8Array(payload.byteLength);
      blobBytes.set(payload);
      form.append(
        `input_image_${index}`,
        new Blob([blobBytes], { type: mimeType }),
        `input_image_${index}.${extension}`,
      );
    }
  }

  const response = await fetch(
    `${CF_API_BASE}/accounts/${encodeURIComponent(accountId)}/ai/run/${model.id}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}` },
      body: form,
      signal: AbortSignal.timeout(360_000),
    },
  );

  const payload = await response.json().catch(() => null) as any;
  if (!response.ok || payload?.success !== true) {
    const message = payload?.errors?.[0]?.message
      || payload?.error?.message
      || `HTTP ${response.status}`;
    const error = new Error(message) as any;
    error.response = { status: response.status, data: payload };
    throw error;
  }

  const image = payload?.result?.image;
  if (typeof image === 'string' && image.length > 0) {
    return { ok: true, image_base64: image, prompt_used: prompt };
  }
  if (Array.isArray(image)) {
    // Some Workers AI models return raw byte arrays instead of base64 strings.
    return { ok: true, image_base64: Buffer.from(image).toString('base64'), prompt_used: prompt };
  }
  return { ok: false, error: 'Cloudflare API did not return image data.' };
};
