import { Telegraf } from 'telegraf';
import OpenAI from 'openai';
import Database from 'better-sqlite3';
import * as dotenv from 'dotenv';
import { search, SafeSearchType } from 'duck-duck-scrape';

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_TOKEN!);
const ai = new OpenAI({
    apiKey: process.env.TIMEWEB_API_KEY,
    baseURL: process.env.TIMEWEB_BASE_URL,
});

// Инициализация базы данных
const db = new Database('chatter.db');
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        role TEXT NOT NULL
    )
`);

const sessions = new Map<number, any[]>();
const SYSTEM_PROMPT = `Ты — Chatter, дружелюбный ИИ-помощник...`; // Твой промпт
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

const trimHistory = (history: any[]) => {
    while (history.length > MAX_HISTORY_ITEMS) {
        history.shift();
    }
};

const safeReply = async (ctx: any, text: string) => {
    try {
        await ctx.reply(text, { parse_mode: 'Markdown' });
    } catch (err) {
        // Если Телега подавилась кривой разметкой от нейросети, шлём как обычный текст
        console.warn('Ошибка разметки, отправляю чистый текст');
        await ctx.reply(text);
    }
};

const runWebSearch = async (query: string) => {
    const searchResults = await search(query, { safeSearch: SafeSearchType.OFF });
    const topResults = searchResults.results.slice(0, 4);

    if (!topResults.length) {
        return `По запросу "${query}" ничего не найдено.`;
    }

    return topResults
        .map((item, index) => {
            const title = item.title || 'Без названия';
            const description = item.description || 'Описание отсутствует';
            const url = item.url || 'URL отсутствует';
            return `${index + 1}. ${title}\n${description}\nИсточник: ${url}`;
        })
        .join('\n\n');
};

// Вспомогательные функции для БД
const getUser = (username: string) => db.prepare('SELECT * FROM users WHERE username = ?').get(username) as { username: string, role: string } | undefined;
const addUser = (username: string, role: string) => db.prepare('INSERT OR REPLACE INTO users (username, role) VALUES (?, ?)').run(username, role);
const getAllUsers = () => db.prepare('SELECT * FROM users').all() as { username: string, role: string }[];

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
    sessions.set(ctx.from.id, []);
    ctx.reply('Память очищена.');
});

bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const userText = ctx.message.text;

    // Инициализация истории
    if (!sessions.has(userId)) sessions.set(userId, []);
    const history = sessions.get(userId)!;

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
                        console.error('Ошибка поиска в DuckDuckGo:', err);
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
                history.push({ role: 'user', content: userText });
                history.push({ role: 'assistant', content: finalAnswer });
                trimHistory(history);
                await safeReply(ctx, finalAnswer);
                return;
            }
        }

        const answer = message.content || FALLBACK_ANSWER;
        history.push({ role: 'user', content: userText });
        history.push({ role: 'assistant', content: answer });
        trimHistory(history);
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
