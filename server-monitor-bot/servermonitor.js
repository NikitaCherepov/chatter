const path = require('path');
const { spawn } = require('child_process');
const { Markup, Telegraf } = require('telegraf');
const OpenAI = require('openai');
const Database = require('better-sqlite3');
require('dotenv').config();

const BOT_TOKEN = (process.env.MONITOR_BOT_TOKEN || '').trim();
const ADMIN_ID = Number.parseInt(process.env.MONITOR_ADMIN_ID || '', 10);
const AI_API_KEY = (process.env.MONITOR_AI_API_KEY || '').trim();
const AI_BASE_URL = (process.env.MONITOR_AI_BASE_URL || '').trim();
const AI_MODEL = (process.env.MONITOR_AI_MODEL || 'qwen/qwen-2.5-7b-instruct').trim();

const MONITOR_PM2_LOG_LINES = Math.max(
    20,
    Math.min(500, Number.parseInt(process.env.MONITOR_PM2_LOG_LINES || '120', 10) || 120)
);
const MONITOR_PM2_TIMEOUT_MS = Math.max(
    5000,
    Math.min(120000, Number.parseInt(process.env.MONITOR_PM2_TIMEOUT_MS || '20000', 10) || 20000)
);
const PM2_ALLOWED_TARGETS = (process.env.MONITOR_PM2_ALLOWED_TARGETS || '')
    .split(/[,\s;]+/)
    .map((item) => item.trim())
    .filter(Boolean);

const MONITOR_DB_PATH = (process.env.MONITOR_DB_PATH || '').trim()
    ? path.resolve(process.cwd(), process.env.MONITOR_DB_PATH.trim())
    : path.resolve(process.cwd(), 'watchdog.db');
const MONITOR_HISTORY_LIMIT = Math.max(
    1,
    Math.min(50, Number.parseInt(process.env.MONITOR_HISTORY_LIMIT || '10', 10) || 10)
);
const MONITOR_HISTORY_ITEM_MAX_CHARS = Math.max(
    200,
    Math.min(4000, Number.parseInt(process.env.MONITOR_HISTORY_ITEM_MAX_CHARS || '1200', 10) || 1200)
);

if (!BOT_TOKEN) throw new Error('MONITOR_BOT_TOKEN is required');
if (!Number.isFinite(ADMIN_ID) || ADMIN_ID <= 0) throw new Error('MONITOR_ADMIN_ID is required');
if (!AI_API_KEY) throw new Error('MONITOR_AI_API_KEY is required');
if (!AI_BASE_URL) throw new Error('MONITOR_AI_BASE_URL is required');

const db = new Database(MONITOR_DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_history_user_id_id
ON chat_history(user_id, id DESC);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
`);

const insertHistoryStmt = db.prepare(`
    INSERT INTO chat_history (user_id, role, content)
    VALUES (?, ?, ?)
`);
const getRecentHistoryStmt = db.prepare(`
    SELECT role, content
    FROM chat_history
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT ?
`);
const trimHistoryStmt = db.prepare(`
    DELETE FROM chat_history
    WHERE user_id = ?
      AND id NOT IN (
        SELECT id
        FROM chat_history
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT ?
      )
`);
const clearHistoryStmt = db.prepare(`
    DELETE FROM chat_history
    WHERE user_id = ?
`);
const getSettingStmt = db.prepare(`
    SELECT value
    FROM settings
    WHERE key = ?
    LIMIT 1
`);
const upsertSettingStmt = db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, strftime('%s', 'now'))
    ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
`);

const LOG_INTERPRETER_SETTING_KEY = 'log_interpreter';
upsertSettingStmt.run(
    LOG_INTERPRETER_SETTING_KEY,
    (getSettingStmt.get(LOG_INTERPRETER_SETTING_KEY)?.value || 'off').toLowerCase() === 'on' ? 'on' : 'off'
);

const bot = new Telegraf(BOT_TOKEN);
const openai = new OpenAI({ apiKey: AI_API_KEY, baseURL: AI_BASE_URL });

const SYSTEM_PROMPT = `Ты — технический консольный ассистент. 
Твоя работа: выполнять команды PM2 для процессов на этом сервере.

ОСНОВНЫЕ ЮНИТЫ:
- "chatter" (основной бот, "чаттер")
- "webapp-notes" (веб-интерфейс, "заметки")
- "watchdog" (это ТЫ)

ПРАВИЛА:
1. Если пользователь называет процесс по-русски или сленгом — сопоставляй с ID/Name из списка (например: "чаттер" -> chatter, "заметки" -> webapp-notes).
3. Команды для СЕБЯ (watchdog) выполняй только если прямо попросили "рестартни себя" или "рестартни админа".

Разрешённые инструменты: list, status, restart, stop, logs, flush.
Отвечай максимально коротко и технично.`;
const LOG_INTERPRETER_PROMPT = `Ты анализируешь логи сервисов.
Ответ: кратко, технично, по делу.
Формат:
1) Состояние (OK / WARNING / ERROR)
2) Что обнаружено (1-4 пункта)
3) Что сделать (до 3 шагов)

Если в логах нет явных проблем — так и скажи.`;

const ALLOWED_ACTIONS = new Set(['list', 'status', 'restart', 'stop', 'logs', 'flush']);
const PM2_TARGET_RE = /^[a-zA-Z0-9._:-]{1,80}$/;
const ALL_TARGET_ALIASES = new Set(['all', 'все', 'всё', 'all_logs', 'all-logs']);

const escapeHtml = (text) => text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

const clipText = (text, max = 3900) => {
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n...`;
};

const normalizeHistoryText = (text) => {
    const normalized = String(text || '')
        .replace(/\r/g, '')
        .trim();
    if (!normalized) return '';
    if (normalized.length <= MONITOR_HISTORY_ITEM_MAX_CHARS) return normalized;
    return `${normalized.slice(0, MONITOR_HISTORY_ITEM_MAX_CHARS)}...`;
};

const addHistoryMessage = (userId, role, content) => {
    const normalized = normalizeHistoryText(content);
    if (!normalized) return;
    insertHistoryStmt.run(userId, role, normalized);
};

const trimHistory = (userId) => {
    trimHistoryStmt.run(userId, userId, MONITOR_HISTORY_LIMIT);
};

const clearHistory = (userId) => {
    clearHistoryStmt.run(userId);
};

const getRecentHistory = (userId) => {
    const rows = getRecentHistoryStmt.all(userId, MONITOR_HISTORY_LIMIT);
    return rows.reverse().map((row) => ({ role: row.role, content: row.content }));
};

const saveConversationTurn = (userId, userText, assistantText) => {
    addHistoryMessage(userId, 'user', userText);
    addHistoryMessage(userId, 'assistant', assistantText);
    trimHistory(userId);
};
const getSettingValue = (key, fallback = '') => {
    const row = getSettingStmt.get(key);
    const value = typeof row?.value === 'string' ? row.value.trim() : '';
    return value || fallback;
};
const setSettingValue = (key, value) => {
    upsertSettingStmt.run(key, value);
};
const isLogInterpreterEnabled = () => getSettingValue(LOG_INTERPRETER_SETTING_KEY, 'off').toLowerCase() === 'on';
const setLogInterpreterEnabled = (enabled) => {
    setSettingValue(LOG_INTERPRETER_SETTING_KEY, enabled ? 'on' : 'off');
};

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const validateTarget = (target, options = { require: false, enforceWhitelist: false }) => {
    const safeTarget = (target || '').trim();
    if (options.require && !safeTarget) {
        return { ok: false, reason: 'Нужно указать имя процесса.' };
    }
    if (!safeTarget) return { ok: true, reason: '' };
    if (!PM2_TARGET_RE.test(safeTarget)) {
        return { ok: false, reason: 'Недопустимое имя процесса.' };
    }
    if (options.enforceWhitelist && PM2_ALLOWED_TARGETS.length && !PM2_ALLOWED_TARGETS.includes(safeTarget)) {
        return { ok: false, reason: `Процесс "${safeTarget}" не входит в белый список.` };
    }
    return { ok: true, reason: '' };
};

const runCommand = (command, args, timeoutMs = MONITOR_PM2_TIMEOUT_MS) => new Promise((resolve) => {
    const child = spawn(command, args, {
        shell: false,
        windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(result);
    };

    const timeoutId = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 1500);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
    });
    child.on('error', (error) => {
        finish({ stdout, stderr, code: null, signal: null, error });
    });
    child.on('close', (code, signal) => {
        finish({ stdout, stderr, code, signal, error: null });
    });
});

const runPm2 = (action, target = '') => {
    const args = [action];
    if (action === 'flush') {
        if (target && target.toLowerCase() !== 'all') {
            args.push(target);
        }
        return runCommand('pm2', args);
    }

    if (target) args.push(target);
    if (action === 'logs') {
        args.push('--lines', String(MONITOR_PM2_LOG_LINES), '--nostream');
    }
    return runCommand('pm2', args);
};

const getCommandOutput = (result) => {
    if (result.error) return `Ошибка запуска pm2: ${result.error.message}`;
    const output = (result.stdout || result.stderr || '').trim();
    return output || 'Команда выполнена без вывода.';
};

const summarizeCommandOutput = (text, maxLines = 8) => {
    const lines = stripAnsi(text)
        .replace(/\r/g, '')
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0);
    if (!lines.length) return 'Без дополнительного вывода.';
    return lines.slice(-maxLines).join('\n');
};

const getPm2Snapshot = async () => {
    const result = await runCommand('pm2', ['jlist']);
    if (result.error) {
        return { ok: false, reason: `Не удалось получить список процессов: ${result.error.message}`, processes: [] };
    }

    const raw = (result.stdout || result.stderr || '').trim();
    if (!raw) {
        return { ok: false, reason: 'PM2 не вернул данные о процессах.', processes: [] };
    }

    try {
        const parsed = JSON.parse(raw);
        const processes = Array.isArray(parsed) ? parsed : [];
        return { ok: true, reason: '', processes };
    } catch {
        return {
            ok: false,
            reason: `Не удалось прочитать JSON от pm2 jlist:\n${clipText(stripAnsi(raw), 500)}`,
            processes: []
        };
    }
};

const matchesTarget = (processInfo, target) => {
    const probe = String(target || '').trim().toLowerCase();
    if (!probe) return true;
    const byName = String(processInfo?.name || '').trim().toLowerCase();
    const byId = String(processInfo?.pm_id ?? '').trim().toLowerCase();
    return byName === probe || byId === probe;
};

const formatBytes = (bytes) => {
    const safe = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
    const mb = safe / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
};

const formatUptime = (pmUptime) => {
    if (!Number.isFinite(pmUptime) || pmUptime <= 0) return '-';
    const diffMs = Math.max(0, Date.now() - pmUptime);
    const totalSeconds = Math.floor(diffMs / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const chunks = [];
    if (days) chunks.push(`${days}d`);
    if (hours) chunks.push(`${hours}h`);
    if (minutes) chunks.push(`${minutes}m`);
    if (!chunks.length) chunks.push(`${seconds}s`);
    return chunks.join(' ');
};

const formatProcessBlock = (processInfo) => {
    const name = processInfo?.name || 'unknown';
    const id = Number.isFinite(processInfo?.pm_id) ? processInfo.pm_id : '?';
    const status = processInfo?.pm2_env?.status || 'unknown';
    const cpu = Number.isFinite(processInfo?.monit?.cpu) ? `${Math.round(processInfo.monit.cpu)}%` : '-';
    const memory = formatBytes(processInfo?.monit?.memory);
    const restarts = Number.isFinite(processInfo?.pm2_env?.restart_time) ? processInfo.pm2_env.restart_time : 0;
    const uptime = formatUptime(processInfo?.pm2_env?.pm_uptime);

    return `- Процесс: ${name} (#${id})
Статус: ${status}
CPU: ${cpu}
RAM: ${memory}
Рестарты: ${restarts}
Uptime: ${uptime}`;
};

const formatProcessList = (title, processes) => {
    if (!processes.length) return `${title}\n\nПроцессы не найдены.`;
    const body = processes.map((proc) => formatProcessBlock(proc)).join('\n\n');
    return clipText(`${title}\n\n${body}`);
};

const formatLogsOutput = (rawText, target) => {
    const cleanedLines = stripAnsi(rawText || '')
        .replace(/\r/g, '')
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0)
        .filter((line) => !line.startsWith('[TAILING]'));

    if (!cleanedLines.length) return 'Логи пустые.';

    let selected = cleanedLines;
    if (target) {
        const targetRx = new RegExp(`\\|\\s*${escapeRegExp(target)}\\s*\\|`, 'i');
        const directTargetLines = cleanedLines.filter((line) => targetRx.test(line));
        if (directTargetLines.length) selected = directTargetLines;
    }

    const tail = selected.slice(-MONITOR_PM2_LOG_LINES);
    if (!tail.length) return 'Логи пустые.';
    return clipText(tail.join('\n'), 3500);
};

const extractToolCall = (message) => {
    const toolCall = message?.tool_calls?.find(
        (item) => item.type === 'function' && item.function?.name === 'pm2_command'
    );
    if (toolCall) return { arguments: toolCall.function.arguments || '{}' };
    if (message?.function_call?.name === 'pm2_command') {
        return { arguments: message.function_call.arguments || '{}' };
    }
    return null;
};
const buildSettingsKeyboard = (enabled) => Markup.inlineKeyboard([
    [Markup.button.callback(`Интерпретатор логов: ${enabled ? 'ON' : 'OFF'}`, 'settings:log_interpreter:toggle')],
    [Markup.button.callback('Обновить', 'settings:refresh')]
]);
const renderSettingsPanelText = () => {
    const enabled = isLogInterpreterEnabled();
    return `⚙️ Настройки Watchdog

Интерпретатор логов: ${enabled ? 'ON' : 'OFF'}
Когда ON: после сырых логов бот присылает AI-разбор.
Когда OFF: только сырые логи.`;
};
const sendSettingsPanel = async (ctx, mode = 'reply') => {
    const text = renderSettingsPanelText();
    const keyboard = buildSettingsKeyboard(isLogInterpreterEnabled());
    if (mode === 'edit') return ctx.editMessageText(text, keyboard);
    return ctx.reply(text, keyboard);
};
const interpretLogsWithAi = async (target, logsText) => {
    const clean = String(logsText || '').trim();
    if (!clean || clean === 'Логи пустые.') {
        return 'Интерпретация: логи пустые.';
    }

    const sample = clean.length > 5000 ? `${clean.slice(-5000)}` : clean;
    try {
        const completion = await openai.chat.completions.create({
            model: AI_MODEL,
            temperature: 0.1,
            messages: [
                { role: 'system', content: LOG_INTERPRETER_PROMPT },
                {
                    role: 'user',
                    content: `Процесс: ${target || 'unknown'}\n\nЛоги:\n${sample}`
                }
            ]
        });
        const text = String(completion.choices?.[0]?.message?.content || '').trim();
        return text || 'Интерпретация: модель не вернула текст.';
    } catch (error) {
        return `Интерпретация недоступна: ${error instanceof Error ? error.message : String(error)}`;
    }
};
const normalizeAllTarget = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return '';
    if (ALL_TARGET_ALIASES.has(normalized)) return 'all';
    return value;
};

bot.telegram.setMyCommands([
    { command: 'clear', description: 'Очистить контекст watchdog' },
    { command: 'settings', description: 'Настройки watchdog' },
    { command: 'flush', description: 'Очистить логи: /flush <process|all>' }
]).catch(() => undefined);

bot.use((ctx, next) => {
    if (ctx.from?.id !== ADMIN_ID) return ctx.reply('Доступ запрещен.');
    return next();
});

bot.command('clear', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    clearHistory(userId);
    await ctx.reply('История watchdog очищена.');
});
bot.command('settings', async (ctx) => {
    await sendSettingsPanel(ctx, 'reply');
});
bot.command('flush', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const parts = String(ctx.message?.text || '').split(/\s+/).filter(Boolean);
    const target = (parts[1] || '').trim();
    if (!target) {
        const errText = 'Использование: /flush <process|all>';
        await ctx.reply(errText);
        saveConversationTurn(userId, '/flush', errText);
        return;
    }

    const isAll = target.toLowerCase() === 'all';
    if (!isAll) {
        const targetCheck = validateTarget(target, { require: true, enforceWhitelist: true });
        if (!targetCheck.ok) {
            const errText = `❌ ${targetCheck.reason}`;
            await ctx.reply(errText);
            saveConversationTurn(userId, `/flush ${target}`, errText);
            return;
        }
    }

    const cmdText = isAll ? 'pm2 flush' : `pm2 flush ${target}`;
    await ctx.reply(`⚙️ Выполняю: ${cmdText}...`);
    const runResult = await runPm2('flush', target);
    const outputSummary = summarizeCommandOutput(getCommandOutput(runResult));
    const responseText = `Логи очищены: ${isAll ? 'все процессы' : target}\n\nВывод PM2:\n${outputSummary}`;
    await ctx.reply(clipText(responseText));
    saveConversationTurn(userId, `/flush ${target}`, responseText);
});
bot.action('settings:refresh', async (ctx) => {
    await ctx.answerCbQuery();
    await sendSettingsPanel(ctx, 'edit');
});
bot.action('settings:log_interpreter:toggle', async (ctx) => {
    const next = !isLogInterpreterEnabled();
    setLogInterpreterEnabled(next);
    await ctx.answerCbQuery(`Интерпретатор: ${next ? 'ON' : 'OFF'}`);
    await sendSettingsPanel(ctx, 'edit');
});

bot.on('text', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const userText = (ctx.message?.text || '').trim();
    if (!userText) return;
    if (
        userText === '/clear' || userText.startsWith('/clear ')
        || userText === '/settings' || userText.startsWith('/settings ')
        || userText === '/flush' || userText.startsWith('/flush ')
    ) return;

    try {
        const history = getRecentHistory(userId);
        const completion = await openai.chat.completions.create({
            model: AI_MODEL,
            temperature: 0,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                ...history,
                { role: 'user', content: userText }
            ],
            tools: [
                {
                    type: 'function',
                    function: {
                        name: 'pm2_command',
                        parameters: {
                            type: 'object',
                            properties: {
                                action: { type: 'string', enum: ['list', 'status', 'restart', 'stop', 'logs', 'flush'] },
                                target: { type: 'string', description: 'Имя или id PM2 процесса' }
                            },
                            required: ['action']
                        }
                    }
                }
            ],
            tool_choice: 'auto'
        });

        const message = completion.choices?.[0]?.message;
        const call = extractToolCall(message);

        if (!call) {
            const fallbackText = String(message?.content || '').trim() || 'Не понял запрос.';
            await ctx.reply(clipText(fallbackText));
            saveConversationTurn(userId, userText, fallbackText);
            return;
        }

        let parsed = {};
        try {
            parsed = JSON.parse(call.arguments || '{}');
        } catch {
            const errText = '❌ Не удалось разобрать аргументы команды.';
            await ctx.reply(errText);
            saveConversationTurn(userId, userText, errText);
            return;
        }

        const action = String(parsed.action || '').trim().toLowerCase();
        const rawTarget = typeof parsed.target === 'string' ? parsed.target.trim() : '';
        let target = normalizeAllTarget(rawTarget);
        if (action === 'flush' && !target) {
            const loweredUserText = userText.toLowerCase();
            if (
                /\b(все|всё|all)\b/.test(loweredUserText)
                || /почисти\s+логи/.test(loweredUserText)
                || /очисти\s+логи/.test(loweredUserText)
                || /flush\s+logs/.test(loweredUserText)
            ) {
                target = 'all';
            }
        }

        if (!ALLOWED_ACTIONS.has(action)) {
            const errText = '❌ Недопустимое действие. Разрешено: list, status, restart, stop, logs, flush.';
            await ctx.reply(errText);
            saveConversationTurn(userId, userText, errText);
            return;
        }

        const mustHaveTarget = action === 'restart' || action === 'stop' || action === 'logs';
        if (mustHaveTarget) {
            const targetCheck = validateTarget(target, { require: true, enforceWhitelist: true });
            if (!targetCheck.ok) {
                const errText = `❌ ${targetCheck.reason}`;
                await ctx.reply(errText);
                saveConversationTurn(userId, userText, errText);
                return;
            }
        } else if (target) {
            const targetCheck = action === 'flush' && target.toLowerCase() === 'all'
                ? { ok: true, reason: '' }
                : validateTarget(target, { require: true, enforceWhitelist: false });
            if (!targetCheck.ok) {
                const errText = `❌ ${targetCheck.reason}`;
                await ctx.reply(errText);
                saveConversationTurn(userId, userText, errText);
                return;
            }
        }

        const cmdText = target ? `${action} ${target}` : action;
        await ctx.reply(`⚙️ Выполняю: pm2 ${cmdText}...`);

        if (action === 'list' || action === 'status') {
            const snapshot = await getPm2Snapshot();
            if (!snapshot.ok) {
                const errText = `❌ ${snapshot.reason}`;
                await ctx.reply(errText);
                saveConversationTurn(userId, userText, errText);
                return;
            }

            const filtered = target
                ? snapshot.processes.filter((proc) => matchesTarget(proc, target))
                : snapshot.processes;

            if (target && !filtered.length) {
                const notFoundText = `Процесс "${target}" не найден.`;
                await ctx.reply(notFoundText);
                saveConversationTurn(userId, userText, notFoundText);
                return;
            }

            const title = target ? `Статус процесса "${target}"` : 'Статус процессов PM2';
            const responseText = formatProcessList(title, filtered);
            await ctx.reply(responseText);
            saveConversationTurn(userId, userText, responseText);
            return;
        }

        if (action === 'logs') {
            const runResult = await runPm2(action, target);
            const output = getCommandOutput(runResult);
            const prettyLogs = formatLogsOutput(output, target);
            const header = `Логи процесса "${target}" (последние ${MONITOR_PM2_LOG_LINES} строк):`;
            await ctx.reply(`${header}\n<pre>${escapeHtml(prettyLogs)}</pre>`, { parse_mode: 'HTML' });

            let assistantText = `${header}\n${prettyLogs}`;
            if (isLogInterpreterEnabled()) {
                await ctx.reply('🧠 Интерпретирую логи...');
                const interpretation = clipText(await interpretLogsWithAi(target, prettyLogs), 3900);
                await ctx.reply(`Интерпретация:\n${interpretation}`);
                assistantText = `${assistantText}\n\nИнтерпретация:\n${interpretation}`;
            }

            saveConversationTurn(userId, userText, assistantText);
            return;
        }

        if (action === 'flush') {
            const effectiveTarget = target || 'all';
            const isAll = effectiveTarget.toLowerCase() === 'all';
            const runResult = await runPm2(action, target);
            const outputSummary = summarizeCommandOutput(getCommandOutput(runResult));
            const responseText = clipText(
                `Логи очищены: ${isAll ? 'все процессы' : target}

Вывод PM2:
${outputSummary}`
            );
            await ctx.reply(responseText);
            saveConversationTurn(userId, userText, responseText);
            return;
        }

        if (action === 'restart' || action === 'stop') {
            const runResult = await runPm2(action, target);
            const rawOutput = getCommandOutput(runResult);
            const outputSummary = summarizeCommandOutput(rawOutput);

            const snapshot = await getPm2Snapshot();
            let stateText = 'Статус после команды не удалось получить.';
            if (snapshot.ok) {
                const filtered = snapshot.processes.filter((proc) => matchesTarget(proc, target));
                if (filtered.length) {
                    stateText = formatProcessList('Текущее состояние:', filtered);
                } else {
                    stateText = `Процесс "${target}" не найден в текущем списке PM2.`;
                }
            }

            const responseText = clipText(
                `Команда выполнена: pm2 ${action} ${target}

Вывод PM2:
${outputSummary}

${stateText}`
            );

            await ctx.reply(responseText);
            saveConversationTurn(userId, userText, responseText);
        }
    } catch (error) {
        const errText = `❌ Ошибка: ${error instanceof Error ? error.message : String(error)}`;
        await ctx.reply(errText);
        saveConversationTurn(userId, userText, errText);
    }
});

bot.launch();
console.log('Watchdog запущен...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
