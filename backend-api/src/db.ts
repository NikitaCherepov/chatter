import path from 'node:path';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config();

const backendApiRoot = path.resolve(__dirname, '..');
const defaultDbPath = path.resolve(backendApiRoot, '../chatter.db');
const resolvedDbPath = path.resolve(
  process.cwd(),
  process.env.API_DB_PATH || process.env.NOTES_DB_PATH || defaultDbPath
);

export const db = new Database(resolvedDbPath);

const hasUserColumn = (columnName: string) => {
  const columns = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  return columns.some(c => c.name === columnName);
};

const ensureUserColumn = (name: string, sql: string) => {
  if (!hasUserColumn(name)) db.exec(sql);
};

const hasChatMessageColumn = (columnName: string) => {
  const columns = db.prepare('PRAGMA table_info(chat_messages)').all() as Array<{ name: string }>;
  return columns.some(c => c.name === columnName);
};

const ensureChatMessageColumn = (name: string, sql: string) => {
  if (!hasChatMessageColumn(name)) db.exec(sql);
};

if (!hasUserColumn('is_admin')) {
  db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
}

ensureUserColumn('daily_tokens_used', 'ALTER TABLE users ADD COLUMN daily_tokens_used INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('total_tokens_used', 'ALTER TABLE users ADD COLUMN total_tokens_used INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('daily_cost_rub', 'ALTER TABLE users ADD COLUMN daily_cost_rub REAL NOT NULL DEFAULT 0');
ensureUserColumn('total_cost_rub', 'ALTER TABLE users ADD COLUMN total_cost_rub REAL NOT NULL DEFAULT 0');
ensureUserColumn('daily_web_search_count', 'ALTER TABLE users ADD COLUMN daily_web_search_count INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('daily_web_search_limit', 'ALTER TABLE users ADD COLUMN daily_web_search_limit INTEGER NOT NULL DEFAULT 10');
ensureUserColumn('total_web_search_count', 'ALTER TABLE users ADD COLUMN total_web_search_count INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('mail_check_limit', 'ALTER TABLE users ADD COLUMN mail_check_limit INTEGER NOT NULL DEFAULT 10');
ensureUserColumn('daily_image_gen_count', 'ALTER TABLE users ADD COLUMN daily_image_gen_count INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('daily_image_gen_limit', 'ALTER TABLE users ADD COLUMN daily_image_gen_limit INTEGER NOT NULL DEFAULT 3');
ensureUserColumn('total_image_gen_count', 'ALTER TABLE users ADD COLUMN total_image_gen_count INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('timezone_offset', 'ALTER TABLE users ADD COLUMN timezone_offset INTEGER');
ensureUserColumn('timezone_confirmed', 'ALTER TABLE users ADD COLUMN timezone_confirmed INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('total_message_length', 'ALTER TABLE users ADD COLUMN total_message_length INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('preferred_model', 'ALTER TABLE users ADD COLUMN preferred_model TEXT');
ensureUserColumn('feature_flags', 'ALTER TABLE users ADD COLUMN feature_flags TEXT');

ensureChatMessageColumn('telegram_chat_id', 'ALTER TABLE chat_messages ADD COLUMN telegram_chat_id INTEGER');
ensureChatMessageColumn('telegram_message_id', 'ALTER TABLE chat_messages ADD COLUMN telegram_message_id INTEGER');
ensureChatMessageColumn('images', 'ALTER TABLE chat_messages ADD COLUMN images TEXT');
ensureChatMessageColumn('audio', 'ALTER TABLE chat_messages ADD COLUMN audio TEXT');
ensureChatMessageColumn('reasoning_content', 'ALTER TABLE chat_messages ADD COLUMN reasoning_content TEXT');
ensureChatMessageColumn('tool_calls_json', 'ALTER TABLE chat_messages ADD COLUMN tool_calls_json TEXT');
ensureChatMessageColumn('archived', 'ALTER TABLE chat_messages ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
ensureChatMessageColumn('archived_at', 'ALTER TABLE chat_messages ADD COLUMN archived_at DATETIME');

// Index for efficient filtering: active (non-archived) messages per chat
if (!db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_chat_messages_active'").get()) {
  db.exec("CREATE INDEX IF NOT EXISTS idx_chat_messages_active ON chat_messages(user_id, chat_id, archived, id DESC)");
}

db.exec("UPDATE users SET is_admin = 1 WHERE role = 'admin'");

db.exec(`
  CREATE TABLE IF NOT EXISTS api_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    login TEXT NOT NULL UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec("CREATE INDEX IF NOT EXISTS idx_api_accounts_login ON api_accounts(login)");

// Telegram link codes
db.exec(`
  CREATE TABLE IF NOT EXISTS telegram_link_codes (
    code TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )
`);

// Cleanup expired codes on startup
db.exec("DELETE FROM telegram_link_codes WHERE expires_at < unixepoch()");

// linked_tg_id column on users — stores TG user_id when linked
ensureUserColumn('linked_tg_id', 'ALTER TABLE users ADD COLUMN linked_tg_id INTEGER');

// ── FTS5 full-text search index on chat_messages ────────────────────────────

const hasFtsTable = () => {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'").all() as Array<{ name: string }>;
  return rows.length > 0;
};

if (!hasFtsTable()) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      user_id UNINDEXED,
      chat_id UNINDEXED,
      message_id UNINDEXED,
      tokenize="unicode61"
    )
  `);

  // Populate from existing messages
  db.exec(`
    INSERT INTO messages_fts(content, user_id, chat_id, message_id)
    SELECT content, user_id, chat_id, id
    FROM chat_messages
    WHERE content IS NOT NULL AND content != ''
  `);

  console.log('[fts5] messages_fts created and populated');
}

// Triggers: keep FTS in sync with chat_messages
const hasTrigger = (name: string) => {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name=?").all(name) as Array<{ name: string }>;
  return rows.length > 0;
};

if (!hasTrigger('trg_chat_messages_fts_ai') || !hasTrigger('trg_chat_messages_fts_ad')) {
  // At least one trigger missing — recreate both and rebuild FTS to catch any missed messages
  db.exec("DROP TRIGGER IF EXISTS trg_chat_messages_fts_ai");
  db.exec("DROP TRIGGER IF EXISTS trg_chat_messages_fts_ad");

  db.exec(`
    CREATE TRIGGER trg_chat_messages_fts_ai AFTER INSERT ON chat_messages BEGIN
      INSERT INTO messages_fts(content, user_id, chat_id, message_id)
      VALUES (new.content, new.user_id, new.chat_id, new.id);
    END
  `);

  db.exec(`
    CREATE TRIGGER trg_chat_messages_fts_ad AFTER DELETE ON chat_messages BEGIN
      DELETE FROM messages_fts WHERE message_id = old.id;
    END
  `);

  // Rebuild FTS from scratch to ensure consistency
  if (hasFtsTable()) {
    db.exec('DELETE FROM messages_fts');
    db.exec(`
      INSERT INTO messages_fts(content, user_id, chat_id, message_id)
      SELECT content, user_id, chat_id, id
      FROM chat_messages
      WHERE content IS NOT NULL AND content != ''
    `);
    console.log('[fts5] triggers missing — recreated, FTS rebuilt from chat_messages');
  }
}

export const toUnix = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed / 1000);
    }
  }
  return Math.floor(Date.now() / 1000);
};

export const getNowUnix = () => Math.floor(Date.now() / 1000);

// ── Macros table ──────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS macros (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    commands TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    pinned INTEGER NOT NULL DEFAULT 0,
    return_output INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

db.exec("CREATE INDEX IF NOT EXISTS idx_macros_user_id ON macros(user_id)");

// ── Safe migrations (add columns if missing) ──
try { db.exec("ALTER TABLE macros ADD COLUMN return_output INTEGER NOT NULL DEFAULT 0"); } catch { /* column already exists */ }

// ── Currency rates (CBR) ──────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS currency_rates (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    value REAL NOT NULL,
    prev_value REAL,
    nominal INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  )
`);

// ── TTS voice preview samples cache ──────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS tts_voice_previews (
    voice_id TEXT PRIMARY KEY,
    audio_url TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'ru',
    created_at INTEGER NOT NULL
  )
`);

