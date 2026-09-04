import { wrapUntrustedContent } from './web-reader.js';

const SEARXNG_BASE_URL = `${process.env.SEARXNG_BASE_URL || 'http://searxng:8080'}`.trim().replace(/\/+$/, '');
const TAVILY_API_KEY = `${process.env.TAVILY_API_KEY || ''}`.trim();
const TAVILY_API_BASE_URL = `${process.env.TAVILY_API_BASE_URL || 'https://api.tavily.com'}`.trim().replace(/\/+$/, '');
const SEARCH_TIMEOUT_MS = 15_000;
const MAX_RESULTS = 5;
const MAX_SEARCH_PAGE = 10;

type WebSearchOptions = {
  cursor?: string;
  wikipedia?: boolean;
  language?: string | null;
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

const parseSearchCursor = (cursor: string | undefined): { page: number; offset: number } | null => {
  if (!cursor) return { page: 1, offset: 0 };
  const match = /^(\d+):(\d+)$/.exec(cursor.trim());
  if (!match) return null;
  const page = Number(match[1]);
  const offset = Number(match[2]);
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_SEARCH_PAGE) return null;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % MAX_RESULTS !== 0) return null;
  return { page, offset };
};

const runSearxngWebSearch = async (query: string, options: WebSearchOptions = {}, signal?: AbortSignal): Promise<string> => {
  const cursor = parseSearchCursor(options.cursor);
  if (!cursor) return 'Tool error: invalid search cursor.';

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('searxng_timeout')), SEARCH_TIMEOUT_MS);

  try {
    const url = new URL(`${SEARXNG_BASE_URL}/search`);
    const wikipediaOnly = options.wikipedia === true;
    url.searchParams.set('q', wikipediaOnly ? `!wikipedia ${query}` : query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('categories', 'general');
    url.searchParams.set('language', wikipediaOnly ? (`${options.language || 'en'}`.trim() || 'en') : 'all');
    url.searchParams.set('pageno', `${cursor.page}`);

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
      page: cursor.page,
      offset: cursor.offset,
      wikipediaOnly,
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

    if (!results.length) return `No results found for query "${query}" on search page ${cursor.page}.`;

    const visibleResults = results.slice(cursor.offset, cursor.offset + MAX_RESULTS);
    if (!visibleResults.length) {
      const nextCursor = cursor.page < MAX_SEARCH_PAGE ? `${cursor.page + 1}:0` : null;
      return `No more results on search page ${cursor.page}. ${nextCursor ? `Continue with cursor "${nextCursor}".` : 'The search depth limit has been reached.'}`;
    }

    const resultText = visibleResults.map((item, index) => {
      const engines = getResultEngines(item);
      return `${cursor.offset + index + 1}. ${item.title || 'Untitled'}\n${item.content || ''}\nSource: ${item.url || '-'}\nSearch engines: ${engines.join(', ') || 'unknown'}`;
    }).join('\n\n');
    const nextOffset = cursor.offset + visibleResults.length;
    const nextCursor = nextOffset < results.length
      ? `${cursor.page}:${nextOffset}`
      : (cursor.page < MAX_SEARCH_PAGE ? `${cursor.page + 1}:0` : null);
    const pagination = nextCursor
      ? `Search pagination: showing ${cursor.offset + 1}-${nextOffset} of ${results.length} results on search page ${cursor.page}. To continue, repeat the same query and wikipedia value with cursor "${nextCursor}".`
      : `Search pagination: showing ${cursor.offset + 1}-${nextOffset} of ${results.length} results on search page ${cursor.page}. The search depth limit has been reached.`;
    return `${wrapUntrustedContent(resultText)}\n\n${pagination}`;
  } catch (error) {
    if (signal?.aborted) throw error;
    console.error('[web-search] SearXNG request failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 'Tool error: search service temporarily unavailable.';
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', forwardAbort);
  }
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
