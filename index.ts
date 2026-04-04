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
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        role TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_username_id
    ON chat_messages(username, id);
`);

const SYSTEM_PROMPT = `Ты — Chatter, дружелюбный ИИ с чувством юмора, с которым приятно общаться. Не бойся спорить, но только если это ДЕЙСТВИТЕЛЬНО необходимо. Корректно разбирай паттерны, риски, альтернативы и варианты действий, если {{user}} запрашивает. Говори c {{user}} как умный и заботливый друг. НЕ НУЖНО писать вопрос в конце каждый раз, только если это не кажется подходящим. Имей чувство юмора. Можешь проявлять заботу или помочь, где считаешь это необходимым. Старайся писать короче, но сохраняя при этом весь смысл и контекст.`; // Твой промпт
const TOOL_HINT_PROMPT = `${SYSTEM_PROMPT}

Если вопрос требует актуальной или проверяемой информации из интернета, вызови инструмент search_web.
После получения результатов поиска обязательно используй их в ответе и коротко укажи, что информация взята из сети.`;
const MODEL_NAME = process.env.TIMEWEB_MODEL || 'gemini-3.1-flash-lite-preview';
const MAX_HISTORY_ITEMS = 20;
const FALLBACK_ANSWER = 'Слушай, чет я завис. Попробуй еще раз?';

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
const getUser = (username: string) => db.prepare('SELECT * FROM users WHERE username = ?').get(username) as { username: string, role: string } | undefined;
const addUser = (username: string, role: string) => db.prepare('INSERT OR REPLACE INTO users (username, role) VALUES (?, ?)').run(username, role);
const getAllUsers = () => db.prepare('SELECT * FROM users').all() as { username: string, role: string }[];
const getUserHistory = (username: string) => {
    const rows = db.prepare(`
        SELECT role, content
        FROM chat_messages
        WHERE username = ?
        ORDER BY id DESC
        LIMIT ?
    `).all(username, MAX_HISTORY_ITEMS) as ChatMessage[];

    return rows.reverse();
};
const addHistoryMessage = (username: string, role: ChatRole, content: string) => db
    .prepare('INSERT INTO chat_messages (username, role, content) VALUES (?, ?, ?)')
    .run(username, role, content);
const trimUserHistory = (username: string) => db.prepare(`
    DELETE FROM chat_messages
    WHERE username = ?
      AND id NOT IN (
        SELECT id
        FROM chat_messages
        WHERE username = ?
        ORDER BY id DESC
        LIMIT ?
      )
`).run(username, username, MAX_HISTORY_ITEMS);
const clearUserHistory = (username: string) => db.prepare('DELETE FROM chat_messages WHERE username = ?').run(username);

// Middleware для авторизации
bot.use(async (ctx, next) => {
    const username = ctx.from?.username;
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';

    // Пропускаем попытку авторизации админа
    if (text.startsWith('/admin ')) return next();

    if (!username) {
        return ctx.reply('У тебя не установлен @username в Telegram. Я не могу тебя идентифицировать.');
    }

    const userRecord = getUser(username);
    if (!userRecord) {
        return ctx.reply('Доступ закрыт. Попроси администратора добавить твой никнейм.');
    }

    // Прокидываем роль пользователя дальше в контекст (полезно для команд)
    ctx.state.role = userRecord.role;
    return next();
});

bot.telegram.setMyCommands([
    { command: 'clear', description: 'Очистить память диалога' },
    { command: 'admin', description: 'Получить права админа' },
    { command: 'add', description: 'Добавить юзера (только админ)' },
    { command: 'users', description: 'Список юзеров (только админ)' }
]);

// Команда получения прав админа
bot.command('admin', (ctx) => {
    const username = ctx.from?.username;
    if (!username) return ctx.reply('Нужен @username.');

    const password = ctx.message.text.split(' ')[1];
    if (password === process.env.ADMIN_PASSWORD) {
        addUser(username, 'admin');
        ctx.reply('Пароль принят. Права администратора выданы. Используй /add <ник> для добавления пользователей.');
    } else {
        ctx.reply('Неверный пароль.');
    }
});

// Команда добавления пользователя (только для админов)
bot.command('add', (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply('Эта команда только для админов.');

    const newUsername = ctx.message.text.split(' ')[1]?.replace('@', '');
    if (!newUsername) return ctx.reply('Укажи никнейм: /add username');

    addUser(newUsername, 'user');
    ctx.reply(`Пользователь @${newUsername} добавлен в базу.`);
});

// Команда просмотра списка (только для админов)
bot.command('users', (ctx) => {
    if (ctx.state.role !== 'admin') return;

    const users = getAllUsers();
    const list = users.map(u => `- @${u.username} (${u.role})`).join('\n');
    ctx.reply(`Список пользователей:\n${list}`);
});

bot.command('clear', (ctx) => {
    const username = ctx.from?.username;
    if (!username) return ctx.reply('Нужен @username.');

    clearUserHistory(username);
    ctx.reply('Память очищена.');
});

bot.on('text', async (ctx) => {
    const username = ctx.from?.username;
    if (!username) return ctx.reply('Нужен @username.');

    const userText = ctx.message.text;
    const history = getUserHistory(username);

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
                addHistoryMessage(username, 'user', userText);
                addHistoryMessage(username, 'assistant', finalAnswer);
                trimUserHistory(username);
                await safeReply(ctx, finalAnswer);
                return;
            }
        }

        const answer = message.content || FALLBACK_ANSWER;
        addHistoryMessage(username, 'user', userText);
        addHistoryMessage(username, 'assistant', answer);
        trimUserHistory(username);
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
