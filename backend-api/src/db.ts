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
    folder_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_user_chats_user_id_id
  ON user_chats(user_id, id DESC);

  CREATE TABLE IF NOT EXISTS chat_agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    owner_user_id INTEGER NOT NULL,
    source_prompt_id INTEGER,
    name TEXT NOT NULL,
    prompt_content TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME
  );

  CREATE INDEX IF NOT EXISTS idx_chat_agents_chat_active_order
  ON chat_agents(chat_id, is_active, sort_order, id);

  CREATE INDEX IF NOT EXISTS idx_chat_agents_owner
  ON chat_agents(owner_user_id, id);

  CREATE TABLE IF NOT EXISTS chat_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_chat_folders_user_order
  ON chat_folders(user_id, sort_order, id);

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

  CREATE TABLE IF NOT EXISTS server_access_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME,
    revoked_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS server_access_key_users (
    key_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    first_used_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (key_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS server_access_key_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1))
  );

  INSERT OR IGNORE INTO server_access_key_state (id, enabled) VALUES (1, 0);

  CREATE INDEX IF NOT EXISTS idx_server_access_key_users_user
  ON server_access_key_users(user_id, last_used_at DESC);
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
// Weekly token quota (conditional units). weekly_window_started_at = unix epoch start of current 7-day window.
ensureUserColumn('weekly_tokens_used', 'ALTER TABLE users ADD COLUMN weekly_tokens_used REAL NOT NULL DEFAULT 0');
ensureUserColumn('weekly_tokens_quota', 'ALTER TABLE users ADD COLUMN weekly_tokens_quota REAL NOT NULL DEFAULT 0');
ensureUserColumn('weekly_window_started_at', 'ALTER TABLE users ADD COLUMN weekly_window_started_at INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('weekly_cost_used', 'ALTER TABLE users ADD COLUMN weekly_cost_used REAL NOT NULL DEFAULT 0');
ensureUserColumn('weekly_cost_quota', 'ALTER TABLE users ADD COLUMN weekly_cost_quota REAL NOT NULL DEFAULT 0');
ensureUserColumn('weekly_cost_quota_limit', 'ALTER TABLE users ADD COLUMN weekly_cost_quota_limit REAL NOT NULL DEFAULT 0');
// Legacy columns (daily_tokens_used, total_tokens_used, daily_cost_rub, total_cost_rub) are no longer created
// for fresh installs. They are dropped below via dropLegacyUserColumns() for upgraded databases.
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
ensureChatMessageColumn('prompt_id', 'ALTER TABLE chat_messages ADD COLUMN prompt_id INTEGER');
ensureChatMessageColumn('prompt_name', 'ALTER TABLE chat_messages ADD COLUMN prompt_name TEXT');
ensureChatMessageColumn('model_name', 'ALTER TABLE chat_messages ADD COLUMN model_name TEXT');
ensureChatMessageColumn('provider_name', 'ALTER TABLE chat_messages ADD COLUMN provider_name TEXT');
ensureChatMessageColumn('agent_id', 'ALTER TABLE chat_messages ADD COLUMN agent_id INTEGER');
// Attachments (documents) — text files injected into AI context
ensureChatMessageColumn('attachments', 'ALTER TABLE chat_messages ADD COLUMN attachments TEXT');
// Subagent traces — полные trace ad-hoc субагентов для UI-отображения (не уходит в AI-контекст)
ensureChatMessageColumn('subagents_json', 'ALTER TABLE chat_messages ADD COLUMN subagents_json TEXT');

// ── user_chats: bot visibility flag ────────────────────────────────────────
// bot_hidden = 1 excludes the chat from the bot's search_chat_history tool.
const hasUserChatColumn = (columnName: string) => {
  const columns = db.prepare('PRAGMA table_info(user_chats)').all() as Array<{ name: string }>;
  return columns.some(column => column.name === columnName);
};
if (!hasUserChatColumn('bot_hidden')) {
  db.exec("ALTER TABLE user_chats ADD COLUMN bot_hidden INTEGER NOT NULL DEFAULT 0");
}
if (!hasUserChatColumn('folder_id')) {
  db.exec('ALTER TABLE user_chats ADD COLUMN folder_id INTEGER');
}
if (!hasUserChatColumn('room_enabled')) {
  db.exec('ALTER TABLE user_chats ADD COLUMN room_enabled INTEGER NOT NULL DEFAULT 0');
}
if (!hasUserChatColumn('room_response_mode')) {
  db.exec("ALTER TABLE user_chats ADD COLUMN room_response_mode TEXT NOT NULL DEFAULT 'manual'");
}
if (!hasUserChatColumn('room_auto_respond')) {
  db.exec('ALTER TABLE user_chats ADD COLUMN room_auto_respond INTEGER NOT NULL DEFAULT 1');
}
if (!hasUserChatColumn('room_next_agent_id')) {
  db.exec('ALTER TABLE user_chats ADD COLUMN room_next_agent_id INTEGER');
}
if (!hasUserChatColumn('default_prompt_id')) {
  db.exec('ALTER TABLE user_chats ADD COLUMN default_prompt_id INTEGER');
}

// ── Multi-user rooms: per-member settings ────────────────────────────────
// Room response settings (mode / auto_respond / selected agent) live on the
// member row, not on user_chats. room_enabled on user_chats stays as the
// "room exists" flag. Legacy room_* settings are migrated into the owner's
// member row below (INSERT OR IGNORE keeps it idempotent).
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_members (
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
    response_mode TEXT NOT NULL DEFAULT 'manual' CHECK(response_mode IN ('manual', 'round')),
    auto_respond INTEGER NOT NULL DEFAULT 1 CHECK(auto_respond IN (0, 1)),
    next_agent_id INTEGER,
    sort_order INTEGER NOT NULL DEFAULT 0,
    joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (chat_id, user_id)
  )
`);
db.exec("CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_chat_members_order ON chat_members(chat_id, sort_order, user_id)");

// ── chat_members: per-member folder placement ──────────────────────────────
// Folder assignment is per-user: the owner keeps theirs in user_chats.folder_id,
// room members store their own here (an owner-side folder move must not
// affect how members see the room in their sidebar).
const hasChatMemberColumn = (columnName: string) => {
  const columns = db.prepare('PRAGMA table_info(chat_members)').all() as Array<{ name: string }>;
  return columns.some(column => column.name === columnName);
};
if (!hasChatMemberColumn('folder_id')) {
  db.exec('ALTER TABLE chat_members ADD COLUMN folder_id INTEGER');
}
db.exec("CREATE INDEX IF NOT EXISTS idx_chat_members_folder ON chat_members(user_id, folder_id)");
// Room titles are personal, just like folder placement. NULL means that the
// member still uses the room owner's title from user_chats.
if (!hasChatMemberColumn('title')) {
  db.exec('ALTER TABLE chat_members ADD COLUMN title TEXT');
}
// Existing members receive a snapshot once. Future owner renames must not
// silently rename rooms in another member's sidebar.
db.exec(`
  UPDATE chat_members
  SET title = (SELECT uc.title FROM user_chats uc WHERE uc.id = chat_members.chat_id)
  WHERE title IS NULL
    AND EXISTS (
      SELECT 1 FROM user_chats uc
      WHERE uc.id = chat_members.chat_id AND uc.user_id != chat_members.user_id
    )
`);

// Bot visibility to other members: 'private' = only the owner can trigger,
// 'shared' = any room member can trigger (@mention / manual trigger).
const hasChatAgentColumn = (columnName: string) => {
  const columns = db.prepare('PRAGMA table_info(chat_agents)').all() as Array<{ name: string }>;
  return columns.some(column => column.name === columnName);
};
if (!hasChatAgentColumn('access')) {
  db.exec("ALTER TABLE chat_agents ADD COLUMN access TEXT NOT NULL DEFAULT 'private' CHECK(access IN ('private', 'shared'))");
}

// ── chat_message_audio: per-user TTS audio ──────────────────────────────────
// TTS озвучка индивидуальна: каждый юзер слышит свой голос/провайдер. Аудио
// привязывается к паре (message, user), а не к сообщению. Legacy-колонка
// chat_messages.audio разово переносится владельцам.
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_message_audio (
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    audio TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, user_id)
  )
`);
db.exec(`
  INSERT OR IGNORE INTO chat_message_audio (message_id, user_id, audio)
  SELECT id, user_id, audio
  FROM chat_messages
  WHERE audio IS NOT NULL AND audio != ''
`);

// Migrate legacy room settings into the owner's member row (idempotent).
db.exec(`
  INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, response_mode, auto_respond, next_agent_id, sort_order, joined_at)
  SELECT id, user_id, 'admin', room_response_mode, room_auto_respond, room_next_agent_id, 0, CURRENT_TIMESTAMP
  FROM user_chats
  WHERE room_enabled = 1
`);

// ── Room invites ──────────────────────────────────────────────────────────
// Admin generates a tokenized link; anyone with an account on the same server
// can join via POST /api/v1/room-invites/:token/join. Tokens are random and
// stored in plain form (short-lived, revocable — same trust level as the
// existing server access keys).
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_invites (
    token TEXT PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    created_by INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at DATETIME
  )
`);
db.exec("CREATE INDEX IF NOT EXISTS idx_chat_invites_chat ON chat_invites(chat_id, revoked_at)");

db.exec('CREATE INDEX IF NOT EXISTS idx_user_chats_user_folder ON user_chats(user_id, folder_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_chat_messages_agent ON chat_messages(agent_id, id) WHERE agent_id IS NOT NULL');

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
  UPDATE users SET total_message_length = 0 WHERE total_message_length IS NULL;
  UPDATE users SET weekly_tokens_used = 0 WHERE weekly_tokens_used IS NULL OR weekly_tokens_used < 0;
  UPDATE users SET weekly_tokens_quota = 0 WHERE weekly_tokens_quota IS NULL OR weekly_tokens_quota < 0;
  UPDATE users SET weekly_cost_used = 0 WHERE weekly_cost_used IS NULL OR weekly_cost_used < 0;
  UPDATE users SET weekly_cost_quota = 0 WHERE weekly_cost_quota IS NULL OR weekly_cost_quota < 0;
  UPDATE users SET weekly_cost_quota_limit = 0 WHERE weekly_cost_quota_limit IS NULL OR weekly_cost_quota_limit < 0;
  UPDATE users SET weekly_window_started_at = 0 WHERE weekly_window_started_at IS NULL OR weekly_window_started_at < 0;
  UPDATE users SET daily_web_search_count = 0 WHERE daily_web_search_count IS NULL;
  UPDATE users SET daily_web_search_limit = 10 WHERE daily_web_search_limit IS NULL OR daily_web_search_limit < 0;
  UPDATE users SET total_web_search_count = 0 WHERE total_web_search_count IS NULL;
  UPDATE users SET core_memory = '' WHERE core_memory IS NULL;
  UPDATE users SET imap_port = 993 WHERE imap_port IS NULL OR imap_port <= 0;
  UPDATE users SET imap_secure = 1 WHERE imap_secure IS NULL;
  UPDATE users SET mail_check_limit = 10 WHERE mail_check_limit IS NULL OR mail_check_limit <= 0;
  CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

`);

// Index for efficient filtering: active (non-archived) messages per chat
if (!db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_chat_messages_active'").get()) {
  db.exec("CREATE INDEX IF NOT EXISTS idx_chat_messages_active ON chat_messages(user_id, chat_id, archived, id DESC)");
}
// Supports room-wide last-message lookups where messages can have different owners.
db.exec("DROP INDEX IF EXISTS idx_chat_messages_chat_id_id");
db.exec("CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_activity ON chat_messages(chat_id, created_at DESC, id DESC)");
db.exec(`
  DROP INDEX IF EXISTS idx_chat_messages_user_prompt_chat;
  CREATE INDEX IF NOT EXISTS idx_chat_messages_user_prompt_id_chat
  ON chat_messages(user_id, prompt_id, chat_id)
  WHERE prompt_id IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_chat_messages_user_model_chat
  ON chat_messages(user_id, model_name, chat_id)
  WHERE model_name IS NOT NULL;
`);

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

// ── Password reset codes ──────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS password_reset_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
db.exec("CREATE INDEX IF NOT EXISTS idx_password_reset_account ON password_reset_codes(account_id)");
db.exec("DELETE FROM password_reset_codes WHERE expires_at < unixepoch()");

// Forces the user to change password on next desktop sign-in (set when admin
// generates a new password or when recovery was done via Telegram bot).
ensureUserColumn('must_change_password', "ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0");

// Token-based context limits.
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

// ── Plan limits config (admin-editable) ──────────────────────────────────
// Stores per-plan overrides. Seeded from code defaults on first run via
// seedPlanLimitsIfEmpty(). Source of truth after seeding is the DB content.

db.exec(`
  CREATE TABLE IF NOT EXISTS plan_limits_config (
    plan TEXT PRIMARY KEY,
    config_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

// ── Global runtime settings ─────────────────────────────────────────────
// Generic key/value storage for settings that should change without a
// backend restart. Values are JSON so more ENV configuration can migrate
// here incrementally without adding a table for every switch.

db.exec(`
  CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

// ── Model overrides (coefficient for token quota accounting) ─────────────
// model_id matches the uniqueId from MODELS_MANUAL / PRO / LITE / VISION env.
// coefficient = multiplier applied to total_tokens for quota accounting.
//   0   = model does not consume quota at all (free model)
//   1   = default
//   0.7 = cheaper than baseline
//   1.5 = more expensive than baseline
// Rows are created lazily when admin sets a coefficient via UI. Missing row = 1.0.

db.exec(`
  CREATE TABLE IF NOT EXISTS model_overrides (
    model_id TEXT PRIMARY KEY,
    coefficient REAL NOT NULL DEFAULT 1.0 CHECK (coefficient >= 0),
    updated_at INTEGER NOT NULL,
    provider_kind TEXT,
    openrouter_provider_slug TEXT,
    pricing_mode TEXT,
    input_price_per_million REAL,
    output_price_per_million REAL,
    cache_read_price_per_million REAL,
    pricing_source TEXT,
    pricing_updated_at INTEGER
  )
`);

// ── Migrations for model_overrides (add columns if missing) ──────────────────
const hasModelOverrideColumn = (columnName: string) => {
  const columns = db.prepare('PRAGMA table_info(model_overrides)').all() as Array<{ name: string }>;
  return columns.some(c => c.name === columnName);
};
const ensureModelOverrideColumn = (name: string, sql: string) => {
  if (!hasModelOverrideColumn(name)) db.exec(sql);
};
ensureModelOverrideColumn('provider_kind', 'ALTER TABLE model_overrides ADD COLUMN provider_kind TEXT');
ensureModelOverrideColumn('openrouter_provider_slug', 'ALTER TABLE model_overrides ADD COLUMN openrouter_provider_slug TEXT');
ensureModelOverrideColumn('pricing_mode', 'ALTER TABLE model_overrides ADD COLUMN pricing_mode TEXT');
ensureModelOverrideColumn('input_price_per_million', 'ALTER TABLE model_overrides ADD COLUMN input_price_per_million REAL');
ensureModelOverrideColumn('output_price_per_million', 'ALTER TABLE model_overrides ADD COLUMN output_price_per_million REAL');
ensureModelOverrideColumn('cache_read_price_per_million', 'ALTER TABLE model_overrides ADD COLUMN cache_read_price_per_million REAL');
ensureModelOverrideColumn('pricing_source', 'ALTER TABLE model_overrides ADD COLUMN pricing_source TEXT');
ensureModelOverrideColumn('pricing_updated_at', 'ALTER TABLE model_overrides ADD COLUMN pricing_updated_at INTEGER');
ensureModelOverrideColumn('selected_api_key_id', 'ALTER TABLE model_overrides ADD COLUMN selected_api_key_id INTEGER');
ensureModelOverrideColumn('is_free', 'ALTER TABLE model_overrides ADD COLUMN is_free INTEGER NOT NULL DEFAULT 0');
// Admin-set display tiers (1..3, NULL = not set) shown in the desktop model selector.
ensureModelOverrideColumn('intel_tier', 'ALTER TABLE model_overrides ADD COLUMN intel_tier INTEGER');
ensureModelOverrideColumn('price_tier', 'ALTER TABLE model_overrides ADD COLUMN price_tier INTEGER');
// Maximum total context accepted by the configured model/provider endpoint.
ensureModelOverrideColumn('context_length', 'ALTER TABLE model_overrides ADD COLUMN context_length INTEGER');
// Locally measured generation speed (EMA over recent messages, tokens/sec).
ensureModelOverrideColumn('avg_tps', 'ALTER TABLE model_overrides ADD COLUMN avg_tps REAL');
ensureModelOverrideColumn('tps_samples', 'ALTER TABLE model_overrides ADD COLUMN tps_samples INTEGER');
ensureModelOverrideColumn('tps_updated_at', 'ALTER TABLE model_overrides ADD COLUMN tps_updated_at INTEGER');


db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    key_encrypted TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// ── OpenRouter provider monitoring (settings + per-model state) ───────────
// Settings live in a single row (id = 1) so the admin panel can persist them
// permanently without ENV rewrites. State is keyed by model unique ID (same
// key space as model_overrides.model_id).

db.exec(`
  CREATE TABLE IF NOT EXISTS openrouter_monitor_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 0,
    interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK (interval_minutes >= 5),
    action TEXT NOT NULL DEFAULT 'notify'
      CHECK (action IN ('notify', 'cheapest', 'throughput', 'latency')),
    recipients_mode TEXT NOT NULL DEFAULT 'all_admins'
      CHECK (recipients_mode IN ('all_admins', 'selected')),
    recipient_user_ids TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS openrouter_monitor_state (
    model_id TEXT PRIMARY KEY,
    route TEXT,
    model_slug TEXT,
    provider_slug TEXT,
    status TEXT NOT NULL DEFAULT 'unknown'
      CHECK (status IN ('unknown', 'available', 'missing', 'check_failed', 'model_missing')),
    last_ok_at INTEGER,
    last_check_at INTEGER,
    consecutive_missing INTEGER NOT NULL DEFAULT 0,
    unavailable_since INTEGER,
    last_notified_at INTEGER,
    last_notified_key TEXT,
    previous_provider_slug TEXT,
    replacement_provider_slug TEXT,
    last_error TEXT,
    last_seen_prices TEXT
  )
`);

// ── Price tracking (added after initial release; migrations for existing DBs) ──
const ensureMonitorSettingsColumn = (columnName: string, ddl: string) => {
  const columns = db.prepare('PRAGMA table_info(openrouter_monitor_settings)').all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === columnName)) db.exec(ddl);
};
ensureMonitorSettingsColumn('price_tracking',
  "ALTER TABLE openrouter_monitor_settings ADD COLUMN price_tracking TEXT NOT NULL DEFAULT 'notify'" +
  " CHECK (price_tracking IN ('off', 'notify', 'update'))");
ensureMonitorSettingsColumn('price_switch_cheapest',
  'ALTER TABLE openrouter_monitor_settings ADD COLUMN price_switch_cheapest INTEGER NOT NULL DEFAULT 0');
ensureMonitorSettingsColumn('price_threshold_pct',
  'ALTER TABLE openrouter_monitor_settings ADD COLUMN price_threshold_pct REAL NOT NULL DEFAULT 5');
{
  const columns = db.prepare('PRAGMA table_info(openrouter_monitor_state)').all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'last_seen_prices')) {
    db.exec('ALTER TABLE openrouter_monitor_state ADD COLUMN last_seen_prices TEXT');
  }
}

// ── User token usage (immutable accounting ledger) ────────────────────────
// Source of truth for cost / statistics. NOT affected by chat/message deletion.
// One row per AI response (manual or auto, including aborts).
// charged_tokens = total_tokens × coefficient at the moment of response.

db.exec(`
  CREATE TABLE IF NOT EXISTS user_token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    chat_id INTEGER,
    message_id INTEGER,
    route TEXT,
    model_id TEXT,
    model_name TEXT,
    provider_name TEXT,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
    cache_miss_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    charged_tokens REAL NOT NULL DEFAULT 0,
    aborted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    upstream_provider_slug TEXT,
    input_price_per_million REAL,
    output_price_per_million REAL,
    cache_read_price_per_million REAL,
    estimated_cost_usd REAL,
    actual_cost_usd REAL,
    pricing_source TEXT
  )
`);

db.exec("CREATE INDEX IF NOT EXISTS idx_utu_user_created ON user_token_usage(user_id, created_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_utu_user_model_created ON user_token_usage(user_id, model_id, created_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_utu_created_at ON user_token_usage(created_at)");

// ── Migrations for user_token_usage (add columns if missing) ──────────────────
const hasUtoColumn = (columnName: string) => {
  const columns = db.prepare('PRAGMA table_info(user_token_usage)').all() as Array<{ name: string }>;
  return columns.some(c => c.name === columnName);
};
const ensureUtoColumn = (name: string, sql: string) => {
  if (!hasUtoColumn(name)) db.exec(sql);
};
ensureUtoColumn('upstream_provider_slug', 'ALTER TABLE user_token_usage ADD COLUMN upstream_provider_slug TEXT');
ensureUtoColumn('input_price_per_million', 'ALTER TABLE user_token_usage ADD COLUMN input_price_per_million REAL');
ensureUtoColumn('output_price_per_million', 'ALTER TABLE user_token_usage ADD COLUMN output_price_per_million REAL');
ensureUtoColumn('cache_read_price_per_million', 'ALTER TABLE user_token_usage ADD COLUMN cache_read_price_per_million REAL');
ensureUtoColumn('estimated_cost_usd', 'ALTER TABLE user_token_usage ADD COLUMN estimated_cost_usd REAL');
ensureUtoColumn('actual_cost_usd', 'ALTER TABLE user_token_usage ADD COLUMN actual_cost_usd REAL');
ensureUtoColumn('pricing_source', 'ALTER TABLE user_token_usage ADD COLUMN pricing_source TEXT');

// ── Drop legacy columns from upgraded databases ───────────────────────────
// SQLite ≥ 3.35 supports ALTER TABLE DROP COLUMN. Wrapped in try/catch: if the
// column is already gone (fresh install or re-run), the error is ignored.
// Same for the is_free column in user_token_usage (replaced by coefficient === 0 logic).
const dropLegacyColumn = (table: string, column: string) => {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === column)) return;
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  } catch (err) {
    console.warn(`[db] drop ${table}.${column} failed (ignored):`, err);
  }
};
dropLegacyColumn('users', 'daily_tokens_used');
dropLegacyColumn('users', 'total_tokens_used');
dropLegacyColumn('users', 'daily_cost_rub');
dropLegacyColumn('users', 'total_cost_rub');
dropLegacyColumn('user_token_usage', 'is_free');

