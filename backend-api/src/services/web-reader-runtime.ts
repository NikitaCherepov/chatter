import { db } from '../db.js';

export type WebReaderProvider = 'desktop' | 'browserless';
export type WebReaderStatOutcome = 'success' | 'failure' | 'empty';

export type WebReaderRuntimeSettings = {
  enabled: boolean;
  desktopEnabled: boolean;
  browserlessEnabled: boolean;
};

export type WebReaderStat = {
  provider: WebReaderProvider;
  attempts: number;
  successes: number;
  failures: number;
  emptyResponses: number;
  unavailableFailures: number;
  timeoutFailures: number;
  parsingFailures: number;
  httpFailures: number;
  otherFailures: number;
  cacheHits: number;
  charactersReturned: number;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastFailureReason: string | null;
};

const SETTINGS_KEY = 'web_reader_runtime_settings';
const DEFAULT_SETTINGS: WebReaderRuntimeSettings = {
  enabled: true,
  desktopEnabled: true,
  browserlessEnabled: true,
};

const normalizeSettings = (value: unknown): WebReaderRuntimeSettings => {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_SETTINGS.enabled,
    desktopEnabled: typeof source.desktopEnabled === 'boolean' ? source.desktopEnabled : DEFAULT_SETTINGS.desktopEnabled,
    browserlessEnabled: typeof source.browserlessEnabled === 'boolean'
      ? source.browserlessEnabled
      : DEFAULT_SETTINGS.browserlessEnabled,
  };
};

export const getWebReaderRuntimeSettings = (): WebReaderRuntimeSettings => {
  const row = db.prepare('SELECT value_json FROM system_settings WHERE key = ?').get(SETTINGS_KEY) as
    | { value_json: string }
    | undefined;
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    return normalizeSettings(JSON.parse(row.value_json));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
};

export const updateWebReaderRuntimeSettings = (patch: unknown): WebReaderRuntimeSettings => {
  const current = getWebReaderRuntimeSettings();
  const source = patch && typeof patch === 'object' ? patch as Record<string, unknown> : {};
  const next = normalizeSettings({
    enabled: typeof source.enabled === 'boolean' ? source.enabled : current.enabled,
    desktopEnabled: typeof source.desktopEnabled === 'boolean' ? source.desktopEnabled : current.desktopEnabled,
    browserlessEnabled: typeof source.browserlessEnabled === 'boolean'
      ? source.browserlessEnabled
      : current.browserlessEnabled,
  });
  db.prepare(`
    INSERT INTO system_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(SETTINGS_KEY, JSON.stringify(next), Date.now());
  return next;
};

const classifyFailure = (reason: string): 'unavailable' | 'timeout' | 'parsing' | 'http' | 'other' => {
  const normalized = reason.toLowerCase();
  if (normalized.includes('not_connected') || normalized.includes('connection_stale')
    || normalized.includes('unsupported') || normalized.includes('unavailable')
    || normalized.includes('token_missing')) return 'unavailable';
  if (normalized.includes('timeout') || normalized.includes('timed out')) return 'timeout';
  if (normalized.includes('parsing') || normalized.includes('graphql')
    || normalized.includes('unreadable')) return 'parsing';
  if (normalized.includes('http') || normalized.includes('fetch')) return 'http';
  return 'other';
};

const recordStatement = db.prepare(`
  INSERT INTO web_reader_stats (
    provider, attempts, successes, failures, empty_responses, unavailable_failures,
    timeout_failures, parsing_failures, http_failures, other_failures, characters_returned,
    last_attempt_at, last_success_at, last_failure_at, last_failure_reason
  ) VALUES (
    @provider, 1, @successes, @failures, @emptyResponses, @unavailableFailures,
    @timeoutFailures, @parsingFailures, @httpFailures, @otherFailures, @charactersReturned,
    @now, @lastSuccessAt, @lastFailureAt, @lastFailureReason
  )
  ON CONFLICT(provider) DO UPDATE SET
    attempts = attempts + 1,
    successes = successes + excluded.successes,
    failures = failures + excluded.failures,
    empty_responses = empty_responses + excluded.empty_responses,
    unavailable_failures = unavailable_failures + excluded.unavailable_failures,
    timeout_failures = timeout_failures + excluded.timeout_failures,
    parsing_failures = parsing_failures + excluded.parsing_failures,
    http_failures = http_failures + excluded.http_failures,
    other_failures = other_failures + excluded.other_failures,
    characters_returned = characters_returned + excluded.characters_returned,
    last_attempt_at = excluded.last_attempt_at,
    last_success_at = COALESCE(excluded.last_success_at, last_success_at),
    last_failure_at = COALESCE(excluded.last_failure_at, last_failure_at),
    last_failure_reason = COALESCE(excluded.last_failure_reason, last_failure_reason)
`);

export const recordWebReaderStat = (
  provider: WebReaderProvider,
  outcome: WebReaderStatOutcome,
  charactersReturned = 0,
  reason = '',
): void => {
  const now = Date.now();
  const failureType = outcome === 'failure' ? classifyFailure(reason) : null;
  recordStatement.run({
    provider,
    successes: outcome === 'success' ? 1 : 0,
    failures: outcome === 'failure' ? 1 : 0,
    emptyResponses: outcome === 'empty' ? 1 : 0,
    unavailableFailures: failureType === 'unavailable' ? 1 : 0,
    timeoutFailures: failureType === 'timeout' ? 1 : 0,
    parsingFailures: failureType === 'parsing' ? 1 : 0,
    httpFailures: failureType === 'http' ? 1 : 0,
    otherFailures: failureType === 'other' ? 1 : 0,
    charactersReturned: Math.max(0, Math.floor(charactersReturned)),
    now,
    lastSuccessAt: outcome === 'success' ? now : null,
    lastFailureAt: outcome === 'failure' ? now : null,
    lastFailureReason: outcome === 'failure' ? reason.slice(0, 500) : null,
  });
};

const cacheHitStatement = db.prepare(`
  INSERT INTO web_reader_stats (provider, cache_hits)
  VALUES (?, 1)
  ON CONFLICT(provider) DO UPDATE SET cache_hits = cache_hits + 1
`);

export const recordWebReaderCacheHit = (provider: WebReaderProvider): void => {
  cacheHitStatement.run(provider);
};

type WebReaderStatRow = Omit<WebReaderStat,
  'emptyResponses' | 'unavailableFailures' | 'timeoutFailures' | 'parsingFailures'
  | 'httpFailures' | 'otherFailures' | 'cacheHits' | 'charactersReturned' | 'lastAttemptAt'
  | 'lastSuccessAt' | 'lastFailureAt' | 'lastFailureReason'> & {
  empty_responses: number;
  unavailable_failures: number;
  timeout_failures: number;
  parsing_failures: number;
  http_failures: number;
  other_failures: number;
  cache_hits: number;
  characters_returned: number;
  last_attempt_at: number | null;
  last_success_at: number | null;
  last_failure_at: number | null;
  last_failure_reason: string | null;
};

export const getWebReaderStats = (): { providers: WebReaderStat[] } => {
  const rows = db.prepare(`
    SELECT * FROM web_reader_stats
    ORDER BY CASE provider WHEN 'desktop' THEN 1 ELSE 2 END
  `).all() as WebReaderStatRow[];
  return {
    providers: rows.map(row => ({
      provider: row.provider,
      attempts: row.attempts,
      successes: row.successes,
      failures: row.failures,
      emptyResponses: row.empty_responses,
      unavailableFailures: row.unavailable_failures,
      timeoutFailures: row.timeout_failures,
      parsingFailures: row.parsing_failures,
      httpFailures: row.http_failures,
      otherFailures: row.other_failures,
      cacheHits: row.cache_hits,
      charactersReturned: row.characters_returned,
      lastAttemptAt: row.last_attempt_at,
      lastSuccessAt: row.last_success_at,
      lastFailureAt: row.last_failure_at,
      lastFailureReason: row.last_failure_reason,
    })),
  };
};
