import { randomUUID } from 'node:crypto';
import { sendIpcToDesktop } from '../ws-clients.js';
import {
  getWebReaderRuntimeSettings,
  recordWebReaderCacheHit,
  recordWebReaderStat,
  type WebReaderProvider,
} from './web-reader-runtime.js';

// Используем базовый урл. Если в .env ничего нет, берем рабочий production-sfo
const BROWSERLESS_BASE_URL = (process.env.BROWSERLESS_BASE_URL || 'https://production-sfo.browserless.io').trim().replace(/\/$/, '');
const BROWSERLESS_TOKEN = (process.env.BROWSERLESS_TOKEN || '').trim();
const WEB_READER_CHUNK_SIZE = 15_000;
const WEB_READER_MAX_TEXT = 120_000;
const WEB_READER_SESSION_TTL_MS = 10 * 60_000;
const MAX_WEB_READER_SESSIONS = 200;
const BROWSERLESS_TIMEOUT_MS = 25_000;

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
  cursor?: string;
  signal?: AbortSignal;
};

type WebPageLink = { text?: string; href?: string };

type WebPageDocument = {
  provider: WebReaderProvider;
  requestedUrl: string;
  title: string;
  url: string;
  text: string;
  links: WebPageLink[];
  description?: string;
  language?: string;
  canonicalUrl?: string;
  truncated: boolean;
};

type WebReaderSession = {
  userId?: number;
  chatId?: number;
  document: WebPageDocument;
  createdAt: number;
};

type DesktopReadResult = {
  title?: string;
  url?: string;
  text?: string;
  elements?: WebPageLink[];
  truncated?: boolean;
};

const webReaderSessions = new Map<string, WebReaderSession>();

const pruneWebReaderSessions = () => {
  const expiresBefore = Date.now() - WEB_READER_SESSION_TTL_MS;
  for (const [id, session] of webReaderSessions) {
    if (session.createdAt < expiresBefore) webReaderSessions.delete(id);
  }
  while (webReaderSessions.size >= MAX_WEB_READER_SESSIONS) {
    const oldestId = webReaderSessions.keys().next().value as string | undefined;
    if (!oldestId) break;
    webReaderSessions.delete(oldestId);
  }
};

const parseWebReaderCursor = (cursor: string): { sessionId: string; offset: number } | null => {
  const match = /^([0-9a-f-]{36}):(\d+)$/i.exec(cursor.trim());
  if (!match) return null;
  const offset = Number(match[2]);
  return Number.isSafeInteger(offset) && offset >= 0 ? { sessionId: match[1], offset } : null;
};

const sameScope = (session: WebReaderSession, options: WebReaderOptions) => (
  session.userId === options.userId && session.chatId === options.chatId
);

const findCachedSession = (requestedUrl: string, options: WebReaderOptions): [string, WebReaderSession] | null => {
  for (const entry of Array.from(webReaderSessions.entries()).reverse()) {
    const [, session] = entry;
    if (session.document.requestedUrl === requestedUrl && sameScope(session, options)) return entry;
  }
  return null;
};

const normalizeLinks = (links: WebPageLink[]): WebPageLink[] => links
  .map(link => ({
    text: `${link?.text || ''}`.replace(/\s+/g, ' ').trim().slice(0, 240),
    href: `${link?.href || ''}`.trim(),
  }))
  .filter(link => /^https?:\/\//i.test(link.href || ''))
  .filter((link, index, items) => items.findIndex(candidate => candidate.href === link.href) === index)
  .slice(0, 40);

const renderDocumentChunk = (sessionId: string, session: WebReaderSession, offset: number): string => {
  const { document } = session;
  if (offset >= document.text.length && document.text.length > 0) throw new Error('web_reader_cursor_invalid');
  const end = Math.min(document.text.length, offset + WEB_READER_CHUNK_SIZE);
  const links = normalizeLinks(document.links)
    .map(link => `- ${link.text || link.href}: ${link.href}`)
    .join('\n');
  const metadata = [
    document.title ? `Title: ${document.title}` : '',
    `URL: ${document.url}`,
    document.canonicalUrl && document.canonicalUrl !== document.url ? `Canonical URL: ${document.canonicalUrl}` : '',
    document.description ? `Description: ${document.description}` : '',
    document.language ? `Language: ${document.language}` : '',
    `Reader: ${document.provider}`,
    links ? `Links:\n${links}` : '',
    '',
    document.text.slice(offset, end),
    document.truncated && end >= document.text.length ? '[Content truncated by reader safety limit]' : '',
  ].filter(Boolean).join('\n');
  const wrapped = wrapUntrustedContent(metadata);
  if (end >= document.text.length) {
    return `${wrapped}\n\nWeb page pagination: showing cached characters ${offset + (document.text.length ? 1 : 0)}-${end} of ${document.text.length} from ${document.provider}.`;
  }
  return `${wrapped}\n\nWeb page pagination: showing cached characters ${offset + 1}-${end} of ${document.text.length} from ${document.provider}. To continue, call read_webpage again with the same URL and cursor "${sessionId}:${end}".`;
};

const toDesktopDocument = (requestedUrl: string, result: DesktopReadResult): WebPageDocument => {
  const text = `${result?.text || ''}`.trim();
  if (!text) throw new Error('desktop_web_reader_empty');
  return {
    provider: 'desktop',
    requestedUrl,
    title: `${result.title || ''}`.trim(),
    url: `${result.url || requestedUrl}`.trim(),
    text: text.slice(0, WEB_READER_MAX_TEXT),
    links: result.elements || [],
    truncated: Boolean(result.truncated) || text.length > WEB_READER_MAX_TEXT,
  };
};

const BROWSERLESS_EXTRACTOR = `() => {
  const clean = (value, max) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max);
  const extractText = (node) => {
    if (!node) return '';
    const clone = node.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, template, svg, canvas, nav, footer').forEach((item) => item.remove());
    return String(clone.innerText || clone.textContent || '').replace(/\\n{3,}/g, '\\n\\n').trim();
  };
  const primary = Array.from(document.querySelectorAll('article, main, [role="main"]'))
    .filter(Boolean)
    .map(extractText)
    .sort((a, b) => b.length - a.length)[0] || '';
  const selected = primary.length >= 500 ? primary : extractText(document.body);
  const links = Array.from(document.querySelectorAll('a[href]')).map((anchor) => ({
    text: clean(anchor.innerText || anchor.textContent || '', 240),
    href: anchor.href,
  })).filter((link) => /^https?:\\/\\//i.test(link.href)).slice(0, 160);
  return JSON.stringify({
    title: clean(document.title, 500),
    url: location.href,
    canonicalUrl: document.querySelector('link[rel="canonical"]')?.href || '',
    description: clean(document.querySelector('meta[name="description"], meta[property="og:description"]')?.content || '', 1000),
    language: clean(document.documentElement.lang, 50),
    text: selected.slice(0, ${WEB_READER_MAX_TEXT}),
    links,
    truncated: selected.length > ${WEB_READER_MAX_TEXT},
  });
}`;

const requestSignal = (signal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } => {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('browserless_timeout')), BROWSERLESS_TIMEOUT_MS);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    },
  };
};

const getCleanTextFromBrowserless = async (url: string, signal?: AbortSignal): Promise<WebPageDocument> => {
  if (!BROWSERLESS_TOKEN) {
    recordWebReaderStat('browserless', 'failure', 0, 'browserless_token_missing');
    throw new Error('browserless_token_missing');
  }

  const endpoint = `${BROWSERLESS_BASE_URL}/stealth/bql?token=${encodeURIComponent(BROWSERLESS_TOKEN)}&blockConsentModals=true&timeout=${BROWSERLESS_TIMEOUT_MS}`;
  const query = `
    mutation ScrapeTarget($target: String!, $extractor: String!) {
      goto(url: $target, waitUntil: domContentLoaded) { status }
      extract: evaluate(content: $extractor) { value }
    }
  `;
  const controlled = requestSignal(signal);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: { target: url, extractor: BROWSERLESS_EXTRACTOR },
      }),
      signal: controlled.signal,
    });

    const responseData = await response.json() as any;
    if (!response.ok) {
      throw new Error(`browserless_http_${response.status}: ${JSON.stringify(responseData).slice(0, 1000)}`);
    }

    const value = responseData?.data?.extract?.value;
    if ((value === null || value === undefined) && responseData?.errors?.length) {
      const errorMsg = responseData.errors.map((e: any) => e.message).join(' | ');
      throw new Error(`browserless_graphql: ${errorMsg}`);
    }
    const extracted = typeof value === 'string' ? JSON.parse(value) : value;
    const text = `${extracted?.text || ''}`.trim();
    if (!text) {
      recordWebReaderStat('browserless', 'empty');
      throw new Error('browserless_web_reader_empty');
    }
    const document: WebPageDocument = {
      provider: 'browserless',
      requestedUrl: url,
      title: `${extracted.title || ''}`.trim(),
      url: `${extracted.url || url}`.trim(),
      canonicalUrl: `${extracted.canonicalUrl || ''}`.trim(),
      description: `${extracted.description || ''}`.trim(),
      language: `${extracted.language || ''}`.trim(),
      text: text.slice(0, WEB_READER_MAX_TEXT),
      links: Array.isArray(extracted.links) ? extracted.links : [],
      truncated: Boolean(extracted.truncated) || text.length > WEB_READER_MAX_TEXT,
    };
    recordWebReaderStat('browserless', 'success', document.text.length);
    return document;
  } catch (error: any) {
    const errorDetails = error?.message || String(error);
    if (errorDetails !== 'browserless_web_reader_empty') {
      recordWebReaderStat('browserless', 'failure', 0, errorDetails);
    }
    throw error;
  } finally {
    controlled.cleanup();
  }
};

export const getCleanTextFromUrl = async (targetUrl: string, options: WebReaderOptions = {}) => {
  const rawUrl = `${targetUrl || ''}`.trim();
  if (!rawUrl) throw new Error('url_required');
  if (!isHttpUrl(rawUrl)) throw new Error('bad_url');
  if (isUnsafeLocalUrl(rawUrl)) throw new Error('unsafe_url');
  const url = new URL(rawUrl).href;
  const runtime = getWebReaderRuntimeSettings();
  if (!runtime.enabled) throw new Error('web_reader_disabled');
  pruneWebReaderSessions();

  if (options.cursor) {
    const parsed = parseWebReaderCursor(options.cursor);
    if (!parsed) throw new Error('web_reader_cursor_invalid');
    const session = webReaderSessions.get(parsed.sessionId);
    if (!session) throw new Error('web_reader_cursor_expired');
    if (!sameScope(session, options) || session.document.requestedUrl !== url) {
      throw new Error('web_reader_cursor_mismatch');
    }
    recordWebReaderCacheHit(session.document.provider);
    return renderDocumentChunk(parsed.sessionId, session, parsed.offset);
  }

  const cached = findCachedSession(url, options);
  if (cached) {
    recordWebReaderCacheHit(cached[1].document.provider);
    return renderDocumentChunk(cached[0], cached[1], 0);
  }

  let document: WebPageDocument | null = null;
  if (runtime.desktopEnabled && Number.isInteger(options.userId) && Number(options.userId) > 0) {
    try {
      const result = await sendIpcToDesktop(Number(options.userId), 'read_webpage', {
        url,
        ...(Number.isInteger(options.chatId) && Number(options.chatId) > 0 ? { chat_id: Number(options.chatId) } : {}),
      }, 60_000, options.signal) as DesktopReadResult;
      document = toDesktopDocument(url, result);
      recordWebReaderStat('desktop', 'success', document.text.length);
    } catch (error: any) {
      if (options.signal?.aborted || error?.name === 'AbortError') throw error;
      if (`${error?.message || ''}` === 'desktop_web_reader_url_blocked') throw error;
      if (`${error?.message || ''}` === 'desktop_web_reader_empty') {
        recordWebReaderStat('desktop', 'empty');
      } else {
        recordWebReaderStat('desktop', 'failure', 0, `${error?.message || String(error)}`);
      }
      console.info('[web-reader] desktop read unavailable; using Browserless fallback', {
        reason: `${error?.message || String(error)}`,
      });
    }
  }

  if (!document) {
    if (!runtime.browserlessEnabled) throw new Error('web_reader_no_provider_available');
    document = await getCleanTextFromBrowserless(url, options.signal);
  }

  const sessionId = randomUUID();
  const session: WebReaderSession = {
    userId: options.userId,
    chatId: options.chatId,
    document,
    createdAt: Date.now(),
  };
  webReaderSessions.set(sessionId, session);
  return renderDocumentChunk(sessionId, session, 0);
};
