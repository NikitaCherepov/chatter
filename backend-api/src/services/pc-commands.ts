/**
 * PC Commands — backend service for managing user's local PC command execution.
 * Settings (fs_scan_enabled, auto_approve_all) and auto-approve policies.
 * Used by ai.ts (execute_pc_command tool) and server.ts (REST endpoints).
 */
import { db, getNowUnix } from '../db.js';

// ── Ensure tables ──────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS pc_commands_settings (
    user_id INTEGER PRIMARY KEY,
    fs_scan_enabled INTEGER NOT NULL DEFAULT 0,
    auto_approve_all INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )
`);

// Migration: add file_read_enabled column (default 1 — allow reads without confirmation by default)
try {
  db.exec(`ALTER TABLE pc_commands_settings ADD COLUMN file_read_enabled INTEGER NOT NULL DEFAULT 1`);
} catch (_e) {
  // Column already exists
}

db.exec(`
  CREATE TABLE IF NOT EXISTS pc_commands_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    pattern TEXT NOT NULL,
    auto_approve INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_pc_commands_policies_user ON pc_commands_policies(user_id)');

// ── Types ──────────────────────────────────────────────────────────────────

export type PcCommandsSettings = {
  fs_scan_enabled: boolean;
  auto_approve_all: boolean;
  file_read_enabled: boolean;
};

export type PcCommandPolicy = {
  id: number;
  pattern: string;
  auto_approve: boolean;
  created_at: number;
};

// ── Settings CRUD ──────────────────────────────────────────────────────────

export const getPcCommandsSettings = (userId: number): PcCommandsSettings => {
  const row = db.prepare('SELECT fs_scan_enabled, auto_approve_all, file_read_enabled FROM pc_commands_settings WHERE user_id = ?').get(userId) as
    | { fs_scan_enabled: number; auto_approve_all: number; file_read_enabled: number }
    | undefined;
  if (!row) {
    return { fs_scan_enabled: false, auto_approve_all: false, file_read_enabled: true };
  }
  return {
    fs_scan_enabled: row.fs_scan_enabled === 1,
    auto_approve_all: row.auto_approve_all === 1,
    file_read_enabled: row.file_read_enabled === 1,
  };
};

export const updatePcCommandsSettings = (
  userId: number,
  updates: { fs_scan_enabled?: boolean; auto_approve_all?: boolean; file_read_enabled?: boolean },
): void => {
  const current = getPcCommandsSettings(userId);
  const fsScan = updates.fs_scan_enabled !== undefined ? updates.fs_scan_enabled : current.fs_scan_enabled;
  const autoApproveAll = updates.auto_approve_all !== undefined ? updates.auto_approve_all : current.auto_approve_all;
  const fileReadEnabled = updates.file_read_enabled !== undefined ? updates.file_read_enabled : current.file_read_enabled;
  const now = getNowUnix();

  db.prepare(`
    INSERT INTO pc_commands_settings (user_id, fs_scan_enabled, auto_approve_all, file_read_enabled, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      fs_scan_enabled = excluded.fs_scan_enabled,
      auto_approve_all = excluded.auto_approve_all,
      file_read_enabled = excluded.file_read_enabled,
      updated_at = excluded.updated_at
  `).run(userId, fsScan ? 1 : 0, autoApproveAll ? 1 : 0, fileReadEnabled ? 1 : 0, now);
};

// ── Policies CRUD ──────────────────────────────────────────────────────────

export const listPcCommandPolicies = (userId: number): PcCommandPolicy[] => {
  const rows = db.prepare(
    'SELECT id, pattern, auto_approve, created_at FROM pc_commands_policies WHERE user_id = ? ORDER BY created_at DESC',
  ).all(userId) as Array<{ id: number; pattern: string; auto_approve: number; created_at: number }>;
  return rows.map((r) => ({
    id: r.id,
    pattern: r.pattern,
    auto_approve: r.auto_approve === 1,
    created_at: r.created_at,
  }));
};

export const createPcCommandPolicy = (
  userId: number,
  pattern: string,
): { ok: true; id: number } | { ok: false; error: string } => {
  const trimmed = pattern.trim();
  if (!trimmed) return { ok: false, error: 'pattern_required' };

  // Validate regex
  try {
    new RegExp(trimmed);
  } catch {
    return { ok: false, error: 'invalid_regex' };
  }

  const now = getNowUnix();
  const result = db.prepare(
    'INSERT INTO pc_commands_policies (user_id, pattern, auto_approve, created_at) VALUES (?, ?, 1, ?)',
  ).run(userId, trimmed, now);

  return { ok: true, id: Number(result.lastInsertRowid) };
};

export const deletePcCommandPolicy = (userId: number, policyId: number): boolean => {
  const result = db.prepare('DELETE FROM pc_commands_policies WHERE user_id = ? AND id = ?').run(userId, policyId);
  return result.changes > 0;
};

/** Check if a command matches any auto-approve policy for the user */
export const isPcCommandAutoApproved = (userId: number, command: string): boolean => {
  const policies = db.prepare(
    'SELECT pattern FROM pc_commands_policies WHERE user_id = ? AND auto_approve = 1',
  ).all(userId) as Array<{ pattern: string }>;

  for (const p of policies) {
    try {
      const re = new RegExp(p.pattern);
      if (re.test(command)) return true;
    } catch {
      // skip invalid regex
    }
  }
  return false;
};
