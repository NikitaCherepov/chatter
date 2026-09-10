import { db } from '../db.js';
import { migrateLegacyQuotaPeriods } from './monthly-usage.js';

type Migration = {
  name: string;
  run: () => void;
};

const MIGRATIONS: Migration[] = [
  {
    // Transfers legacy users.monthly_* quota state into user_plan_quota_periods.
    // Idempotent per user: existing runtime-created periods are never rewritten.
    name: '0001_user_plan_quota_periods',
    run: migrateLegacyQuotaPeriods,
  },
];

/**
 * Versioned schema migrations. Each migration runs exactly once, as a single
 * transaction together with its bookkeeping row; a failure rolls back both
 * the migration body and the schema_migrations insert.
 */
export const runMigrations = (): { applied: string[] } => {
  const applied: string[] = [];
  for (const migration of MIGRATIONS) {
    const done = db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(migration.name);
    if (done) continue;
    db.transaction(() => {
      migration.run();
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(migration.name);
    })();
    applied.push(migration.name);
  }
  return { applied };
};
