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

// backend-api owns the persistent schema. Other clients (Telegram/Electron)
// must use the API instead of creating or migrating these tables themselves.
const usersTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get() as { name: string } | undefined;
if (usersTable) {
  const columns = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'id')) {
    db.exec(`ALTER TABLE users RENAME TO users_legacy_${Date.now()}`);
  }
}

const messagesTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_messages'").get() as { name: string } | undefined;
if (messagesTable) {
  const columns = db.prepare('PRAGMA table_info(chat_messages)').all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'user_id')) {
    db.exec(`ALTER TABLE chat_messages RENAME TO chat_messages_legacy_${Date.now()}`);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'approved',
    plan TEXT NOT NULL DEFAULT 'free',
    language TEXT,
    selected_prompt_id INTEGER,
    custom_prompt_content TEXT,
    core_memory TEXT DEFAULT '',
    imap_provider TEXT,
    imap_user TEXT,
    imap_pass TEXT,
    imap_host TEXT,
    imap_port INTEGER DEFAULT 993,
    imap_secure INTEGER DEFAULT 1,
    active_chat_id INTEGER,
    daily_message_count INTEGER NOT NULL DEFAULT 0,
    daily_message_limit INTEGER NOT NULL DEFAULT 0,
    context_window INTEGER NOT NULL DEFAULT 20,
    context_window_max INTEGER NOT NULL DEFAULT 20,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    chat_id INTEGER,
    telegram_chat_id INTEGER,
    telegram_message_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_chat_messages_user_id_id
  ON chat_messages(user_id, id);

  CREATE TABLE IF NOT EXISTS user_chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_user_chats_user_id_id
  ON user_chats(user_id, id DESC);

  CREATE TABLE IF NOT EXISTS prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bans (
    user_id INTEGER PRIMARY KEY,
    reason TEXT NOT NULL,
    banned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    banned_by INTEGER
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    execute_at INTEGER NOT NULL,
    task_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    notify_mode TEXT NOT NULL DEFAULT 'always',
    notify_condition TEXT,
    recurrence_type TEXT NOT NULL DEFAULT 'once',
    recurrence_weekday INTEGER,
    timezone_offset INTEGER,
    status TEXT NOT NULL DEFAULT 'pending'
  );

  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_notes_user_created ON notes(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notes_user_id_desc ON notes(user_id, id DESC);

  CREATE TABLE IF NOT EXISTS mail_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    label TEXT,
    email TEXT NOT NULL,
    imap_user TEXT NOT NULL,
    imap_pass TEXT NOT NULL,
    imap_host TEXT NOT NULL,
    imap_port INTEGER NOT NULL DEFAULT 993,
    imap_secure INTEGER NOT NULL DEFAULT 1,
    smtp_host TEXT NOT NULL,
    smtp_port INTEGER NOT NULL DEFAULT 465,
    smtp_secure INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_plan_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    plan TEXT NOT NULL CHECK(plan IN ('free', 'standart', 'pro')),
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ends_at DATETIME,
    is_current INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0, 1)),
    assigned_by INTEGER,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_user_plan_subscriptions_user_id
  ON user_plan_subscriptions(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_plan_subscriptions_current
  ON user_plan_subscriptions(user_id, is_current, ends_at);
`);

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

const hasTaskColumn = (columnName: string) => {
  const columns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
  return columns.some(column => column.name === columnName);
};

const ensureTaskColumn = (name: string, sql: string) => {
  if (!hasTaskColumn(name)) db.exec(sql);
};

const hasPromptColumn = (columnName: string) => {
  const columns = db.prepare('PRAGMA table_info(prompts)').all() as Array<{ name: string }>;
  return columns.some(column => column.name === columnName);
};

if (!hasUserColumn('is_admin')) {
  db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
}

ensureUserColumn('name', 'ALTER TABLE users ADD COLUMN name TEXT');
ensureUserColumn('role', "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
ensureUserColumn('selected_prompt_id', 'ALTER TABLE users ADD COLUMN selected_prompt_id INTEGER');
ensureUserColumn('custom_prompt_content', 'ALTER TABLE users ADD COLUMN custom_prompt_content TEXT');
ensureUserColumn('core_memory', "ALTER TABLE users ADD COLUMN core_memory TEXT DEFAULT ''");
ensureUserColumn('imap_provider', 'ALTER TABLE users ADD COLUMN imap_provider TEXT');
ensureUserColumn('imap_user', 'ALTER TABLE users ADD COLUMN imap_user TEXT');
ensureUserColumn('imap_pass', 'ALTER TABLE users ADD COLUMN imap_pass TEXT');
ensureUserColumn('imap_host', 'ALTER TABLE users ADD COLUMN imap_host TEXT');
ensureUserColumn('imap_port', 'ALTER TABLE users ADD COLUMN imap_port INTEGER DEFAULT 993');
ensureUserColumn('imap_secure', 'ALTER TABLE users ADD COLUMN imap_secure INTEGER DEFAULT 1');
ensureUserColumn('active_mail_account_id', 'ALTER TABLE users ADD COLUMN active_mail_account_id INTEGER');
ensureUserColumn('active_chat_id', 'ALTER TABLE users ADD COLUMN active_chat_id INTEGER');
ensureUserColumn('status', "ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'");
ensureUserColumn('plan', "ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'");
ensureUserColumn('created_at', 'ALTER TABLE users ADD COLUMN created_at DATETIME');
ensureUserColumn('daily_message_count', 'ALTER TABLE users ADD COLUMN daily_message_count INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('daily_message_limit', 'ALTER TABLE users ADD COLUMN daily_message_limit INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('context_window', 'ALTER TABLE users ADD COLUMN context_window INTEGER NOT NULL DEFAULT 20');
ensureUserColumn('context_window_max', 'ALTER TABLE users ADD COLUMN context_window_max INTEGER NOT NULL DEFAULT 20');
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
ensureUserColumn('reasoning_level', 'ALTER TABLE users ADD COLUMN reasoning_level TEXT');
ensureUserColumn('model_settings', 'ALTER TABLE users ADD COLUMN model_settings TEXT');
ensureUserColumn('ui_settings', 'ALTER TABLE users ADD COLUMN ui_settings TEXT');
ensureUserColumn('language', 'ALTER TABLE users ADD COLUMN language TEXT');
ensureUserColumn('subagent_mode', "ALTER TABLE users ADD COLUMN subagent_mode TEXT NOT NULL DEFAULT 'auto'");
ensureUserColumn('subagent_reasoning_level', 'ALTER TABLE users ADD COLUMN subagent_reasoning_level TEXT');
ensureUserColumn('auth_token_version', 'ALTER TABLE users ADD COLUMN auth_token_version INTEGER NOT NULL DEFAULT 0');

const mailAccountColumns = db.prepare('PRAGMA table_info(mail_accounts)').all() as Array<{ name: string }>;
if (!mailAccountColumns.some(column => column.name === 'smtp_host')) {
  db.transaction(() => {
    db.exec(`
      DROP INDEX IF EXISTS idx_mail_accounts_user_email;
      CREATE TABLE mail_accounts_next (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        label TEXT,
        email TEXT NOT NULL,
        imap_user TEXT NOT NULL,
        imap_pass TEXT NOT NULL,
        imap_host TEXT NOT NULL,
        imap_port INTEGER NOT NULL DEFAULT 993,
        imap_secure INTEGER NOT NULL DEFAULT 1,
        smtp_host TEXT NOT NULL,
        smtp_port INTEGER NOT NULL DEFAULT 465,
        smtp_secure INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO mail_accounts_next (
        id, user_id, provider, label, email, imap_user, imap_pass, imap_host, imap_port, imap_secure,
        smtp_host, smtp_port, smtp_secure, created_at, updated_at
      )
      SELECT
        id, user_id, provider, NULL, imap_user, imap_user, imap_pass, imap_host, imap_port, imap_secure,
        CASE
          WHEN lower(provider) = 'google' THEN 'smtp.gmail.com'
          WHEN lower(provider) = 'yandex' THEN 'smtp.yandex.com'
          ELSE replace(imap_host, 'imap', 'smtp')
        END,
        465,
        1,
        created_at,
        updated_at
      FROM mail_accounts;
      DROP TABLE mail_accounts;
      ALTER TABLE mail_accounts_next RENAME TO mail_accounts;
      CREATE UNIQUE INDEX idx_mail_accounts_user_email
      ON mail_accounts(user_id, lower(email));
    `);
  })();
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_accounts_user_email ON mail_accounts(user_id, lower(email))`);

ensureChatMessageColumn('telegram_chat_id', 'ALTER TABLE chat_messages ADD COLUMN telegram_chat_id INTEGER');
ensureChatMessageColumn('telegram_message_id', 'ALTER TABLE chat_messages ADD COLUMN telegram_message_id INTEGER');
ensureChatMessageColumn('chat_id', 'ALTER TABLE chat_messages ADD COLUMN chat_id INTEGER');
ensureChatMessageColumn('images', 'ALTER TABLE chat_messages ADD COLUMN images TEXT');
ensureChatMessageColumn('audio', 'ALTER TABLE chat_messages ADD COLUMN audio TEXT');
ensureChatMessageColumn('reasoning_content', 'ALTER TABLE chat_messages ADD COLUMN reasoning_content TEXT');
ensureChatMessageColumn('tool_calls_json', 'ALTER TABLE chat_messages ADD COLUMN tool_calls_json TEXT');
ensureChatMessageColumn('archived', 'ALTER TABLE chat_messages ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
ensureChatMessageColumn('archived_at', 'ALTER TABLE chat_messages ADD COLUMN archived_at DATETIME');
// Token accounting (фаза 1: отображение). token_count не включает reasoning_content.
ensureChatMessageColumn('token_count', 'ALTER TABLE chat_messages ADD COLUMN token_count INTEGER NOT NULL DEFAULT 0');
ensureChatMessageColumn('reasoning_tokens', 'ALTER TABLE chat_messages ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0');
// Exact provider usage and response metadata (local token_count remains the context-trimming weight).
ensureChatMessageColumn('usage_json', 'ALTER TABLE chat_messages ADD COLUMN usage_json TEXT');
ensureChatMessageColumn('prompt_name', 'ALTER TABLE chat_messages ADD COLUMN prompt_name TEXT');
ensureChatMessageColumn('model_name', 'ALTER TABLE chat_messages ADD COLUMN model_name TEXT');
ensureChatMessageColumn('provider_name', 'ALTER TABLE chat_messages ADD COLUMN provider_name TEXT');
// Attachments (documents) — text files injected into AI context
ensureChatMessageColumn('attachments', 'ALTER TABLE chat_messages ADD COLUMN attachments TEXT');
// Subagent traces — полные trace ad-hoc субагентов для UI-отображения (не уходит в AI-контекст)
ensureChatMessageColumn('subagents_json', 'ALTER TABLE chat_messages ADD COLUMN subagents_json TEXT');

ensureTaskColumn('recurrence_type', "ALTER TABLE tasks ADD COLUMN recurrence_type TEXT NOT NULL DEFAULT 'once'");
ensureTaskColumn('recurrence_weekday', 'ALTER TABLE tasks ADD COLUMN recurrence_weekday INTEGER');
ensureTaskColumn('timezone_offset', 'ALTER TABLE tasks ADD COLUMN timezone_offset INTEGER');
ensureTaskColumn('notify_mode', "ALTER TABLE tasks ADD COLUMN notify_mode TEXT NOT NULL DEFAULT 'always'");
ensureTaskColumn('notify_condition', 'ALTER TABLE tasks ADD COLUMN notify_condition TEXT');
if (!hasPromptColumn('description')) {
  db.exec("ALTER TABLE prompts ADD COLUMN description TEXT NOT NULL DEFAULT ''");
}

db.exec(`
  UPDATE users SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL;
  UPDATE users SET status = 'approved' WHERE status IS NULL OR status = '';
  UPDATE users SET plan = 'free' WHERE plan IS NULL OR plan = '' OR plan NOT IN ('free', 'standart', 'pro');
  UPDATE users SET daily_message_count = 0 WHERE daily_message_count IS NULL;
  UPDATE users SET daily_message_limit = 0 WHERE daily_message_limit IS NULL OR daily_message_limit < 0;
  UPDATE users SET total_message_length = 0 WHERE total_message_length IS NULL;
  UPDATE users SET daily_tokens_used = 0 WHERE daily_tokens_used IS NULL;
  UPDATE users SET total_tokens_used = 0 WHERE total_tokens_used IS NULL;
  UPDATE users SET daily_cost_rub = 0 WHERE daily_cost_rub IS NULL;
  UPDATE users SET total_cost_rub = 0 WHERE total_cost_rub IS NULL;
  UPDATE users SET daily_web_search_count = 0 WHERE daily_web_search_count IS NULL;
  UPDATE users SET daily_web_search_limit = 10 WHERE daily_web_search_limit IS NULL OR daily_web_search_limit < 0;
  UPDATE users SET total_web_search_count = 0 WHERE total_web_search_count IS NULL;
  UPDATE users SET core_memory = '' WHERE core_memory IS NULL;
  UPDATE users SET imap_port = 993 WHERE imap_port IS NULL OR imap_port <= 0;
  UPDATE users SET imap_secure = 1 WHERE imap_secure IS NULL;
  UPDATE users SET mail_check_limit = 10 WHERE mail_check_limit IS NULL OR mail_check_limit <= 0;
  UPDATE users SET context_window = 20 WHERE context_window IS NULL OR context_window <= 0;
  UPDATE users SET context_window_max = 20 WHERE context_window_max IS NULL OR context_window_max <= 0;
  CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

  INSERT INTO mail_accounts (
    user_id, provider, email, imap_user, imap_pass, imap_host, imap_port, imap_secure,
    smtp_host, smtp_port, smtp_secure
  )
  SELECT
    id,
    CASE
      WHEN lower(COALESCE(imap_provider, '')) = 'google' OR lower(COALESCE(imap_host, '')) LIKE '%gmail%' THEN 'google'
      ELSE 'yandex'
    END,
    imap_user,
    imap_user,
    imap_pass,
    COALESCE(imap_host, 'imap.yandex.ru'),
    COALESCE(imap_port, 993),
    COALESCE(imap_secure, 1),
    CASE
      WHEN lower(COALESCE(imap_provider, '')) = 'google' OR lower(COALESCE(imap_host, '')) LIKE '%gmail%' THEN 'smtp.gmail.com'
      ELSE 'smtp.yandex.com'
    END,
    465,
    1
  FROM users
  WHERE imap_user IS NOT NULL AND imap_user <> '' AND imap_pass IS NOT NULL AND imap_pass <> ''
    AND NOT EXISTS (
      SELECT 1 FROM mail_accounts existing
      WHERE existing.user_id = users.id AND lower(existing.email) = lower(users.imap_user)
    );

  UPDATE users
  SET active_mail_account_id = COALESCE(
    active_mail_account_id,
    (
      SELECT account.id
      FROM mail_accounts account
      WHERE account.user_id = users.id
      ORDER BY
        CASE WHEN lower(account.provider) = lower(COALESCE(users.imap_provider, '')) THEN 0 ELSE 1 END,
        account.id ASC
      LIMIT 1
    )
  );
`);

// Index for efficient filtering: active (non-archived) messages per chat
if (!db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_chat_messages_active'").get()) {
  db.exec("CREATE INDEX IF NOT EXISTS idx_chat_messages_active ON chat_messages(user_id, chat_id, archived, id DESC)");
}

db.exec("UPDATE users SET is_admin = 1 WHERE role = 'admin'");

db.exec(`
  CREATE TABLE IF NOT EXISTS account_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    provider_subject TEXT NOT NULL,
    username TEXT,
    password_salt TEXT,
    password_hash TEXT,
    metadata_json TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(provider, provider_subject)
  )
`);

db.exec("CREATE INDEX IF NOT EXISTS idx_account_identities_account ON account_identities(account_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_account_identities_provider ON account_identities(provider, provider_subject)");

db.exec(`
  CREATE TABLE IF NOT EXISTS account_redirects (
    source_account_id INTEGER PRIMARY KEY,
    target_account_id INTEGER NOT NULL,
    source_auth_token_version INTEGER NOT NULL DEFAULT 0,
    source_status TEXT NOT NULL DEFAULT 'approved',
    source_is_admin INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT 'account_merge',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec("CREATE INDEX IF NOT EXISTS idx_account_redirects_target ON account_redirects(target_account_id)");

db.exec(`
  CREATE TABLE IF NOT EXISTS account_namespace_migrations (
    source_account_id INTEGER PRIMARY KEY,
    target_account_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
  )
`);

db.exec("CREATE INDEX IF NOT EXISTS idx_account_namespace_migrations_target ON account_namespace_migrations(target_account_id, status)");

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

// Token-based context limit (replaces message-count-based context_window_max)
ensureUserColumn('max_context_tokens_limit', 'ALTER TABLE users ADD COLUMN max_context_tokens_limit INTEGER NOT NULL DEFAULT 30000');
ensureUserColumn('max_context_tokens', 'ALTER TABLE users ADD COLUMN max_context_tokens INTEGER NOT NULL DEFAULT 30000');
// Attachment token limit (0 = auto: 90% of max_context_tokens)
ensureUserColumn('attachment_max_tokens', 'ALTER TABLE users ADD COLUMN attachment_max_tokens INTEGER NOT NULL DEFAULT 0');

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

// ── User custom prompts ──────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS user_prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec("CREATE INDEX IF NOT EXISTS idx_user_prompts_user ON user_prompts(user_id)");

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

