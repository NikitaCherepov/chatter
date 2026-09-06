import { db } from '../db.js';

export const WEB_SEARCH_ENGINES = ['google', 'brave', 'duckduckgo', 'startpage', 'wikipedia'] as const;
export type WebSearchEngine = typeof WEB_SEARCH_ENGINES[number];
export type WebSearchProvider = 'desktop' | 'searxng' | 'tavily';
export type WebSearchStatOutcome = 'success' | 'failure' | 'empty';

export type WebSearchRuntimeSettings = {
  enabled: boolean;
  searxngEnabled: boolean;
  engines: Record<WebSearchEngine, boolean>;
};

export type WebSearchStat = {
  provider: WebSearchProvider;
  engine: string;
  attempts: number;
  successes: number;
  failures: number;
  emptyResponses: number;
  captchaFailures: number;
  rateLimitFailures: number;
  parsingFailures: number;
  httpFailures: number;
  otherFailures: number;
  resultsReturned: number;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastFailureReason: string | null;
};

const SETTINGS_KEY = 'web_search_runtime_settings';
const DEFAULT_SETTINGS: WebSearchRuntimeSettings = {
  enabled: true,
  searxngEnabled: true,
  engines: {
    google: true,
    brave: true,
    duckduckgo: true,
    startpage: true,
    wikipedia: true,
  },
};

const readStoredSettings = (): unknown => {
  const row = db.prepare('SELECT value_json FROM system_settings WHERE key = ?').get(SETTINGS_KEY) as
    | { value_json: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return null;
  }
};

const normalizeSettings = (value: unknown): WebSearchRuntimeSettings => {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const rawEngines = source.engines && typeof source.engines === 'object'
    ? source.engines as Record<string, unknown>
    : {};
  const engines = { ...DEFAULT_SETTINGS.engines };
  for (const engine of WEB_SEARCH_ENGINES) {
    if (typeof rawEngines[engine] === 'boolean') engines[engine] = rawEngines[engine];
  }
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_SETTINGS.enabled,
    searxngEnabled: typeof source.searxngEnabled === 'boolean'
      ? source.searxngEnabled
      : DEFAULT_SETTINGS.searxngEnabled,
    engines,
  };
};

export const getWebSearchRuntimeSettings = (): WebSearchRuntimeSettings => normalizeSettings(readStoredSettings());

export const updateWebSearchRuntimeSettings = (patch: unknown): WebSearchRuntimeSettings => {
  const current = getWebSearchRuntimeSettings();
  const source = patch && typeof patch === 'object' ? patch as Record<string, unknown> : {};
  const next: WebSearchRuntimeSettings = {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : current.enabled,
    searxngEnabled: typeof source.searxngEnabled === 'boolean' ? source.searxngEnabled : current.searxngEnabled,
    engines: { ...current.engines },
  };
  if (source.engines && typeof source.engines === 'object') {
    const enginePatch = source.engines as Record<string, unknown>;
    for (const engine of WEB_SEARCH_ENGINES) {
      if (typeof enginePatch[engine] === 'boolean') next.engines[engine] = enginePatch[engine];
    }
  }
  db.prepare(`
    INSERT INTO system_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(SETTINGS_KEY, JSON.stringify(next), Date.now());
  return next;
};

const classifyFailure = (reason: string) => {
  const normalized = reason.toLowerCase();
  if (normalized.includes('captcha')) return 'captcha';
  if (normalized.includes('too many requests') || normalized.includes('rate limit') || normalized.includes('http 429')) return 'rate_limit';
  if (normalized.includes('parsing')) return 'parsing';
  if (normalized.includes('http')) return 'http';
  return 'other';
};

const recordStatement = db.prepare(`
  INSERT INTO web_search_stats (
    provider, engine, attempts, successes, failures, empty_responses,
    captcha_failures, rate_limit_failures, parsing_failures, http_failures, other_failures,
    results_returned, last_attempt_at, last_success_at, last_failure_at, last_failure_reason
  ) VALUES (
    @provider, @engine, 1, @successes, @failures, @emptyResponses,
    @captchaFailures, @rateLimitFailures, @parsingFailures, @httpFailures, @otherFailures,
    @resultsReturned, @now, @lastSuccessAt, @lastFailureAt, @lastFailureReason
  )
  ON CONFLICT(provider, engine) DO UPDATE SET
    attempts = attempts + 1,
    successes = successes + excluded.successes,
    failures = failures + excluded.failures,
    empty_responses = empty_responses + excluded.empty_responses,
    captcha_failures = captcha_failures + excluded.captcha_failures,
    rate_limit_failures = rate_limit_failures + excluded.rate_limit_failures,
    parsing_failures = parsing_failures + excluded.parsing_failures,
    http_failures = http_failures + excluded.http_failures,
    other_failures = other_failures + excluded.other_failures,
    results_returned = results_returned + excluded.results_returned,
    last_attempt_at = excluded.last_attempt_at,
    last_success_at = COALESCE(excluded.last_success_at, last_success_at),
    last_failure_at = COALESCE(excluded.last_failure_at, last_failure_at),
    last_failure_reason = COALESCE(excluded.last_failure_reason, last_failure_reason)
`);

export const recordWebSearchStat = (
  provider: WebSearchProvider,
  engine: string,
  outcome: WebSearchStatOutcome,
  resultsReturned = 0,
  reason = '',
) => {
  const now = Date.now();
  const failureType = outcome === 'failure' ? classifyFailure(reason) : null;
  recordStatement.run({
    provider,
    engine,
    successes: outcome === 'success' ? 1 : 0,
    failures: outcome === 'failure' ? 1 : 0,
    emptyResponses: outcome === 'empty' ? 1 : 0,
    captchaFailures: failureType === 'captcha' ? 1 : 0,
    rateLimitFailures: failureType === 'rate_limit' ? 1 : 0,
    parsingFailures: failureType === 'parsing' ? 1 : 0,
    httpFailures: failureType === 'http' ? 1 : 0,
    otherFailures: failureType === 'other' ? 1 : 0,
    resultsReturned: Math.max(0, Math.floor(resultsReturned)),
    now,
    lastSuccessAt: outcome === 'success' ? now : null,
    lastFailureAt: outcome === 'failure' ? now : null,
    lastFailureReason: outcome === 'failure' ? reason.slice(0, 500) : null,
  });
};

type WebSearchStatRow = {
  provider: WebSearchProvider;
  engine: string;
  attempts: number;
  successes: number;
  failures: number;
  empty_responses: number;
  captcha_failures: number;
  rate_limit_failures: number;
  parsing_failures: number;
  http_failures: number;
  other_failures: number;
  results_returned: number;
  last_attempt_at: number | null;
  last_success_at: number | null;
  last_failure_at: number | null;
  last_failure_reason: string | null;
};

export const getWebSearchStats = (): { providers: WebSearchStat[]; engines: WebSearchStat[] } => {
  const rows = db.prepare(`
    SELECT * FROM web_search_stats
    ORDER BY CASE provider WHEN 'desktop' THEN 1 WHEN 'searxng' THEN 2 ELSE 3 END, engine
  `).all() as WebSearchStatRow[];
  const mapped = rows.map(row => ({
    provider: row.provider,
    engine: row.engine,
    attempts: row.attempts,
    successes: row.successes,
    failures: row.failures,
    emptyResponses: row.empty_responses,
    captchaFailures: row.captcha_failures,
    rateLimitFailures: row.rate_limit_failures,
    parsingFailures: row.parsing_failures,
    httpFailures: row.http_failures,
    otherFailures: row.other_failures,
    resultsReturned: row.results_returned,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    lastFailureReason: row.last_failure_reason,
  }));
  return {
    providers: mapped.filter(row => row.engine === ''),
    engines: mapped.filter(row => row.provider === 'searxng' && row.engine !== ''),
  };
};
