/**
 * Shared Telegram sending utilities.
 * Used by: scheduler.ts (task results), server.ts (send-to-telegram endpoint).
 *
 * This bypasses the Telegraf bot instance (which lives in index.ts)
 * and calls the Telegram Bot API directly via fetch.
 */

const TELEGRAM_TOKEN = `${process.env.TELEGRAM_TOKEN || ''}`.trim();

/** Split text into chunks ≤ maxLen, preferring to break at newlines. */
export const splitTextForTelegram = (text: string, maxLen = 4000): string[] => {
  const source = typeof text === 'string' ? text : String(text ?? '');
  if (source.length <= maxLen) return [source];

  const chunks: string[] = [];
  let remaining = source;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n', maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
};

/** Format Markdown to Telegram-compatible (same logic as safeReply in index.ts). */
export const formatForTelegram = (text: string): string => {
  return text
    // ### **Текст** → 🔹 *Текст*
    .replace(/^#+\s+\*\*(.*?)\*\*/gm, '🔹 *$1*')
    // ### Текст → 🔹 *Текст*
    .replace(/^#+\s+(.*)/gm, '🔹 *$1*')
    // * item → • item
    .replace(/^\*\s/gm, '• ')
    // **bold** → *bold* (Telegram uses single asterisks)
    .replace(/\*\*(.*?)\*\*/g, '*$1*');
};

/**
 * Send a text message to a Telegram chat (by chat_id / user_id).
 * Handles: Markdown formatting, long text splitting, plain-text fallback.
 */
export const sendTelegramMessage = async (chatId: number, text: string): Promise<void> => {
  if (!TELEGRAM_TOKEN) return;

  const tgFormatted = formatForTelegram(text);
  const chunks = splitTextForTelegram(tgFormatted);

  for (const chunk of chunks) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'Markdown' })
      });
      const data = await response.json().catch(() => ({}));
      // Fallback: plain text if Markdown fails
      if (!response.ok || data?.ok === false) {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: chunk })
        });
      }
    } catch {
      // ignore
    }
  }
};

/**
 * Send a photo (by file path on disk) to a Telegram chat.
 * Used by send-to-telegram endpoint when message has images.
 */
export const sendTelegramPhoto = async (
  chatId: number,
  imageBuffer: Buffer,
  caption?: string
): Promise<void> => {
  if (!TELEGRAM_TOKEN) return;

  const formData = new FormData();
  formData.append('chat_id', String(chatId));
  formData.append('photo', new Blob([new Uint8Array(imageBuffer)]), 'photo.webp');
  if (caption) formData.append('caption', caption.slice(0, 1024));

  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, {
    method: 'POST',
    body: formData
  });
};
