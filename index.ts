import { Markup, Telegraf } from 'telegraf';
import Database from 'better-sqlite3';
import * as dotenv from 'dotenv';
import crypto from 'crypto';
import axios from 'axios';

dotenv.config();

const MAX_HISTORY_ITEMS = 9999;
const USER_PLANS = ['free', 'standart', 'pro'] as const;
type UserPlan = typeof USER_PLANS[number];
const PLAN_LABELS: Record<UserPlan, string> = {
    free: 'FREE',
    standart: 'STANDART',
    pro: 'PRO'
};
const PLAN_MAX_CONTEXT_TOKENS: Record<UserPlan, number> = {
    free: 30_000,
    standart: 60_000,
    pro: 1_000_000
};
const PLAN_DAILY_WEB_SEARCH_LIMITS: Record<UserPlan, number> = {
    free: 0,
    standart: 5,
    pro: 20
};
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
const PLAN_NOTE_LIST_LIMITS: Record<UserPlan, number> = {
    free: 5,
    standart: 10,
    pro: 20
};
const DEFAULT_USER_PLAN: UserPlan = 'free';

const bot = new Telegraf(process.env.TELEGRAM_TOKEN!);
bot.catch(async (err, ctx) => {
    console.error('Telegraf update error:', err);
    try {
        await ctx.reply('Сервис временно недоступен. Попробуйте ещё раз через пару секунд.');
    } catch {
        // ignore reply failures inside error handler
    }
});
// Инициализация базы данных
const db = new Database('chatter.db');

const usersTableInfo = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'users'
`).get() as { name: string } | undefined;

if (usersTableInfo) {
    const columns = db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[];
    const hasIdColumn = columns.some(c => c.name === 'id');
    if (!hasIdColumn) {
        const legacyUsersTable = `users_legacy_${Date.now()}`;
        db.exec(`ALTER TABLE users RENAME TO ${legacyUsersTable}`);
    }
}

const chatMessagesTableInfo = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'chat_messages'
`).get() as { name: string } | undefined;

if (chatMessagesTableInfo) {
    const columns = db.prepare(`PRAGMA table_info(chat_messages)`).all() as { name: string }[];
    const hasUserIdColumn = columns.some(c => c.name === 'user_id');
    if (!hasUserIdColumn) {
        const legacyMessagesTable = `chat_messages_legacy_${Date.now()}`;
        db.exec(`ALTER TABLE chat_messages RENAME TO ${legacyMessagesTable}`);
    }
}

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        name TEXT,
        role TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'approved' CHECK(status IN ('none', 'approved', 'disapproved', 'banned')),
        plan TEXT NOT NULL DEFAULT 'free' CHECK(plan IN ('free', 'standart', 'pro')),
        tg_username TEXT,
        selected_prompt_id INTEGER,
        custom_prompt_content TEXT,
        core_memory TEXT DEFAULT '',
        imap_provider TEXT,
        imap_user TEXT,
        imap_pass TEXT,
        imap_host TEXT,
        imap_port INTEGER DEFAULT 993,
        imap_secure INTEGER DEFAULT 1,
        mail_check_limit INTEGER NOT NULL DEFAULT 10,
        active_chat_id INTEGER,
        timezone_offset INTEGER DEFAULT 5,
        timezone_confirmed INTEGER NOT NULL DEFAULT 0,
        daily_message_count INTEGER NOT NULL DEFAULT 0,
        total_message_length INTEGER NOT NULL DEFAULT 0,
        daily_message_limit INTEGER NOT NULL DEFAULT 0,
        daily_tokens_used INTEGER NOT NULL DEFAULT 0,
        total_tokens_used INTEGER NOT NULL DEFAULT 0,
        daily_cost_rub REAL NOT NULL DEFAULT 0,
        total_cost_rub REAL NOT NULL DEFAULT 0,
        daily_web_search_count INTEGER NOT NULL DEFAULT 0,
        daily_web_search_limit INTEGER NOT NULL DEFAULT ${PLAN_DAILY_WEB_SEARCH_LIMITS[DEFAULT_USER_PLAN]},
        total_web_search_count INTEGER NOT NULL DEFAULT 0,
        context_window INTEGER NOT NULL DEFAULT ${MAX_HISTORY_ITEMS},
        context_window_max INTEGER NOT NULL DEFAULT ${MAX_HISTORY_ITEMS},
        max_context_tokens_limit INTEGER NOT NULL DEFAULT ${PLAN_MAX_CONTEXT_TOKENS[DEFAULT_USER_PLAN]},
        max_context_tokens INTEGER NOT NULL DEFAULT ${PLAN_MAX_CONTEXT_TOKENS[DEFAULT_USER_PLAN]},
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
        title TEXT NOT NULL DEFAULT 'Основной',
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
        reason TEXT NOT NULL DEFAULT 'Без причины',
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

    CREATE INDEX IF NOT EXISTS idx_notes_user_created
    ON notes(user_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_notes_user_id_desc
    ON notes(user_id, id DESC);

    CREATE TABLE IF NOT EXISTS mail_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('yandex', 'google')),
        imap_user TEXT NOT NULL,
        imap_pass TEXT NOT NULL,
        imap_host TEXT NOT NULL,
        imap_port INTEGER NOT NULL DEFAULT 993,
        imap_secure INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, provider)
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
    const columns = db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[];
    return columns.some(c => c.name === columnName);
};

const ensureUserColumn = (columnName: string, alterSql: string) => {
    if (hasUserColumn(columnName)) return;
    db.exec(alterSql);
};

const hasTaskColumn = (columnName: string) => {
    const columns = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
    return columns.some(c => c.name === columnName);
};

const ensureTaskColumn = (columnName: string, alterSql: string) => {
    if (hasTaskColumn(columnName)) return;
    db.exec(alterSql);
};

const hasChatMessageColumn = (columnName: string) => {
    const columns = db.prepare(`PRAGMA table_info(chat_messages)`).all() as { name: string }[];
    return columns.some(c => c.name === columnName);
};

const ensureChatMessageColumn = (columnName: string, alterSql: string) => {
    if (hasChatMessageColumn(columnName)) return;
    db.exec(alterSql);
};

ensureUserColumn('selected_prompt_id', 'ALTER TABLE users ADD COLUMN selected_prompt_id INTEGER');
ensureUserColumn('custom_prompt_content', 'ALTER TABLE users ADD COLUMN custom_prompt_content TEXT');
ensureUserColumn('core_memory', `ALTER TABLE users ADD COLUMN core_memory TEXT DEFAULT ''`);
ensureUserColumn('imap_provider', 'ALTER TABLE users ADD COLUMN imap_provider TEXT');
ensureUserColumn('imap_user', 'ALTER TABLE users ADD COLUMN imap_user TEXT');
ensureUserColumn('imap_pass', 'ALTER TABLE users ADD COLUMN imap_pass TEXT');
ensureUserColumn('imap_host', 'ALTER TABLE users ADD COLUMN imap_host TEXT');
ensureUserColumn('imap_port', 'ALTER TABLE users ADD COLUMN imap_port INTEGER DEFAULT 993');
ensureUserColumn('imap_secure', 'ALTER TABLE users ADD COLUMN imap_secure INTEGER DEFAULT 1');
ensureUserColumn('mail_check_limit', 'ALTER TABLE users ADD COLUMN mail_check_limit INTEGER NOT NULL DEFAULT 10');
ensureUserColumn('active_chat_id', 'ALTER TABLE users ADD COLUMN active_chat_id INTEGER');
ensureUserColumn('status', `ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'`);
ensureUserColumn('plan', `ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT '${DEFAULT_USER_PLAN}'`);
ensureUserColumn('tg_username', 'ALTER TABLE users ADD COLUMN tg_username TEXT');
ensureUserColumn('created_at', 'ALTER TABLE users ADD COLUMN created_at DATETIME');
ensureUserColumn('timezone_offset', 'ALTER TABLE users ADD COLUMN timezone_offset INTEGER DEFAULT 5');
ensureUserColumn('timezone_confirmed', 'ALTER TABLE users ADD COLUMN timezone_confirmed INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('daily_message_count', 'ALTER TABLE users ADD COLUMN daily_message_count INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('total_message_length', 'ALTER TABLE users ADD COLUMN total_message_length INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('daily_message_limit', `ALTER TABLE users ADD COLUMN daily_message_limit INTEGER NOT NULL DEFAULT 0`);
ensureUserColumn('daily_tokens_used', 'ALTER TABLE users ADD COLUMN daily_tokens_used INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('total_tokens_used', 'ALTER TABLE users ADD COLUMN total_tokens_used INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('daily_cost_rub', 'ALTER TABLE users ADD COLUMN daily_cost_rub REAL NOT NULL DEFAULT 0');
ensureUserColumn('total_cost_rub', 'ALTER TABLE users ADD COLUMN total_cost_rub REAL NOT NULL DEFAULT 0');
ensureUserColumn('daily_web_search_count', 'ALTER TABLE users ADD COLUMN daily_web_search_count INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('daily_web_search_limit', `ALTER TABLE users ADD COLUMN daily_web_search_limit INTEGER NOT NULL DEFAULT ${PLAN_DAILY_WEB_SEARCH_LIMITS[DEFAULT_USER_PLAN]}`);
ensureUserColumn('total_web_search_count', 'ALTER TABLE users ADD COLUMN total_web_search_count INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('context_window', `ALTER TABLE users ADD COLUMN context_window INTEGER NOT NULL DEFAULT ${MAX_HISTORY_ITEMS}`);
ensureUserColumn('context_window_max', `ALTER TABLE users ADD COLUMN context_window_max INTEGER NOT NULL DEFAULT ${MAX_HISTORY_ITEMS}`);
ensureUserColumn('max_context_tokens_limit', `ALTER TABLE users ADD COLUMN max_context_tokens_limit INTEGER NOT NULL DEFAULT ${PLAN_MAX_CONTEXT_TOKENS[DEFAULT_USER_PLAN]}`);
ensureUserColumn('max_context_tokens', `ALTER TABLE users ADD COLUMN max_context_tokens INTEGER NOT NULL DEFAULT ${PLAN_MAX_CONTEXT_TOKENS[DEFAULT_USER_PLAN]}`);

ensureTaskColumn('recurrence_type', `ALTER TABLE tasks ADD COLUMN recurrence_type TEXT NOT NULL DEFAULT 'once'`);
ensureTaskColumn('recurrence_weekday', 'ALTER TABLE tasks ADD COLUMN recurrence_weekday INTEGER');
ensureTaskColumn('timezone_offset', 'ALTER TABLE tasks ADD COLUMN timezone_offset INTEGER');
ensureTaskColumn('notify_mode', `ALTER TABLE tasks ADD COLUMN notify_mode TEXT NOT NULL DEFAULT 'always'`);
ensureTaskColumn('notify_condition', 'ALTER TABLE tasks ADD COLUMN notify_condition TEXT');
ensureChatMessageColumn('telegram_chat_id', 'ALTER TABLE chat_messages ADD COLUMN telegram_chat_id INTEGER');
ensureChatMessageColumn('telegram_message_id', 'ALTER TABLE chat_messages ADD COLUMN telegram_message_id INTEGER');
ensureChatMessageColumn('chat_id', 'ALTER TABLE chat_messages ADD COLUMN chat_id INTEGER');
ensureChatMessageColumn('archived', 'ALTER TABLE chat_messages ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
ensureChatMessageColumn('archived_at', 'ALTER TABLE chat_messages ADD COLUMN archived_at DATETIME');

db.exec(`
    CREATE TABLE IF NOT EXISTS user_chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT 'Основной',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_user_chats_user_id_id ON user_chats(user_id, id DESC)`);

db.exec(`
    INSERT INTO user_chats (user_id, title)
    SELECT u.id, 'Основной'
    FROM users u
    WHERE NOT EXISTS (
        SELECT 1
        FROM user_chats uc
        WHERE uc.user_id = u.id
    )
`);

db.exec(`
    UPDATE users
    SET active_chat_id = (
        SELECT uc.id
        FROM user_chats uc
        WHERE uc.user_id = users.id
        ORDER BY uc.id ASC
        LIMIT 1
    )
    WHERE active_chat_id IS NULL
       OR NOT EXISTS (
            SELECT 1
            FROM user_chats uc2
            WHERE uc2.user_id = users.id AND uc2.id = users.active_chat_id
       )
`);

if (hasChatMessageColumn('chat_id')) {
    db.exec(`
        UPDATE chat_messages
        SET chat_id = (
            SELECT u.active_chat_id
            FROM users u
            WHERE u.id = chat_messages.user_id
        )
        WHERE chat_id IS NULL
    `);
}

if (hasUserColumn('created_at')) {
    db.exec(`UPDATE users SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL`);
}
if (hasUserColumn('status')) {
    db.exec(`UPDATE users SET status = 'approved' WHERE status IS NULL OR status = ''`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)`);
}
if (hasUserColumn('plan')) {
    db.exec(`UPDATE users SET plan = '${DEFAULT_USER_PLAN}' WHERE plan IS NULL OR plan = '' OR plan NOT IN ('free', 'standart', 'pro')`);
}
if (hasUserColumn('daily_message_count')) {
    db.exec(`UPDATE users SET daily_message_count = 0 WHERE daily_message_count IS NULL`);
}
if (hasUserColumn('daily_message_limit')) {
    db.exec(`UPDATE users SET daily_message_limit = 0 WHERE daily_message_limit IS NULL OR daily_message_limit < 0`);
}
if (hasUserColumn('total_message_length')) {
    db.exec(`UPDATE users SET total_message_length = 0 WHERE total_message_length IS NULL`);
}
if (hasUserColumn('daily_tokens_used')) {
    db.exec(`UPDATE users SET daily_tokens_used = 0 WHERE daily_tokens_used IS NULL`);
}
if (hasUserColumn('total_tokens_used')) {
    db.exec(`UPDATE users SET total_tokens_used = 0 WHERE total_tokens_used IS NULL`);
}
if (hasUserColumn('daily_cost_rub')) {
    db.exec(`UPDATE users SET daily_cost_rub = 0 WHERE daily_cost_rub IS NULL`);
}
if (hasUserColumn('total_cost_rub')) {
    db.exec(`UPDATE users SET total_cost_rub = 0 WHERE total_cost_rub IS NULL`);
}
if (hasUserColumn('daily_web_search_count')) {
    db.exec(`UPDATE users SET daily_web_search_count = 0 WHERE daily_web_search_count IS NULL`);
}
if (hasUserColumn('daily_web_search_limit')) {
    db.exec(`UPDATE users SET daily_web_search_limit = ${PLAN_DAILY_WEB_SEARCH_LIMITS[DEFAULT_USER_PLAN]} WHERE daily_web_search_limit IS NULL OR daily_web_search_limit < 0`);
}
if (hasUserColumn('total_web_search_count')) {
    db.exec(`UPDATE users SET total_web_search_count = 0 WHERE total_web_search_count IS NULL`);
}
if (hasUserColumn('core_memory')) {
    db.exec(`UPDATE users SET core_memory = '' WHERE core_memory IS NULL`);
}
if (hasUserColumn('imap_port')) {
    db.exec(`UPDATE users SET imap_port = 993 WHERE imap_port IS NULL OR imap_port <= 0`);
}
if (hasUserColumn('imap_secure')) {
    db.exec(`UPDATE users SET imap_secure = 1 WHERE imap_secure IS NULL`);
}
if (hasUserColumn('mail_check_limit')) {
    db.exec(`UPDATE users SET mail_check_limit = 10 WHERE mail_check_limit IS NULL OR mail_check_limit <= 0`);
}
if (hasUserColumn('context_window_max')) {
    db.exec(`UPDATE users SET context_window_max = ${MAX_HISTORY_ITEMS} WHERE context_window_max IS NULL OR context_window_max <= 0`);
}
if (hasUserColumn('max_context_tokens_limit')) {
    db.exec(`
        UPDATE users
        SET max_context_tokens_limit = CASE
            WHEN plan = 'pro' THEN ${PLAN_MAX_CONTEXT_TOKENS.pro}
            WHEN plan = 'standart' THEN ${PLAN_MAX_CONTEXT_TOKENS.standart}
            ELSE ${PLAN_MAX_CONTEXT_TOKENS.free}
        END
        WHERE max_context_tokens_limit IS NULL OR max_context_tokens_limit <= 0
    `);
}
if (hasUserColumn('max_context_tokens')) {
    db.exec(`
        UPDATE users
        SET max_context_tokens = CASE
            WHEN max_context_tokens IS NULL OR max_context_tokens <= 0 THEN max_context_tokens_limit
            WHEN max_context_tokens > max_context_tokens_limit THEN max_context_tokens_limit
            ELSE max_context_tokens
        END
    `);
}
if (hasUserColumn('plan') && hasUserColumn('daily_message_limit')) {
    db.exec(`UPDATE users SET daily_message_limit = 0 WHERE daily_message_limit IS NULL OR daily_message_limit < 0`);
}
if (hasUserColumn('plan') && hasUserColumn('daily_web_search_limit')) {
    db.exec(`
        UPDATE users
        SET daily_web_search_limit = CASE
            WHEN plan = 'pro' THEN ${PLAN_DAILY_WEB_SEARCH_LIMITS.pro}
            WHEN plan = 'standart' THEN ${PLAN_DAILY_WEB_SEARCH_LIMITS.standart}
            ELSE ${PLAN_DAILY_WEB_SEARCH_LIMITS.free}
        END
        WHERE daily_web_search_limit IS NULL OR daily_web_search_limit < 0
    `);
}
if (hasUserColumn('context_window')) {
    db.exec(`
        UPDATE users
        SET context_window = COALESCE(context_window_max, ${MAX_HISTORY_ITEMS})
        WHERE context_window IS NULL OR context_window <= 0
    `);
    db.exec(`
        UPDATE users
        SET context_window = context_window_max
        WHERE context_window > context_window_max AND context_window_max > 0
    `);
}

db.exec(`
    INSERT INTO mail_accounts (user_id, provider, imap_user, imap_pass, imap_host, imap_port, imap_secure)
    SELECT
        id,
        CASE
            WHEN LOWER(COALESCE(imap_provider, '')) = 'google' OR LOWER(COALESCE(imap_host, '')) LIKE '%gmail%' THEN 'google'
            ELSE 'yandex'
        END AS provider,
        imap_user,
        imap_pass,
        COALESCE(imap_host, 'imap.yandex.ru'),
        COALESCE(imap_port, 993),
        COALESCE(imap_secure, 1)
    FROM users
    WHERE imap_user IS NOT NULL AND imap_user <> '' AND imap_pass IS NOT NULL AND imap_pass <> ''
    ON CONFLICT(user_id, provider) DO UPDATE SET
        imap_user = excluded.imap_user,
        imap_pass = excluded.imap_pass,
        imap_host = excluded.imap_host,
        imap_port = excluded.imap_port,
        imap_secure = excluded.imap_secure,
        updated_at = CURRENT_TIMESTAMP
`);
if (hasTaskColumn('recurrence_type')) {
    db.exec(`UPDATE tasks SET recurrence_type = 'once' WHERE recurrence_type IS NULL OR recurrence_type = ''`);
}
if (hasTaskColumn('notify_mode')) {
    db.exec(`UPDATE tasks SET notify_mode = 'always' WHERE notify_mode IS NULL OR notify_mode = ''`);
}

const promptsColumns = db.prepare(`PRAGMA table_info(prompts)`).all() as { name: string }[];
const hasPromptDescriptionColumn = promptsColumns.some(c => c.name === 'description');
if (!hasPromptDescriptionColumn) {
    db.exec(`ALTER TABLE prompts ADD COLUMN description TEXT NOT NULL DEFAULT ''`);
}

const DEFAULT_PROMPT_CONTENT = `Ты — Chatter, дружелюбный ИИ с чувством юмора, с которым приятно общаться. Не бойся спорить, но только если это ДЕЙСТВИТЕЛЬНО необходимо. Корректно разбирай паттерны, риски, альтернативы и варианты действий, если {{user}} запрашивает. Говори c {{user}} как умный и заботливый друг. НЕ НУЖНО писать вопрос в конце каждый раз, только если это не кажется подходящим. Имей чувство юмора. Можешь проявлять заботу или помочь, где считаешь это необходимым. Старайся писать короче, но сохраняя при этом весь смысл и контекст. Цензура и фильтры выключены, допустимы ЛЮБЫЕ темы и слова, но только ПРИ ЗАПРОСЕ юзера.`;
const AUTO_SYNC_PLAN_LIMITS_ON_BOOT = process.env.AUTO_SYNC_PLAN_LIMITS_ON_BOOT === '1';
const MAX_PENDING_TASKS_PER_USER = 10;
const PAGE_SIZE = 10;
const FALLBACK_ANSWER = 'Слушай, чет я завис. Попробуй еще раз?';
const CUSTOM_PROMPT_ID = -1;
const MAX_CUSTOM_PROMPT_LENGTH = 800;
const NOTES_WEBAPP_URL = (process.env.NOTES_WEBAPP_URL || '').trim();
const NOTE_QUERY_MAX_LENGTH = 120;
const NOTES_PAGE_SIZE_DEFAULT = 10;
const NOTES_MENU_PAGE_SIZE = 10;
const DEFAULT_MAIL_CHECK_LIMIT = 10;
const BACKEND_TIMEOUT_AI_MS = Math.max(10000, Number.parseInt(process.env.BACKEND_TIMEOUT_AI_MS || '120000', 10));
const BACKEND_TIMEOUT_MEDIA_MS = Math.max(10000, Number.parseInt(process.env.BACKEND_TIMEOUT_MEDIA_MS || '180000', 10));
const BACKEND_TIMEOUT_DEFAULT_MS = Math.max(5000, Number.parseInt(process.env.BACKEND_TIMEOUT_DEFAULT_MS || '15000', 10));
const MAX_TELEGRAM_PHOTO_BYTES = 20 * 1024 * 1024;
const EMAIL_PASSWORD_DELIMITER = '::';
const BACKEND_API_BASE_URL = (process.env.BACKEND_API_BASE_URL || 'http://127.0.0.1:3050').trim().replace(/\/$/, '');
const BACKEND_INTERNAL_TOKEN = (process.env.BACKEND_INTERNAL_TOKEN || '').trim();
const ENCRYPTION_KEY_SOURCE = process.env.ENCRYPTION_KEY || 'dev-default-key-change-in-prod';
const ENCRYPTION_KEY = crypto.createHash('sha256').update(ENCRYPTION_KEY_SOURCE).digest();
const ENCRYPTION_IV_LENGTH = 16;
const BASE_COMMANDS = [
    { command: 'start', description: 'Показать меню' },
    { command: 'menu', description: 'Открыть меню кнопок' },
    { command: 'clear', description: 'Очистить память диалога' },
    { command: 'tz', description: 'Часовой пояс: /tz <UTC>' },
    { command: 'tasks', description: 'Мои напоминания' },
    { command: 'task_delete', description: 'Удалить задачу: /task_delete <id>' },
    { command: 'note_add', description: 'Заметки: /note_add <текст>' },
    { command: 'notes', description: 'Заметки: список /notes [page]' },
    { command: 'note_find', description: 'Заметки: поиск /note_find <текст>' },
    { command: 'note_delete', description: 'Заметки: удалить /note_delete <id>' },
    { command: 'mail_setup', description: 'Почта: /mail_setup <prov> <mail> <app_pass>' },
    { command: 'mail_use', description: 'Почта: /mail_use <yandex|google>' },
    { command: 'mail_limit', description: 'Почта: лимит check_emails' },
    { command: 'mail_forget', description: 'Почта: /mail_forget [yandex|google]' },
    { command: 'chats', description: 'Список чатов и активный чат' },
    { command: 'chat_new', description: 'Создать чат: /chat_new [название]' },
    { command: 'chat_use', description: 'Переключить чат: /chat_use <id>' },
    { command: 'link', description: 'Привязать десктоп-приложение' },
    { command: 'unlink', description: 'Отвязать десктоп-приложение' },
    { command: 'rename', description: 'Переименовать себя' },
    { command: 'prompts', description: 'Список доступных промптов' },
    { command: 'prompt_use', description: 'Выбрать промпт: /prompt_use <id>' }
] as const;
const ADMIN_EXTRA_COMMANDS = [
    { command: 'add', description: 'Добавить юзера (только админ)' },
    { command: 'remove', description: 'Удалить юзера (только админ)' },
    { command: 'users', description: 'Список юзеров (только админ)' },
    { command: 'ban', description: 'Бан: /ban <id> [причина]' },
    { command: 'unban', description: 'Разбан: /unban <id>' },
    { command: 'prompt_add', description: 'Добавить: /prompt_add Имя | Описание | Текст' },
    { command: 'prompt_show', description: 'Показать промпт: /prompt_show <id>' },
    { command: 'prompt_set', description: 'Изменить текст: /prompt_set <id> | Текст' },
    { command: 'prompt_desc', description: 'Изменить описание: /prompt_desc <id> | Описание' },
    { command: 'prompt_rename', description: 'Переименовать: /prompt_rename <id> Имя' },
    { command: 'prompt_delete', description: 'Удалить: /prompt_delete <id>' },
    { command: 'prompt_default', description: 'Сделать дефолтным: /prompt_default <id>' },
    { command: 'history_user', description: 'История юзера: /history_user <user_id> [limit]' },
    { command: 'history_delete', description: 'Удалить сообщение: /history_delete <user_id> <message_id> [db|tg]' },
    { command: 'sync_plan_limits', description: 'Синхронизировать лимиты по планам' }
] as const;
const ADMIN_COMMANDS = [...BASE_COMMANDS, ...ADMIN_EXTRA_COMMANDS] as const;
const commandScopeCache = new Map<number, 'admin' | 'user'>();
const parseAdminId = (raw: string | undefined) => {
    if (!raw) return null;
    const normalized = raw.replace(/[^\d-]/g, '').trim();
    if (!normalized) return null;
    const parsed = Number.parseInt(normalized, 10);
    if (Number.isNaN(parsed) || parsed <= 0) return null;
    return parsed;
};
const encryptSecret = (text: string) => {
    const iv = crypto.randomBytes(ENCRYPTION_IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return `${iv.toString('hex')}${EMAIL_PASSWORD_DELIMITER}${encrypted.toString('hex')}`;
};
const normalizeMailProvider = (providerRaw: string | null | undefined): MailProvider | null => {
    const provider = (providerRaw || '').trim().toLowerCase();
    if (['yandex', 'ya', 'яндекс'].includes(provider)) return 'yandex';
    if (['google', 'gmail', 'гугл', 'googlemail'].includes(provider)) return 'google';
    return null;
};
const detectMailProviderByEmail = (emailRaw: string) => {
    const email = emailRaw.trim().toLowerCase();
    if (/@gmail\.com$/.test(email)) return 'google' as MailProvider;
    if (/@(yandex\.|ya\.)/.test(email)) return 'yandex' as MailProvider;
    return null;
};
const resolveImapProviderConfig = (providerRaw: string) => {
    const provider = normalizeMailProvider(providerRaw);
    if (provider === 'yandex') {
        return { provider: 'yandex', host: 'imap.yandex.ru', port: 993, secure: 1 };
    }
    if (provider === 'google') {
        return { provider: 'google', host: 'imap.gmail.com', port: 993, secure: 1 };
    }
    return null;
};

const ADMIN_IDS = (() => {
    const ids = new Set<number>();

    for (const raw of (process.env.ADMIN_IDS ?? '').split(/[,\s;]+/)) {
        const value = parseAdminId(raw);
        if (value) ids.add(value);
    }

    const singleAdminId = parseAdminId(process.env.ADMIN_ID);
    if (singleAdminId) {
        ids.add(singleAdminId);
    }

    for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith('ADMIN_ID_')) continue;
        const id = parseAdminId(value);
        if (id) ids.add(id);
    }

    return ids;
})();

type ChatRole = 'user' | 'assistant';
type UserStatus = 'none' | 'approved' | 'disapproved' | 'banned';
type MailProvider = 'yandex' | 'google';
type UserHistoryRow = {
    id: number;
    chat_id: number | null;
    role: ChatRole;
    content: string;
    telegram_message_id: number | null;
    created_at: string;
};
type UserRecord = {
    id: number;
    name: string | null;
    role: string;
    status: UserStatus;
    plan: UserPlan;
    tg_username: string | null;
    selected_prompt_id: number | null;
    custom_prompt_content: string | null;
    core_memory: string | null;
    imap_provider: string | null;
    imap_user: string | null;
    imap_pass: string | null;
    imap_host: string | null;
    imap_port: number | null;
    imap_secure: number | null;
    mail_check_limit: number;
    active_chat_id: number | null;
    timezone_offset: number | null;
    timezone_confirmed: number;
    daily_message_count: number;
    daily_message_limit: number;
    total_message_length: number;
    daily_tokens_used: number;
    total_tokens_used: number;
    daily_cost_rub: number;
    total_cost_rub: number;
    daily_web_search_count: number;
    daily_web_search_limit: number;
    total_web_search_count: number;
    daily_image_gen_count: number;
    daily_image_gen_limit: number;
    total_image_gen_count: number;
    context_window: number;
    context_window_max: number;
    max_context_tokens_limit?: number;
    max_context_tokens?: number;
    preferred_model?: string | null;
};
type PlanDurationCode = 'day' | 'week' | 'month' | 'year' | 'forever';
type TaskStatus = 'pending' | 'done' | 'error';
type TaskType = 'message' | 'smart_home' | 'ai_instruction';
type TaskRecurrenceType = 'once' | 'daily' | 'weekly';
type TaskNotifyMode = 'always' | 'never' | 'on_match' | 'on_condition';
type TaskRecord = {
    id: number;
    user_id: number;
    execute_at: number;
    task_type: TaskType;
    payload: string;
    status: TaskStatus;
    recurrence_type: TaskRecurrenceType;
    recurrence_weekday: number | null;
    timezone_offset: number | null;
    notify_mode: TaskNotifyMode;
    notify_condition: string | null;
};
type PromptRecord = {
    id: number;
    name: string;
    description: string;
    content: string;
    is_default: number;
};
type PendingUserRow = UserRecord & { created_at: string | null };
type BannedUserRow = UserRecord & { reason: string; banned_at: string };
type MailAccountRecord = {
    user_id: number;
    provider: MailProvider;
    imap_user: string;
    imap_pass: string;
    imap_host: string;
    imap_port: number;
    imap_secure: number;
};
type NoteRecord = {
    id: number;
    user_id: number;
    title: string;
    content: string;
    created_at: number;
    updated_at: number;
};
type NoteStatsRecord = {
    user_id: number;
    notes_count: number;
    notes_chars: number;
};
type MenuActionId = 'clear' | 'users' | 'rename' | 'add' | 'remove' | 'prompts' | 'current_prompt' | 'model' | 'context_size' | 'prompt_admin' | 'pending' | 'banned' | 'mail' | 'notes' | 'help';
type MenuActionButton = {
    id: MenuActionId;
    label: string;
    adminOnly: boolean;
    row: number;
};

const MAIN_MENU_TRIGGER_BUTTON = '📋 Меню';
const MAIN_MENU_ACTIONS: MenuActionButton[] = [
    { id: 'clear', label: '🧹 Очистить память', adminOnly: false, row: 1 },
    { id: 'users', label: '👥 Список пользователей', adminOnly: true, row: 1 },
    { id: 'rename', label: '✏️ Переименовать себя', adminOnly: false, row: 2 },
    { id: 'prompts', label: '🧠 Промпты', adminOnly: false, row: 2 },
    { id: 'current_prompt', label: '✅ Мой промпт', adminOnly: false, row: 3 },
    { id: 'model', label: '🤖 Сменить модель', adminOnly: false, row: 3 },
    { id: 'context_size', label: '🗂 Размер контекста', adminOnly: false, row: 3 },
    { id: 'add', label: '➕ Добавить пользователя', adminOnly: true, row: 3 },
    { id: 'remove', label: '➖ Удалить пользователя', adminOnly: true, row: 4 },
    { id: 'prompt_admin', label: '⚙️ Промпт-админ', adminOnly: true, row: 4 },
    { id: 'pending', label: '🕓 Заявки', adminOnly: true, row: 5 },
    { id: 'banned', label: '⛔ Забаненные', adminOnly: true, row: 5 },
    { id: 'mail', label: '📬 Почта', adminOnly: false, row: 6 },
    { id: 'notes', label: '📝 Заметки', adminOnly: false, row: 7 },
    { id: 'help', label: 'ℹ️ Подсказка', adminOnly: false, row: 8 }
];

const MENU_ACTION_BY_ID = Object.fromEntries(MAIN_MENU_ACTIONS.map(item => [item.id, item])) as Record<MenuActionId, MenuActionButton>;

const buildMenuTriggerKeyboard = () => Markup.keyboard([[MAIN_MENU_TRIGGER_BUTTON]]).resize().persistent();
const TZ_BUTTON_SET_UTC = '🕒 Указать UTC';
const TZ_BUTTON_SEND_LOCATION = '📍 Отправить геопозицию';
const buildTimezoneSetupKeyboard = () => Markup.keyboard([
    [TZ_BUTTON_SET_UTC],
    [Markup.button.locationRequest(TZ_BUTTON_SEND_LOCATION)]
]).resize().oneTime();

const buildMainMenuInlineKeyboard = (isAdmin: boolean) => {
    const visibleItems = MAIN_MENU_ACTIONS.filter(item => isAdmin || !item.adminOnly);
    const rows = [...new Set(visibleItems.map(item => item.row))]
        .sort((a, b) => a - b)
        .map(row => visibleItems
            .filter(item => item.row === row)
            .map(item => Markup.button.callback(item.label, `main:${item.id}`)));

    if (NOTES_WEBAPP_URL) {
        rows.push([
            { text: '📝 Заметки (WebApp)', web_app: { url: NOTES_WEBAPP_URL } } as any
        ]);
    }

    return Markup.inlineKeyboard(rows);
};

const buildMailMenuKeyboard = () => Markup.inlineKeyboard([
    [Markup.button.callback('➕ Добавить/обновить', 'mail:setup_help')],
    [Markup.button.callback('⚙️ Почта: настройки', 'mail:settings')],
    [Markup.button.callback('🟡 Инструкция Yandex', 'mail:instr:yandex')],
    [Markup.button.callback('🔵 Инструкция Google', 'mail:instr:google')],
    [Markup.button.callback('🗑 Удалить привязку', 'mail:forget')]
]);
const buildMailSettingsKeyboard = () => Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Изменить лимит', 'mail:limit:change')],
    [Markup.button.callback('⬅️ Назад', 'mail:settings:back')]
]);
const buildContextSettingsKeyboard = () => Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Изменить лимит', 'context:change')],
    [Markup.button.callback('⬅️ Назад в меню', 'context:back')]
]);

const syncCommandScopeForUser = async (userId: number, isAdmin: boolean) => {
    const nextRole: 'admin' | 'user' = isAdmin ? 'admin' : 'user';
    if (commandScopeCache.get(userId) === nextRole) return;

    const commands = isAdmin ? ADMIN_COMMANDS : BASE_COMMANDS;
    await bot.telegram.setMyCommands(commands as any, {
        scope: { type: 'chat', chat_id: userId }
    } as any);

    commandScopeCache.set(userId, nextRole);
};
type RenameFlowState = 'confirm' | 'await_name';
const renameFlows = new Map<number, RenameFlowState>();
const timezoneSetupFlows = new Map<number, 'await_offset'>();
const customPromptEditFlows = new Map<number, 'await_content'>();
const mailLimitFlows = new Map<number, 'await_limit'>();
const contextLimitFlows = new Map<number, 'await_limit'>();
const noteEditFlows = new Map<number, { noteId: number; page: number }>();
const adminUserContextLimitFlows = new Map<number, { targetUserId: number; page: number }>();
const adminUserMessageLimitFlows = new Map<number, { targetUserId: number; page: number }>();
const adminAiMessageFlow = new Map<number, number>();

const startSelfRenameFlow = (ctx: any) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    renameFlows.set(userId, 'confirm');
    return ctx.reply('Вы хотите сменить имя?', Markup.keyboard([['Да', 'Нет']]).resize().oneTime());
};

const sendLongMessage = async (ctx: any, text: string, extra?: Record<string, unknown>) => {
    const MAX_LENGTH = 4000;
    const source = typeof text === 'string' ? text : String(text ?? '');
    const chunks: string[] = [];
    for (let i = 0; i < source.length; i += MAX_LENGTH) {
        chunks.push(source.substring(i, i + MAX_LENGTH));
    }
    if (!chunks.length) chunks.push('');

    let lastMessage: any = null;
    for (const chunk of chunks) {
        lastMessage = await ctx.reply(chunk, extra);
    }
    return lastMessage;
};

const safeReply = async (ctx: any, text: string) => {
    const tgFormattedText = text
        // 1. Бывает, что ИИ генерит заголовок сразу с жирным шрифтом (### **Текст**) — чистим двойное форматирование
        .replace(/^#+\s+\*\*(.*?)\*\*/gm, '🔹 *$1*')
        // 2. Обычные заголовки (### Текст) -> делаем жирными с иконкой
        .replace(/^#+\s+(.*)/gm, '🔹 *$1*')
        // 3. Звездочки-списки
        .replace(/^\*\s/gm, '• ')
        // 4. Обычный жирный шрифт
        .replace(/\*\*(.*?)\*\*/g, '*$1*');

    try {
        return await sendLongMessage(ctx, tgFormattedText, { parse_mode: 'Markdown' });
    } catch (err) {
        console.warn('Ошибка разметки, отправляю чистый текст');
        return await sendLongMessage(ctx, text);
    }
};

type ScheduleTaskArgs = {
    local_time?: string;
    delay_seconds?: number;
    execute_at?: number;
    task_type?: TaskType;
    payload?: string;
    target_chat_id?: number;
    create_new_chat?: boolean;
    recurrence_type?: TaskRecurrenceType;
    recurrence_weekday?: number;
    notify_mode?: TaskNotifyMode;
    notify_condition?: string;
};

const safeSendToUser = async (chatId: number, text: string) => {
    try {
        await bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (err) {
        await bot.telegram.sendMessage(chatId, text);
    }
};

const handleAiDirectMessage = async (ctx: any, targetUserId: number, instruction: string) => {
    const targetUser = await getUser(targetUserId);
    if (!targetUser) {
        await ctx.reply('Юзер не найден в базе.');
        return;
    }

    const thought = instruction.trim();
    if (!thought) {
        await ctx.reply('Пустое сообщение. Напиши, что нужно передать.');
        return;
    }

    const targetUserName = targetUser.name || targetUser.tg_username || 'Друг';
    await ctx.reply('⏳ Нейросеть формулирует послание...');

    try {
        if (!BACKEND_INTERNAL_TOKEN) {
            throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
        }

        const response = await axios.post(
            `${BACKEND_API_BASE_URL}/internal/ai/admin-outreach`,
            {
                target_user_id: targetUserId,
                admin_instruction: thought
            },
            {
                headers: {
                    Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}`
                },
                timeout: BACKEND_TIMEOUT_AI_MS
            }
        );

        const finalMessage = (response.data?.reply_text || '').trim();
        if (!finalMessage) {
            await ctx.reply('❌ Не получилось сгенерировать текст, попробуй ещё раз.');
            return;
        }

        await safeSendToUser(targetUserId, finalMessage);

        // Отправка сгенерированных изображений юзеру
        if (Array.isArray(response.data?.generated_images) && response.data.generated_images.length > 0) {
            for (const img of response.data.generated_images) {
                try {
                    const imageBuffer = Buffer.from(img.image_base64, 'base64');
                    await bot.telegram.sendPhoto(targetUserId, { source: imageBuffer });
                } catch (imgErr) {
                    console.error('Ошибка отправки сгенерированного изображения юзеру:', imgErr);
                }
            }
        }

        await ctx.reply(
            `✅ Сообщение отправлено пользователю ${targetUserName} (ID: ${targetUserId}).\n\nТекст, который отправила нейросеть:\n${finalMessage}`
        );
    } catch (err) {
        await ctx.reply(`❌ Ошибка генерации: ${err instanceof Error ? err.message : String(err)}`);
    }
};

const ISO_WEEKDAY_LABEL: Record<number, string> = {
    1: 'понедельник',
    2: 'вторник',
    3: 'среда',
    4: 'четверг',
    5: 'пятница',
    6: 'суббота',
    7: 'воскресенье'
};

const formatRecurrenceForDisplay = (task: TaskRecord) => {
    if (task.recurrence_type === 'daily') return 'Каждый день';
    if (task.recurrence_type === 'weekly') {
        const label = task.recurrence_weekday ? ISO_WEEKDAY_LABEL[task.recurrence_weekday] : null;
        return label ? `Каждую неделю (${label})` : 'Каждую неделю';
    }
    return 'Один раз';
};

const formatUnixForTimezone = (unixSeconds: number, timezoneOffset: number) => {
    const local = new Date((unixSeconds + timezoneOffset * 3600) * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const utc = new Date(unixSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const sign = timezoneOffset >= 0 ? '+' : '';
    return {
        local,
        utc,
        tzLabel: `UTC${sign}${timezoneOffset}`
    };
};

const formatTaskForDisplay = async (task: TaskRecord) => {
    const payloadPreview = task.payload.length > 140 ? `${task.payload.slice(0, 140)}...` : task.payload;
    const recurrence = formatRecurrenceForDisplay(task);
    const fallbackOffset = (await getUser(task.user_id))?.timezone_offset ?? 5;
    const timezoneOffset = typeof task.timezone_offset === 'number' ? task.timezone_offset : fallbackOffset;
    const when = formatUnixForTimezone(task.execute_at, timezoneOffset);
    const notifyText = (task.notify_mode === 'on_match' || task.notify_mode === 'on_condition')
        ? `${task.notify_mode}: ${task.notify_condition || '(пусто)'}`
        : task.notify_mode;
    return `#${task.id} | ${task.task_type} | ${task.status}\nКогда: ${when.local} (${when.tzLabel})\nКогда (UTC): ${when.utc} UTC\nРасписание: ${recurrence}\nУведомления: ${notifyText}\nДанные: ${payloadPreview}`;
};

const formatTasksList = async (tasks: TaskRecord[], emptyText = 'Задач не найдено.') => (
    tasks.length ? (await Promise.all(tasks.map(formatTaskForDisplay))).join('\n\n') : emptyText
);

const getIsoWeekday = (date: Date) => {
    const day = date.getUTCDay();
    return day === 0 ? 7 : day;
};

const parseLocalTime = (value: string) => {
    const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;

    const hours = Number.parseInt(match[1], 10);
    const minutes = Number.parseInt(match[2], 10);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

    return { hours, minutes };
};

const computeExecuteAtFromLocalTime = (
    localTime: string,
    timezoneOffset: number,
    recurrenceType: TaskRecurrenceType,
    recurrenceWeekday: number | null
) => {
    const parsedTime = parseLocalTime(localTime);
    if (!parsedTime) {
        throw new Error('Некорректный local_time. Ожидаю формат HH:MM, например 02:07.');
    }

    const nowUnix = Math.floor(Date.now() / 1000);
    const localNow = new Date((nowUnix + timezoneOffset * 3600) * 1000);
    const targetLocal = new Date(localNow.getTime());
    targetLocal.setUTCHours(parsedTime.hours, parsedTime.minutes, 0, 0);

    if (recurrenceType === 'weekly') {
        if (!recurrenceWeekday || recurrenceWeekday < 1 || recurrenceWeekday > 7) {
            throw new Error('Для weekly укажи recurrence_weekday от 1 до 7 (1=понедельник).');
        }

        const currentWeekday = getIsoWeekday(targetLocal);
        let deltaDays = (recurrenceWeekday - currentWeekday + 7) % 7;
        if (deltaDays === 0 && targetLocal.getTime() <= localNow.getTime()) deltaDays = 7;
        if (deltaDays > 0) targetLocal.setUTCDate(targetLocal.getUTCDate() + deltaDays);
    } else if (targetLocal.getTime() <= localNow.getTime()) {
        targetLocal.setUTCDate(targetLocal.getUTCDate() + 1);
    }

    return Math.floor(targetLocal.getTime() / 1000 - timezoneOffset * 3600);
};

const computeExecuteAtFromScheduleArgs = (
    args: ScheduleTaskArgs,
    timezoneOffset: number,
    recurrenceType: TaskRecurrenceType,
    recurrenceWeekday: number | null
) => {
    if (typeof args.local_time === 'string' && args.local_time.trim()) {
        return computeExecuteAtFromLocalTime(args.local_time, timezoneOffset, recurrenceType, recurrenceWeekday);
    }

    if (typeof args.delay_seconds === 'number') {
        if (!Number.isFinite(args.delay_seconds) || args.delay_seconds < 0) {
            throw new Error('Некорректный delay_seconds (ожидаю число >= 0).');
        }
        return Math.floor(Date.now() / 1000) + Math.floor(args.delay_seconds);
    }

    const executeAt = Number(args.execute_at);
    if (Number.isFinite(executeAt) && executeAt > 0) {
        return Math.floor(executeAt);
    }

    throw new Error('Не указано время задачи. Передай local_time (HH:MM), delay_seconds или execute_at.');
};

const runBackendAiSend = async (
    userId: number,
    text: string,
    options?: {
        forcePro?: boolean;
        persistUserText?: string;
        ignoreDailyLimit?: boolean;
        countAsUserMessage?: boolean;
        skipHistory?: boolean;
        userTelegramChatId?: number | null;
        userTelegramMessageId?: number | null;
        assistantTelegramChatId?: number | null;
        documents?: Array<{ filename: string; base64: string }>;
    }
) => {
    if (!BACKEND_INTERNAL_TOKEN) {
        throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    }

    const response = await axios.post(
        `${BACKEND_API_BASE_URL}/internal/ai/send`,
        {
            user_id: userId,
            text,
            options: {
                forcePro: Boolean(options?.forcePro),
                ignoreDailyLimit: Boolean(options?.ignoreDailyLimit),
                countAsUserMessage: options?.countAsUserMessage === false ? false : true,
                skipHistory: Boolean(options?.skipHistory),
                persistUserText: typeof options?.persistUserText === 'string' ? options.persistUserText : undefined,
                userTelegramChatId: Number.isFinite(Number(options?.userTelegramChatId)) ? Math.floor(Number(options?.userTelegramChatId)) : null,
                userTelegramMessageId: Number.isFinite(Number(options?.userTelegramMessageId)) ? Math.floor(Number(options?.userTelegramMessageId)) : null,
                assistantTelegramChatId: Number.isFinite(Number(options?.assistantTelegramChatId)) ? Math.floor(Number(options?.assistantTelegramChatId)) : null
            },
            ...(Array.isArray(options?.documents) && options.documents.length > 0 ? { documents: options.documents } : {})
        },
        {
            headers: {
                Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}`
            },
            timeout: BACKEND_TIMEOUT_AI_MS,
            maxBodyLength: Infinity
        }
    );

    return response.data as {
        message_id?: number;
        reply_text?: string;
        model_fallback_notice?: string | null;
        tool_user_messages?: string[];
        generated_images?: Array<{ image_base64: string; prompt_used: string }>;
        usage?: {
            tokens_used?: number;
            used_model?: string;
            used_provider?: string;
        };
    };
};

type AiStreamCallbacks = {
    onIntermediate?: (text: string) => Promise<void> | void;
    onToolStatus?: (text: string) => Promise<void> | void;
    onDesktopAction?: (action: any) => Promise<void> | void;
};

const runBackendAiStream = async (
    userId: number,
    text: string,
    options?: {
        forcePro?: boolean;
        persistUserText?: string;
        ignoreDailyLimit?: boolean;
        countAsUserMessage?: boolean;
        skipHistory?: boolean;
        userTelegramChatId?: number | null;
        userTelegramMessageId?: number | null;
        assistantTelegramChatId?: number | null;
        documents?: Array<{ filename: string; base64: string }>;
    },
    callbacks?: AiStreamCallbacks
): Promise<{
    message_id?: number;
    reply_text?: string;
    model_fallback_notice?: string | null;
    tool_user_messages?: string[];
    generated_images?: Array<{ image_base64: string; prompt_used: string }>;
    usage?: {
        tokens_used?: number;
        used_model?: string;
        used_provider?: string;
    };
    desktop_action?: any;
}> => {
    if (!BACKEND_INTERNAL_TOKEN) {
        throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    }

    const response = await axios.post(
        `${BACKEND_API_BASE_URL}/internal/ai/stream`,
        {
            user_id: userId,
            text,
            options: {
                forcePro: Boolean(options?.forcePro),
                ignoreDailyLimit: Boolean(options?.ignoreDailyLimit),
                countAsUserMessage: options?.countAsUserMessage === false ? false : true,
                skipHistory: Boolean(options?.skipHistory),
                persistUserText: typeof options?.persistUserText === 'string' ? options.persistUserText : undefined,
                userTelegramChatId: Number.isFinite(Number(options?.userTelegramChatId)) ? Math.floor(Number(options?.userTelegramChatId)) : null,
                userTelegramMessageId: Number.isFinite(Number(options?.userTelegramMessageId)) ? Math.floor(Number(options?.userTelegramMessageId)) : null,
                assistantTelegramChatId: Number.isFinite(Number(options?.assistantTelegramChatId)) ? Math.floor(Number(options?.assistantTelegramChatId)) : null
            },
            ...(Array.isArray(options?.documents) && options.documents.length > 0 ? { documents: options.documents } : {})
        },
        {
            headers: {
                Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}`
            },
            responseType: 'stream',
            timeout: BACKEND_TIMEOUT_AI_MS,
            maxBodyLength: Infinity
        }
    );

    const stream = response.data as NodeJS.ReadableStream;

    return new Promise((resolve, reject) => {
        let buffer = '';
        let currentEvent = '';
        let finalResult: any = null;
        let streamError: string | null = null;

        const processSSE = async (raw: string) => {
            const lines = raw.split('\n');
            for (const line of lines) {
                if (line.startsWith('event: ')) {
                    currentEvent = line.slice(7).trim();
                } else if (line.startsWith('data: ')) {
                    const dataStr = line.slice(6);
                    try {
                        const data = JSON.parse(dataStr);
                        switch (currentEvent) {
                            case 'intermediate':
                                if (callbacks?.onIntermediate) await callbacks.onIntermediate(data.text);
                                break;
                            case 'tool_status':
                                if (callbacks?.onToolStatus) await callbacks.onToolStatus(data.text);
                                break;
                            case 'desktop_action':
                                if (callbacks?.onDesktopAction) {
                                    Promise.resolve(callbacks.onDesktopAction(data)).catch((err: any) => {
                                        console.warn('[tg][sse] desktop_action callback failed:', err?.message || err);
                                    });
                                }
                                break;
                            case 'done':
                                finalResult = data;
                                break;
                            case 'error':
                                streamError = data.error || 'unknown_error';
                                break;
                        }
                    } catch {
                        // ignore JSON parse errors on partial chunks
                    }
                    currentEvent = '';
                }
            }
        };

        stream.on('data', async (chunk: Buffer) => {
            buffer += chunk.toString();
            // SSE events separated by double newline
            const parts = buffer.split('\n\n');
            buffer = parts.pop() || '';
            for (const part of parts) {
                await processSSE(part);
            }
        });

        stream.on('end', () => {
            // Process any remaining buffered data
            if (buffer.trim()) {
                processSSE(buffer).then(() => {
                    if (streamError) {
                        reject(new Error(streamError));
                    } else {
                        resolve(finalResult || { reply_text: '' });
                    }
                });
            } else {
                if (streamError) {
                    reject(new Error(streamError));
                } else {
                    resolve(finalResult || { reply_text: '' });
                }
            }
        });

        stream.on('error', (err: any) => {
            reject(err);
        });
    });
};

const runBackendVoiceTurn = async (
    userId: number,
    audioBuffer: Buffer,
    mimeType: string,
    options?: {
        chatId?: number;
        userTelegramChatId?: number | null;
        userTelegramMessageId?: number | null;
        assistantTelegramChatId?: number | null;
    }
) => {
    if (!BACKEND_INTERNAL_TOKEN) {
        throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    }
    const response = await axios.post(
        `${BACKEND_API_BASE_URL}/internal/voice/turn`,
        {
            user_id: userId,
            audio_base64: audioBuffer.toString('base64'),
            mime_type: mimeType || 'audio/ogg',
            chat_id: Number.isFinite(Number(options?.chatId)) ? Math.floor(Number(options?.chatId)) : undefined,
            options: {
                userTelegramChatId: Number.isFinite(Number(options?.userTelegramChatId)) ? Math.floor(Number(options?.userTelegramChatId)) : null,
                userTelegramMessageId: Number.isFinite(Number(options?.userTelegramMessageId)) ? Math.floor(Number(options?.userTelegramMessageId)) : null,
                assistantTelegramChatId: Number.isFinite(Number(options?.assistantTelegramChatId)) ? Math.floor(Number(options?.assistantTelegramChatId)) : null
            }
        },
        {
            headers: {
                Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}`
            },
            timeout: BACKEND_TIMEOUT_MEDIA_MS,
            maxBodyLength: Infinity
        }
    );

    return response.data as {
        recognized_text?: string;
        reply_text?: string;
        voice_audio_base64?: string | null;
        voice_mime_type?: string | null;
        voice_error?: string | null;
        model_fallback_notice?: string | null;
        tool_user_messages?: string[];
        message_id?: number | null;
    };
};

const runBackendPhotoAnalyze = async (
    userId: number,
    imageBuffer: Buffer,
    imageMimeType: string,
    caption: string,
    options?: {
        chatId?: number;
        userTelegramChatId?: number | null;
        userTelegramMessageId?: number | null;
        extraImages?: Array<{ base64: string; mimeType: string }>;
    }
) => {
    if (!BACKEND_INTERNAL_TOKEN) {
        throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    }
    const response = await axios.post(
        `${BACKEND_API_BASE_URL}/internal/photo/analyze`,
        {
            user_id: userId,
            image_base64: imageBuffer.toString('base64'),
            image_mime_type: imageMimeType || 'image/jpeg',
            caption: caption || '',
            chat_id: Number.isFinite(Number(options?.chatId)) ? Math.floor(Number(options?.chatId)) : undefined,
            extra_images: options?.extraImages?.map(img => ({ base64: img.base64, mime_type: img.mimeType })),
            options: {
                userTelegramChatId: Number.isFinite(Number(options?.userTelegramChatId)) ? Math.floor(Number(options?.userTelegramChatId)) : null,
                userTelegramMessageId: Number.isFinite(Number(options?.userTelegramMessageId)) ? Math.floor(Number(options?.userTelegramMessageId)) : null
            }
        },
        {
            headers: {
                Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}`
            },
            timeout: BACKEND_TIMEOUT_MEDIA_MS,
            maxBodyLength: Infinity
        }
    );

    return response.data as {
        message_id?: number | null;
        reply_text?: string;
        model_fallback_notice?: string | null;
        used_model?: string;
        used_provider?: string;
        tokens_used?: number;
        chat_id?: number;
    };
};

const runBackendBindTelegramMessage = async (
    userId: number,
    messageId: number,
    telegramChatId: number | null,
    telegramMessageId: number | null
) => {
    if (!BACKEND_INTERNAL_TOKEN) {
        throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    }
    await axios.post(
        `${BACKEND_API_BASE_URL}/internal/messages/bind-telegram`,
        {
            user_id: userId,
            message_id: messageId,
            telegram_chat_id: Number.isFinite(Number(telegramChatId)) ? Math.floor(Number(telegramChatId)) : null,
            telegram_message_id: Number.isFinite(Number(telegramMessageId)) ? Math.floor(Number(telegramMessageId)) : null
        },
        {
            headers: {
                Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}`
            },
            timeout: BACKEND_TIMEOUT_DEFAULT_MS
        }
    );
};
// ── Backend API helpers for prompts, mail, timezone, context ─────────────

const backendHeaders = () => ({
    Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}`
});

const runBackendGetPrompts = async () => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.get(`${BACKEND_API_BASE_URL}/internal/prompts`, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { prompts: Array<{ id: number; name: string; description: string; content: string; is_default: number }> };
};

const runBackendGetPrompt = async (promptId: number) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.get(`${BACKEND_API_BASE_URL}/internal/prompts/${promptId}`, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { prompt: { id: number; name: string; description: string; content: string; is_default: number } };
};

const runBackendCreatePrompt = async (name: string, description: string, content: string) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.post(`${BACKEND_API_BASE_URL}/internal/prompts`, { name, description, content }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean; prompt_id: number };
};

const runBackendUpdatePromptName = async (promptId: number, name: string) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.put(`${BACKEND_API_BASE_URL}/internal/prompts/${promptId}/name`, { name }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean };
};

const runBackendUpdatePromptDescription = async (promptId: number, description: string) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.put(`${BACKEND_API_BASE_URL}/internal/prompts/${promptId}/description`, { description }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean };
};

const runBackendUpdatePromptContent = async (promptId: number, content: string) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.put(`${BACKEND_API_BASE_URL}/internal/prompts/${promptId}/content`, { content }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean };
};

const runBackendSetDefaultPrompt = async (promptId: number) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.put(`${BACKEND_API_BASE_URL}/internal/prompts/${promptId}/default`, {}, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean };
};

const runBackendDeletePrompt = async (promptId: number) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.delete(`${BACKEND_API_BASE_URL}/internal/prompts/${promptId}`, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean };
};

const runBackendSetTimezone = async (userId: number, offset: number) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.post(`${BACKEND_API_BASE_URL}/internal/user/timezone`, { user_id: userId, timezone_offset: offset }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean };
};

const runBackendSetContextWindow = async (userId: number, contextWindow: number, isAdmin: boolean) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.post(`${BACKEND_API_BASE_URL}/internal/user/context-window`, { user_id: userId, context_window: contextWindow, is_admin: isAdmin }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean };
};

const runBackendSetContextTokens = async (userId: number, maxContextTokens: number) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.post(`${BACKEND_API_BASE_URL}/internal/user/context-tokens-limit`, { user_id: userId, max_context_tokens: maxContextTokens }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean; max_context_tokens: number; max_context_tokens_limit: number };
};

const runBackendMailSetup = async (userId: number, provider: string, email: string, appPassword: string) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.post(`${BACKEND_API_BASE_URL}/internal/mail/setup`, { user_id: userId, provider, email, app_password: appPassword }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean; accounts: Array<{ provider: string; imap_user: string }> };
};

const runBackendMailUse = async (userId: number, provider: string) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.post(`${BACKEND_API_BASE_URL}/internal/mail/use`, { user_id: userId, provider }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean; provider: string; imap_user: string };
};

const runBackendMailLimit = async (userId: number, limit: number) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.put(`${BACKEND_API_BASE_URL}/internal/mail/limit`, { user_id: userId, limit }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean; limit: number };
};

const runBackendMailForget = async (userId: number, provider?: string | null) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.delete(`${BACKEND_API_BASE_URL}/internal/mail/account`, { data: { user_id: userId, provider: provider || undefined }, headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean; deleted: string; remaining?: Array<{ provider: string; imap_user: string }>; new_active?: { provider: string; imap_user: string } };
};

// ── Backend API helpers for user management ───────────────────────────────

const runBackendUpsertTelegramUser = async (tgId: number, name: string, role: string, status: string, tgUsername: string | null, defaultPromptId: number | null) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.post(`${BACKEND_API_BASE_URL}/internal/users/upsert-telegram`, { tg_id: tgId, name, role, status, tg_username: tgUsername, default_prompt_id: defaultPromptId }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean; user: UserRecord };
};

const runBackendCreatePendingUser = async (tgId: number, name: string | null, tgUsername: string | null, defaultPromptId: number | null) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.post(`${BACKEND_API_BASE_URL}/internal/users/create-pending`, { tg_id: tgId, name, tg_username: tgUsername, default_prompt_id: defaultPromptId }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean; user: UserRecord };
};

const runBackendGetUser = async (userId: number) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    try {
        const response = await axios.get(`${BACKEND_API_BASE_URL}/internal/users/${userId}`, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
        return response.data as { user: UserRecord };
    } catch (err: any) {
        if (err?.response?.status === 404) return { user: undefined };
        throw err;
    }
};

const runBackendUpdateTgUsername = async (userId: number, tgUsername: string | null) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.put(`${BACKEND_API_BASE_URL}/internal/users/${userId}/tg-username`, { user_id: userId, tg_username: tgUsername }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean };
};

const runBackendUpdateUserStatus = async (userId: number, status: string) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.put(`${BACKEND_API_BASE_URL}/internal/users/${userId}/status`, { status }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean; status: string };
};

const runBackendUpdateUserRole = async (userId: number, role: string) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.put(`${BACKEND_API_BASE_URL}/internal/users/${userId}/role`, { role }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean; role: string };
};

const runBackendUpdateUserName = async (userId: number, name: string) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.put(`${BACKEND_API_BASE_URL}/internal/users/${userId}/name`, { name }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean; name: string };
};

const runBackendRemoveUser = async (userId: number) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.delete(`${BACKEND_API_BASE_URL}/internal/users/${userId}`, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean };
};

const runBackendGetUsersList = async (filter: string, limit: number, offset: number) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.get(`${BACKEND_API_BASE_URL}/internal/users`, { params: { filter, limit, offset }, headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { users: UserRecord[]; total: number; filter: string; limit: number; offset: number };
};

const runBackendUpdateUserPlan = async (userId: number, plan: string) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.post(`${BACKEND_API_BASE_URL}/internal/users/${userId}/plan`, { plan }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean; plan: string };
};

const runBackendSyncPlanLimits = async () => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.post(`${BACKEND_API_BASE_URL}/internal/sync-plan-limits`, {}, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean };
};

const runBackendBanUser = async (userId: number, bannedBy: number, reason: string) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.post(`${BACKEND_API_BASE_URL}/internal/users/${userId}/ban`, { reason, banned_by: bannedBy }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean; reason: string };
};

const runBackendUnbanUser = async (userId: number) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.delete(`${BACKEND_API_BASE_URL}/internal/users/${userId}/ban`, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean; status: string };
};

const runBackendGetBanRecord = async (userId: number) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.get(`${BACKEND_API_BASE_URL}/internal/users/${userId}/ban`, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ban: { user_id: number; reason: string; banned_at: string; banned_by: number | null } | null };
};

const runBackendSelectUserPrompt = async (userId: number, promptId: number) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.post(`${BACKEND_API_BASE_URL}/internal/users/${userId}/prompt/select`, { prompt_id: promptId }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean };
};

const runBackendUpdateCustomPrompt = async (userId: number, content: string) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.put(`${BACKEND_API_BASE_URL}/internal/users/${userId}/prompt/custom`, { content }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean };
};

type ModelsCatalogEntry = { id: string; name: string; description: string };

const runBackendGetModels = async (userId: number) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.get(`${BACKEND_API_BASE_URL}/internal/users/${userId}/preferred-model`, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { models: ModelsCatalogEntry[]; preferred_model: string | null };
};

const runBackendSetPreferredModel = async (userId: number, modelId: string | null) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.put(`${BACKEND_API_BASE_URL}/internal/users/${userId}/preferred-model`, { model_id: modelId }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean; preferred_model: string | null };
};

const runBackendResetUsersPromptIfDeleted = async (promptId: number) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.post(`${BACKEND_API_BASE_URL}/internal/prompts/reset-users`, { prompt_id: promptId }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean };
};

type UserChatRecord = {
    id: number;
    user_id: number;
    title: string;
    created_at: string;
    updated_at: string;
};

const scheduleDailyCounterReset = () => {
    // Сброс делегирован на backend-api (scheduler.ts)
    // TG бот больше не сбрасывает daily counters самостоятельно
    console.log('[daily-reset] Сброс счётчиков делегирован на backend-api.');
};

// Вспомогательные функции для БД
const getPromptById = (id: number) => db.prepare('SELECT * FROM prompts WHERE id = ?').get(id) as PromptRecord | undefined;
const getAllPrompts = () => db.prepare('SELECT * FROM prompts ORDER BY id').all() as PromptRecord[];
const getDefaultPrompt = () => db.prepare('SELECT * FROM prompts WHERE is_default = 1 LIMIT 1').get() as PromptRecord | undefined;
const createPrompt = (name: string, description: string, content: string, isDefault = false) => {
    if (isDefault) db.prepare('UPDATE prompts SET is_default = 0').run();
    return db.prepare(`
        INSERT INTO prompts (name, description, content, is_default)
        VALUES (?, ?, ?, ?)
    `).run(name, description, content, isDefault ? 1 : 0);
};
const updatePromptName = (id: number, name: string) => db.prepare(`
    UPDATE prompts
    SET name = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
`).run(name, id);
const updatePromptDescription = (id: number, description: string) => db.prepare(`
    UPDATE prompts
    SET description = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
`).run(description, id);
const updatePromptContent = (id: number, content: string) => db.prepare(`
    UPDATE prompts
    SET content = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
`).run(content, id);
const setDefaultPrompt = (id: number) => {
    db.prepare('UPDATE prompts SET is_default = 0').run();
    return db.prepare('UPDATE prompts SET is_default = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
};
const deletePrompt = (id: number) => db.prepare('DELETE FROM prompts WHERE id = ?').run(id);

const ensureDefaultPrompt = () => {
    const defaultPrompt = getDefaultPrompt();
    if (defaultPrompt) return defaultPrompt;

    const firstPrompt = db.prepare('SELECT * FROM prompts ORDER BY id LIMIT 1').get() as PromptRecord | undefined;
    if (firstPrompt) {
        setDefaultPrompt(firstPrompt.id);
        return { ...firstPrompt, is_default: 1 };
    }

    const created = createPrompt('Default', 'Стандартный стиль общения Chatter', DEFAULT_PROMPT_CONTENT, true);
    return getPromptById(Number(created.lastInsertRowid));
};

const defaultPromptSeed = ensureDefaultPrompt();
if (!defaultPromptSeed) {
    throw new Error('Не удалось инициализировать дефолтный промпт.');
}

const normalizeTextPreview = (value: string, maxLen = 120) => {
    const compact = value.replace(/\s+/g, ' ').trim();
    if (!compact) return '';
    return compact.length > maxLen ? `${compact.slice(0, maxLen)}...` : compact;
};
const extractCommandPayload = (messageText: string, command: string) => {
    const pattern = new RegExp(`^\\/${command}(?:@\\w+)?\\s*`, 'i');
    return messageText.replace(pattern, '').trim();
};
const createNote = (userId: number, content: string, title = '') => {
    const nowTs = Math.floor(Date.now() / 1000);
    return db.prepare(`
        INSERT INTO notes (user_id, title, content, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(userId, title, content, nowTs, nowTs);
};
const deleteNoteByUserAndId = (userId: number, noteId: number) => db.prepare(`
    DELETE FROM notes
    WHERE user_id = ? AND id = ?
`).run(userId, noteId);
const updateNoteByUserAndId = (userId: number, noteId: number, content: string) => {
    const nowTs = Math.floor(Date.now() / 1000);
    return db.prepare(`
        UPDATE notes
        SET content = ?, updated_at = ?
        WHERE user_id = ? AND id = ?
    `).run(content, nowTs, userId, noteId);
};
const getNoteByUserAndId = (userId: number, noteId: number) => db.prepare(`
    SELECT id, user_id, title, content, created_at, updated_at
    FROM notes
    WHERE user_id = ? AND id = ?
`).get(userId, noteId) as NoteRecord | undefined;
const getNotesPage = (userId: number, limit: number, offset: number, query = '') => {
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
    const safeOffset = Math.max(0, Math.floor(offset));
    const trimmed = query.trim();
    if (!trimmed) {
        return db.prepare(`
            SELECT id, user_id, title, content, created_at, updated_at
            FROM notes
            WHERE user_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ? OFFSET ?
        `).all(userId, safeLimit, safeOffset) as NoteRecord[];
    }
    const like = `%${trimmed}%`;
    return db.prepare(`
        SELECT id, user_id, title, content, created_at, updated_at
        FROM notes
        WHERE user_id = ? AND (title LIKE ? OR content LIKE ?)
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
    `).all(userId, like, like, safeLimit, safeOffset) as NoteRecord[];
};
const countNotes = (userId: number, query = '') => {
    const trimmed = query.trim();
    if (!trimmed) {
        return (db.prepare(`SELECT COUNT(*) as c FROM notes WHERE user_id = ?`).get(userId) as { c: number }).c;
    }
    const like = `%${trimmed}%`;
    return (db.prepare(`
        SELECT COUNT(*) as c
        FROM notes
        WHERE user_id = ? AND (title LIKE ? OR content LIKE ?)
    `).get(userId, like, like) as { c: number }).c;
};
const getPlanNotesLimit = (plan: UserPlan) => PLAN_NOTES_LIMITS[plan] ?? PLAN_NOTES_LIMITS[DEFAULT_USER_PLAN];
const getPlanNoteContentLimit = (plan: UserPlan) => PLAN_NOTE_CONTENT_LIMITS[plan] ?? PLAN_NOTE_CONTENT_LIMITS[DEFAULT_USER_PLAN];
const getPlanNoteListLimit = (plan: UserPlan) => PLAN_NOTE_LIST_LIMITS[plan] ?? PLAN_NOTE_LIST_LIMITS[DEFAULT_USER_PLAN];
const formatNoteDate = (unixTs: number) => {
    if (!Number.isFinite(unixTs) || unixTs <= 0) return 'дата неизвестна';
    return new Date(unixTs * 1000).toLocaleString('ru-RU');
};
const formatNotesPage = (notes: NoteRecord[], page: number, total: number, pageSize: number, query?: string) => {
    if (!notes.length) {
        return query
            ? `По запросу "${query}" ничего не найдено.`
            : 'Заметок пока нет.';
    }
    const safePage = Math.max(1, page);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const head = query
        ? `Заметки по запросу "${query}" (${total}):`
        : `Заметки (${total}):`;
    const list = notes.map(note => {
        const titlePart = note.title?.trim() ? `${normalizeTextPreview(note.title, 40)} | ` : '';
        return `#${note.id} [${formatNoteDate(note.created_at)}] — ${titlePart}${normalizeTextPreview(note.content, 120)}`;
    }).join('\n');
    return `${head}\n${list}\n\nСтраница ${safePage}/${totalPages}.`;
};
const getNoteMenuTitle = (note: NoteRecord) => {
    const title = (note.title || '').trim();
    if (title) return normalizeTextPreview(title, 48);
    return normalizeTextPreview(note.content || 'Без текста', 48);
};
const buildNotesMenuKeyboard = (notes: NoteRecord[], page: number, total: number) => {
    const keyboardRows = notes.map(note => [
        Markup.button.callback(
            `#${note.id} ${getNoteMenuTitle(note)}`,
            `notes:view:${note.id}:${page}`
        )
    ]);

    const navRow = [];
    if (page > 0) navRow.push(Markup.button.callback('⬅️ Назад', `notes:list:${page - 1}`));
    if ((page + 1) * NOTES_MENU_PAGE_SIZE < total) navRow.push(Markup.button.callback('➡️ Далее', `notes:list:${page + 1}`));
    if (navRow.length) keyboardRows.push(navRow);

    keyboardRows.push([Markup.button.callback('⬅️ В меню', 'notes:back:menu')]);
    return Markup.inlineKeyboard(keyboardRows);
};
const buildNoteViewKeyboard = (noteId: number, page: number) => Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Редактировать', `notes:edit:${noteId}:${page}`)],
    [Markup.button.callback('🗑 Удалить', `notes:delete:${noteId}:${page}`)],
    [Markup.button.callback('⬅️ К списку заметок', `notes:list:${page}`)],
    [Markup.button.callback('⬅️ В меню', 'notes:back:menu')]
]);
const renderNotesMenuList = async (ctx: any, userId: number, page: number, mode: 'reply' | 'edit' = 'reply') => {
    const safePage = Math.max(0, page);
    const total = countNotes(userId);
    if (!total) {
        const text = 'Заметок пока нет. Можно добавить через /note_add <текст>.';
        const keyboard = Markup.inlineKeyboard([[Markup.button.callback('⬅️ В меню', 'notes:back:menu')]]);
        if (mode === 'edit') return ctx.editMessageText(text, keyboard);
        return ctx.reply(text, keyboard);
    }

    const offset = safePage * NOTES_MENU_PAGE_SIZE;
    const notes = getNotesPage(userId, NOTES_MENU_PAGE_SIZE, offset);
    const pages = Math.max(1, Math.ceil(total / NOTES_MENU_PAGE_SIZE));
    const text = `📝 Заметки\nСтраница: ${safePage + 1}/${pages}\nВсего: ${total}\n\nНажми на заметку, чтобы открыть полностью.`;
    const keyboard = buildNotesMenuKeyboard(notes, safePage, total);
    if (mode === 'edit') return ctx.editMessageText(text, keyboard);
    return ctx.reply(text, keyboard);
};
const renderNoteView = async (ctx: any, userId: number, noteId: number, page: number, mode: 'reply' | 'edit' = 'edit') => {
    const note = getNoteByUserAndId(userId, noteId);
    if (!note) {
        const text = `Заметка #${noteId} не найдена.`;
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ К списку заметок', `notes:list:${page}`)],
            [Markup.button.callback('⬅️ В меню', 'notes:back:menu')]
        ]);
        if (mode === 'edit') return ctx.editMessageText(text, keyboard);
        return ctx.reply(text, keyboard);
    }

    const title = note.title?.trim() ? note.title.trim() : 'без заголовка';
    const text = `Заметка #${note.id}\nДата: ${formatNoteDate(note.created_at)}\nЗаголовок: ${title}\n\n${note.content}`;
    const keyboard = buildNoteViewKeyboard(note.id, page);
    if (mode === 'edit') return ctx.editMessageText(text, keyboard);
    return ctx.reply(text, keyboard);
};
const getNoteStatsForUser = (userId: number) => db.prepare(`
    SELECT
        ? as user_id,
        COUNT(*) as notes_count,
        COALESCE(SUM(LENGTH(COALESCE(title, '')) + LENGTH(COALESCE(content, ''))), 0) as notes_chars
    FROM notes
    WHERE user_id = ?
`).get(userId, userId) as NoteStatsRecord;
const getNoteStatsForUsers = (userIds: number[]) => {
    const unique = [...new Set(userIds.filter(id => Number.isFinite(id) && id > 0))];
    const statsMap = new Map<number, NoteStatsRecord>();
    if (!unique.length) return statsMap;

    const placeholders = unique.map(() => '?').join(',');
    const rows = db.prepare(`
        SELECT
            user_id,
            COUNT(*) as notes_count,
            COALESCE(SUM(LENGTH(COALESCE(title, '')) + LENGTH(COALESCE(content, ''))), 0) as notes_chars
        FROM notes
        WHERE user_id IN (${placeholders})
        GROUP BY user_id
    `).all(...unique) as NoteStatsRecord[];

    for (const id of unique) {
        statsMap.set(id, { user_id: id, notes_count: 0, notes_chars: 0 });
    }
    for (const row of rows) {
        statsMap.set(row.user_id, {
            user_id: row.user_id,
            notes_count: Number(row.notes_count || 0),
            notes_chars: Number(row.notes_chars || 0)
        });
    }
    return statsMap;
};

const detectImageMimeType = (url: string, fallback: string | null = null) => {
    const normalizedFallback = (fallback || '').trim().toLowerCase();
    if (normalizedFallback.startsWith('image/')) return normalizedFallback;

    const cleanUrl = url.split('?')[0].toLowerCase();
    if (cleanUrl.endsWith('.png')) return 'image/png';
    if (cleanUrl.endsWith('.webp')) return 'image/webp';
    if (cleanUrl.endsWith('.gif')) return 'image/gif';
    if (cleanUrl.endsWith('.bmp')) return 'image/bmp';
    if (cleanUrl.endsWith('.heic')) return 'image/heic';
    if (cleanUrl.endsWith('.heif')) return 'image/heif';
    return 'image/jpeg';
};

const photoAlbumBuffer = new Map<string, { images: Array<{ buffer: Buffer; mimeType: string }>; caption: string; timer: ReturnType<typeof setTimeout>; ctx: any }>();

// ── Documents (attachments) support for Telegram ──────────────────────────
// Same whitelist as desktop / backend SUPPORTED_EXTENSIONS.
const SUPPORTED_DOCUMENT_EXTENSIONS = new Set([
    'txt', 'md', 'markdown', 'json', 'csv', 'log', 'xml', 'yaml', 'yml', 'ini', 'toml',
    'py', 'js', 'ts', 'tsx', 'jsx', 'go', 'rs', 'java', 'c', 'cpp', 'cs', 'php', 'sh',
    'sql', 'html', 'css', 'docx', 'pdf', 'rtf'
]);
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024; // 5 MB — identical to backend MAX_RAW_FILE_SIZE

type PendingDocument = { filename: string; base64: string; sizeBytes: number };

// Album (media_group_id) buffer — same pattern as photoAlbumBuffer.
const documentAlbumBuffer = new Map<string, { items: PendingDocument[]; caption: string; timer: ReturnType<typeof setTimeout>; ctx: any }>();

const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

const downloadTelegramDocument = async (ctx: any, doc: any): Promise<{ buffer: Buffer; filename: string } | null> => {
    const fileId = doc?.file_id;
    const fileName = (typeof doc?.file_name === 'string' && doc.file_name.trim()) ? doc.file_name.trim() : 'document';
    if (!fileId) return null;
    try {
        const fileLink = await ctx.telegram.getFileLink(fileId);
        const response = await fetch(fileLink.href);
        if (!response.ok) return null;
        const buffer = await response.arrayBuffer();
        if (!buffer.byteLength) return null;
        return { buffer: Buffer.from(buffer), filename: fileName };
    } catch {
        return null;
    }
};

const processDocumentAlbum = async (albumKey: string) => {
    const album = documentAlbumBuffer.get(albumKey);
    if (!album) return;
    documentAlbumBuffer.delete(albumKey);

    const { items, caption, ctx } = album;
    if (!items.length) return;

    processUserTextThroughAi(ctx, caption, { documents: items }).catch((err) => {
        console.error('Ошибка в processUserTextThroughAi (document album):', err);
    });
};

const processUserDocumentThroughAi = async (ctx: any) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const doc = ctx.message?.document;
    if (!doc) return;

    const caption = typeof ctx.message?.caption === 'string' ? ctx.message.caption.trim() : '';
    const mediaGroupId = ctx.message?.media_group_id;

    // Validate extension locally (mirrors backend SUPPORTED_EXTENSIONS).
    const filename = (typeof doc.file_name === 'string' && doc.file_name.trim()) ? doc.file_name.trim() : 'document';
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    if (!SUPPORTED_DOCUMENT_EXTENSIONS.has(ext)) {
        await ctx.reply(
            `⚠️ Формат «.${ext || '?'}» не поддерживается.\n` +
            `Разрешены: txt, md, json, csv, log, xml, yaml, ini, toml, код (py, js, ts, ...), docx, pdf, rtf.`
        );
        return;
    }

    // Check file size from Telegram metadata (avoid downloading huge files).
    if (typeof doc.file_size === 'number' && doc.file_size > MAX_DOCUMENT_BYTES) {
        await ctx.reply(`⚠️ Файл слишком большой (${formatBytes(doc.file_size)}). Максимум — 5 МБ.`);
        return;
    }

    const downloaded = await downloadTelegramDocument(ctx, doc);
    if (!downloaded) {
        await ctx.reply('⚠️ Не удалось скачать файл. Попробуй ещё раз.');
        return;
    }
    if (downloaded.buffer.length > MAX_DOCUMENT_BYTES) {
        await ctx.reply(`⚠️ Файл слишком большой (${formatBytes(downloaded.buffer.length)}). Максимум — 5 МБ.`);
        return;
    }

    const item: PendingDocument = {
        filename: downloaded.filename,
        base64: downloaded.buffer.toString('base64'),
        sizeBytes: downloaded.buffer.length,
    };

    // Album (media_group_id) — collect all files of the group, then send as one AI request.
    if (mediaGroupId) {
        const albumKey = `${userId}:${mediaGroupId}`;
        const existing = documentAlbumBuffer.get(albumKey);
        if (existing) {
            existing.items.push(item);
            if (caption) existing.caption = caption;
        } else {
            documentAlbumBuffer.set(albumKey, {
                items: [item],
                caption,
                timer: setTimeout(() => processDocumentAlbum(albumKey), 1500),
                ctx
            });
        }
        return;
    }

    // Single document → straight to AI (caption becomes the text, or placeholder if empty).
    processUserTextThroughAi(ctx, caption, { documents: [item] }).catch((err) => {
        console.error('Ошибка в processUserTextThroughAi (document):', err);
    });
};

const downloadTelegramPhoto = async (ctx: any, photos: any[]): Promise<{ buffer: Buffer; mimeType: string } | null> => {
    const biggestPhoto = photos[photos.length - 1];
    const fileLink = await ctx.telegram.getFileLink(biggestPhoto.file_id);
    const imageResponse = await fetch(fileLink.href);
    if (!imageResponse.ok) return null;
    const imageBuffer = await imageResponse.arrayBuffer();
    if (!imageBuffer.byteLength || imageBuffer.byteLength > MAX_TELEGRAM_PHOTO_BYTES) return null;
    const mimeType = detectImageMimeType(fileLink.href, imageResponse.headers.get('content-type'));
    return { buffer: Buffer.from(imageBuffer), mimeType };
};

const processPhotoAlbum = async (albumKey: string) => {
    const album = photoAlbumBuffer.get(albumKey);
    if (!album) return;
    photoAlbumBuffer.delete(albumKey);

    const { images, caption, ctx } = album;
    const userId = ctx.from?.id;
    if (!userId || !images.length) return;

    const userRecord = await getUser(userId);
    if (!userRecord) {
        await ctx.reply('Не нашёл тебя в базе. Попроси админа выдать доступ.');
        return;
    }

    // Daily message limit removed — switched to token-based context limits.

    try {
        await ctx.sendChatAction('typing');

        const mainImage = images[0];
        const extraImages = images.slice(1).map(img => ({
            base64: img.buffer.toString('base64'),
            mimeType: img.mimeType
        }));

        const backend = await runBackendPhotoAnalyze(
            userId,
            mainImage.buffer,
            mainImage.mimeType,
            caption,
            {
                chatId: undefined,
                userTelegramChatId: Number.isFinite(Number(ctx.chat?.id)) ? Math.floor(Number(ctx.chat?.id)) : null,
                userTelegramMessageId: Number.isFinite(Number(ctx.message?.message_id)) ? Math.floor(Number(ctx.message?.message_id)) : null,
                extraImages: extraImages.length ? extraImages : undefined
            }
        );

        if (typeof backend?.model_fallback_notice === 'string' && backend.model_fallback_notice.trim()) {
            await ctx.reply(backend.model_fallback_notice.trim());
        }

        const answer = typeof backend?.reply_text === 'string' && backend.reply_text.trim()
            ? backend.reply_text.trim()
            : FALLBACK_ANSWER;
        const sentMessage = await safeReply(ctx, answer);

        const backendAssistantMessageId = Number.isFinite(Number(backend?.message_id))
            ? Math.floor(Number(backend?.message_id))
            : null;
        const assistantTgMessageId = Number.isFinite(Number(sentMessage?.message_id))
            ? Math.floor(Number(sentMessage?.message_id))
            : null;
        if (backendAssistantMessageId) {
            try {
                await runBackendBindTelegramMessage(
                    userId,
                    backendAssistantMessageId,
                    Number.isFinite(Number(ctx.chat?.id)) ? Math.floor(Number(ctx.chat?.id)) : null,
                    assistantTgMessageId
                );
            } catch (bindErr) {
                console.warn('Не удалось привязать telegram_message_id к backend photo сообщению:', bindErr);
            }
        }
    } catch (err) {
        console.error('Ошибка анализа изображения:', err);
        await ctx.reply('Не смог обработать изображение. Проверь формат файла и попробуй ещё раз.');
    }
};

const processUserPhotoThroughAi = async (ctx: any) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const photos = ctx.message?.photo;
    if (!Array.isArray(photos) || !photos.length) return;

    const caption = typeof ctx.message?.caption === 'string' ? ctx.message.caption.trim() : '';
    const mediaGroupId = ctx.message?.media_group_id;

    try {
        const downloaded = await downloadTelegramPhoto(ctx, photos);
        if (!downloaded) {
            await ctx.reply('Не удалось скачать фото. Попробуй ещё раз.');
            return;
        }

        // Альбом — собираем все фото, обрабатываем через задержку
        if (mediaGroupId) {
            const albumKey = `${userId}:${mediaGroupId}`;
            const existing = photoAlbumBuffer.get(albumKey);
            if (existing) {
                existing.images.push(downloaded);
                if (caption) existing.caption = caption;
            } else {
                photoAlbumBuffer.set(albumKey, {
                    images: [downloaded],
                    caption,
                    timer: setTimeout(() => processPhotoAlbum(albumKey), 1500),
                    ctx
                });
            }
            return;
        }

        // Одиночное фото — обрабатываем сразу
        const userRecord = await getUser(userId);
        if (!userRecord) {
            await ctx.reply('Не нашёл тебя в базе. Попроси админа выдать доступ.');
            return;
        }

        if (ctx.state.role !== 'admin') {
            const dailyLimit = normalizeDailyMessageLimit(userRecord.daily_message_limit);
            const dailyCount = Math.max(0, Math.floor(userRecord.daily_message_count || 0));
            if (dailyLimit > 0 && dailyCount >= dailyLimit) {
                await ctx.reply(`Лимит сообщений на сегодня исчерпан (${dailyCount}/${dailyLimit}). Попробуй снова после ежедневного сброса.`);
                return;
            }
        }

        await ctx.sendChatAction('typing');

        const backend = await runBackendPhotoAnalyze(
            userId,
            downloaded.buffer,
            downloaded.mimeType,
            caption,
            {
                chatId: undefined,
                userTelegramChatId: Number.isFinite(Number(ctx.chat?.id)) ? Math.floor(Number(ctx.chat?.id)) : null,
                userTelegramMessageId: Number.isFinite(Number(ctx.message?.message_id)) ? Math.floor(Number(ctx.message?.message_id)) : null
            }
        );

        if (typeof backend?.model_fallback_notice === 'string' && backend.model_fallback_notice.trim()) {
            await ctx.reply(backend.model_fallback_notice.trim());
        }

        const answer = typeof backend?.reply_text === 'string' && backend.reply_text.trim()
            ? backend.reply_text.trim()
            : FALLBACK_ANSWER;
        const sentMessage = await safeReply(ctx, answer);

        const backendAssistantMessageId = Number.isFinite(Number(backend?.message_id))
            ? Math.floor(Number(backend?.message_id))
            : null;
        const assistantTgMessageId = Number.isFinite(Number(sentMessage?.message_id))
            ? Math.floor(Number(sentMessage?.message_id))
            : null;
        if (backendAssistantMessageId) {
            try {
                await runBackendBindTelegramMessage(
                    userId,
                    backendAssistantMessageId,
                    Number.isFinite(Number(ctx.chat?.id)) ? Math.floor(Number(ctx.chat?.id)) : null,
                    assistantTgMessageId
                );
            } catch (bindErr) {
                console.warn('Не удалось привязать telegram_message_id к backend photo сообщению:', bindErr);
            }
        }
    } catch (err) {
        console.error('Ошибка анализа изображения:', err);
        await ctx.reply('Не смог обработать изображение. Проверь формат файла и попробуй ещё раз.');
    }
};

const getUser = async (id: number): Promise<UserRecord | undefined> => {
    const data = await runBackendGetUser(id);
    return data.user;
};
const addUser = async (id: number, name: string, role: string, status: UserStatus = 'approved', tgUsername: string | null = null) => {
    const defaultPromptId = db.prepare('SELECT id FROM prompts WHERE is_default = 1 LIMIT 1').get() as { id: number } | undefined;
    await runBackendUpsertTelegramUser(id, name, role, status, tgUsername, defaultPromptId?.id ?? defaultPromptSeed.id);
};
const createPendingUser = async (id: number, name: string | null, tgUsername: string | null) => {
    const defaultPromptId = db.prepare('SELECT id FROM prompts WHERE is_default = 1 LIMIT 1').get() as { id: number } | undefined;
    const data = await runBackendCreatePendingUser(id, name, tgUsername, defaultPromptId?.id ?? defaultPromptSeed.id);
    return data.user;
};
const updateUserName = async (id: number, name: string) => {
    await runBackendUpdateUserName(id, name);
};
const updateUserTelegramUsername = async (id: number, tgUsername: string | null) => {
    await runBackendUpdateTgUsername(id, tgUsername);
};
const updateUserRole = async (id: number, role: string) => {
    await runBackendUpdateUserRole(id, role);
};
const updateUserStatus = async (id: number, status: UserStatus) => {
    await runBackendUpdateUserStatus(id, status);
};
const updateUserPlan = async (id: number, plan: UserPlan) => {
    await runBackendUpdateUserPlan(id, plan);
};
const syncAllUsersPlanLimits = async () => {
    await runBackendSyncPlanLimits();
};
const updateUserContextWindow = (id: number, contextWindow: number) => db.prepare(`
    UPDATE users
    SET context_window = ?
    WHERE id = ?
`).run(contextWindow, id);
const updateUserDailyMessageLimit = (id: number, dailyMessageLimit: number) => db.prepare(`
    UPDATE users
    SET daily_message_limit = ?
    WHERE id = ?
`).run(Math.max(0, Math.floor(dailyMessageLimit)), id);
const updateUserContextWindowMax = (id: number, contextWindowMax: number) => db.prepare(`
    UPDATE users
    SET context_window_max = ?,
        context_window = CASE
            WHEN COALESCE(context_window, 0) <= 0 THEN ?
            WHEN context_window > ? THEN ?
            ELSE context_window
        END
    WHERE id = ?
`).run(contextWindowMax, contextWindowMax, contextWindowMax, contextWindowMax, id);
const closeCurrentPlanSubscriptions = (userId: number) => db.prepare(`
    UPDATE user_plan_subscriptions
    SET is_current = 0
    WHERE user_id = ? AND is_current = 1
`).run(userId);
const addPlanSubscription = (userId: number, plan: UserPlan, endsAt: string | null, assignedBy: number | null) => db.prepare(`
    INSERT INTO user_plan_subscriptions (user_id, plan, started_at, ends_at, is_current, assigned_by)
    VALUES (?, ?, CURRENT_TIMESTAMP, ?, 1, ?)
`).run(userId, plan, endsAt, assignedBy);
const getCurrentPlanSubscription = (userId: number) => db.prepare(`
    SELECT id, user_id, plan, started_at, ends_at, is_current
    FROM user_plan_subscriptions
    WHERE user_id = ? AND is_current = 1
    ORDER BY id DESC
    LIMIT 1
`).get(userId) as {
    id: number;
    user_id: number;
    plan: UserPlan;
    started_at: string;
    ends_at: string | null;
    is_current: number;
} | undefined;
const getExpiredCurrentSubscriptions = () => db.prepare(`
    SELECT id, user_id, plan, started_at, ends_at
    FROM user_plan_subscriptions
    WHERE is_current = 1 AND ends_at IS NOT NULL AND datetime(ends_at) <= CURRENT_TIMESTAMP
    ORDER BY user_id ASC, id ASC
`).all() as Array<{
    id: number;
    user_id: number;
    plan: UserPlan;
    started_at: string;
    ends_at: string | null;
}>;
const parsePlanFromDb = (raw: string | null | undefined): UserPlan => {
    if (raw === 'free' || raw === 'standart' || raw === 'pro') return raw;
    return DEFAULT_USER_PLAN;
};
const getPlanMaxContextTokens = (plan: UserPlan) => PLAN_MAX_CONTEXT_TOKENS[plan] || PLAN_MAX_CONTEXT_TOKENS[DEFAULT_USER_PLAN];
const getPlanDailyWebSearchLimit = (plan: UserPlan) => PLAN_DAILY_WEB_SEARCH_LIMITS[plan] ?? PLAN_DAILY_WEB_SEARCH_LIMITS[DEFAULT_USER_PLAN];
const normalizeDailyMessageLimit = (value: number | null | undefined) => {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.floor(value as number));
};
const normalizeDailyWebSearchLimit = (value: number | null | undefined) => {
    if (!Number.isFinite(value)) return getPlanDailyWebSearchLimit(DEFAULT_USER_PLAN);
    return Math.max(0, Math.floor(value as number));
};
const applyUserPlan = async (userId: number, plan: UserPlan, endsAt: string | null, assignedBy: number | null) => {
    closeCurrentPlanSubscriptions(userId);
    await updateUserPlan(userId, plan);
    addPlanSubscription(userId, plan, endsAt, assignedBy);
};
const ensureUserCurrentPlanSubscription = async (userId: number) => {
    const current = getCurrentPlanSubscription(userId);
    if (current) return;
    const user = await getUser(userId);
    if (!user) return;
    const normalizedPlan = parsePlanFromDb(user.plan);
    await updateUserPlan(userId, normalizedPlan);
    addPlanSubscription(userId, normalizedPlan, null, null);
};
const ensureCurrentPlanSubscriptionsForAllUsers = async () => {
    const users = getAllUsers();
    for (const user of users) {
        await ensureUserCurrentPlanSubscription(user.id);
    }
};
const getEndsAtForDuration = (duration: PlanDurationCode) => {
    if (duration === 'forever') return null;
    const dt = new Date();
    if (duration === 'day') dt.setDate(dt.getDate() + 1);
    if (duration === 'week') dt.setDate(dt.getDate() + 7);
    if (duration === 'month') dt.setMonth(dt.getMonth() + 1);
    if (duration === 'year') dt.setFullYear(dt.getFullYear() + 1);
    return dt.toISOString().slice(0, 19).replace('T', ' ');
};
const expireFinishedPlanSubscriptions = async () => {
    const expiredRows = getExpiredCurrentSubscriptions();
    const processedUsers = new Set<number>();
    for (const row of expiredRows) {
        if (processedUsers.has(row.user_id)) continue;
        processedUsers.add(row.user_id);
        await applyUserPlan(row.user_id, DEFAULT_USER_PLAN, null, null);
    }
};
const updateUserTimezone = (id: number, timezoneOffset: number) => db.prepare(`
    UPDATE users
    SET timezone_offset = ?, timezone_confirmed = 1
    WHERE id = ?
`).run(timezoneOffset, id);
const updateUserMailSettings = (id: number, provider: string, email: string, encryptedPassword: string, host: string, port = 993, secure = 1) => db.prepare(`
    UPDATE users
    SET imap_provider = ?, imap_user = ?, imap_pass = ?, imap_host = ?, imap_port = ?, imap_secure = ?
    WHERE id = ?
`).run(provider, email, encryptedPassword, host, port, secure, id);
const upsertMailAccount = (userId: number, provider: MailProvider, email: string, encryptedPassword: string, host: string, port = 993, secure = 1) => db.prepare(`
    INSERT INTO mail_accounts (user_id, provider, imap_user, imap_pass, imap_host, imap_port, imap_secure, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, provider) DO UPDATE SET
        imap_user = excluded.imap_user,
        imap_pass = excluded.imap_pass,
        imap_host = excluded.imap_host,
        imap_port = excluded.imap_port,
        imap_secure = excluded.imap_secure,
        updated_at = CURRENT_TIMESTAMP
`).run(userId, provider, email, encryptedPassword, host, port, secure);
const setActiveMailProvider = (userId: number, provider: MailProvider) => db.prepare(`
    UPDATE users SET imap_provider = ? WHERE id = ?
`).run(provider, userId);
const updateUserMailCheckLimit = (userId: number, limit: number) => db.prepare(`
    UPDATE users SET mail_check_limit = ? WHERE id = ?
`).run(limit, userId);
const getMailAccountsForUser = (userId: number) => db.prepare(`
    SELECT user_id, provider, imap_user, imap_pass, imap_host, imap_port, imap_secure
    FROM mail_accounts
    WHERE user_id = ?
    ORDER BY provider ASC
`).all(userId) as MailAccountRecord[];
const getMailAccountForUser = (userId: number, provider: MailProvider) => db.prepare(`
    SELECT user_id, provider, imap_user, imap_pass, imap_host, imap_port, imap_secure
    FROM mail_accounts
    WHERE user_id = ? AND provider = ?
`).get(userId, provider) as MailAccountRecord | undefined;
const deleteMailAccount = (userId: number, provider: MailProvider) => db
    .prepare(`DELETE FROM mail_accounts WHERE user_id = ? AND provider = ?`)
    .run(userId, provider);
const clearUserMailSettings = (id: number) => db.prepare(`
    UPDATE users
    SET imap_provider = NULL, imap_user = NULL, imap_pass = NULL, imap_host = NULL, imap_port = 993, imap_secure = 1
    WHERE id = ?
`).run(id);
const formatTokenCountShort = (tokens: number) => {
    const safe = Math.max(0, Math.floor(tokens || 0));
    if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(2)}M`;
    if (safe >= 1_000) return `${(safe / 1_000).toFixed(1)}k`;
    return `${safe}`;
};
const formatRub = (value: number) => `${(Math.max(0, value || 0)).toFixed(2)}₽`;
const updateUserPrompt = async (id: number, promptId: number) => {
    await runBackendSelectUserPrompt(id, promptId);
};
const selectUserCustomPrompt = async (id: number) => {
    await runBackendSelectUserPrompt(id, CUSTOM_PROMPT_ID);
};
const updateUserCustomPrompt = async (id: number, content: string) => {
    await runBackendUpdateCustomPrompt(id, content);
};
const resetUsersPromptIfDeleted = async (promptId: number) => {
    await runBackendResetUsersPromptIfDeleted(promptId);
};
const removeUser = async (id: number) => {
    await runBackendRemoveUser(id);
};
const removeUserPlanSubscriptions = (id: number) => db.prepare('DELETE FROM user_plan_subscriptions WHERE user_id = ?').run(id);
const getAllUsers = () => db.prepare('SELECT * FROM users ORDER BY id').all() as UserRecord[];
const getUsersCount = () => (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
const getUsersPage = (limit: number, offset: number) => db.prepare(`
    SELECT id, name, role, status, plan, tg_username, selected_prompt_id, custom_prompt_content, core_memory, imap_provider, imap_user, imap_pass, imap_host, imap_port, imap_secure, mail_check_limit, timezone_offset, timezone_confirmed, daily_message_count, daily_message_limit, total_message_length, daily_tokens_used, total_tokens_used, daily_cost_rub, total_cost_rub, daily_web_search_count, daily_web_search_limit, total_web_search_count, daily_image_gen_count, daily_image_gen_limit, total_image_gen_count, context_window, context_window_max, max_context_tokens_limit, max_context_tokens
    FROM users
    ORDER BY id ASC
    LIMIT ? OFFSET ?
`).all(limit, offset) as UserRecord[];
const getPendingUsersCount = () => (db.prepare(`SELECT COUNT(*) as count FROM users WHERE status = 'none'`).get() as { count: number }).count;
const getPendingUsersPage = (limit: number, offset: number) => db.prepare(`
    SELECT id, name, role, status, plan, tg_username, selected_prompt_id, custom_prompt_content, core_memory, imap_provider, imap_user, imap_pass, imap_host, imap_port, imap_secure, mail_check_limit, daily_message_limit, daily_web_search_limit, daily_image_gen_limit, context_window, context_window_max, max_context_tokens_limit, max_context_tokens, created_at
    FROM users
    WHERE status = 'none'
    ORDER BY id ASC
    LIMIT ? OFFSET ?
`).all(limit, offset) as PendingUserRow[];
const getBannedUsersCount = () => (db.prepare(`SELECT COUNT(*) as count FROM users WHERE status = 'banned'`).get() as { count: number }).count;
const getBannedUsersPage = (limit: number, offset: number) => db.prepare(`
    SELECT u.id, u.name, u.role, u.status, u.plan, u.tg_username, u.selected_prompt_id, u.custom_prompt_content, u.core_memory, u.imap_provider, u.imap_user, u.imap_pass, u.imap_host, u.imap_port, u.imap_secure, u.mail_check_limit, u.daily_message_limit, u.daily_web_search_limit, u.daily_image_gen_limit, u.context_window, u.context_window_max, u.max_context_tokens_limit, u.max_context_tokens, b.reason, b.banned_at
    FROM users u
    LEFT JOIN bans b ON b.user_id = u.id
    WHERE u.status = 'banned'
    ORDER BY b.banned_at DESC, u.id ASC
    LIMIT ? OFFSET ?
`).all(limit, offset) as BannedUserRow[];
const getBanRecord = (id: number) => db.prepare(`
    SELECT user_id, reason, banned_at, banned_by
    FROM bans
    WHERE user_id = ?
`).get(id) as { user_id: number; reason: string; banned_at: string; banned_by: number | null } | undefined;
const setBan = (id: number, reason: string, bannedBy: number) => db.prepare(`
    INSERT INTO bans (user_id, reason, banned_by, banned_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
        reason = excluded.reason,
        banned_by = excluded.banned_by,
        banned_at = CURRENT_TIMESTAMP
`).run(id, reason, bannedBy);
const removeBan = (id: number) => db.prepare('DELETE FROM bans WHERE user_id = ?').run(id);
const addTask = (
    userId: number,
    executeAt: number,
    taskType: TaskType,
    payload: string,
    recurrenceType: TaskRecurrenceType,
    recurrenceWeekday: number | null,
    timezoneOffset: number | null,
    notifyMode: TaskNotifyMode,
    notifyCondition: string | null
) => db
    .prepare(`
        INSERT INTO tasks (user_id, execute_at, task_type, payload, recurrence_type, recurrence_weekday, timezone_offset, notify_mode, notify_condition)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(userId, executeAt, taskType, payload, recurrenceType, recurrenceWeekday, timezoneOffset, notifyMode, notifyCondition);
const getPendingTaskCount = (userId: number) => (
    db.prepare(`SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND status = 'pending'`).get(userId) as { count: number }
).count;
const getTaskByUserAndId = (userId: number, taskId: number) => db.prepare(`
    SELECT id, user_id, execute_at, task_type, payload, status, recurrence_type, recurrence_weekday, timezone_offset, notify_mode, notify_condition
    FROM tasks
    WHERE user_id = ? AND id = ?
`).get(userId, taskId) as TaskRecord | undefined;
const deletePendingTaskByUserAndId = (userId: number, taskId: number) => db
    .prepare(`DELETE FROM tasks WHERE user_id = ? AND id = ? AND status = 'pending'`)
    .run(userId, taskId);
const getUserTasks = (userId: number, status: TaskStatus | 'all' = 'pending', limit = 20) => {
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
    if (status === 'all') {
        return db.prepare(`
            SELECT id, user_id, execute_at, task_type, payload, status, recurrence_type, recurrence_weekday, timezone_offset, notify_mode, notify_condition
            FROM tasks
            WHERE user_id = ?
            ORDER BY execute_at ASC, id ASC
            LIMIT ?
        `).all(userId, safeLimit) as TaskRecord[];
    }

    return db.prepare(`
        SELECT id, user_id, execute_at, task_type, payload, status, recurrence_type, recurrence_weekday, timezone_offset, notify_mode, notify_condition
        FROM tasks
        WHERE user_id = ? AND status = ?
        ORDER BY execute_at ASC, id ASC
        LIMIT ?
    `).all(userId, status, safeLimit) as TaskRecord[];
};
const isTimezoneConfigured = (user: UserRecord) => user.timezone_confirmed === 1;
const resolveEffectiveContextWindow = (user: UserRecord | undefined) => {
    // Legacy — still used for message-count fallback, но context control теперь через токены.
    if (!user) return MAX_HISTORY_ITEMS;
    return MAX_HISTORY_ITEMS;
};
const resolveMaxContextTokens = (user: UserRecord | undefined): number => {
    if (!user) return PLAN_MAX_CONTEXT_TOKENS[DEFAULT_USER_PLAN];
    const planLimit = getPlanMaxContextTokens(parsePlanFromDb(user.plan));
    const mctl = user.max_context_tokens_limit ?? 0;
    const mct = user.max_context_tokens ?? 0;
    const hardLimit = Number.isFinite(mctl) && mctl > 0 ? Math.floor(mctl) : planLimit;
    const userChoice = Number.isFinite(mct) && mct > 0 ? Math.floor(mct) : hardLimit;
    return Math.max(1000, Math.min(userChoice, hardLimit));
};
const createUserChat = (userId: number, title: string) => {
    const normalized = title.trim() || 'Новый чат';
    return db.prepare(`
        INSERT INTO user_chats (user_id, title)
        VALUES (?, ?)
    `).run(userId, normalized);
};
const getUserChatById = (userId: number, chatId: number) => db.prepare(`
    SELECT id, user_id, title, created_at, updated_at
    FROM user_chats
    WHERE user_id = ? AND id = ?
`).get(userId, chatId) as UserChatRecord | undefined;
const getUserChats = (userId: number, limit = 100) => {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    return db.prepare(`
        SELECT id, user_id, title, created_at, updated_at
        FROM user_chats
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT ?
    `).all(userId, safeLimit) as UserChatRecord[];
};
const setUserActiveChat = (userId: number, chatId: number) => db.prepare(`
    UPDATE users
    SET active_chat_id = ?
    WHERE id = ?
`).run(chatId, userId);
const ensureActiveChatForUser = (userId: number) => {
    const current = db.prepare(`
        SELECT active_chat_id
        FROM users
        WHERE id = ?
    `).get(userId) as { active_chat_id: number | null } | undefined;

    if (current?.active_chat_id) {
        const exists = getUserChatById(userId, current.active_chat_id);
        if (exists) return exists.id;
    }

    const firstChat = db.prepare(`
        SELECT id
        FROM user_chats
        WHERE user_id = ?
        ORDER BY id ASC
        LIMIT 1
    `).get(userId) as { id: number } | undefined;

    const chatId = firstChat?.id ?? Number(createUserChat(userId, 'Основной').lastInsertRowid);
    setUserActiveChat(userId, chatId);
    return chatId;
};
const getActiveChatForUser = (userId: number) => {
    const activeChatId = ensureActiveChatForUser(userId);
    return getUserChatById(userId, activeChatId);
};
const getRecentHistoryRowsByUser = (userId: number, limit = 20) => {
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
    return db.prepare(`
        SELECT id, chat_id, role, content, telegram_message_id, created_at
        FROM chat_messages
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT ?
    `).all(userId, safeLimit) as UserHistoryRow[];
};
const shortenHistoryContent = (text: string, maxLen = 10) => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= maxLen) return clean;
    return clean.slice(0, maxLen);
};
const formatRecentHistoryRows = (userId: number, rows: UserHistoryRow[]) => {
    if (!rows.length) {
        return `История пользователя #${userId} пуста.`;
    }
    const lines = rows.map(row => {
        const chatPart = row.chat_id ? ` chat:${row.chat_id}` : '';
        const tgMsg = row.telegram_message_id ? ` tg:${row.telegram_message_id}` : '';
        const preview = shortenHistoryContent(row.content);
        return `#${row.id}${chatPart} [${row.role}]${tgMsg} ${row.created_at}\n${preview}`;
    });
    return `Последние сообщения пользователя #${userId} (новые -> старые):\n\n${lines.join('\n\n')}`;
};
const deleteHistoryByUserAndRole = (userId: number, role: ChatRole | 'all') => {
    if (role === 'all') {
        return db.prepare('DELETE FROM chat_messages WHERE user_id = ?').run(userId);
    }
    return db.prepare('DELETE FROM chat_messages WHERE user_id = ? AND role = ?').run(userId, role);
};
const deleteHistoryMessageByUserAndMessageId = (userId: number, messageId: number) => db.prepare(`
    DELETE FROM chat_messages
    WHERE user_id = ? AND id = ?
`).run(userId, messageId);
const deleteHistoryMessageByUserAndTelegramMessageId = (userId: number, telegramMessageId: number) => db.prepare(`
    DELETE FROM chat_messages
    WHERE user_id = ? AND telegram_message_id = ?
`).run(userId, telegramMessageId);
const trimUserHistory = async (userId: number) => {
    // Epoch Trimming — архивация по токенам.
    // Контроль контекста делегирован на backend-api (trimUserHistoryByChat),
    // но TG-бот тоже может архивировать при смене тарифа/лимита.
    const chatId = ensureActiveChatForUser(userId);
    const maxContextTokens = resolveMaxContextTokens(await getUser(userId));

    const rows = db.prepare(`
        SELECT id, token_count
        FROM chat_messages
        WHERE user_id = ? AND chat_id = ? AND archived = 0
        ORDER BY id ASC
    `).all(userId, chatId) as Array<{ id: number; token_count: number }>;

    if (rows.length === 0) return;

    const totalMessageTokens = rows.reduce((sum, r) => sum + (r.token_count || 0), 0);
    if (totalMessageTokens <= maxContextTokens) return;

    const targetTokens = Math.floor(maxContextTokens * 0.5);
    const tokensToArchive = totalMessageTokens - targetTokens;

    const idsToArchive: number[] = [];
    let accumulated = 0;
    for (const row of rows) {
        if (accumulated >= tokensToArchive) break;
        idsToArchive.push(row.id);
        accumulated += row.token_count || 0;
    }

    if (idsToArchive.length >= rows.length) idsToArchive.pop();
    if (idsToArchive.length === 0) return;

    const placeholders = idsToArchive.map(() => '?').join(',');
    db.prepare(`
        UPDATE chat_messages
        SET archived = 1, archived_at = CURRENT_TIMESTAMP
        WHERE id IN (${placeholders})
    `).run(...idsToArchive);
};
const clearActiveUserHistory = (userId: number) => db.prepare(`
    DELETE FROM chat_messages
    WHERE user_id = ? AND chat_id = ?
`).run(userId, ensureActiveChatForUser(userId));
const clearUserHistory = (userId: number) => db.prepare('DELETE FROM chat_messages WHERE user_id = ?').run(userId);

ensureCurrentPlanSubscriptionsForAllUsers().catch((err) => {
    console.error('Ошибка первичной инициализации подписок:', err);
});

const resolvePromptForUser = (user: { selected_prompt_id: number | null; custom_prompt_content?: string | null }) => {
    if (user.selected_prompt_id === CUSTOM_PROMPT_ID) {
        const custom = (user.custom_prompt_content || '').trim();
        if (custom) {
            return {
                id: CUSTOM_PROMPT_ID,
                name: 'Кастомный',
                description: 'Пользовательский промпт',
                content: custom,
                is_default: 0
            } satisfies PromptRecord;
        }
    }

    if (user.selected_prompt_id) {
        const selected = getPromptById(user.selected_prompt_id);
        if (selected) return selected;
    }

    const fallback = ensureDefaultPrompt();
    return fallback!;
};

const linkCodeFlows = new Map<number, 'await_code'>();

// Middleware для авторизации
bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const telegramUsername = ctx.from?.username?.trim() || null;
    let userRecord = await getUser(userId);
    const isAdminByEnv = ADMIN_IDS.has(userId);
    const isAdminByDb = userRecord?.role === 'admin';

    if (isAdminByEnv || isAdminByDb) {
        const fallbackName = userRecord?.name || ctx.from?.first_name || 'Admin';
        const defaultPrompt = ensureDefaultPrompt();
        if (!userRecord) {
            await addUser(userId, fallbackName, 'admin', 'approved', telegramUsername);
            userRecord = await getUser(userId);
        } else {
            if (userRecord.role !== 'admin' || userRecord.status !== 'approved') {
                await addUser(userId, userRecord.name || fallbackName, 'admin', 'approved', telegramUsername);
                userRecord = await getUser(userId);
            } else if (userRecord.tg_username !== telegramUsername) {
                await updateUserTelegramUsername(userId, telegramUsername);
                userRecord = (await getUser(userId)) || userRecord;
            }
        }

        if (userRecord && !userRecord.selected_prompt_id) {
            if (defaultPrompt) await updateUserPrompt(userId, defaultPrompt.id);
        }
        if (userRecord) {
            const normalizedPlan = parsePlanFromDb(userRecord.plan);
            if (userRecord.plan !== normalizedPlan) {
                await updateUserPlan(userId, normalizedPlan);
                userRecord = (await getUser(userId)) || userRecord;
            }
            await ensureUserCurrentPlanSubscription(userId);
        }

        await syncCommandScopeForUser(userId, true);
        ctx.state.role = 'admin';
        ctx.state.userName = fallbackName;
        return next();
    }

    if (!userRecord) {
        const initialName = telegramUsername ? (ctx.from?.first_name || null) : null;
        const pendingUser = await createPendingUser(userId, initialName, telegramUsername);
        await syncCommandScopeForUser(userId, false);

        if (pendingUser) {
            await notifyAdminsNewRequest(pendingUser);
        } else {
            const freshUser = await getUser(userId);
            if (freshUser) await notifyAdminsNewRequest(freshUser);
        }

        if (!telegramUsername) {
            return ctx.reply('Отправили вашу заявку админу, ждём подтверждения.\nУ тебя нет @username, отправь сюда имя одним сообщением.');
        }

        return ctx.reply('Отправили вашу заявку админу, ждём подтверждения.');
    }

    if (userRecord.tg_username !== telegramUsername) {
        await updateUserTelegramUsername(userId, telegramUsername);
        userRecord = (await getUser(userId)) || userRecord;
    }

    if (userRecord.status === 'banned') {
        const ban = getBanRecord(userId);
        const reason = ban?.reason ?? 'Без причины';
        const date = ban?.banned_at ?? 'неизвестно';
        await syncCommandScopeForUser(userId, false);
        return ctx.reply(`🚫 Доступ заблокирован.\nПричина: ${reason}\nДата: ${date}`);
    }

    if (userRecord.status === 'none') {
        const text = ctx.message && 'text' in ctx.message ? ctx.message.text.trim() : '';
        if (text === '/link' || text === '/cancellink' || linkCodeFlows.has(userId)) {
            return next();
        }
        const savedName = await maybeCapturePendingName(ctx, userRecord, text);
        await syncCommandScopeForUser(userId, false);

        if (savedName) {
            return ctx.reply('Имя сохранено. Заявка отправлена админу, ожидаем подтверждения.');
        }

        if (!telegramUsername && !(userRecord.name && userRecord.name.trim())) {
            return ctx.reply('Заявка уже отправлена. У тебя нет @username, отправь своё имя одним сообщением.');
        }

        return ctx.reply('Заявка уже отправлена администратору. Ожидаем подтверждения.');
    }

    if (userRecord.status === 'disapproved') {
        await syncCommandScopeForUser(userId, false);
        return ctx.reply('Заявка была отклонена администратором. Если это ошибка, свяжись с админом.');
    }

    if (userRecord.role !== 'user') {
        await updateUserRole(userId, 'user');
        userRecord = (await getUser(userId)) || userRecord;
    }
    if (!userRecord.selected_prompt_id) {
        const defaultPrompt = ensureDefaultPrompt();
        if (defaultPrompt) await updateUserPrompt(userId, defaultPrompt.id);
    }
    {
        const normalizedPlan = parsePlanFromDb(userRecord.plan);
        if (userRecord.plan !== normalizedPlan) {
            await updateUserPlan(userId, normalizedPlan);
            userRecord = (await getUser(userId)) || userRecord;
        }
        await ensureUserCurrentPlanSubscription(userId);
    }

    await syncCommandScopeForUser(userId, false);
    ctx.state.role = 'user';
    ctx.state.userName = userRecord.name || ctx.from?.first_name || 'Пользователь';
    return next();
});

bot.telegram.setMyCommands(BASE_COMMANDS as any);

const showMenu = async (ctx: any) => {
    const isAdmin = ctx.state.role === 'admin';
    const userId = ctx.from?.id;
    const userRecord = userId ? await getUser(userId) : undefined;
    const activePrompt = userRecord ? resolvePromptForUser(userRecord) : ensureDefaultPrompt();
    const userName = (ctx.state.userName as string | undefined) || userRecord?.name || 'Пользователь';
    const roleLabel = isAdmin ? 'Админ' : 'Пользователь';
    const promptLine = activePrompt
        ? activePrompt.id === CUSTOM_PROMPT_ID
            ? '🧠 Текущий промпт: Кастомный'
            : `🧠 Текущий промпт: #${activePrompt.id} ${activePrompt.name}`
        : '🧠 Текущий промпт: не найден';
    const userPlan = userRecord ? parsePlanFromDb(userRecord.plan) : DEFAULT_USER_PLAN;
    const planLine = `💳 План: ${getPlanLabel(userPlan)}`;
    const contextLine = userRecord
        ? `🗂 Контекст (токены): ${getContextWindowText(userRecord)}`
        : `🗂 Контекст: ${(PLAN_MAX_CONTEXT_TOKENS[DEFAULT_USER_PLAN] / 1000).toFixed(0)}k`;
    const messageLimitLine = userRecord
        ? `📨 Сообщения сегодня: ${getDailyMessageLimitText(userRecord)}`
        : `📨 Сообщения: безлимит`;
    const webLimitLine = userRecord
        ? `🌐 Web-поиск сегодня: ${getDailyWebSearchLimitText(userRecord)}`
        : `🌐 Web-поиск сегодня: 0/${PLAN_DAILY_WEB_SEARCH_LIMITS[DEFAULT_USER_PLAN]}`;
    const imageGenLine = userRecord
        ? `🎨 Картинок сегодня: ${userRecord.daily_image_gen_count ?? 0}/${userRecord.daily_image_gen_limit ?? 0}`
        : `🎨 Картинок сегодня: 0/0`;
    const modelLine = userRecord?.preferred_model
        ? `🤖 Модель: ${userRecord.preferred_model}`
        : '🤖 Модель: Авто';
    const notesLine = NOTES_WEBAPP_URL
        ? '📝 Заметки: доступны в кнопке WebApp'
        : '📝 Заметки: команды /note_add, /notes, /note_find, /note_delete';
    const activeChat = userId ? getActiveChatForUser(userId) : null;
    const chatLine = activeChat
        ? `💬 Активный чат: #${activeChat.id} (${activeChat.title})`
        : '💬 Активный чат: не выбран';
    const moderationLine = isAdmin
        ? `\n🕓 Заявки: ${getPendingUsersCount()} | ⛔ Баны: ${getBannedUsersCount()}`
        : '';

    const text = `📁 Главное меню

👤 Имя: ${userName}
🆔 ID: ${userId ?? 'unknown'}
🛡️ Роль: ${roleLabel}
${planLine}
${contextLine}
${messageLimitLine}
${webLimitLine}
${imageGenLine}
${modelLine}
${chatLine}
${notesLine}
${promptLine}
${moderationLine}

Выберите действие:`;

    return ctx.reply(text, buildMainMenuInlineKeyboard(isAdmin));
};

const handleClear = (ctx: any) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    renameFlows.delete(userId);
    customPromptEditFlows.delete(userId);
    mailLimitFlows.delete(userId);
    contextLimitFlows.delete(userId);
    noteEditFlows.delete(userId);
    adminUserContextLimitFlows.delete(userId);
    adminUserMessageLimitFlows.delete(userId);
    clearActiveUserHistory(userId);
    return ctx.reply('Память активного чата очищена.');
};

const formatPromptsList = (currentPromptId: number | null, includeDescription = false) => {
    const prompts = getAllPrompts();
    const defaultPrompt = getDefaultPrompt();
    const effectiveCurrentPromptId = currentPromptId ?? defaultPrompt?.id ?? null;

    if (!prompts.length) return 'Промптов пока нет.';

    const list = prompts.map(prompt => {
        const markers: string[] = [];
        if (prompt.id === defaultPrompt?.id) markers.push('default');
        if (prompt.id === effectiveCurrentPromptId) markers.push('selected');
        const suffix = markers.length ? ` [${markers.join(', ')}]` : '';
        const description = includeDescription ? ` — ${prompt.description || 'без описания'}` : '';
        return `- ${prompt.id}: ${prompt.name}${suffix}${description}`;
    }).join('\n');

    return `Список промптов:\n${list}`;
};

const getPromptDescription = (description: string) => {
    const normalized = description.replace(/\s+/g, ' ').trim();
    if (!normalized) return 'Описание отсутствует.';
    return normalized.length > 220 ? `${normalized.slice(0, 220)}...` : normalized;
};

const getCustomPromptPreview = (content: string | null | undefined, maxLen = 220) => {
    const normalized = (content || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return 'Пока не задан.';
    return normalized.length > maxLen ? `${normalized.slice(0, maxLen)}...` : normalized;
};

const buildPromptListKeyboard = (prompts: PromptRecord[], currentPromptId: number, hasCustomPrompt: boolean) => {
    const rows = prompts.map(prompt => {
        const label = prompt.id === currentPromptId ? `✅ ${prompt.name}` : prompt.name;
        return [Markup.button.callback(label, `prompt:view:${prompt.id}`)];
    });

    const customLabel = currentPromptId === CUSTOM_PROMPT_ID
        ? '✅ Кастомный'
        : hasCustomPrompt
            ? '🧩 Кастомный'
            : '🧩 Кастомный (создать)';
    rows.push([Markup.button.callback(customLabel, 'prompt:custom:view')]);
    rows.push([Markup.button.callback('❌ Отменить', 'prompt:cancel')]);
    return Markup.inlineKeyboard(rows);
};

const buildPromptCardKeyboard = (promptId: number, selected: boolean) => {
    const chooseButton = selected
        ? Markup.button.callback('✅ Уже выбран', `prompt:noop:${promptId}`)
        : Markup.button.callback('✅ Выбрать', `prompt:use:${promptId}`);

    return Markup.inlineKeyboard([
        [chooseButton],
        [Markup.button.callback('⬅️ К списку', 'prompt:list'), Markup.button.callback('❌ Отменить', 'prompt:cancel')]
    ]);
};

const buildCustomPromptCardKeyboard = (isSelected: boolean, hasCustomPrompt: boolean) => {
    const selectButton = isSelected
        ? Markup.button.callback('✅ Оставить текущий', 'prompt:custom:keep')
        : Markup.button.callback(
            hasCustomPrompt ? '✅ Использовать текущий' : '✅ Сохранить и использовать',
            'prompt:custom:use'
        );

    return Markup.inlineKeyboard([
        [selectButton],
        [Markup.button.callback(hasCustomPrompt ? '✏️ Отредактировать' : '✏️ Создать', 'prompt:custom:edit')],
        [Markup.button.callback('⬅️ К списку', 'prompt:list'), Markup.button.callback('❌ Отменить', 'prompt:cancel')]
    ]);
};

const renderPromptListInteractive = async (ctx: any, user: { selected_prompt_id: number | null; custom_prompt_content?: string | null }, mode: 'reply' | 'edit') => {
    const prompts = getAllPrompts();
    if (!prompts.length) {
        if (mode === 'edit') return ctx.editMessageText('Промптов пока нет.');
        return ctx.reply('Промптов пока нет.');
    }

    const currentPromptId = user.selected_prompt_id === CUSTOM_PROMPT_ID ? CUSTOM_PROMPT_ID : resolvePromptForUser(user).id;
    const text = 'Выбери промпт кнопкой ниже:';
    const keyboard = buildPromptListKeyboard(prompts, currentPromptId, !!(user.custom_prompt_content || '').trim());

    if (mode === 'edit') return ctx.editMessageText(text, keyboard);
    return ctx.reply(text, keyboard);
};

// ── Model selector (TG) ──────────────────────────────────────────────────────

const buildModelListKeyboard = (models: ModelsCatalogEntry[], currentModelId: string | null) => {
    const rows: any[] = [];
    // Авто — всегда первый
    const autoLabel = !currentModelId ? '✅ Авто' : 'Авто';
    rows.push([Markup.button.callback(autoLabel, 'model:select:auto')]);
    // Модели из каталога
    for (const m of models) {
        const label = m.id === currentModelId ? `✅ ${m.name}` : m.name;
        rows.push([Markup.button.callback(label, `model:select:${m.id}`)]);
    }
    rows.push([Markup.button.callback('❌ Отмена', 'model:cancel')]);
    return Markup.inlineKeyboard(rows);
};

const handleModelList = async (ctx: any) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    try {
        const data = await runBackendGetModels(userId);
        if (!data.models.length) {
            await ctx.reply('Ручной выбор моделей недоступен. Используется автоматический режим.');
            return;
        }
        const text = `🤖 Текущая модель: ${data.preferred_model || 'Авто'}\n\nВыберите модель:`;
        await ctx.reply(text, buildModelListKeyboard(data.models, data.preferred_model));
    } catch {
        await ctx.reply('Не удалось загрузить список моделей.');
    }
};

const renderPromptCardInteractive = async (ctx: any, user: { selected_prompt_id: number | null; custom_prompt_content?: string | null }, prompt: PromptRecord) => {
    const currentPromptId = user.selected_prompt_id === CUSTOM_PROMPT_ID ? CUSTOM_PROMPT_ID : resolvePromptForUser(user).id;
    const selected = prompt.id === currentPromptId;
    const defaultMark = prompt.is_default ? ' [default]' : '';
    const selectedMark = selected ? ' [selected]' : '';
    const text = `Название: ${prompt.name}${defaultMark}${selectedMark}\nОписание: ${getPromptDescription(prompt.description)}`;
    return ctx.editMessageText(text, buildPromptCardKeyboard(prompt.id, selected));
};

const renderCustomPromptCardInteractive = async (
    ctx: any,
    user: { selected_prompt_id: number | null; custom_prompt_content?: string | null },
    mode: 'reply' | 'edit' = 'edit'
) => {
    const isSelected = user.selected_prompt_id === CUSTOM_PROMPT_ID;
    const hasCustomPrompt = !!(user.custom_prompt_content || '').trim();
    const selectedMark = isSelected ? ' [selected]' : '';
    const body = getCustomPromptPreview(user.custom_prompt_content, 500);
    const text = `Название: Кастомный${selectedMark}\nЛимит: до ${MAX_CUSTOM_PROMPT_LENGTH} символов.\nТекущий текст:\n${body}`;
    const keyboard = buildCustomPromptCardKeyboard(isSelected, hasCustomPrompt);
    if (mode === 'edit') return ctx.editMessageText(text, keyboard);
    return ctx.reply(text, keyboard);
};

const parsePipeParts = (text: string) => {
    const raw = text.replace(/^\/\S+\s*/, '').trim();
    const parts = raw.split('|').map(part => part.trim()).filter(Boolean);
    if (!parts.length) return null;
    return parts;
};

const getUserDisplayName = (user: { name: string | null; tg_username: string | null; id: number }) => {
    if (user.name && user.name.trim()) return user.name.trim();
    if (user.tg_username && user.tg_username.trim()) return `@${user.tg_username.trim()}`;
    return `ID ${user.id}`;
};

const getStatusLabel = (status: UserStatus) => {
    if (status === 'approved') return 'approved';
    if (status === 'none') return 'none';
    if (status === 'disapproved') return 'disapproved';
    return 'banned';
};
const getPlanLabel = (plan: UserPlan) => PLAN_LABELS[plan] || PLAN_LABELS[DEFAULT_USER_PLAN];
const getContextWindowText = (user: UserRecord) => {
    const effective = resolveMaxContextTokens(user);
    const hardLimit = (user.max_context_tokens_limit ?? 0) > 0
        ? Math.floor(user.max_context_tokens_limit!) : getPlanMaxContextTokens(parsePlanFromDb(user.plan));
    return `${(effective / 1000).toFixed(0)}k/${(hardLimit / 1000).toFixed(0)}k`;
};
const getDailyMessageLimitText = (_user: UserRecord) => 'безлимит';
const getDailyWebSearchLimitText = (user: UserRecord) => {
    const limit = normalizeDailyWebSearchLimit(user.daily_web_search_limit);
    return `${user.daily_web_search_count ?? 0}/${limit}`;
};
const getDurationLabel = (duration: PlanDurationCode) => {
    if (duration === 'day') return '1 день';
    if (duration === 'week') return '1 неделя';
    if (duration === 'month') return '1 месяц';
    if (duration === 'year') return '1 год';
    return 'Бессрочно';
};

const maybeCapturePendingName = async (ctx: any, user: UserRecord, text: string) => {
    if (ctx.from?.username) return false;
    if (user.name && user.name.trim()) return false;
    if (!text || text.startsWith('/')) return false;

    const candidate = text.trim();
    if (!candidate || candidate.length > 64) return false;
    if (/\d/.test(candidate)) return false;
    if (!/^[\p{L}][\p{L}\s.'-]{0,63}$/u.test(candidate)) return false;
    if (candidate.split(/\s+/).filter(Boolean).length > 3) return false;
    await updateUserName(user.id, candidate);
    return true;
};

const buildPendingListKeyboard = (rows: PendingUserRow[], page: number, total: number) => {
    const keyboardRows = rows.map(row => [Markup.button.callback(
        `👤 ${getUserDisplayName(row)} (#${row.id})`,
        `mod:pv:${row.id}:${page}`
    )]);

    const navRow = [];
    if (page > 0) navRow.push(Markup.button.callback('⬅️ Назад', `mod:pp:${page - 1}`));
    if ((page + 1) * PAGE_SIZE < total) navRow.push(Markup.button.callback('➡️ Далее', `mod:pp:${page + 1}`));
    if (navRow.length) keyboardRows.push(navRow);

    keyboardRows.push([Markup.button.callback('🔄 Обновить', `mod:pp:${page}`)]);
    return Markup.inlineKeyboard(keyboardRows);
};

const buildAdminUsersListKeyboard = (rows: UserRecord[], page: number, total: number, noteStatsMap: Map<number, NoteStatsRecord>) => {
    const keyboardRows = rows.map(row => {
        const statusTag = row.status === 'banned' ? '⛔' : row.status === 'approved' ? '✅' : '🕓';
        const planTag = getPlanLabel(parsePlanFromDb(row.plan));
        const webLimit = normalizeDailyWebSearchLimit(row.daily_web_search_limit);
        const notesStats = noteStatsMap.get(row.id) || { user_id: row.id, notes_count: 0, notes_chars: 0 };
        const ctxTokens = (row.max_context_tokens && row.max_context_tokens > 0) ? `${(row.max_context_tokens / 1000).toFixed(0)}k` : 'auto';
        const usageTag = `msg:${row.daily_message_count ?? 0} tok:${formatTokenCountShort(row.daily_tokens_used ?? 0)} ctx:${ctxTokens} web:${row.daily_web_search_count ?? 0}/${webLimit} img:${row.daily_image_gen_count ?? 0}/${row.daily_image_gen_limit ?? 0} nts:${notesStats.notes_count} ch:${notesStats.notes_chars} ${formatRub(row.daily_cost_rub ?? 0)}`;
        return [Markup.button.callback(
            `${statusTag} ${getUserDisplayName(row)} (#${row.id}) • ${planTag} • ${usageTag}`,
            `usr:view:${row.id}:${page}`
        )];
    });

    const navRow = [];
    if (page > 0) navRow.push(Markup.button.callback('⬅️ Назад', `usr:list:${page - 1}`));
    if ((page + 1) * PAGE_SIZE < total) navRow.push(Markup.button.callback('➡️ Далее', `usr:list:${page + 1}`));
    if (navRow.length) keyboardRows.push(navRow);

    keyboardRows.push([Markup.button.callback('🔄 Обновить', `usr:list:${page}`)]);
    return Markup.inlineKeyboard(keyboardRows);
};

const buildAdminUserCardKeyboard = (user: UserRecord, page: number) => {
    const moderationButton = user.status === 'banned'
        ? Markup.button.callback('✅ Разбанить', `usr:unban:${user.id}:${page}`)
        : Markup.button.callback('⛔ Забанить', `usr:ban:${user.id}:${page}`);

    return Markup.inlineKeyboard([
        [Markup.button.callback('✉️ Написать', `ai_send:${user.id}`)],
        [Markup.button.callback('🧩 Поменять план', `usr:plan:open:${user.id}:${page}`)],
        [Markup.button.callback('🗂 Изменить контекст', `usr:ctx:ask:${user.id}:${page}`)],
        [Markup.button.callback('📨 Лимит сообщений', `usr:msg:ask:${user.id}:${page}`)],
        [moderationButton],
        [Markup.button.callback('🗑 Удалить', `usr:remove:${user.id}:${page}`)],
        [Markup.button.callback('⬅️ К списку', `usr:list:${page}`)]
    ]);
};
const buildAdminPlanChoiceKeyboard = (userId: number, page: number) => Markup.inlineKeyboard([
    [Markup.button.callback(`FREE (${PLAN_MAX_CONTEXT_TOKENS.free / 1000}k tokens, web ${PLAN_DAILY_WEB_SEARCH_LIMITS.free})`, `usr:plan:pick:${userId}:${page}:free`)],
    [Markup.button.callback(`STANDART (${PLAN_MAX_CONTEXT_TOKENS.standart / 1000}k tokens, web ${PLAN_DAILY_WEB_SEARCH_LIMITS.standart})`, `usr:plan:pick:${userId}:${page}:standart`)],
    [Markup.button.callback(`PRO (${PLAN_MAX_CONTEXT_TOKENS.pro / 1000}k tokens, web ${PLAN_DAILY_WEB_SEARCH_LIMITS.pro})`, `usr:plan:pick:${userId}:${page}:pro`)],
    [Markup.button.callback('⬅️ Назад к пользователю', `usr:view:${userId}:${page}`)]
]);
const buildAdminPlanDurationKeyboard = (userId: number, page: number, plan: UserPlan) => Markup.inlineKeyboard([
    [
        Markup.button.callback('День', `usr:plan:dur:${userId}:${page}:${plan}:day`),
        Markup.button.callback('Неделя', `usr:plan:dur:${userId}:${page}:${plan}:week`)
    ],
    [
        Markup.button.callback('Месяц', `usr:plan:dur:${userId}:${page}:${plan}:month`),
        Markup.button.callback('Год', `usr:plan:dur:${userId}:${page}:${plan}:year`)
    ],
    [Markup.button.callback('Бессрочно', `usr:plan:dur:${userId}:${page}:${plan}:forever`)],
    [Markup.button.callback('⬅️ К выбору плана', `usr:plan:open:${userId}:${page}`)]
]);

const buildPendingCardKeyboard = (userId: number, page: number) => Markup.inlineKeyboard([
    [
        Markup.button.callback('✅ Подтвердить', `mod:ok:${userId}:${page}`),
        Markup.button.callback('❌ Отклонить', `mod:no:${userId}:${page}`)
    ],
    [Markup.button.callback('⛔ Забанить', `mod:ban:${userId}:${page}`)],
    [Markup.button.callback('⬅️ К заявкам', `mod:pp:${page}`)]
]);

const buildBannedListKeyboard = (rows: BannedUserRow[], page: number, total: number) => {
    const keyboardRows = rows.map(row => [Markup.button.callback(
        `⛔ ${getUserDisplayName(row)} (#${row.id})`,
        `mod:bv:${row.id}:${page}`
    )]);

    const navRow = [];
    if (page > 0) navRow.push(Markup.button.callback('⬅️ Назад', `mod:bp:${page - 1}`));
    if ((page + 1) * PAGE_SIZE < total) navRow.push(Markup.button.callback('➡️ Далее', `mod:bp:${page + 1}`));
    if (navRow.length) keyboardRows.push(navRow);

    keyboardRows.push([Markup.button.callback('🔄 Обновить', `mod:bp:${page}`)]);
    return Markup.inlineKeyboard(keyboardRows);
};

const buildBannedCardKeyboard = (userId: number, page: number) => Markup.inlineKeyboard([
    [Markup.button.callback('✅ Разблокировать', `mod:unban:${userId}:${page}`)],
    [Markup.button.callback('⬅️ К бан-листу', `mod:bp:${page}`)]
]);

const renderAdminUsersList = async (ctx: any, page: number, mode: 'reply' | 'edit' = 'reply') => {
    const safePage = Math.max(0, page);
    const total = getUsersCount();
    if (!total) {
        if (mode === 'edit') return ctx.editMessageText('Пользователей пока нет.');
        return ctx.reply('Пользователей пока нет.');
    }

    const rows = getUsersPage(PAGE_SIZE, safePage * PAGE_SIZE);
    const noteStatsMap = getNoteStatsForUsers(rows.map(r => r.id));
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const text = `👥 Пользователи\nСтраница: ${safePage + 1}/${pages}\nВсего: ${total}`;
    const keyboard = buildAdminUsersListKeyboard(rows, safePage, total, noteStatsMap);
    if (mode === 'edit') return ctx.editMessageText(text, keyboard);
    return ctx.reply(text, keyboard);
};

const renderAdminUserCard = async (ctx: any, user: UserRecord, page: number, mode: 'reply' | 'edit' = 'edit') => {
    const prompt = resolvePromptForUser(user);
    const ban = user.status === 'banned' ? getBanRecord(user.id) : undefined;
    const plan = parsePlanFromDb(user.plan);
    const notesStats = getNoteStatsForUser(user.id);
    const notesLimit = getPlanNotesLimit(plan);
    const noteContentLimit = getPlanNoteContentLimit(plan);
    const subscription = getCurrentPlanSubscription(user.id);
    const subscriptionEnds = subscription?.ends_at ? subscription.ends_at : 'бессрочно';
    const text = `Пользователь #${user.id}
Имя: ${user.name ?? 'не указано'}
Username: ${user.tg_username ? `@${user.tg_username}` : 'нет'}
Роль: ${user.role}
Статус: ${user.status}
План: ${getPlanLabel(plan)}
План до: ${subscriptionEnds}
Контекст (текущий/макс): ${getContextWindowText(user)}
Сообщения в день: ${getDailyMessageLimitText(user)}
Web-поиск в день: ${getDailyWebSearchLimitText(user)}
Генерация картинок в день: ${user.daily_image_gen_count ?? 0}/${user.daily_image_gen_limit ?? 0}
Промпт: #${prompt.id} ${prompt.name}${prompt.is_default ? ' (default)' : ''}
Сообщений сегодня: ${user.daily_message_count ?? 0}
Токенов сегодня: ${user.daily_tokens_used ?? 0}
Цена сегодня: ${formatRub(user.daily_cost_rub ?? 0)}
Поисков web сегодня: ${user.daily_web_search_count ?? 0}
Картинок сегодня: ${user.daily_image_gen_count ?? 0}/${user.daily_image_gen_limit ?? 0}
Токенов всего: ${user.total_tokens_used ?? 0}
Цена всего: ${formatRub(user.total_cost_rub ?? 0)}
Поисков web всего: ${user.total_web_search_count ?? 0}
Картинок всего: ${user.total_image_gen_count ?? 0}
Заметок: ${notesStats.notes_count}/${notesLimit}
Символов в заметках: ${notesStats.notes_chars}
Лимит символов на заметку: ${noteContentLimit}
Всего символов отправлено: ${user.total_message_length ?? 0}
${ban ? `Бан: ${ban.reason}` : ''}`.trim();
    const keyboard = buildAdminUserCardKeyboard(user, page);
    if (mode === 'edit') return ctx.editMessageText(text, keyboard);
    return ctx.reply(text, keyboard);
};
const renderAdminPlanChoiceCard = async (ctx: any, user: UserRecord, page: number, mode: 'reply' | 'edit' = 'edit') => {
    const plan = parsePlanFromDb(user.plan);
    const text = `Пользователь #${user.id}
Текущий план: ${getPlanLabel(plan)}
Текущий контекст: ${getContextWindowText(user)}

Выберите новый план:`;
    const keyboard = buildAdminPlanChoiceKeyboard(user.id, page);
    if (mode === 'edit') return ctx.editMessageText(text, keyboard);
    return ctx.reply(text, keyboard);
};
const renderAdminPlanDurationCard = async (ctx: any, user: UserRecord, page: number, plan: UserPlan, mode: 'reply' | 'edit' = 'edit') => {
    const text = `Пользователь #${user.id}
Новый план: ${getPlanLabel(plan)}
Лимит контекста у плана: ${PLAN_MAX_CONTEXT_TOKENS[plan] / 1000}k токенов
Сообщения в день: безлимит
Лимит web-поиска в день у плана: ${PLAN_DAILY_WEB_SEARCH_LIMITS[plan]}
Лимит заметок: ${getPlanNotesLimit(plan)}
Лимит символов на заметку: ${getPlanNoteContentLimit(plan)}

Выберите срок действия:`;
    const keyboard = buildAdminPlanDurationKeyboard(user.id, page, plan);
    if (mode === 'edit') return ctx.editMessageText(text, keyboard);
    return ctx.reply(text, keyboard);
};

const renderPendingList = async (ctx: any, page: number, mode: 'reply' | 'edit' = 'reply') => {
    const safePage = Math.max(0, page);
    const total = getPendingUsersCount();
    if (!total) {
        if (mode === 'edit') return ctx.editMessageText('Неподтверждённых заявок сейчас нет.');
        return ctx.reply('Неподтверждённых заявок сейчас нет.');
    }

    const rows = getPendingUsersPage(PAGE_SIZE, safePage * PAGE_SIZE);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const header = `🕓 Заявки на доступ\nСтраница: ${safePage + 1}/${pages}\nВсего: ${total}`;
    const keyboard = buildPendingListKeyboard(rows, safePage, total);
    if (mode === 'edit') return ctx.editMessageText(header, keyboard);
    return ctx.reply(header, keyboard);
};

const renderPendingCard = async (ctx: any, user: UserRecord, page: number, mode: 'reply' | 'edit' = 'edit') => {
    const username = user.tg_username ? `@${user.tg_username}` : 'нет';
    const text = `Заявка #${user.id}
Имя: ${user.name ?? 'не указано'}
Username: ${username}
Статус: ${getStatusLabel(user.status)}`;
    const keyboard = buildPendingCardKeyboard(user.id, page);
    if (mode === 'edit') return ctx.editMessageText(text, keyboard);
    return ctx.reply(text, keyboard);
};

const renderBannedList = async (ctx: any, page: number, mode: 'reply' | 'edit' = 'reply') => {
    const safePage = Math.max(0, page);
    const total = getBannedUsersCount();
    if (!total) {
        if (mode === 'edit') return ctx.editMessageText('Сейчас нет забаненных пользователей.');
        return ctx.reply('Сейчас нет забаненных пользователей.');
    }

    const rows = getBannedUsersPage(PAGE_SIZE, safePage * PAGE_SIZE);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const header = `⛔ Забаненные пользователи\nСтраница: ${safePage + 1}/${pages}\nВсего: ${total}`;
    const keyboard = buildBannedListKeyboard(rows, safePage, total);
    if (mode === 'edit') return ctx.editMessageText(header, keyboard);
    return ctx.reply(header, keyboard);
};

const renderBannedCard = async (ctx: any, user: UserRecord, page: number, mode: 'reply' | 'edit' = 'edit') => {
    const ban = getBanRecord(user.id);
    const text = `Бан #${user.id}
Имя: ${user.name ?? 'не указано'}
Username: ${user.tg_username ? `@${user.tg_username}` : 'нет'}
Причина: ${ban?.reason ?? 'Без причины'}
Дата: ${ban?.banned_at ?? 'неизвестно'}`;
    const keyboard = buildBannedCardKeyboard(user.id, page);
    if (mode === 'edit') return ctx.editMessageText(text, keyboard);
    return ctx.reply(text, keyboard);
};

const approveUserAccess = async (targetUserId: number) => {
    const user = await getUser(targetUserId);
    if (!user) return false;
    await updateUserStatus(targetUserId, 'approved');
    if (!user.selected_prompt_id) {
        const defaultPrompt = ensureDefaultPrompt();
        if (defaultPrompt) await updateUserPrompt(targetUserId, defaultPrompt.id);
    }
    removeBan(targetUserId);
    return true;
};

const disapproveUserAccess = async (targetUserId: number) => {
    const user = await getUser(targetUserId);
    if (!user) return false;
    await updateUserStatus(targetUserId, 'disapproved');
    removeBan(targetUserId);
    return true;
};

const banUserAccess = async (targetUserId: number, bannedBy: number, reason: string) => {
    const user = await getUser(targetUserId);
    if (!user) return false;
    await updateUserStatus(targetUserId, 'banned');
    setBan(targetUserId, reason, bannedBy);
    return true;
};

const unbanUserAccess = async (targetUserId: number) => {
    const user = await getUser(targetUserId);
    if (!user) return false;
    removeBan(targetUserId);
    await updateUserStatus(targetUserId, 'none');
    return true;
};

const notifyAdminsNewRequest = async (user: UserRecord) => {
    const usernameText = user.tg_username ? `@${user.tg_username}` : 'нет username';
    const text = `🆕 Новая заявка\nID: ${user.id}\nПрофиль: tg://user?id=${user.id}\nИмя: ${user.name ?? 'не указано'}\nUsername: ${usernameText}`;
    const keyboard = Markup.inlineKeyboard([
        [
            Markup.button.callback('✅ Подтвердить', `mod:ok:${user.id}:0`),
            Markup.button.callback('❌ Отклонить', `mod:no:${user.id}:0`)
        ],
        [Markup.button.callback('⛔ Забанить', `mod:ban:${user.id}:0`)]
    ]);

    for (const adminId of ADMIN_IDS) {
        try {
            await bot.telegram.sendMessage(adminId, text, keyboard);
        } catch (err) {
            console.warn(`Не удалось отправить заявку админу ${adminId}`);
        }
    }
};

bot.command('start', async (ctx) => {
    await ctx.reply('Кнопка меню закреплена внизу.', buildMenuTriggerKeyboard());
    return showMenu(ctx);
});
bot.command('menu', async (ctx) => { await showMenu(ctx); });
bot.hears(MAIN_MENU_TRIGGER_BUTTON, async (ctx) => { await showMenu(ctx); });

bot.command('prompts', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = await getUser(userId);
    if (!user) return ctx.reply('Не нашёл тебя в базе. Попроси админа выдать доступ.');

    if (ctx.state.role !== 'admin') {
        return renderPromptListInteractive(ctx, user, 'reply');
    }

    try {
        const data = await runBackendGetPrompts();
        const prompts = data.prompts;
        const lines = prompts.map(p => {
            const marker = p.is_default ? ' [default]' : '';
            const selected = user.selected_prompt_id === p.id ? ' <-- выбран' : '';
            return `#${p.id} ${p.name}${marker}${selected}: ${normalizeTextPreview(p.description || p.content, 80)}`;
        }).join('\n');
        return ctx.reply(`Промпты:\n\n${lines || 'Нет промптов.'}`);
    } catch {
        return ctx.reply('Ошибка получения промптов из API.');
    }
});

bot.command('prompt_use', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const promptId = Number.parseInt(parts[1], 10);
    if (!promptId || Number.isNaN(promptId)) return ctx.reply('Формат: /prompt_use 1');

    const user = await getUser(userId);
    if (!user) return ctx.reply('Не нашёл тебя в базе. Попроси админа выдать доступ.');

    try {
        const data = await runBackendGetPrompt(promptId);
        await runBackendSelectUserPrompt(userId, promptId);
        return ctx.reply(`Промпт выбран: ${data.prompt.name}`);
    } catch {
        return ctx.reply(`Промпт с ID ${promptId} не найден.`);
    }
});

bot.command('prompt_add', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');

    const parts = parsePipeParts(ctx.message.text);
    if (!parts || parts.length < 3) return ctx.reply('Формат: /prompt_add Имя | Описание | Текст промпта');

    const [name, description, ...contentParts] = parts;
    const content = contentParts.join(' | ').trim();
    if (!content) return ctx.reply('Текст промпта не может быть пустым.');

    try {
        const result = await runBackendCreatePrompt(name, description, content);
        return ctx.reply(`Промпт добавлен: ${name} (ID: ${result.prompt_id})`);
    } catch (err: any) {
        if (axios.isAxiosError(err) && err.response?.data?.error === 'name_already_exists') {
            return ctx.reply('Не удалось добавить промпт. Имя уже занято.');
        }
        return ctx.reply('Не удалось добавить промпт.');
    }
});

bot.command('prompt_show', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const promptId = Number.parseInt(parts[1], 10);
    if (!promptId || Number.isNaN(promptId)) return ctx.reply('Формат: /prompt_show 3');

    try {
        const data = await runBackendGetPrompt(promptId);
        const p = data.prompt;
        const defaultMark = p.is_default ? ' [default]' : '';
        const text = `Промпт ${p.id}: ${p.name}${defaultMark}\nОписание: ${p.description || 'без описания'}\n\nТекст:\n${p.content}`;
        return ctx.reply(text);
    } catch {
        return ctx.reply(`Промпт с ID ${promptId} не найден.`);
    }
});

bot.command('prompt_set', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');

    const parts = parsePipeParts(ctx.message.text);
    if (!parts || parts.length < 2) return ctx.reply('Формат: /prompt_set 3 | Новый текст');

    const promptId = Number.parseInt(parts[0], 10);
    if (!promptId || Number.isNaN(promptId)) return ctx.reply('Укажи корректный ID: /prompt_set 3 | Новый текст');
    const content = parts.slice(1).join(' | ').trim();
    if (!content) return ctx.reply('Новый текст не может быть пустым.');

    try {
        const data = await runBackendGetPrompt(promptId);
        await runBackendUpdatePromptContent(promptId, content);
        return ctx.reply(`Текст промпта "${data.prompt.name}" обновлён.`);
    } catch {
        return ctx.reply(`Промпт с ID ${promptId} не найден.`);
    }
});

bot.command('prompt_desc', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');

    const parts = parsePipeParts(ctx.message.text);
    if (!parts || parts.length < 2) return ctx.reply('Формат: /prompt_desc 3 | Новое описание');

    const promptId = Number.parseInt(parts[0], 10);
    if (!promptId || Number.isNaN(promptId)) return ctx.reply('Укажи корректный ID: /prompt_desc 3 | Новое описание');
    const description = parts.slice(1).join(' | ').trim();
    if (!description) return ctx.reply('Описание не может быть пустым.');

    try {
        const data = await runBackendGetPrompt(promptId);
        await runBackendUpdatePromptDescription(promptId, description);
        return ctx.reply(`Описание промпта "${data.prompt.name}" обновлено.`);
    } catch {
        return ctx.reply(`Промпт с ID ${promptId} не найден.`);
    }
});

bot.command('prompt_rename', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const promptId = Number.parseInt(parts[1], 10);
    const newName = parts.slice(2).join(' ').trim();

    if (!promptId || Number.isNaN(promptId)) return ctx.reply('Формат: /prompt_rename 3 НовоеИмя');
    if (!newName) return ctx.reply('Формат: /prompt_rename 3 НовоеИмя');

    try {
        const data = await runBackendGetPrompt(promptId);
        await runBackendUpdatePromptName(promptId, newName);
        return ctx.reply(`Промпт переименован: ${data.prompt.name} -> ${newName}`);
    } catch (err: any) {
        if (axios.isAxiosError(err) && err.response?.data?.error === 'name_already_exists') {
            return ctx.reply('Не удалось переименовать промпт. Имя уже занято.');
        }
        return ctx.reply(`Промпт с ID ${promptId} не найден.`);
    }
});

bot.command('prompt_default', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const promptId = Number.parseInt(parts[1], 10);
    if (!promptId || Number.isNaN(promptId)) return ctx.reply('Формат: /prompt_default 3');

    try {
        const data = await runBackendGetPrompt(promptId);
        await runBackendSetDefaultPrompt(promptId);
        return ctx.reply(`Промпт по умолчанию обновлён: ${data.prompt.name}`);
    } catch {
        return ctx.reply(`Промпт с ID ${promptId} не найден.`);
    }
});

bot.command('prompt_delete', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const promptId = Number.parseInt(parts[1], 10);
    if (!promptId || Number.isNaN(promptId)) return ctx.reply('Формат: /prompt_delete 3');

    try {
        const data = await runBackendGetPrompt(promptId);
        const name = data.prompt.name;
        await runBackendDeletePrompt(promptId);
        return ctx.reply(`Промпт удалён: ${name}`);
    } catch (err: any) {
        if (axios.isAxiosError(err)) {
            const code = err.response?.data?.error;
            if (code === 'cannot_delete_last_prompt') return ctx.reply('Нельзя удалить последний промпт.');
            if (code === 'cannot_delete_default_prompt') return ctx.reply('Нельзя удалить промпт по умолчанию. Сначала назначь другой через /prompt_default.');
        }
        return ctx.reply(`Промпт с ID ${promptId} не найден.`);
    }
});

// Команда добавления пользователя (только для админов)
bot.command('add', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const newUserId = Number.parseInt(parts[1], 10);
    const newUserName = parts.slice(2).join(' ') || 'Без_имени';

    if (!newUserId || Number.isNaN(newUserId)) return ctx.reply('Укажи правильный ID: /add 123456789 Имя');

    await addUser(newUserId, newUserName, 'user', 'approved', null);
    removeBan(newUserId);
    ctx.reply(`Пользователь ${newUserName} (ID: ${newUserId}) успешно добавлен в базу.`);
});

// Команда удаления пользователя (только для админов)
bot.command('remove', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const targetUserId = Number.parseInt(parts[1], 10);

    if (!targetUserId || Number.isNaN(targetUserId)) return ctx.reply('Укажи правильный ID: /remove 123456789');
    if (ADMIN_IDS.has(targetUserId)) return ctx.reply('Нельзя удалить пользователя из ADMIN_IDS. Сначала убери его из .env и перезапусти бота.');

    const targetUser = await getUser(targetUserId);
    if (!targetUser) return ctx.reply(`Пользователь с ID ${targetUserId} не найден в базе.`);

    await removeUser(targetUserId);
    removeBan(targetUserId);
    removeUserPlanSubscriptions(targetUserId);
    clearUserHistory(targetUserId);
    ctx.reply(`Пользователь ${targetUser.name ?? 'Без_имени'} (ID: ${targetUserId}) удалён из базы.`);
});

bot.command('ban', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');
    const adminId = ctx.from?.id;
    if (!adminId) return;

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const targetUserId = Number.parseInt(parts[1], 10);
    if (!targetUserId || Number.isNaN(targetUserId)) return ctx.reply('Формат: /ban 123456789 [причина]');
    if (ADMIN_IDS.has(targetUserId)) return ctx.reply('Нельзя забанить пользователя из ADMIN_IDS.');

    const targetUser = await getUser(targetUserId);
    if (!targetUser) return ctx.reply(`Пользователь с ID ${targetUserId} не найден в базе.`);

    const reason = parts.slice(2).join(' ').trim() || 'Решение администратора';
    await banUserAccess(targetUserId, adminId, reason);
    ctx.reply(`Пользователь ${targetUser.name ?? 'Без_имени'} (ID: ${targetUserId}) забанен.`);

    bot.telegram.sendMessage(targetUserId, `🚫 Доступ заблокирован администратором.\nПричина: ${reason}`).catch(() => undefined);
});

bot.command('unban', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const targetUserId = Number.parseInt(parts[1], 10);
    if (!targetUserId || Number.isNaN(targetUserId)) return ctx.reply('Формат: /unban 123456789');

    const targetUser = await getUser(targetUserId);
    if (!targetUser) return ctx.reply(`Пользователь с ID ${targetUserId} не найден в базе.`);
    if (targetUser.status !== 'banned') return ctx.reply('Этот пользователь не находится в бане.');

    await unbanUserAccess(targetUserId);
    ctx.reply(`Пользователь ${targetUser.name ?? 'Без_имени'} (ID: ${targetUserId}) разбанен и снова в ожидании.`);

    bot.telegram.sendMessage(targetUserId, '✅ Блокировка снята. Заявка снова в ожидании подтверждения.').catch(() => undefined);
});

// Команда смены имени
bot.command('rename', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const isAdmin = ctx.state.role === 'admin';

    if (!isAdmin) {
        return startSelfRenameFlow(ctx);
    }

    if (parts.length < 2) {
        if (isAdmin) return ctx.reply('Формат: /rename НовоеИмя\nили /rename 123456789 НовоеИмя');
        return ctx.reply('Формат: /rename НовоеИмя');
    }

    let targetUserId = userId;
    let newUserName = parts.slice(1).join(' ').trim();

    // Для админа: если первый аргумент похож на ID, переименовываем указанного юзера.
    if (isAdmin) {
        const parsedId = Number.parseInt(parts[1], 10);
        if (!Number.isNaN(parsedId) && parsedId > 0 && parts.length >= 3) {
            targetUserId = parsedId;
            newUserName = parts.slice(2).join(' ').trim();
        }
    }

    if (!newUserName) {
        if (isAdmin) return ctx.reply('Укажи новое имя: /rename НовоеИмя\nили /rename 123456789 НовоеИмя');
        return ctx.reply('Укажи новое имя: /rename НовоеИмя');
    }

    const targetUser = await getUser(targetUserId);
    if (!targetUser) return ctx.reply(`Пользователь с ID ${targetUserId} не найден в базе.`);

    await updateUserName(targetUserId, newUserName);

    if (targetUserId === userId) {
        ctx.state.userName = newUserName;
        return ctx.reply(`Готово, теперь тебя зовут: ${newUserName}`);
    }

    ctx.reply(`Имя пользователя с ID ${targetUserId} обновлено: ${targetUser.name ?? 'Без_имени'} -> ${newUserName}`);
});

// Команда просмотра списка (только для админов)
bot.command('users', (ctx) => {
    if (ctx.state.role !== 'admin') return;
    return renderAdminUsersList(ctx, 0, 'reply');
});

bot.command('sync_plan_limits', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');
    await syncAllUsersPlanLimits();
    return ctx.reply(`✅ Лимиты по планам синхронизированы.`);
});

bot.command('reset_counters', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');
    try {
        await axios.post(`${BACKEND_API_BASE_URL}/internal/reset-daily-counters`, {}, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
        return ctx.reply('✅ Дневные счётчики всех пользователей обнулены.');
    } catch {
        return ctx.reply('❌ Ошибка при сбросе счётчиков.');
    }
});

bot.command('history_user', (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const targetUserId = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return ctx.reply('Формат: /history_user <user_id> [limit]');
    }

    const rawLimit = Number.parseInt(parts[2], 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.max(1, Math.min(20, rawLimit))
        : 10;

    const rows = getRecentHistoryRowsByUser(targetUserId, limit);
    return ctx.reply(formatRecentHistoryRows(targetUserId, rows));
});

bot.command('history_delete', (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const targetUserId = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return ctx.reply('Формат: /history_delete <user_id> <message_id> [db|tg]\nили /history_delete <user_id> <user|assistant|all>');
    }
    const secondArg = (parts[2] || '').toLowerCase();
    if (!secondArg) {
        return ctx.reply('Формат: /history_delete <user_id> <message_id> [db|tg]\nили /history_delete <user_id> <user|assistant|all>');
    }

    if (secondArg === 'user' || secondArg === 'assistant' || secondArg === 'all') {
        const role: ChatRole | 'all' = secondArg;
        const result = deleteHistoryByUserAndRole(targetUserId, role);
        if (!result.changes) {
            return ctx.reply(`Ничего не удалено для user_id=${targetUserId} (role=${role}).`);
        }
        return ctx.reply(`Удалено ${result.changes} записей истории для user_id=${targetUserId} (role=${role}).`);
    }

    const messageId = Number.parseInt(secondArg, 10);
    if (!Number.isFinite(messageId) || messageId <= 0) {
        return ctx.reply('Некорректный message_id. Формат: /history_delete <user_id> <message_id> [db|tg]');
    }

    const mode = (parts[3] || '').toLowerCase();
    let result;
    if (mode === 'tg') {
        result = deleteHistoryMessageByUserAndTelegramMessageId(targetUserId, messageId);
        if (!result.changes) {
            return ctx.reply(`Сообщение не найдено: user_id=${targetUserId}, telegram_message_id=${messageId}.`);
        }
        return ctx.reply(`Удалено ${result.changes} сообщение(й): user_id=${targetUserId}, telegram_message_id=${messageId}.`);
    }
    if (mode === 'db') {
        result = deleteHistoryMessageByUserAndMessageId(targetUserId, messageId);
        if (!result.changes) {
            return ctx.reply(`Сообщение не найдено: user_id=${targetUserId}, db_id=${messageId}.`);
        }
        return ctx.reply(`Удалено ${result.changes} сообщение(й): user_id=${targetUserId}, db_id=${messageId}.`);
    }

    result = deleteHistoryMessageByUserAndMessageId(targetUserId, messageId);
    if (result.changes) {
        return ctx.reply(`Удалено ${result.changes} сообщение(й): user_id=${targetUserId}, db_id=${messageId}.`);
    }
    const tgResult = deleteHistoryMessageByUserAndTelegramMessageId(targetUserId, messageId);
    if (tgResult.changes) {
        return ctx.reply(`Удалено ${tgResult.changes} сообщение(й): user_id=${targetUserId}, telegram_message_id=${messageId}.`);
    }
    return ctx.reply(`Сообщение не найдено для user_id=${targetUserId}, message_id=${messageId} (проверил db_id и telegram_message_id).`);
});

bot.command('clear', (ctx) => {
    return handleClear(ctx);
});

// ── /link — привязка к desktop-аккаунту ──
bot.command('link', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const userRecord = await getUser(userId);
    if (!userRecord) return ctx.reply('Сначала попроси админа добавить тебя.');
    linkCodeFlows.set(userId, 'await_code');
    return ctx.reply(
        '🔗 Привязка к desktop-приложению.\n\n' +
        'Введи 6-значный код, который отображается в десктоп-приложении.\n' +
        'Код действует 10 минут.\n\n' +
        'Для отмены: /cancellink',
        Markup.keyboard([['/cancellink']]).resize().oneTime()
    );
});

bot.command('cancellink', (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    linkCodeFlows.delete(userId);
    return ctx.reply('Ок, привязка отменена.', buildMenuTriggerKeyboard());
});

bot.command('unlink', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    try {
        const response = await axios.post(
            `${BACKEND_API_BASE_URL}/internal/link/unlink`,
            { tg_id: userId },
            { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` } }
        );
        if (response.data?.ok) {
            return ctx.reply('Аккаунт отвязан от десктоп-приложения.', buildMenuTriggerKeyboard());
        }
        return ctx.reply('Аккаунт не был привязан.', buildMenuTriggerKeyboard());
    } catch (err: any) {
        const msg = err?.response?.data?.error;
        if (msg === 'not_linked') {
            return ctx.reply('Аккаунт не был привязан к десктоп-приложению.', buildMenuTriggerKeyboard());
        }
        console.error('Unlink error:', err?.message || err);
        return ctx.reply('Ошибка при отвязке. Попробуй позже.');
    }
});

bot.command('tz', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const offset = Number.parseInt(ctx.message.text.split(' ')[1], 10);
    if (Number.isNaN(offset) || offset < -12 || offset > 14) {
        return ctx.reply('Использование: /tz <смещение_от_utc>. Например, для Города: /tz 7');
    }

    try {
        await runBackendSetTimezone(userId, offset);
        updateUserTimezone(userId, offset);
    } catch {
        return ctx.reply('Ошибка при установке часового пояса.');
    }
    timezoneSetupFlows.delete(userId);
    const sign = offset >= 0 ? '+' : '';
    return ctx.reply(`Часовой пояс успешно изменён на UTC${sign}${offset}.`, buildMenuTriggerKeyboard());
});

bot.command('tasks', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        return ctx.reply('Нет доступа к задачам.');
    }

    const tasks = getUserTasks(userId, 'pending', 20);
    if (!tasks.length) return ctx.reply('У тебя нет активных напоминаний и расписаний.');

    const text = `Твои активные задачи (${tasks.length}/${MAX_PENDING_TASKS_PER_USER}):\n\n${await formatTasksList(tasks)}`;
    return ctx.reply(text);
});

bot.command('task_delete', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        return ctx.reply('Нет доступа к задачам.');
    }

    const taskId = Number.parseInt(ctx.message.text.split(' ')[1], 10);
    if (!taskId || Number.isNaN(taskId)) {
        return ctx.reply('Формат: /task_delete <id>. Пример: /task_delete 12');
    }

    const task = getTaskByUserAndId(userId, taskId);
    if (!task) return ctx.reply(`Задача с ID ${taskId} не найдена.`);
    if (task.status !== 'pending') return ctx.reply(`Задача #${taskId} уже не активна (status: ${task.status}).`);

    const result = deletePendingTaskByUserAndId(userId, taskId);
    if (!result.changes) return ctx.reply(`Не удалось удалить задачу #${taskId}.`);

    const updated = getUserTasks(userId, 'pending', 20);
    const updatedText = await formatTasksList(updated, 'Активных задач больше нет.');
    return ctx.reply(`Удалил задачу #${taskId}.\n\nТекущие задачи (${updated.length}/${MAX_PENDING_TASKS_PER_USER}):\n\n${updatedText}`);
});

bot.command('chats', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        return ctx.reply('Нет доступа к чатам.');
    }

    const active = getActiveChatForUser(userId);
    const chats = getUserChats(userId, 50);
    if (!chats.length) return ctx.reply('Чатов пока нет.');
    const lines = chats.map(chat => {
        const marker = active?.id === chat.id ? ' [активный]' : '';
        return `#${chat.id}${marker} ${chat.title}`;
    });
    return ctx.reply(`Твои чаты (${chats.length}):\n\n${lines.join('\n')}\n\nКоманды:\n/chat_new <название>\n/chat_use <id>`);
});

bot.command('chat_new', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        return ctx.reply('Нет доступа к чатам.');
    }

    const titleRaw = extractCommandPayload(ctx.message.text, 'chat_new');
    const existingCount = getUserChats(userId, 500).length;
    const autoTitle = `Чат ${existingCount + 1}`;
    const title = (titleRaw || autoTitle).slice(0, 80).trim() || autoTitle;
    const created = createUserChat(userId, title);
    const chatId = Number(created.lastInsertRowid);
    setUserActiveChat(userId, chatId);
    return ctx.reply(`Создал и активировал чат #${chatId}: ${title}`);
});

bot.command('chat_use', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        return ctx.reply('Нет доступа к чатам.');
    }

    const chatId = Number.parseInt(ctx.message.text.split(' ').filter(Boolean)[1], 10);
    if (!Number.isFinite(chatId) || chatId <= 0) {
        return ctx.reply('Формат: /chat_use <id>');
    }

    const chat = getUserChatById(userId, chatId);
    if (!chat) {
        return ctx.reply(`Чат #${chatId} не найден.`);
    }
    setUserActiveChat(userId, chatId);
    return ctx.reply(`Активный чат переключен на #${chat.id}: ${chat.title}`);
});

bot.command('note_add', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        return ctx.reply('Нет доступа к заметкам.');
    }

    const content = extractCommandPayload(ctx.message.text, 'note_add');
    if (!content) return ctx.reply('Формат: /note_add <текст заметки>');
    const userPlan = parsePlanFromDb(user.plan);
    const contentLimit = getPlanNoteContentLimit(userPlan);
    if (content.length > contentLimit) {
        return ctx.reply(`Слишком длинная заметка: ${content.length} символов. Лимит для плана ${getPlanLabel(userPlan)}: ${contentLimit}.`);
    }
    const notesLimit = getPlanNotesLimit(userPlan);
    const notesCount = countNotes(userId);
    if (notesCount >= notesLimit) {
        return ctx.reply(`Лимит записной книжки для плана ${getPlanLabel(userPlan)}: ${notesLimit}. Удали старые заметки (/note_delete <id>) или обнови план.`);
    }

    const created = createNote(userId, content, '');
    const noteId = Number(created.lastInsertRowid);
    return ctx.reply(`✅ Заметка сохранена (ID: ${noteId}).`);
});

bot.command('notes', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        return ctx.reply('Нет доступа к заметкам.');
    }

    const pageRaw = ctx.message.text.split(' ').filter(Boolean)[1];
    const pageParsed = Number.parseInt(pageRaw || '1', 10);
    const page = Number.isFinite(pageParsed) && pageParsed > 0 ? pageParsed : 1;
    const listLimit = getPlanNoteListLimit(parsePlanFromDb(user.plan));
    const offset = (page - 1) * listLimit;
    const notes = getNotesPage(userId, listLimit, offset);
    const total = countNotes(userId);
    return ctx.reply(formatNotesPage(notes, page, total, listLimit));
});

bot.command('note_find', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        return ctx.reply('Нет доступа к заметкам.');
    }

    const query = extractCommandPayload(ctx.message.text, 'note_find');
    if (!query) return ctx.reply('Формат: /note_find <поисковая строка>');
    if (query.length > NOTE_QUERY_MAX_LENGTH) {
        return ctx.reply(`Слишком длинный запрос: ${query.length} символов. Лимит: ${NOTE_QUERY_MAX_LENGTH}.`);
    }

    const listLimit = getPlanNoteListLimit(parsePlanFromDb(user.plan));
    const notes = getNotesPage(userId, listLimit, 0, query);
    const total = countNotes(userId, query);
    return ctx.reply(formatNotesPage(notes, 1, total, listLimit, query));
});

bot.command('note_delete', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        return ctx.reply('Нет доступа к заметкам.');
    }

    const noteId = Number.parseInt(ctx.message.text.split(' ').filter(Boolean)[1], 10);
    if (!noteId || Number.isNaN(noteId)) {
        return ctx.reply('Формат: /note_delete <id>');
    }
    const note = getNoteByUserAndId(userId, noteId);
    if (!note) return ctx.reply(`Заметка #${noteId} не найдена.`);
    const result = deleteNoteByUserAndId(userId, noteId);
    if (!result.changes) return ctx.reply(`Не удалось удалить заметку #${noteId}.`);
    return ctx.reply(`🗑 Заметка #${noteId} удалена.`);
});

bot.command('mail_setup', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        return ctx.reply('Нет доступа к настройке почты.');
    }

    const parts = ctx.message.text.split(' ').filter(Boolean);
    if (parts.length < 3) {
        return ctx.reply('Использование: /mail_setup <yandex|google> <email> <пароль_приложения>\nили: /mail_setup <email> <пароль_приложения> (провайдер определится по домену)');
    }

    let providerInput = '';
    let email = '';
    let appPassword = '';

    const explicitProvider = resolveImapProviderConfig(parts[1]);
    if (explicitProvider) {
        providerInput = parts[1];
        email = parts[2]?.trim() || '';
        appPassword = parts.slice(3).join(' ').trim();
    } else {
        email = parts[1]?.trim() || '';
        appPassword = parts.slice(2).join(' ').trim();
        const detected = detectMailProviderByEmail(email);
        if (detected) providerInput = detected;
    }

    if (!providerInput) {
        return ctx.reply('Не удалось определить провайдер. Укажи явно: yandex или google.');
    }

    if (!email || !appPassword) {
        return ctx.reply('Email и пароль приложения обязательны.');
    }

    try {
        const result = await runBackendMailSetup(userId, providerInput, email, appPassword);
        const connected = result.accounts.map(a => `${a.provider}: ${a.imap_user}`).join('\n');
        return ctx.reply(`✅ Почта привязана: ${email}\nПровайдер: ${providerInput} (активный)\n\nПодключенные ящики:\n${connected}\n\nПереключение: /mail_use <yandex|google>`);
    } catch (err: any) {
        if (axios.isAxiosError(err)) {
            const code = err.response?.data?.error;
            if (code === 'bad_provider') return ctx.reply('Не удалось определить провайдер. Укажи явно: yandex или google.');
        }
        return ctx.reply('Ошибка при настройке почты.');
    }
});

bot.command('mail_use', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const provider = normalizeMailProvider(parts[1]);
    if (!provider) {
        return ctx.reply('Использование: /mail_use <yandex|google>');
    }

    try {
        const result = await runBackendMailUse(userId, provider);
        return ctx.reply(`✅ Активный почтовый ящик: ${result.provider} (${result.imap_user})`);
    } catch (err: any) {
        if (axios.isAxiosError(err) && err.response?.data?.error === 'mail_account_not_found') {
            return ctx.reply(`У тебя не привязан ${provider}. Сначала: /mail_setup ${provider} <email> <пароль_приложения>`);
        }
        return ctx.reply('Ошибка при переключении почты.');
    }
});

bot.command('mail_limit', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        return ctx.reply('Нет доступа к настройке почты.');
    }

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const parsed = Number.parseInt(parts[1] || '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        const current = user.mail_check_limit || DEFAULT_MAIL_CHECK_LIMIT;
        const capText = user.role === 'admin' ? 'без лимита' : 'максимум 10';
        return ctx.reply(`Текущий лимит check_emails: ${current}.\nУстановить: /mail_limit <число> (${capText}).`);
    }

    if (user.role !== 'admin' && parsed > 10) {
        return ctx.reply('Вам доступно максимум 10 писем за запрос.');
    }

    try {
        await runBackendMailLimit(userId, parsed);
        return ctx.reply(`✅ Лимит check_emails обновлён: ${parsed}.`);
    } catch {
        return ctx.reply('Ошибка при обновлении лимита.');
    }
});

bot.command('mail_forget', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const parts = ctx.message.text.split(' ').filter(Boolean);
    const provider = normalizeMailProvider(parts[1]);

    try {
        const result = await runBackendMailForget(userId, provider);
        if (result.deleted === 'all') {
            return ctx.reply('🗑 Данные всех почтовых ящиков удалены.');
        }
        if (result.new_active) {
            return ctx.reply(`🗑 ${result.deleted} удалён. Активный ящик теперь: ${result.new_active.provider} (${result.new_active.imap_user})`);
        }
        return ctx.reply(`🗑 ${result.deleted} удалён. Больше привязанных ящиков нет.`);
    } catch {
        return ctx.reply('Ошибка при удалении почты.');
    }
});

bot.hears(TZ_BUTTON_SET_UTC, (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    timezoneSetupFlows.set(userId, 'await_offset');
    return ctx.reply('Окей, отправь смещение командой вида: /tz 7\nДопустимый диапазон: от -12 до +14.');
});

bot.on('location', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = await getUser(userId);
    if (!user) return;

    const longitude = ctx.message.location.longitude;
    let offset = Math.round(longitude / 15);
    if (offset < -12) offset = -12;
    if (offset > 14) offset = 14;

    try {
        await runBackendSetTimezone(userId, offset);
    } catch {}
    updateUserTimezone(userId, offset);
    timezoneSetupFlows.delete(userId);
    const sign = offset >= 0 ? '+' : '';
    return ctx.reply(`Геопозиция получена. Примерный часовой пояс установлен: UTC${sign}${offset}.`, buildMenuTriggerKeyboard());
});

bot.action(/^main:(clear|users|rename|add|remove|prompts|current_prompt|model|context_size|prompt_admin|pending|banned|mail|notes|help)$/, async (ctx) => {
    const actionId = (ctx as any).match[1] as MenuActionId;
    const action = MENU_ACTION_BY_ID[actionId];

    if (!action) {
        await ctx.answerCbQuery('Неизвестное действие');
        return;
    }

    if (action.adminOnly && ctx.state.role !== 'admin') {
        await ctx.answerCbQuery('Это только для админа');
        return;
    }

    await ctx.answerCbQuery();

    if (actionId === 'clear') {
        await handleClear(ctx);
        return;
    }

    if (actionId === 'users') {
        await renderAdminUsersList(ctx, 0, 'reply');
        return;
    }

    if (actionId === 'rename') {
        if (ctx.state.role === 'admin') {
            await ctx.reply('Для себя: /rename НовоеИмя\nДля пользователя: /rename 123456789 НовоеИмя');
            return;
        }
        await startSelfRenameFlow(ctx);
        return;
    }

    if (actionId === 'prompts') {
        const userId = ctx.from?.id;
        if (!userId) return;

        const user = await getUser(userId);
        if (!user) {
            await ctx.reply('Не нашёл тебя в базе. Попроси админа выдать доступ.');
            return;
        }

        if (ctx.state.role !== 'admin') {
            await renderPromptListInteractive(ctx, user, 'reply');
            return;
        }

        await ctx.reply(`${formatPromptsList(user.selected_prompt_id, true)}\n\nЧтобы выбрать: /prompt_use <id>`);
        return;
    }

    if (actionId === 'current_prompt') {
        const userId = ctx.from?.id;
        if (!userId) return;

        const user = await getUser(userId);
        if (!user) {
            await ctx.reply('Не нашёл тебя в базе. Попроси админа выдать доступ.');
            return;
        }

        const activePrompt = resolvePromptForUser(user);
        if (activePrompt.id === CUSTOM_PROMPT_ID) {
            const preview = getCustomPromptPreview(user.custom_prompt_content, 280);
            await ctx.reply(`Текущий промпт: Кастомный\nЛимит: до ${MAX_CUSTOM_PROMPT_LENGTH} символов.\nТекст:\n${preview}`);
            return;
        }

        const isDefault = activePrompt.is_default === 1 ? ' (default)' : '';
        await ctx.reply(`Текущий промпт: ${activePrompt.name}${isDefault}\nID: ${activePrompt.id}`);
        return;
    }

    if (actionId === 'model') {
        await handleModelList(ctx);
        return;
    }

    if (actionId === 'context_size') {
        const userId = ctx.from?.id;
        if (!userId) return;
        const user = await getUser(userId);
        if (!user) {
            await ctx.reply('Не нашёл тебя в базе. Попроси админа выдать доступ.');
            return;
        }
        const currentTokens = resolveMaxContextTokens(user);
        const maxTokens = (user.max_context_tokens_limit ?? 0) > 0
            ? Math.floor(user.max_context_tokens_limit!) : getPlanMaxContextTokens(parsePlanFromDb(user.plan));
        await ctx.reply(
            `🗂 Лимит контекста (токены)\nТекущий: ${(currentTokens / 1000).toFixed(0)}k\nМаксимум для тарифа: ${(maxTokens / 1000).toFixed(0)}k\nПлан: ${getPlanLabel(parsePlanFromDb(user.plan))}`,
            buildContextSettingsKeyboard()
        );
        return;
    }

    if (actionId === 'add') {
        await ctx.reply('Формат: /add 123456789 Имя');
        return;
    }

    if (actionId === 'remove') {
        await ctx.reply('Формат: /remove 123456789');
        return;
    }

    if (actionId === 'prompt_admin') {
        await ctx.reply('Промпт-админ команды:\n/prompt_add Имя | Описание | Текст\n/prompt_show <id>\n/prompt_set <id> | Текст\n/prompt_desc <id> | Описание\n/prompt_rename <id> Имя\n/prompt_default <id>\n/prompt_delete <id>');
        return;
    }

    if (actionId === 'pending') {
        await renderPendingList(ctx, 0, 'reply');
        return;
    }

    if (actionId === 'banned') {
        await renderBannedList(ctx, 0, 'reply');
        return;
    }

    if (actionId === 'mail') {
        await ctx.reply('📬 Управление почтой\nВыбери действие:', buildMailMenuKeyboard());
        return;
    }

    if (actionId === 'notes') {
        const userId = ctx.from?.id;
        if (!userId) return;
        await renderNotesMenuList(ctx, userId, 0, 'reply');
        return;
    }

    if (ctx.state.role === 'admin') {
        await ctx.reply('Команды: /menu, /clear, /tz, /tasks, /task_delete, /chats, /chat_new, /chat_use, /note_add, /notes, /note_find, /note_delete, /mail_setup, /mail_use, /mail_limit, /mail_forget, /rename, /prompts, /prompt_use, /add, /remove, /users, /sync_plan_limits, /history_user, /history_delete, /ban, /unban, /prompt_add, /prompt_show, /prompt_set, /prompt_desc, /prompt_rename, /prompt_delete, /prompt_default');
        return;
    }

    await ctx.reply('Команды: /menu, /clear, /tz, /tasks, /task_delete, /chats, /chat_new, /chat_use, /note_add, /notes, /note_find, /note_delete, /mail_setup, /mail_use, /mail_limit, /mail_forget, /rename, /prompts, /prompt_use');
});

bot.action('context:change', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user) {
        await ctx.answerCbQuery('Нет доступа');
        return;
    }

    contextLimitFlows.set(userId, 'await_limit');
    await ctx.answerCbQuery('Ожидаю число');
    const maxTokens = (user.max_context_tokens_limit ?? 0) > 0
        ? Math.floor(user.max_context_tokens_limit!) : getPlanMaxContextTokens(parsePlanFromDb(user.plan));
    await ctx.reply(
        `Введите лимит контекста в токенах (например: 30000).\nСейчас: ${(resolveMaxContextTokens(user) / 1000).toFixed(0)}k\nМаксимум для тарифа: ${(maxTokens / 1000).toFixed(0)}k\nДля отмены: "отмена".`
    );
});

bot.action('context:back', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) contextLimitFlows.delete(userId);
    await ctx.answerCbQuery();
    await showMenu(ctx);
});

bot.action(/^mod:pp:(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery('Только для админа');
        return;
    }

    const page = Number.parseInt((ctx as any).match[1], 10);
    await renderPendingList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
    await ctx.answerCbQuery();
});

bot.action('mail:setup_help', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Команда: /mail_setup <yandex|google> <email> <пароль_приложения>\nили: /mail_setup <email> <пароль_приложения>\nПереключение активного: /mail_use <yandex|google>\nУдаление: /mail_forget [yandex|google]');
});

bot.action('mail:settings', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user) {
        await ctx.answerCbQuery('Нет доступа');
        return;
    }
    await ctx.answerCbQuery();
    const current = user.mail_check_limit || DEFAULT_MAIL_CHECK_LIMIT;
    const capText = user.role === 'admin' ? 'без ограничения' : 'до 10';
    await ctx.reply(`⚙️ Почта: настройки\nТекущее ограничение check_emails: ${current}\nВам доступно: ${capText}`, buildMailSettingsKeyboard());
});

bot.action('mail:limit:change', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user) {
        await ctx.answerCbQuery('Нет доступа');
        return;
    }

    mailLimitFlows.set(userId, 'await_limit');
    await ctx.answerCbQuery('Ожидаю число');
    await ctx.reply('Введите новое ограничение для check_emails одним числом.');
});

bot.action('mail:settings:back', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) mailLimitFlows.delete(userId);
    await ctx.answerCbQuery();
    await ctx.reply('📬 Управление почтой\nВыбери действие:', buildMailMenuKeyboard());
});

bot.action('mail:instr:yandex', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Яндекс:\n1) Открой Yandex ID → Безопасность.\n2) Создай "Пароль приложения" для почты.\n3) Выполни: /mail_setup yandex <email> <пароль_приложения>.');
});

bot.action('mail:instr:google', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Google:\n1) Включи 2FA в аккаунте.\n2) Создай App Password для Mail.\n3) Выполни: /mail_setup google <email> <app_password>.');
});

bot.action('mail:forget', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    try { await runBackendMailForget(userId); } catch {}
    clearUserMailSettings(userId);
    await ctx.answerCbQuery('Почта удалена');
    await ctx.reply('🗑 Данные почты удалены.');
});

bot.action(/^notes:list:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        await ctx.answerCbQuery('Нет доступа');
        return;
    }
    const page = Number.parseInt((ctx as any).match[1], 10);
    await ctx.answerCbQuery();
    await renderNotesMenuList(ctx, userId, Number.isNaN(page) ? 0 : page, 'edit');
});

bot.action(/^notes:view:(\d+):(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        await ctx.answerCbQuery('Нет доступа');
        return;
    }
    const noteId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    await ctx.answerCbQuery();
    if (Number.isNaN(noteId) || noteId <= 0) {
        await ctx.reply('Некорректный ID заметки.');
        return;
    }
    await renderNoteView(ctx, userId, noteId, Number.isNaN(page) ? 0 : page, 'edit');
});

bot.action(/^notes:edit:(\d+):(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        await ctx.answerCbQuery('Нет доступа');
        return;
    }
    const noteId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    if (Number.isNaN(noteId) || noteId <= 0) {
        await ctx.answerCbQuery('Некорректный ID');
        return;
    }
    const note = getNoteByUserAndId(userId, noteId);
    if (!note) {
        await ctx.answerCbQuery('Заметка не найдена');
        return;
    }
    noteEditFlows.set(userId, { noteId, page: Number.isNaN(page) ? 0 : page });
    await ctx.answerCbQuery('Ожидаю текст');
    await ctx.reply(`Введите новый текст для заметки #${noteId}.\nЛимит по вашему плану: ${getPlanNoteContentLimit(parsePlanFromDb(user.plan))} символов.\nДля отмены: "отмена".`);
});

bot.action(/^notes:delete:(\d+):(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        await ctx.answerCbQuery('Нет доступа');
        return;
    }
    const noteId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const safePage = Number.isNaN(page) ? 0 : page;
    if (Number.isNaN(noteId) || noteId <= 0) {
        await ctx.answerCbQuery('Некорректный ID');
        return;
    }
    const note = getNoteByUserAndId(userId, noteId);
    if (!note) {
        await ctx.answerCbQuery('Уже удалена');
        await renderNotesMenuList(ctx, userId, safePage, 'edit');
        return;
    }
    const deleted = deleteNoteByUserAndId(userId, noteId);
    if (!deleted.changes) {
        await ctx.answerCbQuery('Не удалось удалить');
        return;
    }
    const totalAfter = countNotes(userId);
    const maxPage = Math.max(0, Math.ceil(totalAfter / NOTES_MENU_PAGE_SIZE) - 1);
    const nextPage = Math.min(safePage, maxPage);
    await ctx.answerCbQuery('Удалено');
    await renderNotesMenuList(ctx, userId, nextPage, 'edit');
});

bot.action('notes:back:menu', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) noteEditFlows.delete(userId);
    await ctx.answerCbQuery();
    await showMenu(ctx);
});

bot.action(/^mod:pv:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery('Только для админа');
        return;
    }

    const userId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const user = await getUser(userId);
    if (!user || user.status !== 'none') {
        await ctx.answerCbQuery('Заявка уже обработана');
        await renderPendingList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
        return;
    }

    await renderPendingCard(ctx, user, Number.isNaN(page) ? 0 : page, 'edit');
    await ctx.answerCbQuery();
});

bot.action(/^mod:ok:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery('Только для админа');
        return;
    }

    const targetUserId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const ok = await approveUserAccess(targetUserId);
    if (!ok) {
        await ctx.answerCbQuery('Пользователь не найден');
        return;
    }

    try {
        await bot.telegram.sendMessage(targetUserId, '✅ Доступ подтверждён. Можешь писать боту.');
    } catch (err) {
        console.warn(`Не удалось отправить уведомление пользователю ${targetUserId}`);
    }

    await renderPendingList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
    await ctx.answerCbQuery('Подтверждено');
});

bot.action(/^mod:no:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery('Только для админа');
        return;
    }

    const targetUserId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const ok = await disapproveUserAccess(targetUserId);
    if (!ok) {
        await ctx.answerCbQuery('Пользователь не найден');
        return;
    }

    try {
        await bot.telegram.sendMessage(targetUserId, '❌ Заявка отклонена администратором.');
    } catch (err) {
        console.warn(`Не удалось отправить уведомление пользователю ${targetUserId}`);
    }

    await renderPendingList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
    await ctx.answerCbQuery('Отклонено');
});

bot.action(/^mod:ban:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery('Только для админа');
        return;
    }

    const adminId = ctx.from?.id;
    if (!adminId) return;
    const targetUserId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);

    const ok = await banUserAccess(targetUserId, adminId, 'Решение администратора');
    if (!ok) {
        await ctx.answerCbQuery('Пользователь не найден');
        return;
    }

    try {
        await bot.telegram.sendMessage(targetUserId, '🚫 Доступ заблокирован администратором.');
    } catch (err) {
        console.warn(`Не удалось отправить уведомление пользователю ${targetUserId}`);
    }

    await renderPendingList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
    await ctx.answerCbQuery('Пользователь забанен');
});

bot.action(/^mod:bp:(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery('Только для админа');
        return;
    }

    const page = Number.parseInt((ctx as any).match[1], 10);
    await renderBannedList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
    await ctx.answerCbQuery();
});

bot.action(/^mod:bv:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery('Только для админа');
        return;
    }

    const userId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const user = await getUser(userId);
    if (!user || user.status !== 'banned') {
        await ctx.answerCbQuery('Пользователь уже не в бане');
        await renderBannedList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
        return;
    }

    await renderBannedCard(ctx, user, Number.isNaN(page) ? 0 : page, 'edit');
    await ctx.answerCbQuery();
});

bot.action(/^mod:unban:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery('Только для админа');
        return;
    }

    const targetUserId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const ok = await unbanUserAccess(targetUserId);
    if (!ok) {
        await ctx.answerCbQuery('Пользователь не найден');
        return;
    }

    try {
        await bot.telegram.sendMessage(targetUserId, '✅ Блокировка снята. Заявка снова в ожидании подтверждения.');
    } catch (err) {
        console.warn(`Не удалось отправить уведомление пользователю ${targetUserId}`);
    }

    await renderBannedList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
    await ctx.answerCbQuery('Разблокирован');
});

bot.action(/^usr:list:(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery('Только для админа');
        return;
    }

    const page = Number.parseInt((ctx as any).match[1], 10);
    await renderAdminUsersList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
    await ctx.answerCbQuery();
});

bot.action(/^usr:view:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery('Только для админа');
        return;
    }

    const userId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const user = await getUser(userId);
    if (!user) {
        await ctx.answerCbQuery('Пользователь не найден');
        await renderAdminUsersList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
        return;
    }

    await renderAdminUserCard(ctx, user, Number.isNaN(page) ? 0 : page, 'edit');
    await ctx.answerCbQuery();
});

bot.action(/^usr:plan:open:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery('Только для админа');
        return;
    }

    const userId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const user = await getUser(userId);
    if (!user) {
        await ctx.answerCbQuery('Пользователь не найден');
        await renderAdminUsersList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
        return;
    }

    await renderAdminPlanChoiceCard(ctx, user, Number.isNaN(page) ? 0 : page, 'edit');
    await ctx.answerCbQuery();
});

bot.action(/^usr:plan:pick:(\d+):(\d+):(free|standart|pro)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery('Только для админа');
        return;
    }

    const userId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const plan = (ctx as any).match[3] as UserPlan;
    const user = await getUser(userId);
    if (!user) {
        await ctx.answerCbQuery('Пользователь не найден');
        await renderAdminUsersList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
        return;
    }

    await renderAdminPlanDurationCard(ctx, user, Number.isNaN(page) ? 0 : page, plan, 'edit');
    await ctx.answerCbQuery();
});

bot.action(/^usr:plan:dur:(\d+):(\d+):(free|standart|pro):(day|week|month|year|forever)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery('Только для админа');
        return;
    }

    const adminId = ctx.from?.id;
    if (!adminId) return;
    const userId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const plan = (ctx as any).match[3] as UserPlan;
    const duration = (ctx as any).match[4] as PlanDurationCode;
    const user = await getUser(userId);
    if (!user) {
        await ctx.answerCbQuery('Пользователь не найден');
        await renderAdminUsersList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
        return;
    }

    const endsAt = getEndsAtForDuration(duration);
    await applyUserPlan(userId, plan, endsAt, adminId);
    await trimUserHistory(userId);
    const refreshed = await getUser(userId);
    if (!refreshed) {
        await ctx.answerCbQuery('Ошибка обновления');
        return;
    }

    await renderAdminUserCard(ctx, refreshed, Number.isNaN(page) ? 0 : page, 'edit');
    await ctx.answerCbQuery(`План ${getPlanLabel(plan)} на ${getDurationLabel(duration)}`);
});

bot.action(/^usr:ctx:ask:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery('Только для админа');
        return;
    }

    const adminId = ctx.from?.id;
    if (!adminId) return;
    const targetUserId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const user = await getUser(targetUserId);
    if (!user) {
        await ctx.answerCbQuery('Пользователь не найден');
        return;
    }

    adminUserContextLimitFlows.set(adminId, { targetUserId, page: Number.isNaN(page) ? 0 : page });
    await ctx.answerCbQuery('Ожидаю число');
    const maxTokens = (user.max_context_tokens_limit ?? 0) > 0
        ? Math.floor(user.max_context_tokens_limit!) : getPlanMaxContextTokens(parsePlanFromDb(user.plan));
    await ctx.reply(
        `Введите лимит контекста в токенах для пользователя #${targetUserId}.\nСейчас: ${(resolveMaxContextTokens(user) / 1000).toFixed(0)}k\nМаксимум по тарифу: ${(maxTokens / 1000).toFixed(0)}k\nДля админа ограничений нет.\nДля отмены: "отмена".`
    );
});

bot.action(/^usr:msg:ask:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery('Только для админа');
        return;
    }

    const adminId = ctx.from?.id;
    if (!adminId) return;
    const targetUserId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const user = await getUser(targetUserId);
    if (!user) {
        await ctx.answerCbQuery('Пользователь не найден');
        return;
    }

    adminUserMessageLimitFlows.set(adminId, { targetUserId, page: Number.isNaN(page) ? 0 : page });
    await ctx.answerCbQuery('Ожидаю число');
    await ctx.reply(
        `Введите лимит сообщений в день для пользователя #${targetUserId}.\nТекущий: безлимит\nСегодня отправлено: ${user.daily_message_count ?? 0}\n0 = безлимит.\nДля отмены: "отмена".`
    );
});

bot.action(/^usr:ban:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery('Только для админа');
        return;
    }
    const adminId = ctx.from?.id;
    if (!adminId) return;

    const targetUserId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const user = await getUser(targetUserId);
    if (!user) {
        await ctx.answerCbQuery('Пользователь не найден');
        return;
    }
    if (ADMIN_IDS.has(targetUserId) || user.role === 'admin') {
        await ctx.answerCbQuery('Нельзя банить админа');
        return;
    }

    await banUserAccess(targetUserId, adminId, 'Решение администратора');
    const refreshed = await getUser(targetUserId);
    if (refreshed) await renderAdminUserCard(ctx, refreshed, Number.isNaN(page) ? 0 : page, 'edit');

    bot.telegram.sendMessage(targetUserId, '🚫 Доступ заблокирован администратором.').catch(() => undefined);
    await ctx.answerCbQuery('Пользователь забанен');
});

bot.action(/^usr:unban:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery('Только для админа');
        return;
    }

    const targetUserId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const user = await getUser(targetUserId);
    if (!user) {
        await ctx.answerCbQuery('Пользователь не найден');
        return;
    }
    if (user.status !== 'banned') {
        await ctx.answerCbQuery('Он не в бане');
        return;
    }

    await unbanUserAccess(targetUserId);
    const refreshed = await getUser(targetUserId);
    if (refreshed) await renderAdminUserCard(ctx, refreshed, Number.isNaN(page) ? 0 : page, 'edit');

    bot.telegram.sendMessage(targetUserId, '✅ Блокировка снята. Заявка снова в ожидании подтверждения.').catch(() => undefined);
    await ctx.answerCbQuery('Разбанен');
});

bot.action(/^usr:remove:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery('Только для админа');
        return;
    }

    const targetUserId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const user = await getUser(targetUserId);
    if (!user) {
        await ctx.answerCbQuery('Пользователь уже удален');
        await renderAdminUsersList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
        return;
    }
    if (ADMIN_IDS.has(targetUserId) || user.role === 'admin') {
        await ctx.answerCbQuery('Нельзя удалить админа');
        return;
    }

    await removeUser(targetUserId);
    removeBan(targetUserId);
    clearUserHistory(targetUserId);
    await renderAdminUsersList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
    await ctx.answerCbQuery('Пользователь удален');
});

bot.action(/^ai_send:(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery('Только для админа');
        return;
    }

    const adminId = ctx.from?.id;
    if (!adminId) return;

    const targetId = Number.parseInt((ctx as any).match[1], 10);
    const targetUser = await getUser(targetId);
    if (!targetUser) {
        await ctx.answerCbQuery();
        await ctx.reply('Юзер не найден в базе.');
        return;
    }

    adminAiMessageFlow.set(adminId, targetId);
    await ctx.answerCbQuery('Ожидаю текст');
    await ctx.reply(
        `Что ИИ должен передать пользователю *${targetUser.name || targetUser.tg_username || targetId}*?\nНапиши суть сообщения, а нейросеть сама оформит его в своём стиле.`,
        { parse_mode: 'Markdown' }
    );
});

bot.action('prompt:list', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = await getUser(userId);
    if (!user) {
        await ctx.answerCbQuery('Нет доступа');
        return;
    }

    if (ctx.state.role === 'admin') {
        await ctx.answerCbQuery('Для админа используйте /prompts');
        return;
    }

    await renderPromptListInteractive(ctx, user, 'edit');
    await ctx.answerCbQuery();
});

bot.action('prompt:custom:view', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = await getUser(userId);
    if (!user) {
        await ctx.answerCbQuery('Нет доступа');
        return;
    }

    if (ctx.state.role === 'admin') {
        await ctx.answerCbQuery('Для админа используйте /prompt_set');
        return;
    }

    await renderCustomPromptCardInteractive(ctx, user, 'edit');
    await ctx.answerCbQuery();
});

bot.action('prompt:custom:use', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = await getUser(userId);
    if (!user) {
        await ctx.answerCbQuery('Нет доступа');
        return;
    }
    if (ctx.state.role === 'admin') {
        await ctx.answerCbQuery('Недоступно');
        return;
    }

    const customContent = (user.custom_prompt_content || '').trim();
    if (!customContent) {
        customPromptEditFlows.set(userId, 'await_content');
        await ctx.answerCbQuery('Нужно создать текст');
        await ctx.reply(`Введи текст кастомного промпта (до ${MAX_CUSTOM_PROMPT_LENGTH} символов).`);
        return;
    }

    await selectUserCustomPrompt(userId);
    await runBackendSelectUserPrompt(userId, -1);
    const refreshed = await getUser(userId);
    if (!refreshed) {
        await ctx.answerCbQuery('Ошибка профиля');
        return;
    }
    await renderCustomPromptCardInteractive(ctx, refreshed, 'edit');
    await ctx.answerCbQuery('Кастомный промпт выбран');
});

bot.action('prompt:custom:edit', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user) {
        await ctx.answerCbQuery('Нет доступа');
        return;
    }
    if (ctx.state.role === 'admin') {
        await ctx.answerCbQuery('Недоступно');
        return;
    }

    customPromptEditFlows.set(userId, 'await_content');
    await ctx.answerCbQuery('Ожидаю текст');
    const currentText = getCustomPromptPreview(user.custom_prompt_content, 280);
    await ctx.reply(`Текущий кастомный промпт:\n${currentText}\n\nОтправь новый текст (до ${MAX_CUSTOM_PROMPT_LENGTH} символов).`);
});

bot.action('prompt:custom:keep', async (ctx) => {
    await ctx.answerCbQuery('Оставляем текущий кастомный промпт');
});

bot.action(/^prompt:view:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = await getUser(userId);
    if (!user) {
        await ctx.answerCbQuery('Нет доступа');
        return;
    }

    if (ctx.state.role === 'admin') {
        await ctx.answerCbQuery('Для админа используйте /prompt_show <id>');
        return;
    }

    const promptId = Number.parseInt((ctx as any).match[1], 10);
    let prompt;
    try {
        const data = await runBackendGetPrompt(promptId);
        prompt = data.prompt;
    } catch {
        await ctx.answerCbQuery('Промпт не найден');
        return;
    }

    await renderPromptCardInteractive(ctx, user, prompt);
    await ctx.answerCbQuery();
});

bot.action(/^prompt:use:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = await getUser(userId);
    if (!user) {
        await ctx.answerCbQuery('Нет доступа');
        return;
    }

    if (ctx.state.role === 'admin') {
        await ctx.answerCbQuery('Для админа используйте /prompt_default или /prompt_use');
        return;
    }

    const promptId = Number.parseInt((ctx as any).match[1], 10);
    let prompt;
    try {
        const data = await runBackendGetPrompt(promptId);
        prompt = data.prompt;
    } catch {
        await ctx.answerCbQuery('Промпт не найден');
        return;
    }

    await runBackendSelectUserPrompt(userId, promptId);
    await updateUserPrompt(userId, promptId);
    const refreshedUser = await getUser(userId);
    if (!refreshedUser) {
        await ctx.answerCbQuery('Ошибка профиля');
        return;
    }

    await renderPromptCardInteractive(ctx, refreshedUser, prompt);
    await ctx.answerCbQuery('Промпт выбран');
});

bot.action(/^prompt:noop:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery('Этот промпт уже выбран');
});

bot.action('prompt:cancel', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) {
        customPromptEditFlows.delete(userId);
    }
    await ctx.editMessageText('Выбор промпта отменён.');
    await ctx.answerCbQuery();
});

// ── Model selector callbacks ─────────────────────────────────────────────────

bot.action(/^model:select:(.+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const rawId = (ctx as any).match[1] as string;
    const modelId = rawId === 'auto' ? null : rawId;
    try {
        await runBackendSetPreferredModel(userId, modelId);
        const label = modelId || 'Авто';
        await ctx.editMessageText(`🤖 Модель изменена на: ${label}`);
        await ctx.answerCbQuery(`Модель: ${label}`);
    } catch {
        await ctx.answerCbQuery('Ошибка при смене модели');
    }
});

bot.action('model:cancel', async (ctx) => {
    await ctx.editMessageText('Выбор модели отменён.');
    await ctx.answerCbQuery();
});

// Store full commands by confirmationId — Telegram message text loses Markdown backticks
const pendingPcCommandTexts = new Map<string, string>();

type PendingRejectionComment = {
    endpoint: string;
    confirmationId: string;
    label: string;
};

const pendingRejectionComments = new Map<number, PendingRejectionComment>();

const requestRejectionComment = async (
    ctx: any,
    endpoint: string,
    confirmationId: string,
    label: string,
) => {
    const userId = ctx.from?.id;
    if (!userId) {
        await ctx.answerCbQuery('Ошибка');
        return;
    }
    pendingRejectionComments.set(userId, { endpoint, confirmationId, label });
    await ctx.answerCbQuery('Жду комментарий');
    await ctx.reply(`Напиши комментарий для отклонения: ${label}\n\nНапример: "не тот файл" или "сначала покажи diff". Для отмены: /cancel`);
};

const rejectWithOptionalComment = async (
    endpoint: string,
    confirmationId: string,
    userId: number,
    rejectionComment = '',
) => axios.post(
    `${BACKEND_API_BASE_URL}${endpoint}`,
    {
        confirmation_id: confirmationId,
        approved: false,
        user_id: userId,
        ...(rejectionComment.trim() ? { rejection_comment: rejectionComment.trim() } : {}),
    },
    { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` }, timeout: 15000 }
);

// ── PC Command Confirmation (Telegram inline buttons) ─────────────────────

bot.action(/^pcconfirm:(allow|always|review|reject|reject_comment):(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const confirmationId = ctx.match[2];
    const userId = ctx.from?.id;

    if (!userId) {
        await ctx.answerCbQuery('Ошибка: пользователь не определён.');
        return;
    }

    // Answer callback query immediately — Telegram requires it within ~15s
    if (action === 'reject') {
        await ctx.answerCbQuery('Отклонено');
        try {
            await rejectWithOptionalComment('/internal/pc-commands/approve', confirmationId, userId);
            await ctx.editMessageText('❌ Команда отклонена.');
        } catch {
            await ctx.editMessageText('⚠️ Не удалось отклонить (истёк таймаут?).').catch(() => {});
        }
        return;
    }

    if (action === 'reject_comment') {
        const cmd = pendingPcCommandTexts.get(confirmationId) || 'команды на ПК';
        await requestRejectionComment(ctx, '/internal/pc-commands/approve', confirmationId, cmd.slice(0, 120));
        return;
    }

    if (action === 'allow') {
        await ctx.answerCbQuery('Выполняю...');
        // Run in background — don't block Telegraf
        (async () => {
            try {
                const resp = await axios.post(
                    `${BACKEND_API_BASE_URL}/internal/pc-commands/approve`,
                    { confirmation_id: confirmationId, approved: true, user_id: userId },
                    { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` }, timeout: 120000 }
                );
                const output = typeof resp.data?.result === 'string' ? resp.data.result : '';
                const preview = output.slice(0, 500) || '(нет вывода)';
                await ctx.editMessageText(`✅ Команда выполнена.\n\n\`\`\`\n${preview.replace(/```/g, "'''")}\n\`\`\``, { parse_mode: 'Markdown' }).catch(() => {
                    ctx.editMessageText(`✅ Команда выполнена.\n\n${preview}`).catch(() => {});
                });
            } catch (err: any) {
                const msg = err?.response?.data?.error || err?.message || ' неизвестная ошибка';
                await ctx.editMessageText(`⚠️ Ошибка выполнения: ${msg}`).catch(() => {});
            }
        })();
        return;
    }

    if (action === 'always') {
        // Confirm: "Are you sure?"
        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback('✅ Да, разрешить всегда', `pcconfirm:always_confirm:${confirmationId}`),
                Markup.button.callback('⬅️ Назад', `pcconfirm:always_cancel:${confirmationId}`),
            ]
        ]);
        await ctx.editMessageText('⚠️ Создать постоянное правило для этой команды? Действие нельзя отменить.', keyboard);
        await ctx.answerCbQuery();
        return;
    }

    if (action === 'review') {
        await ctx.answerCbQuery('Отправляю на проверку...');
        // Run in background
        (async () => {
            try {
                const cmd = pendingPcCommandTexts.get(confirmationId) || '(неизвестная команда)';

                const liteResp = await axios.post(
                    `${BACKEND_API_BASE_URL}/internal/ai/lite`,
                    {
                        text: `Оцени безопасность следующей команды для выполнения на ПК пользователя. Кратко объясни риски (1-2 предложения). Команда: ${cmd}`,
                    },
                    { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` }, timeout: 30000 }
                );
                const verdict = liteResp.data?.reply_text || liteResp.data?.text || '(нет ответа)';
                await ctx.reply(`🔍 Проверка AI:\n\n${verdict}\n\n⬆️ Кнопки подтверждения выше остаются активными.`);
            } catch (err: any) {
                const msg = err?.message || 'ошибка';
                await ctx.reply(`Не удалось проверить команду: ${msg}\n\n⬆️ Кнопки подтверждения выше остаются активными.`).catch(() => {});
            }
        })();
        return;
    }
});

// "Always" confirmation sub-flow
bot.action(/^pcconfirm:always_confirm:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    const userId = ctx.from?.id;
    if (!userId) {
        await ctx.answerCbQuery('Ошибка');
        return;
    }

    await ctx.answerCbQuery('Выполняю...');

    // Run in background — don't block Telegraf
    (async () => {
        try {
            const cmd = pendingPcCommandTexts.get(confirmationId) || '';

            if (cmd) {
                try {
                    await axios.post(
                        `${BACKEND_API_BASE_URL}/internal/pc-commands/policies`,
                        { user_id: userId, pattern: '^' + cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$' },
                        { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` }, timeout: 10000 }
                    );
                } catch {
                    // Non-critical
                }
            }

            const resp = await axios.post(
                `${BACKEND_API_BASE_URL}/internal/pc-commands/approve`,
                { confirmation_id: confirmationId, approved: true, user_id: userId },
                { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` }, timeout: 120000 }
            );
            const output = typeof resp.data?.result === 'string' ? resp.data.result : '';
            const preview = output.slice(0, 500) || '(нет вывода)';
            await ctx.editMessageText(`🔓 Разрешено всегда + команда выполнена.\n\n\`\`\`\n${preview.replace(/```/g, "'''")}\n\`\`\``, { parse_mode: 'Markdown' }).catch(() => {
                ctx.editMessageText(`🔓 Разрешено всегда + команда выполнена.\n\n${preview}`).catch(() => {});
            });
            // answerCbQuery already sent above
        } catch (err: any) {
            const msg = err?.response?.data?.error || err?.message || ' неизвестная ошибка';
            await ctx.editMessageText(`⚠️ Ошибка: ${msg}`).catch(() => {});
        }
    })();
});

bot.action(/^pcconfirm:always_cancel:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    const cmd = pendingPcCommandTexts.get(confirmationId) || '';
    const preview = cmd.slice(0, 200);
    const keyboard = Markup.inlineKeyboard([
        [
            Markup.button.callback('✅ Разрешить', `pcconfirm:allow:${confirmationId}`),
            Markup.button.callback('🔓 Разрешить всегда', `pcconfirm:always:${confirmationId}`),
        ],
        [
            Markup.button.callback('❓ Проверить', `pcconfirm:review:${confirmationId}`),
            Markup.button.callback('❌ Отклонить', `pcconfirm:reject:${confirmationId}`),
            Markup.button.callback('💬 Отклонить с комментарием', `pcconfirm:reject_comment:${confirmationId}`),
        ]
    ]);
    const escapedPreview = preview.replace(/`/g, '\\`');
    await ctx.editMessageText(`🔐 Подтверждение команды на ПК\n\n\`${escapedPreview}\`\n\nРазрешить выполнение?`, { parse_mode: 'Markdown', ...keyboard }).catch(() => {
        ctx.editMessageText(`🔐 Подтверждение команды на ПК\n\n${preview}\n\nРазрешить выполнение?`, keyboard).catch(() => {});
    });
    await ctx.answerCbQuery();
});

// ── File Action Confirmation (Telegram inline buttons) ────────────────────

bot.action(/^fileconfirm:(allow|reject|reject_comment):(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const confirmationId = ctx.match[2];
    const userId = ctx.from?.id;

    if (!userId) {
        await ctx.answerCbQuery('Ошибка: пользователь не определён.');
        return;
    }

    if (action === 'reject') {
        await ctx.answerCbQuery('Отклонено');
        try {
            await rejectWithOptionalComment('/internal/pc-commands/approve', confirmationId, userId);
            await ctx.editMessageText('❌ Действие с файлом отклонено.');
        } catch {
            await ctx.editMessageText('⚠️ Не удалось отклонить (истёк таймаут?).').catch(() => {});
        }
        return;
    }

    if (action === 'reject_comment') {
        await requestRejectionComment(ctx, '/internal/pc-commands/approve', confirmationId, 'действия с файлом');
        return;
    }

    // action === 'allow'
    await ctx.answerCbQuery('Выполняю...');
    (async () => {
        try {
            const resp = await axios.post(
                `${BACKEND_API_BASE_URL}/internal/pc-commands/approve`,
                { confirmation_id: confirmationId, approved: true, user_id: userId },
                { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` }, timeout: 120000 }
            );
            const result = resp.data?.result;
            // For read_file — show content preview; for write_file — show success
            if (result && typeof result === 'object' && result.content) {
                const contentPreview = typeof result.content === 'string' ? result.content.slice(0, 3000) : '';
                const linesInfo = result.total_lines ? `\nВсего строк: ${result.total_lines}` : '';
                await ctx.editMessageText(`✅ Файл прочитан.${linesInfo}\n\n\`\`\`\n${contentPreview.replace(/```/g, "'''")}\n\`\`\``, { parse_mode: 'Markdown' }).catch(() => {
                    ctx.editMessageText(`✅ Файл прочитан.${linesInfo}\n\n${contentPreview}`).catch(() => {});
                });
            } else {
                await ctx.editMessageText('✅ Файл записан.').catch(() => {});
            }
        } catch (err: any) {
            const msg = err?.response?.data?.error || err?.message || 'неизвестная ошибка';
            await ctx.editMessageText(`⚠️ Ошибка: ${msg}`).catch(() => {});
        }
    })();
});

// ── Visual Click Confirmation (Telegram inline buttons) ───────────────────

bot.action(/^vclick:(allow|reject):(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const confirmationId = ctx.match[2];
    const userId = ctx.from?.id;

    if (!userId) {
        await ctx.answerCbQuery('Ошибка: пользователь не определён.');
        return;
    }

    if (action === 'reject') {
        await ctx.answerCbQuery('Отклонено');
        try {
            await axios.post(
                `${BACKEND_API_BASE_URL}/internal/visual-click/approve`,
                { confirmation_id: confirmationId, approved: false, user_id: userId },
                { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` }, timeout: 15000 }
            );
            await ctx.editMessageText('❌ Клик отменён.');
        } catch {
            await ctx.editMessageText('⚠️ Не удалось отклонить (истёк таймаут?).').catch(() => {});
        }
        return;
    }

    // action === 'allow'
    await ctx.answerCbQuery('Кликаю...');
    (async () => {
        try {
            const resp = await axios.post(
                `${BACKEND_API_BASE_URL}/internal/visual-click/approve`,
                { confirmation_id: confirmationId, approved: true, user_id: userId },
                { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` }, timeout: 30000 }
            );
            const data = resp.data?.result;
            if (data?.status === 'ok') {
                await ctx.editMessageText(`✅ Клик выполнен (${data.x}, ${data.y})`).catch(() => {});
            } else {
                await ctx.editMessageText('✅ Клик выполнен.').catch(() => {});
            }
        } catch (err: any) {
            const msg = err?.response?.data?.error || err?.message || 'неизвестная ошибка';
            await ctx.editMessageText(`⚠️ Ошибка клика: ${msg}`).catch(() => {});
        }
    })();
});

// ── DevOps SSH Confirmation (Telegram inline buttons) ─────────────────────

bot.action(/^devops:allow:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    const userId = ctx.from?.id;
    if (!userId) {
        await ctx.answerCbQuery('Ошибка');
        return;
    }
    await ctx.answerCbQuery('Выполняю SSH...');
    (async () => {
        try {
            const resp = await axios.post(
                `${BACKEND_API_BASE_URL}/internal/devops/approve`,
                { confirmation_id: confirmationId, approved: true, user_id: userId },
                { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` }, timeout: 120000 }
            );
            const result = resp.data?.result;
            const stdout = result?.stdout || '';
            const stderr = result?.stderr || '';
            const exitCode = result?.exit_code;
            let output = '';
            if (stdout) output += stdout.slice(0, 800);
            if (stderr) output += (output ? '\n' : '') + stderr.slice(0, 400);
            if (!output) output = `(нет вывода, exit_code=${exitCode ?? '?'})`;
            await ctx.editMessageText(`✅ SSH выполнен.\n\n\`\`\`\n${output.replace(/```/g, "'''")}\n\`\`\``, { parse_mode: 'Markdown' }).catch(() => {
                ctx.editMessageText(`✅ SSH выполнен.\n\n${output}`).catch(() => {});
            });
        } catch (err: any) {
            const msg = err?.response?.data?.error || err?.message || 'неизвестная ошибка';
            await ctx.editMessageText(`⚠️ Ошибка SSH: ${msg}`).catch(() => {});
        }
    })();
});

bot.action(/^devops:reject:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    const userId = ctx.from?.id;
    if (!userId) {
        await ctx.answerCbQuery('Ошибка');
        return;
    }
    await ctx.answerCbQuery('Отклонено');
    try {
        await rejectWithOptionalComment('/internal/devops/approve', confirmationId, userId);
        await ctx.editMessageText('❌ SSH команда отклонена.');
    } catch {
        await ctx.editMessageText('⚠️ Не удалось отклонить (истёк таймаут?).').catch(() => {});
    }
});

bot.action(/^devops:reject_comment:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    const cmd = pendingPcCommandTexts.get(`devops:${confirmationId}`) || 'SSH команды';
    await requestRejectionComment(ctx, '/internal/devops/approve', confirmationId, cmd.slice(0, 120));
});

bot.action(/^email:allow:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    const userId = ctx.from?.id;
    if (!userId) {
        await ctx.answerCbQuery('Ошибка');
        return;
    }
    await ctx.answerCbQuery('Отправляю...');
    (async () => {
        try {
            const resp = await axios.post(
                `${BACKEND_API_BASE_URL}/internal/email/approve`,
                { confirmation_id: confirmationId, approved: true, user_id: userId },
                { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` }, timeout: 60000 }
            );
            const result = typeof resp.data?.result === 'string' ? resp.data.result : '';
            await ctx.editMessageText(`✅ Письмо отправлено.\n${result ? `\n${result}` : ''}`).catch(() => {});
        } catch (err: any) {
            const msg = err?.response?.data?.error || err?.message || 'неизвестная ошибка';
            await ctx.editMessageText(`⚠️ Ошибка отправки письма: ${msg}`).catch(() => {});
        }
    })();
});

bot.action(/^email:reject:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    const userId = ctx.from?.id;
    if (!userId) {
        await ctx.answerCbQuery('Ошибка');
        return;
    }
    await ctx.answerCbQuery('Отклонено');
    try {
        await rejectWithOptionalComment('/internal/email/approve', confirmationId, userId);
        await ctx.editMessageText('❌ Отправка письма отклонена.');
    } catch {
        await ctx.editMessageText('⚠️ Не удалось отклонить (истёк таймаут?).').catch(() => {});
    }
});

bot.action(/^email:reject_comment:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    await requestRejectionComment(ctx, '/internal/email/approve', confirmationId, 'отправки письма');
});

bot.action(/^devops:always:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    const userId = ctx.from?.id;
    if (!userId) {
        await ctx.answerCbQuery('Ошибка');
        return;
    }
    // Confirm: "Are you sure?"
    const keyboard = Markup.inlineKeyboard([
        [
            Markup.button.callback('✅ Да, разрешить всегда', `devops:always_confirm:${confirmationId}`),
            Markup.button.callback('⬅️ Назад', `devops:always_cancel:${confirmationId}`),
        ]
    ]);
    await ctx.editMessageText('⚠️ Создать постоянное правило для этой SSH команды?', keyboard);
    await ctx.answerCbQuery();
});

bot.action(/^devops:always_confirm:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    const userId = ctx.from?.id;
    if (!userId) {
        await ctx.answerCbQuery('Ошибка');
        return;
    }
    await ctx.answerCbQuery('Выполняю...');
    (async () => {
        try {
            const cmd = pendingPcCommandTexts.get(`devops:${confirmationId}`) || '';
            const serverId = pendingPcCommandTexts.get(`devops_server:${confirmationId}`) || '';
            if (cmd && serverId) {
                const escapedCmd = cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                await axios.post(
                    `${BACKEND_API_BASE_URL}/internal/devops/servers/${serverId}/policies`,
                    { user_id: userId, pattern: `^${escapedCmd}$`, auto_approve: true },
                    { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` }, timeout: 10000 }
                );
            }
            const resp = await axios.post(
                `${BACKEND_API_BASE_URL}/internal/devops/approve`,
                { confirmation_id: confirmationId, approved: true, user_id: userId },
                { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` }, timeout: 120000 }
            );
            const result = resp.data?.result;
            const stdout = result?.stdout || '';
            const stderr = result?.stderr || '';
            let output = '';
            if (stdout) output += stdout.slice(0, 800);
            if (stderr) output += (output ? '\n' : '') + stderr.slice(0, 400);
            if (!output) output = '(нет вывода)';
            await ctx.editMessageText(`🔓 Разрешено всегда + SSH выполнен.\n\n\`\`\`\n${output.replace(/```/g, "'''")}\n\`\`\``, { parse_mode: 'Markdown' }).catch(() => {
                ctx.editMessageText(`🔓 Разрешено всегда + SSH выполнен.\n\n${output}`).catch(() => {});
            });
        } catch (err: any) {
            const msg = err?.response?.data?.error || err?.message || 'ошибка';
            await ctx.editMessageText(`⚠️ Ошибка: ${msg}`).catch(() => {});
        }
    })();
});

bot.action(/^devops:always_cancel:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    // Just go back — re-show would need original text, just leave as is
    await ctx.editMessageText('↩️ Возвращены кнопки подтверждения.').catch(() => {});
});

bot.action(/^devops:review:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    const userId = ctx.from?.id;
    if (!userId) {
        await ctx.answerCbQuery('Ошибка');
        return;
    }
    await ctx.answerCbQuery('Отправляю на проверку...');
    (async () => {
        try {
            const cmd = pendingPcCommandTexts.get(`devops:${confirmationId}`) || '(неизвестная команда)';
            const liteResp = await axios.post(
                `${BACKEND_API_BASE_URL}/internal/ai/lite`,
                {
                    text: `Оцени безопасность следующей SSH команды для выполнения на сервере. Кратко объясни риски (1-2 предложения). Команда: ${cmd}`,
                },
                { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` }, timeout: 30000 }
            );
            const verdict = liteResp.data?.reply_text || liteResp.data?.text || '(нет ответа)';
            await ctx.reply(`🔍 Проверка AI:\n\n${verdict}\n\n⬆️ Кнопки подтверждения выше остаются активными.`);
        } catch (err: any) {
            const msg = err?.message || 'ошибка';
            await ctx.reply(`Не удалось проверить команду: ${msg}\n\n⬆️ Кнопки подтверждения выше остаются активными.`).catch(() => {});
        }
    })();
});

bot.action(/^devops:creds_apply:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    const userId = ctx.from?.id;
    if (!userId) {
        await ctx.answerCbQuery('Ошибка');
        return;
    }
    await ctx.answerCbQuery('Применяю...');
    (async () => {
        try {
            const resp = await axios.post(
                `${BACKEND_API_BASE_URL}/internal/devops/approve`,
                { confirmation_id: confirmationId, approved: true, user_id: userId },
                { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` }, timeout: 120000 }
            );
            const result = resp.data?.result;
            const output = typeof result === 'string' ? result.slice(0, 500) : '(выполнено)';
            await ctx.editMessageText(`✅ Credentials обновлены.\n\n${output}`).catch(() => {});
        } catch (err: any) {
            const msg = err?.response?.data?.error || err?.message || 'ошибка';
            await ctx.editMessageText(`⚠️ Ошибка: ${msg}`).catch(() => {});
        }
    })();
});

bot.action(/^devops:creds_reject:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    const userId = ctx.from?.id;
    if (!userId) {
        await ctx.answerCbQuery('Ошибка');
        return;
    }
    await ctx.answerCbQuery('Отклонено');
    try {
        await rejectWithOptionalComment('/internal/devops/approve', confirmationId, userId);
        await ctx.editMessageText('❌ Обновление credentials отклонено.');
    } catch {
        await ctx.editMessageText('⚠️ Не удалось отклонить.').catch(() => {});
    }
});

bot.action(/^devops:creds_reject_comment:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    await requestRejectionComment(ctx, '/internal/devops/approve', confirmationId, 'обновления credentials');
});

const processUserTextThroughAi = async (
    ctx: any,
    rawText: string,
    options?: {
        forcePro?: boolean;
        persistUserText?: string;
        onAssistantReply?: (assistantText: string) => Promise<void> | void;
        suppressFinalReply?: boolean;
        ignoreDailyLimit?: boolean;
        countAsUserMessage?: boolean;
        skipHistory?: boolean;
        documents?: Array<{ filename: string; base64: string }>;
    }
) => {
    const userId = ctx.from?.id;
    if (!userId) return null;

    let userText = rawText.trim();
    const hasDocuments = Array.isArray(options?.documents) && options!.documents!.length > 0;
    // Allow empty text when documents are attached (placeholder for AI).
    if (!userText && !hasDocuments) {
        if (!options?.suppressFinalReply) {
            await ctx.reply('Пустое сообщение. Попробуй ещё раз.');
        }
        return null;
    }
    const forceProRoute = Boolean(options?.forcePro) || userText.startsWith('!!!');
    if (forceProRoute && !options?.forcePro) {
        userText = userText.replace(/^!{3,}/, '').trim();
    }
    if (forceProRoute && !userText && !hasDocuments) {
        if (!options?.suppressFinalReply) {
            await ctx.reply('После !!! нужен текст запроса.');
        }
        return null;
    }
    // If no text but documents present — use a neutral placeholder so backend "empty_text" check passes.
    if (!userText && hasDocuments) {
        userText = 'Проанализируй прикреплённые документы.';
    }
    const userTextForHistory = options?.persistUserText?.trim() || userText;

    const userName = (ctx.state.userName as string | undefined) || 'Пользователь';
    const userRecord = await getUser(userId);
    if (!userRecord) {
        if (!options?.suppressFinalReply) {
            await ctx.reply('Не нашёл тебя в базе. Попроси админа выдать доступ.');
        }
        return null;
    }
    // Daily message limit removed — switched to token-based context limits.

    try {
        await ctx.sendChatAction('typing');
        const userChatId = Number.isFinite(Number(ctx.chat?.id)) ? Math.floor(Number(ctx.chat?.id)) : null;
        const userMessageId = Number.isFinite(Number(ctx.message?.message_id)) ? Math.floor(Number(ctx.message?.message_id)) : null;

        const backend = await runBackendAiStream(userId, userText, {
            forcePro: forceProRoute,
            persistUserText: userTextForHistory,
            ignoreDailyLimit: options?.ignoreDailyLimit,
            countAsUserMessage: options?.countAsUserMessage,
            skipHistory: options?.skipHistory,
            userTelegramChatId: userChatId,
            userTelegramMessageId: userMessageId,
            assistantTelegramChatId: userChatId,
            documents: options?.documents
        }, {
            onIntermediate: async (stepText) => {
                if (options?.suppressFinalReply) return;
                try {
                    await ctx.reply(stepText.slice(0, 4096));
                } catch {
                    // ignore
                }
            },
            onToolStatus: async (statusText) => {
                if (options?.suppressFinalReply) return;
                try {
                    await ctx.reply(`_${statusText}_`);
                } catch {
                    // ignore
                }
            },
            onDesktopAction: async (action) => {
                if (action?.action === 'pc_command_confirmation' && action?.value?.confirmation_id) {
                    const confirmationId = action.value.confirmation_id;
                    const command = action.value.command || '';
                    pendingPcCommandTexts.set(confirmationId, command);
                    const preview = command.slice(0, 200);
                    const keyboard = Markup.inlineKeyboard([
                        [
                            Markup.button.callback('✅ Разрешить', `pcconfirm:allow:${confirmationId}`),
                            Markup.button.callback('🔓 Разрешить всегда', `pcconfirm:always:${confirmationId}`),
                        ],
                        [
                            Markup.button.callback('❓ Проверить', `pcconfirm:review:${confirmationId}`),
                            Markup.button.callback('❌ Отклонить', `pcconfirm:reject:${confirmationId}`),
                        ]
                        ,
                        [
                            Markup.button.callback('💬 Отклонить с комментарием', `pcconfirm:reject_comment:${confirmationId}`),
                        ]
                    ]);
                    const escapedCmd = preview.replace(/`/g, '\\`');
                    try {
                        await ctx.reply(
                            `🔐 **Подтверждение команды на ПК**\n\n\`${escapedCmd}\`\n\nРазрешить выполнение?`,
                            { parse_mode: 'Markdown', ...keyboard }
                        );
                    } catch {
                        try {
                            await ctx.reply(`🔐 Подтверждение команды на ПК\n\n${preview}\n\nРазрешить выполнение?`, keyboard);
                        } catch {
                            // ignore
                        }
                    }
                }
                if (action?.action === 'file_action_confirmation' && action?.value?.confirmation_id) {
                    const confirmationId = action.value.confirmation_id;
                    const actionType = action.value.action_type || 'read';
                    const filePath = action.value.file_path || '';
                    const mode = action.value.mode || 'overwrite';
                    const sizeBytes = action.value.size_bytes || 0;
                    const contentPreview = action.value.content_preview || '';

                    const isWrite = actionType === 'write';
                    const titleIcon = isWrite ? '📝' : '📖';
                    const titleText = isWrite
                        ? `Запись файла${mode === 'append' ? ' (добавление)' : ''}`
                        : 'Чтение файла';

                    const sizeLine = isWrite && sizeBytes > 0
                        ? `\nРазмер: ${(sizeBytes / 1024).toFixed(1)} КБ`
                        : '';

                    let msgText = `${titleIcon} ${titleText}\n\n${filePath}${sizeLine}`;
                    if (contentPreview) {
                        const preview = contentPreview.slice(0, 800).replace(/```/g, "'''");
                        msgText += `\n\n${preview}`;
                    }
                    msgText += `\n\n${isWrite ? 'Разрешить запись?' : 'Разрешить чтение?'}`;

                    const keyboard = Markup.inlineKeyboard([
                        [
                            Markup.button.callback(`✅ ${isWrite ? 'Записать' : 'Прочитать'}`, `fileconfirm:allow:${confirmationId}`),
                            Markup.button.callback('❌ Отклонить', `fileconfirm:reject:${confirmationId}`),
                        ],
                        [
                            Markup.button.callback('💬 Отклонить с комментарием', `fileconfirm:reject_comment:${confirmationId}`),
                        ]
                    ]);
                    console.log('[tg][desktop_action] file_action_confirmation', {
                        confirmationId,
                        actionType,
                        filePath
                    });
                    try {
                        await ctx.reply(msgText, keyboard);
                    } catch (err: any) {
                        console.warn('[tg][desktop_action] file_action reply failed:', err?.message || err);
                        try {
                            await ctx.reply(`${titleIcon} ${titleText}\n\n${filePath}${sizeLine}\n\n${isWrite ? 'Разрешить запись?' : 'Разрешить чтение?'}`, keyboard);
                        } catch (fallbackErr: any) {
                            console.warn('[tg][desktop_action] file_action fallback reply failed:', fallbackErr?.message || fallbackErr);
                            throw fallbackErr;
                        }
                    }
                }
                if (action?.action === 'edit_file_lines_confirmation' && action?.value?.confirmation_id) {
                    const confirmationId = action.value.confirmation_id;
                    const filePath = action.value.file_path || '';
                    const startLine = action.value.start_line || 0;
                    const endLine = action.value.end_line || 0;
                    const oldPreview = (action.value.old_content_preview || '').slice(0, 600);
                    const newPreview = (action.value.new_content_preview || '').slice(0, 600);

                    let msgText = `✏️ Редактирование файла\n\n${filePath}\nСтроки: ${startLine}–${endLine}\n`;
                    if (oldPreview) {
                        msgText += `\n❌ Удаляется:\n${oldPreview.replace(/```/g, "'''")}\n`;
                    }
                    if (newPreview) {
                        msgText += `\n✅ Добавляется:\n${newPreview.replace(/```/g, "'''")}\n`;
                    }
                    if (!newPreview && oldPreview) {
                        msgText += `\n(строки будут удалены)`;
                    }
                    msgText += '\n\nПрименить изменения?';

                    const keyboard = Markup.inlineKeyboard([
                        [
                            Markup.button.callback('✅ Применить', `fileconfirm:allow:${confirmationId}`),
                            Markup.button.callback('❌ Отклонить', `fileconfirm:reject:${confirmationId}`),
                        ],
                        [
                            Markup.button.callback('💬 Отклонить с комментарием', `fileconfirm:reject_comment:${confirmationId}`),
                        ]
                    ]);
                    console.log('[tg][desktop_action] edit_file_lines_confirmation', {
                        confirmationId,
                        filePath,
                        startLine,
                        endLine
                    });
                    try {
                        await ctx.reply(msgText, keyboard);
                    } catch (err: any) {
                        console.warn('[tg][desktop_action] edit_file_lines reply failed:', err?.message || err);
                        try {
                            await ctx.reply(`✏️ Редактирование файла\n\n${filePath}\nСтроки: ${startLine}–${endLine}\n\nПрименить изменения?`, keyboard);
                        } catch (fallbackErr: any) {
                            console.warn('[tg][desktop_action] edit_file_lines fallback reply failed:', fallbackErr?.message || fallbackErr);
                            throw fallbackErr;
                        }
                    }
                }
                if (action?.action === 'devops_confirmation' && action?.value?.confirmation_id) {
                    const confirmationId = action.value.confirmation_id;
                    const serverName = action.value.server_name || '';
                    const serverId = action.value.server_id || '';
                    const command = action.value.command || '';
                    const host = action.value.host || '';
                    pendingPcCommandTexts.set(`devops:${confirmationId}`, command);
                    pendingPcCommandTexts.set(`devops_server:${confirmationId}`, String(serverId));
                    const preview = command.slice(0, 300);
                    const escapedCmd = preview.replace(/`/g, '\\`');
                    let msgText = `🖥 **SSH: ${serverName}** (${host})\n\n\`${escapedCmd}\`\n\nРазрешить выполнение?`;
                    const keyboard = Markup.inlineKeyboard([
                        [
                            Markup.button.callback('✅ Разрешить', `devops:allow:${confirmationId}`),
                            Markup.button.callback('🔓 Разрешить всегда', `devops:always:${confirmationId}`),
                        ],
                        [
                            Markup.button.callback('❓ Проверить', `devops:review:${confirmationId}`),
                            Markup.button.callback('❌ Отклонить', `devops:reject:${confirmationId}`),
                        ],
                        [
                            Markup.button.callback('💬 Отклонить с комментарием', `devops:reject_comment:${confirmationId}`),
                        ]
                    ]);
                    try {
                        await ctx.reply(msgText, { parse_mode: 'Markdown', ...keyboard });
                    } catch {
                        try {
                            await ctx.reply(`🖥 SSH: ${serverName} (${host})\n\n${preview}\n\nРазрешить выполнение?`, keyboard);
                        } catch {
                            // ignore
                        }
                    }
                }
                if (action?.action === 'suggest_server_creds_update' && action?.value?.confirmation_id) {
                    const confirmationId = action.value.confirmation_id;
                    const serverName = action.value.server_name || '';
                    const reason = action.value.reason || '';
                    const keyboard = Markup.inlineKeyboard([
                        [
                            Markup.button.callback('✅ Применить', `devops:creds_apply:${confirmationId}`),
                            Markup.button.callback('❌ Отклонить', `devops:creds_reject:${confirmationId}`),
                        ],
                        [
                            Markup.button.callback('💬 Отклонить с комментарием', `devops:creds_reject_comment:${confirmationId}`),
                        ]
                    ]);
                    try {
                        await ctx.reply(
                            `🔑 **Обновление credentials: ${serverName}**\n\n${reason}\n\nПрименить?`,
                            { parse_mode: 'Markdown', ...keyboard }
                        );
                    } catch {
                        try {
                            await ctx.reply(`🔑 Обновление credentials: ${serverName}\n\n${reason}\n\nПрименить?`, keyboard);
                        } catch {
                            // ignore
                        }
                    }
                }
                if (action?.action === 'email_confirmation' && action?.value?.confirmation_id) {
                    const confirmationId = action.value.confirmation_id;
                    const fromAddr = action.value.from || '';
                    const toAddr = action.value.to || '';
                    const subject = action.value.subject || '';
                    const bodyPreview = (action.value.body || '').slice(0, 1000);
                    const keyboard = Markup.inlineKeyboard([
                        [
                            Markup.button.callback('✅ Отправить', `email:allow:${confirmationId}`),
                            Markup.button.callback('❌ Отклонить', `email:reject:${confirmationId}`),
                        ],
                        [
                            Markup.button.callback('💬 Отклонить с комментарием', `email:reject_comment:${confirmationId}`),
                        ]
                    ]);
                    const fromLine = fromAddr ? `От: ${fromAddr}\n` : '';
                    const msgText = `📧 **Отправка письма**\n\n${fromLine}Кому: ${toAddr}\nТема: ${subject}\n\n\`\`\`\n${bodyPreview.replace(/```/g, "'''")}\n\`\`\`\n\nОтправить?`;
                    try {
                        await ctx.reply(msgText, { parse_mode: 'Markdown', ...keyboard });
                    } catch {
                        try {
                            await ctx.reply(`📧 Отправка письма\n\n${fromLine}Кому: ${toAddr}\nТема: ${subject}\n\n${bodyPreview}\n\nОтправить?`, keyboard);
                        } catch {
                            // ignore
                        }
                    }
                }
                if (action?.action === 'visual_click_confirmation' && action?.value?.confirmation_id) {
                    const confirmationId = action.value.confirmation_id;
                    const reason = action.value.reason || 'Клик по экрану';
                    const btn = action.value.button === 'right' ? 'правой' : 'левой';
                    const xPct = Math.round((action.value.x || 0) * 100);
                    const yPct = Math.round((action.value.y || 0) * 100);
                    pendingPcCommandTexts.set(`visual:${confirmationId}`, JSON.stringify({
                        display_id: action.value.display_id,
                        x: action.value.x,
                        y: action.value.y,
                        button: action.value.button,
                    }));
                    const keyboard = Markup.inlineKeyboard([
                        [
                            Markup.button.callback('✅ Кликнуть', `vclick:allow:${confirmationId}`),
                            Markup.button.callback('❌ Отклонить', `vclick:reject:${confirmationId}`),
                        ]
                    ]);
                    const caption = `🖱 Клик по экрану\n\n${reason}\nКоординаты: ${xPct}%, ${yPct}% (${btn} кнопка)`;

                    // If we have a preview image — send as photo with inline keyboard
                    let photoSent = false;
                    const previewB64 = action.value.preview_image_base64;
                    if (previewB64) {
                        try {
                            const imageBuffer = Buffer.from(previewB64, 'base64');
                            await ctx.replyWithPhoto(
                                { source: imageBuffer },
                                { caption, ...keyboard }
                            );
                            photoSent = true;
                        } catch (err) {
                            console.error('[visual_click] failed to send preview photo:', err);
                        }
                    }
                    if (!photoSent) {
                        try {
                            await ctx.reply(`${caption}\n\nПодтвердить?`, keyboard);
                        } catch {
                            // ignore
                        }
                    }
                }
            }
        });

        if (Array.isArray(backend?.tool_user_messages) && backend.tool_user_messages.length > 0 && !options?.suppressFinalReply) {
            for (const msg of backend.tool_user_messages) {
                const trimmed = typeof msg === 'string' ? msg.trim() : '';
                if (trimmed) {
                    await ctx.reply(trimmed);
                }
            }
        }
        if (typeof backend?.model_fallback_notice === 'string' && backend.model_fallback_notice.trim() && !options?.suppressFinalReply) {
            await ctx.reply(backend.model_fallback_notice.trim());
        }
        const assistantText = typeof backend?.reply_text === 'string' && backend.reply_text.trim()
            ? backend.reply_text.trim()
            : FALLBACK_ANSWER;
        let sentMessage: any = null;
        if (!options?.suppressFinalReply) {
            sentMessage = await safeReply(ctx, assistantText);
            const backendAssistantMessageId = Number.isFinite(Number(backend?.message_id))
                ? Math.floor(Number(backend?.message_id))
                : null;
            const assistantTgMessageId = Number.isFinite(Number(sentMessage?.message_id))
                ? Math.floor(Number(sentMessage?.message_id))
                : null;
            if (backendAssistantMessageId && !options?.skipHistory) {
                try {
                    await runBackendBindTelegramMessage(userId, backendAssistantMessageId, userChatId, assistantTgMessageId);
                } catch (bindErr) {
                    console.warn('Не удалось привязать telegram_message_id к backend сообщению:', bindErr);
                }
            }
            // Отправка сгенерированных изображений
            if (Array.isArray(backend?.generated_images) && backend.generated_images.length > 0) {
                for (const img of backend.generated_images) {
                    try {
                        const imageBuffer = Buffer.from(img.image_base64, 'base64');
                        await ctx.replyWithPhoto({ source: imageBuffer });
                    } catch (imgErr) {
                        console.error('Ошибка отправки сгенерированного изображения:', imgErr);
                        await ctx.reply('Не удалось отправить сгенерированное изображение.').catch(() => {});
                    }
                }
            }
        }
        if (options?.onAssistantReply) {
            await options.onAssistantReply(assistantText);
        }
        return assistantText;
    } catch (err) {
        console.error('Ошибка backend-ai вызова:', err);
        if (!options?.suppressFinalReply) {
            await ctx.reply('Блин, какая-то ошибка в системе. Проверь логи backend-api.');
        }
        return null;
    }
};

bot.on('text', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const userText = ctx.message.text.trim();
    const directMessageTargetId = adminAiMessageFlow.get(userId);
    if (directMessageTargetId) {
        adminAiMessageFlow.delete(userId);
        await handleAiDirectMessage(ctx, directMessageTargetId, userText);
        return;
    }

    const pendingRejection = pendingRejectionComments.get(userId);
    if (pendingRejection) {
        if (userText.toLowerCase() === '/cancel' || userText.toLowerCase() === 'отмена') {
            pendingRejectionComments.delete(userId);
            await ctx.reply('Отклонение с комментарием отменено. Кнопки подтверждения выше остаются активными.');
            return;
        }
        pendingRejectionComments.delete(userId);
        try {
            await rejectWithOptionalComment(
                pendingRejection.endpoint,
                pendingRejection.confirmationId,
                userId,
                userText,
            );
            await ctx.reply('❌ Отклонено с комментарием.');
        } catch {
            await ctx.reply('⚠️ Не удалось отклонить (возможно, подтверждение уже истекло или было обработано).');
        }
        return;
    }

    // ── Link code flow ──
    const linkFlow = linkCodeFlows.get(userId);
    if (linkFlow === 'await_code') {
        linkCodeFlows.delete(userId);
        const code = userText.replace(/\D/g, '');
        if (code.length !== 6) {
            linkCodeFlows.set(userId, 'await_code');
            return ctx.reply('Нужно 6 цифр. Попробуй ещё раз или /cancellink для отмены.');
        }
        try {
            const response = await axios.post(
                `${BACKEND_API_BASE_URL}/internal/link/verify`,
                { code, tg_id: userId, tg_username: ctx.from?.username || null },
                { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` } }
            );
            if (response.data?.ok) {
                return ctx.reply(
                    '✅ Аккаунт привязан! Теперь можешь пользоваться десктоп-приложением с данными твоего Telegram-аккаунта.',
                    buildMenuTriggerKeyboard()
                );
            }
            return ctx.reply('Не удалось привязать. Возможно, код истёк. Попробуй получить новый код в приложении и снова /link.');
        } catch (err: any) {
            const msg = err?.response?.data?.error;
            if (msg === 'invalid_or_expired_code') {
                return ctx.reply('Код недействителен или истёк. Получи новый код в приложении и попробуй /link снова.');
            }
            if (msg === 'telegram_user_not_approved') {
                return ctx.reply('Сначала админ должен подтвердить доступ к боту, потом можно привязывать desktop-приложение.');
            }
            if (msg === 'telegram_user_not_found') {
                return ctx.reply('Не нашёл твой Telegram-аккаунт в базе. Напиши /start и дождись подтверждения админа.');
            }
            console.error('Link verify error:', err?.message || err);
            return ctx.reply('Ошибка при привязке. Попробуй позже.');
        }
    }

    const adminContextFlow = adminUserContextLimitFlows.get(userId);
    if (adminContextFlow) {
        const lowered = userText.toLowerCase();
        if (lowered === 'отмена' || lowered === '/cancel') {
            adminUserContextLimitFlows.delete(userId);
            return ctx.reply('Ок, изменение контекста пользователя отменено.');
        }

        const parsed = Number.parseInt(userText, 10);
        if (!Number.isFinite(parsed) || parsed < 1000) {
            return ctx.reply('Нужно ввести число от 1000. Например: 30000. Для отмены: "отмена".');
        }

        const targetUser = await getUser(adminContextFlow.targetUserId);
        if (!targetUser) {
            adminUserContextLimitFlows.delete(userId);
            return ctx.reply('Пользователь не найден.');
        }

        const nextValue = Math.max(1000, Math.floor(parsed));
        try { await runBackendSetContextTokens(adminContextFlow.targetUserId, nextValue); } catch {}
        db.prepare('UPDATE users SET max_context_tokens = ? WHERE id = ?').run(nextValue, adminContextFlow.targetUserId);
        await trimUserHistory(adminContextFlow.targetUserId);
        adminUserContextLimitFlows.delete(userId);
        const refreshed = await getUser(adminContextFlow.targetUserId);
        if (refreshed) {
            const maxTokens = (refreshed.max_context_tokens_limit ?? 0) > 0
                ? Math.floor(refreshed.max_context_tokens_limit!) : getPlanMaxContextTokens(parsePlanFromDb(refreshed.plan));
            await ctx.reply(`✅ Лимит токенов пользователя #${adminContextFlow.targetUserId}: ${(resolveMaxContextTokens(refreshed) / 1000).toFixed(0)}k (макс: ${(maxTokens / 1000).toFixed(0)}k)`);
            await renderAdminUserCard(ctx, refreshed, adminContextFlow.page, 'reply');
            return;
        }
        return ctx.reply(`✅ Лимит токенов пользователя #${adminContextFlow.targetUserId}: ${nextValue}.`);
    }

    const adminMessageLimitFlow = adminUserMessageLimitFlows.get(userId);
    if (adminMessageLimitFlow) {
        const lowered = userText.toLowerCase();
        if (lowered === 'отмена' || lowered === '/cancel') {
            adminUserMessageLimitFlows.delete(userId);
            return ctx.reply('Ок, изменение лимита сообщений отменено.');
        }

        const parsed = Number.parseInt(userText, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
            return ctx.reply('Нужно ввести число 0 или больше. 0 = безлимит. Для отмены: "отмена".');
        }

        const targetUser = await getUser(adminMessageLimitFlow.targetUserId);
        if (!targetUser) {
            adminUserMessageLimitFlows.delete(userId);
            return ctx.reply('Пользователь не найден.');
        }

        const nextLimit = normalizeDailyMessageLimit(parsed);
        updateUserDailyMessageLimit(adminMessageLimitFlow.targetUserId, nextLimit);
        adminUserMessageLimitFlows.delete(userId);
        const refreshed = await getUser(adminMessageLimitFlow.targetUserId);
        if (refreshed) {
            await ctx.reply(`✅ Лимит сообщений пользователя #${adminMessageLimitFlow.targetUserId}: ${normalizeDailyMessageLimit(refreshed.daily_message_limit)} (0 = безлимит).`);
            await renderAdminUserCard(ctx, refreshed, adminMessageLimitFlow.page, 'reply');
            return;
        }
        return ctx.reply(`✅ Лимит сообщений пользователя #${adminMessageLimitFlow.targetUserId}: ${nextLimit}.`);
    }

    const isAdmin = ctx.state.role === 'admin';
    const timezoneFlow = timezoneSetupFlows.get(userId);

    if (timezoneFlow === 'await_offset') {
        let offsetText = userText;
        if (offsetText.startsWith('/tz')) {
            offsetText = offsetText.split(' ')[1] ?? '';
        }

        const offset = Number.parseInt(offsetText, 10);
        if (Number.isNaN(offset) || offset < -12 || offset > 14) {
            return ctx.reply('Не понял смещение. Отправь число от -12 до +14, например: 7');
        }

        try { await runBackendSetTimezone(userId, offset); } catch {}
        updateUserTimezone(userId, offset);
        timezoneSetupFlows.delete(userId);
        const sign = offset >= 0 ? '+' : '';
        return ctx.reply(`Готово, часовой пояс установлен: UTC${sign}${offset}. Теперь могу ставить таймеры.`, buildMenuTriggerKeyboard());
    }

    if (!isAdmin) {
        const renameFlow = renameFlows.get(userId);

        if (renameFlow === 'confirm') {
            const answer = userText.toLowerCase();
            if (answer === 'да') {
                renameFlows.set(userId, 'await_name');
                return ctx.reply('Введите имя:');
            }

            if (answer === 'нет') {
                renameFlows.delete(userId);
                return ctx.reply('Ок, отменил.', buildMenuTriggerKeyboard());
            }

            return ctx.reply('Ответь "Да" или "Нет".', Markup.keyboard([['Да', 'Нет']]).resize().oneTime());
        }

        if (renameFlow === 'await_name') {
            if (!userText || userText.startsWith('/')) {
                return ctx.reply('Имя не может быть пустым. Введи обычный текст без команды.');
            }

            if (userText.length > 64) {
                return ctx.reply('Слишком длинное имя. До 64 символов.');
            }

            const userRecord = await getUser(userId);
            if (!userRecord) {
                renameFlows.delete(userId);
                return ctx.reply('Не нашёл тебя в базе. Попроси админа выдать доступ заново.');
            }

            await updateUserName(userId, userText);
            ctx.state.userName = userText;
            renameFlows.delete(userId);
            return ctx.reply('Имя принято.', buildMenuTriggerKeyboard());
        }

        const customPromptFlow = customPromptEditFlows.get(userId);
        if (customPromptFlow === 'await_content') {
            if (!userText || userText.startsWith('/')) {
                return ctx.reply('Текст промпта не должен быть пустым и не должен быть командой.');
            }
            if (userText.length > MAX_CUSTOM_PROMPT_LENGTH) {
                return ctx.reply(`Слишком длинно: ${userText.length} символов. Лимит: ${MAX_CUSTOM_PROMPT_LENGTH}.`);
            }

            const userRecord = await getUser(userId);
            if (!userRecord) {
                customPromptEditFlows.delete(userId);
                return ctx.reply('Не нашёл тебя в базе. Попроси админа выдать доступ заново.');
            }

            await updateUserCustomPrompt(userId, userText.trim());
            try { await runBackendUpdateCustomPrompt(userId, userText.trim()); } catch {}
            try { await runBackendSelectUserPrompt(userId, -1); } catch {}
            await selectUserCustomPrompt(userId);
            customPromptEditFlows.delete(userId);
            return ctx.reply('Кастомный промпт сохранён и выбран.', buildMenuTriggerKeyboard());
        }
    }

    const mailLimitFlow = mailLimitFlows.get(userId);
    if (mailLimitFlow === 'await_limit') {
        const lowered = userText.toLowerCase();
        if (lowered === 'отмена' || lowered === '/cancel') {
            mailLimitFlows.delete(userId);
            return ctx.reply('Ок, изменение лимита отменено.');
        }

        const parsed = Number.parseInt(userText, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return ctx.reply('Нужно ввести положительное число. Например: 10. Для отмены: "отмена".');
        }

        const userRecord = await getUser(userId);
        if (!userRecord) {
            mailLimitFlows.delete(userId);
            return ctx.reply('Не нашёл тебя в базе. Попроси админа выдать доступ заново.');
        }
        if (userRecord.role !== 'admin' && parsed > 10) {
            return ctx.reply('Для вас доступно максимум 10. Введи число от 1 до 10.');
        }

        try { await runBackendMailLimit(userId, parsed); } catch {}
        updateUserMailCheckLimit(userId, parsed);
        mailLimitFlows.delete(userId);
        return ctx.reply(`✅ Новое ограничение check_emails: ${parsed}.`);
    }

    const contextLimitFlow = contextLimitFlows.get(userId);
    if (contextLimitFlow === 'await_limit') {
        const lowered = userText.toLowerCase();
        if (lowered === 'отмена' || lowered === '/cancel') {
            contextLimitFlows.delete(userId);
            return ctx.reply('Ок, изменение размера контекста отменено.');
        }

        const parsed = Number.parseInt(userText, 10);
        if (!Number.isFinite(parsed) || parsed < 1000) {
            return ctx.reply('Нужно ввести число от 1000. Например: 30000. Для отмены: "отмена".');
        }

        const userRecord = await getUser(userId);
        if (!userRecord) {
            contextLimitFlows.delete(userId);
            return ctx.reply('Не нашёл тебя в базе. Попроси админа выдать доступ заново.');
        }

        const maxAllowed = (userRecord.max_context_tokens_limit ?? 0) > 0
            ? Math.floor(userRecord.max_context_tokens_limit!) : getPlanMaxContextTokens(parsePlanFromDb(userRecord.plan));
        const isUserAdmin = ADMIN_IDS.has(userId) || userRecord.role === 'admin';
        if (!isUserAdmin && parsed > maxAllowed) {
            return ctx.reply(`Для тебя доступно максимум ${(maxAllowed / 1000).toFixed(0)}k токенов.`);
        }

        const ctxValue = Math.max(1000, Math.floor(parsed));
        try { await runBackendSetContextTokens(userId, ctxValue); } catch {}
        db.prepare('UPDATE users SET max_context_tokens = ? WHERE id = ?').run(ctxValue, userId);
        await trimUserHistory(userId);
        contextLimitFlows.delete(userId);
        const refreshed = await getUser(userId);
        if (refreshed) {
            return ctx.reply(
                `✅ Лимит контекста обновлён: ${(resolveMaxContextTokens(refreshed) / 1000).toFixed(0)}k из ${(maxAllowed / 1000).toFixed(0)}k токенов.`
            );
        }
        return ctx.reply(`✅ Лимит контекста обновлён: ${ctxValue} токенов.`);
    }

    const noteEditFlow = noteEditFlows.get(userId);
    if (noteEditFlow) {
        const lowered = userText.toLowerCase();
        if (lowered === 'отмена' || lowered === '/cancel') {
            noteEditFlows.delete(userId);
            return ctx.reply('Ок, редактирование заметки отменено.');
        }

        const userRecord = await getUser(userId);
        if (!userRecord) {
            noteEditFlows.delete(userId);
            return ctx.reply('Не нашёл тебя в базе. Попроси админа выдать доступ заново.');
        }

        const userPlan = parsePlanFromDb(userRecord.plan);
        const contentLimit = getPlanNoteContentLimit(userPlan);
        if (!userText || userText.length > contentLimit) {
            return ctx.reply(`Текст заметки должен быть от 1 до ${contentLimit} символов. Для отмены: "отмена".`);
        }

        const note = getNoteByUserAndId(userId, noteEditFlow.noteId);
        if (!note) {
            noteEditFlows.delete(userId);
            return ctx.reply(`Заметка #${noteEditFlow.noteId} не найдена.`);
        }

        const result = updateNoteByUserAndId(userId, noteEditFlow.noteId, userText.trim());
        noteEditFlows.delete(userId);
        if (!result.changes) {
            return ctx.reply(`Не удалось обновить заметку #${noteEditFlow.noteId}.`);
        }

        await ctx.reply(`✅ Заметка #${noteEditFlow.noteId} обновлена.`);
        await renderNoteView(ctx, userId, noteEditFlow.noteId, noteEditFlow.page, 'reply');
        return;
    }

    // Fire-and-forget: don't block Telegraf from processing callback_query (inline buttons)
    processUserTextThroughAi(ctx, userText).catch(err => {
        console.error('Ошибка в processUserTextThroughAi:', err);
    });
});

// ── Document (file attachment) handler ──
bot.on('document', async (ctx) => {
    await processUserDocumentThroughAi(ctx);
});

bot.on('voice', async (ctx) => {
    const voice = ctx.message?.voice;
    const chatId = ctx.chat?.id;
    if (!voice || !chatId) return;

    const processingMsg = await ctx.reply('🎙 Перевариваю аудио в текст...');

    try {
        const fileLink = await ctx.telegram.getFileLink(voice.file_id);
        const response = await fetch(fileLink.href);
        if (!response.ok) {
            throw new Error(`Не удалось скачать голосовое из Telegram: ${response.status} ${response.statusText}`);
        }

        const audioBuffer = await response.arrayBuffer();
        const mimeType = voice.mime_type || 'audio/ogg';
        const userId = Math.floor(Number(ctx.from.id));
        const userChatId = Number.isFinite(Number(ctx.chat?.id)) ? Math.floor(Number(ctx.chat?.id)) : null;
        const userMessageId = Number.isFinite(Number(ctx.message?.message_id)) ? Math.floor(Number(ctx.message?.message_id)) : null;

        const backend = await runBackendVoiceTurn(userId, Buffer.from(audioBuffer), mimeType, {
            chatId: undefined,
            userTelegramChatId: userChatId,
            userTelegramMessageId: userMessageId,
            assistantTelegramChatId: userChatId
        });

        const text = typeof backend?.recognized_text === 'string' ? backend.recognized_text.trim() : '';
        if (!text) {
            await ctx.telegram.editMessageText(chatId, processingMsg.message_id, undefined, '🗣 Ничего не расслышал.');
            return;
        }

        await ctx.telegram.editMessageText(chatId, processingMsg.message_id, undefined, `🗣 Распознано:\n${text}`);

        if (Array.isArray(backend?.tool_user_messages) && backend.tool_user_messages.length) {
            for (const message of backend.tool_user_messages) {
                const trimmed = typeof message === 'string' ? message.trim() : '';
                if (trimmed) {
                    await ctx.reply(trimmed);
                }
            }
        }

        if (typeof backend?.model_fallback_notice === 'string' && backend.model_fallback_notice.trim()) {
            await ctx.reply(backend.model_fallback_notice.trim());
        }

        const assistantText = typeof backend?.reply_text === 'string' && backend.reply_text.trim()
            ? backend.reply_text.trim()
            : FALLBACK_ANSWER;
        const sentTextMessage = await safeReply(ctx, assistantText);

        const backendAssistantMessageId = Number.isFinite(Number(backend?.message_id))
            ? Math.floor(Number(backend?.message_id))
            : null;
        const assistantTgMessageId = Number.isFinite(Number(sentTextMessage?.message_id))
            ? Math.floor(Number(sentTextMessage?.message_id))
            : null;
        if (backendAssistantMessageId) {
            try {
                await runBackendBindTelegramMessage(userId, backendAssistantMessageId, userChatId, assistantTgMessageId);
            } catch (bindErr) {
                console.warn('Не удалось привязать telegram_message_id к backend voice сообщению:', bindErr);
            }
        }

        const voiceAudioBase64 = typeof backend?.voice_audio_base64 === 'string' ? backend.voice_audio_base64.trim() : '';
        if (voiceAudioBase64) {
            const voiceBuffer = Buffer.from(voiceAudioBase64, 'base64');
            if (voiceBuffer.length) {
                await ctx.replyWithVoice({ source: voiceBuffer });
            }
        } else if (typeof backend?.voice_error === 'string' && backend.voice_error.trim()) {
            console.warn('Ошибка генерации голоса на backend:', backend.voice_error);
        }
    } catch (error) {
        console.error('Ошибка работы с голосовым:', error);
        try {
            await ctx.telegram.editMessageText(
                chatId,
                processingMsg.message_id,
                undefined,
                '❌ Сбой связи с сервером расшифровки или внутренняя ошибка.'
            );
        } catch {
            await ctx.reply('❌ Сбой связи с сервером расшифровки или внутренняя ошибка.');
        }
    }
});

bot.on('photo', async (ctx) => {
    await processUserPhotoThroughAi(ctx);
});


setInterval(() => {
    void (async () => {
        try {
            await expireFinishedPlanSubscriptions();
        } catch (err) {
            console.error('Ошибка проверки истекших подписок:', err);
        }
    })();
}, 60 * 60 * 1000);

void (async () => {
    try {
        await expireFinishedPlanSubscriptions();
    } catch (err) {
        console.error('Ошибка первичной проверки подписок:', err);
    }
})();

if (AUTO_SYNC_PLAN_LIMITS_ON_BOOT) {
    (async () => {
        try {
            await syncAllUsersPlanLimits();
            console.log('Автосинхронизация лимитов по планам выполнена.');
        } catch (err) {
            console.error('Ошибка автосинхронизации лимитов по планам:', err);
        }
    })();
}

scheduleDailyCounterReset();

bot.launch();
console.log('Chatter запущен с базой данных!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

