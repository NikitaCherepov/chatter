import { db } from './db';

export type NoteRow = {
  id: number;
  user_id: number;
  title: string;
  content: string;
  created_at: number;
  updated_at: number;
};

export const listNotes = (userId: number, query: string, limit: number, offset: number) => {
  const cleanQuery = query.trim();
  if (!cleanQuery) {
    const items = db.prepare(`
      SELECT id, user_id, title, content, created_at, updated_at
      FROM notes
      WHERE user_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(userId, limit, offset) as NoteRow[];

    const total = (db.prepare('SELECT COUNT(*) as c FROM notes WHERE user_id = ?').get(userId) as { c: number }).c;
    return { items, total };
  }

  const like = `%${cleanQuery}%`;
  const items = db.prepare(`
    SELECT id, user_id, title, content, created_at, updated_at
    FROM notes
    WHERE user_id = ? AND (title LIKE ? OR content LIKE ?)
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(userId, like, like, limit, offset) as NoteRow[];

  const total = (db.prepare(`
    SELECT COUNT(*) as c
    FROM notes
    WHERE user_id = ? AND (title LIKE ? OR content LIKE ?)
  `).get(userId, like, like) as { c: number }).c;

  return { items, total };
};

export const createNote = (userId: number, title: string, content: string) => {
  const now = Math.floor(Date.now() / 1000);
  const created = db.prepare(`
    INSERT INTO notes (user_id, title, content, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, title, content, now, now);

  return db.prepare(`
    SELECT id, user_id, title, content, created_at, updated_at
    FROM notes
    WHERE id = ? AND user_id = ?
  `).get(Number(created.lastInsertRowid), userId) as NoteRow;
};

export const deleteNote = (userId: number, noteId: number) => {
  const result = db.prepare('DELETE FROM notes WHERE user_id = ? AND id = ?').run(userId, noteId);
  return result.changes > 0;
};
