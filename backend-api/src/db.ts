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
ensureUserColumn('timezone_offset', 'ALTER TABLE users ADD COLUMN timezone_offset INTEGER');
ensureUserColumn('timezone_confirmed', 'ALTER TABLE users ADD COLUMN timezone_confirmed INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('total_message_length', 'ALTER TABLE users ADD COLUMN total_message_length INTEGER NOT NULL DEFAULT 0');

ensureChatMessageColumn('telegram_chat_id', 'ALTER TABLE chat_messages ADD COLUMN telegram_chat_id INTEGER');
ensureChatMessageColumn('telegram_message_id', 'ALTER TABLE chat_messages ADD COLUMN telegram_message_id INTEGER');

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

