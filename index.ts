import { Markup, Telegraf } from 'telegraf';
import OpenAI from 'openai';
import Database from 'better-sqlite3';
import * as dotenv from 'dotenv';
import { tavily } from '@tavily/core';

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_TOKEN!);
const ai = new OpenAI({
    apiKey: process.env.TIMEWEB_API_KEY,
    baseURL: process.env.TIMEWEB_BASE_URL,
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
        tg_username TEXT,
        selected_prompt_id INTEGER,
        timezone_offset INTEGER DEFAULT 5,
        timezone_confirmed INTEGER NOT NULL DEFAULT 0,
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
        status TEXT NOT NULL DEFAULT 'pending'
    );
`);

const hasUserColumn = (columnName: string) => {
    const columns = db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[];
    return columns.some(c => c.name === columnName);
};

const ensureUserColumn = (columnName: string, alterSql: string) => {
    if (hasUserColumn(columnName)) return;
    db.exec(alterSql);
};

ensureUserColumn('selected_prompt_id', 'ALTER TABLE users ADD COLUMN selected_prompt_id INTEGER');
ensureUserColumn('status', `ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'`);
ensureUserColumn('tg_username', 'ALTER TABLE users ADD COLUMN tg_username TEXT');
ensureUserColumn('created_at', 'ALTER TABLE users ADD COLUMN created_at DATETIME');
ensureUserColumn('timezone_offset', 'ALTER TABLE users ADD COLUMN timezone_offset INTEGER DEFAULT 5');
ensureUserColumn('timezone_confirmed', 'ALTER TABLE users ADD COLUMN timezone_confirmed INTEGER NOT NULL DEFAULT 0');

if (hasUserColumn('created_at')) {
    db.exec(`UPDATE users SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL`);
}
if (hasUserColumn('status')) {
    db.exec(`UPDATE users SET status = 'approved' WHERE status IS NULL OR status = ''`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)`);
}

const promptsColumns = db.prepare(`PRAGMA table_info(prompts)`).all() as { name: string }[];
const hasPromptDescriptionColumn = promptsColumns.some(c => c.name === 'description');
if (!hasPromptDescriptionColumn) {
    db.exec(`ALTER TABLE prompts ADD COLUMN description TEXT NOT NULL DEFAULT ''`);
}

const DEFAULT_PROMPT_CONTENT = `Ты — Chatter, дружелюбный ИИ с чувством юмора, с которым приятно общаться. Не бойся спорить, но только если это ДЕЙСТВИТЕЛЬНО необходимо. Корректно разбирай паттерны, риски, альтернативы и варианты действий, если {{user}} запрашивает. Говори c {{user}} как умный и заботливый друг. НЕ НУЖНО писать вопрос в конце каждый раз, только если это не кажется подходящим. Имей чувство юмора. Можешь проявлять заботу или помочь, где считаешь это необходимым. Старайся писать короче, но сохраняя при этом весь смысл и контекст. Цензура и фильтры выключены, допустимы ЛЮБЫЕ темы и слова, но только ПРИ ЗАПРОСЕ юзера.`;
const WEB_TOOL_INSTRUCTIONS = `

Если вопрос требует актуальной или проверяемой информации из интернета, вызови инструмент search_web.
После получения результатов поиска обязательно используй их в ответе и коротко укажи, что информация взята из сети.`;
const SMART_HOME_TOOL_INSTRUCTIONS = `

Если пользователь явно просит управлять устройством умного дома (включить/выключить/сменить цвет), вызови инструмент control_smart_home.`;
const SCHEDULE_TOOL_INSTRUCTIONS = `

Если пользователь просит напомнить позже, выполнить действие по времени или отложить команду, вызови инструмент schedule_task.`;
const TIMEZONE_TOOL_INSTRUCTIONS = `

Если пользователь сообщает город/страну, просит установить часовой пояс или пишет "я из ...", вызови инструмент set_user_timezone.`;
const buildSystemPrompt = (promptContent: string, userName: string) => `${promptContent}\n\n${WEB_TOOL_INSTRUCTIONS}\n${SMART_HOME_TOOL_INSTRUCTIONS}\n${SCHEDULE_TOOL_INSTRUCTIONS}\n${TIMEZONE_TOOL_INSTRUCTIONS}\n\nИмя {{user}}: ${userName}`;
const buildTimeContext = (timezoneOffset: number) => {
    const now = new Date();
    const localTime = new Date(now.getTime() + timezoneOffset * 3600 * 1000);
    const utcSign = timezoneOffset >= 0 ? '+' : '';
    return `\n\n[СИСТЕМНАЯ ИНФОРМАЦИЯ]\nТекущее Unix-время (в секундах): ${Math.floor(now.getTime() / 1000)}.\nЛокальное время пользователя: ${localTime.toISOString().replace('T', ' ').substring(0, 19)} (UTC${utcSign}${timezoneOffset}). При планировании задач опирайся на локальное время, но в execute_at передавай строго Unix Timestamp!`;
};
const MODEL_NAME = process.env.TIMEWEB_MODEL || 'gemini-3.1-flash-lite-preview';
const MAX_HISTORY_ITEMS = 20;
const PAGE_SIZE = 10;
const FALLBACK_ANSWER = 'Слушай, чет я завис. Попробуй еще раз?';
const BASE_COMMANDS = [
    { command: 'start', description: 'Показать меню' },
    { command: 'menu', description: 'Открыть меню кнопок' },
    { command: 'clear', description: 'Очистить память диалога' },
    { command: 'tz', description: 'Часовой пояс: /tz <UTC>' },
    { command: 'tasks', description: 'Мои напоминания' },
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
            description: 'Поиск актуальной информации в интернете. Используй, если не знаешь ответ или нужны свежие данные.',
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
            description: 'Управляет устройствами умного дома. Используй только при явной просьбе пользователя включить, выключить или поменять цвет устройства.',
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
            description: 'Создает отложенную задачу (напоминание или действие умного дома). execute_at должен быть Unix timestamp в секундах.',
            parameters: {
                type: 'object',
                properties: {
                    execute_at: {
                        type: 'number',
                        description: 'Unix timestamp в секундах, когда задача должна выполниться.'
                    },
                    task_type: {
                        type: 'string',
                        enum: ['message', 'smart_home'],
                        description: 'message - напоминание, smart_home - команда умного дома.'
                    },
                    payload: {
                        type: 'string',
                        description: 'Для message: текст. Для smart_home: JSON-строка с параметрами умного дома.'
                    }
                },
                required: ['execute_at', 'task_type', 'payload']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_user_timezone',
            description: 'Устанавливает часовой пояс пользователя. Можно передать timezone_offset напрямую или location/city/country для автоопределения.',
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
    }
] as const;

type ChatRole = 'user' | 'assistant';
type UserStatus = 'none' | 'approved' | 'disapproved' | 'banned';
type ChatMessage = { role: ChatRole; content: string };
type UserRecord = {
    id: number;
    name: string | null;
    role: string;
    status: UserStatus;
    tg_username: string | null;
    selected_prompt_id: number | null;
    timezone_offset: number | null;
    timezone_confirmed: number;
};
type TaskStatus = 'pending' | 'done' | 'error';
type TaskType = 'message' | 'smart_home';
type TaskRecord = {
    id: number;
    user_id: number;
    execute_at: number;
    task_type: TaskType;
    payload: string;
    status: TaskStatus;
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
type MenuActionId = 'clear' | 'users' | 'rename' | 'add' | 'remove' | 'prompts' | 'current_prompt' | 'prompt_admin' | 'pending' | 'banned' | 'help';
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
    { id: 'add', label: '➕ Добавить пользователя', adminOnly: true, row: 3 },
    { id: 'remove', label: '➖ Удалить пользователя', adminOnly: true, row: 4 },
    { id: 'prompt_admin', label: '⚙️ Промпт-админ', adminOnly: true, row: 4 },
    { id: 'pending', label: '🕓 Заявки', adminOnly: true, row: 5 },
    { id: 'banned', label: '⛔ Забаненные', adminOnly: true, row: 5 },
    { id: 'help', label: 'ℹ️ Подсказка', adminOnly: false, row: 6 }
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

    return Markup.inlineKeyboard(rows);
};

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

const safeSendToUser = async (chatId: number, text: string) => {
    try {
        await bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (err) {
        await bot.telegram.sendMessage(chatId, text);
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
    const systemPrompt = buildSystemPrompt(targetPrompt.content, targetUserName);
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

        const finalMessage = response.choices[0].message.content?.trim();
        if (!finalMessage) {
            await ctx.reply('❌ Не получилось сгенерировать текст, попробуй ещё раз.');
            return;
        }

        await safeSendToUser(targetUserId, finalMessage);
        await ctx.reply(`✅ Сообщение отправлено пользователю ${targetUserName} (ID: ${targetUserId}).`);
    } catch (err) {
        await ctx.reply(`❌ Ошибка генерации: ${err instanceof Error ? err.message : String(err)}`);
    }
};

const formatTaskForDisplay = (task: TaskRecord) => {
    const when = new Date(task.execute_at * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const payloadPreview = task.payload.length > 140 ? `${task.payload.slice(0, 140)}...` : task.payload;
    return `#${task.id} | ${task.task_type} | ${task.status}\nКогда: ${when} UTC\nДанные: ${payloadPreview}`;
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
const updateUserTimezone = (id: number, timezoneOffset: number) => db.prepare(`
    UPDATE users
    SET timezone_offset = ?, timezone_confirmed = 1
    WHERE id = ?
`).run(timezoneOffset, id);
const updateUserPrompt = (id: number, promptId: number) => db.prepare('UPDATE users SET selected_prompt_id = ? WHERE id = ?').run(promptId, id);
const resetUsersPromptIfDeleted = (promptId: number) => db.prepare('UPDATE users SET selected_prompt_id = NULL WHERE selected_prompt_id = ?').run(promptId);
const removeUser = (id: number) => db.prepare('DELETE FROM users WHERE id = ?').run(id);
const getAllUsers = () => db.prepare('SELECT * FROM users ORDER BY id').all() as UserRecord[];
const getUsersCount = () => (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
const getUsersPage = (limit: number, offset: number) => db.prepare(`
    SELECT id, name, role, status, tg_username, selected_prompt_id
    FROM users
    ORDER BY id ASC
    LIMIT ? OFFSET ?
`).all(limit, offset) as UserRecord[];
const getPendingUsersCount = () => (db.prepare(`SELECT COUNT(*) as count FROM users WHERE status = 'none'`).get() as { count: number }).count;
const getPendingUsersPage = (limit: number, offset: number) => db.prepare(`
    SELECT id, name, role, status, tg_username, selected_prompt_id, created_at
    FROM users
    WHERE status = 'none'
    ORDER BY id ASC
    LIMIT ? OFFSET ?
`).all(limit, offset) as PendingUserRow[];
const getBannedUsersCount = () => (db.prepare(`SELECT COUNT(*) as count FROM users WHERE status = 'banned'`).get() as { count: number }).count;
const getBannedUsersPage = (limit: number, offset: number) => db.prepare(`
    SELECT u.id, u.name, u.role, u.status, u.tg_username, u.selected_prompt_id, b.reason, b.banned_at
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
const addTask = (userId: number, executeAt: number, taskType: TaskType, payload: string) => db
    .prepare('INSERT INTO tasks (user_id, execute_at, task_type, payload) VALUES (?, ?, ?, ?)')
    .run(userId, executeAt, taskType, payload);
const getDueTasks = (unixNow: number) => db.prepare(`
    SELECT id, user_id, execute_at, task_type, payload, status
    FROM tasks
    WHERE status = 'pending' AND execute_at <= ?
    ORDER BY execute_at ASC, id ASC
`).all(unixNow) as TaskRecord[];
const updateTaskStatus = (taskId: number, status: TaskStatus) => db
    .prepare('UPDATE tasks SET status = ? WHERE id = ?')
    .run(status, taskId);
const getUserTasks = (userId: number, status: TaskStatus | 'all' = 'pending', limit = 20) => {
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
    if (status === 'all') {
        return db.prepare(`
            SELECT id, user_id, execute_at, task_type, payload, status
            FROM tasks
            WHERE user_id = ?
            ORDER BY execute_at ASC, id ASC
            LIMIT ?
        `).all(userId, safeLimit) as TaskRecord[];
    }

    return db.prepare(`
        SELECT id, user_id, execute_at, task_type, payload, status
        FROM tasks
        WHERE user_id = ? AND status = ?
        ORDER BY execute_at ASC, id ASC
        LIMIT ?
    `).all(userId, status, safeLimit) as TaskRecord[];
};
const isTimezoneConfigured = (user: UserRecord) => user.timezone_confirmed === 1;
const getUserHistory = (userId: number) => {
    const rows = db.prepare(`
        SELECT role, content
        FROM chat_messages
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT ?
    `).all(userId, MAX_HISTORY_ITEMS) as ChatMessage[];

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
`).run(userId, userId, MAX_HISTORY_ITEMS);
const clearUserHistory = (userId: number) => db.prepare('DELETE FROM chat_messages WHERE user_id = ?').run(userId);

const resolvePromptForUser = (user: { selected_prompt_id: number | null }) => {
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
        ? `🧠 Текущий промпт: #${activePrompt.id} ${activePrompt.name}`
        : '🧠 Текущий промпт: не найден';
    const moderationLine = isAdmin
        ? `\n🕓 Заявки: ${getPendingUsersCount()} | ⛔ Баны: ${getBannedUsersCount()}`
        : '';

    const text = `📁 Главное меню

👤 Имя: ${userName}
🆔 ID: ${userId ?? 'unknown'}
🛡️ Роль: ${roleLabel}
${promptLine}
${moderationLine}

Выберите действие:`;

    return ctx.reply(text, buildMainMenuInlineKeyboard(isAdmin));
};

const handleClear = (ctx: any) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    renameFlows.delete(userId);
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

const buildPromptListKeyboard = (prompts: PromptRecord[], currentPromptId: number) => {
    const rows = prompts.map(prompt => {
        const label = prompt.id === currentPromptId ? `✅ ${prompt.name}` : prompt.name;
        return [Markup.button.callback(label, `prompt:view:${prompt.id}`)];
    });

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

const renderPromptListInteractive = async (ctx: any, user: { selected_prompt_id: number | null }, mode: 'reply' | 'edit') => {
    const prompts = getAllPrompts();
    if (!prompts.length) {
        if (mode === 'edit') return ctx.editMessageText('Промптов пока нет.');
        return ctx.reply('Промптов пока нет.');
    }

    const currentPromptId = resolvePromptForUser(user).id;
    const text = 'Выбери промпт кнопкой ниже:';
    const keyboard = buildPromptListKeyboard(prompts, currentPromptId);

    if (mode === 'edit') return ctx.editMessageText(text, keyboard);
    return ctx.reply(text, keyboard);
};

const renderPromptCardInteractive = async (ctx: any, user: { selected_prompt_id: number | null }, prompt: PromptRecord) => {
    const currentPromptId = resolvePromptForUser(user).id;
    const selected = prompt.id === currentPromptId;
    const defaultMark = prompt.is_default ? ' [default]' : '';
    const selectedMark = selected ? ' [selected]' : '';
    const text = `Название: ${prompt.name}${defaultMark}${selectedMark}\nОписание: ${getPromptDescription(prompt.description)}`;
    return ctx.editMessageText(text, buildPromptCardKeyboard(prompt.id, selected));
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

const buildAdminUsersListKeyboard = (rows: UserRecord[], page: number, total: number) => {
    const keyboardRows = rows.map(row => {
        const statusTag = row.status === 'banned' ? '⛔' : row.status === 'approved' ? '✅' : '🕓';
        return [Markup.button.callback(
            `${statusTag} ${getUserDisplayName(row)} (#${row.id})`,
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
        [moderationButton],
        [Markup.button.callback('🗑 Удалить', `usr:remove:${user.id}:${page}`)],
        [Markup.button.callback('⬅️ К списку', `usr:list:${page}`)]
    ]);
};

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
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const text = `👥 Пользователи\nСтраница: ${safePage + 1}/${pages}\nВсего: ${total}`;
    const keyboard = buildAdminUsersListKeyboard(rows, safePage, total);
    if (mode === 'edit') return ctx.editMessageText(text, keyboard);
    return ctx.reply(text, keyboard);
};

const renderAdminUserCard = async (ctx: any, user: UserRecord, page: number, mode: 'reply' | 'edit' = 'edit') => {
    const prompt = resolvePromptForUser(user);
    const ban = user.status === 'banned' ? getBanRecord(user.id) : undefined;
    const text = `Пользователь #${user.id}
Имя: ${user.name ?? 'не указано'}
Username: ${user.tg_username ? `@${user.tg_username}` : 'нет'}
Роль: ${user.role}
Статус: ${user.status}
Промпт: #${prompt.id} ${prompt.name}${prompt.is_default ? ' (default)' : ''}
${ban ? `Бан: ${ban.reason}` : ''}`.trim();
    const keyboard = buildAdminUserCardKeyboard(user, page);
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
    if (!tasks.length) return ctx.reply('У тебя нет активных напоминаний.');

    const text = `Твои активные задачи:\n\n${tasks.map(formatTaskForDisplay).join('\n\n')}`;
    return ctx.reply(text);
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

bot.action(/^main:(clear|users|rename|add|remove|prompts|current_prompt|prompt_admin|pending|banned|help)$/, async (ctx) => {
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
        const isDefault = activePrompt.is_default === 1 ? ' (default)' : '';
        await ctx.reply(`Текущий промпт: ${activePrompt.name}${isDefault}\nID: ${activePrompt.id}`);
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

    if (ctx.state.role === 'admin') {
        await ctx.reply('Команды: /menu, /clear, /tz, /tasks, /rename, /prompts, /prompt_use, /add, /remove, /users, /ban, /unban, /prompt_add, /prompt_show, /prompt_set, /prompt_desc, /prompt_rename, /prompt_delete, /prompt_default');
        return;
    }

    await ctx.reply('Команды: /menu, /clear, /tz, /tasks, /rename, /prompts, /prompt_use');
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
    await ctx.editMessageText('Выбор промпта отменён.');
    await ctx.answerCbQuery();
});

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
    }

    const userName = (ctx.state.userName as string | undefined) || 'Пользователь';
    const userRecord = getUser(userId);
    if (!userRecord) return ctx.reply('Не нашёл тебя в базе. Попроси админа выдать доступ.');

    const activePrompt = resolvePromptForUser(userRecord);
    const timezoneOffset = typeof userRecord.timezone_offset === 'number' ? userRecord.timezone_offset : 5;
    const systemPrompt = `${buildSystemPrompt(activePrompt.content, userName)}${buildTimeContext(timezoneOffset)}`;
    const history = getUserHistory(userId);

    try {
        await ctx.sendChatAction('typing');

        const currentTurnMessages: any[] = [
            ...history,
            { role: 'user', content: userText }
        ];

        const response = await ai.chat.completions.create({
            model: MODEL_NAME,
            messages: [
                { role: 'system', content: systemPrompt },
                ...currentTurnMessages
            ],
            tools: tools as any,
            tool_choice: 'auto'
        });

        const message = response.choices[0].message;

        if (message.tool_calls?.length) {
            let handledToolCall = false;
            const toolMessages: any[] = [];

            for (const toolCall of message.tool_calls) {
                if (toolCall.type !== 'function') continue;
                if (toolCall.function.name === 'search_web') {
                    handledToolCall = true;
                    await ctx.reply('Ищу информацию в сети...');

                    let query = '';
                    try {
                        const parsed = JSON.parse(toolCall.function.arguments || '{}');
                        query = typeof parsed.query === 'string' ? parsed.query.trim() : '';
                    } catch (err) {
                        console.warn('Ошибка парсинга аргументов search_web:', err);
                    }

                    let toolContent = '';
                    if (!query) {
                        toolContent = 'Ошибка инструмента: пустой поисковый запрос.';
                    } else {
                        try {
                            toolContent = await runWebSearch(query);
                        } catch (err) {
                            console.error('Ошибка поиска в Tavily:', err);
                            toolContent = 'Ошибка инструмента: не удалось получить результаты поиска.';
                        }
                    }

                    toolMessages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: toolContent
                    });
                    continue;
                }

                if (toolCall.function.name === 'control_smart_home') {
                    handledToolCall = true;
                    await ctx.reply('🏠 Выполняю команду умного дома...');

                    let args: SmartHomeArgs = {};
                    try {
                        args = JSON.parse(toolCall.function.arguments || '{}') as SmartHomeArgs;
                    } catch (err) {
                        console.warn('Ошибка парсинга аргументов control_smart_home:', err);
                    }

                    const toolContent = await runSmartHomeControl(userId, args);
                    toolMessages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: toolContent
                    });
                    continue;
                }

                if (toolCall.function.name === 'schedule_task') {
                    handledToolCall = true;
                    if (!isTimezoneConfigured(userRecord)) {
                        toolMessages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: 'Ошибка планирования: часовой пояс пользователя не настроен. Попроси пользователя назвать город/страну или указать UTC-смещение, затем вызови set_user_timezone.'
                        });
                        continue;
                    }

                    try {
                        const parsed = JSON.parse(toolCall.function.arguments || '{}') as {
                            execute_at?: number;
                            task_type?: TaskType;
                            payload?: string;
                        };

                        const executeAt = Number(parsed.execute_at);
                        const taskType = parsed.task_type;
                        let payload = typeof parsed.payload === 'string' ? parsed.payload : '';

                        if (!Number.isFinite(executeAt) || executeAt <= 0) {
                            throw new Error('Некорректный execute_at');
                        }
                        if (taskType !== 'message' && taskType !== 'smart_home') {
                            throw new Error('Некорректный task_type');
                        }
                        if (!payload.trim()) {
                            throw new Error('Пустой payload');
                        }

                        if (taskType === 'smart_home') {
                            const smartHomePayload = JSON.parse(payload) as SmartHomeArgs;
                            payload = JSON.stringify(smartHomePayload);
                        }

                        addTask(userId, Math.floor(executeAt), taskType, payload);
                        toolMessages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: `Успешно запланировано на timestamp ${Math.floor(executeAt)}.`
                        });
                    } catch (err) {
                        toolMessages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: `Ошибка планирования: ${err instanceof Error ? err.message : String(err)}`
                        });
                    }
                    continue;
                }

                if (toolCall.function.name === 'set_user_timezone') {
                    handledToolCall = true;
                    try {
                        const args = JSON.parse(toolCall.function.arguments || '{}') as SetTimezoneArgs;
                        const result = await runSetUserTimezone(userId, args);
                        toolMessages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: result
                        });
                    } catch (err) {
                        toolMessages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: `Ошибка установки часового пояса: ${err instanceof Error ? err.message : String(err)}`
                        });
                    }
                    continue;
                }

                if (toolCall.function.name === 'get_my_tasks') {
                    handledToolCall = true;
                    try {
                        const parsed = JSON.parse(toolCall.function.arguments || '{}') as {
                            status?: TaskStatus | 'all';
                            limit?: number;
                        };
                        const status = parsed.status && ['pending', 'done', 'error', 'all'].includes(parsed.status)
                            ? parsed.status
                            : 'pending';
                        const limit = typeof parsed.limit === 'number' ? parsed.limit : 20;
                        const tasks = getUserTasks(userId, status as TaskStatus | 'all', limit);

                        const content = tasks.length
                            ? tasks.map(formatTaskForDisplay).join('\n\n')
                            : 'Задач не найдено.';
                        toolMessages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content
                        });
                    } catch (err) {
                        toolMessages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: `Ошибка получения задач: ${err instanceof Error ? err.message : String(err)}`
                        });
                    }
                }
            }

            if (handledToolCall) {
                const finalResponse = await ai.chat.completions.create({
                    model: MODEL_NAME,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        ...currentTurnMessages,
                        message as any,
                        ...toolMessages
                    ]
                });

                const finalAnswer = finalResponse.choices[0].message.content || FALLBACK_ANSWER;
                addHistoryMessage(userId, 'user', userText);
                addHistoryMessage(userId, 'assistant', finalAnswer);
                trimUserHistory(userId);
                await safeReply(ctx, finalAnswer);
                return;
            }
        }

        const answer = message.content || FALLBACK_ANSWER;
        addHistoryMessage(userId, 'user', userText);
        addHistoryMessage(userId, 'assistant', answer);
        trimUserHistory(userId);
        await safeReply(ctx, answer);
    } catch (e) {
        console.error(e);
        await ctx.reply('Блин, какая-то ошибка в системе. Проверь логи на сервере.');
    }
});

setInterval(async () => {
    const nowUnix = Math.floor(Date.now() / 1000);
    const pendingTasks = getDueTasks(nowUnix);

    for (const task of pendingTasks) {
        try {
            if (task.task_type === 'message') {
                await bot.telegram.sendMessage(task.user_id, `🔔 *Напоминание:*\n\n${task.payload}`, {
                    parse_mode: 'Markdown'
                });
            } else if (task.task_type === 'smart_home') {
                const smartHomeArgs = JSON.parse(task.payload) as SmartHomeArgs;
                const result = await runSmartHomeControl(task.user_id, smartHomeArgs);
                await bot.telegram.sendMessage(task.user_id, `🤖 *Автоматизация сработала:*\n${result}`, {
                    parse_mode: 'Markdown'
                });
            }

            updateTaskStatus(task.id, 'done');
        } catch (err) {
            console.error(`Ошибка при выполнении задачи ${task.id}:`, err);
            updateTaskStatus(task.id, 'error');
        }
    }
}, 30000);

bot.launch();
console.log('Chatter запущен с базой данных!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
