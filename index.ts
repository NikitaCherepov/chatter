import { Telegraf } from 'telegraf';
import OpenAI from 'openai';
import Database from 'better-sqlite3';
import * as dotenv from 'dotenv';

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
        return ctx.reply("У тебя не установлен @username в Telegram. Я не могу тебя идентифицировать.");
    }

    const userRecord = getUser(username);
    
    if (!userRecord) {
        return ctx.reply("Доступ закрыт. Попроси администратора добавить твой никнейм.");
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
    if (!username) return ctx.reply("Нужен @username.");

    const password = ctx.message.text.split(' ')[1];
    if (password === process.env.ADMIN_PASSWORD) {
        addUser(username, 'admin');
        ctx.reply("Пароль принят. Права администратора выданы. Используй /add <ник> для добавления пользователей.");
    } else {
        ctx.reply("Неверный пароль.");
    }
});

// Команда добавления пользователя (только для админов)
bot.command('add', (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply("Эта команда только для админов.");
    
    const newUsername = ctx.message.text.split(' ')[1]?.replace('@', '');
    if (!newUsername) return ctx.reply("Укажи никнейм: /add username");

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
    ctx.reply("Память очищена.");
});

bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const userText = ctx.message.text;

    // Инициализация истории
    if (!sessions.has(userId)) sessions.set(userId, []);
    const history = sessions.get(userId)!;

    try {
        await ctx.sendChatAction('typing');

        const response = await ai.chat.completions.create({
            model: 'gemini-3.1-flash-lite-preview', // Или ту, что указана в кабинете Timeweb
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                ...history,
                { role: 'user', content: userText }
            ],
        });

        const answer = response.choices[0].message.content || "Слушай, чет я завис. Попробуй еще раз?";

        // Сохраняем в контекст
        history.push({ role: 'user', content: userText });
        history.push({ role: 'assistant', content: answer });

        // Ограничиваем контекст (последние 10 сообщений)
        if (history.length > 20) history.splice(0, 2);

        try {
            await ctx.reply(answer, { parse_mode: 'Markdown' });
        } catch (err) {
            // Если Телега подавилась кривой разметкой от нейросети, шлём как обычный текст
            console.warn("Ошибка разметки, отправляю чистый текст");
            await ctx.reply(answer);
        }
    } catch (e) {
        console.error(e);
        await ctx.reply("Блин, какая-то ошибка в системе. Проверь логи на сервере.");
    }
});

bot.launch();
console.log('Chatter запущен с базой данных!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
