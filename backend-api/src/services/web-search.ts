import { randomUUID } from 'node:crypto';
import { sendIpcToDesktop } from '../ws-clients.js';
import { wrapUntrustedContent } from './web-reader.js';

const SEARXNG_BASE_URL = `${process.env.SEARXNG_BASE_URL || 'http://searxng:8080'}`.trim().replace(/\/+$/, '');
const SEARXNG_ENABLED = !['0', 'false', 'off', 'disabled'].includes(`${process.env.SEARXNG_ENABLED || 'true'}`.trim().toLowerCase());
const TAVILY_API_KEY = `${process.env.TAVILY_API_KEY || ''}`.trim();
const TAVILY_API_BASE_URL = `${process.env.TAVILY_API_BASE_URL || 'https://api.tavily.com'}`.trim().replace(/\/+$/, '');
const SEARCH_TIMEOUT_MS = 15_000;
const MAX_RESULTS = 5;
const MAX_SEARCH_PAGE = 10;
const TAVILY_MAX_RESULTS = 20;
const SEARCH_SESSION_TTL_MS = 10 * 60_000;
const MAX_SEARCH_SESSIONS = 200;

type SearchType = 'web' | 'news';
type SearchSort = 'relevance' | 'date';
type SearchFreshness = 'any' | 'day' | 'week' | 'month' | 'year';
type SearchMode = 'web' | 'wikipedia';
type SearchProvider = 'desktop' | 'searxng' | 'tavily';

export type TavilyQuotaGate = {
  check: () => string | null;
  consume: () => void;
};

type WebSearchOptions = {
  userId: number;
  chatId?: number;
  cursor?: string;
  wikipedia?: boolean;
  searchType?: SearchType;
  sort?: SearchSort;
  freshness?: SearchFreshness;
  language?: string | null;
  tavilyQuota?: TavilyQuotaGate;
};

type SearchResult = {
  title?: string;
  content?: string;
  url?: string;
  engine?: string;
  engines?: string[];
  positions?: number[];
  score?: number;
  published_date?: string;
  publishedDate?: string;
};

type SearchSession = {
  userId: number;
  chatId?: number;
  query: string;
  mode: SearchMode;
  searchType: SearchType;
  sort: SearchSort;
  freshness: SearchFreshness;
  language: string;
  provider: SearchProvider | null;
  results: SearchResult[];
  nextPage: number;
  exhausted: boolean;
  answer?: string;
  createdAt: number;
};

type SearxngResponse = {
  results?: SearchResult[];
  unresponsive_engines?: unknown[];
};

type DesktopSearchResponse = {
  url?: string;
  title?: string;
  challenge?: 'captcha' | null;
  results?: SearchResult[];
};

type TavilyResponse = {
  answer?: string;
  request_id?: string;
  usage?: { credits?: number };
  results?: SearchResult[];
};

const searchSessions = new Map<string, SearchSession>();

const pruneSearchSessions = () => {
  const expiresBefore = Date.now() - SEARCH_SESSION_TTL_MS;
  for (const [id, session] of searchSessions) {
    if (session.createdAt < expiresBefore) searchSessions.delete(id);
  }
  while (searchSessions.size >= MAX_SEARCH_SESSIONS) {
    const oldestId = searchSessions.keys().next().value as string | undefined;
    if (!oldestId) break;
    searchSessions.delete(oldestId);
  }
};

const parseSearchCursor = (cursor: string): { searchId: string; offset: number } | null => {
  const match = /^([0-9a-f-]{36}):(\d+)$/i.exec(cursor.trim());
  if (!match) return null;
  const offset = Number(match[2]);
  return Number.isSafeInteger(offset) && offset >= 0 ? { searchId: match[1], offset } : null;
};

const failureName = (failure: unknown): string => {
  if (Array.isArray(failure)) return `${failure[0] || ''}`.trim();
  if (failure && typeof failure === 'object' && 'engine' in failure) return `${(failure as { engine?: unknown }).engine || ''}`.trim();
  return `${failure || ''}`.trim();
};

const failureReason = (failure: unknown): string => {
  if (Array.isArray(failure)) return `${failure[1] || ''}`.trim();
  if (failure && typeof failure === 'object') {
    if ('error' in failure) return `${(failure as { error?: unknown }).error || ''}`.trim();
    if ('reason' in failure) return `${(failure as { reason?: unknown }).reason || ''}`.trim();
  }
  return '';
};

const resultEngines = (result: SearchResult, provider?: SearchProvider | null): string[] => {
  const engines = Array.isArray(result.engines) && result.engines.length ? result.engines : [result.engine || ''];
  const normalized = engines.map(engine => `${engine}`.trim()).filter(Boolean);
  return normalized.length ? normalized : provider ? [provider] : [];
};

const withTimeout = async <T>(label: string, signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error(`${label}_timeout`)), SEARCH_TIMEOUT_MS);
  try {
    return await action(controller.signal);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', forwardAbort);
  }
};

const fetchDesktopPage = async (session: SearchSession, page: number, signal?: AbortSignal): Promise<SearchResult[]> => {
  const response = await sendIpcToDesktop(session.userId, 'web_search', {
    query: session.query,
    mode: session.mode,
    searchType: session.searchType,
    sort: session.sort,
    freshness: session.freshness,
    page,
    language: session.language,
    ...(session.chatId ? { chat_id: session.chatId } : {}),
  }, 30_000, signal) as DesktopSearchResponse;
  if (response?.challenge === 'captcha') throw new Error('desktop_search_captcha_required');
  const results = Array.isArray(response?.results) ? response.results : [];
  console.info('[web-search] Desktop browser report', JSON.stringify({
    page,
    searchMode: session.mode,
    searchType: session.searchType,
    sort: session.sort,
    freshness: session.freshness,
    url: response?.url || '',
    title: response?.title || '',
    resultCount: results.length,
    results: results.map((result, index) => ({ rank: index + 1, title: result.title || '', url: result.url || '' })),
  }, null, 2));
  return results;
};

const fetchSearxngPage = async (session: SearchSession, page: number, signal?: AbortSignal): Promise<SearchResult[]> => {
  if (!SEARXNG_ENABLED || !SEARXNG_BASE_URL) throw new Error('searxng_disabled');
  return withTimeout('searxng', signal, async requestSignal => {
    const url = new URL(`${SEARXNG_BASE_URL}/search`);
    url.searchParams.set('q', session.mode === 'wikipedia' ? `!wikipedia ${session.query}` : session.query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('categories', session.searchType === 'news' ? 'news' : 'general');
    url.searchParams.set('language', session.language);
    url.searchParams.set('pageno', `${page}`);
    if (session.freshness !== 'any') url.searchParams.set('time_range', session.freshness);
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'X-Client-Source': 'chatter-backend' },
      signal: requestSignal,
    });
    if (!response.ok) throw new Error(`searxng_http_${response.status}`);
    const data = await response.json() as SearxngResponse;
    const results = Array.isArray(data.results) ? data.results : [];
    const failures = (Array.isArray(data.unresponsive_engines) ? data.unresponsive_engines : [])
      .map(failure => ({ engine: failureName(failure), reason: failureReason(failure) }))
      .filter(failure => failure.engine);
    console.info('[web-search] SearXNG engine report', JSON.stringify({
      page,
      searchMode: session.mode,
      returned: [...new Set(results.flatMap(result => resultEngines(result)))].sort(),
      failed: failures,
      resultCount: results.length,
      results: results.map((result, index) => ({
        rank: index + 1,
        title: result.title || '',
        engines: resultEngines(result),
        positions: result.positions || [],
        score: result.score ?? null,
        url: result.url || '',
      })),
    }, null, 2));
    if (!results.length && failures.length) throw new Error('searxng_engines_unavailable');
    return results;
  });
};

const publishedTimestamp = (result: SearchResult): number => {
  const value = result.published_date || result.publishedDate;
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : -1;
};

const fetchTavily = async (session: SearchSession, signal?: AbortSignal): Promise<TavilyResponse> => {
  if (!TAVILY_API_KEY) throw new Error('tavily_not_configured');
  return withTimeout('tavily', signal, async requestSignal => {
    const body: Record<string, unknown> = {
      query: session.query,
      search_depth: 'basic',
      topic: session.searchType === 'news' ? 'news' : 'general',
      max_results: TAVILY_MAX_RESULTS,
      include_answer: true,
    };
    if (session.freshness !== 'any') body.time_range = session.freshness;
    if (session.mode === 'wikipedia') body.include_domains = ['wikipedia.org'];
    const response = await fetch(`${TAVILY_API_BASE_URL}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TAVILY_API_KEY}`,
        'X-Client-Source': 'chatter-backend',
      },
      body: JSON.stringify(body),
      signal: requestSignal,
    });
    if (!response.ok) throw new Error(`tavily_http_${response.status}`);
    const data = await response.json() as TavilyResponse;
    const results = Array.isArray(data.results) ? data.results : [];
    if (session.sort === 'date') results.sort((left, right) => publishedTimestamp(right) - publishedTimestamp(left));
    console.info('[web-search] Tavily report', JSON.stringify({
      searchMode: session.mode,
      searchType: session.searchType,
      sort: session.sort,
      freshness: session.freshness,
      requestId: data.request_id || '',
      credits: data.usage?.credits ?? null,
      resultCount: results.length,
      results: results.map((result, index) => ({
        rank: index + 1,
        title: result.title || '',
        score: result.score ?? null,
        publishedDate: result.published_date || result.publishedDate || '',
        url: result.url || '',
      })),
    }, null, 2));
    return { ...data, results };
  });
};

const appendUniqueResults = (session: SearchSession, incoming: SearchResult[]) => {
  const knownUrls = new Set(session.results.map(result => result.url).filter(Boolean));
  for (const result of incoming) {
    if (result.url && knownUrls.has(result.url)) continue;
    if (result.url) knownUrls.add(result.url);
    session.results.push(result);
  }
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const initializeProvider = async (session: SearchSession, quota: TavilyQuotaGate | undefined, signal?: AbortSignal): Promise<string | null> => {
  try {
    const results = await fetchDesktopPage(session, 1, signal);
    session.provider = 'desktop';
    session.nextPage = 2;
    session.exhausted = !results.length;
    appendUniqueResults(session, results);
    return null;
  } catch (error) {
    if (signal?.aborted) throw error;
    const message = errorMessage(error);
    if (message === 'desktop_search_captcha_required') {
      return 'Tool error: desktop search requires verification. A CAPTCHA window was opened in Chatter Desktop. Ask the user to complete it, then repeat the search.';
    }
    console.info('[web-search] Desktop unavailable, trying SearXNG', { error: message });
  }

  try {
    const results = await fetchSearxngPage(session, 1, signal);
    session.provider = 'searxng';
    session.nextPage = 2;
    session.exhausted = !results.length;
    appendUniqueResults(session, results);
    return null;
  } catch (error) {
    if (signal?.aborted) throw error;
    console.info('[web-search] SearXNG unavailable, trying Tavily', { error: errorMessage(error) });
  }

  if (!TAVILY_API_KEY) return 'Tool error: search service temporarily unavailable.';
  const quotaError = quota?.check();
  if (quotaError) return quotaError;
  try {
    const data = await fetchTavily(session, signal);
    quota?.consume();
    session.provider = 'tavily';
    session.nextPage = 2;
    session.exhausted = true;
    session.answer = data.answer;
    appendUniqueResults(session, data.results || []);
    return null;
  } catch (error) {
    if (signal?.aborted) throw error;
    console.error('[web-search] Tavily request failed', { error: errorMessage(error) });
    return 'Tool error: search service temporarily unavailable.';
  }
};

const loadMore = async (session: SearchSession, signal?: AbortSignal) => {
  if (!session.provider || session.provider === 'tavily' || session.nextPage > MAX_SEARCH_PAGE) {
    session.exhausted = true;
    return;
  }
  try {
    const results = session.provider === 'desktop'
      ? await fetchDesktopPage(session, session.nextPage, signal)
      : await fetchSearxngPage(session, session.nextPage, signal);
    session.nextPage += 1;
    if (!results.length) session.exhausted = true;
    appendUniqueResults(session, results);
  } catch (error) {
    if (signal?.aborted) throw error;
    console.error('[web-search] Search pagination failed', { provider: session.provider, error: errorMessage(error) });
    throw error;
  }
};

export const runWebSearch = async (query: string, options: WebSearchOptions, signal?: AbortSignal): Promise<string> => {
  const mode: SearchMode = options.wikipedia === true ? 'wikipedia' : 'web';
  const searchType: SearchType = options.searchType === 'news' ? 'news' : 'web';
  const sort: SearchSort = options.sort === 'date' ? 'date' : 'relevance';
  const freshness: SearchFreshness = ['day', 'week', 'month', 'year'].includes(`${options.freshness || ''}`)
    ? options.freshness as Exclude<SearchFreshness, 'any'>
    : 'any';
  if (mode === 'wikipedia' && (searchType !== 'web' || sort !== 'relevance' || freshness !== 'any')) {
    return 'Tool error: Wikipedia search cannot be combined with news, date sorting, or freshness filters.';
  }
  pruneSearchSessions();

  let searchId: string;
  let offset = 0;
  let session: SearchSession;
  if (options.cursor) {
    const cursor = parseSearchCursor(options.cursor);
    const existing = cursor ? searchSessions.get(cursor.searchId) : undefined;
    if (!cursor || !existing || existing.userId !== options.userId || existing.chatId !== options.chatId) {
      return 'Tool error: search cursor is invalid or expired. Start a new search without a cursor.';
    }
    if (existing.query !== query || existing.mode !== mode || existing.searchType !== searchType || existing.sort !== sort || existing.freshness !== freshness) {
      return 'Tool error: search cursor does not match this query or search options. Start a new search without a cursor.';
    }
    searchId = cursor.searchId;
    offset = cursor.offset;
    session = existing;
  } else {
    searchId = randomUUID();
    session = {
      userId: options.userId,
      chatId: options.chatId,
      query,
      mode,
      searchType,
      sort,
      freshness,
      language: mode === 'wikipedia' ? (`${options.language || 'en'}`.trim() || 'en') : 'all',
      provider: null,
      results: [],
      nextPage: 1,
      exhausted: false,
      createdAt: Date.now(),
    };
    searchSessions.set(searchId, session);
    const providerError = await initializeProvider(session, options.tavilyQuota, signal);
    if (providerError) {
      searchSessions.delete(searchId);
      return providerError;
    }
  }

  try {
    while (offset >= session.results.length && !session.exhausted) await loadMore(session, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return 'Tool error: search service temporarily unavailable.';
  }

  const visibleResults = session.results.slice(offset, offset + MAX_RESULTS);
  if (!visibleResults.length) return `No more results found for query "${query}". The search depth limit has been reached.`;
  const resultText = visibleResults.map((item, index) => {
    const engines = resultEngines(item, session.provider);
    const published = item.published_date || item.publishedDate;
    return `${offset + index + 1}. ${item.title || 'Untitled'}\n${item.content || ''}\nSource: ${item.url || '-'}${published ? `\nPublished: ${published}` : ''}\nSearch engines: ${engines.join(', ') || 'unknown'}`;
  }).join('\n\n');
  const summary = offset === 0 && session.answer ? `Summary: ${session.answer}\n\n` : '';
  const nextOffset = offset + visibleResults.length;
  const hasMore = nextOffset < session.results.length || !session.exhausted;
  const nextCursor = hasMore ? `${searchId}:${nextOffset}` : null;
  const pagination = nextCursor
    ? `Search pagination: showing cached results ${offset + 1}-${nextOffset} from ${session.provider}. To continue, repeat the same query and search options with cursor "${nextCursor}".`
    : `Search pagination: showing cached results ${offset + 1}-${nextOffset} from ${session.provider}. No more results are available.`;
  return `${wrapUntrustedContent(`${summary}${resultText}`)}\n\n${pagination}`;
};
