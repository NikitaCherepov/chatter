import { sendMessageThroughAi } from './ai.js';
import { getUserById } from './chats.js';
import { saveUserImageThumbnail } from './image-storage.js';
import { areImageAttachmentsAllowedForPlan, MAX_IMAGES_PER_REQUEST } from './plan-limits.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export const runPhotoAnalyzeTurn = async (
  userId: number,
  imageBase64: string,
  imageMimeType: string,
  caption: string,
  chatId?: number,
  options?: {
    userTelegramChatId?: number | null;
    userTelegramMessageId?: number | null;
    extraImages?: Array<{ base64: string; mimeType: string }>;
  }
) => {
  const user = getUserById(userId);
  if (!user) throw new Error('user_not_found');

  const normalizedImage = `${imageBase64 || ''}`.trim();
  if (!normalizedImage) throw new Error('empty_image');

  const imageBuffer = Buffer.from(normalizedImage, 'base64');
  if (!imageBuffer.length) throw new Error('empty_image');
  if (imageBuffer.length > MAX_IMAGE_BYTES) throw new Error('image_too_large');

  if (!areImageAttachmentsAllowedForPlan(user.plan, user.is_admin === 1)) throw new Error('images_not_allowed_for_plan');

  const extraImages = (options?.extraImages ?? [])
    .filter(img => img.base64)
    .map(img => {
      const buf = Buffer.from(img.base64, 'base64');
      if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
      return { base64: img.base64, mimeType: img.mimeType || 'image/jpeg' };
    })
    .filter((img): img is { base64: string; mimeType: string } => img !== null);

  const totalImages = 1 + extraImages.length;
  if (totalImages > MAX_IMAGES_PER_REQUEST) {
    throw new Error(`too_many_images_max_${MAX_IMAGES_PER_REQUEST}`);
  }

  const allImages = [
    { base64: normalizedImage, mimeType: `${imageMimeType || 'image/jpeg'}`.trim() || 'image/jpeg' },
    ...extraImages
  ];

  // Save thumbnails for all images
  let userImages: Array<{ url: string; type: 'user_photo' }> | null = null;
  try {
    const saved: Array<{ url: string; type: 'user_photo' }> = [];
    for (const img of allImages) {
      const result = await saveUserImageThumbnail(img.base64, img.mimeType);
      saved.push({ url: result.url, type: 'user_photo' });
    }
    userImages = saved;
  } catch (err) {
    console.error('[photo] failed to save image thumbnails:', err);
  }

  const userPrompt = `${caption || ''}`.trim() || '';
  const result = await sendMessageThroughAi(userId, userPrompt, chatId, {
    images: allImages,
    persistUserText: caption ? `[Фото${allImages.length > 1 ? ` (${allImages.length} шт)` : ''}] ${caption}` : `[Фото${allImages.length > 1 ? ` (${allImages.length} шт)` : ''}]`,
    userTelegramChatId: options?.userTelegramChatId ?? null,
    userTelegramMessageId: options?.userTelegramMessageId ?? null,
    userImages
  });

  return result;
};
