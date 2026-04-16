import { db } from '../db.js';
import type { NoteDto, UserPlan } from '../types.js';

const PLAN_NOTES_LIMITS: Record<UserPlan, number> = {
  free: 10,
  standart: 50,
  pro: 250
};

const PLAN_NOTE_CONTENT_LIMITS: Record<UserPlan, number> = {
  free: 400,
  standart: 800,
  pro: 3000
};

export const listNotes = (userId: number, limit = 20, offset = 0, query = ''): NoteDto[] => {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  const q = query.trim();

  let rows: Array<{ id: number; title: string; content: string; created_at: number; updated_at: number }>;
  if (!q) {
    rows = db.prepare(`
      SELECT id, title, content, created_at, updated_at
      FROM notes
      WHERE user_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(userId, safeLimit, safeOffset) as typeof rows;
  } else {
    const like = `%${q}%`;
    rows = db.prepare(`
      SELECT id, title, content, created_at, updated_at
      FROM notes
      WHERE user_id = ? AND (title LIKE ? OR content LIKE ?)
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(userId, like, like, safeLimit, safeOffset) as typeof rows;
  }

  return rows.map(r => ({
    id: r.id,
    title: r.title,
    content: r.content,
    created_at: Math.floor(r.created_at),
    updated_at: Math.floor(r.updated_at)
  }));
};

export const countNotes = (userId: number, query = '') => {
  const q = query.trim();
  if (!q) {
    return (db.prepare('SELECT COUNT(*) as c FROM notes WHERE user_id = ?').get(userId) as { c: number }).c;
  }
  const like = `%${q}%`;
  return (db.prepare('SELECT COUNT(*) as c FROM notes WHERE user_id = ? AND (title LIKE ? OR content LIKE ?)').get(userId, like, like) as { c: number }).c;
};

export const createNote = (userId: number, plan: UserPlan, title: string, content: string) => {
  const normalizedContent = (content || '').trim();
  const normalizedTitle = (title || '').trim();
  if (!normalizedContent) return { ok: false as const, error: 'content_required' };
  if (normalizedTitle.length > 120) return { ok: false as const, error: 'title_too_long' };
  if (normalizedContent.length > PLAN_NOTE_CONTENT_LIMITS[plan]) return { ok: false as const, error: 'content_too_long' };
  const currentCount = countNotes(userId);
  if (currentCount >= PLAN_NOTES_LIMITS[plan]) return { ok: false as const, error: 'notes_limit' };

  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(`
    INSERT INTO notes (user_id, title, content, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, normalizedTitle, normalizedContent, now, now);

  return { ok: true as const, id: Number(result.lastInsertRowid) };
};

export const deleteNote = (userId: number, noteId: number) => db
  .prepare('DELETE FROM notes WHERE user_id = ? AND id = ?')
  .run(userId, noteId)
  .changes > 0;
