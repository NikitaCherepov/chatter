import { Markup, Telegraf } from 'telegraf';
import OpenAI from 'openai';
import Database from 'better-sqlite3';
import * as dotenv from 'dotenv';
import { tavily } from '@tavily/core';
import crypto from 'crypto';

dotenv.config();

const MAX_HISTORY_ITEMS = 6;
const USER_PLANS = ['free', 'standart', 'pro'] as const;
type UserPlan = typeof USER_PLANS[number];
const PLAN_LABELS: Record<UserPlan, string> = {
    free: 'FREE',
    standart: 'STANDART',
    pro: 'PRO'
};
const PLAN_CONTEXT_LIMITS: Record<UserPlan, number> = {
    free: MAX_HISTORY_ITEMS,
    standart: 10,
    pro: 20
};
const PLAN_DAILY_MESSAGE_LIMITS: Record<UserPlan, number> = {
    free: 10,
    standart: 20,
    pro: 50
};
const PLAN_DAILY_WEB_SEARCH_LIMITS: Record<UserPlan, number> = {
    free: 0,
    standart: 2,
    pro: 10
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
const PLAN_LITE_ROUTER_ENABLED: Record<UserPlan, boolean> = {
    free: false,
    standart: true,
    pro: true
};
const PLAN_ESCALATE_TOOL_ENABLED: Record<UserPlan, boolean> = {
    free: false,
    standart: true,
    pro: true
};
const DEFAULT_USER_PLAN: UserPlan = 'free';

const bot = new Telegraf(process.env.TELEGRAM_TOKEN!);
const ai = new OpenAI({
    apiKey: process.env.TIMEWEB_API_KEY,
    baseURL: process.env.TIMEWEB_BASE_URL,
});
const aiLite = new OpenAI({
    apiKey: process.env.TIMEWEB_LITE_API_KEY || process.env.TIMEWEB_API_KEY,
    baseURL: process.env.TIMEWEB_LITE_BASE_URL || process.env.TIMEWEB_BASE_URL,
});
const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

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
        timezone_offset INTEGER DEFAULT 5,
        timezone_confirmed INTEGER NOT NULL DEFAULT 0,
        daily_message_count INTEGER NOT NULL DEFAULT 0,
        total_message_length INTEGER NOT NULL DEFAULT 0,
        daily_message_limit INTEGER NOT NULL DEFAULT ${PLAN_DAILY_MESSAGE_LIMITS[DEFAULT_USER_PLAN]},
        daily_tokens_used INTEGER NOT NULL DEFAULT 0,
        total_tokens_used INTEGER NOT NULL DEFAULT 0,
        daily_cost_rub REAL NOT NULL DEFAULT 0,
        total_cost_rub REAL NOT NULL DEFAULT 0,
        daily_web_search_count INTEGER NOT NULL DEFAULT 0,
        daily_web_search_limit INTEGER NOT NULL DEFAULT ${PLAN_DAILY_WEB_SEARCH_LIMITS[DEFAULT_USER_PLAN]},
        total_web_search_count INTEGER NOT NULL DEFAULT 0,
        context_window INTEGER NOT NULL DEFAULT ${PLAN_CONTEXT_LIMITS[DEFAULT_USER_PLAN]},
        context_window_max INTEGER NOT NULL DEFAULT ${PLAN_CONTEXT_LIMITS[DEFAULT_USER_PLAN]},
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_user_id_id
    ON chat_messages(user_id, id);

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
ensureUserColumn('status', `ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'`);
ensureUserColumn('plan', `ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT '${DEFAULT_USER_PLAN}'`);
ensureUserColumn('tg_username', 'ALTER TABLE users ADD COLUMN tg_username TEXT');
ensureUserColumn('created_at', 'ALTER TABLE users ADD COLUMN created_at DATETIME');
ensureUserColumn('timezone_offset', 'ALTER TABLE users ADD COLUMN timezone_offset INTEGER DEFAULT 5');
ensureUserColumn('timezone_confirmed', 'ALTER TABLE users ADD COLUMN timezone_confirmed INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('daily_message_count', 'ALTER TABLE users ADD COLUMN daily_message_count INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('total_message_length', 'ALTER TABLE users ADD COLUMN total_message_length INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('daily_message_limit', `ALTER TABLE users ADD COLUMN daily_message_limit INTEGER NOT NULL DEFAULT ${PLAN_DAILY_MESSAGE_LIMITS[DEFAULT_USER_PLAN]}`);
ensureUserColumn('daily_tokens_used', 'ALTER TABLE users ADD COLUMN daily_tokens_used INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('total_tokens_used', 'ALTER TABLE users ADD COLUMN total_tokens_used INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('daily_cost_rub', 'ALTER TABLE users ADD COLUMN daily_cost_rub REAL NOT NULL DEFAULT 0');
ensureUserColumn('total_cost_rub', 'ALTER TABLE users ADD COLUMN total_cost_rub REAL NOT NULL DEFAULT 0');
ensureUserColumn('daily_web_search_count', 'ALTER TABLE users ADD COLUMN daily_web_search_count INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('daily_web_search_limit', `ALTER TABLE users ADD COLUMN daily_web_search_limit INTEGER NOT NULL DEFAULT ${PLAN_DAILY_WEB_SEARCH_LIMITS[DEFAULT_USER_PLAN]}`);
ensureUserColumn('total_web_search_count', 'ALTER TABLE users ADD COLUMN total_web_search_count INTEGER NOT NULL DEFAULT 0');
ensureUserColumn('context_window', `ALTER TABLE users ADD COLUMN context_window INTEGER NOT NULL DEFAULT ${PLAN_CONTEXT_LIMITS[DEFAULT_USER_PLAN]}`);
ensureUserColumn('context_window_max', `ALTER TABLE users ADD COLUMN context_window_max INTEGER NOT NULL DEFAULT ${PLAN_CONTEXT_LIMITS[DEFAULT_USER_PLAN]}`);

ensureTaskColumn('recurrence_type', `ALTER TABLE tasks ADD COLUMN recurrence_type TEXT NOT NULL DEFAULT 'once'`);
ensureTaskColumn('recurrence_weekday', 'ALTER TABLE tasks ADD COLUMN recurrence_weekday INTEGER');
ensureTaskColumn('timezone_offset', 'ALTER TABLE tasks ADD COLUMN timezone_offset INTEGER');
ensureTaskColumn('notify_mode', `ALTER TABLE tasks ADD COLUMN notify_mode TEXT NOT NULL DEFAULT 'always'`);
ensureTaskColumn('notify_condition', 'ALTER TABLE tasks ADD COLUMN notify_condition TEXT');

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
    db.exec(`UPDATE users SET daily_message_limit = ${PLAN_DAILY_MESSAGE_LIMITS[DEFAULT_USER_PLAN]} WHERE daily_message_limit IS NULL OR daily_message_limit < 0`);
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
    db.exec(`UPDATE users SET context_window_max = ${PLAN_CONTEXT_LIMITS[DEFAULT_USER_PLAN]} WHERE context_window_max IS NULL OR context_window_max <= 0`);
}
if (hasUserColumn('plan') && hasUserColumn('context_window_max')) {
    db.exec(`
        UPDATE users
        SET context_window_max = CASE
            WHEN plan = 'pro' THEN ${PLAN_CONTEXT_LIMITS.pro}
            WHEN plan = 'standart' THEN ${PLAN_CONTEXT_LIMITS.standart}
            ELSE ${PLAN_CONTEXT_LIMITS.free}
        END
    `);
}
if (hasUserColumn('plan') && hasUserColumn('daily_message_limit')) {
    db.exec(`
        UPDATE users
        SET daily_message_limit = CASE
            WHEN plan = 'pro' THEN ${PLAN_DAILY_MESSAGE_LIMITS.pro}
            WHEN plan = 'standart' THEN ${PLAN_DAILY_MESSAGE_LIMITS.standart}
            ELSE ${PLAN_DAILY_MESSAGE_LIMITS.free}
        END
        WHERE daily_message_limit IS NULL OR daily_message_limit < 0
    `);
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
        SET context_window = COALESCE(context_window_max, ${PLAN_CONTEXT_LIMITS[DEFAULT_USER_PLAN]})
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
const LITE_ROUTER_INSTRUCTIONS = `

Ты — быстрый ассистент-диспетчер.
Твоя главная задача: управление устройствами, быстрый web-поиск, установка часового пояса, случайные броски и короткие бытовые ответы.
ПРАВИЛО ЭСКАЛАЦИИ: если запрос сложный (творчество, глубокий анализ, длинная структурированная расшифровка, программирование, большой текст), не пытайся отвечать сам.
Ты ОБЯЗАН немедленно вызвать инструмент escalate_to_pro и передать исходный запрос пользователя в original_query.`;
const buildSystemPrompt = (promptContent: string, userName: string, coreMemory = '') => `${promptContent}\n\nИмя {{user}}: ${userName}\n\n[ПОСТОЯННЫЕ ЗНАНИЯ О ПОЛЬЗОВАТЕЛЕ]\n${coreMemory.trim() || 'Пока пусто.'}`;
const buildTimeContext = (timezoneOffset: number) => {
    const now = new Date();
    const localTime = new Date(now.getTime() + timezoneOffset * 3600 * 1000);
    const utcSign = timezoneOffset >= 0 ? '+' : '';
    return `\n\n[СИСТЕМНАЯ ИНФОРМАЦИЯ]\nТекущее Unix-время (в секундах): ${Math.floor(now.getTime() / 1000)}.\nЛокальное время пользователя: ${localTime.toISOString().replace('T', ' ').substring(0, 19)} (UTC${utcSign}${timezoneOffset}). При планировании задач используй local_time (HH:MM) или delay_seconds.`;
};
const MODEL_NAME = process.env.TIMEWEB_MODEL || 'gemini-3.1-flash-lite-preview';
const LITE_MODEL_NAME = process.env.TIMEWEB_LITE_MODEL || 'gemini-2.5-flash-lite';
const DEBUG_AI_RAW_MAIN_RESPONSE = process.env.DEBUG_AI_RAW_MAIN_RESPONSE === '1';
const DEBUG_AI_RAW_LITE_RESPONSE = process.env.DEBUG_AI_RAW_LITE_RESPONSE === '1';
const MAX_PENDING_TASKS_PER_USER = 10;
const PAGE_SIZE = 10;
const FALLBACK_ANSWER = 'Слушай, чет я завис. Попробуй еще раз?';
const CUSTOM_PROMPT_ID = -1;
const MAX_CUSTOM_PROMPT_LENGTH = 800;
const MAX_CORE_MEMORY_LENGTH = 400;
const NOTES_WEBAPP_URL = (process.env.NOTES_WEBAPP_URL || '').trim();
const NOTE_CONTENT_MAX_LENGTH = 3000;
const NOTE_TITLE_MAX_LENGTH = 120;
const NOTE_QUERY_MAX_LENGTH = 120;
const NOTES_PAGE_SIZE_DEFAULT = 10;
const NOTES_MENU_PAGE_SIZE = 10;
const DEFAULT_MAIL_CHECK_LIMIT = 10;
const TOKENS_PER_PRICE_BLOCK = 500_000;
const PRICE_PER_PRICE_BLOCK_RUB = 102;
const RUB_PER_TOKEN = PRICE_PER_PRICE_BLOCK_RUB / TOKENS_PER_PRICE_BLOCK;
const EMAIL_PASSWORD_DELIMITER = '::';
const VOICE_TRANSCRIBE_URL = (process.env.VOICE_TRANSCRIBE_URL || 'http://***REMOVED_VOICE_ENDPOINT***/api/voice').trim();
const VOICE_TRANSCRIBE_TOKEN = (process.env.VOICE_TRANSCRIBE_TOKEN || '***REMOVED_VOICE_SECRET***').trim();
const resolveDefaultVoiceEndpoint = (transcribeUrl: string, targetPath: '/api/tts' | '/api/silero') => {
    try {
        const parsed = new URL(transcribeUrl);
        if (parsed.pathname.endsWith('/api/voice')) {
            parsed.pathname = parsed.pathname.replace(/\/api\/voice$/, targetPath);
        } else if (!parsed.pathname || parsed.pathname === '/') {
            parsed.pathname = targetPath;
        }
        return parsed.toString();
    } catch {
        return `http://***REMOVED_VOICE_ENDPOINT***${targetPath}`;
    }
};
const normalizeTtsEngine = (raw: string | undefined) => {
    const value = (raw || 'tts').trim().toLowerCase();
    return value === 'silero' ? 'silero' : 'tts';
};
const VOICE_TTS_ENGINE = normalizeTtsEngine(process.env.VOICE_TTS_ENGINE);
const VOICE_TTS_URL = (process.env.VOICE_TTS_URL || resolveDefaultVoiceEndpoint(VOICE_TRANSCRIBE_URL, '/api/tts')).trim();
const VOICE_SILERO_URL = (process.env.VOICE_SILERO_URL || resolveDefaultVoiceEndpoint(VOICE_TRANSCRIBE_URL, '/api/silero')).trim();
const getVoiceSynthesisUrl = () => (VOICE_TTS_ENGINE === 'silero' ? VOICE_SILERO_URL : VOICE_TTS_URL);
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
    { command: 'prompt_default', description: 'Сделать дефолтным: /prompt_default <id>' }
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
const parseCsv = (raw: string | undefined) => {
    if (!raw) return [] as string[];
    return raw
        .split(/[,\n;]+/)
        .map(item => item.trim())
        .filter(Boolean);
};
const normalizeDeviceAlias = (alias: string) => alias.trim().toLowerCase();
const encryptSecret = (text: string) => {
    const iv = crypto.randomBytes(ENCRYPTION_IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return `${iv.toString('hex')}${EMAIL_PASSWORD_DELIMITER}${encrypted.toString('hex')}`;
};
const decryptSecret = (text: string) => {
    const parts = text.split(EMAIL_PASSWORD_DELIMITER);
    if (parts.length !== 2) throw new Error('Неверный формат секрета');
    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = Buffer.from(parts[1], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    const decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()]);
    return decrypted.toString('utf8');
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
const SMART_HOME_ALLOWED_IDS = (() => {
    const ids = new Set<number>();

    for (const raw of parseCsv(process.env.SMART_HOME_ALLOWED_IDS)) {
        const id = parseAdminId(raw);
        if (id) ids.add(id);
    }

    const singleId = parseAdminId(process.env.SMART_HOME_ALLOWED_ID);
    if (singleId) ids.add(singleId);

    for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith('SMART_HOME_ALLOWED_ID_')) continue;
        const id = parseAdminId(value);
        if (id) ids.add(id);
    }

    return ids;
})();

const SMART_HOME_DEVICES_FALLBACK: Record<string, string[]> = {
    'свет': [
        '20c0fb1b-f5e4-4daf-b121-0ee0fb326586',
        '619facb9-4ce8-4ed6-b66a-923f01c8e0a4',
        'e3d027ee-3ca4-4776-9e92-f23c7e6dc926'
    ],
    'увлажнитель': [
        '65b9c366-cb0c-4dfd-8624-1473a811752f'
    ]
};

const SMART_HOME_DEVICES: Record<string, string[]> = (() => {
    const devices: Record<string, string[]> = {};
    for (const [alias, ids] of Object.entries(SMART_HOME_DEVICES_FALLBACK)) {
        devices[normalizeDeviceAlias(alias)] = ids.map(id => id.trim()).filter(Boolean);
    }

    const jsonRaw = process.env.SMART_HOME_DEVICES_JSON;
    if (jsonRaw) {
        try {
            const parsed = JSON.parse(jsonRaw) as Record<string, string[] | string>;
            for (const [alias, value] of Object.entries(parsed)) {
                const ids = Array.isArray(value) ? value.map(v => `${v}`.trim()).filter(Boolean) : parseCsv(`${value}`);
                if (!ids.length) continue;
                devices[normalizeDeviceAlias(alias)] = ids;
            }
        } catch (err) {
            console.warn('SMART_HOME_DEVICES_JSON имеет неверный JSON-формат');
        }
    }

    for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith('SMART_HOME_DEVICE_')) continue;
        const alias = normalizeDeviceAlias(key.replace('SMART_HOME_DEVICE_', '').replace(/__/g, '-').replace(/_/g, ' '));
        const ids = parseCsv(value);
        if (!ids.length) continue;
        devices[alias] = ids;
    }

    return devices;
})();
const SMART_HOME_DEVICE_NAMES = Object.keys(SMART_HOME_DEVICES);
const SMART_HOME_DEVICE_OPTIONS_TEXT = SMART_HOME_DEVICE_NAMES.length
    ? SMART_HOME_DEVICE_NAMES.join(', ')
    : 'не настроены (добавь SMART_HOME_DEVICE_* в .env)';
const canUserControlSmartHome = (userId: number) => ADMIN_IDS.has(userId) || SMART_HOME_ALLOWED_IDS.has(userId);

const tools = [
    {
        type: 'function',
        function: {
            name: 'search_web',
            description: 'Поиск актуальной/проверяемой информации в интернете. Используй, когда нужны свежие данные или факты из сети. После вызова опирайся на результаты поиска в ответе.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Поисковый запрос'
                    }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'control_smart_home',
            description: 'Управляет устройствами умного дома. Используй ТОЛЬКО при явной просьбе включить/выключить устройство или изменить цвет/яркость.',
            parameters: {
                type: 'object',
                properties: {
                    device_name: {
                        type: 'string',
                        description: `Название устройства. Доступные варианты: ${SMART_HOME_DEVICE_OPTIONS_TEXT}.`
                    },
                    action: {
                        type: 'string',
                        enum: ['on', 'off', 'set_color', 'set_brightness'],
                        description: 'on - включить, off - выключить, set_color - изменить цвет, set_brightness - изменить яркость.'
                    },
                    color: {
                        type: 'string',
                        description: 'Цвет в формате #RRGGBB или имя цвета (красный, синий и т.д.). Только для set_color.'
                    },
                    brightness: {
                        type: 'number',
                        description: 'Уровень яркости от 1 до 100. Используется только с action=set_brightness.'
                    }
                },
                required: ['device_name', 'action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'schedule_task',
            description: 'Создает задачу по времени (одноразовую или по расписанию): напоминания, отложенные команды дома, запланированный веб-поиск, регулярная проверка почты. Для времени предпочитай local_time (HH:MM) или delay_seconds, не вычисляй Unix timestamp вручную.',
            parameters: {
                type: 'object',
                properties: {
                    local_time: {
                        type: 'string',
                        description: 'Локальное время пользователя в формате HH:MM, например 02:07.'
                    },
                    delay_seconds: {
                        type: 'number',
                        description: 'Задержка в секундах от текущего момента, например 60.'
                    },
                    execute_at: {
                        type: 'number',
                        description: 'Legacy-поле: Unix timestamp в секундах. Используй только если local_time/delay_seconds не подходят.'
                    },
                    task_type: {
                        type: 'string',
                        enum: ['message', 'smart_home', 'web_search', 'email_check'],
                        description: 'message - напоминание, smart_home - команда умного дома, web_search - запланированный поиск в интернете, email_check - запланированная проверка почты.'
                    },
                    payload: {
                        type: 'string',
                        description: 'Для message: текст. Для smart_home: JSON-строка с параметрами умного дома. Для web_search: поисковый запрос. Для email_check: JSON-строка {"provider":"yandex|google","search_query":"...", "limit":10, "offset":10, "date_from":"2026-04-01","date_to":"2026-04-30"} или просто строка запроса.'
                    },
                    recurrence_type: {
                        type: 'string',
                        enum: ['once', 'daily', 'weekly'],
                        description: 'Тип расписания: once - один раз, daily - каждый день, weekly - каждую неделю.'
                    },
                    recurrence_weekday: {
                        type: 'number',
                        description: 'День недели для weekly: 1=понедельник ... 7=воскресенье.'
                    },
                    notify_mode: {
                        type: 'string',
                        enum: ['always', 'never', 'on_match'],
                        description: 'Режим уведомлений: always - всегда писать о результате, never - никогда не писать, on_match - писать только если результат содержит notify_condition.'
                    },
                    notify_condition: {
                        type: 'string',
                        description: 'Условие-триггер для notify_mode=on_match. Если строка найдена в результате, бот отправит уведомление.'
                    }
                },
                required: ['task_type', 'payload']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_user_timezone',
            description: 'Устанавливает часовой пояс пользователя. Передай timezone_offset напрямую или location/city/country для автоопределения по локации.',
            parameters: {
                type: 'object',
                properties: {
                    timezone_offset: {
                        type: 'number',
                        description: 'Смещение от UTC (целое число от -12 до +14). Если известно — передай его.'
                    },
                    location: {
                        type: 'string',
                        description: 'Локация в свободной форме, например: "Город, Страна".'
                    },
                    city: {
                        type: 'string',
                        description: 'Город пользователя, если отдельно.'
                    },
                    country: {
                        type: 'string',
                        description: 'Страна пользователя, если отдельно.'
                    }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_my_tasks',
            description: 'Возвращает список задач текущего пользователя. Никогда не запрашивай задачи другого пользователя.',
            parameters: {
                type: 'object',
                properties: {
                    status: {
                        type: 'string',
                        enum: ['pending', 'done', 'error', 'all'],
                        description: 'Фильтр по статусу задач.'
                    },
                    limit: {
                        type: 'number',
                        description: 'Сколько задач вернуть, от 1 до 50.'
                    }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'delete_my_task',
            description: 'Удаляет ОДНУ активную задачу текущего пользователя по точному ID (для отмены конкретного напоминания/задачи) и возвращает обновлённый список.',
            parameters: {
                type: 'object',
                properties: {
                    task_id: {
                        type: 'number',
                        description: 'ID задачи для удаления.'
                    }
                },
                required: ['task_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'check_emails',
            description: 'Ищет письма в почте пользователя: последние входящие, поиск по отправителю/теме/ключевому слову, фильтр по датам, пагинация. Если пользователь явно указывает yandex/google — передавай provider.',
            parameters: {
                type: 'object',
                properties: {
                    provider: {
                        type: 'string',
                        enum: ['yandex', 'google'],
                        description: 'Какой ящик использовать.'
                    },
                    search_query: {
                        type: 'string',
                        description: 'Поисковая строка (имя, домен, тема, ключевое слово).'
                    },
                    date_from: {
                        type: 'string',
                        description: 'Начальная дата (включительно) в формате YYYY-MM-DD.'
                    },
                    date_to: {
                        type: 'string',
                        description: 'Конечная дата (включительно) в формате YYYY-MM-DD.'
                    },
                    limit: {
                        type: 'number',
                        description: 'Количество результатов. Если не указано, берётся пользовательский лимит из настроек почты.'
                    },
                    offset: {
                        type: 'number',
                        description: 'Сдвиг для пагинации. Пример: сначала offset=0, потом offset=10 для следующих 10 писем.'
                    }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_email_content',
            description: 'Читает содержимое конкретного письма по части темы. Обычно используй после check_emails, когда нужно открыть найденное письмо.',
            parameters: {
                type: 'object',
                properties: {
                    provider: {
                        type: 'string',
                        enum: ['yandex', 'google'],
                        description: 'Какой ящик использовать.'
                    },
                    subject_part: {
                        type: 'string',
                        description: 'Часть темы письма для поиска.'
                    }
                },
                required: ['subject_part']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'send_email',
            description: 'Отправляет письмо от имени пользователя. Используй, когда пользователь явно просит отправить email. Если пользователь явно указывает yandex/google — передавай provider.',
            parameters: {
                type: 'object',
                properties: {
                    provider: {
                        type: 'string',
                        enum: ['yandex', 'google'],
                        description: 'Какой ящик использовать.'
                    },
                    to: {
                        type: 'string',
                        description: 'Email получателя.'
                    },
                    subject: {
                        type: 'string',
                        description: 'Тема письма.'
                    },
                    body: {
                        type: 'string',
                        description: 'Текст письма. Можно передавать HTML-разметку (<b>, <h1>, <ul>, <a> и т.д.) для красивого письма.'
                    }
                },
                required: ['to', 'subject', 'body']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'save_note',
            description: 'Сохраняет запись в личную записную книжку пользователя. Используй, когда пользователь просит "запиши"/"сохрани в заметки". Это заметки, а не долговременная память.',
            parameters: {
                type: 'object',
                properties: {
                    title: {
                        type: 'string',
                        description: 'Короткий заголовок заметки (необязательно).'
                    },
                    content: {
                        type: 'string',
                        description: 'Текст заметки, который нужно сохранить.'
                    }
                },
                required: ['content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_my_notes',
            description: 'Показывает заметки пользователя из записной книжки. Поддерживает поиск и пагинацию.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Поисковая строка по заголовку и тексту.'
                    },
                    limit: {
                        type: 'number',
                        description: 'Сколько заметок вернуть за запрос (1..50).'
                    },
                    offset: {
                        type: 'number',
                        description: 'Сдвиг для пагинации. Пример: 0, затем 10.'
                    }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_note',
            description: 'Читает одну заметку пользователя целиком по точному ID.',
            parameters: {
                type: 'object',
                properties: {
                    note_id: {
                        type: 'number',
                        description: 'ID заметки.'
                    }
                },
                required: ['note_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'delete_note',
            description: 'Удаляет одну заметку пользователя по точному ID и возвращает обновлённый список.',
            parameters: {
                type: 'object',
                properties: {
                    note_id: {
                        type: 'number',
                        description: 'ID заметки для удаления.'
                    }
                },
                required: ['note_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'update_core_memory',
            description: 'Критически важная долговременная память о пользователе. Используй ТОЛЬКО для важных биографических фактов (возраст, профессия, семья, переезд, устойчивые долгосрочные предпочтения). Не используй для рутины или одноразовых событий. Для записей в блокнот используй save_note.',
            parameters: {
                type: 'object',
                properties: {
                    new_fact: {
                        type: 'string',
                        description: 'Новый важный факт о пользователе, кратко и конкретно.'
                    },
                    explicit_request: {
                        type: 'boolean',
                        description: 'true, если пользователь явно попросил "запомни".'
                    }
                },
                required: ['new_fact']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'random_roll',
            description: 'Случайный бросок: монетка или кубики (d4,d6,d8,d10,d12,d20,d100). Используй для запросов "подбрось монетку/брось кубик/случайный результат". Для кубиков поддерживает обычный режим, преимущество и помеху.',
            parameters: {
                type: 'object',
                properties: {
                    roll_type: {
                        type: 'string',
                        enum: ['coin', 'dice'],
                        description: 'coin - монетка, dice - кубики.'
                    },
                    dice_notation: {
                        type: 'string',
                        description: 'Нотация кубиков, например: 1d20, 2d6+3, 2д20 + 5.'
                    },
                    mode: {
                        type: 'string',
                        enum: ['normal', 'advantage', 'disadvantage'],
                        description: 'Режим для dice: обычный, с преимуществом, с помехой.'
                    }
                },
                required: ['roll_type']
            }
        }
    }
] as const;
const ESCALATE_TO_PRO_TOOL = {
    type: 'function',
    function: {
        name: 'escalate_to_pro',
        description: 'Используй ТОЛЬКО если запрос требует глубокого анализа, творческого мышления, сложного структурирования, написания кода или длинного рассказа. Передай исходный запрос пользователя.',
        parameters: {
            type: 'object',
            properties: {
                original_query: {
                    type: 'string',
                    description: 'Изначальный запрос пользователя для передачи в старшую модель.'
                }
            },
            required: ['original_query']
        }
    }
} as const;

type ChatRole = 'user' | 'assistant';
type UserStatus = 'none' | 'approved' | 'disapproved' | 'banned';
type MailProvider = 'yandex' | 'google';
type ChatMessage = { role: ChatRole; content: string };
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
    context_window: number;
    context_window_max: number;
};
type PlanDurationCode = 'day' | 'week' | 'month' | 'year' | 'forever';
type TaskStatus = 'pending' | 'done' | 'error';
type TaskType = 'message' | 'smart_home' | 'web_search' | 'email_check';
type TaskRecurrenceType = 'once' | 'daily' | 'weekly';
type TaskNotifyMode = 'always' | 'never' | 'on_match';
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
type MenuActionId = 'clear' | 'users' | 'rename' | 'add' | 'remove' | 'prompts' | 'current_prompt' | 'context_size' | 'prompt_admin' | 'pending' | 'banned' | 'mail' | 'notes' | 'help';
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
        await ctx.reply(tgFormattedText, { parse_mode: 'Markdown' });
    } catch (err) {
        console.warn('Ошибка разметки, отправляю чистый текст');
        await ctx.reply(text);
    }
};

const runWebSearch = async (query: string) => {
    try {
        const response = await tvly.search(query, {
            searchDepth: 'basic',
            maxResults: 3,
            includeAnswer: true
        });

        if (!response.results.length) {
            return `По запросу "${query}" ничего не найдено.`;
        }

        let resultText = response.answer ? `Сводка: ${response.answer}\n\n` : '';

        resultText += response.results.map((item, index) => {
            return `${index + 1}. ${item.title}\n${item.content}\nИсточник: ${item.url}`;
        }).join('\n\n');

        return resultText;
    } catch (err) {
        console.error('Ошибка Tavily API:', err);
        return 'Ошибка инструмента: поисковый сервис временно недоступен.';
    }
};

const COLOR_NAME_TO_HEX: Record<string, string> = {
    red: '#FF0000',
    green: '#00FF00',
    blue: '#0000FF',
    white: '#FFFFFF',
    black: '#000000',
    yellow: '#FFFF00',
    purple: '#800080',
    violet: '#800080',
    pink: '#FFC0CB',
    orange: '#FFA500',
    cyan: '#00FFFF',
    teal: '#008080',
    warmwhite: '#FFD8A8',
    coolwhite: '#DCEBFF',
    'красный': '#FF0000',
    'зеленый': '#00FF00',
    'зелёный': '#00FF00',
    'синий': '#0000FF',
    'белый': '#FFFFFF',
    'черный': '#000000',
    'чёрный': '#000000',
    'желтый': '#FFFF00',
    'жёлтый': '#FFFF00',
    'фиолетовый': '#800080',
    'розовый': '#FFC0CB',
    'оранжевый': '#FFA500',
    'голубой': '#00FFFF',
    'бирюзовый': '#00FFFF',
    'теплый белый': '#FFD8A8',
    'тёплый белый': '#FFD8A8',
    'холодный белый': '#DCEBFF'
};

const parseColorToHsv = (value: string) => {
    const normalized = value.trim().toLowerCase();
    const mapped = COLOR_NAME_TO_HEX[normalized] || normalized;
    const compact = mapped.replace(/\s+/g, '');

    if (!/^#?[0-9a-f]{6}$/i.test(compact)) return null;
    const hex = compact.startsWith('#') ? compact.slice(1) : compact;

    const r = Number.parseInt(hex.slice(0, 2), 16) / 255;
    const g = Number.parseInt(hex.slice(2, 4), 16) / 255;
    const b = Number.parseInt(hex.slice(4, 6), 16) / 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;

    let h = 0;
    const s = max === 0 ? 0 : d / max;
    const v = max;

    if (max !== min) {
        switch (max) {
            case r:
                h = (g - b) / d + (g < b ? 6 : 0);
                break;
            case g:
                h = (b - r) / d + 2;
                break;
            case b:
                h = (r - g) / d + 4;
                break;
        }
        h /= 6;
    }

    return {
        h: Math.round(h * 360),
        s: Math.round(s * 100),
        v: Math.round(v * 100)
    };
};

type SmartHomeAction = 'on' | 'off' | 'set_color' | 'set_brightness';
type SmartHomeArgs = {
    device_name?: string;
    action?: SmartHomeAction;
    color?: string;
    brightness?: number;
};
type SetTimezoneArgs = {
    timezone_offset?: number;
    location?: string;
    city?: string;
    country?: string;
};
type RandomRollMode = 'normal' | 'advantage' | 'disadvantage';
type RandomRollArgs = {
    roll_type?: 'coin' | 'dice';
    dice_notation?: string;
    mode?: RandomRollMode;
};
type ScheduleTaskArgs = {
    local_time?: string;
    delay_seconds?: number;
    execute_at?: number;
    task_type?: TaskType;
    payload?: string;
    recurrence_type?: TaskRecurrenceType;
    recurrence_weekday?: number;
    notify_mode?: TaskNotifyMode;
    notify_condition?: string;
};
type DeleteTaskArgs = {
    task_id?: number;
};
type UpdateCoreMemoryArgs = {
    new_fact?: string;
    explicit_request?: boolean;
};
type CheckEmailsArgs = {
    provider?: MailProvider;
    search_query?: string;
    date_from?: string;
    date_to?: string;
    limit?: number;
    offset?: number;
};
type ReadEmailContentArgs = {
    provider?: MailProvider;
    subject_part?: string;
};
type SendEmailArgs = {
    provider?: MailProvider;
    to?: string;
    subject?: string;
    body?: string;
};
type SaveNoteArgs = {
    content?: string;
    title?: string;
};
type ListMyNotesArgs = {
    query?: string;
    limit?: number;
    offset?: number;
};
type ReadNoteArgs = {
    note_id?: number;
};
type DeleteNoteArgs = {
    note_id?: number;
};
type VoiceTranscribeResponse = {
    text?: string;
};

const clampTimezoneOffset = (offset: number) => {
    if (!Number.isFinite(offset)) return null;
    const rounded = Math.round(offset);
    if (rounded < -12 || rounded > 14) return null;
    return rounded;
};

const parseUtcOffsetFromText = (raw: string) => {
    const text = raw.trim().toLowerCase();
    const utcMatch = text.match(/utc\s*([+-]\s*\d{1,2})/i);
    if (utcMatch) {
        const value = Number.parseInt(utcMatch[1].replace(/\s+/g, ''), 10);
        return clampTimezoneOffset(value);
    }

    const gmtMatch = text.match(/gmt\s*([+-]\s*\d{1,2})/i);
    if (gmtMatch) {
        const value = Number.parseInt(gmtMatch[1].replace(/\s+/g, ''), 10);
        return clampTimezoneOffset(value);
    }

    return null;
};

const estimateOffsetByLongitude = (longitude: number) => {
    const estimated = Math.round(longitude / 15);
    if (estimated < -12) return -12;
    if (estimated > 14) return 14;
    return estimated;
};

const resolveOffsetFromLocationText = async (locationText: string) => {
    const inlineOffset = parseUtcOffsetFromText(locationText);
    if (inlineOffset !== null) return inlineOffset;

    try {
        const endpoint = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(locationText)}`;
        const response = await fetch(endpoint, {
            headers: { 'User-Agent': 'chatter-bot/1.0 (timezone resolver)' }
        });
        if (!response.ok) return null;
        const data = await response.json() as Array<{ lon?: string }>;
        const lon = Number.parseFloat(data?.[0]?.lon ?? '');
        if (!Number.isFinite(lon)) return null;
        return estimateOffsetByLongitude(lon);
    } catch (err) {
        return null;
    }
};

const runSetUserTimezone = async (userId: number, args: SetTimezoneArgs) => {
    let resolvedOffset: number | null = null;

    if (typeof args.timezone_offset === 'number') {
        resolvedOffset = clampTimezoneOffset(args.timezone_offset);
    }

    if (resolvedOffset === null) {
        const locationText = [
            args.location?.trim(),
            args.city?.trim(),
            args.country?.trim()
        ].filter(Boolean).join(', ');

        if (locationText) {
            resolvedOffset = await resolveOffsetFromLocationText(locationText);
        }
    }

    if (resolvedOffset === null) {
        return 'Не удалось определить часовой пояс. Попроси пользователя указать смещение явно, например: UTC+7.';
    }

    updateUserTimezone(userId, resolvedOffset);
    const sign = resolvedOffset >= 0 ? '+' : '';
    return `Часовой пояс пользователя установлен: UTC${sign}${resolvedOffset}.`;
};

const ALLOWED_DICE_SIDES = new Set([4, 6, 8, 10, 12, 20, 100]);
const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

const parseDiceNotation = (notation: string) => {
    const normalized = notation.replace(/\s+/g, '').toLowerCase().replace('д', 'd');
    const match = normalized.match(/^(\d{1,3})d(4|6|8|10|12|20|100)([+-]\d{1,4})?$/);
    if (!match) return null;

    const count = Number.parseInt(match[1], 10);
    const sides = Number.parseInt(match[2], 10);
    const modifier = match[3] ? Number.parseInt(match[3], 10) : 0;

    if (!Number.isFinite(count) || count <= 0 || count > 100) return null;
    if (!ALLOWED_DICE_SIDES.has(sides)) return null;
    if (!Number.isFinite(modifier) || Math.abs(modifier) > 10000) return null;

    return { count, sides, modifier, normalized };
};

const rollDiceExpression = (count: number, sides: number, modifier: number) => {
    const rolls = Array.from({ length: count }, () => randomInt(1, sides));
    const rollsSum = rolls.reduce((acc, value) => acc + value, 0);
    const total = rollsSum + modifier;
    return { rolls, rollsSum, modifier, total };
};

const formatRollLine = (roll: { rolls: number[]; rollsSum: number; modifier: number; total: number }) => {
    const modifierText = roll.modifier === 0 ? '' : roll.modifier > 0 ? ` + ${roll.modifier}` : ` - ${Math.abs(roll.modifier)}`;
    return `броски [${roll.rolls.join(', ')}] => ${roll.rollsSum}${modifierText} = ${roll.total}`;
};

const runRandomRoll = (args: RandomRollArgs) => {
    const rollType = args.roll_type;
    if (rollType !== 'coin' && rollType !== 'dice') {
        return 'Ошибка инструмента: roll_type должен быть coin или dice.';
    }

    if (rollType === 'coin') {
        const side = Math.random() < 0.5 ? 'Орёл' : 'Решка';
        return `Монетка: ${side}.`;
    }

    const parsed = parseDiceNotation(args.dice_notation || '');
    if (!parsed) {
        return 'Ошибка инструмента: некорректная нотация кубиков. Пример: 2d20+5.';
    }

    const mode: RandomRollMode = args.mode && ['normal', 'advantage', 'disadvantage'].includes(args.mode)
        ? args.mode
        : 'normal';

    if (mode === 'normal') {
        const roll = rollDiceExpression(parsed.count, parsed.sides, parsed.modifier);
        return `Кубики ${parsed.normalized}: ${formatRollLine(roll)}.`;
    }

    const first = rollDiceExpression(parsed.count, parsed.sides, parsed.modifier);
    const second = rollDiceExpression(parsed.count, parsed.sides, parsed.modifier);
    const pickMax = mode === 'advantage';
    const chosen = pickMax
        ? (first.total >= second.total ? first : second)
        : (first.total <= second.total ? first : second);
    const modeText = pickMax ? 'преимущество' : 'помеха';

    return `Кубики ${parsed.normalized} (${modeText}):
1) ${formatRollLine(first)}
2) ${formatRollLine(second)}
Итог: ${chosen.total}.`;
};

const safeSendToUser = async (chatId: number, text: string) => {
    try {
        await bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (err) {
        await bot.telegram.sendMessage(chatId, text);
    }
};

const runCoreMemoryMerge = async (userId: number, newFact: string, explicitRequest: boolean) => {
    const user = getUser(userId);
    if (!user) {
        return 'Ошибка памяти: пользователь не найден.';
    }

    const fact = newFact.trim();
    if (!fact) {
        return 'Ошибка памяти: пустой факт.';
    }

    const currentMemory = (user.core_memory || '').trim();
    const mergePrompt = `Ты — безжалостный редактор памяти ИИ-ассистента.
Твоя задача: обновить профиль пользователя, интегрировав в него новый факт.

ТЕКУЩАЯ ПАМЯТЬ:
${currentMemory || '(пусто)'}

НОВЫЙ ФАКТ:
${fact}

КОНТЕКСТ:
- Явный запрос "запомни": ${explicitRequest ? 'да' : 'нет'}.
- Если факт явно незначительный и explicitRequest=нет — можешь оставить память без изменений.

ПРАВИЛА:
1. ЖЕСТКИЙ ЛИМИТ: ровно ${MAX_CORE_MEMORY_LENGTH} символов максимум. Если превышаешь — удаляй самую старую и наименее важную информацию (оставляй ядро: кто он, где живет, кем работает, близкие люди).
2. СТИЛЬ: телеграфный. Никаких полных предложений. Используй списки, сокращения, теги.
3. Дедупликация: если новый факт конфликтует со старым (например, сменил город/работу) — удаляй старый.
4. В ответе выдай ТОЛЬКО новый текст памяти, без комментариев и JSON.`;

    let mergedMemory = currentMemory;
    let action: 'updated' | 'unchanged' = 'unchanged';
    let reason = 'без комментария';

    try {
        const mergeResponse = await ai.chat.completions.create({
            model: MODEL_NAME,
            messages: [
                { role: 'system', content: 'Ты аккуратный модуль памяти. Верни только готовый текст памяти.' },
                { role: 'user', content: mergePrompt }
            ]
        });
        const mergeTokens = extractTotalTokens(mergeResponse);
        if (mergeTokens > 0) {
            incrementUserTokenUsage(userId, mergeTokens);
        }

        const raw = mergeResponse.choices[0]?.message?.content?.trim() || '';
        mergedMemory = raw || currentMemory;
        if (mergedMemory.length > MAX_CORE_MEMORY_LENGTH) {
            mergedMemory = mergedMemory.slice(0, MAX_CORE_MEMORY_LENGTH).trim();
        }
        action = mergedMemory === currentMemory ? 'unchanged' : 'updated';
        reason = 'merge-модель';
    } catch (err) {
        console.warn('Ошибка merge core_memory, применяю fallback:', err);
        const fallbackCandidate = currentMemory
            ? `${currentMemory}\n- ${fact}`
            : `- ${fact}`;
        mergedMemory = fallbackCandidate.slice(0, MAX_CORE_MEMORY_LENGTH).trim();
        action = mergedMemory === currentMemory ? 'unchanged' : 'updated';
        reason = 'fallback-слияние';
    }

    if (mergedMemory !== currentMemory) {
        updateUserCoreMemory(userId, mergedMemory);
    }

    return `Память: ${action}.
Причина: ${reason}.
Текущая длина памяти: ${mergedMemory.length}/${MAX_CORE_MEMORY_LENGTH}.
Текущая память:
${mergedMemory || '(пусто)'}`;
};

const runScheduledWebSearchTask = async (task: TaskRecord) => {
    const query = task.payload.trim();
    if (!query) {
        return 'Не получилось выполнить поиск: пустой запрос в задаче.';
    }

    const webLimitState = checkWebSearchLimit(task.user_id);
    if (!webLimitState.allowed) {
        return `Запрос: ${query}\n\n${webLimitState.reason}`;
    }

    incrementUserWebSearchUsage(task.user_id, 1);
    const webResult = await runWebSearch(query);
    const userRecord = getUser(task.user_id);

    if (!userRecord) {
        return `Запрос: ${query}\n\n${webResult}`;
    }

    const userName = userRecord.name || userRecord.tg_username || 'Пользователь';
    const activePrompt = resolvePromptForUser(userRecord);
    const timezoneOffset = typeof userRecord.timezone_offset === 'number' ? userRecord.timezone_offset : 5;
    const systemPrompt = `${buildSystemPrompt(activePrompt.content, userName, userRecord.core_memory || '')}${buildTimeContext(timezoneOffset)}`;

    try {
        const aiResponse = await ai.chat.completions.create({
            model: MODEL_NAME,
            messages: [
                { role: 'system', content: systemPrompt },
                {
                    role: 'user',
                    content: `Сработала отложенная задача веб-поиска.
Запрос пользователя: "${query}".

Результаты поиска:
${webResult}

Сформулируй итог для пользователя на русском языке: кратко и по делу, 3-6 пунктов, затем блок "Источники:" с ссылками, если они есть. Если данные неполные или есть ошибки, сообщи это честно.`
                }
            ]
        });
        const totalTokens = extractTotalTokens(aiResponse);
        if (totalTokens > 0) {
            incrementUserTokenUsage(task.user_id, totalTokens);
        }

        const finalText = aiResponse.choices[0]?.message?.content?.trim();
        if (!finalText) {
            return `Запрос: ${query}\n\n${webResult}`;
        }

        return finalText;
    } catch (err) {
        console.error('Ошибка генерации ответа для запланированного web_search:', err);
        return `Запрос: ${query}\n\n${webResult}`;
    }
};

const handleAiDirectMessage = async (ctx: any, targetUserId: number, instruction: string) => {
    const targetUser = getUser(targetUserId);
    if (!targetUser) {
        await ctx.reply('Юзер не найден в базе.');
        return;
    }

    const thought = instruction.trim();
    if (!thought) {
        await ctx.reply('Пустое сообщение. Напиши, что нужно передать.');
        return;
    }

    await ctx.reply('⏳ Нейросеть формулирует послание...');

    const targetPrompt = resolvePromptForUser(targetUser);
    const targetUserName = targetUser.name || targetUser.tg_username || 'Друг';
    const systemPrompt = buildSystemPrompt(targetPrompt.content, targetUserName, targetUser.core_memory || '');
    const aiTask = `[СИСТЕМНОЕ ЗАДАНИЕ ОТ АДМИНА]: Администратор просит передать этому пользователю информацию.
Твоя задача: взять "мысль админа" и написать сообщение от своего лица, строго сохраняя свой текущий характер и стиль, заданный в системном промпте.
НЕ пиши "Админ просил передать", просто вплети эту мысль в разговор от себя.
Выведи ТОЛЬКО готовый текст сообщения для юзера, без подтверждений и лишних слов.

Мысль админа: "${thought}"`;

    try {
        const response = await ai.chat.completions.create({
            model: MODEL_NAME,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: aiTask }
            ]
        });
        const totalTokens = extractTotalTokens(response);
        if (totalTokens > 0) {
            incrementUserTokenUsage(targetUserId, totalTokens);
        }

        const finalMessage = response.choices[0].message.content?.trim();
        if (!finalMessage) {
            await ctx.reply('❌ Не получилось сгенерировать текст, попробуй ещё раз.');
            return;
        }

        await safeSendToUser(targetUserId, finalMessage);
        addHistoryMessage(targetUserId, 'assistant', finalMessage);
        trimUserHistory(targetUserId);
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

const formatTaskForDisplay = (task: TaskRecord) => {
    const payloadPreview = task.payload.length > 140 ? `${task.payload.slice(0, 140)}...` : task.payload;
    const recurrence = formatRecurrenceForDisplay(task);
    const fallbackOffset = getUser(task.user_id)?.timezone_offset ?? 5;
    const timezoneOffset = typeof task.timezone_offset === 'number' ? task.timezone_offset : fallbackOffset;
    const when = formatUnixForTimezone(task.execute_at, timezoneOffset);
    const notifyText = task.notify_mode === 'on_match'
        ? `on_match: ${task.notify_condition || '(пусто)'}`
        : task.notify_mode;
    return `#${task.id} | ${task.task_type} | ${task.status}\nКогда: ${when.local} (${when.tzLabel})\nКогда (UTC): ${when.utc} UTC\nРасписание: ${recurrence}\nУведомления: ${notifyText}\nДанные: ${payloadPreview}`;
};

const formatTasksList = (tasks: TaskRecord[], emptyText = 'Задач не найдено.') => (
    tasks.length ? tasks.map(formatTaskForDisplay).join('\n\n') : emptyText
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

const computeNextRecurringExecuteAt = (task: TaskRecord) => {
    if (task.recurrence_type === 'once') return null;

    const fallbackOffset = getUser(task.user_id)?.timezone_offset ?? 5;
    const timezoneOffset = typeof task.timezone_offset === 'number' ? task.timezone_offset : fallbackOffset;
    const localDate = new Date((task.execute_at + timezoneOffset * 3600) * 1000);
    const nowUnix = Math.floor(Date.now() / 1000);

    if (task.recurrence_type === 'daily') {
        do {
            localDate.setUTCDate(localDate.getUTCDate() + 1);
        } while (Math.floor(localDate.getTime() / 1000 - timezoneOffset * 3600) <= nowUnix);
        return Math.floor(localDate.getTime() / 1000 - timezoneOffset * 3600);
    }

    if (task.recurrence_type === 'weekly') {
        const targetWeekday = task.recurrence_weekday;
        if (!targetWeekday || targetWeekday < 1 || targetWeekday > 7) return null;
        const currentWeekday = getIsoWeekday(localDate);
        let deltaDays = (targetWeekday - currentWeekday + 7) % 7;
        if (deltaDays === 0) deltaDays = 7;
        localDate.setUTCDate(localDate.getUTCDate() + deltaDays);
        while (Math.floor(localDate.getTime() / 1000 - timezoneOffset * 3600) <= nowUnix) {
            localDate.setUTCDate(localDate.getUTCDate() + 7);
        }
        return Math.floor(localDate.getTime() / 1000 - timezoneOffset * 3600);
    }

    return null;
};

const shouldNotifyTaskResult = (task: TaskRecord, resultText: string) => {
    if (task.notify_mode === 'never') return false;
    if (task.notify_mode === 'always') return true;
    const condition = (task.notify_condition || '').trim().toLowerCase();
    if (!condition) return false;
    return resultText.toLowerCase().includes(condition);
};

const scheduleDailyCounterReset = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(24, 0, 0, 0);
    const delay = Math.max(1000, next.getTime() - now.getTime());

    setTimeout(() => {
        try {
            resetDailyMessageCounters();
            console.log('Дневные счётчики (сообщения/токены/стоимость) обнулены.');
        } catch (err) {
            console.error('Ошибка ежедневного сброса счётчиков:', err);
        } finally {
            scheduleDailyCounterReset();
        }
    }, delay);
};

const runSmartHomeControl = async (userId: number, args: SmartHomeArgs) => {
    if (!canUserControlSmartHome(userId)) {
        return 'Ошибка доступа: у тебя нет прав на управление умным домом.';
    }

    if (!process.env.YANDEX_IOT_TOKEN) {
        return 'Ошибка конфигурации: не задан YANDEX_IOT_TOKEN.';
    }

    const deviceName = normalizeDeviceAlias(args.device_name || '');
    if (!deviceName) {
        return 'Ошибка инструмента: не передано имя устройства.';
    }

    const deviceIds = SMART_HOME_DEVICES[deviceName];
    if (!deviceIds?.length) {
        return `Ошибка: устройство "${args.device_name}" не найдено.`;
    }

    const action = args.action;
    if (!action || !['on', 'off', 'set_color', 'set_brightness'].includes(action)) {
        return 'Ошибка инструмента: неизвестное действие.';
    }

    const onOffPayload = (value: boolean) => ({
        type: 'devices.capabilities.on_off',
        state: { instance: 'on', value }
    });
    const colorPayload = (hsv: { h: number; s: number; v: number }) => ({
        type: 'devices.capabilities.color_setting',
        state: { instance: 'hsv', value: hsv }
    });
    const brightnessPayload = (value: number) => ({
        type: 'devices.capabilities.range',
        state: { instance: 'brightness', value }
    });

    let actionsPayload: any[] = [];
    let brightnessValue: number | null = null;
    if (action === 'on') actionsPayload = [onOffPayload(true)];
    if (action === 'off') actionsPayload = [onOffPayload(false)];
    if (action === 'set_color') {
        if (!args.color) return 'Ошибка инструмента: для set_color нужен параметр color.';
        const hsv = parseColorToHsv(args.color);
        if (hsv === null) return `Ошибка инструмента: не удалось распознать цвет "${args.color}".`;
        actionsPayload = [onOffPayload(true), colorPayload(hsv)];
    }
    if (action === 'set_brightness') {
        if (args.brightness === undefined) return 'Ошибка инструмента: для set_brightness нужен параметр brightness.';
        let br = Number(args.brightness);
        if (Number.isNaN(br)) br = 100;
        if (br < 1) br = 1;
        if (br > 100) br = 100;
        brightnessValue = br;
        actionsPayload = [onOffPayload(true), brightnessPayload(br)];
    }

    const devicesPayload = deviceIds.map(id => ({
        id,
        actions: actionsPayload
    }));

    try {
        const response = await fetch('https://api.iot.yandex.net/v1.0/devices/actions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.YANDEX_IOT_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ devices: devicesPayload })
        });

        const raw = await response.text();
        let data: any = {};
        try {
            data = raw ? JSON.parse(raw) : {};
        } catch (err) {
            data = { raw };
        }

        if (!response.ok) {
            return `Ошибка API Яндекса (${response.status}): ${raw || 'пустой ответ'}`;
        }

        const devices = Array.isArray(data?.devices) ? data.devices : [];
        const failed = devices.filter((device: any) =>
            Array.isArray(device?.capabilities)
            && device.capabilities.some((cap: any) => cap?.state?.action_result?.status === 'ERROR')
        );

        if (failed.length) {
            const failedIds = failed.map((item: any) => item?.id).filter(Boolean).join(', ');
            return `Команда выполнена частично. Ошибка у устройств: ${failedIds || 'неизвестно'}.`;
        }

        const actionText = action === 'on'
            ? 'включено'
            : action === 'off'
                ? 'выключено'
                : action === 'set_color'
                    ? `цвет изменен на ${args.color}`
                    : `яркость установлена на ${brightnessValue ?? args.brightness}%`;
        return `Успешно: "${args.device_name}" -> ${actionText}.`;
    } catch (err) {
        return `Техническая ошибка при управлении умным домом: ${err instanceof Error ? err.message : String(err)}`;
    }
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
const runSaveNoteTool = (userId: number, rawContent: string, rawTitle = '') => {
    const user = getUser(userId);
    if (!user) return 'Ошибка: пользователь не найден.';

    const content = rawContent.trim();
    const title = rawTitle.trim();
    if (!content) return 'Ошибка: пустой content.';
    if (title.length > NOTE_TITLE_MAX_LENGTH) {
        return `Ошибка: title слишком длинный (${title.length}/${NOTE_TITLE_MAX_LENGTH}).`;
    }

    const userPlan = parsePlanFromDb(user.plan);
    const contentLimit = getPlanNoteContentLimit(userPlan);
    if (content.length > contentLimit) {
        return `Ошибка: content слишком длинный (${content.length}/${contentLimit}) для плана ${getPlanLabel(userPlan)}.`;
    }
    const notesLimit = getPlanNotesLimit(userPlan);
    const notesCount = countNotes(userId);
    if (notesCount >= notesLimit) {
        return `Ошибка: лимит записной книжки достигнут (${notesCount}/${notesLimit}) для плана ${getPlanLabel(userPlan)}.`;
    }

    const created = createNote(userId, content, title);
    const noteId = Number(created.lastInsertRowid);
    const createdNote = getNoteByUserAndId(userId, noteId);
    const createdAt = createdNote ? formatNoteDate(createdNote.created_at) : 'дата неизвестна';
    return `Заметка сохранена: #${noteId} [${createdAt}]. Всего: ${notesCount + 1}/${notesLimit}.`;
};
const runListMyNotesTool = (userId: number, rawQuery = '', rawLimit?: number, rawOffset?: number) => {
    const user = getUser(userId);
    if (!user) return 'Ошибка: пользователь не найден.';
    const userPlan = parsePlanFromDb(user.plan);
    const maxListLimit = getPlanNoteListLimit(userPlan);
    const query = (rawQuery || '').trim().slice(0, NOTE_QUERY_MAX_LENGTH);
    const limit = Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(maxListLimit, Math.floor(rawLimit as number)))
        : maxListLimit;
    const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset as number)) : 0;
    const notes = getNotesPage(userId, limit, offset, query);
    const total = countNotes(userId, query);
    const page = Math.floor(offset / limit) + 1;
    return formatNotesPage(notes, page, total, limit, query || undefined);
};
const runReadNoteTool = (userId: number, noteIdRaw?: number) => {
    const noteId = Number(noteIdRaw);
    if (!Number.isFinite(noteId) || noteId <= 0) return 'Ошибка: некорректный note_id.';
    const note = getNoteByUserAndId(userId, Math.floor(noteId));
    if (!note) return `Заметка #${Math.floor(noteId)} не найдена.`;
    const titleText = note.title?.trim() ? note.title.trim() : 'без заголовка';
    return `Заметка #${note.id}\nДата: ${formatNoteDate(note.created_at)}\nЗаголовок: ${titleText}\n\n${note.content}`;
};
const runDeleteNoteTool = (userId: number, noteIdRaw?: number) => {
    const noteId = Number(noteIdRaw);
    if (!Number.isFinite(noteId) || noteId <= 0) return 'Ошибка: некорректный note_id.';
    const note = getNoteByUserAndId(userId, Math.floor(noteId));
    if (!note) return `Заметка #${Math.floor(noteId)} не найдена.`;
    const deleted = deleteNoteByUserAndId(userId, Math.floor(noteId));
    if (!deleted.changes) return `Не удалось удалить заметку #${Math.floor(noteId)}.`;
    const updated = runListMyNotesTool(userId, '', undefined, 0);
    return `Заметка #${Math.floor(noteId)} удалена.\n\n${updated}`;
};
const sendVoiceResponse = async (ctx: any, text: string) => {
    const safeText = (text || '').trim();
    if (!safeText) {
        await ctx.reply('❌ Пустой текст для озвучки.');
        return;
    }

    try {
        const synthesisUrl = getVoiceSynthesisUrl();
        const headers: Record<string, string> = {
            'Content-Type': 'application/json'
        };
        if (VOICE_TRANSCRIBE_TOKEN) {
            headers.Authorization = `Bearer ${VOICE_TRANSCRIBE_TOKEN}`;
        }

        const response = await fetch(synthesisUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ text: safeText })
        });

        if (!response.ok) {
            const details = await response.text().catch(() => '');
            const extra = details ? ` | ${details.slice(0, 200)}` : '';
            throw new Error(`VOICE_SYNTH ${response.status} ${response.statusText}${extra}`);
        }

        const audioBuffer = await response.arrayBuffer();
        if (!audioBuffer.byteLength) {
            throw new Error('TTS вернул пустой аудиофайл.');
        }

        await ctx.replyWithVoice({ source: Buffer.from(audioBuffer) });
    } catch (err) {
        console.error('Ошибка генерации голоса:', err);
        await ctx.reply(`❌ Ошибка генерации голоса: ${safeText}`);
    }
};

const getUser = (id: number) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRecord | undefined;
const addUser = (id: number, name: string, role: string, status: UserStatus = 'approved', tgUsername: string | null = null) => db.prepare(`
    INSERT INTO users (id, name, role, status, tg_username, selected_prompt_id)
    VALUES (?, ?, ?, ?, ?, COALESCE((SELECT id FROM prompts WHERE is_default = 1 LIMIT 1), ?))
    ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        role = excluded.role,
        status = excluded.status,
        tg_username = COALESCE(excluded.tg_username, users.tg_username),
        selected_prompt_id = COALESCE(users.selected_prompt_id, excluded.selected_prompt_id)
`).run(id, name, role, status, tgUsername, defaultPromptSeed.id);
const createPendingUser = (id: number, name: string | null, tgUsername: string | null) => db.prepare(`
    INSERT INTO users (id, name, role, status, tg_username, selected_prompt_id)
    VALUES (?, ?, 'user', 'none', ?, COALESCE((SELECT id FROM prompts WHERE is_default = 1 LIMIT 1), ?))
`).run(id, name, tgUsername, defaultPromptSeed.id);
const updateUserName = (id: number, name: string) => db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id);
const updateUserTelegramUsername = (id: number, tgUsername: string | null) => db.prepare('UPDATE users SET tg_username = ? WHERE id = ?').run(tgUsername, id);
const updateUserRole = (id: number, role: string) => db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
const updateUserStatus = (id: number, status: UserStatus) => db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
const updateUserPlan = (id: number, plan: UserPlan) => db.prepare(`
    UPDATE users
    SET plan = ?, context_window_max = ?, daily_message_limit = ?, daily_web_search_limit = ?, context_window = CASE
        WHEN COALESCE(context_window, 0) <= 0 THEN ?
        WHEN context_window > ? THEN ?
        ELSE context_window
    END
    WHERE id = ?
`).run(
    plan,
    PLAN_CONTEXT_LIMITS[plan],
    PLAN_DAILY_MESSAGE_LIMITS[plan],
    PLAN_DAILY_WEB_SEARCH_LIMITS[plan],
    PLAN_CONTEXT_LIMITS[plan],
    PLAN_CONTEXT_LIMITS[plan],
    PLAN_CONTEXT_LIMITS[plan],
    id
);
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
const getPlanContextLimit = (plan: UserPlan) => PLAN_CONTEXT_LIMITS[plan] || PLAN_CONTEXT_LIMITS[DEFAULT_USER_PLAN];
const getPlanDailyMessageLimit = (plan: UserPlan) => PLAN_DAILY_MESSAGE_LIMITS[plan] ?? PLAN_DAILY_MESSAGE_LIMITS[DEFAULT_USER_PLAN];
const getPlanDailyWebSearchLimit = (plan: UserPlan) => PLAN_DAILY_WEB_SEARCH_LIMITS[plan] ?? PLAN_DAILY_WEB_SEARCH_LIMITS[DEFAULT_USER_PLAN];
const normalizeDailyMessageLimit = (value: number | null | undefined) => {
    if (!Number.isFinite(value)) return getPlanDailyMessageLimit(DEFAULT_USER_PLAN);
    return Math.max(0, Math.floor(value as number));
};
const normalizeDailyWebSearchLimit = (value: number | null | undefined) => {
    if (!Number.isFinite(value)) return getPlanDailyWebSearchLimit(DEFAULT_USER_PLAN);
    return Math.max(0, Math.floor(value as number));
};
const checkWebSearchLimit = (userId: number) => {
    const user = getUser(userId);
    if (!user) {
        return { allowed: false, count: 0, limit: 0, reason: 'Пользователь не найден.' };
    }
    const limit = normalizeDailyWebSearchLimit(user.daily_web_search_limit);
    const count = Math.max(0, Math.floor(user.daily_web_search_count || 0));
    if (limit <= 0) {
        return {
            allowed: false,
            count,
            limit,
            reason: `По твоему плану (${getPlanLabel(parsePlanFromDb(user.plan))}) web-поиск отключен на сегодня.`
        };
    }
    if (count >= limit) {
        return {
            allowed: false,
            count,
            limit,
            reason: `Лимит web-поиска на сегодня исчерпан (${count}/${limit}).`
        };
    }
    return { allowed: true, count, limit, reason: '' };
};
const applyUserPlan = (userId: number, plan: UserPlan, endsAt: string | null, assignedBy: number | null) => {
    closeCurrentPlanSubscriptions(userId);
    updateUserPlan(userId, plan);
    addPlanSubscription(userId, plan, endsAt, assignedBy);
};
const ensureUserCurrentPlanSubscription = (userId: number) => {
    const current = getCurrentPlanSubscription(userId);
    if (current) return;
    const user = getUser(userId);
    if (!user) return;
    const normalizedPlan = parsePlanFromDb(user.plan);
    updateUserPlan(userId, normalizedPlan);
    addPlanSubscription(userId, normalizedPlan, null, null);
};
const ensureCurrentPlanSubscriptionsForAllUsers = () => {
    const users = getAllUsers();
    for (const user of users) {
        ensureUserCurrentPlanSubscription(user.id);
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
const expireFinishedPlanSubscriptions = () => {
    const expiredRows = getExpiredCurrentSubscriptions();
    const processedUsers = new Set<number>();
    for (const row of expiredRows) {
        if (processedUsers.has(row.user_id)) continue;
        processedUsers.add(row.user_id);
        applyUserPlan(row.user_id, DEFAULT_USER_PLAN, null, null);
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
const resolveUserMailAccount = (user: UserRecord, preferredProviderRaw?: string | null) => {
    const preferredProvider = normalizeMailProvider(preferredProviderRaw);
    const activeProvider = normalizeMailProvider(user.imap_provider);

    if (preferredProvider) {
        const preferred = getMailAccountForUser(user.id, preferredProvider);
        if (preferred) return preferred;
    }

    if (activeProvider) {
        const active = getMailAccountForUser(user.id, activeProvider);
        if (active) return active;
    }

    const all = getMailAccountsForUser(user.id);
    if (all.length) return all[0];

    if (user.imap_user && user.imap_pass && user.imap_host) {
        const provider = normalizeMailProvider(user.imap_provider)
            || (user.imap_host.includes('gmail') ? 'google' : 'yandex');
        return {
            user_id: user.id,
            provider,
            imap_user: user.imap_user,
            imap_pass: user.imap_pass,
            imap_host: user.imap_host,
            imap_port: user.imap_port ?? 993,
            imap_secure: user.imap_secure ?? 1
        } satisfies MailAccountRecord;
    }

    return null;
};
const clearUserMailSettings = (id: number) => db.prepare(`
    UPDATE users
    SET imap_provider = NULL, imap_user = NULL, imap_pass = NULL, imap_host = NULL, imap_port = 993, imap_secure = 1
    WHERE id = ?
`).run(id);
const toRubFromTokens = (tokens: number) => Math.max(0, tokens) * RUB_PER_TOKEN;
const formatTokenCountShort = (tokens: number) => {
    const safe = Math.max(0, Math.floor(tokens || 0));
    if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(2)}M`;
    if (safe >= 1_000) return `${(safe / 1_000).toFixed(1)}k`;
    return `${safe}`;
};
const formatRub = (value: number) => `${(Math.max(0, value || 0)).toFixed(2)}₽`;
const extractTotalTokens = (response: any) => {
    const total = Number(response?.usage?.total_tokens ?? 0);
    if (!Number.isFinite(total) || total < 0) return 0;
    return Math.floor(total);
};
const runEmailCheck = async (
    userId: number,
    searchQuery?: string,
    limit = 5,
    provider?: string,
    offset = 0,
    dateFrom?: string,
    dateTo?: string
) => {
    const user = getUser(userId);
    if (!user) {
        return 'Ошибка: пользователь не найден.';
    }
    const account = resolveUserMailAccount(user, provider);
    if (!account) {
        return 'Ошибка: почта не настроена. Используй /mail_setup или кнопку "📬 Почта".';
    }

    const requestedLimitRaw = Number.isFinite(limit) ? Math.floor(limit) : 0;
    const userDefaultLimit = Number.isFinite(user.mail_check_limit) && user.mail_check_limit > 0
        ? Math.floor(user.mail_check_limit)
        : DEFAULT_MAIL_CHECK_LIMIT;
    const desiredLimit = requestedLimitRaw > 0 ? requestedLimitRaw : userDefaultLimit;
    const safeLimit = user.role === 'admin'
        ? Math.max(1, desiredLimit)
        : Math.max(1, Math.min(10, desiredLimit));
    const safeOffset = Math.max(0, Math.min(500, Math.floor(offset || 0)));
    const fetchWindow = Math.min(500, safeLimit + safeOffset + 20);
    const normalizedQuery = (searchQuery || '').trim();
    const normalizeDateOnly = (value?: string) => {
        if (!value) return null;
        const raw = value.trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
        return raw;
    };
    const fromDate = normalizeDateOnly(dateFrom);
    const toDate = normalizeDateOnly(dateTo);
    const fromTs = fromDate ? Date.parse(`${fromDate}T00:00:00Z`) : null;
    const toTs = toDate ? Date.parse(`${toDate}T23:59:59Z`) : null;
    let decryptedPass = '';
    try {
        decryptedPass = decryptSecret(account.imap_pass);
    } catch (err) {
        return 'Ошибка: не удалось расшифровать пароль почты. Перепривяжи через /mail_setup.';
    }

    let ImapFlowCtor: any;
    try {
        const dynamicImporter = new Function('moduleName', 'return import(moduleName)') as (moduleName: string) => Promise<any>;
        const mod = await dynamicImporter('imapflow');
        ImapFlowCtor = mod?.ImapFlow;
        if (!ImapFlowCtor) {
            return 'Ошибка: библиотека imapflow не найдена. Установи её на сервере: npm install imapflow';
        }
    } catch (err) {
        return 'Ошибка: библиотека imapflow не найдена. Установи её на сервере: npm install imapflow';
    }

    const client = new ImapFlowCtor({
        host: account.imap_host,
        port: Number(account.imap_port || 993),
        secure: account.imap_secure !== 0,
        logger: false,
        auth: {
            user: account.imap_user,
            pass: decryptedPass
        }
    });

    try {
        await client.connect();
        const emails: Array<{ from: string; subject: string; date: string; mailbox: string; ts: number }> = [];

        const mailboxCandidates = normalizedQuery
            ? ['INBOX', 'Archive', 'Sent', 'Spam', 'Junk', 'Отправленные', 'Архив', 'Спам']
            : ['INBOX'];

        for (const mailbox of [...new Set(mailboxCandidates)]) {
            let lock: any = null;
            try {
                lock = await client.getMailboxLock(mailbox);
            } catch {
                continue;
            }

            try {
                let resultIds: number[] = [];
                if (normalizedQuery) {
                    const byFrom = await client.search({ from: normalizedQuery }).catch(() => [] as number[]);
                    const bySubject = await client.search({ subject: normalizedQuery }).catch(() => [] as number[]);
                    const byText = await client.search({ text: normalizedQuery }).catch(() => [] as number[]);
                    const merged = new Set<number>([...byFrom, ...bySubject, ...byText]);
                    resultIds = [...merged].sort((a, b) => a - b);
                } else {
                    resultIds = await client.search({ all: true });
                }

                const targetIds = resultIds.slice(-fetchWindow);
                if (!targetIds.length) {
                    continue;
                }

                for await (const msg of client.fetch(targetIds, { envelope: true })) {
                    const from = msg.envelope?.from?.[0]?.address || 'unknown';
                    const subject = msg.envelope?.subject || '(без темы)';
                    const dt = msg.envelope?.date ? new Date(msg.envelope.date) : null;
                    const ts = dt ? dt.getTime() : 0;
                    if (fromTs !== null && ts && ts < fromTs) continue;
                    if (toTs !== null && ts && ts > toTs) continue;
                    const date = dt ? dt.toLocaleString('ru-RU') : 'без даты';
                    emails.push({ from, subject, date, mailbox, ts });
                }
            } finally {
                lock.release();
            }
        }

        await client.logout();
        if (!emails.length) {
            const dateHint = (fromDate || toDate)
                ? ` c учетом диапазона ${fromDate || '...'}..${toDate || '...'}`
                : '';
            return normalizedQuery
                ? `Писем по запросу "${normalizedQuery}"${dateHint} не найдено (проверил INBOX/Архив/Отправленные/Спам).`
                : 'На почте пусто.';
        }

        const sorted = emails
            .sort((a, b) => b.ts - a.ts)
            .slice(safeOffset, safeOffset + safeLimit)
            .map(({ ts, ...rest }) => rest);
        if (!sorted.length) {
            return `Писем больше нет для этой страницы (offset=${safeOffset}, limit=${safeLimit}).`;
        }
        return JSON.stringify({
            page: {
                offset: safeOffset,
                limit: safeLimit,
                returned: sorted.length
            },
            items: sorted
        }, null, 2);
    } catch (err) {
        try { await client.logout(); } catch {}
        return `Ошибка подключения к почте: ${err instanceof Error ? err.message : String(err)}`;
    }
};

const decodeQuotedPrintable = (input: string) => {
    const normalized = input.replace(/=\r?\n/g, '');
    return normalized.replace(/=([A-Fa-f0-9]{2})/g, (_, hex: string) => {
        const code = Number.parseInt(hex, 16);
        return Number.isNaN(code) ? '' : String.fromCharCode(code);
    });
};

const decodeTransferEncodedBody = (rawBody: string, transferEncoding: string | null) => {
    const encoding = (transferEncoding || '').toLowerCase().trim();
    if (encoding === 'base64') {
        try {
            const compact = rawBody.replace(/\s+/g, '');
            return Buffer.from(compact, 'base64').toString('utf8');
        } catch {
            return rawBody;
        }
    }
    if (encoding === 'quoted-printable') {
        return decodeQuotedPrintable(rawBody);
    }
    return rawBody;
};

const stripHtmlToText = (html: string) => html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();

const parseMimeHeaders = (headersRaw: string) => {
    const map = new Map<string, string>();
    const unfolded = headersRaw.replace(/\r?\n[ \t]+/g, ' ');
    for (const line of unfolded.split(/\r?\n/)) {
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        if (!map.has(key)) map.set(key, value);
    }
    return map;
};

const extractBoundary = (contentType: string | null) => {
    if (!contentType) return null;
    const match = contentType.match(/boundary="?([^";]+)"?/i);
    return match?.[1] || null;
};

const splitMimeParts = (body: string, boundary: string) => {
    const delimiter = `--${boundary}`;
    const endDelimiter = `--${boundary}--`;
    const lines = body.replace(/\r\n/g, '\n').split('\n');
    const parts: string[] = [];
    let collecting = false;
    let current: string[] = [];

    for (const line of lines) {
        if (line === delimiter) {
            if (collecting && current.length) {
                parts.push(current.join('\n'));
            }
            collecting = true;
            current = [];
            continue;
        }
        if (line === endDelimiter) {
            if (collecting && current.length) {
                parts.push(current.join('\n'));
            }
            break;
        }
        if (collecting) current.push(line);
    }

    return parts;
};

const extractReadableEmailTextFromRaw = (rawSource: string) => {
    const normalized = rawSource.replace(/\r\n/g, '\n');
    const splitIndex = normalized.indexOf('\n\n');
    if (splitIndex < 0) return normalized.trim().slice(0, 2000);

    const topHeadersRaw = normalized.slice(0, splitIndex);
    const topBody = normalized.slice(splitIndex + 2);
    const topHeaders = parseMimeHeaders(topHeadersRaw);
    const topContentType = topHeaders.get('content-type') || null;
    const boundary = extractBoundary(topContentType);

    const collectPartText = (partRaw: string) => {
        const idx = partRaw.indexOf('\n\n');
        if (idx < 0) return null;
        const partHeadersRaw = partRaw.slice(0, idx);
        const partBodyRaw = partRaw.slice(idx + 2);
        const partHeaders = parseMimeHeaders(partHeadersRaw);
        const partType = (partHeaders.get('content-type') || 'text/plain').toLowerCase();
        const transfer = partHeaders.get('content-transfer-encoding') || null;
        const decoded = decodeTransferEncodedBody(partBodyRaw, transfer);
        if (partType.includes('text/plain')) return decoded;
        if (partType.includes('text/html')) return stripHtmlToText(decoded);
        return null;
    };

    if (boundary) {
        const parts = splitMimeParts(topBody, boundary);
        let htmlFallback: string | null = null;
        for (const part of parts) {
            const idx = part.indexOf('\n\n');
            if (idx < 0) continue;
            const partHeaders = parseMimeHeaders(part.slice(0, idx));
            const partType = (partHeaders.get('content-type') || '').toLowerCase();

            // Пропускаем вложенные multipart на этом уровне.
            if (partType.includes('multipart/')) continue;

            const text = collectPartText(part);
            if (!text) continue;
            if (partType.includes('text/plain')) return text.replace(/\s+/g, ' ').trim();
            if (!htmlFallback && partType.includes('text/html')) htmlFallback = text;
        }
        if (htmlFallback) return htmlFallback.replace(/\s+/g, ' ').trim();
    }

    const transfer = topHeaders.get('content-transfer-encoding') || null;
    const decoded = decodeTransferEncodedBody(topBody, transfer);
    const topType = (topContentType || '').toLowerCase();
    const plain = topType.includes('text/html') ? stripHtmlToText(decoded) : decoded;
    return plain.replace(/\s+/g, ' ').trim();
};

const runEmailRead = async (userId: number, subjectPart: string, provider?: string) => {
    const user = getUser(userId);
    if (!user) {
        return 'Ошибка: пользователь не найден.';
    }
    const account = resolveUserMailAccount(user, provider);
    if (!account) {
        return 'Ошибка: почта не настроена. Используй /mail_setup или кнопку "📬 Почта".';
    }

    const query = subjectPart.trim();
    if (!query) return 'Ошибка: пустой subject_part.';

    let decryptedPass = '';
    try {
        decryptedPass = decryptSecret(account.imap_pass);
    } catch (err) {
        return 'Ошибка: не удалось расшифровать пароль почты. Перепривяжи через /mail_setup.';
    }

    let ImapFlowCtor: any;
    try {
        const dynamicImporter = new Function('moduleName', 'return import(moduleName)') as (moduleName: string) => Promise<any>;
        const mod = await dynamicImporter('imapflow');
        ImapFlowCtor = mod?.ImapFlow;
        if (!ImapFlowCtor) {
            return 'Ошибка: библиотека imapflow не найдена. Установи её на сервере: npm install imapflow';
        }
    } catch (err) {
        return 'Ошибка: библиотека imapflow не найдена. Установи её на сервере: npm install imapflow';
    }

    const client = new ImapFlowCtor({
        host: account.imap_host,
        port: Number(account.imap_port || 993),
        secure: account.imap_secure !== 0,
        logger: false,
        auth: {
            user: account.imap_user,
            pass: decryptedPass
        }
    });

    try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');
        try {
            const resultIds = await client.search({ subject: query });
            if (!resultIds.length) {
                return `Письмо с темой "${query}" не найдено.`;
            }

            const lastId = resultIds[resultIds.length - 1];
            const msg = await client.fetchOne(lastId, { source: true, envelope: true });
            if (!msg?.source) return 'Не удалось прочитать тело письма.';

            const sourceText = Buffer.isBuffer(msg.source) ? msg.source.toString('utf8') : `${msg.source}`;
            const clean = extractReadableEmailTextFromRaw(sourceText).slice(0, 2000);
            const subject = msg.envelope?.subject || '(без темы)';
            return `Тема: ${subject}\nСодержимое (фрагмент):\n${clean || '(пусто)'}`;
        } finally {
            lock.release();
            await client.logout();
        }
    } catch (err) {
        try { await client.logout(); } catch {}
        return `Ошибка при чтении письма: ${err instanceof Error ? err.message : String(err)}`;
    }
};

const resolveSmtpHostFromImapHost = (imapHost: string) => {
    const normalized = imapHost.trim().toLowerCase();
    if (!normalized) return '';
    if (normalized.includes('imap.gmail.com')) return 'smtp.gmail.com';
    if (normalized.includes('imap.yandex')) return 'smtp.yandex.ru';
    if (normalized.includes('imap.mail.ru')) return 'smtp.mail.ru';
    return normalized.replace(/^imap\./, 'smtp.');
};

const runEmailSend = async (userId: number, to: string, subject: string, body: string, provider?: string) => {
    const user = getUser(userId);
    if (!user) {
        return 'Ошибка: пользователь не найден.';
    }
    const account = resolveUserMailAccount(user, provider);
    if (!account) {
        return 'Ошибка: почта не настроена. Сначала используй /mail_setup.';
    }

    const recipient = to.trim();
    const mailSubject = subject.trim();
    const mailBody = body.trim();
    if (!recipient || !mailSubject || !mailBody) {
        return 'Ошибка: нужны to, subject и body.';
    }

    const smtpHost = resolveSmtpHostFromImapHost(account.imap_host);
    if (!smtpHost) {
        return 'Ошибка: не удалось определить SMTP-хост.';
    }

    let decryptedPass = '';
    try {
        decryptedPass = decryptSecret(account.imap_pass);
    } catch (err) {
        return 'Ошибка: не удалось расшифровать пароль почты. Перепривяжи через /mail_setup.';
    }

    let nodemailerMod: any;
    try {
        const dynamicImporter = new Function('moduleName', 'return import(moduleName)') as (moduleName: string) => Promise<any>;
        nodemailerMod = await dynamicImporter('nodemailer');
        if (!nodemailerMod?.default?.createTransport) {
            return 'Ошибка: библиотека nodemailer не найдена. Установи её на сервере: npm install nodemailer';
        }
    } catch (err) {
        return 'Ошибка: библиотека nodemailer не найдена. Установи её на сервере: npm install nodemailer';
    }

    const transporter = nodemailerMod.default.createTransport({
        host: smtpHost,
        port: 465,
        secure: true,
        auth: {
            user: account.imap_user,
            pass: decryptedPass
        }
    });

    try {
        await transporter.sendMail({
            from: account.imap_user,
            to: recipient,
            subject: mailSubject,
            text: mailBody.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
            html: mailBody
        });
        return `✅ Письмо успешно отправлено на ${recipient}`;
    } catch (err) {
        return `❌ Ошибка при отправке письма: ${err instanceof Error ? err.message : String(err)}`;
    }
};

const runScheduledEmailCheckTask = async (task: TaskRecord) => {
    let searchQuery = '';
    let limit = 5;
    let provider = '';
    let offset = 0;
    let dateFrom = '';
    let dateTo = '';

    const raw = task.payload.trim();
    if (raw) {
        if (raw.startsWith('{')) {
            try {
                const parsed = JSON.parse(raw) as { provider?: string; search_query?: string; limit?: number; offset?: number; date_from?: string; date_to?: string };
                provider = typeof parsed.provider === 'string' ? parsed.provider : '';
                searchQuery = typeof parsed.search_query === 'string' ? parsed.search_query : '';
                limit = typeof parsed.limit === 'number' ? parsed.limit : 5;
                offset = typeof parsed.offset === 'number' ? parsed.offset : 0;
                dateFrom = typeof parsed.date_from === 'string' ? parsed.date_from : '';
                dateTo = typeof parsed.date_to === 'string' ? parsed.date_to : '';
            } catch {
                searchQuery = raw;
            }
        } else {
            searchQuery = raw;
        }
    }

    const result = await runEmailCheck(task.user_id, searchQuery, limit, provider, offset, dateFrom, dateTo);
    const title = searchQuery
        ? `📬 *Запланированная проверка почты*${provider ? ` (${provider})` : ''} (запрос: ${searchQuery})`
        : `📬 *Запланированная проверка почты*${provider ? ` (${provider})` : ''}`;
    return `${title}\n\n${result}`;
};
const incrementUserStats = (id: number, messageLength: number, tokensUsed: number) => {
    const safeLength = Math.max(0, messageLength);
    const safeTokens = Math.max(0, Math.floor(tokensUsed));
    const costRub = toRubFromTokens(safeTokens);
    return db.prepare(`
    UPDATE users
    SET daily_message_count = COALESCE(daily_message_count, 0) + 1,
        total_message_length = COALESCE(total_message_length, 0) + ?,
        daily_tokens_used = COALESCE(daily_tokens_used, 0) + ?,
        total_tokens_used = COALESCE(total_tokens_used, 0) + ?,
        daily_cost_rub = COALESCE(daily_cost_rub, 0) + ?,
        total_cost_rub = COALESCE(total_cost_rub, 0) + ?
    WHERE id = ?
`).run(safeLength, safeTokens, safeTokens, costRub, costRub, id);
};
const incrementUserTokenUsage = (id: number, tokensUsed: number) => {
    const safeTokens = Math.max(0, Math.floor(tokensUsed));
    const costRub = toRubFromTokens(safeTokens);
    return db.prepare(`
    UPDATE users
    SET daily_tokens_used = COALESCE(daily_tokens_used, 0) + ?,
        total_tokens_used = COALESCE(total_tokens_used, 0) + ?,
        daily_cost_rub = COALESCE(daily_cost_rub, 0) + ?,
        total_cost_rub = COALESCE(total_cost_rub, 0) + ?
    WHERE id = ?
`).run(safeTokens, safeTokens, costRub, costRub, id);
};
const incrementUserWebSearchUsage = (id: number, count = 1) => {
    const safeCount = Math.max(0, Math.floor(count));
    if (safeCount <= 0) return;
    return db.prepare(`
    UPDATE users
    SET daily_web_search_count = COALESCE(daily_web_search_count, 0) + ?,
        total_web_search_count = COALESCE(total_web_search_count, 0) + ?
    WHERE id = ?
`).run(safeCount, safeCount, id);
};
const resetDailyMessageCounters = () => db.prepare(`
    UPDATE users
    SET daily_message_count = 0,
        daily_tokens_used = 0,
        daily_cost_rub = 0,
        daily_web_search_count = 0
`).run();
const updateUserPrompt = (id: number, promptId: number) => db.prepare('UPDATE users SET selected_prompt_id = ? WHERE id = ?').run(promptId, id);
const selectUserCustomPrompt = (id: number) => db.prepare('UPDATE users SET selected_prompt_id = ? WHERE id = ?').run(CUSTOM_PROMPT_ID, id);
const updateUserCustomPrompt = (id: number, content: string) => db.prepare('UPDATE users SET custom_prompt_content = ? WHERE id = ?').run(content, id);
const updateUserCoreMemory = (id: number, memory: string) => db.prepare('UPDATE users SET core_memory = ? WHERE id = ?').run(memory, id);
const resetUsersPromptIfDeleted = (promptId: number) => db.prepare('UPDATE users SET selected_prompt_id = NULL WHERE selected_prompt_id = ?').run(promptId);
const removeUser = (id: number) => db.prepare('DELETE FROM users WHERE id = ?').run(id);
const removeUserPlanSubscriptions = (id: number) => db.prepare('DELETE FROM user_plan_subscriptions WHERE user_id = ?').run(id);
const getAllUsers = () => db.prepare('SELECT * FROM users ORDER BY id').all() as UserRecord[];
const getUsersCount = () => (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
const getUsersPage = (limit: number, offset: number) => db.prepare(`
    SELECT id, name, role, status, plan, tg_username, selected_prompt_id, custom_prompt_content, core_memory, imap_provider, imap_user, imap_pass, imap_host, imap_port, imap_secure, mail_check_limit, timezone_offset, timezone_confirmed, daily_message_count, daily_message_limit, total_message_length, daily_tokens_used, total_tokens_used, daily_cost_rub, total_cost_rub, daily_web_search_count, daily_web_search_limit, total_web_search_count, context_window, context_window_max
    FROM users
    ORDER BY id ASC
    LIMIT ? OFFSET ?
`).all(limit, offset) as UserRecord[];
const getPendingUsersCount = () => (db.prepare(`SELECT COUNT(*) as count FROM users WHERE status = 'none'`).get() as { count: number }).count;
const getPendingUsersPage = (limit: number, offset: number) => db.prepare(`
    SELECT id, name, role, status, plan, tg_username, selected_prompt_id, custom_prompt_content, core_memory, imap_provider, imap_user, imap_pass, imap_host, imap_port, imap_secure, mail_check_limit, daily_message_limit, daily_web_search_limit, context_window, context_window_max, created_at
    FROM users
    WHERE status = 'none'
    ORDER BY id ASC
    LIMIT ? OFFSET ?
`).all(limit, offset) as PendingUserRow[];
const getBannedUsersCount = () => (db.prepare(`SELECT COUNT(*) as count FROM users WHERE status = 'banned'`).get() as { count: number }).count;
const getBannedUsersPage = (limit: number, offset: number) => db.prepare(`
    SELECT u.id, u.name, u.role, u.status, u.plan, u.tg_username, u.selected_prompt_id, u.custom_prompt_content, u.core_memory, u.imap_provider, u.imap_user, u.imap_pass, u.imap_host, u.imap_port, u.imap_secure, u.mail_check_limit, u.daily_message_limit, u.daily_web_search_limit, u.context_window, u.context_window_max, b.reason, b.banned_at
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
const getDueTasks = (unixNow: number) => db.prepare(`
    SELECT id, user_id, execute_at, task_type, payload, status, recurrence_type, recurrence_weekday, timezone_offset, notify_mode, notify_condition
    FROM tasks
    WHERE status = 'pending' AND execute_at <= ?
    ORDER BY execute_at ASC, id ASC
`).all(unixNow) as TaskRecord[];
const updateTaskStatus = (taskId: number, status: TaskStatus) => db
    .prepare('UPDATE tasks SET status = ? WHERE id = ?')
    .run(status, taskId);
const updateTaskNextExecution = (taskId: number, nextExecuteAt: number) => db
    .prepare('UPDATE tasks SET execute_at = ? WHERE id = ?')
    .run(nextExecuteAt, taskId);
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
    if (!user) return MAX_HISTORY_ITEMS;
    const maxWindow = Number.isFinite(user.context_window_max) && user.context_window_max > 0
        ? Math.floor(user.context_window_max)
        : getPlanContextLimit(parsePlanFromDb(user.plan));
    const currentWindow = Number.isFinite(user.context_window) && user.context_window > 0
        ? Math.floor(user.context_window)
        : maxWindow;
    return Math.max(1, Math.min(currentWindow, maxWindow));
};
const getUserHistory = (userId: number) => {
    const user = getUser(userId);
    const contextWindow = resolveEffectiveContextWindow(user);
    const rows = db.prepare(`
        SELECT role, content
        FROM chat_messages
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT ?
    `).all(userId, contextWindow) as ChatMessage[];

    return rows.reverse();
};
const addHistoryMessage = (userId: number, role: ChatRole, content: string) => db
    .prepare('INSERT INTO chat_messages (user_id, role, content) VALUES (?, ?, ?)')
    .run(userId, role, content);
const trimUserHistory = (userId: number) => db.prepare(`
    DELETE FROM chat_messages
    WHERE user_id = ?
      AND id NOT IN (
        SELECT id
        FROM chat_messages
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT ?
      )
`).run(userId, userId, resolveEffectiveContextWindow(getUser(userId)));
const clearUserHistory = (userId: number) => db.prepare('DELETE FROM chat_messages WHERE user_id = ?').run(userId);

ensureCurrentPlanSubscriptionsForAllUsers();

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

// Middleware для авторизации
bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const telegramUsername = ctx.from?.username?.trim() || null;
    let userRecord = getUser(userId);
    const isAdminByEnv = ADMIN_IDS.has(userId);
    const isAdminByDb = userRecord?.role === 'admin';

    if (isAdminByEnv || isAdminByDb) {
        const fallbackName = userRecord?.name || ctx.from?.first_name || 'Admin';
        if (!userRecord) {
            addUser(userId, fallbackName, 'admin', 'approved', telegramUsername);
            userRecord = getUser(userId);
        } else {
            if (userRecord.role !== 'admin' || userRecord.status !== 'approved') {
                addUser(userId, userRecord.name || fallbackName, 'admin', 'approved', telegramUsername);
                userRecord = getUser(userId);
            } else if (userRecord.tg_username !== telegramUsername) {
                updateUserTelegramUsername(userId, telegramUsername);
                userRecord = getUser(userId) || userRecord;
            }
        }

        if (userRecord && !userRecord.selected_prompt_id) {
            const defaultPrompt = ensureDefaultPrompt();
            if (defaultPrompt) updateUserPrompt(userId, defaultPrompt.id);
        }
        if (userRecord) {
            const normalizedPlan = parsePlanFromDb(userRecord.plan);
            if (userRecord.plan !== normalizedPlan) {
                updateUserPlan(userId, normalizedPlan);
                userRecord = getUser(userId) || userRecord;
            }
            ensureUserCurrentPlanSubscription(userId);
        }

        await syncCommandScopeForUser(userId, true);
        ctx.state.role = 'admin';
        ctx.state.userName = fallbackName;
        return next();
    }

    if (!userRecord) {
        const initialName = telegramUsername ? (ctx.from?.first_name || null) : null;
        createPendingUser(userId, initialName, telegramUsername);
        await syncCommandScopeForUser(userId, false);

        const freshUser = getUser(userId);
        if (freshUser) await notifyAdminsNewRequest(freshUser);

        if (!telegramUsername) {
            return ctx.reply('Отправили вашу заявку админу, ждём подтверждения.\nУ тебя нет @username, отправь сюда имя одним сообщением.');
        }

        return ctx.reply('Отправили вашу заявку админу, ждём подтверждения.');
    }

    if (userRecord.tg_username !== telegramUsername) {
        updateUserTelegramUsername(userId, telegramUsername);
        userRecord = getUser(userId) || userRecord;
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
        const savedName = maybeCapturePendingName(ctx, userRecord, text);
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
        updateUserRole(userId, 'user');
        userRecord = getUser(userId) || userRecord;
    }
    if (!userRecord.selected_prompt_id) {
        const defaultPrompt = ensureDefaultPrompt();
        if (defaultPrompt) updateUserPrompt(userId, defaultPrompt.id);
    }
    {
        const normalizedPlan = parsePlanFromDb(userRecord.plan);
        if (userRecord.plan !== normalizedPlan) {
            updateUserPlan(userId, normalizedPlan);
            userRecord = getUser(userId) || userRecord;
        }
        ensureUserCurrentPlanSubscription(userId);
    }

    await syncCommandScopeForUser(userId, false);
    ctx.state.role = 'user';
    ctx.state.userName = userRecord.name || ctx.from?.first_name || 'Пользователь';
    return next();
});

bot.telegram.setMyCommands(BASE_COMMANDS as any);

const showMenu = (ctx: any) => {
    const isAdmin = ctx.state.role === 'admin';
    const userId = ctx.from?.id;
    const userRecord = userId ? getUser(userId) : undefined;
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
        ? `🗂 Контекст (текущий/доступный): ${getContextWindowText(userRecord)}`
        : `🗂 Контекст: ${MAX_HISTORY_ITEMS}/${MAX_HISTORY_ITEMS}`;
    const messageLimitLine = userRecord
        ? `📨 Сообщения сегодня: ${getDailyMessageLimitText(userRecord)}`
        : `📨 Сообщения сегодня: 0/${PLAN_DAILY_MESSAGE_LIMITS[DEFAULT_USER_PLAN]}`;
    const webLimitLine = userRecord
        ? `🌐 Web-поиск сегодня: ${getDailyWebSearchLimitText(userRecord)}`
        : `🌐 Web-поиск сегодня: 0/${PLAN_DAILY_WEB_SEARCH_LIMITS[DEFAULT_USER_PLAN]}`;
    const notesLine = NOTES_WEBAPP_URL
        ? '📝 Заметки: доступны в кнопке WebApp'
        : '📝 Заметки: команды /note_add, /notes, /note_find, /note_delete';
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
    clearUserHistory(userId);
    return ctx.reply('Память очищена.');
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
    const effective = resolveEffectiveContextWindow(user);
    const maxWindow = Number.isFinite(user.context_window_max) && user.context_window_max > 0
        ? Math.floor(user.context_window_max)
        : getPlanContextLimit(parsePlanFromDb(user.plan));
    return `${effective}/${maxWindow}`;
};
const getDailyMessageLimitText = (user: UserRecord) => {
    const limit = normalizeDailyMessageLimit(user.daily_message_limit);
    return limit === 0 ? 'безлимит' : `${user.daily_message_count ?? 0}/${limit}`;
};
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

const maybeCapturePendingName = (ctx: any, user: UserRecord, text: string) => {
    if (ctx.from?.username) return false;
    if (user.name && user.name.trim()) return false;
    if (!text || text.startsWith('/')) return false;

    const candidate = text.trim();
    if (!candidate || candidate.length > 64) return false;
    updateUserName(user.id, candidate);
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
        const messageLimit = normalizeDailyMessageLimit(row.daily_message_limit);
        const webLimit = normalizeDailyWebSearchLimit(row.daily_web_search_limit);
        const notesStats = noteStatsMap.get(row.id) || { user_id: row.id, notes_count: 0, notes_chars: 0 };
        const usageTag = `msg:${row.daily_message_count ?? 0}/${messageLimit === 0 ? '∞' : messageLimit} tok:${formatTokenCountShort(row.daily_tokens_used ?? 0)} web:${row.daily_web_search_count ?? 0}/${webLimit} nts:${notesStats.notes_count} ch:${notesStats.notes_chars} ${formatRub(row.daily_cost_rub ?? 0)}`;
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
    [Markup.button.callback(`FREE (ctx ${PLAN_CONTEXT_LIMITS.free}, msg ${PLAN_DAILY_MESSAGE_LIMITS.free}, web ${PLAN_DAILY_WEB_SEARCH_LIMITS.free})`, `usr:plan:pick:${userId}:${page}:free`)],
    [Markup.button.callback(`STANDART (ctx ${PLAN_CONTEXT_LIMITS.standart}, msg ${PLAN_DAILY_MESSAGE_LIMITS.standart}, web ${PLAN_DAILY_WEB_SEARCH_LIMITS.standart})`, `usr:plan:pick:${userId}:${page}:standart`)],
    [Markup.button.callback(`PRO (ctx ${PLAN_CONTEXT_LIMITS.pro}, msg ${PLAN_DAILY_MESSAGE_LIMITS.pro}, web ${PLAN_DAILY_WEB_SEARCH_LIMITS.pro})`, `usr:plan:pick:${userId}:${page}:pro`)],
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
Промпт: #${prompt.id} ${prompt.name}${prompt.is_default ? ' (default)' : ''}
Сообщений сегодня: ${user.daily_message_count ?? 0}
Токенов сегодня: ${user.daily_tokens_used ?? 0}
Цена сегодня: ${formatRub(user.daily_cost_rub ?? 0)}
Поисков web сегодня: ${user.daily_web_search_count ?? 0}
Токенов всего: ${user.total_tokens_used ?? 0}
Цена всего: ${formatRub(user.total_cost_rub ?? 0)}
Поисков web всего: ${user.total_web_search_count ?? 0}
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
Лимит контекста у плана: ${PLAN_CONTEXT_LIMITS[plan]}
Лимит сообщений в день у плана: ${PLAN_DAILY_MESSAGE_LIMITS[plan]}
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

const approveUserAccess = (targetUserId: number) => {
    const user = getUser(targetUserId);
    if (!user) return false;
    updateUserStatus(targetUserId, 'approved');
    if (!user.selected_prompt_id) {
        const defaultPrompt = ensureDefaultPrompt();
        if (defaultPrompt) updateUserPrompt(targetUserId, defaultPrompt.id);
    }
    removeBan(targetUserId);
    return true;
};

const disapproveUserAccess = (targetUserId: number) => {
    const user = getUser(targetUserId);
    if (!user) return false;
    updateUserStatus(targetUserId, 'disapproved');
    removeBan(targetUserId);
    return true;
};

const banUserAccess = (targetUserId: number, bannedBy: number, reason: string) => {
    const user = getUser(targetUserId);
    if (!user) return false;
    updateUserStatus(targetUserId, 'banned');
    setBan(targetUserId, reason, bannedBy);
    return true;
};

const unbanUserAccess = (targetUserId: number) => {
    const user = getUser(targetUserId);
    if (!user) return false;
    removeBan(targetUserId);
    updateUserStatus(targetUserId, 'none');
    return true;
};

const notifyAdminsNewRequest = async (user: UserRecord) => {
    const usernameText = user.tg_username ? `@${user.tg_username}` : 'нет username';
    const text = `🆕 Новая заявка\nID: ${user.id}\nИмя: ${user.name ?? 'не указано'}\nUsername: ${usernameText}`;
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
bot.command('menu', (ctx) => showMenu(ctx));
bot.hears(MAIN_MENU_TRIGGER_BUTTON, (ctx) => showMenu(ctx));

bot.command('prompts', (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = getUser(userId);
    if (!user) return ctx.reply('Не нашёл тебя в базе. Попроси админа выдать доступ.');

    if (ctx.state.role !== 'admin') {
        return renderPromptListInteractive(ctx, user, 'reply');
    }

    return ctx.reply(formatPromptsList(user.selected_prompt_id, true));
});

bot.command('prompt_use', (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const promptId = Number.parseInt(parts[1], 10);
    if (!promptId || Number.isNaN(promptId)) return ctx.reply('Формат: /prompt_use 1');

    const user = getUser(userId);
    if (!user) return ctx.reply('Не нашёл тебя в базе. Попроси админа выдать доступ.');

    const prompt = getPromptById(promptId);
    if (!prompt) return ctx.reply(`Промпт с ID ${promptId} не найден.`);

    updateUserPrompt(userId, promptId);
    return ctx.reply(`Промпт выбран: ${prompt.name}`);
});

bot.command('prompt_add', (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');

    const parts = parsePipeParts(ctx.message.text);
    if (!parts || parts.length < 3) return ctx.reply('Формат: /prompt_add Имя | Описание | Текст промпта');

    const [name, description, ...contentParts] = parts;
    const content = contentParts.join(' | ').trim();
    if (!content) return ctx.reply('Текст промпта не может быть пустым.');

    try {
        const created = createPrompt(name, description, content, false);
        const promptId = Number(created.lastInsertRowid);
        return ctx.reply(`Промпт добавлен: ${name} (ID: ${promptId})`);
    } catch (err) {
        return ctx.reply('Не удалось добавить промпт. Возможно, имя уже занято.');
    }
});

bot.command('prompt_show', (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const promptId = Number.parseInt(parts[1], 10);
    if (!promptId || Number.isNaN(promptId)) return ctx.reply('Формат: /prompt_show 3');

    const prompt = getPromptById(promptId);
    if (!prompt) return ctx.reply(`Промпт с ID ${promptId} не найден.`);

    const defaultMark = prompt.is_default ? ' [default]' : '';
    const text = `Промпт ${prompt.id}: ${prompt.name}${defaultMark}\nОписание: ${prompt.description || 'без описания'}\n\nТекст:\n${prompt.content}`;
    return ctx.reply(text);
});

bot.command('prompt_set', (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');

    const parts = parsePipeParts(ctx.message.text);
    if (!parts || parts.length < 2) return ctx.reply('Формат: /prompt_set 3 | Новый текст');

    const promptId = Number.parseInt(parts[0], 10);
    if (!promptId || Number.isNaN(promptId)) return ctx.reply('Укажи корректный ID: /prompt_set 3 | Новый текст');
    const content = parts.slice(1).join(' | ').trim();
    if (!content) return ctx.reply('Новый текст не может быть пустым.');

    const prompt = getPromptById(promptId);
    if (!prompt) return ctx.reply(`Промпт с ID ${promptId} не найден.`);

    updatePromptContent(promptId, content);
    return ctx.reply(`Текст промпта "${prompt.name}" обновлён.`);
});

bot.command('prompt_desc', (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');

    const parts = parsePipeParts(ctx.message.text);
    if (!parts || parts.length < 2) return ctx.reply('Формат: /prompt_desc 3 | Новое описание');

    const promptId = Number.parseInt(parts[0], 10);
    if (!promptId || Number.isNaN(promptId)) return ctx.reply('Укажи корректный ID: /prompt_desc 3 | Новое описание');
    const description = parts.slice(1).join(' | ').trim();
    if (!description) return ctx.reply('Описание не может быть пустым.');

    const prompt = getPromptById(promptId);
    if (!prompt) return ctx.reply(`Промпт с ID ${promptId} не найден.`);

    updatePromptDescription(promptId, description);
    return ctx.reply(`Описание промпта "${prompt.name}" обновлено.`);
});

bot.command('prompt_rename', (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const promptId = Number.parseInt(parts[1], 10);
    const newName = parts.slice(2).join(' ').trim();

    if (!promptId || Number.isNaN(promptId)) return ctx.reply('Формат: /prompt_rename 3 НовоеИмя');
    if (!newName) return ctx.reply('Формат: /prompt_rename 3 НовоеИмя');

    const prompt = getPromptById(promptId);
    if (!prompt) return ctx.reply(`Промпт с ID ${promptId} не найден.`);

    try {
        updatePromptName(promptId, newName);
        return ctx.reply(`Промпт переименован: ${prompt.name} -> ${newName}`);
    } catch (err) {
        return ctx.reply('Не удалось переименовать промпт. Возможно, имя уже занято.');
    }
});

bot.command('prompt_default', (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const promptId = Number.parseInt(parts[1], 10);
    if (!promptId || Number.isNaN(promptId)) return ctx.reply('Формат: /prompt_default 3');

    const prompt = getPromptById(promptId);
    if (!prompt) return ctx.reply(`Промпт с ID ${promptId} не найден.`);

    setDefaultPrompt(promptId);
    return ctx.reply(`Промпт по умолчанию обновлён: ${prompt.name}`);
});

bot.command('prompt_delete', (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const promptId = Number.parseInt(parts[1], 10);
    if (!promptId || Number.isNaN(promptId)) return ctx.reply('Формат: /prompt_delete 3');

    const prompt = getPromptById(promptId);
    if (!prompt) return ctx.reply(`Промпт с ID ${promptId} не найден.`);

    const prompts = getAllPrompts();
    if (prompts.length <= 1) return ctx.reply('Нельзя удалить последний промпт.');
    if (prompt.is_default) return ctx.reply('Нельзя удалить промпт по умолчанию. Сначала назначь другой через /prompt_default.');

    deletePrompt(promptId);
    resetUsersPromptIfDeleted(promptId);
    return ctx.reply(`Промпт удалён: ${prompt.name}`);
});

// Команда добавления пользователя (только для админов)
bot.command('add', (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const newUserId = Number.parseInt(parts[1], 10);
    const newUserName = parts.slice(2).join(' ') || 'Без_имени';

    if (!newUserId || Number.isNaN(newUserId)) return ctx.reply('Укажи правильный ID: /add 123456789 Имя');

    addUser(newUserId, newUserName, 'user', 'approved', null);
    removeBan(newUserId);
    ctx.reply(`Пользователь ${newUserName} (ID: ${newUserId}) успешно добавлен в базу.`);
});

// Команда удаления пользователя (только для админов)
bot.command('remove', (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const targetUserId = Number.parseInt(parts[1], 10);

    if (!targetUserId || Number.isNaN(targetUserId)) return ctx.reply('Укажи правильный ID: /remove 123456789');
    if (ADMIN_IDS.has(targetUserId)) return ctx.reply('Нельзя удалить пользователя из ADMIN_IDS. Сначала убери его из .env и перезапусти бота.');

    const targetUser = getUser(targetUserId);
    if (!targetUser) return ctx.reply(`Пользователь с ID ${targetUserId} не найден в базе.`);

    removeUser(targetUserId);
    removeBan(targetUserId);
    removeUserPlanSubscriptions(targetUserId);
    clearUserHistory(targetUserId);
    ctx.reply(`Пользователь ${targetUser.name ?? 'Без_имени'} (ID: ${targetUserId}) удалён из базы.`);
});

bot.command('ban', (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');
    const adminId = ctx.from?.id;
    if (!adminId) return;

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const targetUserId = Number.parseInt(parts[1], 10);
    if (!targetUserId || Number.isNaN(targetUserId)) return ctx.reply('Формат: /ban 123456789 [причина]');
    if (ADMIN_IDS.has(targetUserId)) return ctx.reply('Нельзя забанить пользователя из ADMIN_IDS.');

    const targetUser = getUser(targetUserId);
    if (!targetUser) return ctx.reply(`Пользователь с ID ${targetUserId} не найден в базе.`);

    const reason = parts.slice(2).join(' ').trim() || 'Решение администратора';
    banUserAccess(targetUserId, adminId, reason);
    ctx.reply(`Пользователь ${targetUser.name ?? 'Без_имени'} (ID: ${targetUserId}) забанен.`);

    bot.telegram.sendMessage(targetUserId, `🚫 Доступ заблокирован администратором.\nПричина: ${reason}`).catch(() => undefined);
});

bot.command('unban', (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const targetUserId = Number.parseInt(parts[1], 10);
    if (!targetUserId || Number.isNaN(targetUserId)) return ctx.reply('Формат: /unban 123456789');

    const targetUser = getUser(targetUserId);
    if (!targetUser) return ctx.reply(`Пользователь с ID ${targetUserId} не найден в базе.`);
    if (targetUser.status !== 'banned') return ctx.reply('Этот пользователь не находится в бане.');

    unbanUserAccess(targetUserId);
    ctx.reply(`Пользователь ${targetUser.name ?? 'Без_имени'} (ID: ${targetUserId}) разбанен и снова в ожидании.`);

    bot.telegram.sendMessage(targetUserId, '✅ Блокировка снята. Заявка снова в ожидании подтверждения.').catch(() => undefined);
});

// Команда смены имени
bot.command('rename', (ctx) => {
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

    const targetUser = getUser(targetUserId);
    if (!targetUser) return ctx.reply(`Пользователь с ID ${targetUserId} не найден в базе.`);

    updateUserName(targetUserId, newUserName);

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

bot.command('clear', (ctx) => {
    return handleClear(ctx);
});

bot.command('tz', (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const offset = Number.parseInt(ctx.message.text.split(' ')[1], 10);
    if (Number.isNaN(offset) || offset < -12 || offset > 14) {
        return ctx.reply('Использование: /tz <смещение_от_utc>. Например, для Города: /tz 7');
    }

    updateUserTimezone(userId, offset);
    timezoneSetupFlows.delete(userId);
    const sign = offset >= 0 ? '+' : '';
    return ctx.reply(`Часовой пояс успешно изменён на UTC${sign}${offset}.`, buildMenuTriggerKeyboard());
});

bot.command('tasks', (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        return ctx.reply('Нет доступа к задачам.');
    }

    const tasks = getUserTasks(userId, 'pending', 20);
    if (!tasks.length) return ctx.reply('У тебя нет активных напоминаний и расписаний.');

    const text = `Твои активные задачи (${tasks.length}/${MAX_PENDING_TASKS_PER_USER}):\n\n${formatTasksList(tasks)}`;
    return ctx.reply(text);
});

bot.command('task_delete', (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = getUser(userId);
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
    const updatedText = formatTasksList(updated, 'Активных задач больше нет.');
    return ctx.reply(`Удалил задачу #${taskId}.\n\nТекущие задачи (${updated.length}/${MAX_PENDING_TASKS_PER_USER}):\n\n${updatedText}`);
});

bot.command('note_add', (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const user = getUser(userId);
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

bot.command('notes', (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const user = getUser(userId);
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

bot.command('note_find', (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const user = getUser(userId);
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

bot.command('note_delete', (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const user = getUser(userId);
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

    const user = getUser(userId);
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

    const providerConfig = resolveImapProviderConfig(providerInput);
    if (!providerConfig) {
        return ctx.reply('Не удалось определить провайдер. Укажи явно: yandex или google.');
    }

    if (!email || !appPassword) {
        return ctx.reply('Email и пароль приложения обязательны.');
    }

    const encryptedPass = encryptSecret(appPassword);
    upsertMailAccount(
        userId,
        providerConfig.provider as MailProvider,
        email,
        encryptedPass,
        providerConfig.host,
        providerConfig.port,
        providerConfig.secure
    );
    setActiveMailProvider(userId, providerConfig.provider as MailProvider);
    updateUserMailSettings(
        userId,
        providerConfig.provider,
        email,
        encryptedPass,
        providerConfig.host,
        providerConfig.port,
        providerConfig.secure
    );

    const accounts = getMailAccountsForUser(userId);
    const connected = accounts.map(a => `${a.provider}: ${a.imap_user}`).join('\n');
    return ctx.reply(`✅ Почта привязана: ${email}\nПровайдер: ${providerConfig.provider} (активный)\n\nПодключенные ящики:\n${connected}\n\nПереключение: /mail_use <yandex|google>`);
});

bot.command('mail_use', (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const provider = normalizeMailProvider(parts[1]);
    if (!provider) {
        return ctx.reply('Использование: /mail_use <yandex|google>');
    }

    const account = getMailAccountForUser(userId, provider);
    if (!account) {
        return ctx.reply(`У тебя не привязан ${provider}. Сначала: /mail_setup ${provider} <email> <пароль_приложения>`);
    }

    setActiveMailProvider(userId, provider);
    updateUserMailSettings(userId, provider, account.imap_user, account.imap_pass, account.imap_host, account.imap_port, account.imap_secure);
    return ctx.reply(`✅ Активный почтовый ящик: ${provider} (${account.imap_user})`);
});

bot.command('mail_limit', (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const user = getUser(userId);
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

    updateUserMailCheckLimit(userId, parsed);
    return ctx.reply(`✅ Лимит check_emails обновлён: ${parsed}.`);
});

bot.command('mail_forget', (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const parts = ctx.message.text.split(' ').filter(Boolean);
    const provider = normalizeMailProvider(parts[1]);
    if (!provider) {
        clearUserMailSettings(userId);
        db.prepare('DELETE FROM mail_accounts WHERE user_id = ?').run(userId);
        return ctx.reply('🗑 Данные всех почтовых ящиков удалены.');
    }

    deleteMailAccount(userId, provider);
    const remaining = getMailAccountsForUser(userId);
    if (!remaining.length) {
        clearUserMailSettings(userId);
        return ctx.reply(`🗑 ${provider} удалён. Больше привязанных ящиков нет.`);
    }

    const nextActive = remaining[0];
    setActiveMailProvider(userId, nextActive.provider);
    updateUserMailSettings(userId, nextActive.provider, nextActive.imap_user, nextActive.imap_pass, nextActive.imap_host, nextActive.imap_port, nextActive.imap_secure);
    return ctx.reply(`🗑 ${provider} удалён. Активный ящик теперь: ${nextActive.provider} (${nextActive.imap_user})`);
});

bot.hears(TZ_BUTTON_SET_UTC, (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    timezoneSetupFlows.set(userId, 'await_offset');
    return ctx.reply('Окей, отправь смещение командой вида: /tz 7\nДопустимый диапазон: от -12 до +14.');
});

bot.on('location', (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = getUser(userId);
    if (!user) return;

    const longitude = ctx.message.location.longitude;
    let offset = Math.round(longitude / 15);
    if (offset < -12) offset = -12;
    if (offset > 14) offset = 14;

    updateUserTimezone(userId, offset);
    timezoneSetupFlows.delete(userId);
    const sign = offset >= 0 ? '+' : '';
    return ctx.reply(`Геопозиция получена. Примерный часовой пояс установлен: UTC${sign}${offset}.`, buildMenuTriggerKeyboard());
});

bot.action(/^main:(clear|users|rename|add|remove|prompts|current_prompt|context_size|prompt_admin|pending|banned|mail|notes|help)$/, async (ctx) => {
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

        const user = getUser(userId);
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

        const user = getUser(userId);
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

    if (actionId === 'context_size') {
        const userId = ctx.from?.id;
        if (!userId) return;
        const user = getUser(userId);
        if (!user) {
            await ctx.reply('Не нашёл тебя в базе. Попроси админа выдать доступ.');
            return;
        }
        await ctx.reply(
            `🗂 Размер контекста\nТекущий: ${resolveEffectiveContextWindow(user)}\nДоступно максимум: ${Math.max(1, user.context_window_max || getPlanContextLimit(parsePlanFromDb(user.plan)))}\nПлан: ${getPlanLabel(parsePlanFromDb(user.plan))}`,
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
        await ctx.reply('Команды: /menu, /clear, /tz, /tasks, /task_delete, /note_add, /notes, /note_find, /note_delete, /mail_setup, /mail_use, /mail_limit, /mail_forget, /rename, /prompts, /prompt_use, /add, /remove, /users, /ban, /unban, /prompt_add, /prompt_show, /prompt_set, /prompt_desc, /prompt_rename, /prompt_delete, /prompt_default');
        return;
    }

    await ctx.reply('Команды: /menu, /clear, /tz, /tasks, /task_delete, /note_add, /notes, /note_find, /note_delete, /mail_setup, /mail_use, /mail_limit, /mail_forget, /rename, /prompts, /prompt_use');
});

bot.action('context:change', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const user = getUser(userId);
    if (!user) {
        await ctx.answerCbQuery('Нет доступа');
        return;
    }

    contextLimitFlows.set(userId, 'await_limit');
    await ctx.answerCbQuery('Ожидаю число');
    await ctx.reply(
        `Введите новый размер контекста.\nСейчас: ${resolveEffectiveContextWindow(user)}\nМаксимум для вас: ${Math.max(1, user.context_window_max || getPlanContextLimit(parsePlanFromDb(user.plan)))}\nДля отмены: "отмена".`
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
    const user = getUser(userId);
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
    const user = getUser(userId);
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
    clearUserMailSettings(userId);
    await ctx.answerCbQuery('Почта удалена');
    await ctx.reply('🗑 Данные почты удалены.');
});

bot.action(/^notes:list:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const user = getUser(userId);
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
    const user = getUser(userId);
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
    const user = getUser(userId);
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
    const user = getUser(userId);
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
    const user = getUser(userId);
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
    const ok = approveUserAccess(targetUserId);
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
    const ok = disapproveUserAccess(targetUserId);
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

    const ok = banUserAccess(targetUserId, adminId, 'Решение администратора');
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
    const user = getUser(userId);
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
    const ok = unbanUserAccess(targetUserId);
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
    const user = getUser(userId);
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
    const user = getUser(userId);
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
    const user = getUser(userId);
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
    const user = getUser(userId);
    if (!user) {
        await ctx.answerCbQuery('Пользователь не найден');
        await renderAdminUsersList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
        return;
    }

    const endsAt = getEndsAtForDuration(duration);
    applyUserPlan(userId, plan, endsAt, adminId);
    trimUserHistory(userId);
    const refreshed = getUser(userId);
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
    const user = getUser(targetUserId);
    if (!user) {
        await ctx.answerCbQuery('Пользователь не найден');
        return;
    }

    adminUserContextLimitFlows.set(adminId, { targetUserId, page: Number.isNaN(page) ? 0 : page });
    await ctx.answerCbQuery('Ожидаю число');
    await ctx.reply(
        `Введите новый текущий размер контекста для пользователя #${targetUserId}.\nСейчас: ${resolveEffectiveContextWindow(user)}\nМаксимум по плану: ${Math.max(1, user.context_window_max || getPlanContextLimit(parsePlanFromDb(user.plan)))}\nДля админа ограничений нет.\nДля отмены: "отмена".`
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
    const user = getUser(targetUserId);
    if (!user) {
        await ctx.answerCbQuery('Пользователь не найден');
        return;
    }

    adminUserMessageLimitFlows.set(adminId, { targetUserId, page: Number.isNaN(page) ? 0 : page });
    const plan = parsePlanFromDb(user.plan);
    await ctx.answerCbQuery('Ожидаю число');
    await ctx.reply(
        `Введите лимит сообщений в день для пользователя #${targetUserId}.\nТекущий: ${normalizeDailyMessageLimit(user.daily_message_limit)}\nСегодня отправлено: ${user.daily_message_count ?? 0}\nПо плану ${getPlanLabel(plan)}: ${PLAN_DAILY_MESSAGE_LIMITS[plan]}\n0 = безлимит.\nДля отмены: "отмена".`
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
    const user = getUser(targetUserId);
    if (!user) {
        await ctx.answerCbQuery('Пользователь не найден');
        return;
    }
    if (ADMIN_IDS.has(targetUserId) || user.role === 'admin') {
        await ctx.answerCbQuery('Нельзя банить админа');
        return;
    }

    banUserAccess(targetUserId, adminId, 'Решение администратора');
    const refreshed = getUser(targetUserId);
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
    const user = getUser(targetUserId);
    if (!user) {
        await ctx.answerCbQuery('Пользователь не найден');
        return;
    }
    if (user.status !== 'banned') {
        await ctx.answerCbQuery('Он не в бане');
        return;
    }

    unbanUserAccess(targetUserId);
    const refreshed = getUser(targetUserId);
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
    const user = getUser(targetUserId);
    if (!user) {
        await ctx.answerCbQuery('Пользователь уже удален');
        await renderAdminUsersList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
        return;
    }
    if (ADMIN_IDS.has(targetUserId) || user.role === 'admin') {
        await ctx.answerCbQuery('Нельзя удалить админа');
        return;
    }

    removeUser(targetUserId);
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
    const targetUser = getUser(targetId);
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

    const user = getUser(userId);
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

    const user = getUser(userId);
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

    const user = getUser(userId);
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

    selectUserCustomPrompt(userId);
    const refreshed = getUser(userId);
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
    const user = getUser(userId);
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

    const user = getUser(userId);
    if (!user) {
        await ctx.answerCbQuery('Нет доступа');
        return;
    }

    if (ctx.state.role === 'admin') {
        await ctx.answerCbQuery('Для админа используйте /prompt_show <id>');
        return;
    }

    const promptId = Number.parseInt((ctx as any).match[1], 10);
    const prompt = getPromptById(promptId);
    if (!prompt) {
        await ctx.answerCbQuery('Промпт не найден');
        return;
    }

    await renderPromptCardInteractive(ctx, user, prompt);
    await ctx.answerCbQuery();
});

bot.action(/^prompt:use:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = getUser(userId);
    if (!user) {
        await ctx.answerCbQuery('Нет доступа');
        return;
    }

    if (ctx.state.role === 'admin') {
        await ctx.answerCbQuery('Для админа используйте /prompt_default или /prompt_use');
        return;
    }

    const promptId = Number.parseInt((ctx as any).match[1], 10);
    const prompt = getPromptById(promptId);
    if (!prompt) {
        await ctx.answerCbQuery('Промпт не найден');
        return;
    }

    updateUserPrompt(userId, promptId);
    const refreshedUser = getUser(userId);
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

const processUserTextThroughAi = async (
    ctx: any,
    rawText: string,
    options?: { forcePro?: boolean; persistUserText?: string; onAssistantReply?: (assistantText: string) => Promise<void> | void }
) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    let userText = rawText.trim();
    if (!userText) {
        await ctx.reply('Пустое сообщение. Попробуй ещё раз.');
        return;
    }
    const forceProRoute = Boolean(options?.forcePro) || userText.startsWith('!!!');
    if (forceProRoute && !options?.forcePro) {
        userText = userText.replace(/^!{3,}/, '').trim();
    }
    if (!userText) {
        await ctx.reply('После !!! нужен текст запроса.');
        return;
    }
    const userTextForHistory = options?.persistUserText?.trim() || userText;

    const userName = (ctx.state.userName as string | undefined) || 'Пользователь';
    const userRecord = getUser(userId);
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

    const activePrompt = resolvePromptForUser(userRecord);
    const timezoneOffset = typeof userRecord.timezone_offset === 'number' ? userRecord.timezone_offset : 5;
    const systemPrompt = `${buildSystemPrompt(activePrompt.content, userName, userRecord.core_memory || '')}${buildTimeContext(timezoneOffset)}`;
    const history = getUserHistory(userId);
    const baseTools = tools as unknown as any[];

    try {
        await ctx.sendChatAction('typing');

        let totalTokensForTurn = 0;
        const finishTurn = async (assistantText: string) => {
            incrementUserStats(userId, userTextForHistory.length, totalTokensForTurn);
            addHistoryMessage(userId, 'user', userTextForHistory);
            addHistoryMessage(userId, 'assistant', assistantText);
            trimUserHistory(userId);
            await safeReply(ctx, assistantText);
            if (options?.onAssistantReply) {
                await options.onAssistantReply(assistantText);
            }
        };

        let executionModelClient = ai;
        let executionModelName = MODEL_NAME;
        let executionTools = baseTools;
        let executionSystemPrompt = systemPrompt;
        let executionHistory = history;

        if (!forceProRoute) {
            type CheapRoute = 'SMART_HOME' | 'QUICK_SEARCH' | 'TIMEZONE' | 'RANDOM' | 'PRO';
            const cheapToolsMapping: Record<Exclude<CheapRoute, 'PRO'>, string[]> = {
                SMART_HOME: ['control_smart_home'],
                QUICK_SEARCH: ['search_web'],
                TIMEZONE: ['set_user_timezone'],
                RANDOM: ['random_roll']
            };

            let routeLabel: CheapRoute = 'PRO';
            const hasSchedulingIntent = /\b(напомн|напоминани|таймер|по\s+расписанию|отложи|позже|завтра|послезавтра|ежедневно|еженедельно|кажд(ый|ую|ое|ые)|every\s+day|every\s+week)\b/i.test(userText)
                || /\bв\s*\d{1,2}:\d{2}\b/i.test(userText)
                || /через\s+[^.,!?]{0,24}\b(секунд|секунду|секунды|сек|минут|минуту|минута|мин|час|часа|часов|ч|день|дня|дней|сутк|недел|месяц|месяца|месяцев)\b/i.test(userText);
            const routerPrompt = `Ты — маршрутизатор запросов. Твоя цель — определить категорию запроса.
Верни ТОЛЬКО ОДНО СЛОВО из списка ниже.

[ПРОСТЫЕ КАТЕГОРИИ - не требуют истории чата]:
- SMART_HOME (управление светом, розетками)
- QUICK_SEARCH (узнать погоду, курс валют, быстрый факт из сети)
- TIMEZONE (установить часовой пояс)
- RANDOM (бросить кубик, монетку)

[СЛОЖНАЯ КАТЕГОРИЯ]:
- PRO (любой сложный вопрос, программирование, анализ, почта (email), расписания, работа с памятью, заметки/блокнот, длинные беседы)

ВАЖНО: если в запросе есть отложенное/регулярное действие по времени ("через ...", "завтра", "в 10:30", "напомни", "каждый день"), выбирай ТОЛЬКО PRO, даже если там есть погода/поиск.

Запрос пользователя: "${userText}"`;

            if (!hasSchedulingIntent) {
                try {
                    const routerResponse = await aiLite.chat.completions.create({
                        model: LITE_MODEL_NAME,
                        messages: [{ role: 'user', content: routerPrompt }],
                        temperature: 0,
                        max_tokens: 100,
                        thinking: { type: 'disabled' }
                    } as any);
                    if (DEBUG_AI_RAW_LITE_RESPONSE) {
                        try {
                            console.log('[DEBUG_AI_RAW_LITE_RESPONSE][router]', JSON.stringify(routerResponse, null, 2));
                        } catch (err) {
                            console.warn('[DEBUG_AI_RAW_LITE_RESPONSE][router] Не удалось сериализовать ответ:', err);
                        }
                    }
                    totalTokensForTurn += extractTotalTokens(routerResponse);
                    const rawRoute = `${routerResponse.choices[0]?.message?.content || ''}`.toUpperCase();
                    const matchedRoute = rawRoute.match(/\b(SMART_HOME|QUICK_SEARCH|TIMEZONE|RANDOM|PRO)\b/);
                    if (
                        matchedRoute?.[1] === 'SMART_HOME'
                        || matchedRoute?.[1] === 'QUICK_SEARCH'
                        || matchedRoute?.[1] === 'TIMEZONE'
                        || matchedRoute?.[1] === 'RANDOM'
                        || matchedRoute?.[1] === 'PRO'
                    ) {
                        routeLabel = matchedRoute[1];
                    }
                } catch (err) {
                    console.warn('Ошибка дешёвого роутера, использую PRO:', err);
                }
            }

            if (routeLabel !== 'PRO') {
                const allowedToolNames = cheapToolsMapping[routeLabel];
                const allowedTools = baseTools.filter(tool => allowedToolNames.includes(`${tool?.function?.name || ''}`));
                if (allowedTools.length) {
                    executionModelClient = aiLite;
                    executionModelName = LITE_MODEL_NAME;
                    executionTools = allowedTools;
                    executionSystemPrompt = 'Ты ассистент. Выполни задачу пользователя, используя доступные функции. Отвечай максимально коротко.';
                    executionHistory = [];
                }
            }
        }

        const currentMessages: any[] = [
            { role: 'system', content: executionSystemPrompt },
            ...executionHistory,
            { role: 'user', content: userText }
        ];

        let answer = FALLBACK_ANSWER;
        let isGenerating = true;
        let loopCount = 0;
        const MAX_TOOL_LOOPS = 6;

        while (isGenerating && loopCount < MAX_TOOL_LOOPS) {
            loopCount += 1;

            const response = await executionModelClient.chat.completions.create({
                model: executionModelName,
                messages: currentMessages,
                tools: executionTools,
                tool_choice: 'auto',
                thinking: executionModelClient === aiLite ? { type: 'disabled' } : { type: 'enabled' },
                clear_thinking: false
            } as any);
            if (DEBUG_AI_RAW_MAIN_RESPONSE) {
                try {
                    console.log('[DEBUG_AI_RAW_MAIN_RESPONSE]', JSON.stringify(response, null, 2));
                } catch (err) {
                    console.warn('[DEBUG_AI_RAW_MAIN_RESPONSE] Не удалось сериализовать ответ:', err);
                }
            }
            if (DEBUG_AI_RAW_LITE_RESPONSE && executionModelClient === aiLite) {
                try {
                    console.log('[DEBUG_AI_RAW_LITE_RESPONSE][chat]', JSON.stringify(response, null, 2));
                } catch (err) {
                    console.warn('[DEBUG_AI_RAW_LITE_RESPONSE][chat] Не удалось сериализовать ответ:', err);
                }
            }
            totalTokensForTurn += extractTotalTokens(response);

            const message = response.choices[0].message;
            currentMessages.push(message as any);

            if (!message.tool_calls?.length) {
                answer = message.content || FALLBACK_ANSWER;
                isGenerating = false;
                break;
            }

            for (const toolCall of message.tool_calls) {
                if (toolCall.type !== 'function') continue;

                let toolContent = '';

                try {
                    if (toolCall.function.name === 'search_web') {
                        await ctx.reply('Ищу информацию в сети...');

                        let query = '';
                        try {
                            const parsed = JSON.parse(toolCall.function.arguments || '{}');
                            query = typeof parsed.query === 'string' ? parsed.query.trim() : '';
                        } catch (err) {
                            console.warn('Ошибка парсинга аргументов search_web:', err);
                        }

                        if (!query) {
                            toolContent = 'Ошибка инструмента: пустой поисковый запрос.';
                        } else {
                            try {
                                const webLimitState = checkWebSearchLimit(userId);
                                if (!webLimitState.allowed) {
                                    toolContent = webLimitState.reason;
                                } else {
                                    incrementUserWebSearchUsage(userId, 1);
                                    toolContent = await runWebSearch(query);
                                }
                            } catch (err) {
                                console.error('Ошибка поиска в Tavily:', err);
                                toolContent = 'Ошибка инструмента: не удалось получить результаты поиска.';
                            }
                        }
                    } else if (toolCall.function.name === 'control_smart_home') {
                        await ctx.reply('🏠 Выполняю команду умного дома...');

                        let args: SmartHomeArgs = {};
                        try {
                            args = JSON.parse(toolCall.function.arguments || '{}') as SmartHomeArgs;
                        } catch (err) {
                            console.warn('Ошибка парсинга аргументов control_smart_home:', err);
                        }

                        toolContent = await runSmartHomeControl(userId, args);
                    } else if (toolCall.function.name === 'schedule_task') {
                        if (!isTimezoneConfigured(userRecord)) {
                            toolContent = 'Ошибка планирования: часовой пояс пользователя не настроен. Попроси пользователя назвать город/страну или указать UTC-смещение, затем вызови set_user_timezone.';
                        } else {
                            const parsed = JSON.parse(toolCall.function.arguments || '{}') as ScheduleTaskArgs;

                            const taskType = parsed.task_type;
                            let payload = typeof parsed.payload === 'string' ? parsed.payload : '';
                            const recurrenceType = parsed.recurrence_type ?? 'once';
                            const rawWeekday = Number(parsed.recurrence_weekday);
                            const recurrenceWeekday = Number.isFinite(rawWeekday) ? Math.floor(rawWeekday) : null;
                            const notifyMode = parsed.notify_mode ?? 'always';
                            const notifyCondition = typeof parsed.notify_condition === 'string' ? parsed.notify_condition.trim() : null;

                            if (taskType !== 'message' && taskType !== 'smart_home' && taskType !== 'web_search' && taskType !== 'email_check') {
                                throw new Error('Некорректный task_type');
                            }
                            if (recurrenceType !== 'once' && recurrenceType !== 'daily' && recurrenceType !== 'weekly') {
                                throw new Error('Некорректный recurrence_type');
                            }
                            if (notifyMode !== 'always' && notifyMode !== 'never' && notifyMode !== 'on_match') {
                                throw new Error('Некорректный notify_mode');
                            }
                            if (notifyMode === 'on_match' && !notifyCondition) {
                                throw new Error('Для notify_mode=on_match укажи notify_condition.');
                            }
                            if (recurrenceWeekday !== null && (recurrenceWeekday < 1 || recurrenceWeekday > 7)) {
                                throw new Error('Для weekly укажи recurrence_weekday от 1 до 7 (1=понедельник).');
                            }
                            if (!payload.trim()) {
                                throw new Error('Пустой payload');
                            }
                            const pendingCount = getPendingTaskCount(userId);
                            if (pendingCount >= MAX_PENDING_TASKS_PER_USER) {
                                throw new Error(`Лимит активных задач: ${MAX_PENDING_TASKS_PER_USER}. Удали лишние через delete_my_task или /task_delete <id>.`);
                            }

                            if (taskType === 'smart_home') {
                                const smartHomePayload = JSON.parse(payload) as SmartHomeArgs;
                                payload = JSON.stringify(smartHomePayload);
                            }

                            const executeAt = computeExecuteAtFromScheduleArgs(parsed, timezoneOffset, recurrenceType, recurrenceWeekday);

                            addTask(
                                userId,
                                executeAt,
                                taskType,
                                payload,
                                recurrenceType,
                                recurrenceType === 'weekly' ? recurrenceWeekday : null,
                                timezoneOffset,
                                notifyMode,
                                notifyMode === 'on_match' ? notifyCondition : null
                            );
                            const planned = formatUnixForTimezone(executeAt, timezoneOffset);
                            const notifyInfo = notifyMode === 'on_match'
                                ? `on_match (${notifyCondition})`
                                : notifyMode;
                            toolContent = `Успешно запланировано. Следующий запуск: ${planned.local} (${planned.tzLabel}). UTC-время: ${planned.utc}. Тип расписания: ${recurrenceType}. Режим уведомлений: ${notifyInfo}.`;
                        }
                    } else if (toolCall.function.name === 'delete_my_task') {
                        const parsed = JSON.parse(toolCall.function.arguments || '{}') as DeleteTaskArgs;
                        const taskId = Number(parsed.task_id);
                        if (!Number.isFinite(taskId) || taskId <= 0) {
                            throw new Error('Некорректный task_id');
                        }

                        const task = getTaskByUserAndId(userId, Math.floor(taskId));
                        if (!task) {
                            throw new Error(`Задача #${Math.floor(taskId)} не найдена.`);
                        }
                        if (task.status !== 'pending') {
                            throw new Error(`Задача #${Math.floor(taskId)} уже не активна (status: ${task.status}).`);
                        }

                        const deleted = deletePendingTaskByUserAndId(userId, Math.floor(taskId));
                        if (!deleted.changes) {
                            throw new Error(`Не удалось удалить задачу #${Math.floor(taskId)}.`);
                        }

                        const updatedTasks = getUserTasks(userId, 'pending', 20);
                        const listText = formatTasksList(updatedTasks, 'Активных задач больше нет.');
                        toolContent = `Задача #${Math.floor(taskId)} удалена.\n\nОбновлённый список активных задач (${updatedTasks.length}/${MAX_PENDING_TASKS_PER_USER}):\n${listText}`;
                    } else if (toolCall.function.name === 'set_user_timezone') {
                        const args = JSON.parse(toolCall.function.arguments || '{}') as SetTimezoneArgs;
                        toolContent = await runSetUserTimezone(userId, args);
                    } else if (toolCall.function.name === 'get_my_tasks') {
                        const parsed = JSON.parse(toolCall.function.arguments || '{}') as {
                            status?: TaskStatus | 'all';
                            limit?: number;
                        };
                        const status = parsed.status && ['pending', 'done', 'error', 'all'].includes(parsed.status)
                            ? parsed.status
                            : 'pending';
                        const limit = typeof parsed.limit === 'number' ? parsed.limit : 20;
                        const tasks = getUserTasks(userId, status as TaskStatus | 'all', limit);
                        toolContent = formatTasksList(tasks);
                    } else if (toolCall.function.name === 'check_emails') {
                        const parsed = JSON.parse(toolCall.function.arguments || '{}') as CheckEmailsArgs;
                        const limit = typeof parsed.limit === 'number' ? parsed.limit : 5;
                        const searchQuery = typeof parsed.search_query === 'string' ? parsed.search_query : '';
                        const provider = typeof parsed.provider === 'string' ? parsed.provider : '';
                        const offset = typeof parsed.offset === 'number' ? parsed.offset : 0;
                        const dateFrom = typeof parsed.date_from === 'string' ? parsed.date_from : '';
                        const dateTo = typeof parsed.date_to === 'string' ? parsed.date_to : '';
                        toolContent = await runEmailCheck(userId, searchQuery, limit, provider, offset, dateFrom, dateTo);
                    } else if (toolCall.function.name === 'read_email_content') {
                        const parsed = JSON.parse(toolCall.function.arguments || '{}') as ReadEmailContentArgs;
                        const subjectPart = typeof parsed.subject_part === 'string' ? parsed.subject_part : '';
                        const provider = typeof parsed.provider === 'string' ? parsed.provider : '';
                        toolContent = await runEmailRead(userId, subjectPart, provider);
                    } else if (toolCall.function.name === 'send_email') {
                        const parsed = JSON.parse(toolCall.function.arguments || '{}') as SendEmailArgs;
                        const to = typeof parsed.to === 'string' ? parsed.to : '';
                        const subject = typeof parsed.subject === 'string' ? parsed.subject : '';
                        const body = typeof parsed.body === 'string' ? parsed.body : '';
                        const provider = typeof parsed.provider === 'string' ? parsed.provider : '';
                        toolContent = await runEmailSend(userId, to, subject, body, provider);
                    } else if (toolCall.function.name === 'save_note') {
                        const parsed = JSON.parse(toolCall.function.arguments || '{}') as SaveNoteArgs;
                        const content = typeof parsed.content === 'string' ? parsed.content : '';
                        const title = typeof parsed.title === 'string' ? parsed.title : '';
                        toolContent = runSaveNoteTool(userId, content, title);
                    } else if (toolCall.function.name === 'list_my_notes') {
                        const parsed = JSON.parse(toolCall.function.arguments || '{}') as ListMyNotesArgs;
                        const query = typeof parsed.query === 'string' ? parsed.query : '';
                        const limit = typeof parsed.limit === 'number' ? parsed.limit : undefined;
                        const offset = typeof parsed.offset === 'number' ? parsed.offset : undefined;
                        toolContent = runListMyNotesTool(userId, query, limit, offset);
                    } else if (toolCall.function.name === 'read_note') {
                        const parsed = JSON.parse(toolCall.function.arguments || '{}') as ReadNoteArgs;
                        toolContent = runReadNoteTool(userId, parsed.note_id);
                    } else if (toolCall.function.name === 'delete_note') {
                        const parsed = JSON.parse(toolCall.function.arguments || '{}') as DeleteNoteArgs;
                        toolContent = runDeleteNoteTool(userId, parsed.note_id);
                    } else if (toolCall.function.name === 'update_core_memory') {
                        const parsed = JSON.parse(toolCall.function.arguments || '{}') as UpdateCoreMemoryArgs;
                        const newFact = typeof parsed.new_fact === 'string' ? parsed.new_fact.trim() : '';
                        const explicitRequest = Boolean(parsed.explicit_request);
                        if (!newFact) {
                            throw new Error('Пустой new_fact');
                        }
                        toolContent = await runCoreMemoryMerge(userId, newFact, explicitRequest);
                    } else if (toolCall.function.name === 'random_roll') {
                        let args: RandomRollArgs = {};
                        try {
                            args = JSON.parse(toolCall.function.arguments || '{}') as RandomRollArgs;
                        } catch (err) {
                            console.warn('Ошибка парсинга аргументов random_roll:', err);
                        }

                        const target = args.roll_type === 'coin'
                            ? 'монетку'
                            : args.dice_notation
                                ? `кубики ${args.dice_notation}`
                                : 'кубики';
                        await ctx.reply(`Подкидываем ${target}...`);

                        toolContent = runRandomRoll(args);
                    } else {
                        toolContent = `Ошибка: неизвестный инструмент ${toolCall.function.name}`;
                    }
                } catch (err) {
                    toolContent = `Ошибка инструмента ${toolCall.function.name}: ${err instanceof Error ? err.message : String(err)}`;
                }

                currentMessages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: toolContent
                });
            }
        }

        if (isGenerating && loopCount >= MAX_TOOL_LOOPS) {
            console.warn(`Достигнут лимит tool-циклов (${MAX_TOOL_LOOPS}) для user_id=${userId}`);
        }

        await finishTurn(answer);
    } catch (e) {
        console.error(e);
        await ctx.reply('Блин, какая-то ошибка в системе. Проверь логи на сервере.');
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

    const adminContextFlow = adminUserContextLimitFlows.get(userId);
    if (adminContextFlow) {
        const lowered = userText.toLowerCase();
        if (lowered === 'отмена' || lowered === '/cancel') {
            adminUserContextLimitFlows.delete(userId);
            return ctx.reply('Ок, изменение контекста пользователя отменено.');
        }

        const parsed = Number.parseInt(userText, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return ctx.reply('Нужно ввести положительное число. Например: 25. Для отмены: "отмена".');
        }

        const targetUser = getUser(adminContextFlow.targetUserId);
        if (!targetUser) {
            adminUserContextLimitFlows.delete(userId);
            return ctx.reply('Пользователь не найден.');
        }

        const nextValue = Math.max(1, Math.floor(parsed));
        updateUserContextWindow(adminContextFlow.targetUserId, nextValue);
        trimUserHistory(adminContextFlow.targetUserId);
        adminUserContextLimitFlows.delete(userId);
        const refreshed = getUser(adminContextFlow.targetUserId);
        if (refreshed) {
            await ctx.reply(`✅ Контекст пользователя #${adminContextFlow.targetUserId} обновлён: ${resolveEffectiveContextWindow(refreshed)} (макс: ${Math.max(1, refreshed.context_window_max || getPlanContextLimit(parsePlanFromDb(refreshed.plan)))})`);
            await renderAdminUserCard(ctx, refreshed, adminContextFlow.page, 'reply');
            return;
        }
        return ctx.reply(`✅ Контекст пользователя #${adminContextFlow.targetUserId} обновлён: ${nextValue}.`);
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

        const targetUser = getUser(adminMessageLimitFlow.targetUserId);
        if (!targetUser) {
            adminUserMessageLimitFlows.delete(userId);
            return ctx.reply('Пользователь не найден.');
        }

        const nextLimit = normalizeDailyMessageLimit(parsed);
        updateUserDailyMessageLimit(adminMessageLimitFlow.targetUserId, nextLimit);
        adminUserMessageLimitFlows.delete(userId);
        const refreshed = getUser(adminMessageLimitFlow.targetUserId);
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

            const userRecord = getUser(userId);
            if (!userRecord) {
                renameFlows.delete(userId);
                return ctx.reply('Не нашёл тебя в базе. Попроси админа выдать доступ заново.');
            }

            updateUserName(userId, userText);
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

            const userRecord = getUser(userId);
            if (!userRecord) {
                customPromptEditFlows.delete(userId);
                return ctx.reply('Не нашёл тебя в базе. Попроси админа выдать доступ заново.');
            }

            updateUserCustomPrompt(userId, userText.trim());
            selectUserCustomPrompt(userId);
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

        const userRecord = getUser(userId);
        if (!userRecord) {
            mailLimitFlows.delete(userId);
            return ctx.reply('Не нашёл тебя в базе. Попроси админа выдать доступ заново.');
        }
        if (userRecord.role !== 'admin' && parsed > 10) {
            return ctx.reply('Для вас доступно максимум 10. Введи число от 1 до 10.');
        }

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
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return ctx.reply('Нужно ввести положительное число. Например: 10. Для отмены: "отмена".');
        }

        const userRecord = getUser(userId);
        if (!userRecord) {
            contextLimitFlows.delete(userId);
            return ctx.reply('Не нашёл тебя в базе. Попроси админа выдать доступ заново.');
        }

        const maxAllowed = Math.max(1, userRecord.context_window_max || getPlanContextLimit(parsePlanFromDb(userRecord.plan)));
        if (parsed > maxAllowed) {
            return ctx.reply(`Для тебя доступно максимум ${maxAllowed}. Введи число от 1 до ${maxAllowed}.`);
        }

        updateUserContextWindow(userId, Math.floor(parsed));
        trimUserHistory(userId);
        contextLimitFlows.delete(userId);
        const refreshed = getUser(userId);
        if (refreshed) {
            return ctx.reply(
                `✅ Размер контекста обновлён: ${resolveEffectiveContextWindow(refreshed)} из ${Math.max(1, refreshed.context_window_max || getPlanContextLimit(parsePlanFromDb(refreshed.plan)))}.`
            );
        }
        return ctx.reply(`✅ Размер контекста обновлён: ${Math.floor(parsed)}.`);
    }

    const noteEditFlow = noteEditFlows.get(userId);
    if (noteEditFlow) {
        const lowered = userText.toLowerCase();
        if (lowered === 'отмена' || lowered === '/cancel') {
            noteEditFlows.delete(userId);
            return ctx.reply('Ок, редактирование заметки отменено.');
        }

        const userRecord = getUser(userId);
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

    await processUserTextThroughAi(ctx, userText);
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
        const formData = new FormData();
        const mimeType = voice.mime_type || 'audio/ogg';
        formData.append('audio', new Blob([audioBuffer], { type: mimeType }), 'voice.ogg');

        const headers: Record<string, string> = {};
        if (VOICE_TRANSCRIBE_TOKEN) {
            headers.Authorization = `Bearer ${VOICE_TRANSCRIBE_TOKEN}`;
        }

        const kzResponse = await fetch(VOICE_TRANSCRIBE_URL, {
            method: 'POST',
            headers,
            body: formData
        });

        if (!kzResponse.ok) {
            const details = await kzResponse.text().catch(() => '');
            const extra = details ? ` | ${details.slice(0, 200)}` : '';
            throw new Error(`Ошибка от микросервиса: ${kzResponse.status} ${kzResponse.statusText}${extra}`);
        }

        const payload = await kzResponse.json() as VoiceTranscribeResponse;
        const text = typeof payload.text === 'string' ? payload.text.trim() : '';

        if (!text) {
            await ctx.telegram.editMessageText(chatId, processingMsg.message_id, undefined, '🗣 Ничего не расслышал.');
            return;
        }

        await ctx.telegram.editMessageText(chatId, processingMsg.message_id, undefined, `🗣 Распознано:\n${text}`);
        await processUserTextThroughAi(ctx, text, {
            persistUserText: text,
            onAssistantReply: async (assistantText: string) => {
                await sendVoiceResponse(ctx, assistantText);
            }
        });
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

setInterval(async () => {
    const nowUnix = Math.floor(Date.now() / 1000);
    const pendingTasks = getDueTasks(nowUnix);

    for (const task of pendingTasks) {
        try {
            let successMessage = '';
            if (task.task_type === 'message') {
                successMessage = `🔔 *Напоминание:*\n\n${task.payload}`;
            } else if (task.task_type === 'smart_home') {
                const smartHomeArgs = JSON.parse(task.payload) as SmartHomeArgs;
                const result = await runSmartHomeControl(task.user_id, smartHomeArgs);
                successMessage = `🤖 *Автоматизация сработала:*\n${result}`;
            } else if (task.task_type === 'web_search') {
                const result = await runScheduledWebSearchTask(task);
                successMessage = `🔎 *Запланированный поиск выполнен:*\n\n${result}`;
            } else if (task.task_type === 'email_check') {
                successMessage = await runScheduledEmailCheckTask(task);
            }

            if (successMessage && shouldNotifyTaskResult(task, successMessage)) {
                await safeSendToUser(task.user_id, successMessage);
            }

            if (task.recurrence_type === 'once') {
                updateTaskStatus(task.id, 'done');
            } else {
                const nextExecuteAt = computeNextRecurringExecuteAt(task);
                if (!nextExecuteAt) {
                    throw new Error(`Не удалось вычислить следующий запуск для recurring-задачи #${task.id}`);
                }
                updateTaskNextExecution(task.id, nextExecuteAt);
            }
        } catch (err) {
            console.error(`Ошибка при выполнении задачи ${task.id}:`, err);
            updateTaskStatus(task.id, 'error');
        }
    }
}, 30000);

setInterval(() => {
    try {
        expireFinishedPlanSubscriptions();
    } catch (err) {
        console.error('Ошибка проверки истекших подписок:', err);
    }
}, 60 * 60 * 1000);

try {
    expireFinishedPlanSubscriptions();
} catch (err) {
    console.error('Ошибка первичной проверки подписок:', err);
}

scheduleDailyCounterReset();

bot.launch();
console.log('Chatter запущен с базой данных!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
