import { db, getNowUnix } from '../db.js';

export type MacroRow = {
  id: number;
  title: string;
  description: string;
  commands: string[];
  enabled: boolean;
  pinned: boolean;
  created_at: number;
  updated_at: number;
};

type MacroDbRow = {
  id: number;
  title: string;
  description: string;
  commands: string; // JSON string
  enabled: number;
  pinned: number;
  created_at: number;
  updated_at: number;
};

const MACROS_LIMIT = 50;

const parseMacroRow = (row: MacroDbRow): MacroRow => ({
  id: row.id,
  title: row.title,
  description: row.description,
  commands: JSON.parse(row.commands || '[]'),
  enabled: row.enabled === 1,
  pinned: row.pinned === 1,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

export const listMacros = (userId: number): MacroRow[] => {
  const rows = db.prepare(`
    SELECT id, title, description, commands, enabled, pinned, created_at, updated_at
    FROM macros
    WHERE user_id = ?
    ORDER BY pinned DESC, updated_at DESC
    LIMIT ?
  `).all(userId, MACROS_LIMIT) as MacroDbRow[];
  return rows.map(parseMacroRow);
};

export const getEnabledMacros = (userId: number): MacroRow[] => {
  const rows = db.prepare(`
    SELECT id, title, description, commands, enabled, pinned, created_at, updated_at
    FROM macros
    WHERE user_id = ? AND enabled = 1
    ORDER BY pinned DESC, updated_at DESC
  `).all(userId) as MacroDbRow[];
  return rows.map(parseMacroRow);
};

export const getMacroById = (userId: number, macroId: number): MacroRow | null => {
  const row = db.prepare(`
    SELECT id, title, description, commands, enabled, pinned, created_at, updated_at
    FROM macros
    WHERE user_id = ? AND id = ?
  `).get(userId, macroId) as MacroDbRow | undefined;
  return row ? parseMacroRow(row) : null;
};

export const createMacro = (
  userId: number,
  title: string,
  description: string,
  commands: string[],
  enabled: boolean,
  pinned: boolean,
): { ok: true; id: number } | { ok: false; error: string } => {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) return { ok: false, error: 'title_required' };
  if (trimmedTitle.length > 100) return { ok: false, error: 'title_too_long' };
  if (description.length > 500) return { ok: false, error: 'description_too_long' };
  if (!Array.isArray(commands) || commands.length === 0) return { ok: false, error: 'commands_required' };
  if (commands.length > 30) return { ok: false, error: 'too_many_commands' };

  // Check limit
  const count = (db.prepare('SELECT COUNT(*) as cnt FROM macros WHERE user_id = ?').get(userId) as any).cnt;
  if (count >= MACROS_LIMIT) return { ok: false, error: 'macros_limit' };

  const now = getNowUnix();
  const commandsJson = JSON.stringify(commands);

  const result = db.prepare(`
    INSERT INTO macros (user_id, title, description, commands, enabled, pinned, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, trimmedTitle, description.trim(), commandsJson, enabled ? 1 : 0, pinned ? 1 : 0, now, now);

  return { ok: true, id: Number(result.lastInsertRowid) };
};

export const updateMacro = (
  userId: number,
  macroId: number,
  updates: { title?: string; description?: string; commands?: string[]; enabled?: boolean; pinned?: boolean },
): { ok: true } | { ok: false; error: string } => {
  const existing = getMacroById(userId, macroId);
  if (!existing) return { ok: false, error: 'not_found' };

  const title = updates.title !== undefined ? updates.title.trim() : existing.title;
  const description = updates.description !== undefined ? updates.description.trim() : existing.description;
  const commands = updates.commands !== undefined ? updates.commands : existing.commands;
  const enabled = updates.enabled !== undefined ? updates.enabled : existing.enabled;
  const pinned = updates.pinned !== undefined ? updates.pinned : existing.pinned;

  if (!title) return { ok: false, error: 'title_required' };
  if (title.length > 100) return { ok: false, error: 'title_too_long' };
  if (description.length > 500) return { ok: false, error: 'description_too_long' };
  if (!Array.isArray(commands) || commands.length === 0) return { ok: false, error: 'commands_required' };

  const now = getNowUnix();
  db.prepare(`
    UPDATE macros SET title = ?, description = ?, commands = ?, enabled = ?, pinned = ?, updated_at = ?
    WHERE user_id = ? AND id = ?
  `).run(title, description, JSON.stringify(commands), enabled ? 1 : 0, pinned ? 1 : 0, now, userId, macroId);

  return { ok: true };
};

export const deleteMacro = (userId: number, macroId: number): boolean => {
  const result = db.prepare('DELETE FROM macros WHERE user_id = ? AND id = ?').run(userId, macroId);
  return result.changes > 0;
};
