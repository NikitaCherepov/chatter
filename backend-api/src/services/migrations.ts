import { db } from '../db.js';
import { migrateLegacyQuotaPeriods } from './monthly-usage.js';

type Migration = {
  name: string;
  run: () => void;
};

const tableHasColumn = (table: string, column: string) => {
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  return columns.some(item => item.name === column);
};

const dropColumnIfPresent = (table: string, column: string) => {
  if (!tableHasColumn(table, column)) return;
  db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
};

// Drops the legacy users quota columns; anchors quota_anchor_at from the legacy window first.
const dropLegacyQuotaUserColumns = () => {
  if (tableHasColumn('users', 'monthly_usage_window_started_at')) {
    db.exec(`
      UPDATE user_plan_subscriptions
      SET quota_anchor_at = COALESCE(
        (SELECT NULLIF(monthly_usage_window_started_at, 0) FROM users WHERE users.id = user_plan_subscriptions.user_id),
        unixepoch(started_at),
        unixepoch()
      )
      WHERE quota_anchor_at IS NULL OR quota_anchor_at <= 0
    `);
  }
  const legacyColumns = [
    'monthly_usage_window_started_at',
    'monthly_web_search_count', 'monthly_web_search_limit',
    'monthly_web_reader_count', 'monthly_web_reader_limit',
    'monthly_image_gen_count', 'monthly_image_gen_limit',
    'daily_web_search_count', 'daily_web_search_limit',
    'daily_web_reader_count', 'daily_web_reader_limit',
    'daily_image_gen_count', 'daily_image_gen_limit',
  ];
  for (const column of legacyColumns) dropColumnIfPresent('users', column);
};

const MIGRATIONS: Migration[] = [
  {
    // Transfers legacy users.monthly_* quota state into user_plan_quota_periods.
    // Idempotent per user: existing runtime-created periods are never rewritten.
    name: '0001_user_plan_quota_periods',
    run: migrateLegacyQuotaPeriods,
  },
  {
    // Runs after 0001, so the legacy state is transferred before the columns disappear.
    name: '0002_drop_legacy_quota_user_columns',
    run: dropLegacyQuotaUserColumns,
  },
];

/**
 * Versioned schema migrations. Each migration runs exactly once, as a single
 * transaction together with its bookkeeping row; a failure rolls back both
 * the migration body and the schema_migrations insert.
 *
 * `stopAfter` stops right after applying the named migration (used by tests).
 */
export const runMigrations = (options?: { stopAfter?: string }): { applied: string[] } => {
  const applied: string[] = [];
  for (const migration of MIGRATIONS) {
    const done = db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(migration.name);
    if (done) continue;
    db.transaction(() => {
      migration.run();
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(migration.name);
    })();
    applied.push(migration.name);
    if (options?.stopAfter === migration.name) break;
  }
  return { applied };
};
