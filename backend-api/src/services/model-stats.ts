import { db, getNowUnix } from '../db.js';
import { getModelOverride, refreshOverrideCache } from './token-quota.js';

// ── Model generation speed stats (locally measured, tokens/sec) ────────────
// Per-message updates stay in memory (zero disk I/O); the aggregated EMA is
// flushed into model_overrides on an interval and on process shutdown.

type TpsStat = { avgTps: number; samples: number };

const stats = new Map<string, TpsStat>();
let flushTimer: NodeJS.Timeout | null = null;

/**
 * Provides the set of currently routable model ids. Registered by ai.ts to
 * avoid a circular import. Null = no filter (write everything).
 */
let knownModelsProvider: (() => Set<string> | null) | null = null;
export const setKnownModelStatsFilter = (fn: () => Set<string> | null): void => {
  knownModelsProvider = fn;
};

/** Drop in-memory stats for a model (e.g. its override row was deleted). */
export const forgetModelTps = (modelId: string | null | undefined): void => {
  if (modelId) stats.delete(modelId);
};

const FLUSH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
/** EMA weight of a new sample: higher = faster adaptation to provider changes. */
const EMA_ALPHA = 0.15;

const scheduleFlush = () => {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try { flushModelTpsStats(); } catch (err) { console.warn('[model-stats] flush failed:', err); }
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
};

/** Record an observed generation speed for a model (tokens/sec). */
export const recordModelTps = (modelId: string | null | undefined, tps: number): void => {
  if (!modelId || !Number.isFinite(tps) || tps <= 0) return;
  const existing = stats.get(modelId);
  if (existing) {
    existing.avgTps = existing.avgTps * (1 - EMA_ALPHA) + tps * EMA_ALPHA;
    existing.samples += 1;
  } else {
    // Seed the EMA with the persisted value so restarts don't reset history.
    const persistedOverride = getModelOverride(modelId);
    const persisted = persistedOverride?.avg_tps;
    stats.set(modelId, {
      avgTps: Number.isFinite(persisted) && persisted && persisted > 0
        ? persisted * (1 - EMA_ALPHA) + tps * EMA_ALPHA
        : tps,
      samples: Math.max(0, persistedOverride?.tps_samples ?? 0) + 1,
    });
  }
  scheduleFlush();
};

/** Persist accumulated stats into model_overrides (keeps other columns intact). */
export const flushModelTpsStats = (): void => {
  if (stats.size === 0) return;
  const now = getNowUnix();
  const known = knownModelsProvider?.() ?? null;
  const upsert = db.prepare(`
    INSERT INTO model_overrides (model_id, coefficient, updated_at, avg_tps, tps_samples, tps_updated_at)
    VALUES (?, 1.0, ?, ?, ?, ?)
    ON CONFLICT(model_id) DO UPDATE SET
      avg_tps = excluded.avg_tps,
      tps_samples = excluded.tps_samples,
      tps_updated_at = excluded.tps_updated_at
  `);
  for (const [modelId, stat] of stats) {
    // Model was removed from the catalog — drop its stats instead of
    // resurrecting a row in model_overrides.
    if (known && !known.has(modelId)) {
      stats.delete(modelId);
      continue;
    }
    upsert.run(modelId, now, Math.round(stat.avgTps * 10) / 10, stat.samples, now);
  }
  refreshOverrideCache();
};

// Flush on shutdown so at most one interval of data is lost on restart.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    try { flushModelTpsStats(); } catch { /* best effort */ }
  });
}
