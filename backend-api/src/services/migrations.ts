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

// Backfills tasks.target_mode / tasks.target_chat_id from the legacy
// ai_instruction payload JSON ({"instruction": ..., "_target_chat_id": ...,
// "_create_new_chat": true}). The payload wrapper is unwrapped into plain
// instruction text. target_mode is two-valued: 'chat' (deliver to
// target_chat_id; NULL means the user's active chat at run time — legacy
// fallback) and 'new_chat'. Rooms and foreign chats never were valid targets,
// so such legacy entries fall back to 'chat' with a NULL target.
const migrateTasksTargetMode = () => {
  const rows = db.prepare(`
    SELECT id, user_id, task_type, payload, target_mode, target_chat_id
    FROM tasks
    WHERE task_type = 'ai_instruction'
  `).all() as Array<{ id: number; user_id: number; task_type: string; payload: string; target_mode: string; target_chat_id: number | null }>;

  for (const row of rows) {
    let targetMode: string | null = null;
    let targetChatId: number | null = null;
    let payload: string | null = null;

    try {
      const parsed = JSON.parse(row.payload);
      if (parsed && typeof parsed === 'object') {
        const instruction = typeof parsed.instruction === 'string'
          ? parsed.instruction
          : (typeof parsed._instruction === 'string' ? parsed._instruction : null);
        if (instruction !== null && instruction.trim()) payload = instruction;

        if (parsed._create_new_chat === true) {
          targetMode = 'new_chat';
        } else {
          targetMode = 'chat';
          if (Number.isFinite(Number(parsed._target_chat_id))) {
            const chatId = Math.floor(Number(parsed._target_chat_id));
            // Rooms and foreign chats are forbidden targets — validate ownership.
            const chat = db.prepare(`
              SELECT id FROM user_chats
              WHERE id = ? AND user_id = ? AND (room_enabled IS NULL OR room_enabled = 0)
            `).get(chatId, row.user_id) as { id: number } | undefined;
            if (chat) targetChatId = chatId;
          }
        }
      }
    } catch {
      // Plain-text payload — no legacy routing metadata, keep 'chat'.
    }

    if (targetMode === null) continue; // nothing to migrate for this row
    db.prepare('UPDATE tasks SET target_mode = ?, target_chat_id = ?, payload = ? WHERE id = ?')
      .run(targetMode, targetChatId, payload ?? row.payload, row.id);
  }
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

const migrateTasksNotify = () => {
  db.exec(`
    CREATE TABLE tasks_migrate (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      execute_at INTEGER NOT NULL,
      task_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      notify_mode TEXT,
      recurrence_type TEXT NOT NULL DEFAULT 'once',
      recurrence_weekday INTEGER,
      timezone_offset INTEGER,
      target_mode TEXT NOT NULL DEFAULT 'chat',
      target_chat_id INTEGER,
      redirect_notify INTEGER NOT NULL DEFAULT 1,
      allowed_tools TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
    )
  `);
  db.exec(`
    INSERT INTO tasks_migrate (id, user_id, execute_at, task_type, payload, notify_mode, recurrence_type, recurrence_weekday, timezone_offset, target_mode, target_chat_id, redirect_notify, allowed_tools, status)
    SELECT id, user_id, execute_at, task_type, payload,
      CASE WHEN notify_mode IN ('always', 'never', 'on_error') THEN notify_mode ELSE 'always' END,
      recurrence_type, recurrence_weekday, timezone_offset, target_mode, target_chat_id, COALESCE(redirect_notify, 1), allowed_tools, status
    FROM tasks
  `);
  db.exec('DROP TABLE tasks');
  db.exec('ALTER TABLE tasks_migrate RENAME TO tasks');
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
  {
    // Unwraps legacy ai_instruction payload JSON into tasks.target_mode /
    // tasks.target_chat_id columns (added to the tasks schema in db.ts).
    name: '0003_tasks_target_mode',
    run: migrateTasksTargetMode,
  },
  {
    // notify_mode: NULL | 'always' | 'never' | 'on_error' (NULL only for ai_instruction).
    name: '0004_tasks_notify',
    run: migrateTasksNotify,
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
