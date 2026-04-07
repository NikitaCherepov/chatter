import Database from 'better-sqlite3';
import path from 'node:path';

const dbPath = process.env.NOTES_DB_PATH
  ? path.resolve(process.cwd(), process.env.NOTES_DB_PATH)
  : path.resolve(process.cwd(), '..', 'chatter.db');

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_notes_user_created
  ON notes(user_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_notes_user_id_desc
  ON notes(user_id, id DESC);
`);

export { db };
