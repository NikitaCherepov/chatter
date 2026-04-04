import { Telegraf } from 'telegraf';
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
        role TEXT NOT NULL
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
`);

const SYSTEM_PROMPT = `Ты — Chatter, дружелюбный ИИ с чувством юмора, с которым приятно общаться. Не бойся спорить, но только если это ДЕЙСТВИТЕЛЬНО необходимо. Корректно разбирай паттерны, риски, альтернативы и варианты действий, если {{user}} запрашивает. Говори c {{user}} как умный и заботливый друг. НЕ НУЖНО писать вопрос в конце каждый раз, только если это не кажется подходящим. Имей чувство юмора. Можешь проявлять заботу или помочь, где считаешь это необходимым. Старайся писать короче, но сохраняя при этом весь смысл и контекст.`; // Твой промпт
const TOOL_HINT_PROMPT = `${SYSTEM_PROMPT}

Если вопрос требует актуальной или проверяемой информации из интернета, вызови инструмент search_web.
После получения результатов поиска обязательно используй их в ответе и коротко укажи, что информация взята из сети.`;
const MODEL_NAME = process.env.TIMEWEB_MODEL || 'gemini-3.1-flash-lite-preview';
const MAX_HISTORY_ITEMS = 20;
const FALLBACK_ANSWER = 'Слушай, чет я завис. Попробуй еще раз?';
const ADMIN_IDS = (() => {
    const ids = new Set<number>();

    for (const raw of (process.env.ADMIN_IDS ?? '').split(',')) {
        const value = Number.parseInt(raw.trim(), 10);
        if (!Number.isNaN(value) && value > 0) ids.add(value);
    }

    for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith('ADMIN_ID_')) continue;
        const id = Number.parseInt((value ?? '').trim(), 10);
        if (!Number.isNaN(id) && id > 0) ids.add(id);
    }

    return ids;
})();

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
    }
] as const;

type ChatRole = 'user' | 'assistant';
type ChatMessage = { role: ChatRole; content: string };

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

// Вспомогательные функции для БД
const getUser = (id: number) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) as { id: number, name: string, role: string } | undefined;
const addUser = (id: number, name: string, role: string) => db.prepare('INSERT OR REPLACE INTO users (id, name, role) VALUES (?, ?, ?)').run(id, name, role);
const updateUserName = (id: number, name: string) => db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id);
const getAllUsers = () => db.prepare('SELECT * FROM users').all() as { id: number, name: string, role: string }[];
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

// Middleware для авторизации
bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const userRecord = getUser(userId);

    if (ADMIN_IDS.has(userId)) {
        const envAdminName = ctx.from?.first_name || userRecord?.name || 'Admin';
        if (!userRecord || userRecord.role !== 'admin' || userRecord.name !== envAdminName) {
            addUser(userId, envAdminName, 'admin');
        }

        ctx.state.role = 'admin';
        ctx.state.userName = envAdminName;
        return next();
    }

    if (!userRecord) {
        return ctx.reply(`Доступ закрыт 🛑\n\nТвой Telegram ID: \`${userId}\`\nОтправь этот ID администратору, чтобы получить доступ.`, { parse_mode: 'Markdown' });
    }

    ctx.state.role = userRecord.role;
    ctx.state.userName = userRecord.name;
    return next();
});

bot.telegram.setMyCommands([
    { command: 'clear', description: 'Очистить память диалога' },
    { command: 'add', description: 'Добавить юзера (только админ)' },
    { command: 'rename', description: 'Переименовать юзера (только админ)' },
    { command: 'users', description: 'Список юзеров (только админ)' }
]);

// Команда добавления пользователя (только для админов)
bot.command('add', (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const newUserId = Number.parseInt(parts[1], 10);
    const newUserName = parts.slice(2).join(' ') || 'Без_имени';

    if (!newUserId || Number.isNaN(newUserId)) return ctx.reply('Укажи правильный ID: /add 123456789 Имя');

    addUser(newUserId, newUserName, 'user');
    ctx.reply(`Пользователь ${newUserName} (ID: ${newUserId}) успешно добавлен в базу.`);
});

// Команда смены имени пользователя (только для админов)
bot.command('rename', (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const targetUserId = Number.parseInt(parts[1], 10);
    const newUserName = parts.slice(2).join(' ').trim();

    if (!targetUserId || Number.isNaN(targetUserId)) return ctx.reply('Укажи правильный ID: /rename 123456789 НовоеИмя');
    if (!newUserName) return ctx.reply('Укажи новое имя: /rename 123456789 НовоеИмя');

    const targetUser = getUser(targetUserId);
    if (!targetUser) return ctx.reply(`Пользователь с ID ${targetUserId} не найден в базе.`);

    updateUserName(targetUserId, newUserName);
    ctx.reply(`Имя пользователя с ID ${targetUserId} обновлено: ${targetUser.name ?? 'Без_имени'} -> ${newUserName}`);
});

// Команда просмотра списка (только для админов)
bot.command('users', (ctx) => {
    if (ctx.state.role !== 'admin') return;

    const users = getAllUsers();
    const list = users.map(u => `- ${u.name ?? 'Без_имени'} (ID: ${u.id}) — ${u.role}`).join('\n');
    ctx.reply(`Список пользователей:\n${list}`);
});

bot.command('clear', (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    clearUserHistory(userId);
    ctx.reply('Память очищена.');
});

bot.on('text', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const userText = ctx.message.text;
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
                { role: 'system', content: TOOL_HINT_PROMPT },
                ...currentTurnMessages
            ],
            tools: tools as any,
            tool_choice: 'auto'
        });

        const message = response.choices[0].message;

        if (message.tool_calls?.length) {
            let handledSearch = false;
            const toolMessages: any[] = [];

            for (const toolCall of message.tool_calls) {
                if (toolCall.type !== 'function') continue;
                if (toolCall.function.name !== 'search_web') continue;

                handledSearch = true;
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
            }

            if (handledSearch) {
                const finalResponse = await ai.chat.completions.create({
                    model: MODEL_NAME,
                    messages: [
                        { role: 'system', content: TOOL_HINT_PROMPT },
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

bot.launch();
console.log('Chatter запущен с базой данных!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
