// ── OpenRouter monitor tests ────────────────────────────────────────────────
// Run: npx tsx tests/openrouter-monitor.test.mts
// Uses a throwaway SQLite DB (API_DB_PATH) and an injected OpenRouter fetch,
// so nothing touches the real catalog, Telegram or model_overrides of prod.

import path from 'node:path';
import os from 'node:os';
// IMPORTANT: must be set before any module that touches the DB is loaded.
// Static imports are hoisted above this assignment, so all app imports below
// are dynamic.
process.env.API_DB_PATH = path.join(
  os.tmpdir(), `chatter-monitor-test-${process.pid}-${Date.now()}.db`,
);

const assert = (await import('node:assert')).default;
const { default: Database } = await import('better-sqlite3');

const {
  registerMonitoredModelsProvider, setMonitorFetchForTests, setNotifyTransportForTests,
  setProviderNamesFetchForTests,
  runMonitorCycle, saveMonitorSettings, getMonitorSettings, getMonitorStates,
  attemptRuntimeProviderSwitch, matchesProviderSlug, selectReplacement,
} = await import('../src/services/openrouter-monitor.js') as typeof import('../src/services/openrouter-monitor.js');
const { getModelOverride, setModelProvider } = await import('../src/services/token-quota.js') as typeof import('../src/services/token-quota.js');
type OpenRouterEndpoint = import('../src/services/openrouter-monitor.js').OpenRouterEndpoint;
type MonitorSettings = import('../src/services/openrouter-monitor.js').MonitorSettings;

// ── Test doubles ────────────────────────────────────────────────────────────

type EndpointSpec = OpenRouterEndpoint;

const ep = (tag: string, overrides: Partial<EndpointSpec> = {}): EndpointSpec => ({
  tag,
  status: 'active',
  supported_parameters: ['tools'],
  pricing: { prompt: '0.000001', completion: '0.000002', input_cache_read: '0.0000001' },
  throughput_last_30m: { p50: 100 },
  latency_last_30m: { p50: 200 },
  uptime_last_30m: 0.99,
  ...overrides,
});

const FULL = {
  'google/gemini-2.5-flash': [
    ep('provider-a'),
    ep('provider-b', { pricing: { prompt: '0.0000002', completion: '0.000001', input_cache_read: '0' }, throughput_last_30m: { p50: 500 }, latency_last_30m: { p50: 100 }, uptime_last_30m: 0.95 }),
    ep('provider-c', { pricing: { prompt: '0.000003', completion: '0.000003' }, throughput_last_30m: { p50: 50 }, latency_last_30m: { p50: 300 }, uptime_last_30m: 0.9 }),
    // Regional variants of google-vertex (base-slug grouping).
    ep('google-vertex/us-east5', { pricing: { prompt: '0.0000005', completion: '0.000001' } }),
    ep('google-vertex/us-central1', { pricing: { prompt: '0.0000004', completion: '0.0000009' } }),
    ep('inactive-provider', { status: 'inactive' }),
  ],
};

let catalog: Record<string, EndpointSpec[]> = { ...FULL };
let httpFail: number | null = null; // simulate 429/500 for all models
let fetchCount = 0;

setMonitorFetchForTests(async (modelSlug: string) => {
  fetchCount += 1;
  if (httpFail) throw Object.assign(new Error(`openrouter_http_${httpFail}`), { httpStatus: httpFail });
  if (!(modelSlug in catalog)) return { status: 404, endpoints: [] };
  return { status: 200, endpoints: catalog[modelSlug] };
});

const notifications: string[] = [];
setNotifyTransportForTests(async (textFor: (language: unknown) => string) => {
  notifications.push(textFor('en'));
  notifications.push(textFor('ru')); // sanity: ru bundle renders without keys leaking
});
// No real /providers calls from tests.
setProviderNamesFetchForTests(async () => new Map([
  ['provider-a', 'Provider A Inc.'],
  ['provider-b', 'Provider B LLC'],
]));

const MODELS = [
  { uniqueId: 'manual-1', route: 'Manual', modelSlug: 'google/gemini-2.5-flash' },
  { uniqueId: 'lite-1', route: 'Lite', modelSlug: 'google/gemini-2.5-flash' }, // same slug, different chain
  { uniqueId: 'pro-1', route: 'Pro', modelSlug: 'other/model' },
];
registerMonitoredModelsProvider(() => MODELS);

const setSettings = (patch: Partial<MonitorSettings>) => saveMonitorSettings(patch);
const resetWorld = () => {
  catalog = JSON.parse(JSON.stringify(FULL));
  httpFail = null;
  fetchCount = 0;
  notifications.length = 0;
  // Fresh monitor state per scenario.
  const rawDb = new Database(process.env.API_DB_PATH!);
  rawDb.exec('DELETE FROM openrouter_monitor_state');
  rawDb.close();
  setSettings({ enabled: true, intervalMinutes: 60, action: 'notify', recipientsMode: 'all_admins', recipientUserIds: [], priceTracking: 'off' });
  for (const m of MODELS) {
    setModelProvider(m.uniqueId, {
      providerKind: 'openrouter',
      openrouterProviderSlug: 'provider-a',
      pricingMode: 'auto',
      inputPricePerMillion: 1, outputPricePerMillion: 2, cacheReadPricePerMillion: 0.1,
      pricingSource: 'openrouter_auto',
    });
  }
};

// ── 1. Provider slug matching (base slug vs exact variant) ─────────────────

assert.strictEqual(matchesProviderSlug('google-vertex', 'google-vertex'), true);
assert.strictEqual(matchesProviderSlug('google-vertex/us-east5', 'google-vertex'), true);
assert.strictEqual(matchesProviderSlug('google-vertex/us-central1', 'google-vertex'), true);
assert.strictEqual(matchesProviderSlug('google-vertexx', 'google-vertex'), false);
assert.strictEqual(matchesProviderSlug('deepinfra/turbo', 'deepinfra/turbo'), true);
assert.strictEqual(matchesProviderSlug('deepinfra/turbo-fast', 'deepinfra/turbo'), false, 'exact variant slug must not match siblings');

// ── 2. Provider present → available, no notify, no switch ───────────────────

resetWorld();
let outcomes = await runMonitorCycle();
assert.strictEqual(outcomes.find(o => o.modelId === 'manual-1')?.status, 'available');
assert.strictEqual(outcomes.find(o => o.modelId === 'lite-1')?.status, 'available');
assert.strictEqual(outcomes.find(o => o.modelId === 'pro-1')?.status, 'model_missing', 'model not in catalog');
assert.strictEqual(getModelOverride('manual-1')?.openrouter_provider_slug, 'provider-a');
assert.strictEqual(notifications.length, 2, 'model-removed notification for pro-1 (en + ru)');
console.log('✔ provider present / model removed');

// ── 3. One network failure (429/500) → check_failed, no switch ──────────────

resetWorld();
httpFail = 429;
outcomes = await runMonitorCycle();
assert.strictEqual(outcomes.find(o => o.modelId === 'manual-1')?.status, 'check_failed');
assert.strictEqual(getMonitorStates().find(s => s.model_id === 'manual-1')?.consecutive_missing, 0);
assert.strictEqual(getModelOverride('manual-1')?.openrouter_provider_slug, 'provider-a');
assert.strictEqual(notifications.length, 0);
console.log('✔ 429 does not switch');

// ── 4. Missing once (auto-switch cheapest) → pending, no switch yet ─────────

resetWorld();
setSettings({ action: 'cheapest' });
catalog['google/gemini-2.5-flash'] = FULL['google/gemini-2.5-flash'].filter(e => !e.tag!.startsWith('provider-a'));
outcomes = await runMonitorCycle();
assert.strictEqual(outcomes.find(o => o.modelId === 'manual-1')?.status, 'missing');
assert.strictEqual(getModelOverride('manual-1')?.openrouter_provider_slug, 'provider-a', 'no switch after single miss');
assert.ok(notifications.length >= 1);
assert.ok(notifications[0].includes('pending'), 'first miss tells auto-switch is pending');
console.log('✔ single miss does not switch');

// ── 5. Missing twice → auto-switch to cheapest + prices updated ─────────────

outcomes = await runMonitorCycle();
const switched = outcomes.find(o => o.modelId === 'manual-1');
assert.ok(switched?.switched, 'switch on second consecutive miss');
// Cheapest by input price: provider-b (0.2$/M) vs provider-c (3$/M) vs google-vertex group max (0.5$/M)
assert.strictEqual(getModelOverride('manual-1')?.openrouter_provider_slug, 'provider-b');
assert.strictEqual(getModelOverride('manual-1')?.input_price_per_million, 0.2);
assert.strictEqual(getModelOverride('manual-1')?.output_price_per_million, 1);
assert.strictEqual(getModelOverride('manual-1')?.pricing_mode, 'auto');
assert.strictEqual(getModelOverride('manual-1')?.pricing_source, 'openrouter_auto');
const lite = getModelOverride('lite-1');
assert.strictEqual(lite?.openrouter_provider_slug, 'provider-b', 'same model slug in another chain switched too');
// One endpoints request per unique model slug per cycle: gemini slug is
// shared by manual-1 + lite-1 (both switched to provider-b) → 1 fetch,
// plus 1 fetch for other/model = 2 total.
fetchCount = 0;
catalog['other/model'] = []; // model slug known → not 404, empty endpoints is fine
await runMonitorCycle();
assert.strictEqual(fetchCount, 2, 'identical model slug across chains fetched once');
delete catalog['other/model'];
console.log('✔ double miss switches to cheapest and updates prices');

// ── 6. Dedup: repeated cycles don't re-notify for the same state ────────────
// manual-1 and lite-1 share the slug; each uniqueId gets one notification per
// missing episode. Episode 1 (provider-b missing, cycle A), episode 2
// (confirmed + switched, cycle B), cycle C → no new notifications.

// pro-1 keeps producing model_missing episodes (other/model is absent) —
// filter it out; count English messages only (ru is pushed as a bundle sanity).
const geminiNotifs = () => notifications.filter(n => n.includes('Route: ') && !n.includes('Route: Pro'));
const before = geminiNotifs().length;
catalog['google/gemini-2.5-flash'] = FULL['google/gemini-2.5-flash'].filter(e => !e.tag!.startsWith('provider-b'));
await runMonitorCycle();
const afterFirst = geminiNotifs().length;
assert.strictEqual(afterFirst - before, 2, 'one pending-notification per model');
await runMonitorCycle();
const afterSecond = geminiNotifs().length;
assert.strictEqual(afterSecond - afterFirst, 2, 'one switch-notification per model');
await runMonitorCycle(); // replacement still present → available, nothing new
assert.strictEqual(geminiNotifs().length, afterSecond, 'no re-notification for the same episode');
console.log('✔ notification deduplicated');

// ── 7. Recovery then re-missing → new notification allowed ──────────────────

resetWorld();
catalog['google/gemini-2.5-flash'] = FULL['google/gemini-2.5-flash'].filter(e => !e.tag!.startsWith('provider-a'));
await runMonitorCycle(); // missing #1 (notify)
await runMonitorCycle(); // missing #2 (notify is deduped; notify-only mode → no switch)
assert.strictEqual(getModelOverride('manual-1')?.openrouter_provider_slug, 'provider-a', 'manual mode changes nothing');
catalog = JSON.parse(JSON.stringify(FULL));
await runMonitorCycle(); // recovered
catalog['google/gemini-2.5-flash'] = FULL['google/gemini-2.5-flash'].filter(e => !e.tag!.startsWith('provider-a'));
await runMonitorCycle(); // missing again
const episodeNotifs = notifications.filter(n => n.includes('provider-a') && n.includes('Route: Manual'));
assert.strictEqual(episodeNotifs.length, 2, 'notified again after recovery + re-disappearance');
console.log('✔ re-notify after recovery');

// ── 8. Manual (notify-only) mode never switches ─────────────────────────────

resetWorld();
setSettings({ action: 'notify' });
catalog['google/gemini-2.5-flash'] = FULL['google/gemini-2.5-flash'].filter(e => !e.tag!.startsWith('provider-a'));
await runMonitorCycle();
await runMonitorCycle();
await runMonitorCycle();
assert.strictEqual(getModelOverride('manual-1')?.openrouter_provider_slug, 'provider-a');
assert.ok(notifications.some(n => n.includes('No replacement was selected')), 'notify-only message');
console.log('✔ manual mode changes nothing');

// ── 9. Selection strategies ─────────────────────────────────────────────────

const endpoints = FULL['google/gemini-2.5-flash'].filter(e => e.tag !== 'inactive-provider');
assert.strictEqual(selectReplacement(endpoints, 'cheapest', undefined, 'provider-a')?.baseSlug, 'provider-b');
assert.strictEqual(selectReplacement(endpoints, 'throughput', undefined, 'provider-a')?.baseSlug, 'provider-b', 'max throughput p50=500');
assert.strictEqual(selectReplacement(endpoints, 'latency', undefined, 'provider-a')?.baseSlug, 'provider-b', 'min latency p50=100');
// Excluding provider-b: provider-a ties with google-vertex on throughput (100)
// and latency (200) and comes first, both beat provider-c (50/300):
assert.strictEqual(selectReplacement(endpoints, 'throughput', undefined, 'provider-b')?.baseSlug, 'provider-a');
assert.strictEqual(selectReplacement(endpoints, 'latency', undefined, 'provider-b')?.baseSlug, 'provider-a');
// With provider-a AND provider-b excluded, google-vertex beats provider-c:
assert.strictEqual(selectReplacement(endpoints.filter(e => !e.tag!.startsWith('provider-a')), 'throughput', undefined, 'provider-b')?.baseSlug, 'google-vertex');
// tools requirement:
const noTools = endpoints.map(e => ({ ...e, supported_parameters: e.tag === 'provider-b' ? [] : ['tools'] }));
assert.strictEqual(selectReplacement(noTools, 'cheapest', { tools: true }, 'provider-a')?.baseSlug, 'google-vertex');
console.log('✔ selection strategies');

// ── 10. Runtime auto-switch: single shot, respects mode ─────────────────────

resetWorld();
setSettings({ action: 'notify' });
catalog['google/gemini-2.5-flash'] = FULL['google/gemini-2.5-flash'].filter(e => !e.tag!.startsWith('provider-a'));
assert.strictEqual(await attemptRuntimeProviderSwitch('manual-1'), null, 'no auto-switch in notify mode');
assert.strictEqual(getModelOverride('manual-1')?.openrouter_provider_slug, 'provider-a');

setSettings({ action: 'cheapest' });
const newSlug = await attemptRuntimeProviderSwitch('manual-1', { tools: true });
assert.strictEqual(newSlug, 'provider-b');
assert.strictEqual(getModelOverride('manual-1')?.openrouter_provider_slug, 'provider-b');
assert.strictEqual(getModelOverride('manual-1')?.input_price_per_million, 0.2);
assert.ok(notifications.some(n => n.includes('New provider: Provider B LLC (provider-b)') && n.includes('live request')), 'provider display name + runtime reason');
assert.ok(notifications.some(n => n.includes('Strategy: notify only') || n.includes('Strategy: cheapest')), 'strategy label translated, no raw i18n key leak');
assert.ok(notifications.every(n => !n.includes('openRouterMonitor.')), 'no raw translation keys in notifications');
// Provider still present → runtime switch is a no-op (transient error).
catalog = JSON.parse(JSON.stringify(FULL));
assert.strictEqual(await attemptRuntimeProviderSwitch('manual-1'), null);
console.log('✔ runtime auto-switch');

// ── 11. Settings persistence ────────────────────────────────────────────────

setSettings({ enabled: true, intervalMinutes: 30, action: 'latency', recipientsMode: 'selected', recipientUserIds: [1, 'x', 2] });
const s = getMonitorSettings();
assert.deepStrictEqual(s, { enabled: true, intervalMinutes: 30, action: 'latency', recipientsMode: 'selected', recipientUserIds: [1, 2], priceTracking: 'off', priceThresholdPct: 5 });
console.log('✔ settings persist and sanitize');

// ── 12. Price tracking ──────────────────────────────────────────────────────

resetWorld();
setSettings({ priceTracking: 'notify' });
await runMonitorCycle(); // first successful check → baseline recorded silently
notifications.length = 0;

// Input price 1 → 2 $/M (100% change, way above the 5% threshold).
const reprice = (prompt: string) => {
  catalog['google/gemini-2.5-flash'] = FULL['google/gemini-2.5-flash'].map(e =>
    e.tag === 'provider-a'
      ? { ...e, pricing: { prompt, completion: e.pricing!.completion, input_cache_read: e.pricing!.input_cache_read } }
      : e
  );
};
reprice('0.000002');
outcomes = await runMonitorCycle();
assert.ok(outcomes.find(o => o.modelId === 'manual-1')?.notified, 'price change notified');
assert.ok(notifications.some(n => n.includes('$1 → $2 (+100%)')), 'old → new price + change percent in the message');
assert.ok(notifications.every(n => !n.includes('updated automatically')), 'notify mode does not touch overrides');
assert.ok(notifications.some(n => n.includes('price tracking is set to notify only')), 'message explains why the provider was not changed');
assert.strictEqual(getModelOverride('manual-1')?.input_price_per_million, 1, 'override prices untouched in notify mode');
console.log('✔ price change notifies without touching overrides');

// Update mode refreshes model_overrides prices but never uses the separate
// strategy configured for a provider disappearance.
setSettings({ priceTracking: 'update', action: 'cheapest' });
reprice('0.000003'); // 2 → 3 $/M
notifications.length = 0;
outcomes = await runMonitorCycle();
assert.ok(outcomes.find(o => o.modelId === 'manual-1')?.notified);
assert.strictEqual(getModelOverride('manual-1')?.input_price_per_million, 3, 'override prices refreshed');
assert.strictEqual(getModelOverride('manual-1')?.openrouter_provider_slug, 'provider-a', 'update-only mode does not switch providers');
assert.strictEqual(getModelOverride('manual-1')?.pricing_source, 'openrouter_auto');
assert.ok(notifications.some(n => n.includes('updated automatically')), 'message mentions automatic update');
console.log('✔ update mode refreshes override prices');

// Small drift below the threshold is ignored.
reprice('0.0000031'); // 3 → 3.1 $/M ≈ 3.3% < 5%
notifications.length = 0;
outcomes = await runMonitorCycle();
assert.ok(!outcomes.find(o => o.modelId === 'manual-1')?.notified, 'small drift ignored');
assert.strictEqual(notifications.length, 0);
console.log('✔ below-threshold drift ignored');

// The dedicated switch mode re-evaluates all endpoints after a significant
// price change and switches when another provider is now cheaper.
resetWorld();
setSettings({ priceTracking: 'switch_cheapest', action: 'latency' });
await runMonitorCycle(); // provider-a baseline
notifications.length = 0;
reprice('0.000004'); // provider-a becomes more expensive than provider-b
outcomes = await runMonitorCycle();
const priceSwitched = outcomes.find(o => o.modelId === 'manual-1');
assert.ok(priceSwitched?.switched, 'price change switches to the cheapest provider');
assert.strictEqual(priceSwitched?.newSlug, 'provider-b');
assert.strictEqual(getModelOverride('manual-1')?.openrouter_provider_slug, 'provider-b');
assert.strictEqual(getModelOverride('manual-1')?.input_price_per_million, 0.2);
assert.ok(notifications.some(n => n.includes('Provider switched: Provider A Inc. (provider-a) → Provider B LLC (provider-b).')));

// The replacement prices become the new baseline, so the next cycle must not
// report the same change again.
notifications.length = 0;
outcomes = await runMonitorCycle();
assert.ok(!outcomes.find(o => o.modelId === 'manual-1')?.notified, 'replacement baseline prevents duplicate alerts');
assert.strictEqual(notifications.filter(n => n.includes('Route: Manual')).length, 0);
console.log('✔ price change can switch provider and stores the new baseline');

console.log('\nAll openrouter-monitor tests passed.');
process.exit(0);
