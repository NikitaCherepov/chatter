// ── OpenRouter provider monitor ─────────────────────────────────────────────
// Periodically verifies that the OpenRouter provider pinned in
// model_overrides.openrouter_provider_slug still serves the model, notifies
// admins via Telegram when it disappears and (optionally) auto-switches to a
// replacement endpoint of the same model.
//
// Import graph is intentionally kept light (db / token-quota / telegram-send /
// accounts only). ai.ts registers a models provider at startup, which keeps
// this module testable in isolation.

import { db, getNowUnix } from '../db.js';
import { getModelOverride, setModelProvider } from './token-quota.js';
import { sendTelegramMessage } from './telegram-send.js';
import { getTelegramIdentityForAccount } from './accounts.js';
import { translateForLanguage } from '../i18n/index.js';

const OPENROUTER_BASE_URL = `${process.env.OPENROUTER_MONITOR_BASE_URL || 'https://openrouter.ai/api/v1'}`.replace(/\/$/, '');
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.OPENROUTER_MONITOR_TIMEOUT_MS || '12000', 10);
/** Successful catalog responses (HTTP 200) with the provider missing that are
 *  required before auto-switching. Protects against flaky catalog data. */
const MISSING_THRESHOLD = 2;
/** Fraction of the interval used as random jitter (0..JITTER_FRACTION × interval). */
const JITTER_FRACTION = 0.1;

export type MonitorAction = 'notify' | 'cheapest' | 'throughput' | 'latency';
export type PriceTrackingMode = 'off' | 'notify' | 'update';
export type MonitorStatus = 'unknown' | 'available' | 'missing' | 'check_failed' | 'model_missing';

export type MonitorSettings = {
  enabled: boolean;
  intervalMinutes: number;
  action: MonitorAction;
  recipientsMode: 'all_admins' | 'selected';
  recipientUserIds: number[];
  priceTracking: PriceTrackingMode;
  priceThresholdPct: number;
};

export type MonitoredModel = {
  uniqueId: string;
  route: string;
  modelSlug: string;
};

export type MonitorState = {
  model_id: string;
  route: string | null;
  model_slug: string | null;
  provider_slug: string | null;
  status: MonitorStatus;
  last_ok_at: number | null;
  last_check_at: number | null;
  consecutive_missing: number;
  unavailable_since: number | null;
  last_notified_at: number | null;
  last_notified_key: string | null;
  previous_provider_slug: string | null;
  replacement_provider_slug: string | null;
  last_error: string | null;
  last_seen_prices: string | null;
};

export type OpenRouterEndpoint = {
  tag?: string;
  name?: string;
  provider_name?: string;
  status?: string;
  supported_parameters?: string[];
  zdr?: boolean;
  pricing?: Record<string, unknown>;
  throughput_last_30m?: { p50?: number } | null;
  latency_last_30m?: { p50?: number } | null;
  uptime_last_30m?: number | null;
};

export type SelectionRequirements = {
  tools?: boolean;
  zdr?: boolean;
  caching?: boolean;
};

// ── Settings persistence ────────────────────────────────────────────────────

const DEFAULT_SETTINGS: MonitorSettings = {
  enabled: false,
  intervalMinutes: 60,
  action: 'notify',
  recipientsMode: 'all_admins',
  recipientUserIds: [],
  priceTracking: 'notify',
  priceThresholdPct: 5,
};

const PRICE_TRACKING_MODES = ['off', 'notify', 'update'] as const;

const parseRecipientIds = (raw: unknown): number[] => {
  let list: unknown[];
  if (typeof raw === 'string') { try { list = JSON.parse(raw || '[]'); } catch { list = []; } }
  else if (Array.isArray(raw)) list = raw;
  else list = [];
  return list
    .map(v => Number(v))
    .filter(v => Number.isInteger(v) && v > 0);
};

export const getMonitorSettings = (): MonitorSettings => {
  const row = db.prepare('SELECT * FROM openrouter_monitor_settings WHERE id = 1').get() as
    | { enabled: number; interval_minutes: number; action: string; recipients_mode: string; recipient_user_ids: string;
        price_tracking?: string; price_threshold_pct?: number }
    | undefined;
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    enabled: row.enabled === 1,
    intervalMinutes: Number.isFinite(row.interval_minutes) && row.interval_minutes >= 5 ? row.interval_minutes : DEFAULT_SETTINGS.intervalMinutes,
    action: (['notify', 'cheapest', 'throughput', 'latency'] as const).includes(row.action as MonitorAction)
      ? (row.action as MonitorAction) : DEFAULT_SETTINGS.action,
    recipientsMode: row.recipients_mode === 'selected' ? 'selected' : 'all_admins',
    recipientUserIds: parseRecipientIds(row.recipient_user_ids),
    priceTracking: PRICE_TRACKING_MODES.includes(row.price_tracking as PriceTrackingMode)
      ? (row.price_tracking as PriceTrackingMode) : DEFAULT_SETTINGS.priceTracking,
    priceThresholdPct: Number.isFinite(row.price_threshold_pct) && (row.price_threshold_pct ?? 0) > 0
      ? row.price_threshold_pct! : DEFAULT_SETTINGS.priceThresholdPct,
  };
};

export const saveMonitorSettings = (patch: Partial<MonitorSettings>): MonitorSettings => {
  const current = getMonitorSettings();
  const next: MonitorSettings = {
    enabled: patch.enabled ?? current.enabled,
    intervalMinutes: Number.isFinite(patch.intervalMinutes) && (patch.intervalMinutes ?? 0) >= 5
      ? Math.floor(patch.intervalMinutes!) : current.intervalMinutes,
    action: patch.action && (['notify', 'cheapest', 'throughput', 'latency'] as const).includes(patch.action)
      ? patch.action : current.action,
    recipientsMode: patch.recipientsMode === 'selected' || patch.recipientsMode === 'all_admins'
      ? patch.recipientsMode : current.recipientsMode,
    recipientUserIds: patch.recipientUserIds !== undefined ? parseRecipientIds(patch.recipientUserIds) : current.recipientUserIds,
    priceTracking: patch.priceTracking && PRICE_TRACKING_MODES.includes(patch.priceTracking)
      ? patch.priceTracking : current.priceTracking,
    priceThresholdPct: patch.priceThresholdPct !== undefined && Number.isFinite(patch.priceThresholdPct) && patch.priceThresholdPct > 0
      ? Math.min(100, patch.priceThresholdPct) : current.priceThresholdPct,
  };
  db.prepare(`
    INSERT INTO openrouter_monitor_settings
      (id, enabled, interval_minutes, action, recipients_mode, recipient_user_ids, price_tracking, price_threshold_pct, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      enabled = excluded.enabled,
      interval_minutes = excluded.interval_minutes,
      action = excluded.action,
      recipients_mode = excluded.recipients_mode,
      recipient_user_ids = excluded.recipient_user_ids,
      price_tracking = excluded.price_tracking,
      price_threshold_pct = excluded.price_threshold_pct,
      updated_at = excluded.updated_at
  `).run(
    next.enabled ? 1 : 0,
    next.intervalMinutes,
    next.action,
    next.recipientsMode,
    JSON.stringify(next.recipientUserIds),
    next.priceTracking,
    next.priceThresholdPct,
    getNowUnix(),
  );
  return next;
};

// ── State persistence ───────────────────────────────────────────────────────

const readState = (modelId: string): MonitorState | null =>
  db.prepare('SELECT * FROM openrouter_monitor_state WHERE model_id = ?').get(modelId) as MonitorState | undefined ?? null;

const writeState = (state: MonitorState): void => {
  db.prepare(`
    INSERT INTO openrouter_monitor_state (
      model_id, route, model_slug, provider_slug, status,
      last_ok_at, last_check_at, consecutive_missing, unavailable_since,
      last_notified_at, last_notified_key, previous_provider_slug,
      replacement_provider_slug, last_error, last_seen_prices
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(model_id) DO UPDATE SET
      route = excluded.route,
      model_slug = excluded.model_slug,
      provider_slug = excluded.provider_slug,
      status = excluded.status,
      last_ok_at = excluded.last_ok_at,
      last_check_at = excluded.last_check_at,
      consecutive_missing = excluded.consecutive_missing,
      unavailable_since = excluded.unavailable_since,
      last_notified_at = excluded.last_notified_at,
      last_notified_key = excluded.last_notified_key,
      previous_provider_slug = excluded.previous_provider_slug,
      replacement_provider_slug = excluded.replacement_provider_slug,
      last_error = excluded.last_error,
      last_seen_prices = excluded.last_seen_prices
  `).run(
    state.model_id, state.route, state.model_slug, state.provider_slug, state.status,
    state.last_ok_at, state.last_check_at, state.consecutive_missing, state.unavailable_since,
    state.last_notified_at, state.last_notified_key, state.previous_provider_slug,
    state.replacement_provider_slug, state.last_error, state.last_seen_prices,
  );
};

const upsertState = (modelId: string, patch: Partial<MonitorState>): MonitorState => {
  const existing = readState(modelId);
  const base: MonitorState = existing ?? {
    model_id: modelId, route: null, model_slug: null, provider_slug: null,
    status: 'unknown', last_ok_at: null, last_check_at: null, consecutive_missing: 0,
    unavailable_since: null, last_notified_at: null, last_notified_key: null,
    previous_provider_slug: null, replacement_provider_slug: null, last_error: null,
    last_seen_prices: null,
  };
  const next = { ...base, ...patch, model_id: modelId } as MonitorState;
  writeState(next);
  return next;
};

export const getMonitorStates = (): MonitorState[] =>
  db.prepare('SELECT * FROM openrouter_monitor_state').all() as MonitorState[];

// ── Monitored models provider (registered by ai.ts) ─────────────────────────

type ModelsProvider = () => MonitoredModel[];
let modelsProvider: ModelsProvider = () => [];

export const registerMonitoredModelsProvider = (provider: ModelsProvider): void => {
  modelsProvider = provider;
};

/** Injectable fetch for tests. */
export const setMonitorFetchForTests = (
  fn: ((modelSlug: string) => Promise<EndpointFetchResult>) | null,
): void => {
  endpointFetch = fn ?? defaultEndpointFetch;
};

type EndpointFetchResult = { status: number; endpoints: OpenRouterEndpoint[] | null };
const defaultEndpointFetch = async (modelSlug: string): Promise<EndpointFetchResult> => {
  const response = await fetch(`${OPENROUTER_BASE_URL}/models/${modelSlug}/endpoints`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // 404 = model removed from the catalog entirely (successful, definitive answer).
  if (response.status === 404) return { status: 404, endpoints: [] };
  if (!response.ok) throw Object.assign(new Error(`openrouter_http_${response.status}`), { httpStatus: response.status });
  const data = await response.json() as { data?: { endpoints?: OpenRouterEndpoint[] } };
  return { status: 200, endpoints: data?.data?.endpoints ?? [] };
};
let endpointFetch: (modelSlug: string) => Promise<EndpointFetchResult> = defaultEndpointFetch;

// ── Provider matching / grouping (mirrors ModelListEditor logic) ────────────

/**
 * A stored base slug (e.g. `google-vertex`) matches any regional variant
 * (`google-vertex/us-east5`). A stored variant slug (contains `/`) must match
 * the exact tag.
 */
export const matchesProviderSlug = (endpointTag: string, selectedSlug: string): boolean => {
  if (!endpointTag || !selectedSlug) return false;
  if (selectedSlug.includes('/')) return endpointTag === selectedSlug;
  return endpointTag === selectedSlug || endpointTag.startsWith(`${selectedSlug}/`);
};

const baseSlugOf = (tag: string): string => tag.split('/')[0] || tag;

// ── Price calculation (same rounding as the admin panel) ────────────────────

const pricePerTokenToPerMillion = (raw: unknown): number | null => {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.round(raw * 1_000_000 * 1e6) / 1e6;
  }
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
    return Math.round(Number(raw) * 1_000_000 * 1e6) / 1e6;
  }
  return null;
};

export type EndpointPrices = {
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  cacheReadPricePerMillion: number | null;
};

export const pricingToPrices = (pricing: Record<string, unknown> | undefined): EndpointPrices | null => {
  if (!pricing) return null;
  const input = pricePerTokenToPerMillion(pricing.prompt);
  const output = pricePerTokenToPerMillion(pricing.completion);
  const cache = pricePerTokenToPerMillion(pricing.input_cache_read);
  if (input === null && output === null && cache === null) return null;
  return { inputPricePerMillion: input, outputPricePerMillion: output, cacheReadPricePerMillion: cache };
};

// ── Replacement selection ───────────────────────────────────────────────────

type CandidateGroup = {
  baseSlug: string;
  prices: EndpointPrices | null;        // max across regional endpoints (as the UI shows)
  throughputP50: number | null;         // max across endpoints
  latencyP50: number | null;            // min across endpoints
  uptime: number | null;                // max across endpoints
  endpointCount: number;
};

const isEndpointUsable = (ep: OpenRouterEndpoint, requirements?: SelectionRequirements): boolean => {
  // Inactive endpoints are excluded. OpenRouter uses "active"/"inactive";
  // missing field is treated as active.
  if (ep.status && ep.status.toLowerCase() !== 'active') return false;
  const supported = new Set(ep.supported_parameters || []);
  if (requirements?.tools && !supported.has('tools')) return false;
  if (requirements?.caching && !supported.has('cache_control')) return false;
  if (requirements?.zdr && ep.zdr !== true && !supported.has('zero_data_retention')) return false;
  return true;
};

const buildCandidateGroups = (endpoints: OpenRouterEndpoint[], requirements?: SelectionRequirements): CandidateGroup[] => {
  const groups = new Map<string, OpenRouterEndpoint[]>();
  for (const ep of endpoints) {
    const tag = ep.tag || '';
    if (!tag) continue;
    if (!isEndpointUsable(ep, requirements)) continue;
    const base = baseSlugOf(tag);
    const list = groups.get(base) || [];
    list.push(ep);
    groups.set(base, list);
  }
  const result: CandidateGroup[] = [];
  for (const [base, eps] of groups) {
    const priceList = eps.map(e => pricingToPrices(e.pricing)).filter((p): p is EndpointPrices => p !== null);
    // Group price = max across regional variants (conservative, same as UI).
    let prices: EndpointPrices | null = null;
    if (priceList.length) {
      prices = {
        inputPricePerMillion: Math.max(...priceList.map(p => p.inputPricePerMillion ?? -Infinity)) === -Infinity ? null : Math.max(...priceList.map(p => p.inputPricePerMillion ?? -Infinity)),
        outputPricePerMillion: Math.max(...priceList.map(p => p.outputPricePerMillion ?? -Infinity)) === -Infinity ? null : Math.max(...priceList.map(p => p.outputPricePerMillion ?? -Infinity)),
        cacheReadPricePerMillion: Math.max(...priceList.map(p => p.cacheReadPricePerMillion ?? -Infinity)) === -Infinity ? null : Math.max(...priceList.map(p => p.cacheReadPricePerMillion ?? -Infinity)),
      };
    }
    const throughputs = eps.map(e => e.throughput_last_30m?.p50).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const latencies = eps.map(e => e.latency_last_30m?.p50).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const uptimes = eps.map(e => e.uptime_last_30m).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    result.push({
      baseSlug: base,
      prices,
      throughputP50: throughputs.length ? Math.max(...throughputs) : null,
      latencyP50: latencies.length ? Math.min(...latencies) : null,
      uptime: uptimes.length ? Math.max(...uptimes) : null,
      endpointCount: eps.length,
    });
  }
  return result;
};

const uptimeOf = (g: CandidateGroup): number => (g.uptime ?? -1);
const betterTiebreak = (a: CandidateGroup, b: CandidateGroup): number => uptimeOf(b) - uptimeOf(a);

export const selectReplacement = (
  endpoints: OpenRouterEndpoint[],
  strategy: MonitorAction,
  requirements?: SelectionRequirements,
  excludeSlug?: string | null,
): CandidateGroup | null => {
  const candidates = buildCandidateGroups(endpoints, requirements)
    .filter(g => !excludeSlug || g.baseSlug !== excludeSlug);
  if (!candidates.length) return null;

  if (strategy === 'notify') return null;

  const priceKey = (x: CandidateGroup) => x.prices?.inputPricePerMillion ?? x.prices?.outputPricePerMillion ?? Infinity;
  const score = (g: CandidateGroup): number => {
    if (strategy === 'cheapest') return priceKey(g);
    if (strategy === 'throughput') return g.throughputP50 ?? -1;
    return g.latencyP50 ?? Infinity;
  };

  let best: CandidateGroup = candidates[0];
  let bestScore = score(best);
  for (const g of candidates.slice(1)) {
    const s = score(g);
    const improves = strategy === 'latency' || strategy === 'cheapest' ? s < bestScore : s > bestScore;
    if (improves || (s === bestScore && betterTiebreak(g, best) < 0)) {
      best = g;
      bestScore = s;
    }
  }
  return best;
};

// ── Telegram notifications ──────────────────────────────────────────────────

/** Human-readable provider names from /providers (cached, same TTL as panel). */
let providerNames: Map<string, string> | null = null;
let providerNamesAt = 0;
const PROVIDER_NAMES_TTL_MS = 30 * 60 * 1000;

const defaultProviderNamesFetch = async (): Promise<Map<string, string>> => {
  const response = await fetch(`${OPENROUTER_BASE_URL}/providers`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw Object.assign(new Error(`openrouter_http_${response.status}`), { httpStatus: response.status });
  const data = await response.json() as { data?: Array<{ slug?: string; name?: string }> };
  const map = new Map<string, string>();
  for (const item of data?.data || []) {
    if (item?.slug && item?.name) map.set(item.slug, item.name);
  }
  return map;
};
let providerNamesFetch: () => Promise<Map<string, string>> = defaultProviderNamesFetch;
export const setProviderNamesFetchForTests = (fn: (() => Promise<Map<string, string>>) | null): void => {
  providerNamesFetch = fn ?? defaultProviderNamesFetch;
  providerNames = null;
  providerNamesAt = 0;
};

const loadProviderNames = async (): Promise<Map<string, string>> => {
  if (providerNames && Date.now() - providerNamesAt < PROVIDER_NAMES_TTL_MS) return providerNames;
  try {
    providerNames = await providerNamesFetch();
    providerNamesAt = Date.now();
  } catch {
    // keep stale names or an empty map — slug-only labels are acceptable
  }
  return providerNames ?? new Map();
};

/**
 * Transports receive a text builder so the message can be rendered
 * individually for every recipient's language (users.language).
 */
type NotifyTransport = (textFor: (language: unknown) => string) => Promise<void>;
const notifyTransport: NotifyTransport[] = [];
export const setNotifyTransportForTests = (fn: NotifyTransport | null): void => {
  notifyTransport.length = 0;
  if (fn) notifyTransport.push(fn);
};
notifyTransport.push(async (textFor) => {
  const settings = getMonitorSettings();
  const admins = db.prepare('SELECT id, language FROM users WHERE is_admin = 1 OR role = ?').all('admin') as Array<{ id: number; language: string | null }>;
  const targets = settings.recipientsMode === 'selected'
    ? admins.filter(a => settings.recipientUserIds.includes(a.id))
    : admins;
  for (const admin of targets) {
    try {
      const identity = getTelegramIdentityForAccount(admin.id);
      if (!identity) continue;
      const chatId = Number(identity.provider_subject);
      if (!Number.isInteger(chatId)) continue;
      await sendTelegramMessage(chatId, textFor(admin.language));
    } catch (err) {
      console.warn('[openrouter-monitor] telegram notify failed:', err);
    }
  }
});

const fmtPrice = (v: number | null | undefined): string =>
  (typeof v === 'number' && Number.isFinite(v)) ? `$${v}` : '—';

const buildNotification = (params: {
  modelSlug: string;
  route: string;
  previousSlug: string;
  previousName?: string | null;
  newName?: string | null;
  replacement: CandidateGroup | null;
  strategy: MonitorAction;
  autoSwitch: boolean;
  /** Auto-switch is enabled but the confirmation threshold is not reached yet. */
  pendingConfirmation?: boolean;
  reasonKey?: 'reasonRuntime' | 'reasonRemoved';
}, language?: unknown): string => {
  const t = (key: string, values: Record<string, string | number> = {}) =>
    translateForLanguage(language, `openRouterMonitor.${key}`, values);
  const label = (slug: string, name?: string | null) =>
    name && name !== slug ? `${name} (${slug})` : slug;
  const lines = [
    t('title'),
    '',
    `${t('model')}: \`${params.modelSlug}\``,
    `${t('route')}: ${params.route}`,
    `${t('previousProvider')}: ${label(params.previousSlug, params.previousName)}`,
    t('status'),
    '',
  ];
  if (params.pendingConfirmation) {
    lines.push(t('pending', { count: MISSING_THRESHOLD }));
  } else if (params.autoSwitch && params.replacement) {
    lines.push(
      `${t('newProvider')}: ${label(params.replacement.baseSlug, params.newName)}`,
      `${t('strategy')}: ${t(`strategy${params.strategy.charAt(0).toUpperCase()}${params.strategy.slice(1)}`)}`,
      `${t('input')}: ${fmtPrice(params.replacement.prices?.inputPricePerMillion)} / 1M`,
      `${t('output')}: ${fmtPrice(params.replacement.prices?.outputPricePerMillion)} / 1M`,
      `${t('cacheRead')}: ${fmtPrice(params.replacement.prices?.cacheReadPricePerMillion)} / 1M`,
    );
  } else if (params.autoSwitch) {
    lines.push(t('noReplacementFound'));
    lines.push(t('chooseInPanel'));
  } else {
    lines.push(t('noReplacementSelected'));
  }
  if (params.reasonKey) lines.push('', `${t('reason')}: ${t(params.reasonKey)}`);
  return lines.join('\n');
};

// ── Core check logic ────────────────────────────────────────────────────────

export type CheckOutcome = {
  modelId: string;
  status: MonitorStatus;
  switched: boolean;
  notified: boolean;
  newSlug?: string | null;
};

/**
 * Runs one monitoring cycle. Grouped by model slug so the same model is
 * requested from OpenRouter only once even if it is used by several routes.
 */
export const runMonitorCycle = async (options?: {
  /** Restrict the cycle to specific unique IDs (Check now button). */
  modelIds?: string[];
  /** Force auto-switch even after a single definitive miss (runtime hook). */
  forceSwitch?: boolean;
  requirements?: SelectionRequirements;
}): Promise<CheckOutcome[]> => {
  const settings = getMonitorSettings();
  const allModels = modelsProvider();
  const models = options?.modelIds?.length
    ? allModels.filter(m => options.modelIds!.includes(m.uniqueId))
    : allModels;

  // Only models with a pinned provider slug are monitored.
  const targets = models
    .map(m => ({ ...m, slug: getModelOverride(m.uniqueId)?.openrouter_provider_slug ?? null }))
    .filter((m): m is MonitoredModel & { slug: string } => Boolean(m.slug));

  // Group by model slug → one HTTP request per unique model.
  const bySlug = new Map<string, typeof targets>();
  for (const t of targets) {
    const list = bySlug.get(t.modelSlug) || [];
    list.push(t);
    bySlug.set(t.modelSlug, list);
  }

  const outcomes: CheckOutcome[] = [];

  for (const [modelSlug, group] of bySlug) {
    let endpoints: OpenRouterEndpoint[] | null = null;
    let httpStatus = 0;
    let fetchError: string | null = null;
    try {
      const result = await endpointFetch(modelSlug);
      httpStatus = result.status;
      endpoints = result.endpoints;
    } catch (err: any) {
      fetchError = err?.message || 'fetch_failed';
    }

    for (const target of group) {
      const now = getNowUnix();
      const existing = readState(target.uniqueId);

      // Admin changed the slug manually since the last check → fresh episode.
      if (existing && existing.provider_slug && existing.provider_slug !== target.slug) {
        upsertState(target.uniqueId, {
          provider_slug: target.slug,
          consecutive_missing: 0,
          unavailable_since: null,
          last_notified_key: null,
          replacement_provider_slug: null,
          last_error: null,
          last_seen_prices: null, // re-baseline prices for the new provider
        });
      }

      // 1) Catalog unreachable / rate-limited / server error → state unknown.
      if (endpoints === null) {
        upsertState(target.uniqueId, {
          route: target.route,
          model_slug: target.modelSlug,
          provider_slug: target.slug,
          status: 'check_failed',
          last_check_at: now,
          last_error: fetchError || 'check_failed',
        });
        outcomes.push({ modelId: target.uniqueId, status: 'check_failed', switched: false, notified: false });
        continue;
      }

      // 2) Model removed from the catalog entirely.
      if (httpStatus === 404) {
        const state = upsertState(target.uniqueId, {
          route: target.route,
          model_slug: target.modelSlug,
          provider_slug: target.slug,
          status: 'model_missing',
          last_check_at: now,
          last_error: 'model_not_found_in_catalog',
        });
        const notified = await maybeNotify(state, target, null, 'reasonRemoved');
        outcomes.push({ modelId: target.uniqueId, status: 'model_missing', switched: false, notified });
        continue;
      }

      // 3) Successful catalog response — check the pinned provider.
      const providerPresent = endpoints.some(ep => matchesProviderSlug(ep.tag || '', target.slug));
      if (providerPresent) {
        upsertState(target.uniqueId, {
          route: target.route,
          model_slug: target.modelSlug,
          provider_slug: target.slug,
          status: 'available',
          last_ok_at: now,
          last_check_at: now,
          consecutive_missing: 0,
          unavailable_since: null,
          last_notified_key: null,
          last_error: null,
        });
        const priceNotified = await maybeNotifyPriceChange(target, endpoints);
        outcomes.push({ modelId: target.uniqueId, status: 'available', switched: false, notified: priceNotified });
        continue;
      }

      // 4) Provider definitively missing from a successful catalog response.
      const autoSwitch = settings.action !== 'notify';
      const canSwitch = options?.forceSwitch
        || (autoSwitch && (readState(target.uniqueId)?.consecutive_missing ?? 0) + 1 >= MISSING_THRESHOLD);

      const state = upsertState(target.uniqueId, {
        route: target.route,
        model_slug: target.modelSlug,
        provider_slug: target.slug,
        status: 'missing',
        last_check_at: now,
        consecutive_missing: (readState(target.uniqueId)?.consecutive_missing ?? 0) + 1,
        unavailable_since: readState(target.uniqueId)?.unavailable_since ?? now,
      });

      let replacement: CandidateGroup | null = null;
      if (canSwitch && autoSwitch) {
        replacement = selectReplacement(endpoints, settings.action, options?.requirements, target.slug);
        if (replacement) {
          setModelProvider(target.uniqueId, {
            openrouterProviderSlug: replacement.baseSlug,
            inputPricePerMillion: replacement.prices?.inputPricePerMillion ?? null,
            outputPricePerMillion: replacement.prices?.outputPricePerMillion ?? null,
            cacheReadPricePerMillion: replacement.prices?.cacheReadPricePerMillion ?? null,
            pricingMode: 'auto',
            pricingSource: 'openrouter_auto',
          });
          upsertState(target.uniqueId, {
            provider_slug: replacement.baseSlug,
            consecutive_missing: 0,
            unavailable_since: null,
            last_notified_key: null,
            previous_provider_slug: target.slug,
            replacement_provider_slug: replacement.baseSlug,
          });
        }
      }

      const notified = await maybeNotify(state, target, replacement, undefined, canSwitch && autoSwitch, autoSwitch && !canSwitch);
      outcomes.push({
        modelId: target.uniqueId,
        status: 'missing',
        switched: Boolean(replacement),
        notified,
        newSlug: replacement?.baseSlug ?? null,
      });
    }
  }

  return outcomes;
};

/** Deduplicated notification: one per (model, missing provider) episode. */
const maybeNotify = async (
  state: MonitorState,
  target: MonitoredModel & { slug: string },
  replacement: CandidateGroup | null,
  reasonKey?: 'reasonRuntime' | 'reasonRemoved',
  autoSwitchAttempted?: boolean,
  pendingConfirmation?: boolean,
): Promise<boolean> => {
  const settings = getMonitorSettings();
  const key = state.status === 'model_missing' ? 'model_missing' : target.slug;
  const fresh = readState(target.uniqueId);
  if (fresh?.last_notified_key === key) return false; // already notified for this episode

  const names = await loadProviderNames();
  const params = {
    modelSlug: target.modelSlug,
    route: target.route,
    previousSlug: target.slug,
    previousName: names.get(target.slug) ?? null,
    newName: replacement ? names.get(replacement.baseSlug) ?? null : null,
    replacement,
    strategy: settings.action,
    autoSwitch: autoSwitchAttempted ?? false,
    pendingConfirmation,
    reasonKey,
  };
  const textFor = (language: unknown) => buildNotification(params, language);
  try {
    for (const transport of notifyTransport) await transport(textFor);
  } catch (err) {
    console.warn('[openrouter-monitor] notify transport failed:', err);
  }
  upsertState(target.uniqueId, { last_notified_at: getNowUnix(), last_notified_key: key });
  return true;
};

// ── Price tracking ──────────────────────────────────────────────────────────

/** Grouped prices of the pinned provider (max across regional variants, same as the UI shows). */
export const pinnedProviderPrices = (endpoints: OpenRouterEndpoint[], slug: string): EndpointPrices | null => {
  const eps = endpoints.filter(ep => matchesProviderSlug(ep.tag || '', slug));
  if (!eps.length) return null;
  // All matching endpoints share the same base slug → single candidate group.
  return buildCandidateGroups(eps)[0]?.prices ?? null;
};

const parseStoredPrices = (raw: string | null): EndpointPrices | null => {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as EndpointPrices;
    return (typeof v === 'object' && v !== null) ? v : null;
  } catch {
    return null;
  }
};

/** True when every field is either non-comparable or within the threshold. */
export const pricesWithinThreshold = (prev: EndpointPrices, current: EndpointPrices, thresholdPct: number): boolean => {
  const fields: Array<keyof EndpointPrices> = ['inputPricePerMillion', 'outputPricePerMillion', 'cacheReadPricePerMillion'];
  for (const field of fields) {
    const a = prev[field];
    const b = current[field];
    // Only compare where both sides are known numbers; null ↔ value is not a
    // reliable signal (some providers don't publish cache prices).
    if (typeof a !== 'number' || typeof b !== 'number') continue;
    if (a === 0 && b === 0) continue;
    const base = a === 0 ? b : a;
    const changePct = Math.abs(b - a) / Math.abs(base) * 100;
    if (changePct > thresholdPct) return false;
  }
  return true;
};

const buildPriceNotification = (params: {
  modelSlug: string;
  route: string;
  providerSlug: string;
  providerName?: string | null;
  prev: EndpointPrices;
  current: EndpointPrices;
  updatedOverrides: boolean;
}, language?: unknown): string => {
  const t = (key: string, values: Record<string, string | number> = {}) =>
    translateForLanguage(language, `openRouterMonitor.${key}`, values);
  const label = params.providerName && params.providerName !== params.providerSlug
    ? `${params.providerName} (${params.providerSlug})` : params.providerSlug;
  const delta = (a: number | null, b: number | null) => {
    let pct = '';
    if (typeof a === 'number' && typeof b === 'number' && a !== 0) {
      const change = ((b - a) / Math.abs(a)) * 100;
      const rounded = Math.round(Math.abs(change) * 10) / 10;
      pct = ` (${change > 0 ? '+' : change < 0 ? '−' : ''}${rounded}%)`;
    }
    return `${fmtPrice(a)} → ${fmtPrice(b)}${pct}`;
  };
  const lines = [
    t('priceTitle'),
    '',
    `${t('model')}: \`${params.modelSlug}\``,
    `${t('route')}: ${params.route}`,
    `${t('provider')}: ${label}`,
    '',
    `${t('input')}: ${delta(params.prev.inputPricePerMillion, params.current.inputPricePerMillion)} / 1M`,
    `${t('output')}: ${delta(params.prev.outputPricePerMillion, params.current.outputPricePerMillion)} / 1M`,
    `${t('cacheRead')}: ${delta(params.prev.cacheReadPricePerMillion, params.current.cacheReadPricePerMillion)} / 1M`,
  ];
  if (params.updatedOverrides) lines.push('', t('priceUpdatedOverrides'));
  return lines.join('\n');
};

/**
 * Compares the pinned provider's current prices against the last seen snapshot.
 * First successful check records the baseline silently; afterwards a change
 * beyond settings.priceThresholdPct notifies admins (and optionally refreshes
 * the prices stored in model_overrides so cost accounting stays honest).
 */
const maybeNotifyPriceChange = async (
  target: MonitoredModel & { slug: string },
  endpoints: OpenRouterEndpoint[],
): Promise<boolean> => {
  try {
    const settings = getMonitorSettings();
    if (settings.priceTracking === 'off') return false;

    const current = pinnedProviderPrices(endpoints, target.slug);
    if (!current) return false;

    const currentJson = JSON.stringify(current);
    const stored = readState(target.uniqueId);
    if (stored?.last_seen_prices === currentJson) return false; // nothing changed

    const prev = parseStoredPrices(stored?.last_seen_prices ?? null);
    upsertState(target.uniqueId, { last_seen_prices: currentJson });
    if (!prev) return false; // first check → baseline only
    if (pricesWithinThreshold(prev, current, settings.priceThresholdPct)) return false;

    // 'update' mode refreshes model_overrides prices — never for manually
    // priced models, that's an explicit admin decision.
    let updatedOverrides = false;
    if (settings.priceTracking === 'update') {
      const override = getModelOverride(target.uniqueId);
      if (override && override.pricing_mode !== 'manual') {
        setModelProvider(target.uniqueId, {
          inputPricePerMillion: current.inputPricePerMillion,
          outputPricePerMillion: current.outputPricePerMillion,
          cacheReadPricePerMillion: current.cacheReadPricePerMillion,
          pricingSource: 'openrouter_auto',
        });
        updatedOverrides = true;
      }
    }

    const names = await loadProviderNames();
    const params = {
      modelSlug: target.modelSlug,
      route: target.route,
      providerSlug: target.slug,
      providerName: names.get(target.slug) ?? null,
      prev,
      current,
      updatedOverrides,
    };
    const textFor = (language: unknown) => buildPriceNotification(params, language);
    for (const transport of notifyTransport) await transport(textFor).catch(() => {});
    return true;
  } catch (err) {
    console.warn('[openrouter-monitor] price check failed:', err);
    return false;
  }
};

// ── Test notifications (admin panel "Test notification" buttons) ────────────

/**
 * Sends a sample notification through the real transport (same recipients and
 * languages as production alerts) so the admin can verify Telegram delivery.
 * Uses the first monitored model for realistic content; falls back to
 * placeholders when nothing is monitored yet. Never throws.
 */
export const sendTestNotification = async (kind: 'missing' | 'price'): Promise<boolean> => {
  try {
    const first = modelsProvider()[0] ?? { uniqueId: 'test', route: '—', modelSlug: 'test/model' };
    const slug = getModelOverride(first.uniqueId)?.openrouter_provider_slug ?? 'example-provider';
    const names = await loadProviderNames();

    let textFor: (language: unknown) => string;
    if (kind === 'price') {
      const prev = { inputPricePerMillion: 1, outputPricePerMillion: 2, cacheReadPricePerMillion: 0.1 };
      const current = { inputPricePerMillion: 1.5, outputPricePerMillion: 2.4, cacheReadPricePerMillion: 0.1 };
      const params = {
        modelSlug: first.modelSlug,
        route: first.route,
        providerSlug: slug,
        providerName: names.get(slug) ?? null,
        prev,
        current,
        updatedOverrides: false,
      };
      textFor = (language: unknown) => buildPriceNotification(params, language);
    } else {
      const replacement: CandidateGroup = {
        baseSlug: 'example-replacement',
        prices: { inputPricePerMillion: 0.75, outputPricePerMillion: 1.2, cacheReadPricePerMillion: 0.05 },
        throughputP50: 420,
        latencyP50: 180,
        uptime: 0.99,
        endpointCount: 2,
      };
      const params = {
        modelSlug: first.modelSlug,
        route: first.route,
        previousSlug: slug,
        previousName: names.get(slug) ?? null,
        newName: names.get(replacement.baseSlug) ?? null,
        replacement,
        strategy: getMonitorSettings().action,
        autoSwitch: true,
      };
      textFor = (language: unknown) => buildNotification(params, language);
    }

    for (const transport of notifyTransport) await transport(textFor).catch(() => {});
    return true;
  } catch (err) {
    console.warn('[openrouter-monitor] test notification failed:', err);
    return false;
  }
};

// ── Runtime auto-switch (real request failed with missing provider) ─────────

/** Detects OpenRouter "provider/endpoint no longer available" style errors. */
export const isProviderMissingError = (err: any): boolean => {
  const status = Number(err?.status);
  const message = `${err?.message || err?.error?.message || ''}`;
  if (status === 404 && /provider|endpoint|model/i.test(message)) return true;
  if (status === 400 && /no allowed providers|not a valid provider|no endpoints/i.test(message)) return true;
  return false;
};

/**
 * One-shot runtime recovery: refresh endpoints for the model, verify the
 * pinned provider is really gone, pick a replacement, persist it and notify.
 * Returns the new slug, or null when nothing could be done. Never throws.
 */
export const attemptRuntimeProviderSwitch = async (
  uniqueId: string,
  requirements?: SelectionRequirements,
): Promise<string | null> => {
  try {
    const settings = getMonitorSettings();
    if (settings.action === 'notify') return null; // manual mode — no auto-switch

    const override = getModelOverride(uniqueId);
    const currentSlug = override?.openrouter_provider_slug ?? null;
    if (!currentSlug) return null;

    // Find the model slug for this unique id.
    const model = modelsProvider().find(m => m.uniqueId === uniqueId);
    if (!model) return null;

    let endpoints: OpenRouterEndpoint[];
    try {
      const result = await endpointFetch(model.modelSlug);
      if (result.endpoints === null) return null; // catalog unreachable → state unknown
      endpoints = result.endpoints;
    } catch {
      return null;
    }

    if (endpoints.some(ep => matchesProviderSlug(ep.tag || '', currentSlug))) {
      return null; // provider still listed; the runtime error was transient
    }

    const replacement = selectReplacement(endpoints, settings.action, requirements, currentSlug);
    if (!replacement) return null;

    setModelProvider(uniqueId, {
      openrouterProviderSlug: replacement.baseSlug,
      inputPricePerMillion: replacement.prices?.inputPricePerMillion ?? null,
      outputPricePerMillion: replacement.prices?.outputPricePerMillion ?? null,
      cacheReadPricePerMillion: replacement.prices?.cacheReadPricePerMillion ?? null,
      pricingMode: 'auto',
      pricingSource: 'openrouter_auto',
    });
    upsertState(uniqueId, {
      route: model.route,
      model_slug: model.modelSlug,
      provider_slug: replacement.baseSlug,
      status: 'available',
      last_check_at: getNowUnix(),
      last_ok_at: getNowUnix(),
      consecutive_missing: 0,
      unavailable_since: null,
      previous_provider_slug: currentSlug,
      replacement_provider_slug: replacement.baseSlug,
      last_notified_key: null,
      last_error: null,
    });

    const names = await loadProviderNames();
    const params = {
      modelSlug: model.modelSlug,
      route: model.route,
      previousSlug: currentSlug,
      previousName: names.get(currentSlug) ?? null,
      newName: names.get(replacement.baseSlug) ?? null,
      replacement,
      strategy: settings.action,
      autoSwitch: true,
      reasonKey: 'reasonRuntime' as const,
    };
    const textFor = (language: unknown) => buildNotification(params, language);
    for (const transport of notifyTransport) await transport(textFor).catch(() => {});
    upsertState(uniqueId, { last_notified_at: getNowUnix(), last_notified_key: `runtime:${currentSlug}` });

    return replacement.baseSlug;
  } catch (err) {
    console.warn('[openrouter-monitor] runtime switch failed:', err);
    return null;
  }
};

// ── Scheduler with jitter ───────────────────────────────────────────────────

let schedulerTimer: ReturnType<typeof setTimeout> | null = null;
let schedulerRunning = false;

const scheduleNext = (): void => {
  if (schedulerTimer) clearTimeout(schedulerTimer);
  const settings = getMonitorSettings();
  if (!settings.enabled) { schedulerTimer = null; return; }
  const intervalMs = settings.intervalMinutes * 60_000;
  // Random jitter so all Chatter installations don't hit OpenRouter in sync.
  const jitterMs = Math.floor(Math.random() * Math.max(1, intervalMs * JITTER_FRACTION));
  schedulerTimer = setTimeout(async () => {
    if (!schedulerRunning) {
      schedulerRunning = true;
      try {
        await runMonitorCycle();
      } catch (err) {
        console.warn('[openrouter-monitor] cycle failed:', err);
      } finally {
        schedulerRunning = false;
      }
    }
    scheduleNext();
  }, intervalMs + jitterMs);
  if (typeof schedulerTimer.unref === 'function') schedulerTimer.unref();
};

export const startOpenRouterMonitor = (): void => {
  if (process.env.OPENROUTER_MONITOR_DISABLED === '1') return;
  scheduleNext();
  console.log('[openrouter-monitor] started');
};

export const restartOpenRouterMonitor = (): void => {
  scheduleNext();
};
