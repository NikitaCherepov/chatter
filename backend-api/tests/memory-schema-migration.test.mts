import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const databasePath = path.join(os.tmpdir(), `chatter-memory-schema-${process.pid}-${Date.now()}.sqlite`);
const legacy = new Database(databasePath);
legacy.exec(`
  CREATE TABLE chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    chat_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  INSERT INTO chat_messages (id, user_id, role, content, chat_id)
  VALUES (42, 77, 'user', 'legacy message', 9);

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

  CREATE TABLE memory_records (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    memory_space_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  INSERT INTO memory_records (id, user_id, memory_space_id, text, source, created_at, updated_at)
  VALUES ('legacy-memory', 77, 1, 'legacy', 'automatic', 1, 1);
`);
legacy.close();

process.env.API_DB_PATH = databasePath;
const { db } = await import('../src/db.js');

const columns = db.prepare('PRAGMA table_info(memory_spaces)').all() as Array<{ name: string }>;
assert.equal(columns.some(column => column.name === 'is_primary'), true, 'migration adds is_primary');
const memoryRecordColumns = db.prepare('PRAGMA table_info(memory_records)').all() as Array<{ name: string }>;
assert.equal(
  memoryRecordColumns.some(column => column.name === 'origin_message_cursor'),
  true,
  'migration adds memory provenance cursor',
);
const chatMessageColumns = db.prepare('PRAGMA table_info(chat_messages)').all() as Array<{ name: string }>;
assert.equal(
  chatMessageColumns.some(column => column.name === 'timeline_index'),
  true,
  'migration adds stable chat timeline index',
);
assert.equal(
  (db.prepare('SELECT timeline_index FROM chat_messages WHERE id = 42').get() as { timeline_index: number }).timeline_index,
  42,
  'migration backfills a stable cursor for existing messages',
);
const nextLegacyMessageId = Number(db.prepare(`
  INSERT INTO chat_messages (user_id, role, content, chat_id) VALUES (77, 'user', 'next', 9)
`).run().lastInsertRowid);
assert.equal(
  (db.prepare('SELECT timeline_index FROM chat_messages WHERE id = ?').get(nextLegacyMessageId) as { timeline_index: number }).timeline_index,
  43,
  'new messages continue after the migrated timeline cursor',
);
assert.equal(
  (db.prepare("SELECT origin_message_cursor FROM memory_records WHERE id = 'legacy-memory'").get() as { origin_message_cursor: number | null }).origin_message_cursor,
  null,
  'legacy memories remain valid manual/unknown-origin memories',
);
const spaces = db.prepare(`
  SELECT name, is_default, is_primary FROM memory_spaces WHERE user_id = 77 ORDER BY id
`).all() as Array<{ name: string; is_default: number; is_primary: number }>;
assert.deepEqual(spaces, [
  { name: 'Main memory', is_default: 0, is_primary: 1 },
  { name: 'Selected memory', is_default: 1, is_primary: 0 },
]);

console.log('memory schema migration tests passed');
