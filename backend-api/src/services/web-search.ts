import { wrapUntrustedContent } from './web-reader.js';
import { randomUUID } from 'node:crypto';

const SEARXNG_BASE_URL = `${process.env.SEARXNG_BASE_URL || 'http://searxng:8080'}`.trim().replace(/\/+$/, '');
const TAVILY_API_KEY = `${process.env.TAVILY_API_KEY || ''}`.trim();
const TAVILY_API_BASE_URL = `${process.env.TAVILY_API_BASE_URL || 'https://api.tavily.com'}`.trim().replace(/\/+$/, '');
const SEARCH_TIMEOUT_MS = 15_000;
const MAX_RESULTS = 5;
const MAX_SEARCH_PAGE = 10;
const SEARCH_SESSION_TTL_MS = 10 * 60_000;
const MAX_SEARCH_SESSIONS = 200;

type WebSearchOptions = {
  userId: number;
  cursor?: string;
  wikipedia?: boolean;
  github?: boolean;
  language?: string | null;
};

type SearchMode = 'web' | 'wikipedia' | 'github';

type SearchSession = {
  userId: number;
  query: string;
  mode: SearchMode;
  language: string;
  results: SearxngResult[];
  nextSearxngPage: number;
  exhausted: boolean;
  createdAt: number;
};

type SearxngResult = {
  title?: string;
  content?: string;
  url?: string;
  engine?: string;
  engines?: string[];
  positions?: number[];
  score?: number;
};

type SearxngResponse = {
  answers?: unknown[];
  results?: SearxngResult[];
  unresponsive_engines?: unknown[];
};

const engineNameFromFailure = (failure: unknown): string => {
  if (Array.isArray(failure)) return `${failure[0] || ''}`.trim();
  if (failure && typeof failure === 'object' && 'engine' in failure) {
    return `${(failure as { engine?: unknown }).engine || ''}`.trim();
  }
  return `${failure || ''}`.trim();
};

const engineFailureReason = (failure: unknown): string => {
  if (Array.isArray(failure)) return `${failure[1] || ''}`.trim();
  if (failure && typeof failure === 'object' && 'error' in failure) {
    return `${(failure as { error?: unknown }).error || ''}`.trim();
  }
  return '';
};

const getResultEngines = (result: SearxngResult): string[] => (
  Array.isArray(result.engines) && result.engines.length
    ? result.engines
    : [result.engine || '']
).map(engine => `${engine}`.trim()).filter(Boolean);

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
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  return { searchId: match[1], offset };
};

const fetchSearxngPage = async (session: SearchSession, page: number, signal?: AbortSignal): Promise<SearxngResult[]> => {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('searxng_timeout')), SEARCH_TIMEOUT_MS);

  try {
    const url = new URL(`${SEARXNG_BASE_URL}/search`);
    const scopedQuery =
      session.mode === 'wikipedia'
        ? `!wikipedia ${session.query}`
        : session.mode === 'github'
          ? `!ghc ${session.query}`
          : session.query;
    url.searchParams.set('q', scopedQuery);
    url.searchParams.set('format', 'json');
    url.searchParams.set('categories', 'general');
    url.searchParams.set('language', session.language);
    url.searchParams.set('pageno', `${page}`);

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-Client-Source': 'chatter-backend',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`searxng_http_${response.status}`);

    const data = await response.json() as SearxngResponse;
    const results = Array.isArray(data.results) ? data.results : [];
    const returnedEngines = [...new Set(results.flatMap(getResultEngines))].sort();
    const failedEngines = (Array.isArray(data.unresponsive_engines) ? data.unresponsive_engines : [])
      .map(failure => ({
        engine: engineNameFromFailure(failure),
        reason: engineFailureReason(failure),
      }))
      .filter(failure => failure.engine);

    const engineReport = {
      page,
      searchMode: session.mode,
      returned: returnedEngines,
      failed: failedEngines,
      resultCount: results.length,
      results: results.map((result, index) => ({
        rank: index + 1,
        title: result.title || '',
        engines: getResultEngines(result),
        positions: result.positions || [],
        score: result.score ?? null,
        url: result.url || '',
      })),
    };
    console.info('[web-search] SearXNG engine report', JSON.stringify(engineReport, null, 2));
    return results;
  } catch (error) {
    if (signal?.aborted) throw error;
    console.error('[web-search] SearXNG request failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', forwardAbort);
  }
};

const runSearxngWebSearch = async (query: string, options: WebSearchOptions, signal?: AbortSignal): Promise<string> => {
  if (options.wikipedia === true && options.github === true) {
    return 'Tool error: wikipedia and github search modes cannot be enabled together.';
  }

  const mode: SearchMode = options.github === true ? 'github' : options.wikipedia === true ? 'wikipedia' : 'web';
  pruneSearchSessions();

  let searchId: string;
  let offset = 0;
  let session: SearchSession;

  if (options.cursor) {
    const cursor = parseSearchCursor(options.cursor);
    const existing = cursor ? searchSessions.get(cursor.searchId) : undefined;
    if (!cursor || !existing || existing.userId !== options.userId) {
      return 'Tool error: search cursor is invalid or expired. Start a new search without a cursor.';
    }
    if (existing.query !== query || existing.mode !== mode) {
      return 'Tool error: search cursor does not match this query or search mode. Start a new search without a cursor.';
    }
    searchId = cursor.searchId;
    offset = cursor.offset;
    session = existing;
  } else {
    searchId = randomUUID();
    session = {
      userId: options.userId,
      query,
      mode,
      language: mode === 'wikipedia' ? (`${options.language || 'en'}`.trim() || 'en') : 'all',
      results: [],
      nextSearxngPage: 1,
      exhausted: false,
      createdAt: Date.now(),
    };
    searchSessions.set(searchId, session);
  }

  try {
    while (offset >= session.results.length && !session.exhausted) {
      if (session.nextSearxngPage > MAX_SEARCH_PAGE) {
        session.exhausted = true;
        break;
      }
      const pageResults = await fetchSearxngPage(session, session.nextSearxngPage, signal);
      session.nextSearxngPage += 1;
      if (!pageResults.length) {
        session.exhausted = true;
        break;
      }
      const knownUrls = new Set(session.results.map(result => result.url).filter(Boolean));
      const uniqueResults = pageResults.filter(result => {
        if (!result.url) return true;
        if (knownUrls.has(result.url)) return false;
        knownUrls.add(result.url);
        return true;
      });
      session.results.push(...uniqueResults);
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    return 'Tool error: search service temporarily unavailable.';
  }

  const visibleResults = session.results.slice(offset, offset + MAX_RESULTS);
  if (!visibleResults.length) {
    return `No more results found for query "${query}". The search depth limit has been reached.`;
  }

  const resultText = visibleResults.map((item, index) => {
    const engines = getResultEngines(item);
    return `${offset + index + 1}. ${item.title || 'Untitled'}\n${item.content || ''}\nSource: ${item.url || '-'}\nSearch engines: ${engines.join(', ') || 'unknown'}`;
  }).join('\n\n');
  const nextOffset = offset + visibleResults.length;
  const hasMore = nextOffset < session.results.length || !session.exhausted;
  const nextCursor = hasMore ? `${searchId}:${nextOffset}` : null;
  const pagination = nextCursor
    ? `Search pagination: showing cached results ${offset + 1}-${nextOffset}. To continue, repeat the same query and search mode (wikipedia/github) with cursor "${nextCursor}".`
    : `Search pagination: showing cached results ${offset + 1}-${nextOffset}. No more results are available.`;
  return `${wrapUntrustedContent(resultText)}\n\n${pagination}`;
};
// Kept as an inactive fallback while SearXNG is tested in production.
export const runTavilyWebSearch = async (query: string, signal?: AbortSignal): Promise<string> => {
  if (!TAVILY_API_KEY) return 'Tool error: search service temporarily unavailable.';

  try {
    const response = await fetch(`${TAVILY_API_BASE_URL}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TAVILY_API_KEY}`,
        'X-Client-Source': 'chatter-backend',
      },
      body: JSON.stringify({
        query,
        search_depth: 'basic',
        max_results: 3,
        include_answer: true,
      }),
      signal,
    });
    if (!response.ok) throw new Error(`tavily_http_${response.status}`);

    const data = await response.json() as {
      answer?: string;
      results?: Array<{ title?: string; content?: string; url?: string }>;
    };
    const results = Array.isArray(data.results) ? data.results : [];
    if (!results.length) return `No results found for query "${query}".`;

    let resultText = data.answer ? `Summary: ${data.answer}\n\n` : '';
    resultText += results.map((item, index) => (
      `${index + 1}. ${item.title || 'Untitled'}\n${item.content || ''}\nSource: ${item.url || '-'}`
    )).join('\n\n');
    return wrapUntrustedContent(resultText);
  } catch (error) {
    if (signal?.aborted) throw error;
    console.error('[web-search] Tavily request failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 'Tool error: search service temporarily unavailable.';
  }
};

// The public tool uses only SearXNG during the current test phase.
export const runWebSearch = runSearxngWebSearch;
