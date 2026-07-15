/**
 * Shared Telegram sending utilities.
 * Used by: scheduler.ts (task results), server.ts (send-to-telegram endpoint).
 *
 * This bypasses the Telegraf bot instance (which lives in index.ts)
 * and calls the Telegram Bot API directly via fetch.
 */

import { marked, Renderer } from 'marked';

const TELEGRAM_TOKEN = `${process.env.TELEGRAM_TOKEN || ''}`.trim();
const TG_USE_RICH_MESSAGES =
  process.env.TG_USE_RICH_MESSAGES === '1' ||
  process.env.TG_USE_RICH_STREAMING === '1';
const formatSafeError = (error: unknown) => error instanceof Error ? error.message : String(error);

type SendTelegramMessageOptions = {
  strict?: boolean;
  preferRich?: boolean;
};

const escapeRichHtml = (text: string): string => text
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const isSafeRichUrl = (url: string): boolean => /^(https?:|mailto:|tel:|tg:\/\/)/i.test(url.trim());

const cleanCodeLanguage = (lang?: string): string => (lang || '')
  .split(/\s+/)[0]
  .replace(/[^a-zA-Z0-9_+#.-]/g, '')
  .slice(0, 40);

const createTelegramRichMarkdownRenderer = (): Renderer => {
  const renderer = new Renderer();
  const inline = (tokens: any[]) => renderer.parser.parseInline(tokens);
  const block = (tokens: any[]) => renderer.parser.parse(tokens);
  const listItemContent = (tokens: any[]) => tokens
    .map(token => {
      if ((token?.type === 'paragraph' || token?.type === 'text') && Array.isArray(token.tokens)) {
        return inline(token.tokens);
      }
      return block([token]);
    })
    .join('');

  renderer.code = ({ text, lang }) => {
    const language = cleanCodeLanguage(lang);
    const classAttr = language ? ` class="language-${escapeRichHtml(language)}"` : '';
    return `<pre><code${classAttr}>${escapeRichHtml(text)}</code></pre>\n`;
  };
  renderer.blockquote = ({ tokens }) => `<blockquote>${block(tokens)}</blockquote>\n`;
  renderer.heading = ({ tokens, depth }) => {
    const level = Math.min(Math.max(depth, 1), 6);
    return `<h${level}>${inline(tokens)}</h${level}>\n`;
  };
  renderer.hr = () => '<hr/>\n';
  renderer.paragraph = ({ tokens }) => `<p>${inline(tokens)}</p>\n`;
  renderer.strong = ({ tokens }) => `<b>${inline(tokens)}</b>`;
  renderer.em = ({ tokens }) => `<i>${inline(tokens)}</i>`;
  renderer.codespan = ({ text }) => `<code>${escapeRichHtml(text)}</code>`;
  renderer.br = () => '<br>';
  renderer.del = ({ tokens }) => `<s>${inline(tokens)}</s>`;
  renderer.text = ({ text }) => escapeRichHtml(text);
  renderer.html = ({ text, block }) => block ? `<p>${escapeRichHtml(text)}</p>\n` : escapeRichHtml(text);
  renderer.image = ({ href, text }) => {
    const alt = text?.trim() || href;
    if (!href || !isSafeRichUrl(href)) return escapeRichHtml(alt || '');
    return `<a href="${escapeRichHtml(href)}">${escapeRichHtml(alt)}</a>`;
  };
  renderer.link = ({ href, tokens }) => {
    const label = inline(tokens);
    if (!href || !isSafeRichUrl(href)) return label;
    return `<a href="${escapeRichHtml(href)}">${label}</a>`;
  };
  renderer.list = ({ ordered, start, items }) => {
    const tag = ordered ? 'ol' : 'ul';
    const startAttr = ordered && typeof start === 'number' && start > 1 ? ` start="${start}"` : '';
    const body = items.map(item => renderer.listitem(item)).join('');
    return `<${tag}${startAttr}>${body}</${tag}>\n`;
  };
  renderer.listitem = (item) => {
    const checkbox = item.task ? `<code>${item.checked ? 'x' : ' '}</code> ` : '';
    return `<li>${checkbox}${listItemContent(item.tokens)}</li>`;
  };
  renderer.table = ({ header, rows }) => {
    const head = `<tr>${header.map(cell => renderer.tablecell({ ...cell, header: true })).join('')}</tr>`;
    const body = rows
      .map(row => `<tr>${row.map(cell => renderer.tablecell({ ...cell, header: false })).join('')}</tr>`)
      .join('');
    return `<table>${head}${body}</table>\n`;
  };
  renderer.tablecell = ({ tokens, header, align }) => {
    const tag = header ? 'th' : 'td';
    const alignAttr = align ? ` align="${align}"` : '';
    return `<${tag}${alignAttr}>${inline(tokens)}</${tag}>`;
  };

  return renderer;
};

export const markdownToTelegramRichHtml = (text: string): string => {
  const markdown = text.trim();
  if (!markdown) return '';

  try {
    const html = marked.parse(markdown, {
      async: false,
      gfm: true,
      breaks: true,
      renderer: createTelegramRichMarkdownRenderer(),
    });
    return typeof html === 'string' ? html.trim() : `<p>${escapeRichHtml(markdown)}</p>`;
  } catch (err: any) {
    console.warn('[telegram-send] rich markdown render failed:', formatSafeError(err));
    return `<p>${escapeRichHtml(markdown)}</p>`;
  }
};

const assertTelegramOk = async (response: Response, method: string): Promise<any> => {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    const description = data?.description || `${response.status} ${response.statusText}`;
    throw new Error(`${method}_failed: ${description}`);
  }
  return data;
};

const sendTelegramJson = async (method: string, payload: Record<string, unknown>): Promise<any> => {
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return assertTelegramOk(response, method);
};

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
export const sendTelegramMessage = async (
  chatId: number,
  text: string,
  options: SendTelegramMessageOptions = {}
): Promise<void> => {
  if (!TELEGRAM_TOKEN) {
    if (options.strict) throw new Error('telegram_not_configured');
    return;
  }

  const source = typeof text === 'string' ? text : String(text ?? '');
  if (!source.trim()) return;

  const preferRich = options.preferRich ?? TG_USE_RICH_MESSAGES;
  let fallbackSource = source;
  if (preferRich) {
    const richChunks = splitTextForTelegram(source, 12000);
    let richChunkIndex = 0;
    try {
      for (; richChunkIndex < richChunks.length; richChunkIndex++) {
        const chunk = richChunks[richChunkIndex];
        const html = markdownToTelegramRichHtml(chunk);
        if (!html) continue;
        await sendTelegramJson('sendRichMessage', {
          chat_id: chatId,
          rich_message: { html },
        });
      }
      return;
    } catch (err) {
      fallbackSource = richChunks.slice(richChunkIndex).join('\n');
      console.warn('[telegram-send] sendRichMessage failed, falling back to sendMessage:', formatSafeError(err));
      if (options.strict) {
        // Keep fallback below, but if that also fails the endpoint should report it.
      }
    }
  }

  const tgFormatted = formatForTelegram(fallbackSource);
  const chunks = splitTextForTelegram(tgFormatted);

  for (const chunk of chunks) {
    try {
      await sendTelegramJson('sendMessage', { chat_id: chatId, text: chunk, parse_mode: 'Markdown' });
    } catch (err) {
      try {
        await sendTelegramJson('sendMessage', { chat_id: chatId, text: chunk });
      } catch (fallbackErr) {
        if (options.strict) throw fallbackErr;
        console.warn('[telegram-send] sendMessage failed:', formatSafeError(fallbackErr));
      }
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
