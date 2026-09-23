import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const databasePath = path.join(os.tmpdir(), `chatter-memory-schema-${process.pid}-${Date.now()}.sqlite`);
const legacy = new Database(databasePath);
legacy.exec(`
  CREATE TABLE memory_spaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('general', 'chat')),
    chat_id INTEGER,
    namespace_key TEXT NOT NULL UNIQUE,
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    archived_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO memory_spaces (
    user_id, name, kind, chat_id, namespace_key, is_default, archived_at, created_at, updated_at
  ) VALUES
    (77, 'Main memory', 'general', NULL, '77', 0, NULL, 1, 1),
    (77, 'Selected memory', 'general', NULL, 'account-77-general-custom', 1, NULL, 2, 2);
`);
legacy.close();

process.env.API_DB_PATH = databasePath;
const { db } = await import('../src/db.js');

const columns = db.prepare('PRAGMA table_info(memory_spaces)').all() as Array<{ name: string }>;
assert.equal(columns.some(column => column.name === 'is_primary'), true, 'migration adds is_primary');
const spaces = db.prepare(`
  SELECT name, is_default, is_primary FROM memory_spaces WHERE user_id = 77 ORDER BY id
`).all() as Array<{ name: string; is_default: number; is_primary: number }>;
assert.deepEqual(spaces, [
  { name: 'Main memory', is_default: 0, is_primary: 1 },
  { name: 'Selected memory', is_default: 1, is_primary: 0 },
]);

console.log('memory schema migration tests passed');
