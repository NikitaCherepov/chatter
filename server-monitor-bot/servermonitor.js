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
const MONITOR_REPO_TIMEOUT_MS = Math.max(
    10000,
    Math.min(30 * 60 * 1000, Number.parseInt(process.env.MONITOR_REPO_TIMEOUT_MS || '600000', 10) || 600000)
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

CREATE TABLE IF NOT EXISTS process_registry (
    process_name TEXT PRIMARY KEY,
    display_name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    abs_path TEXT NOT NULL DEFAULT '',
    aliases TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
`);

const ensureProcessRegistryColumns = () => {
    const columns = db.prepare('PRAGMA table_info(process_registry)').all();
    const hasAbsPath = columns.some((col) => col.name === 'abs_path');
    if (!hasAbsPath) {
        db.exec(`ALTER TABLE process_registry ADD COLUMN abs_path TEXT NOT NULL DEFAULT ''`);
    }
};
ensureProcessRegistryColumns();

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
const getAllProcessRegistryStmt = db.prepare(`
    SELECT process_name, display_name, description, abs_path, aliases, created_at, updated_at
    FROM process_registry
    ORDER BY process_name ASC
`);
const getProcessByNameStmt = db.prepare(`
    SELECT process_name, display_name, description, abs_path, aliases, created_at, updated_at
    FROM process_registry
    WHERE process_name = ?
    LIMIT 1
`);
const upsertProcessRegistryStmt = db.prepare(`
    INSERT INTO process_registry (process_name, display_name, description, abs_path, aliases, updated_at)
    VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'))
    ON CONFLICT(process_name) DO UPDATE SET
        display_name = excluded.display_name,
        description = excluded.description,
        abs_path = excluded.abs_path,
        aliases = excluded.aliases,
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

Разрешённые PM2 инструменты: list, status, restart, stop, logs, flush.
Разрешённые репо-инструменты: git_pull, npm_i, npm_build.
Репо-команды выполняй только по сохранённым абсолютным путям из реестра процессов.
Также у тебя есть реестр процессов: добавляй/обновляй процессы через специальный инструмент, когда пользователь просит.
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
const resolveHomeDir = () => process.env.HOME || process.env.USERPROFILE || '';
const expandHomePath = (input) => {
    const raw = String(input || '').trim();
    if (!raw) return '';
    if (raw.startsWith('~/') || raw === '~') {
        const home = resolveHomeDir();
        if (!home) return raw;
        return path.join(home, raw.slice(2));
    }
    return raw;
};
const normalizeAbsolutePath = (input) => {
    const expanded = expandHomePath(input);
    if (!expanded) return '';
    return path.resolve(expanded);
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
const normalizeRegistryToken = (value) => String(value || '').trim().toLowerCase();
const parseAliases = (value) => {
    const raw = Array.isArray(value) ? value.join(',') : String(value || '');
    const parts = raw.split(/[,\n;|]+/).map((x) => normalizeRegistryToken(x)).filter(Boolean);
    return [...new Set(parts)];
};
const toAliasesString = (aliases) => parseAliases(aliases).join(', ');
const mergeAliases = (a, b) => [...new Set([...parseAliases(a), ...parseAliases(b)])];
const upsertProcessRegistry = (processName, payload = {}) => {
    const normalizedName = String(processName || '').trim();
    if (!normalizedName) return { ok: false, reason: 'Пустое имя процесса.' };
    const existing = getProcessByNameStmt.get(normalizedName);
    const displayName = (payload.display_name ?? existing?.display_name ?? normalizedName).trim();
    const description = (payload.description ?? existing?.description ?? '').trim();
    const absPath = normalizeAbsolutePath(payload.abs_path ?? existing?.abs_path ?? '');
    const aliasesMerged = mergeAliases(existing?.aliases || '', payload.aliases || '');
    const aliases = aliasesMerged.join(', ');
    upsertProcessRegistryStmt.run(normalizedName, displayName, description, absPath, aliases);
    return { ok: true, reason: '' };
};
const getProcessRegistryRows = () => getAllProcessRegistryStmt.all();
const buildRegistryTokenMap = () => {
    const map = new Map();
    for (const row of getProcessRegistryRows()) {
        map.set(normalizeRegistryToken(row.process_name), row.process_name);
        const display = normalizeRegistryToken(row.display_name);
        if (display) map.set(display, row.process_name);
        for (const alias of parseAliases(row.aliases || '')) {
            map.set(alias, row.process_name);
        }
    }
    return map;
};
const resolveTargetFromRegistry = (target) => {
    const normalized = normalizeRegistryToken(target);
    if (!normalized) return '';
    if (ALL_TARGET_ALIASES.has(normalized)) return 'all';
    const tokenMap = buildRegistryTokenMap();
    return tokenMap.get(normalized) || target;
};
const formatRegistryList = () => {
    const rows = getProcessRegistryRows();
    if (!rows.length) return 'Реестр процессов пуст.';
    return clipText(`Реестр процессов:\n\n${rows.map((row) => {
        const aliases = parseAliases(row.aliases || '');
        const aliasesText = aliases.length ? aliases.join(', ') : '-';
        const desc = row.description?.trim() || '-';
        const p = row.abs_path?.trim() || '-';
        return `- ${row.process_name}\n  Имя: ${row.display_name || row.process_name}\n  Путь: ${p}\n  Описание: ${desc}\n  Алиасы: ${aliasesText}`;
    }).join('\n\n')}`);
};
const syncRegistryFromPm2Processes = (processes) => {
    const known = new Set(getProcessRegistryRows().map((row) => row.process_name));
    const newNames = [];
    for (const proc of processes || []) {
        const name = String(proc?.name || '').trim();
        if (!name) continue;
        if (!known.has(name)) {
            upsertProcessRegistry(name, { display_name: name, description: '', aliases: '' });
            known.add(name);
            newNames.push(name);
        }
    }
    return newNames;
};
const buildRegistryContextMessage = () => {
    const rows = getProcessRegistryRows();
    if (!rows.length) return 'Реестр процессов пока пуст.';
    const text = rows.slice(0, 50).map((row) => {
        const aliases = parseAliases(row.aliases || '');
        return `- ${row.process_name} | путь: ${row.abs_path || '-'} | имя: ${row.display_name || row.process_name} | алиасы: ${aliases.join(', ') || '-'} | описание: ${row.description || '-'}`;
    }).join('\n');
    return `Текущий реестр процессов:\n${text}`;
};
const resolveRegisteredProcessPath = (processNameOrAlias) => {
    const resolvedName = resolveTargetFromRegistry(processNameOrAlias);
    const row = getProcessByNameStmt.get(String(resolvedName || '').trim());
    if (!row) return { ok: false, process_name: '', abs_path: '', reason: `Процесс "${processNameOrAlias}" не найден в реестре.` };
    const absPath = normalizeAbsolutePath(row.abs_path || '');
    if (!absPath || !path.isAbsolute(absPath)) {
        return { ok: false, process_name: row.process_name, abs_path: '', reason: `У процесса "${row.process_name}" не задан абсолютный путь.` };
    }
    return { ok: true, process_name: row.process_name, abs_path: absPath, reason: '' };
};
const runRepoAction = async (action, processNameOrAlias) => {
    const resolved = resolveRegisteredProcessPath(processNameOrAlias);
    if (!resolved.ok) return { ok: false, text: `❌ ${resolved.reason}` };

    let command = 'npm';
    let args = ['run', 'build'];
    if (action === 'git_pull') {
        command = 'git';
        args = ['pull', '--ff-only'];
    } else if (action === 'npm_i') {
        command = 'npm';
        args = ['i'];
    } else if (action === 'npm_build') {
        command = 'npm';
        args = ['run', 'build'];
    } else {
        return { ok: false, text: `❌ Неизвестное действие репо: ${action}` };
    }

    const result = await runCommand(command, args, MONITOR_REPO_TIMEOUT_MS, resolved.abs_path);
    const output = summarizeCommandOutput(getCommandOutput(result), 20);
    return {
        ok: true,
        text: clipText(
            `Выполнено для ${resolved.process_name}\nПуть: ${resolved.abs_path}\nКоманда: ${command} ${args.join(' ')}\n\nВывод:\n${output}`
        )
    };
};
const seedDefaultProcessPaths = () => {
    const home = resolveHomeDir();
    if (!home) return;
    const chatterPath = normalizeAbsolutePath(process.env.MONITOR_CHATTER_PATH || '~/chatter');
    const notesPath = normalizeAbsolutePath(process.env.MONITOR_WEBAPP_NOTES_PATH || '~/chatter/webapp-notes');
    const watchdogPath = normalizeAbsolutePath(process.env.MONITOR_WATCHDOG_PATH || process.cwd());
    upsertProcessRegistry('chatter', {
        display_name: 'chatter',
        description: 'Основной бот',
        abs_path: chatterPath,
        aliases: 'чаттер,main-bot'
    });
    upsertProcessRegistry('webapp-notes', {
        display_name: 'webapp-notes',
        description: 'Мини-сайт заметок',
        abs_path: notesPath,
        aliases: 'заметки,notes'
    });
    upsertProcessRegistry('watchdog', {
        display_name: 'watchdog',
        description: 'Монитор-бот',
        abs_path: watchdogPath,
        aliases: 'админ,монитор'
    });
};
seedDefaultProcessPaths();
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

const runCommand = (command, args, timeoutMs = MONITOR_PM2_TIMEOUT_MS, cwd = undefined) => new Promise((resolve) => {
    const child = spawn(command, args, {
        shell: false,
        windowsHide: true,
        cwd
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
    const toolCall = message?.tool_calls?.find((item) =>
        item.type === 'function'
        && (
            item.function?.name === 'pm2_command'
            || item.function?.name === 'process_registry_command'
            || item.function?.name === 'repo_command'
        )
    );
    if (toolCall) return { name: toolCall.function.name, arguments: toolCall.function.arguments || '{}' };
    if (
        message?.function_call?.name === 'pm2_command'
        || message?.function_call?.name === 'process_registry_command'
        || message?.function_call?.name === 'repo_command'
    ) {
        return { name: message.function_call.name, arguments: message.function_call.arguments || '{}' };
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
    { command: 'flush', description: 'Очистить логи: /flush <process|all>' },
    { command: 'proc_list', description: 'Список процессов из реестра' },
    { command: 'proc_add', description: 'Добавить/обновить: /proc_add name | desc | aliases | abs_path' },
    { command: 'git_pull', description: 'Git pull: /git_pull <process>' },
    { command: 'npm_i', description: 'npm i: /npm_i <process>' },
    { command: 'npm_build', description: 'npm run build: /npm_build <process>' }
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
bot.command('proc_list', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const text = formatRegistryList();
    await ctx.reply(text);
    saveConversationTurn(userId, '/proc_list', text);
});
bot.command('proc_add', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const payload = String(ctx.message?.text || '').replace(/^\/proc_add\s*/i, '').trim();
    if (!payload) {
        const text = 'Использование: /proc_add <process_name> | <описание> | <алиасы через запятую> | <абсолютный_путь>';
        await ctx.reply(text);
        saveConversationTurn(userId, '/proc_add', text);
        return;
    }
    const parts = payload.split('|').map((x) => x.trim());
    const processName = parts[0] || '';
    const description = parts[1] || '';
    const aliases = parts[2] || '';
    const absPath = parts[3] || '';
    const result = upsertProcessRegistry(processName, {
        display_name: processName,
        description,
        aliases,
        abs_path: absPath
    });
    const text = result.ok
        ? `Процесс сохранён: ${processName}`
        : `❌ ${result.reason}`;
    await ctx.reply(text);
    saveConversationTurn(userId, `/proc_add ${payload}`, text);
});
bot.command('git_pull', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const target = String(ctx.message?.text || '').replace(/^\/git_pull\s*/i, '').trim();
    if (!target) {
        const text = 'Использование: /git_pull <process>';
        await ctx.reply(text);
        saveConversationTurn(userId, '/git_pull', text);
        return;
    }
    await ctx.reply(`⚙️ Выполняю git pull для ${target}...`);
    const result = await runRepoAction('git_pull', target);
    await ctx.reply(result.text);
    saveConversationTurn(userId, `/git_pull ${target}`, result.text);
});
bot.command('npm_i', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const target = String(ctx.message?.text || '').replace(/^\/npm_i\s*/i, '').trim();
    if (!target) {
        const text = 'Использование: /npm_i <process>';
        await ctx.reply(text);
        saveConversationTurn(userId, '/npm_i', text);
        return;
    }
    await ctx.reply(`⚙️ Выполняю npm i для ${target}...`);
    const result = await runRepoAction('npm_i', target);
    await ctx.reply(result.text);
    saveConversationTurn(userId, `/npm_i ${target}`, result.text);
});
bot.command('npm_build', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const target = String(ctx.message?.text || '').replace(/^\/npm_build\s*/i, '').trim();
    if (!target) {
        const text = 'Использование: /npm_build <process>';
        await ctx.reply(text);
        saveConversationTurn(userId, '/npm_build', text);
        return;
    }
    await ctx.reply(`⚙️ Выполняю npm run build для ${target}...`);
    const result = await runRepoAction('npm_build', target);
    await ctx.reply(result.text);
    saveConversationTurn(userId, `/npm_build ${target}`, result.text);
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
        || userText === '/proc_list' || userText.startsWith('/proc_list ')
        || userText === '/proc_add' || userText.startsWith('/proc_add ')
        || userText === '/git_pull' || userText.startsWith('/git_pull ')
        || userText === '/npm_i' || userText.startsWith('/npm_i ')
        || userText === '/npm_build' || userText.startsWith('/npm_build ')
    ) return;

    try {
        const history = getRecentHistory(userId);
        const completion = await openai.chat.completions.create({
            model: AI_MODEL,
            temperature: 0,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'system', content: buildRegistryContextMessage() },
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
                },
                {
                    type: 'function',
                    function: {
                        name: 'process_registry_command',
                        parameters: {
                            type: 'object',
                            properties: {
                                action: { type: 'string', enum: ['list', 'add', 'update', 'sync_from_pm2'] },
                                process_name: { type: 'string' },
                                display_name: { type: 'string' },
                                description: { type: 'string' },
                                aliases: { type: 'string' },
                                abs_path: { type: 'string' }
                            },
                            required: ['action']
                        }
                    }
                },
                {
                    type: 'function',
                    function: {
                        name: 'repo_command',
                        parameters: {
                            type: 'object',
                            properties: {
                                action: { type: 'string', enum: ['git_pull', 'npm_i', 'npm_build'] },
                                process_name: { type: 'string' }
                            },
                            required: ['action', 'process_name']
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

        const toolName = call.name || message?.tool_calls?.[0]?.function?.name || 'pm2_command';
        if (toolName === 'repo_command') {
            const repoAction = String(parsed.action || '').trim().toLowerCase();
            const processName = String(parsed.process_name || '').trim();
            const result = await runRepoAction(repoAction, processName);
            await ctx.reply(result.text);
            saveConversationTurn(userId, userText, result.text);
            return;
        }
        if (toolName === 'process_registry_command') {
            const regAction = String(parsed.action || '').trim().toLowerCase();
            if (regAction === 'list') {
                const text = formatRegistryList();
                await ctx.reply(text);
                saveConversationTurn(userId, userText, text);
                return;
            }
            if (regAction === 'sync_from_pm2') {
                const snapshot = await getPm2Snapshot();
                if (!snapshot.ok) {
                    const errText = `❌ ${snapshot.reason}`;
                    await ctx.reply(errText);
                    saveConversationTurn(userId, userText, errText);
                    return;
                }
                const added = syncRegistryFromPm2Processes(snapshot.processes);
                const text = added.length
                    ? `Синхронизация завершена. Добавлены процессы: ${added.join(', ')}`
                    : 'Синхронизация завершена. Новых процессов нет.';
                await ctx.reply(text);
                saveConversationTurn(userId, userText, text);
                return;
            }
            if (regAction === 'add' || regAction === 'update') {
                const processName = String(parsed.process_name || '').trim();
                const displayName = String(parsed.display_name || processName).trim();
                const description = String(parsed.description || '').trim();
                const aliases = String(parsed.aliases || '').trim();
                const absPath = String(parsed.abs_path || '').trim();
                const result = upsertProcessRegistry(processName, {
                    display_name: displayName,
                    description,
                    aliases,
                    abs_path: absPath
                });
                const text = result.ok
                    ? `Процесс сохранён: ${processName}`
                    : `❌ ${result.reason}`;
                await ctx.reply(text);
                saveConversationTurn(userId, userText, text);
                return;
            }
            const errText = '❌ Неизвестное действие реестра.';
            await ctx.reply(errText);
            saveConversationTurn(userId, userText, errText);
            return;
        }

        const action = String(parsed.action || '').trim().toLowerCase();
        const rawTarget = typeof parsed.target === 'string' ? parsed.target.trim() : '';
        let target = resolveTargetFromRegistry(normalizeAllTarget(rawTarget));
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
            let finalText = responseText;
            if (!target) {
                const added = syncRegistryFromPm2Processes(snapshot.processes);
                if (added.length) {
                    const hint = `Вижу новые процессы: ${added.join(', ')}.\nДобавить описание? Напиши: "Добавь процесс <имя> | <описание> | <алиасы>"`;
                    await ctx.reply(hint);
                    finalText = `${finalText}\n\n${hint}`;
                }
            }
            if (isLogInterpreterEnabled()) {
                const compact = filtered.map((proc) => `#${proc.pm_id} ${proc.name} ${proc.pm2_env?.status || 'unknown'} cpu:${proc.monit?.cpu ?? '-'} mem:${proc.monit?.memory ?? '-'}`).join('\n');
                const interpretation = clipText(await interpretLogsWithAi(target || 'pm2-status', compact), 3900);
                await ctx.reply(`Интерпретация:\n${interpretation}`);
                finalText = `${finalText}\n\nИнтерпретация:\n${interpretation}`;
            }
            saveConversationTurn(userId, userText, finalText);
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
