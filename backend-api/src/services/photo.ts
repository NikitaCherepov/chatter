import { sendMessageThroughAi } from './ai.js';

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
  }
) => {
  const normalizedImage = `${imageBase64 || ''}`.trim();
  if (!normalizedImage) throw new Error('empty_image');

  const imageBuffer = Buffer.from(normalizedImage, 'base64');
  if (!imageBuffer.length) throw new Error('empty_image');
  if (imageBuffer.length > MAX_IMAGE_BYTES) throw new Error('image_too_large');

  const userPrompt = `${caption || ''}`.trim() || '';
  const result = await sendMessageThroughAi(userId, userPrompt, chatId, {
    image: {
      base64: normalizedImage,
      mimeType: `${imageMimeType || 'image/jpeg'}`.trim() || 'image/jpeg'
    },
    persistUserText: caption ? `[Фото] ${caption}` : '[Фото]',
    userTelegramChatId: options?.userTelegramChatId ?? null,
    userTelegramMessageId: options?.userTelegramMessageId ?? null
  });

  return result;
};
