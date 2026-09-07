import { sendIpcToDesktop } from '../ws-clients.js';
import { getWebReaderRuntimeSettings, recordWebReaderStat } from './web-reader-runtime.js';

// Используем базовый урл. Если в .env ничего нет, берем рабочий production-sfo
const BROWSERLESS_BASE_URL = (process.env.BROWSERLESS_BASE_URL || 'https://production-sfo.browserless.io').trim().replace(/\/$/, '');
const BROWSERLESS_TOKEN = (process.env.BROWSERLESS_TOKEN || '').trim();

const isHttpUrl = (value: string) => {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

const isUnsafeLocalUrl = (value: string): boolean => {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return true;
    const ipv4 = hostname.split('.').map(Number);
    if (ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
      const [a, b] = ipv4;
      return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168) || a >= 224;
    }
    if (hostname === '::' || hostname === '::1' || /^(?:fc|fd)/i.test(hostname) || /^fe[89ab]/i.test(hostname)) return true;
    const mappedIpv4 = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
    return mappedIpv4 ? isUnsafeLocalUrl(`http://${mappedIpv4}`) : false;
  } catch {
    return true;
  }
};

/** Escapes closing tags inside content to prevent break-out from untrusted data wrappers. */
export const wrapUntrustedContent = (content: string): string => {
  const sanitized = content.replace(
    /<\s*\/\s*untrusted_web_content\s*>/gi,
    '&lt;/untrusted_web_content&gt;',
  );
  return `<untrusted_web_content>${sanitized}</untrusted_web_content>`;
};

type WebReaderOptions = {
  userId?: number;
  chatId?: number;
  signal?: AbortSignal;
};

type DesktopReadResult = {
  title?: string;
  url?: string;
  text?: string;
  elements?: Array<{ text?: string; href?: string }>;
  truncated?: boolean;
};

const formatDesktopResult = (result: DesktopReadResult): string => {
  const text = `${result?.text || ''}`.trim();
  if (!text) throw new Error('desktop_web_reader_empty');
  const links = (result.elements || [])
    .filter((item) => typeof item?.href === 'string' && /^https?:\/\//i.test(item.href))
    .filter((item, index, items) => items.findIndex((candidate) => candidate.href === item.href) === index)
    .slice(0, 40)
    .map((item) => `- ${`${item.text || item.href}`.replace(/\s+/g, ' ').trim().slice(0, 240)}: ${item.href}`);
  const parts = [
    result.title ? `Title: ${result.title}` : '',
    result.url ? `URL: ${result.url}` : '',
    '',
    text.slice(0, 15_000),
    links.length ? `\nLinks:\n${links.join('\n')}` : '',
    result.truncated ? '\n[Content truncated]' : '',
  ].filter((part, index) => Boolean(part) || index === 2);
  return wrapUntrustedContent(parts.join('\n'));
};

const getCleanTextFromBrowserless = async (url: string) => {
  if (!BROWSERLESS_TOKEN) {
    recordWebReaderStat('browserless', 'failure', 0, 'browserless_token_missing');
    throw new Error('browserless_token_missing');
  }

  // Тот самый рабочий Stealth эндпоинт
  const endpoint = `${BROWSERLESS_BASE_URL}/stealth/bql?token=${encodeURIComponent(BROWSERLESS_TOKEN)}&blockConsentModals=true`;

  // Идеально выверенная мутация
  const query = `
    mutation ScrapeTarget($target: String!) {
      goto(url: $target, waitUntil: networkIdle) { status }
      solve(wait: true) { time }
      text(selector: "body") { text }
    }
  `;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: { target: url },
      }),
      signal: AbortSignal.timeout(45_000),
    });

    const responseData = await response.json() as any;
    if (!response.ok) {
      throw new Error(`browserless_http_${response.status}: ${JSON.stringify(responseData).slice(0, 1000)}`);
    }

    // ПРОВЕРКА НА ВНУТРЕННИЕ ОШИБКИ GRAPHQL
    if (responseData?.errors && responseData.errors.length > 0) {
      const errorMsg = responseData.errors.map((e: any) => e.message).join(' | ');
      console.error('GraphQL Internal Errors:', errorMsg);
      recordWebReaderStat('browserless', 'failure', 0, `graphql: ${errorMsg}`);
      return `Ошибка парсера (GraphQL): ${errorMsg}`;
    }

    const rawText = responseData?.data?.text?.text || '';
    const cleanText = rawText.replace(/\s+/g, ' ').trim();

    if (!cleanText) {
      recordWebReaderStat('browserless', 'empty');
      return 'Текст на странице не найден или контент заблокирован (возможно, пустой body).';
    }

    recordWebReaderStat('browserless', 'success', Math.min(cleanText.length, 15_000));
    return wrapUntrustedContent(cleanText.slice(0, 15000));

  } catch (error: any) {
    const errorDetails = error?.message || String(error);
    console.error('Browserless BQL HTTP Error:', errorDetails);
    recordWebReaderStat('browserless', 'failure', 0, errorDetails);
    return `HTTP Ошибка при чтении страницы: ${errorDetails}`;
  }
};

export const getCleanTextFromUrl = async (targetUrl: string, options: WebReaderOptions = {}) => {
  const url = `${targetUrl || ''}`.trim();
  if (!url) throw new Error('url_required');
  if (!isHttpUrl(url)) throw new Error('bad_url');
  if (isUnsafeLocalUrl(url)) throw new Error('unsafe_url');
  const runtime = getWebReaderRuntimeSettings();
  if (!runtime.enabled) throw new Error('web_reader_disabled');

  if (runtime.desktopEnabled && Number.isInteger(options.userId) && Number(options.userId) > 0) {
    try {
      const result = await sendIpcToDesktop(Number(options.userId), 'read_webpage', {
        url,
        ...(Number.isInteger(options.chatId) && Number(options.chatId) > 0 ? { chat_id: Number(options.chatId) } : {}),
      }, 60_000, options.signal) as DesktopReadResult;
      const sourceText = `${result?.text || ''}`.trim();
      if (!sourceText) {
        recordWebReaderStat('desktop', 'empty');
        throw new Error('desktop_web_reader_empty');
      }
      const formatted = formatDesktopResult(result);
      recordWebReaderStat('desktop', 'success', Math.min(sourceText.length, 15_000));
      return formatted;
    } catch (error: any) {
      if (options.signal?.aborted || error?.name === 'AbortError') throw error;
      if (`${error?.message || ''}` === 'desktop_web_reader_url_blocked') throw error;
      if (`${error?.message || ''}` !== 'desktop_web_reader_empty') {
        recordWebReaderStat('desktop', 'failure', 0, `${error?.message || String(error)}`);
      }
      console.info('[web-reader] desktop read unavailable; using Browserless fallback', {
        reason: `${error?.message || String(error)}`,
      });
    }
  }

  if (!runtime.browserlessEnabled) throw new Error('web_reader_no_provider_available');
  return getCleanTextFromBrowserless(url);
};
