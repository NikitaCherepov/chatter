import { Markup, Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import * as dotenv from 'dotenv';
import crypto from 'crypto';
import axios from 'axios';
import { marked, Renderer } from 'marked';
import {
    createBotTranslator,
    DEFAULT_LANGUAGE,
    ensureBotI18nReady,
    normalizeSupportedLanguage,
    SUPPORTED_LANGUAGES,
    translateBot,
    type BotTranslate,
    type SupportedLanguage
} from './i18n/index.js';

dotenv.config();

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
const DEFAULT_USER_PLAN: UserPlan = 'free';

type BotContext = Context & {
    state: Context['state'] & {
        language: SupportedLanguage;
        accountId: number;
        telegramId: number;
        role?: 'admin' | 'user';
        userName?: string;
    };
    t: BotTranslate;
};

const formatSafeError = (error: unknown) => {
    if (axios.isAxiosError(error)) {
        const backendError = typeof error.response?.data?.error === 'string'
            ? `backend=${error.response.data.error}`
            : '';
        const details = [
            error.message,
            error.code ? `code=${error.code}` : '',
            error.response?.status ? `status=${error.response.status}` : '',
            backendError
        ].filter(Boolean);
        return details.join(' ');
    }
    if (error instanceof Error) return error.message;
    return String(error);
};

const TELEGRAM_TOKEN = `${process.env.TELEGRAM_TOKEN || ''}`.trim();
if (!TELEGRAM_TOKEN) throw new Error('telegram_token_not_configured');

const bot = new Telegraf<BotContext>(TELEGRAM_TOKEN);
bot.catch(async (err, ctx) => {
    console.error('Telegraf update error:', formatSafeError(err));
    try {
        await ctx.reply(ctx.t('common.serviceUnavailable'));
    } catch {
        // ignore reply failures inside error handler
    }
});

const AUTO_SYNC_PLAN_LIMITS_ON_BOOT = process.env.AUTO_SYNC_PLAN_LIMITS_ON_BOOT === '1';
const MAX_PENDING_TASKS_PER_USER = 10;
const PAGE_SIZE = 10;
const CUSTOM_PROMPT_ID = -1;
const MAX_CUSTOM_PROMPT_LENGTH = 800;
const NOTES_WEBAPP_URL = (process.env.NOTES_WEBAPP_URL || '').trim();
const NOTE_QUERY_MAX_LENGTH = 120;
const NOTES_PAGE_SIZE_DEFAULT = 10;
const NOTES_MENU_PAGE_SIZE = 10;
const CHATS_MENU_PAGE_SIZE = 8;
const BACKEND_TIMEOUT_AI_MS = Math.max(10000, Number.parseInt(process.env.BACKEND_TIMEOUT_AI_MS || '120000', 10));
const BACKEND_TIMEOUT_MEDIA_MS = Math.max(10000, Number.parseInt(process.env.BACKEND_TIMEOUT_MEDIA_MS || '180000', 10));
const BACKEND_TIMEOUT_DEFAULT_MS = Math.max(5000, Number.parseInt(process.env.BACKEND_TIMEOUT_DEFAULT_MS || '15000', 10));
const MAX_TELEGRAM_PHOTO_BYTES = 20 * 1024 * 1024;
const MAX_TELEGRAM_VOICE_BYTES = 10 * 1024 * 1024;
const EMAIL_PASSWORD_DELIMITER = '::';
const BACKEND_API_BASE_URL = (process.env.BACKEND_API_BASE_URL || 'http://127.0.0.1:3050').trim().replace(/\/$/, '');
const BACKEND_INTERNAL_TOKEN = (process.env.BACKEND_INTERNAL_TOKEN || '').trim();
const ENCRYPTION_KEY_SOURCE = process.env.ENCRYPTION_KEY || 'dev-default-key-change-in-prod';
// Rich streaming через sendRichMessageDraft (Bot API 10.1+).
// 1 = стриминг с черновиком (RichBlockThinking + RichBlockParagraph), 0 = старый режим "intermediate + done".
const TG_USE_RICH_STREAMING = process.env.TG_USE_RICH_STREAMING === '1';
const ENCRYPTION_KEY = crypto.createHash('sha256').update(ENCRYPTION_KEY_SOURCE).digest();
const ENCRYPTION_IV_LENGTH = 16;
const BASE_COMMANDS = [
    'start', 'menu', 'clear', 'tz', 'tasks', 'task_delete', 'note_add', 'notes',
    'note_find', 'note_delete', 'mail_setup', 'mail_use', 'mail_forget',
    'chats', 'chat_new', 'chat_use', 'link', 'unlink', 'rename', 'prompts', 'prompt_use'
] as const;
const ADMIN_EXTRA_COMMANDS = [
    'add', 'remove', 'users', 'ban', 'unban', 'prompt_add', 'prompt_show',
    'prompt_set', 'prompt_desc', 'prompt_rename', 'prompt_delete', 'prompt_default',
    'history_user', 'history_delete', 'sync_plan_limits'
] as const;
const buildBotCommands = (isAdmin: boolean, t: BotTranslate) => (
    [...BASE_COMMANDS, ...(isAdmin ? ADMIN_EXTRA_COMMANDS : [])].map(command => ({
        command,
        description: t(`commands.${command}`)
    }))
);
const commandScopeCache = new Map<number, string>();
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
    account_id: number;
    telegram_id: number | null;
    telegram_username: string | null;
    name: string | null;
    role: string;
    status: UserStatus;
    plan: UserPlan;
    language?: string | null;
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
    max_context_tokens_limit?: number;
    max_context_tokens?: number;
    preferred_model?: string | null;
    identities?: Array<{ provider: string; provider_subject: string; username: string | null }>;
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
    id: number;
    provider: MailProvider;
    label: string | null;
    email: string;
    is_active: boolean;
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
type MenuActionId = 'clear' | 'users' | 'rename' | 'add' | 'remove' | 'prompts' | 'current_prompt' | 'model' | 'context_size' | 'prompt_admin' | 'pending' | 'banned' | 'mail' | 'notes' | 'chats' | 'language' | 'help' | 'recover_desktop';
type MenuActionButton = {
    id: MenuActionId;
    labelKey: string;
    adminOnly: boolean;
    row: number;
};

const MAIN_MENU_TRIGGER_BUTTONS = [...new Set(
    SUPPORTED_LANGUAGES.map(language => translateBot(language, 'menu.trigger'))
)];
const MAIN_MENU_ACTIONS: MenuActionButton[] = [
    { id: 'clear', labelKey: 'menu.buttons.clear', adminOnly: false, row: 1 },
    { id: 'users', labelKey: 'menu.buttons.users', adminOnly: true, row: 1 },
    { id: 'rename', labelKey: 'menu.buttons.rename', adminOnly: false, row: 2 },
    { id: 'prompts', labelKey: 'menu.buttons.prompts', adminOnly: false, row: 2 },
    { id: 'current_prompt', labelKey: 'menu.buttons.currentPrompt', adminOnly: false, row: 3 },
    { id: 'model', labelKey: 'menu.buttons.model', adminOnly: false, row: 3 },
    { id: 'context_size', labelKey: 'menu.buttons.contextSize', adminOnly: false, row: 3 },
    { id: 'add', labelKey: 'menu.buttons.addUser', adminOnly: true, row: 3 },
    { id: 'remove', labelKey: 'menu.buttons.removeUser', adminOnly: true, row: 4 },
    { id: 'prompt_admin', labelKey: 'menu.buttons.promptAdmin', adminOnly: true, row: 4 },
    { id: 'pending', labelKey: 'menu.buttons.pending', adminOnly: true, row: 5 },
    { id: 'banned', labelKey: 'menu.buttons.banned', adminOnly: true, row: 5 },
    { id: 'mail', labelKey: 'menu.buttons.mail', adminOnly: false, row: 6 },
    { id: 'language', labelKey: 'menu.buttons.language', adminOnly: false, row: 6 },
    { id: 'notes', labelKey: 'menu.buttons.notes', adminOnly: false, row: 7 },
    { id: 'chats', labelKey: 'menu.buttons.chats', adminOnly: false, row: 7 },
    { id: 'help', labelKey: 'menu.buttons.help', adminOnly: false, row: 8 },
    { id: 'recover_desktop', labelKey: 'menu.buttons.recoverDesktop', adminOnly: false, row: 9 }
];

const MENU_ACTION_BY_ID = Object.fromEntries(MAIN_MENU_ACTIONS.map(item => [item.id, item])) as Record<MenuActionId, MenuActionButton>;

const buildMenuTriggerKeyboard = (t: BotTranslate) => Markup.keyboard([[t('menu.trigger')]]).resize().persistent();
const TZ_BUTTON_SET_UTC_VALUES = SUPPORTED_LANGUAGES.map(language =>
    translateBot(language, 'timezone.buttons.setUtc')
);
const buildTimezoneSetupKeyboard = (t: BotTranslate) => Markup.keyboard([
    [t('timezone.buttons.setUtc')],
    [Markup.button.locationRequest(t('timezone.buttons.sendLocation'))]
]).resize().oneTime();

const buildMainMenuInlineKeyboard = (isAdmin: boolean, hasDesktopAccount: boolean, t: BotTranslate) => {
    const visibleItems = MAIN_MENU_ACTIONS.filter(item => {
        if (item.adminOnly && !isAdmin) return false;
        if (item.id === 'recover_desktop' && !hasDesktopAccount) return false;
        return true;
    });
    const rows = [...new Set(visibleItems.map(item => item.row))]
        .sort((a, b) => a - b)
        .map(row => visibleItems
            .filter(item => item.row === row)
            .map(item => Markup.button.callback(t(item.labelKey), `main:${item.id}`)));

    if (NOTES_WEBAPP_URL) {
        rows.push([
            { text: t('menu.buttons.notesWebApp'), web_app: { url: NOTES_WEBAPP_URL } } as any
        ]);
    }

    return Markup.inlineKeyboard(rows);
};

const getNativeLanguageName = (language: SupportedLanguage) => {
    try {
        return new Intl.DisplayNames([language], { type: 'language' }).of(language) || language;
    } catch {
        return language;
    }
};

const buildLanguageKeyboard = (currentLanguage: SupportedLanguage, t: BotTranslate) => {
    const buttons = SUPPORTED_LANGUAGES.map(language => Markup.button.callback(
        `${language === currentLanguage ? '✅ ' : ''}${getNativeLanguageName(language)}`,
        `language:set:${language}`
    ));
    const rows = [] as ReturnType<typeof Markup.button.callback>[][];
    for (let index = 0; index < buttons.length; index += 2) {
        rows.push(buttons.slice(index, index + 2));
    }
    rows.push([Markup.button.callback(t('language.back'), 'language:back')]);
    return Markup.inlineKeyboard(rows);
};

const getMailMenuAccountLabel = (account: MailAccountRecord) => normalizeTextPreview(
    account.label?.trim() || account.email,
    34
);
const buildMailMenuKeyboard = (accounts: MailAccountRecord[], t: BotTranslate) => {
    const rows = accounts.map(account => [
        Markup.button.callback(
            `${account.is_active ? '✅ ' : '📧 '}${getMailMenuAccountLabel(account)}`,
            account.is_active ? `mail:noop:${account.id}` : `mail:use:${account.id}`
        ),
        Markup.button.callback('🗑', `mail:delete:${account.id}`)
    ]);
    rows.push([Markup.button.callback(t('mail.buttons.setup'), 'mail:add')]);
    rows.push([
        Markup.button.callback(t('mail.buttons.yandexInstructions'), 'mail:instr:yandex'),
        Markup.button.callback(t('mail.buttons.googleInstructions'), 'mail:instr:google')
    ]);
    rows.push([Markup.button.callback(t('mail.buttons.back'), 'mail:back:menu')]);
    return Markup.inlineKeyboard(rows);
};
const buildMailProviderKeyboard = (t: BotTranslate) => Markup.inlineKeyboard([
    [
        Markup.button.callback(t('mail.buttons.google'), 'mail:add:google'),
        Markup.button.callback(t('mail.buttons.yandex'), 'mail:add:yandex')
    ],
    [Markup.button.callback(t('mail.buttons.cancel'), 'mail:list')]
]);
const renderMailMenu = async (ctx: any, userId: number, mode: 'reply' | 'edit' = 'reply') => {
    const data = await runBackendGetMailAccounts(userId);
    const text = data.accounts.length
        ? ctx.t('mail.menuList', { count: data.accounts.length })
        : ctx.t('mail.noAccounts');
    const keyboard = buildMailMenuKeyboard(data.accounts, ctx.t);
    if (mode === 'edit') {
        return ctx.editMessageText(text, keyboard).catch((error: any) => {
            const message = `${error?.description || error?.message || ''}`;
            if (message.includes('message is not modified')) return;
            throw error;
        });
    }
    return ctx.reply(text, keyboard);
};
const buildContextSettingsKeyboard = (t: BotTranslate) => Markup.inlineKeyboard([
    [Markup.button.callback(t('context.buttons.change'), 'context:change')],
    [Markup.button.callback(t('context.buttons.back'), 'context:back')]
]);

const syncCommandScopeForUser = async (
    telegramId: number,
    isAdmin: boolean,
    language: SupportedLanguage
) => {
    const nextRole: 'admin' | 'user' = isAdmin ? 'admin' : 'user';
    const cacheKey = `${nextRole}:${language}`;
    if (commandScopeCache.get(telegramId) === cacheKey) return;

    const commands = buildBotCommands(isAdmin, (key, options) => translateBot(language, key, options));
    await bot.telegram.setMyCommands(commands as any, {
        scope: { type: 'chat', chat_id: telegramId }
    } as any);

    commandScopeCache.set(telegramId, cacheKey);
};
type RenameFlowState = 'confirm' | 'await_name';
const renameFlows = new Map<number, RenameFlowState>();
const timezoneSetupFlows = new Map<number, 'await_offset'>();
const customPromptEditFlows = new Map<number, 'await_content'>();
const contextLimitFlows = new Map<number, 'await_limit'>();
const noteEditFlows = new Map<number, { noteId: number; page: number }>();
type MailSetupFlow =
    | { step: 'await_email'; provider: 'google' | 'yandex' }
    | { step: 'await_password'; provider: 'google' | 'yandex'; email: string };
const mailSetupFlows = new Map<number, MailSetupFlow>();
const adminUserContextLimitFlows = new Map<number, { targetUserId: number; page: number }>();

// Rate limiter for /recover_desktop: 1 request per 60 sec per account.
// Each call rotates the user's password and revokes all sessions, so it must
// not be spammable.
const recoverDesktopCooldowns = new Map<number, number>();
const RECOVER_DESKTOP_COOLDOWN_SEC = 60;

// Confirmation flow state for /recover_desktop (similar to unlinkChoiceFlows).
// User clicks the button → we show a YES/NO inline keyboard → only on YES we
// actually rotate the password. Expires after 5 minutes.
const recoverDesktopConfirmFlows = new Map<number, { expiresAt: number }>();
const RECOVER_DESKTOP_CONFIRM_TTL_MS = 5 * 60 * 1000;
const adminAiMessageFlow = new Map<number, number>();

const startSelfRenameFlow = (ctx: any) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    renameFlows.set(userId, 'confirm');
    return ctx.reply(
        ctx.t('profile.renameConfirm'),
        Markup.keyboard([[
            ctx.t('common.yes'),
            ctx.t('common.no')
        ]]).resize().oneTime()
    );
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
        await ctx.reply(ctx.t('admin.userNotFound'));
        return;
    }

    const thought = instruction.trim();
    if (!thought) {
        await ctx.reply(ctx.t('adminDirect.empty'));
        return;
    }

    const targetUserName = targetUser.name || targetUser.telegram_username || ctx.t('adminDirect.friend');
    await ctx.reply(ctx.t('adminDirect.generating'));

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
            await ctx.reply(ctx.t('adminDirect.emptyResult'));
            return;
        }

        if (!targetUser.telegram_id) {
            throw new Error('У аккаунта нет привязанного Telegram.');
        }
        await safeSendToUser(targetUser.telegram_id, finalMessage);

        // Отправка сгенерированных изображений юзеру
        if (Array.isArray(response.data?.generated_images) && response.data.generated_images.length > 0) {
            for (const img of response.data.generated_images) {
                try {
                    const imageBuffer = Buffer.from(img.image_base64, 'base64');
                    await bot.telegram.sendPhoto(targetUser.telegram_id, { source: imageBuffer });
                } catch (imgErr) {
                    console.error('Ошибка отправки сгенерированного изображения юзеру:', formatSafeError(imgErr));
                }
            }
        }

        await ctx.reply(ctx.t('adminDirect.sent', { name: targetUserName, id: targetUserId, text: finalMessage }));
    } catch (err) {
        await ctx.reply(ctx.t('adminDirect.error', { error: err instanceof Error ? err.message : String(err) }));
    }
};

const ISO_WEEKDAY_KEY: Record<number, string> = {
    1: 'tasks.weekdays.monday',
    2: 'tasks.weekdays.tuesday',
    3: 'tasks.weekdays.wednesday',
    4: 'tasks.weekdays.thursday',
    5: 'tasks.weekdays.friday',
    6: 'tasks.weekdays.saturday',
    7: 'tasks.weekdays.sunday'
};

const formatRecurrenceForDisplay = (task: TaskRecord, t: BotTranslate) => {
    if (task.recurrence_type === 'daily') return t('tasks.recurrence.daily');
    if (task.recurrence_type === 'weekly') {
        const weekdayKey = task.recurrence_weekday
            ? ISO_WEEKDAY_KEY[task.recurrence_weekday]
            : null;
        return weekdayKey
            ? t('tasks.recurrence.weeklyOn', { weekday: t(weekdayKey) })
            : t('tasks.recurrence.weekly');
    }
    return t('tasks.recurrence.once');
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

const formatTaskForDisplay = async (task: TaskRecord, t: BotTranslate) => {
    const payloadPreview = task.payload.length > 140 ? `${task.payload.slice(0, 140)}...` : task.payload;
    const recurrence = formatRecurrenceForDisplay(task, t);
    const fallbackOffset = (await getUser(task.user_id))?.timezone_offset ?? 5;
    const timezoneOffset = typeof task.timezone_offset === 'number' ? task.timezone_offset : fallbackOffset;
    const when = formatUnixForTimezone(task.execute_at, timezoneOffset);
    const notifyText = (task.notify_mode === 'on_match' || task.notify_mode === 'on_condition')
        ? t('tasks.notify.withCondition', {
            mode: t(`tasks.notify.modes.${task.notify_mode}`),
            condition: task.notify_condition || t('tasks.empty')
        })
        : t(`tasks.notify.modes.${task.notify_mode}`);
    return t('tasks.item', {
        id: task.id,
        type: t(`tasks.types.${task.task_type}`),
        status: t(`tasks.statuses.${task.status}`),
        localTime: when.local,
        timezone: when.tzLabel,
        utcTime: when.utc,
        recurrence,
        notify: notifyText,
        payload: payloadPreview
    });
};

const formatTasksList = async (
    tasks: TaskRecord[],
    t: BotTranslate,
    emptyText = t('tasks.notFound')
) => (
    tasks.length
        ? (await Promise.all(tasks.map(task => formatTaskForDisplay(task, t)))).join('\n\n')
        : emptyText
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
    onStreamToken?: (text: string) => Promise<void> | void;
    onReasoningStream?: (text: string) => Promise<void> | void;
};

const runBackendAiStream = async (
    userId: number,
    text: string,
    options?: {
        forcePro?: boolean;
        persistUserText?: string;
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
        let streamErrorMessage: string | null = null;

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
                            case 'stream_token':
                                if (STREAM_DEBUG_LOG) {
                                    console.log(`[tg][sse] stream_token received, len=${typeof data.text === 'string' ? data.text.length : '?'}`);
                                }
                                if (callbacks?.onStreamToken) await callbacks.onStreamToken(data.text);
                                break;
                            case 'reasoning_token':
                                if (STREAM_DEBUG_LOG) {
                                    console.log(`[tg][sse] reasoning_token received, len=${typeof data.text === 'string' ? data.text.length : '?'}`);
                                }
                                if (callbacks?.onReasoningStream) await callbacks.onReasoningStream(data.text);
                                break;
                            case 'desktop_action':
                                if (callbacks?.onDesktopAction) {
                                    Promise.resolve(callbacks.onDesktopAction(data)).catch((err: any) => {
                                        console.warn('[tg][sse] desktop_action callback failed:', formatSafeError(err));
                                    });
                                }
                                break;
                            case 'done':
                                finalResult = data;
                                break;
                            case 'error':
                                streamError = data.error || 'unknown_error';
                                streamErrorMessage = data.message || '';
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
                        const err = new Error(streamError) as Error & { localizedMessage?: string };
                        err.localizedMessage = streamErrorMessage || undefined;
                        reject(err);
                    } else {
                        resolve(finalResult || { reply_text: '' });
                    }
                });
            } else {
                if (streamError) {
                    const err = new Error(streamError) as Error & { localizedMessage?: string };
                    err.localizedMessage = streamErrorMessage || undefined;
                    reject(err);
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

const runBackendCreatePrompt = async (actorUserId: number, name: string, description: string, content: string) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.post(`${BACKEND_API_BASE_URL}/internal/prompts`, { actor_user_id: actorUserId, name, description, content }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean; prompt_id: number };
};

const runBackendUpdatePromptName = async (actorUserId: number, promptId: number, name: string) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.put(`${BACKEND_API_BASE_URL}/internal/prompts/${promptId}/name`, { actor_user_id: actorUserId, name }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean };
};

const runBackendUpdatePromptDescription = async (actorUserId: number, promptId: number, description: string) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.put(`${BACKEND_API_BASE_URL}/internal/prompts/${promptId}/description`, { actor_user_id: actorUserId, description }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean };
};

const runBackendUpdatePromptContent = async (actorUserId: number, promptId: number, content: string) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.put(`${BACKEND_API_BASE_URL}/internal/prompts/${promptId}/content`, { actor_user_id: actorUserId, content }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean };
};

const runBackendSetDefaultPrompt = async (actorUserId: number, promptId: number) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.put(`${BACKEND_API_BASE_URL}/internal/prompts/${promptId}/default`, { actor_user_id: actorUserId }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean };
};

const runBackendDeletePrompt = async (actorUserId: number, promptId: number) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.delete(`${BACKEND_API_BASE_URL}/internal/prompts/${promptId}`, { data: { actor_user_id: actorUserId }, headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean };
};

const runBackendSetTimezone = async (userId: number, offset: number) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.post(`${BACKEND_API_BASE_URL}/internal/user/timezone`, { user_id: userId, timezone_offset: offset }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
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

const runBackendGetMailAccounts = async (userId: number) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.get(`${BACKEND_API_BASE_URL}/internal/mail/accounts`, {
        params: { user_id: userId },
        headers: backendHeaders(),
        timeout: BACKEND_TIMEOUT_DEFAULT_MS
    });
    return response.data as { accounts: MailAccountRecord[]; active_account_id: number | null };
};

const runBackendMailUse = async (userId: number, reference: string) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.post(`${BACKEND_API_BASE_URL}/internal/mail/use`, { user_id: userId, reference }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean; provider: string; imap_user: string };
};

const runBackendMailForget = async (userId: number, reference?: string | null) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.delete(`${BACKEND_API_BASE_URL}/internal/mail/account`, { data: { user_id: userId, reference: reference || undefined }, headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean; deleted: string; remaining?: Array<{ provider: string; imap_user: string }>; new_active?: { provider: string; imap_user: string } };
};

// ── Backend API helpers for user management ───────────────────────────────

const runBackendUpsertTelegramUser = async (tgId: number, name: string, role: string, status: string, tgUsername: string | null, defaultPromptId: number | null, language?: SupportedLanguage | null) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.post(`${BACKEND_API_BASE_URL}/internal/users/upsert-telegram`, { tg_id: tgId, name, role, status, tg_username: tgUsername, default_prompt_id: defaultPromptId, language }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean; user: UserRecord };
};

const runBackendCreatePendingUser = async (tgId: number, name: string | null, tgUsername: string | null, defaultPromptId: number | null, language?: SupportedLanguage | null) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.post(`${BACKEND_API_BASE_URL}/internal/users/create-pending`, { tg_id: tgId, name, tg_username: tgUsername, default_prompt_id: defaultPromptId, language }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
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

const runBackendGetUserByTelegramId = async (telegramId: number) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    try {
        const response = await axios.get(`${BACKEND_API_BASE_URL}/internal/users/by-telegram/${telegramId}`, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
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

const runBackendUpdateUserLanguage = async (userId: number, language: SupportedLanguage) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.put(`${BACKEND_API_BASE_URL}/internal/users/${userId}/language`, { user_id: userId, language }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean; language: SupportedLanguage };
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

const getDatabaseTelegramAdmins = async () => {
    const admins: UserRecord[] = [];
    const pageSize = 500;
    let offset = 0;
    let total = 0;

    do {
        const page = await runBackendGetUsersList('all', pageSize, offset);
        total = Math.max(0, Number(page.total) || 0);
        for (const user of page.users) {
            if (user.role === 'admin' && user.status === 'approved' && user.telegram_id) {
                admins.push(user);
            }
        }
        offset += page.users.length;
        if (!page.users.length) break;
    } while (offset < total);

    return admins;
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

type ModelsCatalogEntry = { id: string; name: string; description: string; is_free?: boolean };

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
const normalizeTextPreview = (value: string, maxLen = 120) => {
    const compact = value.replace(/\s+/g, ' ').trim();
    if (!compact) return '';
    return compact.length > maxLen ? `${compact.slice(0, maxLen)}...` : compact;
};
const extractCommandPayload = (messageText: string, command: string) => {
    const pattern = new RegExp(`^\\/${command}(?:@\\w+)?\\s*`, 'i');
    return messageText.replace(pattern, '').trim();
};
const formatNoteDate = (unixTs: number, language: SupportedLanguage, t: BotTranslate) => {
    if (!Number.isFinite(unixTs) || unixTs <= 0) return t('notes.unknownDate');
    return new Date(unixTs * 1000).toLocaleString(language);
};
const formatNotesPage = (
    notes: NoteRecord[],
    page: number,
    total: number,
    pageSize: number,
    t: BotTranslate,
    language: SupportedLanguage,
    query?: string
) => {
    if (!notes.length) {
        return query
            ? t('notes.searchEmpty', { query })
            : t('notes.none');
    }
    const safePage = Math.max(1, page);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const head = query
        ? t('notes.searchHead', { query, total })
        : t('notes.listHead', { total });
    const list = notes.map(note => {
        const titlePart = note.title?.trim() ? `${normalizeTextPreview(note.title, 40)} | ` : '';
        return `#${note.id} [${formatNoteDate(note.created_at, language, t)}] — ${titlePart}${normalizeTextPreview(note.content, 120)}`;
    }).join('\n');
    return t('notes.page', { head, list, page: safePage, pages: totalPages });
};
const getNoteMenuTitle = (note: NoteRecord, t: BotTranslate) => {
    const title = (note.title || '').trim();
    if (title) return normalizeTextPreview(title, 48);
    return normalizeTextPreview(note.content || t('notes.noText'), 48);
};
const buildNotesMenuKeyboard = (
    notes: NoteRecord[],
    page: number,
    total: number,
    t: BotTranslate
) => {
    const keyboardRows = notes.map(note => [
        Markup.button.callback(
            `#${note.id} ${getNoteMenuTitle(note, t)}`,
            `notes:view:${note.id}:${page}`
        )
    ]);

    const navRow = [];
    if (page > 0) {
        navRow.push(Markup.button.callback(t('notes.buttons.previous'), `notes:list:${page - 1}`));
    }
    if ((page + 1) * NOTES_MENU_PAGE_SIZE < total) {
        navRow.push(Markup.button.callback(t('notes.buttons.next'), `notes:list:${page + 1}`));
    }
    if (navRow.length) keyboardRows.push(navRow);

    keyboardRows.push([Markup.button.callback(t('notes.buttons.menu'), 'notes:back:menu')]);
    return Markup.inlineKeyboard(keyboardRows);
};
const buildNoteViewKeyboard = (noteId: number, page: number, t: BotTranslate) => Markup.inlineKeyboard([
    [Markup.button.callback(t('notes.buttons.edit'), `notes:edit:${noteId}:${page}`)],
    [Markup.button.callback(t('notes.buttons.delete'), `notes:delete:${noteId}:${page}`)],
    [Markup.button.callback(t('notes.buttons.toList'), `notes:list:${page}`)],
    [Markup.button.callback(t('notes.buttons.menu'), 'notes:back:menu')]
]);
const renderNotesMenuList = async (ctx: any, userId: number, page: number, mode: 'reply' | 'edit' = 'reply') => {
    const safePage = Math.max(0, page);
    const offset = safePage * NOTES_MENU_PAGE_SIZE;
    const { notes, total } = await runBackendGetNotes(userId, NOTES_MENU_PAGE_SIZE, offset);
    if (!total) {
        const text = ctx.t('notes.noneWithHint');
        const keyboard = Markup.inlineKeyboard([[
            Markup.button.callback(ctx.t('notes.buttons.menu'), 'notes:back:menu')
        ]]);
        if (mode === 'edit') return ctx.editMessageText(text, keyboard);
        return ctx.reply(text, keyboard);
    }

    const pages = Math.max(1, Math.ceil(total / NOTES_MENU_PAGE_SIZE));
    const text = ctx.t('notes.menuList', {
        page: safePage + 1,
        pages,
        total
    });
    const keyboard = buildNotesMenuKeyboard(notes, safePage, total, ctx.t);
    if (mode === 'edit') return ctx.editMessageText(text, keyboard);
    return ctx.reply(text, keyboard);
};

const getChatMenuTitle = (chat: UserChatRecord) => normalizeTextPreview(chat.title || `#${chat.id}`, 42);
const buildChatsMenuKeyboard = (
    chats: UserChatRecord[],
    activeChatId: number,
    page: number,
    hasNextPage: boolean,
    t: BotTranslate
) => {
    const rows = chats.map(chat => [
        Markup.button.callback(
            `${chat.id === activeChatId ? '✅ ' : ''}${getChatMenuTitle(chat)}`,
            `chats:use:${chat.id}:${page}`
        )
    ]);

    const navigation = [];
    if (page > 0) {
        navigation.push(Markup.button.callback(t('chats.buttons.previous'), `chats:list:${page - 1}`));
    }
    if (hasNextPage) {
        navigation.push(Markup.button.callback(t('chats.buttons.next'), `chats:list:${page + 1}`));
    }
    if (navigation.length) rows.push(navigation);

    rows.push([Markup.button.callback(t('chats.buttons.new'), 'chats:new')]);
    rows.push([Markup.button.callback(t('chats.buttons.menu'), 'chats:back:menu')]);
    return Markup.inlineKeyboard(rows);
};

const renderChatsMenuList = async (ctx: any, userId: number, page: number, mode: 'reply' | 'edit' = 'reply') => {
    const safePage = Math.max(0, page);
    const data = await runBackendGetChats(
        userId,
        CHATS_MENU_PAGE_SIZE + 1,
        safePage * CHATS_MENU_PAGE_SIZE
    );
    const chats = data.chats.slice(0, CHATS_MENU_PAGE_SIZE);
    const hasNextPage = data.chats.length > CHATS_MENU_PAGE_SIZE;
    const text = chats.length
        ? ctx.t('chats.menuList', { page: safePage + 1 })
        : ctx.t('chats.none');
    const keyboard = buildChatsMenuKeyboard(chats, data.active_chat_id, safePage, hasNextPage, ctx.t);

    if (mode === 'edit') {
        return ctx.editMessageText(text, keyboard).catch((err: any) => {
            const message = `${err?.description || err?.message || ''}`;
            if (message.includes('message is not modified')) return;
            throw err;
        });
    }
    return ctx.reply(text, keyboard);
};

const renderNoteView = async (ctx: any, userId: number, noteId: number, page: number, mode: 'reply' | 'edit' = 'edit') => {
    const note = await runBackendGetNote(userId, noteId);
    if (!note) {
        const text = ctx.t('notes.notFound', { id: noteId });
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback(ctx.t('notes.buttons.toList'), `notes:list:${page}`)],
            [Markup.button.callback(ctx.t('notes.buttons.menu'), 'notes:back:menu')]
        ]);
        if (mode === 'edit') return ctx.editMessageText(text, keyboard);
        return ctx.reply(text, keyboard);
    }

    const title = note.title?.trim() ? note.title.trim() : ctx.t('notes.noTitle');
    const text = ctx.t('notes.view', {
        id: note.id,
        date: formatNoteDate(note.created_at, ctx.state.language, ctx.t),
        title,
        content: note.content
    });
    const keyboard = buildNoteViewKeyboard(note.id, page, ctx.t);
    if (mode === 'edit') return ctx.editMessageText(text, keyboard);
    return ctx.reply(text, keyboard);
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
const activeUserRequests = new Set<number>();

const withUserRequestLock = async <T>(
    ctx: any,
    action: () => Promise<T>,
    waitForTurn = false
): Promise<T | undefined> => {
    const userId = Number(ctx.state.accountId);
    if (!Number.isSafeInteger(userId) || userId <= 0) return undefined;
    while (activeUserRequests.has(userId)) {
        if (!waitForTurn) {
            await ctx.reply(ctx.t('common.requestInProgress'));
            return undefined;
        }
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 250);
        });
    }

    activeUserRequests.add(userId);
    try {
        return await action();
    } finally {
        activeUserRequests.delete(userId);
    }
};

const runUserRequestInBackground = (
    ctx: any,
    action: () => Promise<unknown>,
    waitForTurn = false
) => {
    void withUserRequestLock(ctx, action, waitForTurn).catch((error) => {
        console.error('[tg] Background user request failed:', formatSafeError(error));
    });
};

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

    await processUserTextThroughAi(ctx, caption, { documents: items });
};

const processUserDocumentThroughAi = async (ctx: any) => {
    const userId = ctx.state.accountId;
    if (!userId) return;

    const doc = ctx.message?.document;
    if (!doc) return;

    const caption = typeof ctx.message?.caption === 'string' ? ctx.message.caption.trim() : '';
    const mediaGroupId = ctx.message?.media_group_id;

    // Validate extension locally (mirrors backend SUPPORTED_EXTENSIONS).
    const filename = (typeof doc.file_name === 'string' && doc.file_name.trim()) ? doc.file_name.trim() : 'document';
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    if (!SUPPORTED_DOCUMENT_EXTENSIONS.has(ext)) {
        await ctx.reply(ctx.t('attachments.unsupportedFormat', { extension: ext || '?' }));
        return;
    }

    // Check file size from Telegram metadata (avoid downloading huge files).
    if (typeof doc.file_size === 'number' && doc.file_size > MAX_DOCUMENT_BYTES) {
        await ctx.reply(ctx.t('attachments.tooLarge', { size: formatBytes(doc.file_size), max: '5 MB' }));
        return;
    }

    const downloaded = await downloadTelegramDocument(ctx, doc);
    if (!downloaded) {
        await ctx.reply(ctx.t('attachments.downloadFailed'));
        return;
    }
    if (downloaded.buffer.length > MAX_DOCUMENT_BYTES) {
        await ctx.reply(ctx.t('attachments.tooLarge', { size: formatBytes(downloaded.buffer.length), max: '5 MB' }));
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
            clearTimeout(existing.timer);
            existing.items.push(item);
            if (caption) existing.caption = caption;
            existing.timer = setTimeout(() => {
                void withUserRequestLock(ctx, () => processDocumentAlbum(albumKey), true);
            }, 1500);
        } else {
            documentAlbumBuffer.set(albumKey, {
                items: [item],
                caption,
                timer: setTimeout(() => {
                    void withUserRequestLock(ctx, () => processDocumentAlbum(albumKey), true);
                }, 1500),
                ctx
            });
        }
        return;
    }

    // Single document → straight to AI (caption becomes the text, or placeholder if empty).
    await processUserTextThroughAi(ctx, caption, { documents: [item] });
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
    const userId = ctx.state.accountId;
    if (!userId || !images.length) return;

    const userRecord = await getUser(userId);
    if (!userRecord) {
        await ctx.reply(ctx.t('common.userMissing'));
        return;
    }


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
            : ctx.t('ai.fallbackAnswer');
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
                console.warn('Не удалось привязать telegram_message_id к backend photo сообщению:', formatSafeError(bindErr));
            }
        }
    } catch (err) {
        console.error('Ошибка анализа изображения:', formatSafeError(err));
        await ctx.reply(ctx.t('attachments.imageProcessingFailed'));
    }
};

const processUserPhotoThroughAi = async (ctx: any) => {
    const userId = ctx.state.accountId;
    if (!userId) return;

    const photos = ctx.message?.photo;
    if (!Array.isArray(photos) || !photos.length) return;

    const caption = typeof ctx.message?.caption === 'string' ? ctx.message.caption.trim() : '';
    const mediaGroupId = ctx.message?.media_group_id;

    try {
        const downloaded = await downloadTelegramPhoto(ctx, photos);
        if (!downloaded) {
            await ctx.reply(ctx.t('attachments.photoDownloadFailed'));
            return;
        }

        // Альбом — собираем все фото, обрабатываем через задержку
        if (mediaGroupId) {
            const albumKey = `${userId}:${mediaGroupId}`;
            const existing = photoAlbumBuffer.get(albumKey);
            if (existing) {
                clearTimeout(existing.timer);
                existing.images.push(downloaded);
                if (caption) existing.caption = caption;
                existing.timer = setTimeout(() => {
                    void withUserRequestLock(ctx, () => processPhotoAlbum(albumKey), true);
                }, 1500);
            } else {
                photoAlbumBuffer.set(albumKey, {
                    images: [downloaded],
                    caption,
                    timer: setTimeout(() => {
                        void withUserRequestLock(ctx, () => processPhotoAlbum(albumKey), true);
                    }, 1500),
                    ctx
                });
            }
            return;
        }

        // Одиночное фото — обрабатываем сразу
        const userRecord = await getUser(userId);
        if (!userRecord) {
            await ctx.reply(ctx.t('common.userMissing'));
            return;
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
            : ctx.t('ai.fallbackAnswer');
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
                console.warn('Не удалось привязать telegram_message_id к backend photo сообщению:', formatSafeError(bindErr));
            }
        }
    } catch (err) {
        console.error('Ошибка анализа изображения:', formatSafeError(err));
        await ctx.reply(ctx.t('attachments.imageProcessingFailed'));
    }
};

const getUser = async (id: number): Promise<UserRecord | undefined> => {
    const data = await runBackendGetUser(id);
    return data.user;
};
const getUserByTelegramId = async (telegramId: number): Promise<UserRecord | undefined> => {
    const data = await runBackendGetUserByTelegramId(telegramId);
    return data.user;
};
const addUser = async (id: number, name: string, role: string, status: UserStatus = 'approved', tgUsername: string | null = null) => {
    const defaultPrompt = await runBackendGetDefaultPrompt();
    const result = await runBackendUpsertTelegramUser(id, name, role, status, tgUsername, defaultPrompt?.id ?? null);
    return result.user;
};

const runBackendApplyUserPlan = async (userId: number, plan: UserPlan, endsAt: string | null, assignedBy: number | null) => {
    const response = await axios.post(`${BACKEND_API_BASE_URL}/internal/users/${userId}/plan`, {
        plan, ends_at: endsAt, assigned_by: assignedBy, record_subscription: true
    }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean; plan: UserPlan; ends_at: string | null };
};

type UserPlanSubscriptionRecord = {
    id: number;
    user_id: number;
    plan: UserPlan;
    started_at: string;
    ends_at: string | null;
    is_current: number;
    assigned_by?: number | null;
};

const runBackendGetUserSubscription = async (userId: number) => {
    const response = await axios.get(`${BACKEND_API_BASE_URL}/internal/users/${userId}/subscription`, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return (response.data as { subscription: UserPlanSubscriptionRecord | null }).subscription;
};

const createPendingUser = async (id: number, name: string | null, tgUsername: string | null, language?: SupportedLanguage | null) => {
    const defaultPrompt = await runBackendGetDefaultPrompt();
    const data = await runBackendCreatePendingUser(id, name, tgUsername, defaultPrompt?.id ?? null, language);
    return data.user;
};
const updateUserName = async (id: number, name: string) => {
    await runBackendUpdateUserName(id, name);
};
const updateUserTelegramUsername = async (id: number, tgUsername: string | null) => {
    await runBackendUpdateTgUsername(id, tgUsername);
};
const updateUserLanguage = async (id: number, language: SupportedLanguage) => {
    await runBackendUpdateUserLanguage(id, language);
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
const parsePlanFromDb = (raw: string | null | undefined): UserPlan => {
    if (raw === 'free' || raw === 'standart' || raw === 'pro') return raw;
    return DEFAULT_USER_PLAN;
};
const getPlanMaxContextTokens = (plan: UserPlan) => PLAN_MAX_CONTEXT_TOKENS[plan] || PLAN_MAX_CONTEXT_TOKENS[DEFAULT_USER_PLAN];
const getPlanDailyWebSearchLimit = (plan: UserPlan) => PLAN_DAILY_WEB_SEARCH_LIMITS[plan] ?? PLAN_DAILY_WEB_SEARCH_LIMITS[DEFAULT_USER_PLAN];
const normalizeDailyWebSearchLimit = (value: number | null | undefined) => {
    if (!Number.isFinite(value)) return getPlanDailyWebSearchLimit(DEFAULT_USER_PLAN);
    return Math.max(0, Math.floor(value as number));
};
const applyUserPlan = async (userId: number, plan: UserPlan, endsAt: string | null, assignedBy: number | null) => {
    await runBackendApplyUserPlan(userId, plan, endsAt, assignedBy);
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
const removeUser = async (id: number) => {
    await runBackendRemoveUser(id);
};
const isTimezoneConfigured = (user: UserRecord) => user.timezone_confirmed === 1;
const resolveMaxContextTokens = (user: UserRecord | undefined): number => {
    if (!user) return PLAN_MAX_CONTEXT_TOKENS[DEFAULT_USER_PLAN];
    const planLimit = getPlanMaxContextTokens(parsePlanFromDb(user.plan));
    const mctl = user.max_context_tokens_limit ?? 0;
    const mct = user.max_context_tokens ?? 0;
    const hardLimit = Number.isFinite(mctl) && mctl > 0 ? Math.floor(mctl) : planLimit;
    const userChoice = Number.isFinite(mct) && mct > 0 ? Math.floor(mct) : hardLimit;
    return Math.max(1000, Math.min(userChoice, hardLimit));
};
const shortenHistoryContent = (text: string, maxLen = 10) => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= maxLen) return clean;
    return clean.slice(0, maxLen);
};
const formatRecentHistoryRows = (userId: number, rows: UserHistoryRow[], t: BotTranslate) => {
    if (!rows.length) {
        return t('adminHistory.empty', { id: userId });
    }
    const lines = rows.map(row => {
        const chatPart = row.chat_id ? ` chat:${row.chat_id}` : '';
        const tgMsg = row.telegram_message_id ? ` tg:${row.telegram_message_id}` : '';
        const preview = shortenHistoryContent(row.content);
        return `#${row.id}${chatPart} [${row.role}]${tgMsg} ${row.created_at}\n${preview}`;
    });
    return t('adminHistory.list', { id: userId, rows: lines.join('\n\n') });
};
const resolvePromptForUser = async (userId: number) => (await runBackendGetResolvedPrompt(userId)).prompt;

const linkCodeFlows = new Map<number, 'await_code'>();
const unlinkChoiceFlows = new Map<number, { expiresAt: number }>();

// Middleware для авторизации
bot.use(async (ctx, next) => {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;
    ctx.state.telegramId = telegramId;
    await ensureBotI18nReady();
    const telegramLanguage = normalizeSupportedLanguage(ctx.from?.language_code);
    ctx.state.language = telegramLanguage ?? DEFAULT_LANGUAGE;
    ctx.t = createBotTranslator(() => ctx.state.language);
    const telegramUsername = ctx.from?.username?.trim() || null;
    let userRecord = await getUserByTelegramId(telegramId);

    if (!userRecord) {
        const initialName = telegramUsername ? (ctx.from?.first_name || null) : null;
        userRecord = await createPendingUser(telegramId, initialName, telegramUsername, telegramLanguage);
        if (!userRecord) userRecord = await getUserByTelegramId(telegramId);
        if (!userRecord) {
            console.error(`Backend did not return an account for Telegram identity ${telegramId}`);
            return ctx.reply(ctx.t('common.serviceUnavailable'));
        }

        ctx.state.accountId = userRecord.id;
        await syncCommandScopeForUser(telegramId, false, ctx.state.language);
        await notifyAdminsNewRequest(userRecord);

        if (!telegramUsername) {
            return ctx.reply(ctx.t('access.requestSentNeedsName'));
        }
        return ctx.reply(ctx.t('access.requestSent'));
    }

    const accountId = userRecord.id;
    ctx.state.accountId = accountId;

    const savedLanguage = normalizeSupportedLanguage(userRecord?.language);
    if (savedLanguage) {
        ctx.state.language = savedLanguage;
    } else if (userRecord && telegramLanguage) {
        try {
            await updateUserLanguage(accountId, telegramLanguage);
            userRecord = { ...userRecord, language: telegramLanguage };
            ctx.state.language = telegramLanguage;
        } catch (error) {
            console.warn(`Не удалось сохранить язык Telegram для аккаунта ${accountId}:`, formatSafeError(error));
        }
    }

    const isAdminByDb = userRecord?.role === 'admin' && userRecord.status === 'approved';

    if (isAdminByDb && userRecord) {
        const fallbackName = userRecord?.name || ctx.from?.first_name || 'Admin';
        const defaultPrompt = await runBackendGetDefaultPrompt();
        if (userRecord.telegram_username !== telegramUsername) {
            await updateUserTelegramUsername(accountId, telegramUsername);
            userRecord = (await getUser(accountId)) || userRecord;
        }

        if (userRecord && !userRecord.selected_prompt_id) {
            if (defaultPrompt) await updateUserPrompt(accountId, defaultPrompt.id);
        }
        if (userRecord) {
            const normalizedPlan = parsePlanFromDb(userRecord.plan);
            if (userRecord.plan !== normalizedPlan) {
                await updateUserPlan(accountId, normalizedPlan);
                userRecord = (await getUser(accountId)) || userRecord;
            }
        }

        await syncCommandScopeForUser(telegramId, true, ctx.state.language);
        ctx.state.role = 'admin';
        ctx.state.userName = fallbackName;
        return next();
    }

    if (userRecord.telegram_username !== telegramUsername) {
        await updateUserTelegramUsername(accountId, telegramUsername);
        userRecord = (await getUser(accountId)) || userRecord;
    }

    if (userRecord.status === 'banned') {
        const ban = (await runBackendGetBanRecord(accountId)).ban;
        const reason = ban?.reason ?? ctx.t('access.noReason');
        const date = ban?.banned_at ?? ctx.t('access.unknownDate');
        await syncCommandScopeForUser(telegramId, false, ctx.state.language);
        return ctx.reply(ctx.t('access.blocked', { reason, date }));
    }

    if (userRecord.status === 'none') {
        const text = ctx.message && 'text' in ctx.message ? ctx.message.text.trim() : '';
        if (text === '/link' || text === '/cancellink' || linkCodeFlows.has(accountId)) {
            return next();
        }
        const savedName = await maybeCapturePendingName(ctx, userRecord, text);
        await syncCommandScopeForUser(telegramId, false, ctx.state.language);

        if (savedName) {
            return ctx.reply(ctx.t('access.nameSaved'));
        }

        if (!telegramUsername && !(userRecord.name && userRecord.name.trim())) {
            return ctx.reply(ctx.t('access.pendingNeedsName'));
        }

        return ctx.reply(ctx.t('access.pending'));
    }

    if (userRecord.status === 'disapproved') {
        await syncCommandScopeForUser(telegramId, false, ctx.state.language);
        return ctx.reply(ctx.t('access.rejected'));
    }

    if (userRecord.role !== 'user') {
        await updateUserRole(accountId, 'user');
        userRecord = (await getUser(accountId)) || userRecord;
    }
    if (!userRecord.selected_prompt_id) {
        const defaultPrompt = await runBackendGetDefaultPrompt();
        if (defaultPrompt) await updateUserPrompt(accountId, defaultPrompt.id);
    }
    {
        const normalizedPlan = parsePlanFromDb(userRecord.plan);
        if (userRecord.plan !== normalizedPlan) {
            await updateUserPlan(accountId, normalizedPlan);
            userRecord = (await getUser(accountId)) || userRecord;
        }
    }

    await syncCommandScopeForUser(telegramId, false, ctx.state.language);
    ctx.state.role = 'user';
    ctx.state.userName = userRecord.name || ctx.from?.first_name || ctx.t('roles.user');
    return next();
});

bot.telegram.setMyCommands(buildBotCommands(false, (key, options) => (
    translateBot(DEFAULT_LANGUAGE, key, options)
)) as any);

const showMenu = async (ctx: any) => {
    const isAdmin = ctx.state.role === 'admin';
    const userId = ctx.state.accountId;
    const userRecord = userId ? await getUser(userId) : undefined;
    const hasDesktopAccount = userRecord?.identities?.some(i => i.provider === 'password') ?? false;
    const activePrompt = userRecord && userId
        ? await resolvePromptForUser(userId)
        : await runBackendGetDefaultPrompt();
    const userName = (ctx.state.userName as string | undefined) || userRecord?.name || ctx.t('roles.user');
    const roleLabel = isAdmin ? ctx.t('roles.admin') : ctx.t('roles.user');
    const promptLine = activePrompt
        ? activePrompt.id === CUSTOM_PROMPT_ID
            ? ctx.t('menu.promptCustom')
            : ctx.t('menu.prompt', { id: activePrompt.id, name: activePrompt.name })
        : ctx.t('menu.promptMissing');
    const userPlan = userRecord ? parsePlanFromDb(userRecord.plan) : DEFAULT_USER_PLAN;
    const planLine = ctx.t('menu.plan', { plan: getPlanLabel(userPlan) });
    const contextLine = userRecord
        ? ctx.t('menu.context', { value: getContextWindowText(userRecord) })
        : ctx.t('menu.contextDefault', { value: `${(PLAN_MAX_CONTEXT_TOKENS[DEFAULT_USER_PLAN] / 1000).toFixed(0)}k` });
    const webLimitLine = userRecord
        ? ctx.t('menu.webToday', { value: getDailyWebSearchLimitText(userRecord) })
        : ctx.t('menu.webToday', { value: `0/${PLAN_DAILY_WEB_SEARCH_LIMITS[DEFAULT_USER_PLAN]}` });
    const imageGenLine = userRecord
        ? ctx.t('menu.imagesToday', { value: `${userRecord.daily_image_gen_count ?? 0}/${userRecord.daily_image_gen_limit ?? 0}` })
        : ctx.t('menu.imagesToday', { value: '0/0' });
    const modelLine = userRecord?.preferred_model
        ? ctx.t('menu.model', { model: userRecord.preferred_model })
        : ctx.t('menu.model', { model: ctx.t('menu.modelAuto') });
    const notesLine = NOTES_WEBAPP_URL
        ? ctx.t('menu.notesWebApp')
        : ctx.t('menu.notesCommands');
    const chatsData = userId ? await runBackendGetChats(userId, 100) : null;
    const activeChat = chatsData?.chats.find(chat => chat.id === chatsData.active_chat_id) || null;
    const chatLine = activeChat
        ? ctx.t('menu.activeChat', { id: activeChat.id, title: activeChat.title })
        : ctx.t('menu.activeChatMissing');
    const moderationCounts = isAdmin
        ? await Promise.all([
            runBackendGetUsersList('pending', 1, 0),
            runBackendGetUsersList('banned', 1, 0)
        ])
        : null;
    const moderationLine = moderationCounts
        ? ctx.t('menu.moderation', { pending: moderationCounts[0].total, banned: moderationCounts[1].total })
        : '';

    const text = [
        ctx.t('menu.title'),
        '',
        ctx.t('menu.name', { name: userName }),
        ctx.t('menu.id', { id: userId ?? ctx.t('common.unknown') }),
        ctx.t('menu.role', { role: roleLabel }),
        planLine,
        contextLine,
        webLimitLine,
        imageGenLine,
        modelLine,
        chatLine,
        notesLine,
        promptLine,
        ...(moderationLine ? [moderationLine] : []),
        '',
        ctx.t('menu.chooseAction')
    ].join('\n');

    return ctx.reply(text, buildMainMenuInlineKeyboard(isAdmin, hasDesktopAccount, ctx.t));
};

const handleClear = async (ctx: any) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    renameFlows.delete(userId);
    customPromptEditFlows.delete(userId);
    contextLimitFlows.delete(userId);
    noteEditFlows.delete(userId);
    adminUserContextLimitFlows.delete(userId);
    await runBackendClearActiveChat(userId);
    return ctx.reply(ctx.t('menu.cleared'));
};

const formatPromptsList = async (currentPromptId: number | null, t: BotTranslate, includeDescription = false) => {
    const { prompts } = await runBackendGetPrompts();
    const defaultPrompt = prompts.find(prompt => prompt.is_default === 1) || prompts[0];
    const effectiveCurrentPromptId = currentPromptId ?? defaultPrompt?.id ?? null;

    if (!prompts.length) return t('prompt.none');

    const list = prompts.map(prompt => {
        const markers: string[] = [];
        if (prompt.id === defaultPrompt?.id) markers.push(t('prompt.markers.default'));
        if (prompt.id === effectiveCurrentPromptId) markers.push(t('prompt.markers.selected'));
        const suffix = markers.length ? ` [${markers.join(', ')}]` : '';
        const description = includeDescription
            ? ` — ${getPromptDescriptionForDisplay(prompt, t)}`
            : '';
        return `- ${prompt.id}: ${prompt.name}${suffix}${description}`;
    }).join('\n');

    return t('prompt.plainList', { list });
};

const getPromptDescription = (description: string, t: BotTranslate) => {
    const normalized = description.replace(/\s+/g, ' ').trim();
    if (!normalized) return t('prompt.noDescription');
    return normalized.length > 220 ? `${normalized.slice(0, 220)}...` : normalized;
};

const runBackendGetDefaultPrompt = async () => {
    const { prompts } = await runBackendGetPrompts();
    return prompts.find(prompt => prompt.is_default === 1) || prompts[0];
};

const runBackendGetResolvedPrompt = async (userId: number) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.get(`${BACKEND_API_BASE_URL}/internal/users/${userId}/prompt/resolved`, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { prompt: PromptRecord };
};

const runBackendGetChats = async (userId: number, limit = 100, offset = 0) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.get(`${BACKEND_API_BASE_URL}/internal/users/${userId}/chats`, {
        params: { limit, offset }, headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS
    });
    return response.data as { chats: Array<UserChatRecord & { is_active: boolean }>; active_chat_id: number };
};

const runBackendGetChat = async (userId: number, chatId: number) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.get(`${BACKEND_API_BASE_URL}/internal/users/${userId}/chats/${chatId}`, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { chat: UserChatRecord; is_active: boolean };
};

const runBackendCreateChat = async (userId: number, title?: string) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.post(`${BACKEND_API_BASE_URL}/internal/users/${userId}/chats`, { title }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean; chat: UserChatRecord };
};

const runBackendActivateChat = async (userId: number, chatId: number) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    const response = await axios.post(`${BACKEND_API_BASE_URL}/internal/users/${userId}/chats/${chatId}/activate`, {}, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: boolean; chat: UserChatRecord };
};

const runBackendClearActiveChat = async (userId: number) => {
    const chats = await runBackendGetChats(userId, 1);
    await axios.delete(`${BACKEND_API_BASE_URL}/internal/users/${userId}/chats/${chats.active_chat_id}/messages`, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
};

const runBackendClearUserHistory = async (userId: number) => {
    if (!BACKEND_INTERNAL_TOKEN) throw new Error('BACKEND_INTERNAL_TOKEN не настроен.');
    await axios.delete(`${BACKEND_API_BASE_URL}/internal/users/${userId}/messages`, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
};

const runBackendGetUserHistory = async (actorUserId: number, userId: number, limit: number) => {
    const response = await axios.get(`${BACKEND_API_BASE_URL}/internal/admin/users/${userId}/history`, {
        params: { actor_user_id: actorUserId, limit }, headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS
    });
    return response.data as { messages: UserHistoryRow[] };
};

const runBackendDeleteUserHistoryByRole = async (actorUserId: number, userId: number, role: ChatRole | 'all') => {
    const response = await axios.delete(`${BACKEND_API_BASE_URL}/internal/admin/users/${userId}/history`, {
        data: { actor_user_id: actorUserId, role }, headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS
    });
    return response.data as { ok: boolean; deleted: number; matched_by: string };
};

const runBackendDeleteUserHistoryMessage = async (actorUserId: number, userId: number, messageId: number, mode: 'db' | 'tg') => {
    const response = await axios.delete(`${BACKEND_API_BASE_URL}/internal/admin/users/${userId}/history`, {
        data: { actor_user_id: actorUserId, message_id: messageId, mode }, headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS
    });
    return response.data as { ok: boolean; deleted: number; matched_by: string };
};

const withNoteOwner = (userId: number, note: Omit<NoteRecord, 'user_id'>): NoteRecord => ({ ...note, user_id: userId });

const runBackendGetNotes = async (userId: number, limit: number, offset: number, query = '') => {
    const response = await axios.get(`${BACKEND_API_BASE_URL}/internal/users/${userId}/notes`, {
        params: { limit, offset, query }, headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS
    });
    const data = response.data as { notes: Array<Omit<NoteRecord, 'user_id'>>; total: number };
    return { notes: data.notes.map(note => withNoteOwner(userId, note)), total: data.total };
};

const runBackendGetNote = async (userId: number, noteId: number) => {
    try {
        const response = await axios.get(`${BACKEND_API_BASE_URL}/internal/users/${userId}/notes/${noteId}`, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
        return withNoteOwner(userId, (response.data as { note: Omit<NoteRecord, 'user_id'> }).note);
    } catch (error: any) {
        if (axios.isAxiosError(error) && error.response?.status === 404) return undefined;
        throw error;
    }
};

const runBackendCreateNote = async (userId: number, content: string, title = '') => {
    const response = await axios.post(`${BACKEND_API_BASE_URL}/internal/users/${userId}/notes`, { title, content }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: true; id: number };
};

const runBackendUpdateNote = async (userId: number, noteId: number, content: string) => {
    const response = await axios.put(`${BACKEND_API_BASE_URL}/internal/users/${userId}/notes/${noteId}`, { content }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return response.data as { ok: true };
};

const runBackendDeleteNote = async (userId: number, noteId: number) => {
    try {
        await axios.delete(`${BACKEND_API_BASE_URL}/internal/users/${userId}/notes/${noteId}`, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
        return true;
    } catch (error: any) {
        if (axios.isAxiosError(error) && error.response?.status === 404) return false;
        throw error;
    }
};

const runBackendGetNoteStats = async (userId: number) => {
    const response = await axios.get(`${BACKEND_API_BASE_URL}/internal/users/${userId}/note-stats`, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    return (response.data as { stats: NoteStatsRecord }).stats;
};

const runBackendGetNoteStatsForUsers = async (actorUserId: number, userIds: number[]) => {
    const response = await axios.post(`${BACKEND_API_BASE_URL}/internal/admin/notes/stats`, { actor_user_id: actorUserId, user_ids: userIds }, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
    const rows = (response.data as { stats: NoteStatsRecord[] }).stats;
    return new Map(rows.map(row => [row.user_id, row]));
};

const runBackendGetTasks = async (userId: number, status: TaskStatus | 'all' = 'pending', limit = 20) => {
    const response = await axios.get(`${BACKEND_API_BASE_URL}/internal/users/${userId}/tasks`, {
        params: { status, limit }, headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS
    });
    const tasks = (response.data as { tasks: Array<Omit<TaskRecord, 'user_id'>> }).tasks;
    return tasks.map(task => ({ ...task, user_id: userId }));
};

const runBackendGetTask = async (userId: number, taskId: number) => {
    try {
        const response = await axios.get(`${BACKEND_API_BASE_URL}/internal/users/${userId}/tasks/${taskId}`, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
        const task = (response.data as { task: Omit<TaskRecord, 'user_id'> }).task;
        return { ...task, user_id: userId };
    } catch (error: any) {
        if (axios.isAxiosError(error) && error.response?.status === 404) return undefined;
        throw error;
    }
};

const runBackendDeleteTask = async (userId: number, taskId: number) => {
    try {
        await axios.delete(`${BACKEND_API_BASE_URL}/internal/users/${userId}/tasks/${taskId}`, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
        return true;
    } catch (error: any) {
        if (axios.isAxiosError(error) && error.response?.status === 404) return false;
        throw error;
    }
};

const getPromptDescriptionForDisplay = (
    prompt: { name: string; description?: string | null; content: string },
    t: BotTranslate
) => prompt.name === 'Default'
    ? t('prompt.defaultDescription')
    : getPromptDescription(prompt.description || '', t);

const getCustomPromptPreview = (
    content: string | null | undefined,
    t: BotTranslate,
    maxLen = 220
) => {
    const normalized = (content || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return t('prompt.customEmpty');
    return normalized.length > maxLen ? `${normalized.slice(0, maxLen)}...` : normalized;
};

const buildPromptListKeyboard = (
    prompts: PromptRecord[],
    currentPromptId: number,
    hasCustomPrompt: boolean,
    t: BotTranslate
) => {
    const rows = prompts.map(prompt => {
        const label = prompt.id === currentPromptId ? `✅ ${prompt.name}` : prompt.name;
        return [Markup.button.callback(label, `prompt:view:${prompt.id}`)];
    });

    const customLabel = currentPromptId === CUSTOM_PROMPT_ID
        ? t('prompt.buttons.customSelected')
        : hasCustomPrompt
            ? t('prompt.buttons.custom')
            : t('prompt.buttons.customCreate');
    rows.push([Markup.button.callback(customLabel, 'prompt:custom:view')]);
    rows.push([Markup.button.callback(t('prompt.buttons.cancel'), 'prompt:cancel')]);
    return Markup.inlineKeyboard(rows);
};

const buildPromptCardKeyboard = (promptId: number, selected: boolean, t: BotTranslate) => {
    const chooseButton = selected
        ? Markup.button.callback(t('prompt.buttons.alreadySelected'), `prompt:noop:${promptId}`)
        : Markup.button.callback(t('prompt.buttons.select'), `prompt:use:${promptId}`);

    return Markup.inlineKeyboard([
        [chooseButton],
        [
            Markup.button.callback(t('prompt.buttons.toList'), 'prompt:list'),
            Markup.button.callback(t('prompt.buttons.cancel'), 'prompt:cancel')
        ]
    ]);
};

const buildCustomPromptCardKeyboard = (
    isSelected: boolean,
    hasCustomPrompt: boolean,
    t: BotTranslate
) => {
    const selectButton = isSelected
        ? Markup.button.callback(t('prompt.buttons.keepCurrent'), 'prompt:custom:keep')
        : Markup.button.callback(
            hasCustomPrompt
                ? t('prompt.buttons.useCurrent')
                : t('prompt.buttons.saveAndUse'),
            'prompt:custom:use'
        );

    return Markup.inlineKeyboard([
        [selectButton],
        [
            Markup.button.callback(
                hasCustomPrompt ? t('prompt.buttons.edit') : t('prompt.buttons.create'),
                'prompt:custom:edit'
            )
        ],
        [
            Markup.button.callback(t('prompt.buttons.toList'), 'prompt:list'),
            Markup.button.callback(t('prompt.buttons.cancel'), 'prompt:cancel')
        ]
    ]);
};

const renderPromptListInteractive = async (ctx: any, user: { selected_prompt_id: number | null; custom_prompt_content?: string | null }, mode: 'reply' | 'edit') => {
    const { prompts } = await runBackendGetPrompts();
    if (!prompts.length) {
        if (mode === 'edit') return ctx.editMessageText(ctx.t('prompt.none'));
        return ctx.reply(ctx.t('prompt.none'));
    }

    const currentPromptId = user.selected_prompt_id === CUSTOM_PROMPT_ID
        ? CUSTOM_PROMPT_ID
        : (await resolvePromptForUser(ctx.state.accountId)).id;
    const text = ctx.t('prompt.choose');
    const keyboard = buildPromptListKeyboard(
        prompts,
        currentPromptId,
        !!(user.custom_prompt_content || '').trim(),
        ctx.t
    );

    if (mode === 'edit') return ctx.editMessageText(text, keyboard);
    return ctx.reply(text, keyboard);
};

// ── Model selector (TG) ──────────────────────────────────────────────────────

const buildModelListKeyboard = (
    models: ModelsCatalogEntry[],
    currentModelId: string | null,
    t: BotTranslate
) => {
    const rows: any[] = [];
    // Авто — всегда первый
    const autoLabel = !currentModelId
        ? `✅ ${t('model.auto')}`
        : t('model.auto');
    rows.push([Markup.button.callback(autoLabel, 'model:select:auto')]);
    // Модели из каталога
    for (const m of models) {
        const freeTag = m.is_free ? ` ${t('model.freeBadge')}` : '';
        const label = m.id === currentModelId ? `✅ ${m.name}${freeTag}` : `${m.name}${freeTag}`;
        rows.push([Markup.button.callback(label, `model:select:${m.id}`)]);
    }
    rows.push([Markup.button.callback(t('model.buttons.cancel'), 'model:cancel')]);
    return Markup.inlineKeyboard(rows);
};

const handleModelList = async (ctx: any) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    try {
        const data = await runBackendGetModels(userId);
        if (!data.models.length) {
            await ctx.reply(ctx.t('model.manualUnavailable'));
            return;
        }
        const text = ctx.t('model.select', {
            model: data.preferred_model || ctx.t('model.auto')
        });
        await ctx.reply(text, buildModelListKeyboard(data.models, data.preferred_model, ctx.t));
    } catch {
        await ctx.reply(ctx.t('model.loadError'));
    }
};

const renderPromptCardInteractive = async (ctx: any, user: { selected_prompt_id: number | null; custom_prompt_content?: string | null }, prompt: PromptRecord) => {
    const currentPromptId = user.selected_prompt_id === CUSTOM_PROMPT_ID
        ? CUSTOM_PROMPT_ID
        : (await resolvePromptForUser(ctx.state.accountId)).id;
    const selected = prompt.id === currentPromptId;
    const defaultMark = prompt.is_default ? ctx.t('prompt.cardDefaultMark') : '';
    const selectedMark = selected ? ctx.t('prompt.cardSelectedMark') : '';
    const text = ctx.t('prompt.card', {
        name: prompt.name,
        defaultMark,
        selectedMark,
        description: getPromptDescriptionForDisplay(prompt, ctx.t)
    });
    return ctx.editMessageText(text, buildPromptCardKeyboard(prompt.id, selected, ctx.t));
};

const renderCustomPromptCardInteractive = async (
    ctx: any,
    user: { selected_prompt_id: number | null; custom_prompt_content?: string | null },
    mode: 'reply' | 'edit' = 'edit'
) => {
    const isSelected = user.selected_prompt_id === CUSTOM_PROMPT_ID;
    const hasCustomPrompt = !!(user.custom_prompt_content || '').trim();
    const selectedMark = isSelected ? ctx.t('prompt.cardSelectedMark') : '';
    const body = getCustomPromptPreview(user.custom_prompt_content, ctx.t, 500);
    const text = ctx.t('prompt.customCard', {
        name: ctx.t('prompt.customName'),
        selectedMark,
        limit: MAX_CUSTOM_PROMPT_LENGTH,
        body
    });
    const keyboard = buildCustomPromptCardKeyboard(isSelected, hasCustomPrompt, ctx.t);
    if (mode === 'edit') return ctx.editMessageText(text, keyboard);
    return ctx.reply(text, keyboard);
};

const parsePipeParts = (text: string) => {
    const raw = text.replace(/^\/\S+\s*/, '').trim();
    const parts = raw.split('|').map(part => part.trim()).filter(Boolean);
    if (!parts.length) return null;
    return parts;
};

const getUserDisplayName = (user: { name: string | null; telegram_username: string | null; id: number }) => {
    if (user.name && user.name.trim()) return user.name.trim();
    if (user.telegram_username && user.telegram_username.trim()) return `@${user.telegram_username.trim()}`;
    return `ID ${user.id}`;
};

const getPlanLabel = (plan: UserPlan) => PLAN_LABELS[plan] || PLAN_LABELS[DEFAULT_USER_PLAN];
const getContextWindowText = (user: UserRecord) => {
    const effective = resolveMaxContextTokens(user);
    const hardLimit = (user.max_context_tokens_limit ?? 0) > 0
        ? Math.floor(user.max_context_tokens_limit!) : getPlanMaxContextTokens(parsePlanFromDb(user.plan));
    return `${(effective / 1000).toFixed(0)}k/${(hardLimit / 1000).toFixed(0)}k`;
};
const getDailyWebSearchLimitText = (user: UserRecord) => {
    const limit = normalizeDailyWebSearchLimit(user.daily_web_search_limit);
    return `${user.daily_web_search_count ?? 0}/${limit}`;
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

const buildPendingListKeyboard = (rows: PendingUserRow[], page: number, total: number, t: BotTranslate) => {
    const keyboardRows = rows.map(row => [Markup.button.callback(
        `👤 ${getUserDisplayName(row)} (#${row.id})`,
        `mod:pv:${row.id}:${page}`
    )]);

    const navRow = [];
    if (page > 0) navRow.push(Markup.button.callback(t('admin.buttons.previous'), `mod:pp:${page - 1}`));
    if ((page + 1) * PAGE_SIZE < total) navRow.push(Markup.button.callback(t('admin.buttons.next'), `mod:pp:${page + 1}`));
    if (navRow.length) keyboardRows.push(navRow);

    keyboardRows.push([Markup.button.callback(t('admin.buttons.refresh'), `mod:pp:${page}`)]);
    return Markup.inlineKeyboard(keyboardRows);
};

const buildAdminUsersListKeyboard = (rows: UserRecord[], page: number, total: number, noteStatsMap: Map<number, NoteStatsRecord>, t: BotTranslate) => {
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
    if (page > 0) navRow.push(Markup.button.callback(t('admin.buttons.previous'), `usr:list:${page - 1}`));
    if ((page + 1) * PAGE_SIZE < total) navRow.push(Markup.button.callback(t('admin.buttons.next'), `usr:list:${page + 1}`));
    if (navRow.length) keyboardRows.push(navRow);

    keyboardRows.push([Markup.button.callback(t('admin.buttons.refresh'), `usr:list:${page}`)]);
    return Markup.inlineKeyboard(keyboardRows);
};

const buildAdminUserCardKeyboard = (user: UserRecord, page: number, t: BotTranslate) => {
    const moderationButton = user.status === 'banned'
        ? Markup.button.callback(t('admin.buttons.unban'), `usr:unban:${user.id}:${page}`)
        : Markup.button.callback(t('admin.buttons.ban'), `usr:ban:${user.id}:${page}`);

    return Markup.inlineKeyboard([
        [Markup.button.callback(t('admin.buttons.message'), `ai_send:${user.id}`)],
        [Markup.button.callback(t('admin.buttons.changePlan'), `usr:plan:open:${user.id}:${page}`)],
        [Markup.button.callback(t('admin.buttons.changeContext'), `usr:ctx:ask:${user.id}:${page}`)],
        [moderationButton],
        [Markup.button.callback(t('admin.buttons.delete'), `usr:remove:${user.id}:${page}`)],
        [Markup.button.callback(t('admin.buttons.toList'), `usr:list:${page}`)]
    ]);
};
const buildAdminPlanChoiceKeyboard = (userId: number, page: number, t: BotTranslate) => Markup.inlineKeyboard([
    [Markup.button.callback(t('generated.freePlanButton', { value: PLAN_MAX_CONTEXT_TOKENS.free / 1000, free: PLAN_DAILY_WEB_SEARCH_LIMITS.free }), `usr:plan:pick:${userId}:${page}:free`)],
    [Markup.button.callback(t('generated.standardPlanButton', { value: PLAN_MAX_CONTEXT_TOKENS.standart / 1000, standart: PLAN_DAILY_WEB_SEARCH_LIMITS.standart }), `usr:plan:pick:${userId}:${page}:standart`)],
    [Markup.button.callback(t('generated.proPlanButton', { value: PLAN_MAX_CONTEXT_TOKENS.pro / 1000, pro: PLAN_DAILY_WEB_SEARCH_LIMITS.pro }), `usr:plan:pick:${userId}:${page}:pro`)],
    [Markup.button.callback(t('admin.buttons.backToUser'), `usr:view:${userId}:${page}`)]
]);
const buildAdminPlanDurationKeyboard = (userId: number, page: number, plan: UserPlan, t: BotTranslate) => Markup.inlineKeyboard([
    [
        Markup.button.callback(t('admin.durations.day'), `usr:plan:dur:${userId}:${page}:${plan}:day`),
        Markup.button.callback(t('admin.durations.week'), `usr:plan:dur:${userId}:${page}:${plan}:week`)
    ],
    [
        Markup.button.callback(t('admin.durations.month'), `usr:plan:dur:${userId}:${page}:${plan}:month`),
        Markup.button.callback(t('admin.durations.year'), `usr:plan:dur:${userId}:${page}:${plan}:year`)
    ],
    [Markup.button.callback(t('admin.durations.forever'), `usr:plan:dur:${userId}:${page}:${plan}:forever`)],
    [Markup.button.callback(t('admin.buttons.backToPlan'), `usr:plan:open:${userId}:${page}`)]
]);

const buildPendingCardKeyboard = (userId: number, page: number, t: BotTranslate) => Markup.inlineKeyboard([
    [
        Markup.button.callback(t('admin.buttons.approve'), `mod:ok:${userId}:${page}`),
        Markup.button.callback(t('admin.buttons.reject'), `mod:no:${userId}:${page}`)
    ],
    [Markup.button.callback(t('admin.buttons.ban'), `mod:ban:${userId}:${page}`)],
    [Markup.button.callback(t('admin.buttons.toRequests'), `mod:pp:${page}`)]
]);

const buildBannedListKeyboard = (rows: BannedUserRow[], page: number, total: number, t: BotTranslate) => {
    const keyboardRows = rows.map(row => [Markup.button.callback(
        `⛔ ${getUserDisplayName(row)} (#${row.id})`,
        `mod:bv:${row.id}:${page}`
    )]);

    const navRow = [];
    if (page > 0) navRow.push(Markup.button.callback(t('admin.buttons.previous'), `mod:bp:${page - 1}`));
    if ((page + 1) * PAGE_SIZE < total) navRow.push(Markup.button.callback(t('admin.buttons.next'), `mod:bp:${page + 1}`));
    if (navRow.length) keyboardRows.push(navRow);

    keyboardRows.push([Markup.button.callback(t('admin.buttons.refresh'), `mod:bp:${page}`)]);
    return Markup.inlineKeyboard(keyboardRows);
};

const buildBannedCardKeyboard = (userId: number, page: number, t: BotTranslate) => Markup.inlineKeyboard([
    [Markup.button.callback(t('admin.buttons.unblock'), `mod:unban:${userId}:${page}`)],
    [Markup.button.callback(t('admin.buttons.toBans'), `mod:bp:${page}`)]
]);

const renderAdminUsersList = async (ctx: any, page: number, mode: 'reply' | 'edit' = 'reply') => {
    const safePage = Math.max(0, page);
    const data = await runBackendGetUsersList('all', PAGE_SIZE, safePage * PAGE_SIZE);
    const total = data.total;
    if (!total) {
        if (mode === 'edit') return ctx.editMessageText(ctx.t('admin.usersNone'));
        return ctx.reply(ctx.t('admin.usersNone'));
    }

    const rows = data.users;
    const noteStatsMap = await runBackendGetNoteStatsForUsers(ctx.state.accountId, rows.map(r => r.id));
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const text = ctx.t('admin.usersList', { page: safePage + 1, pages, total });
    const keyboard = buildAdminUsersListKeyboard(rows, safePage, total, noteStatsMap, ctx.t);
    if (mode === 'edit') return ctx.editMessageText(text, keyboard);
    return ctx.reply(text, keyboard);
};

const renderAdminUserCard = async (ctx: any, user: UserRecord, page: number, mode: 'reply' | 'edit' = 'edit') => {
    const prompt = await resolvePromptForUser(user.id);
    const ban = user.status === 'banned' ? (await runBackendGetBanRecord(user.id)).ban : undefined;
    const plan = parsePlanFromDb(user.plan);
    const notesStats = await runBackendGetNoteStats(user.id);
    const subscription = await runBackendGetUserSubscription(user.id);
    const subscriptionEnds = subscription?.ends_at || ctx.t('admin.forever');
    const text = ctx.t('admin.userCard', {
        id: user.id, name: user.name ?? ctx.t('admin.notSpecified'),
        username: user.telegram_username ? `@${user.telegram_username}` : ctx.t('admin.noneValue'),
        role: user.role === 'admin' ? ctx.t('roles.admin') : ctx.t('roles.user'),
        status: ctx.t(`admin.statuses.${user.status}`), plan: getPlanLabel(plan), subscriptionEnds,
        context: getContextWindowText(user),
        webLimit: getDailyWebSearchLimitText(user), imagesDaily: `${user.daily_image_gen_count ?? 0}/${user.daily_image_gen_limit ?? 0}`,
        prompt: `#${prompt.id} ${prompt.id === CUSTOM_PROMPT_ID ? ctx.t('prompt.customName') : prompt.name}${prompt.is_default ? ctx.t('prompt.currentDefaultMark') : ''}`,
        messagesToday: user.daily_message_count ?? 0, tokensToday: user.daily_tokens_used ?? 0,
        costToday: formatRub(user.daily_cost_rub ?? 0), webToday: user.daily_web_search_count ?? 0,
        tokensTotal: user.total_tokens_used ?? 0, costTotal: formatRub(user.total_cost_rub ?? 0),
        webTotal: user.total_web_search_count ?? 0, imagesTotal: user.total_image_gen_count ?? 0,
        notes: notesStats.notes_count, noteChars: notesStats.notes_chars,
        totalChars: user.total_message_length ?? 0,
        banLine: ban ? ctx.t('admin.banLine', { reason: ban.reason }) : ''
    }).trim();
    const keyboard = buildAdminUserCardKeyboard(user, page, ctx.t);
    if (mode === 'edit') return ctx.editMessageText(text, keyboard);
    return ctx.reply(text, keyboard);
};
const renderAdminPlanChoiceCard = async (ctx: any, user: UserRecord, page: number, mode: 'reply' | 'edit' = 'edit') => {
    const plan = parsePlanFromDb(user.plan);
    const text = ctx.t('admin.planChoice', { id: user.id, plan: getPlanLabel(plan), context: getContextWindowText(user) });
    const keyboard = buildAdminPlanChoiceKeyboard(user.id, page, ctx.t);
    if (mode === 'edit') return ctx.editMessageText(text, keyboard);
    return ctx.reply(text, keyboard);
};
const renderAdminPlanDurationCard = async (ctx: any, user: UserRecord, page: number, plan: UserPlan, mode: 'reply' | 'edit' = 'edit') => {
    const text = ctx.t('admin.planDuration', { id: user.id, plan: getPlanLabel(plan), context: PLAN_MAX_CONTEXT_TOKENS[plan] / 1000, web: PLAN_DAILY_WEB_SEARCH_LIMITS[plan] });
    const keyboard = buildAdminPlanDurationKeyboard(user.id, page, plan, ctx.t);
    if (mode === 'edit') return ctx.editMessageText(text, keyboard);
    return ctx.reply(text, keyboard);
};

const renderPendingList = async (ctx: any, page: number, mode: 'reply' | 'edit' = 'reply') => {
    const safePage = Math.max(0, page);
    const data = await runBackendGetUsersList('pending', PAGE_SIZE, safePage * PAGE_SIZE);
    const total = data.total;
    if (!total) {
        if (mode === 'edit') return ctx.editMessageText(ctx.t('admin.requestsNone'));
        return ctx.reply(ctx.t('admin.requestsNone'));
    }

    const rows = data.users as unknown as PendingUserRow[];
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const header = ctx.t('admin.requestsList', { page: safePage + 1, pages, total });
    const keyboard = buildPendingListKeyboard(rows, safePage, total, ctx.t);
    if (mode === 'edit') return ctx.editMessageText(header, keyboard);
    return ctx.reply(header, keyboard);
};

const renderPendingCard = async (ctx: any, user: UserRecord, page: number, mode: 'reply' | 'edit' = 'edit') => {
    const username = user.telegram_username ? `@${user.telegram_username}` : ctx.t('admin.noneValue');
    const text = ctx.t('admin.requestCard', { id: user.id, name: user.name ?? ctx.t('admin.notSpecified'), username, status: ctx.t(`admin.statuses.${user.status}`) });
    const keyboard = buildPendingCardKeyboard(user.id, page, ctx.t);
    if (mode === 'edit') return ctx.editMessageText(text, keyboard);
    return ctx.reply(text, keyboard);
};

const renderBannedList = async (ctx: any, page: number, mode: 'reply' | 'edit' = 'reply') => {
    const safePage = Math.max(0, page);
    const data = await runBackendGetUsersList('banned', PAGE_SIZE, safePage * PAGE_SIZE);
    const total = data.total;
    if (!total) {
        if (mode === 'edit') return ctx.editMessageText(ctx.t('admin.bansNone'));
        return ctx.reply(ctx.t('admin.bansNone'));
    }

    const rows = data.users as unknown as BannedUserRow[];
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const header = ctx.t('admin.bansList', { page: safePage + 1, pages, total });
    const keyboard = buildBannedListKeyboard(rows, safePage, total, ctx.t);
    if (mode === 'edit') return ctx.editMessageText(header, keyboard);
    return ctx.reply(header, keyboard);
};

const renderBannedCard = async (ctx: any, user: UserRecord, page: number, mode: 'reply' | 'edit' = 'edit') => {
    const ban = (await runBackendGetBanRecord(user.id)).ban;
    const text = ctx.t('admin.banCard', { id: user.id, name: user.name ?? ctx.t('admin.notSpecified'), username: user.telegram_username ? `@${user.telegram_username}` : ctx.t('admin.noneValue'), reason: ban?.reason ?? ctx.t('access.noReason'), date: ban?.banned_at ?? ctx.t('common.unknown') });
    const keyboard = buildBannedCardKeyboard(user.id, page, ctx.t);
    if (mode === 'edit') return ctx.editMessageText(text, keyboard);
    return ctx.reply(text, keyboard);
};

const approveUserAccess = async (targetUserId: number) => {
    const user = await getUser(targetUserId);
    if (!user) return false;
    await updateUserStatus(targetUserId, 'approved');
    if (!user.selected_prompt_id) {
        const defaultPrompt = await runBackendGetDefaultPrompt();
        if (defaultPrompt) await updateUserPrompt(targetUserId, defaultPrompt.id);
    }
    return true;
};

const disapproveUserAccess = async (targetUserId: number) => {
    const user = await getUser(targetUserId);
    if (!user) return false;
    await updateUserStatus(targetUserId, 'disapproved');
    return true;
};

const banUserAccess = async (targetUserId: number, bannedBy: number, reason: string) => {
    const user = await getUser(targetUserId);
    if (!user) return false;
    await runBackendBanUser(targetUserId, bannedBy, reason);
    return true;
};

const unbanUserAccess = async (targetUserId: number) => {
    const user = await getUser(targetUserId);
    if (!user) return false;
    await runBackendUnbanUser(targetUserId);
    return true;
};

const notifyAdminsNewRequest = async (user: UserRecord) => {
    let admins: UserRecord[] = [];
    try {
        admins = await getDatabaseTelegramAdmins();
    } catch (err) {
        console.warn('Не удалось получить список администраторов из БД:', formatSafeError(err));
        return;
    }

    if (!admins.length) {
        console.warn('В БД нет подтверждённых администраторов: заявка не была отправлена.');
    }

    for (const admin of admins) {
        try {
            const t = (key: string, options?: Record<string, unknown>) => translateBot(admin.language, key, options);
            const usernameText = user.telegram_username ? `@${user.telegram_username}` : t('admin.noneValue');
            const text = t('admin.newRequestNotification', {
                id: user.id,
                profile: user.telegram_id ? `tg://user?id=${user.telegram_id}` : '',
                name: user.name ?? t('admin.notSpecified'),
                username: usernameText
            });
            const keyboard = Markup.inlineKeyboard([
                [
                    Markup.button.callback(t('admin.buttons.approve'), `mod:ok:${user.id}:0`),
                    Markup.button.callback(t('admin.buttons.reject'), `mod:no:${user.id}:0`)
                ],
                [Markup.button.callback(t('admin.buttons.ban'), `mod:ban:${user.id}:0`)]
            ]);
            await bot.telegram.sendMessage(admin.telegram_id!, text, keyboard);
        } catch (err) {
            console.warn(`Не удалось отправить заявку админу ${admin.id}`);
        }
    }
};

bot.command('start', async (ctx) => {
    await ctx.reply(ctx.t('menu.pinned'), buildMenuTriggerKeyboard(ctx.t));
    return showMenu(ctx);
});
bot.command('menu', async (ctx) => { await showMenu(ctx); });
bot.hears(MAIN_MENU_TRIGGER_BUTTONS, async (ctx) => { await showMenu(ctx); });

bot.command('prompts', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;

    const user = await getUser(userId);
    if (!user) return ctx.reply(ctx.t('common.userMissing'));

    if (ctx.state.role !== 'admin') {
        return renderPromptListInteractive(ctx, user, 'reply');
    }

    try {
        const data = await runBackendGetPrompts();
        const prompts = data.prompts;
        const lines = prompts.map(p => {
            const marker = p.is_default ? ctx.t('prompt.cardDefaultMark') : '';
            const selected = user.selected_prompt_id === p.id
                ? ctx.t('prompt.adminSelectedMark')
                : '';
            return `#${p.id} ${p.name}${marker}${selected}: ${normalizeTextPreview(getPromptDescriptionForDisplay(p, ctx.t), 80)}`;
        }).join('\n');
        return ctx.reply(ctx.t('prompt.adminList', {
            lines: lines || ctx.t('prompt.none')
        }));
    } catch {
        return ctx.reply(ctx.t('prompt.apiError'));
    }
});

bot.command('prompt_use', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const promptId = Number.parseInt(parts[1], 10);
    if (!promptId || Number.isNaN(promptId)) return ctx.reply(ctx.t('prompt.useFormat'));

    const user = await getUser(userId);
    if (!user) return ctx.reply(ctx.t('common.userMissing'));

    try {
        const data = await runBackendGetPrompt(promptId);
        await runBackendSelectUserPrompt(userId, promptId);
        return ctx.reply(ctx.t('prompt.selectedNamed', { name: data.prompt.name }));
    } catch {
        return ctx.reply(ctx.t('prompt.notFoundId', { id: promptId }));
    }
});

bot.command('prompt_add', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply(ctx.t('common.adminOnly'));

    const parts = parsePipeParts(ctx.message.text);
    if (!parts || parts.length < 3) return ctx.reply(ctx.t('adminPrompt.addFormat'));

    const [name, description, ...contentParts] = parts;
    const content = contentParts.join(' | ').trim();
    if (!content) return ctx.reply(ctx.t('adminPrompt.contentEmpty'));

    try {
        const result = await runBackendCreatePrompt(ctx.state.accountId, name, description, content);
        return ctx.reply(ctx.t('adminPrompt.added', { name, id: result.prompt_id }));
    } catch (err: any) {
        if (axios.isAxiosError(err) && err.response?.data?.error === 'name_already_exists') {
            return ctx.reply(ctx.t('adminPrompt.nameTakenAdd'));
        }
        return ctx.reply(ctx.t('adminPrompt.addError'));
    }
});

bot.command('prompt_show', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply(ctx.t('common.adminOnly'));

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const promptId = Number.parseInt(parts[1], 10);
    if (!promptId || Number.isNaN(promptId)) return ctx.reply(ctx.t('adminPrompt.showFormat'));

    try {
        const data = await runBackendGetPrompt(promptId);
        const p = data.prompt;
        const defaultMark = p.is_default ? ctx.t('prompt.cardDefaultMark') : '';
        const text = ctx.t('adminPrompt.show', { id: p.id, name: p.name, defaultMark, description: getPromptDescriptionForDisplay(p, ctx.t), content: p.content });
        return ctx.reply(text);
    } catch {
        return ctx.reply(ctx.t('prompt.notFoundId', { id: promptId }));
    }
});

bot.command('prompt_set', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply(ctx.t('common.adminOnly'));

    const parts = parsePipeParts(ctx.message.text);
    if (!parts || parts.length < 2) return ctx.reply(ctx.t('adminPrompt.setFormat'));

    const promptId = Number.parseInt(parts[0], 10);
    if (!promptId || Number.isNaN(promptId)) return ctx.reply(ctx.t('adminPrompt.setInvalidId'));
    const content = parts.slice(1).join(' | ').trim();
    if (!content) return ctx.reply(ctx.t('adminPrompt.newContentEmpty'));

    try {
        const data = await runBackendGetPrompt(promptId);
        await runBackendUpdatePromptContent(ctx.state.accountId, promptId, content);
        return ctx.reply(ctx.t('adminPrompt.contentUpdated', { name: data.prompt.name }));
    } catch {
        return ctx.reply(ctx.t('prompt.notFoundId', { id: promptId }));
    }
});

bot.command('prompt_desc', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply(ctx.t('common.adminOnly'));

    const parts = parsePipeParts(ctx.message.text);
    if (!parts || parts.length < 2) return ctx.reply(ctx.t('adminPrompt.descFormat'));

    const promptId = Number.parseInt(parts[0], 10);
    if (!promptId || Number.isNaN(promptId)) return ctx.reply(ctx.t('adminPrompt.descInvalidId'));
    const description = parts.slice(1).join(' | ').trim();
    if (!description) return ctx.reply(ctx.t('adminPrompt.descriptionEmpty'));

    try {
        const data = await runBackendGetPrompt(promptId);
        await runBackendUpdatePromptDescription(ctx.state.accountId, promptId, description);
        return ctx.reply(ctx.t('adminPrompt.descriptionUpdated', { name: data.prompt.name }));
    } catch {
        return ctx.reply(ctx.t('prompt.notFoundId', { id: promptId }));
    }
});

bot.command('prompt_rename', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply(ctx.t('common.adminOnly'));

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const promptId = Number.parseInt(parts[1], 10);
    const newName = parts.slice(2).join(' ').trim();

    if (!promptId || Number.isNaN(promptId)) return ctx.reply(ctx.t('adminPrompt.renameFormat'));
    if (!newName) return ctx.reply(ctx.t('adminPrompt.renameFormat'));

    try {
        const data = await runBackendGetPrompt(promptId);
        await runBackendUpdatePromptName(ctx.state.accountId, promptId, newName);
        return ctx.reply(ctx.t('adminPrompt.renamed', { oldName: data.prompt.name, newName }));
    } catch (err: any) {
        if (axios.isAxiosError(err) && err.response?.data?.error === 'name_already_exists') {
            return ctx.reply(ctx.t('adminPrompt.nameTakenRename'));
        }
        return ctx.reply(ctx.t('prompt.notFoundId', { id: promptId }));
    }
});

bot.command('prompt_default', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply(ctx.t('common.adminOnly'));

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const promptId = Number.parseInt(parts[1], 10);
    if (!promptId || Number.isNaN(promptId)) return ctx.reply(ctx.t('adminPrompt.defaultFormat'));

    try {
        const data = await runBackendGetPrompt(promptId);
        await runBackendSetDefaultPrompt(ctx.state.accountId, promptId);
        return ctx.reply(ctx.t('adminPrompt.defaultUpdated', { name: data.prompt.name }));
    } catch {
        return ctx.reply(ctx.t('prompt.notFoundId', { id: promptId }));
    }
});

bot.command('prompt_delete', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply(ctx.t('common.adminOnly'));

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const promptId = Number.parseInt(parts[1], 10);
    if (!promptId || Number.isNaN(promptId)) return ctx.reply(ctx.t('adminPrompt.deleteFormat'));

    try {
        const data = await runBackendGetPrompt(promptId);
        const name = data.prompt.name;
        await runBackendDeletePrompt(ctx.state.accountId, promptId);
        return ctx.reply(ctx.t('adminPrompt.deleted', { name }));
    } catch (err: any) {
        if (axios.isAxiosError(err)) {
            const code = err.response?.data?.error;
            if (code === 'cannot_delete_last_prompt') return ctx.reply(ctx.t('adminPrompt.cannotDeleteLast'));
            if (code === 'cannot_delete_default_prompt') return ctx.reply(ctx.t('adminPrompt.cannotDeleteDefault'));
        }
        return ctx.reply(ctx.t('prompt.notFoundId', { id: promptId }));
    }
});

// Команда добавления пользователя (только для админов)
bot.command('add', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply(ctx.t('common.adminOnly'));

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const newUserId = Number.parseInt(parts[1], 10);
    const newUserName = parts.slice(2).join(' ') || ctx.t('admin.unnamed');

    if (!newUserId || Number.isNaN(newUserId)) return ctx.reply(ctx.t('admin.addFormat'));

    const newUser = await addUser(newUserId, newUserName, 'user', 'approved', null);
    await runBackendUnbanUser(newUser.id);
    await updateUserStatus(newUser.id, 'approved');
    ctx.reply(ctx.t('admin.userAdded', { name: newUserName, id: newUser.id }));
});

// Команда удаления пользователя (только для админов)
bot.command('remove', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply(ctx.t('common.adminOnly'));

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const targetUserId = Number.parseInt(parts[1], 10);

    if (!targetUserId || Number.isNaN(targetUserId)) return ctx.reply(ctx.t('admin.removeFormat'));
    const targetUser = await getUser(targetUserId);
    if (!targetUser) return ctx.reply(ctx.t('admin.userNotFoundId', { id: targetUserId }));
    if (targetUser.role === 'admin') return ctx.reply(ctx.t('admin.cannotDeleteAdminDb'));

    await removeUser(targetUserId);
    ctx.reply(ctx.t('admin.userRemoved', { name: targetUser.name ?? ctx.t('admin.unnamed'), id: targetUserId }));
});

bot.command('ban', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply(ctx.t('common.adminOnly'));
    const adminId = ctx.state.accountId;
    if (!adminId) return;

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const targetUserId = Number.parseInt(parts[1], 10);
    if (!targetUserId || Number.isNaN(targetUserId)) return ctx.reply(ctx.t('admin.banFormat'));
    const targetUser = await getUser(targetUserId);
    if (!targetUser) return ctx.reply(ctx.t('admin.userNotFoundId', { id: targetUserId }));
    if (targetUser.role === 'admin') return ctx.reply(ctx.t('admin.cannotBanAdminDb'));

    const reason = parts.slice(2).join(' ').trim() || ctx.t('admin.defaultBanReason');
    await banUserAccess(targetUserId, adminId, reason);
    ctx.reply(ctx.t('admin.userBanned', { name: targetUser.name ?? ctx.t('admin.unnamed'), id: targetUserId }));

});

bot.command('unban', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply(ctx.t('common.adminOnly'));

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const targetUserId = Number.parseInt(parts[1], 10);
    if (!targetUserId || Number.isNaN(targetUserId)) return ctx.reply(ctx.t('admin.unbanFormat'));

    const targetUser = await getUser(targetUserId);
    if (!targetUser) return ctx.reply(ctx.t('admin.userNotFoundId', { id: targetUserId }));
    if (targetUser.status !== 'banned') return ctx.reply(ctx.t('admin.notBanned'));

    await unbanUserAccess(targetUserId);
    ctx.reply(ctx.t('admin.userUnbanned', { name: targetUser.name ?? ctx.t('admin.unnamed'), id: targetUserId }));

});

// Команда смены имени
bot.command('rename', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const isAdmin = ctx.state.role === 'admin';

    if (!isAdmin) {
        return startSelfRenameFlow(ctx);
    }

    if (parts.length < 2) {
        return ctx.reply(isAdmin ? ctx.t('admin.renameFormat') : ctx.t('profile.renameFormat'));
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
        return ctx.reply(isAdmin ? ctx.t('admin.renameRequired') : ctx.t('profile.renameRequired'));
    }

    const targetUser = await getUser(targetUserId);
    if (!targetUser) return ctx.reply(ctx.t('admin.userNotFoundId', { id: targetUserId }));

    await updateUserName(targetUserId, newUserName);

    if (targetUserId === userId) {
        ctx.state.userName = newUserName;
        return ctx.reply(ctx.t('profile.renamed', { name: newUserName }));
    }

    ctx.reply(ctx.t('admin.userRenamed', { id: targetUserId, oldName: targetUser.name ?? ctx.t('admin.unnamed'), newName: newUserName }));
});

// Команда просмотра списка (только для админов)
bot.command('users', (ctx) => {
    if (ctx.state.role !== 'admin') return;
    return renderAdminUsersList(ctx, 0, 'reply');
});

bot.command('sync_plan_limits', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply(ctx.t('common.adminOnly'));
    await syncAllUsersPlanLimits();
    return ctx.reply(ctx.t('admin.planLimitsSynced'));
});

bot.command('reset_counters', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply(ctx.t('common.adminOnly'));
    try {
        await axios.post(`${BACKEND_API_BASE_URL}/internal/reset-daily-counters`, {}, { headers: backendHeaders(), timeout: BACKEND_TIMEOUT_DEFAULT_MS });
        return ctx.reply(ctx.t('admin.countersReset'));
    } catch {
        return ctx.reply(ctx.t('admin.countersResetError'));
    }
});

bot.command('history_user', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply(ctx.t('common.adminOnly'));

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const targetUserId = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return ctx.reply(ctx.t('adminHistory.userFormat'));
    }

    const rawLimit = Number.parseInt(parts[2], 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.max(1, Math.min(20, rawLimit))
        : 10;

    const { messages } = await runBackendGetUserHistory(ctx.state.accountId, targetUserId, limit);
    return ctx.reply(formatRecentHistoryRows(targetUserId, messages, ctx.t));
});

bot.command('history_delete', async (ctx) => {
    if (ctx.state.role !== 'admin') return ctx.reply(ctx.t('common.adminOnly'));

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const targetUserId = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return ctx.reply(ctx.t('adminHistory.deleteFormat'));
    }
    const secondArg = (parts[2] || '').toLowerCase();
    if (!secondArg) {
        return ctx.reply(ctx.t('adminHistory.deleteFormat'));
    }

    if (secondArg === 'user' || secondArg === 'assistant' || secondArg === 'all') {
        const role: ChatRole | 'all' = secondArg;
        const result = await runBackendDeleteUserHistoryByRole(ctx.state.accountId, targetUserId, role);
        if (!result.deleted) {
            return ctx.reply(ctx.t('adminHistory.nothingDeletedRole', { id: targetUserId, role }));
        }
        return ctx.reply(ctx.t('adminHistory.deletedRole', { count: result.deleted, id: targetUserId, role }));
    }

    const messageId = Number.parseInt(secondArg, 10);
    if (!Number.isFinite(messageId) || messageId <= 0) {
        return ctx.reply(ctx.t('adminHistory.invalidMessageId'));
    }

    const mode = (parts[3] || '').toLowerCase();
    let result: { deleted: number };
    if (mode === 'tg') {
        result = await runBackendDeleteUserHistoryMessage(ctx.state.accountId, targetUserId, messageId, 'tg');
        if (!result.deleted) {
            return ctx.reply(ctx.t('adminHistory.notFoundTg', { id: targetUserId, messageId }));
        }
        return ctx.reply(ctx.t('adminHistory.deletedTg', { count: result.deleted, id: targetUserId, messageId }));
    }
    if (mode === 'db') {
        result = await runBackendDeleteUserHistoryMessage(ctx.state.accountId, targetUserId, messageId, 'db');
        if (!result.deleted) {
            return ctx.reply(ctx.t('adminHistory.notFoundDb', { id: targetUserId, messageId }));
        }
        return ctx.reply(ctx.t('adminHistory.deletedDb', { count: result.deleted, id: targetUserId, messageId }));
    }

    result = await runBackendDeleteUserHistoryMessage(ctx.state.accountId, targetUserId, messageId, 'db');
    if (result.deleted) {
        return ctx.reply(ctx.t('adminHistory.deletedDb', { count: result.deleted, id: targetUserId, messageId }));
    }
    const tgResult = await runBackendDeleteUserHistoryMessage(ctx.state.accountId, targetUserId, messageId, 'tg');
    if (tgResult.deleted) {
        return ctx.reply(ctx.t('adminHistory.deletedTg', { count: tgResult.deleted, id: targetUserId, messageId }));
    }
    return ctx.reply(ctx.t('adminHistory.notFoundAny', { id: targetUserId, messageId }));
});

bot.command('clear', (ctx) => {
    return handleClear(ctx);
});

// ── /link — привязка к desktop-аккаунту ──
bot.command('link', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    const userRecord = await getUser(userId);
    if (!userRecord) return ctx.reply(ctx.t('link.askAdminFirst'));
    linkCodeFlows.set(userId, 'await_code');
    return ctx.reply(
        ctx.t('link.instructions'),
        Markup.keyboard([['/cancellink']]).resize().oneTime()
    );
});

bot.command('cancellink', (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    linkCodeFlows.delete(userId);
    return ctx.reply(ctx.t('link.cancelled'), buildMenuTriggerKeyboard(ctx.t));
});

bot.command('unlink', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    unlinkChoiceFlows.set(userId, { expiresAt: Date.now() + 10 * 60 * 1000 });
    return ctx.reply(
        ctx.t('unlink.warning'),
        Markup.inlineKeyboard([
            [Markup.button.callback(ctx.t('unlink.buttons.desktop'), `unlink:desktop:${userId}`)],
            [Markup.button.callback(ctx.t('unlink.buttons.telegram'), `unlink:telegram:${userId}`)],
            [Markup.button.callback(ctx.t('unlink.buttons.cancel'), `unlink:cancel:${userId}`)]
        ])
    );
});

bot.action(/^unlink:(desktop|telegram|cancel):(\d+)$/, async (ctx) => {
    const action = (ctx as any).match[1] as 'desktop' | 'telegram' | 'cancel';
    const ownerAccountId = Number.parseInt((ctx as any).match[2], 10);
    const userId = ctx.state.accountId;

    if (!userId || userId !== ownerAccountId) {
        await ctx.answerCbQuery(ctx.t('unlink.wrongUser'));
        return;
    }

    const pending = unlinkChoiceFlows.get(userId);
    if (!pending || pending.expiresAt <= Date.now()) {
        unlinkChoiceFlows.delete(userId);
        await ctx.answerCbQuery(ctx.t('unlink.expiredCallback'));
        await ctx.editMessageText(ctx.t('unlink.expired')).catch(() => {});
        return;
    }

    unlinkChoiceFlows.delete(userId);
    if (action === 'cancel') {
        await ctx.answerCbQuery(ctx.t('unlink.cancelledCallback'));
        await ctx.editMessageText(ctx.t('unlink.cancelled')).catch(() => {});
        return;
    }

    await ctx.answerCbQuery(ctx.t('unlink.processingCallback'));
    await ctx.editMessageText(ctx.t('unlink.processing')).catch(() => {});

    try {
        const response = await axios.post(
            `${BACKEND_API_BASE_URL}/internal/link/unlink`,
            { tg_id: ctx.state.telegramId, data_owner: action },
            {
                headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` },
                timeout: 30000
            }
        );

        if (!response.data?.ok) {
            await ctx.editMessageText(ctx.t('unlink.failed')).catch(() => {});
            return;
        }

        const ownerText = action === 'telegram'
            ? ctx.t('unlink.successTelegram')
            : ctx.t('unlink.successDesktop');
        await ctx.editMessageText(ctx.t('unlink.success', { details: ownerText })).catch(() => {});
    } catch (err: any) {
        const msg = err?.response?.data?.error;
        if (msg === 'not_linked') {
            await ctx.editMessageText(ctx.t('unlink.notLinked')).catch(() => {});
            return;
        }
        if (msg === 'password_identity_required') {
            await ctx.editMessageText(ctx.t('unlink.passwordRequired')).catch(() => {});
            return;
        }
        console.error('Unlink error:', formatSafeError(err));
        await ctx.editMessageText(ctx.t('unlink.confirmationError')).catch(() => {});
    }
});

// ── /recover_desktop — recover desktop login & generate new password ──────
// Two-step flow: command/button → confirmation dialog → actual password
// rotation. Mirrors the unlink flow: an inline YES/NO keyboard so the user
// must explicitly confirm before sessions are revoked.

const startRecoverDesktopConfirm = async (ctx: any) => {
    const userId = ctx.state.accountId;
    if (!userId) return;

    // Rate-limit the *start* of the flow too, so a user cannot spam the
    // button and create endless confirmation dialogs.
    const nowSec = Math.floor(Date.now() / 1000);
    const lastUsed = recoverDesktopCooldowns.get(userId);
    if (lastUsed && nowSec - lastUsed < RECOVER_DESKTOP_COOLDOWN_SEC) {
        const waitSec = RECOVER_DESKTOP_COOLDOWN_SEC - (nowSec - lastUsed);
        return ctx.reply(ctx.t('recover.rateLimited', { seconds: waitSec }));
    }

    recoverDesktopConfirmFlows.set(userId, { expiresAt: Date.now() + RECOVER_DESKTOP_CONFIRM_TTL_MS });
    return ctx.reply(
        ctx.t('recover.confirm'),
        Markup.inlineKeyboard([
            [Markup.button.callback(ctx.t('recover.buttons.yes'), `recover:yes:${userId}`)],
            [Markup.button.callback(ctx.t('recover.buttons.no'), `recover:no:${userId}`)]
        ])
    );
};

const executeRecoverDesktop = async (ctx: any) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    const t = ctx.t;

    // Apply the rate limit now (actual rotation). Also prune stale entries.
    const nowSec = Math.floor(Date.now() / 1000);
    if (recoverDesktopCooldowns.size > 1000) {
        for (const [key, ts] of recoverDesktopCooldowns) {
            if (nowSec - ts > RECOVER_DESKTOP_COOLDOWN_SEC * 2) recoverDesktopCooldowns.delete(key);
        }
    }
    recoverDesktopCooldowns.set(userId, nowSec);

    try {
        // Fetch account identities to check if password identity exists
        const userRes = await axios.get(
            `${BACKEND_API_BASE_URL}/internal/users/${userId}`,
            { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` }, timeout: 10_000 }
        );
        const identities: Array<{ provider: string; provider_subject: string; username: string | null }> =
            userRes.data?.user?.identities || [];
        const passwordIdentity = identities.find((i: any) => i.provider === 'password');
        if (!passwordIdentity) {
            return ctx.reply(t('recover.noDesktopAccount'));
        }

        // Generate a new password via backend (also sets must_change_password=1)
        const passwordRes = await axios.post(
            `${BACKEND_API_BASE_URL}/internal/admin/users/${userId}/generate-password`,
            {},
            { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` }, timeout: 10_000 }
        );
        const newPassword = passwordRes.data?.new_password;
        if (!newPassword) {
            return ctx.reply(t('recover.error'));
        }

        const login = passwordIdentity.provider_subject;

        // Send login first, then the new password
        await ctx.reply(t('recover.loginMessage', { login }));
        await ctx.reply(t('recover.passwordMessage', { password: newPassword }));
        await ctx.reply(t('recover.loginInstructions'));

    } catch (err: any) {
        if (err?.response?.data?.error === 'no_password_identity') {
            return ctx.reply(t('recover.noDesktopAccount'));
        }
        console.error('recover_desktop error:', formatSafeError(err));
        return ctx.reply(t('recover.error'));
    }
};

bot.command('recover_desktop', async (ctx) => {
    await startRecoverDesktopConfirm(ctx);
});

// Confirmation callback handler. Mirrors the unlink flow: payload includes
// the owner account id so a stale callback from another user can't fire.
bot.action(/^recover:(yes|no):(\d+)$/, async (ctx) => {
    const choice = (ctx as any).match[1] as 'yes' | 'no';
    const ownerAccountId = Number.parseInt((ctx as any).match[2], 10);
    const userId = ctx.state.accountId;

    if (!userId || userId !== ownerAccountId) {
        await ctx.answerCbQuery(ctx.t('recover.wrongUser'));
        return;
    }

    const pending = recoverDesktopConfirmFlows.get(userId);
    if (!pending || pending.expiresAt <= Date.now()) {
        recoverDesktopConfirmFlows.delete(userId);
        await ctx.answerCbQuery(ctx.t('recover.expiredCallback'));
        await ctx.editMessageText(ctx.t('recover.expired')).catch(() => {});
        return;
    }
    recoverDesktopConfirmFlows.delete(userId);

    if (choice === 'no') {
        await ctx.answerCbQuery(ctx.t('recover.cancelledCallback'));
        await ctx.editMessageText(ctx.t('recover.cancelled')).catch(() => {});
        return;
    }

    // Confirmed — rotate the password and reply with credentials.
    await ctx.answerCbQuery();
    await ctx.editMessageText(ctx.t('recover.inProgress')).catch(() => {});
    await executeRecoverDesktop(ctx);
});

bot.command('tz', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;

    const offset = Number.parseInt(ctx.message.text.split(' ')[1], 10);
    if (Number.isNaN(offset) || offset < -12 || offset > 14) {
        return ctx.reply(ctx.t('timezone.usage'));
    }

    try {
        await runBackendSetTimezone(userId, offset);
    } catch {
        return ctx.reply(ctx.t('timezone.error'));
    }
    timezoneSetupFlows.delete(userId);
    const sign = offset >= 0 ? '+' : '';
    return ctx.reply(ctx.t('timezone.changed', { offset: `${sign}${offset}` }), buildMenuTriggerKeyboard(ctx.t));
});

bot.command('tasks', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;

    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        return ctx.reply(ctx.t('tasks.noAccess'));
    }

    const tasks = await runBackendGetTasks(userId, 'pending', 20);
    if (!tasks.length) return ctx.reply(ctx.t('tasks.noneActive'));

    const text = ctx.t('tasks.list', {
        count: tasks.length,
        max: MAX_PENDING_TASKS_PER_USER,
        tasks: await formatTasksList(tasks, ctx.t)
    });
    return ctx.reply(text);
});

bot.command('task_delete', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;

    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        return ctx.reply(ctx.t('tasks.noAccess'));
    }

    const taskId = Number.parseInt(ctx.message.text.split(' ')[1], 10);
    if (!taskId || Number.isNaN(taskId)) {
        return ctx.reply(ctx.t('tasks.deleteFormat'));
    }

    const task = await runBackendGetTask(userId, taskId);
    if (!task) return ctx.reply(ctx.t('tasks.notFoundId', { id: taskId }));
    if (task.status !== 'pending') {
        return ctx.reply(ctx.t('tasks.notActive', {
            id: taskId,
            status: ctx.t(`tasks.statuses.${task.status}`)
        }));
    }

    const deleted = await runBackendDeleteTask(userId, taskId);
    if (!deleted) return ctx.reply(ctx.t('tasks.deleteError', { id: taskId }));

    const updated = await runBackendGetTasks(userId, 'pending', 20);
    const updatedText = await formatTasksList(updated, ctx.t, ctx.t('tasks.noneRemaining'));
    return ctx.reply(ctx.t('tasks.deleted', {
        id: taskId,
        count: updated.length,
        max: MAX_PENDING_TASKS_PER_USER,
        tasks: updatedText
    }));
});

bot.command('chats', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        return ctx.reply(ctx.t('chats.noAccess'));
    }

    return renderChatsMenuList(ctx, userId, 0, 'reply');
});

bot.command('chat_new', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        return ctx.reply(ctx.t('chats.noAccess'));
    }

    const titleRaw = extractCommandPayload(ctx.message.text, 'chat_new');
    const title = titleRaw.slice(0, 80).trim();
    const created = await runBackendCreateChat(userId, title || undefined);
    const chatId = created.chat.id;
    return ctx.reply(ctx.t('chats.created', { id: chatId, title: created.chat.title }));
});

bot.command('chat_use', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        return ctx.reply(ctx.t('chats.noAccess'));
    }

    const chatId = Number.parseInt(ctx.message.text.split(' ').filter(Boolean)[1], 10);
    if (!Number.isFinite(chatId) || chatId <= 0) {
        return ctx.reply(ctx.t('chats.useFormat'));
    }

    let chat: UserChatRecord;
    try {
        chat = (await runBackendGetChat(userId, chatId)).chat;
    } catch {
        return ctx.reply(ctx.t('chats.notFound', { id: chatId }));
    }
    await runBackendActivateChat(userId, chatId);
    return ctx.reply(ctx.t('chats.switched', { id: chat.id, title: chat.title }));
});

bot.command('note_add', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        return ctx.reply(ctx.t('notes.noAccess'));
    }

    const content = extractCommandPayload(ctx.message.text, 'note_add');
    if (!content) return ctx.reply(ctx.t('notes.addFormat'));
    const created = await runBackendCreateNote(userId, content, '');
    const noteId = created.id;
    return ctx.reply(ctx.t('notes.saved', { id: noteId }));
});

bot.command('notes', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        return ctx.reply(ctx.t('notes.noAccess'));
    }

    const pageRaw = ctx.message.text.split(' ').filter(Boolean)[1];
    const pageParsed = Number.parseInt(pageRaw || '1', 10);
    const page = Number.isFinite(pageParsed) && pageParsed > 0 ? pageParsed : 1;
    const listLimit = NOTES_PAGE_SIZE_DEFAULT;
    const offset = (page - 1) * listLimit;
    const { notes, total } = await runBackendGetNotes(userId, listLimit, offset);
    return ctx.reply(formatNotesPage(
        notes,
        page,
        total,
        listLimit,
        ctx.t,
        ctx.state.language
    ));
});

bot.command('note_find', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        return ctx.reply(ctx.t('notes.noAccess'));
    }

    const query = extractCommandPayload(ctx.message.text, 'note_find');
    if (!query) return ctx.reply(ctx.t('notes.findFormat'));
    if (query.length > NOTE_QUERY_MAX_LENGTH) {
        return ctx.reply(ctx.t('notes.queryTooLong', {
            length: query.length,
            limit: NOTE_QUERY_MAX_LENGTH
        }));
    }

    const listLimit = NOTES_PAGE_SIZE_DEFAULT;
    const { notes, total } = await runBackendGetNotes(userId, listLimit, 0, query);
    return ctx.reply(formatNotesPage(
        notes,
        1,
        total,
        listLimit,
        ctx.t,
        ctx.state.language,
        query
    ));
});

bot.command('note_delete', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        return ctx.reply(ctx.t('notes.noAccess'));
    }

    const noteId = Number.parseInt(ctx.message.text.split(' ').filter(Boolean)[1], 10);
    if (!noteId || Number.isNaN(noteId)) {
        return ctx.reply(ctx.t('notes.deleteFormat'));
    }
    const note = await runBackendGetNote(userId, noteId);
    if (!note) return ctx.reply(ctx.t('notes.notFound', { id: noteId }));
    const deleted = await runBackendDeleteNote(userId, noteId);
    if (!deleted) return ctx.reply(ctx.t('notes.deleteError', { id: noteId }));
    return ctx.reply(ctx.t('notes.deleted', { id: noteId }));
});

bot.command('mail_setup', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;

    // The command contains the app password. Remove it from Telegram immediately;
    // the password itself is stored encrypted by backend-api.
    try {
        await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id);
    } catch (err) {
        console.warn('Не удалось удалить сообщение с mail credentials:', formatSafeError(err));
    }

    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        return ctx.reply(ctx.t('mail.noAccess'));
    }

    const parts = ctx.message.text.split(' ').filter(Boolean);
    if (parts.length < 3) {
        return ctx.reply(ctx.t('mail.setupUsage'));
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
        return ctx.reply(ctx.t('mail.providerUnknown'));
    }

    if (!email || !appPassword) {
        return ctx.reply(ctx.t('mail.credentialsRequired'));
    }

    try {
        const result = await runBackendMailSetup(userId, providerInput, email, appPassword);
        const connected = result.accounts.map(a => `${a.provider}: ${a.imap_user}`).join('\n');
        return ctx.reply(ctx.t('mail.connected', {
            email,
            provider: providerInput,
            accounts: connected
        }));
    } catch (err: any) {
        if (axios.isAxiosError(err)) {
            const code = err.response?.data?.error;
            if (code === 'bad_provider') return ctx.reply(ctx.t('mail.providerUnknown'));
        }
        return ctx.reply(ctx.t('mail.setupError'));
    }
});

bot.command('mail_use', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;

    const parts = ctx.message.text.split(' ').filter(Boolean);
    const reference = parts.slice(1).join(' ').trim();
    if (!reference) {
        return ctx.reply(ctx.t('mail.useUsage'));
    }

    try {
        const result = await runBackendMailUse(userId, reference);
        return ctx.reply(ctx.t('mail.activeAccount', {
            provider: result.provider,
            email: result.imap_user
        }));
    } catch (err: any) {
        if (axios.isAxiosError(err) && err.response?.data?.error === 'mail_account_not_found') {
            return ctx.reply(ctx.t('mail.accountNotFound', { provider: reference }));
        }
        return ctx.reply(ctx.t('mail.useError'));
    }
});

bot.command('mail_forget', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    const parts = ctx.message.text.split(' ').filter(Boolean);
    const reference = parts.slice(1).join(' ').trim() || null;

    try {
        const result = await runBackendMailForget(userId, reference);
        if (result.deleted === 'all') {
            return ctx.reply(ctx.t('mail.allDeleted'));
        }
        if (result.new_active) {
            return ctx.reply(ctx.t('mail.deletedWithActive', {
                provider: result.deleted,
                activeProvider: result.new_active.provider,
                email: result.new_active.imap_user
            }));
        }
        return ctx.reply(ctx.t('mail.deletedLast', { provider: result.deleted }));
    } catch {
        return ctx.reply(ctx.t('mail.deleteError'));
    }
});

bot.hears(TZ_BUTTON_SET_UTC_VALUES, (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    timezoneSetupFlows.set(userId, 'await_offset');
    return ctx.reply(ctx.t('timezone.enterOffset'));
});

bot.on('location', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;

    const user = await getUser(userId);
    if (!user) return;

    const longitude = ctx.message.location.longitude;
    let offset = Math.round(longitude / 15);
    if (offset < -12) offset = -12;
    if (offset > 14) offset = 14;

    try {
        await runBackendSetTimezone(userId, offset);
    } catch {
        return ctx.reply(ctx.t('timezone.error'));
    }
    timezoneSetupFlows.delete(userId);
    const sign = offset >= 0 ? '+' : '';
    return ctx.reply(ctx.t('timezone.locationSet', { offset: `${sign}${offset}` }), buildMenuTriggerKeyboard(ctx.t));
});

bot.action(/^main:(clear|users|rename|add|remove|prompts|current_prompt|model|context_size|prompt_admin|pending|banned|mail|notes|chats|language|help|recover_desktop)$/, async (ctx) => {
    const actionId = (ctx as any).match[1] as MenuActionId;
    const action = MENU_ACTION_BY_ID[actionId];

    if (!action) {
        await ctx.answerCbQuery(ctx.t('common.unknownAction'));
        return;
    }

    if (action.adminOnly && ctx.state.role !== 'admin') {
        await ctx.answerCbQuery(ctx.t('common.adminOnly'));
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
            await ctx.reply(ctx.t('generated.renameUsage'));
            return;
        }
        await startSelfRenameFlow(ctx);
        return;
    }

    if (actionId === 'prompts') {
        const userId = ctx.state.accountId;
        if (!userId) return;

        const user = await getUser(userId);
        if (!user) {
            await ctx.reply(ctx.t('common.userMissing'));
            return;
        }

        if (ctx.state.role !== 'admin') {
            await renderPromptListInteractive(ctx, user, 'reply');
            return;
        }

        await ctx.reply(ctx.t('prompt.adminChoose', {
            list: await formatPromptsList(user.selected_prompt_id, ctx.t, true)
        }));
        return;
    }

    if (actionId === 'current_prompt') {
        const userId = ctx.state.accountId;
        if (!userId) return;

        const user = await getUser(userId);
        if (!user) {
            await ctx.reply(ctx.t('common.userMissing'));
            return;
        }

        const activePrompt = await resolvePromptForUser(userId);
        if (activePrompt.id === CUSTOM_PROMPT_ID) {
            const preview = getCustomPromptPreview(user.custom_prompt_content, ctx.t, 280);
            await ctx.reply(ctx.t('prompt.currentCustom', {
                name: ctx.t('prompt.customName'),
                limit: MAX_CUSTOM_PROMPT_LENGTH,
                text: preview
            }));
            return;
        }

        const defaultMark = activePrompt.is_default === 1
            ? ctx.t('prompt.currentDefaultMark')
            : '';
        await ctx.reply(ctx.t('prompt.current', {
            name: activePrompt.name,
            defaultMark,
            id: activePrompt.id
        }));
        return;
    }

    if (actionId === 'model') {
        await handleModelList(ctx);
        return;
    }

    if (actionId === 'context_size') {
        const userId = ctx.state.accountId;
        if (!userId) return;
        const user = await getUser(userId);
        if (!user) {
            await ctx.reply(ctx.t('common.userMissing'));
            return;
        }
        const currentTokens = resolveMaxContextTokens(user);
        const maxTokens = (user.max_context_tokens_limit ?? 0) > 0
            ? Math.floor(user.max_context_tokens_limit!) : getPlanMaxContextTokens(parsePlanFromDb(user.plan));
        await ctx.reply(ctx.t('context.card', {
            current: (currentTokens / 1000).toFixed(0),
            max: (maxTokens / 1000).toFixed(0),
            plan: getPlanLabel(parsePlanFromDb(user.plan))
        }), buildContextSettingsKeyboard(ctx.t));
        return;
    }

    if (actionId === 'add') {
        await ctx.reply(ctx.t('generated.addUsage'));
        return;
    }

    if (actionId === 'remove') {
        await ctx.reply(ctx.t('generated.removeUsage'));
        return;
    }

    if (actionId === 'prompt_admin') {
        await ctx.reply(ctx.t('generated.promptAdminCommands'));
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
        const userId = ctx.state.accountId;
        if (!userId) return;
        await renderMailMenu(ctx, userId, 'reply');
        return;
    }

    if (actionId === 'notes') {
        const userId = ctx.state.accountId;
        if (!userId) return;
        await renderNotesMenuList(ctx, userId, 0, 'reply');
        return;
    }

    if (actionId === 'chats') {
        const userId = ctx.state.accountId;
        if (!userId) return;
        await renderChatsMenuList(ctx, userId, 0, 'reply');
        return;
    }

    if (actionId === 'language') {
        await ctx.reply(ctx.t('language.card', {
            language: getNativeLanguageName(ctx.state.language)
        }), buildLanguageKeyboard(ctx.state.language, ctx.t));
        return;
    }

    if (actionId === 'recover_desktop') {
        await startRecoverDesktopConfirm(ctx);
        return;
    }

    if (ctx.state.role === 'admin') {
        await ctx.reply(ctx.t('generated.allCommands').replace(/,\s*\/mail_limit\b/g, ''));
        return;
    }

    await ctx.reply(ctx.t('generated.userCommands').replace(/,\s*\/mail_limit\b/g, ''));
});

bot.action(/^language:set:([a-zA-Z-]+)$/, async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;

    const language = normalizeSupportedLanguage((ctx as any).match[1]);
    if (!language) {
        await ctx.answerCbQuery(ctx.t('common.unknownAction'));
        return;
    }

    try {
        await updateUserLanguage(userId, language);
        ctx.state.language = language;
        await syncCommandScopeForUser(ctx.state.telegramId, ctx.state.role === 'admin', language);
    } catch (error) {
        console.error(`Failed to update Telegram language for user ${userId}:`, formatSafeError(error));
        await ctx.answerCbQuery(ctx.t('common.serviceUnavailable'));
        return;
    }

    const languageName = getNativeLanguageName(language);
    await ctx.answerCbQuery(ctx.t('language.changed', { language: languageName }));
    await ctx.editMessageText(ctx.t('language.card', { language: languageName }), buildLanguageKeyboard(language, ctx.t)).catch(() => undefined);
    await ctx.reply(ctx.t('language.changed', { language: languageName }), buildMenuTriggerKeyboard(ctx.t));
});

bot.action('language:back', async (ctx) => {
    await ctx.answerCbQuery();
    await showMenu(ctx);
});

bot.action('context:change', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user) {
        await ctx.answerCbQuery(ctx.t('common.noAccess'));
        return;
    }

    contextLimitFlows.set(userId, 'await_limit');
    await ctx.answerCbQuery(ctx.t('context.awaitNumber'));
    const maxTokens = (user.max_context_tokens_limit ?? 0) > 0
        ? Math.floor(user.max_context_tokens_limit!) : getPlanMaxContextTokens(parsePlanFromDb(user.plan));
    await ctx.reply(ctx.t('context.enterLimit', {
        current: (resolveMaxContextTokens(user) / 1000).toFixed(0),
        max: (maxTokens / 1000).toFixed(0),
        cancel: ctx.t('common.cancelWord')
    }));
});

bot.action('context:back', async (ctx) => {
    const userId = ctx.state.accountId;
    if (userId) contextLimitFlows.delete(userId);
    await ctx.answerCbQuery();
    await showMenu(ctx);
});

bot.action(/^mod:pp:(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery(ctx.t('common.adminOnly'));
        return;
    }

    const page = Number.parseInt((ctx as any).match[1], 10);
    await renderPendingList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
    await ctx.answerCbQuery();
});

bot.action('mail:setup_help', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(ctx.t('mail.setupHelp'));
});

bot.action('mail:add', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(ctx.t('mail.chooseProvider'), buildMailProviderKeyboard(ctx.t));
});

bot.action(/^mail:add:(google|yandex)$/, async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    const provider = (ctx as any).match[1] as 'google' | 'yandex';
    mailSetupFlows.set(userId, { step: 'await_email', provider });
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        ctx.t('mail.enterEmailInteractive', { provider: ctx.t(`mail.providers.${provider}`) }),
        Markup.inlineKeyboard([[Markup.button.callback(ctx.t('mail.buttons.cancel'), 'mail:setup_cancel')]])
    );
});

bot.action('mail:setup_cancel', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    mailSetupFlows.delete(userId);
    await ctx.answerCbQuery(ctx.t('mail.setupCancelled'));
    await renderMailMenu(ctx, userId, 'edit');
});

bot.action('mail:instr:yandex', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(ctx.t('mail.yandexInstructions'));
});

bot.action('mail:instr:google', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(ctx.t('mail.googleInstructions'));
});

bot.action(/^mail:noop:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery(ctx.t('mail.alreadyActive'));
});

bot.action(/^mail:use:(\d+)$/, async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    const accountId = Number.parseInt((ctx as any).match[1], 10);
    try {
        const account = await runBackendMailUse(userId, String(accountId));
        await ctx.answerCbQuery(ctx.t('mail.activeAccountShort', { email: account.imap_user }));
        await renderMailMenu(ctx, userId, 'edit');
    } catch {
        await ctx.answerCbQuery(ctx.t('mail.useError'));
    }
});

bot.action(/^mail:delete:(\d+)$/, async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    const accountId = Number.parseInt((ctx as any).match[1], 10);
    const data = await runBackendGetMailAccounts(userId);
    const account = data.accounts.find(item => item.id === accountId);
    if (!account) {
        await ctx.answerCbQuery(ctx.t('mail.accountMissing'));
        return renderMailMenu(ctx, userId, 'edit');
    }
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        ctx.t('mail.deleteConfirm', { account: account.label || account.email }),
        Markup.inlineKeyboard([
            [
                Markup.button.callback(ctx.t('mail.buttons.confirmDelete'), `mail:delete_confirm:${accountId}`),
                Markup.button.callback(ctx.t('mail.buttons.cancel'), 'mail:list')
            ]
        ])
    );
});

bot.action(/^mail:delete_confirm:(\d+)$/, async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    const accountId = Number.parseInt((ctx as any).match[1], 10);
    try {
        await runBackendMailForget(userId, String(accountId));
        await ctx.answerCbQuery(ctx.t('mail.deletedShort'));
        await renderMailMenu(ctx, userId, 'edit');
    } catch {
        await ctx.answerCbQuery(ctx.t('mail.deleteError'));
    }
});

bot.action('mail:list', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    await ctx.answerCbQuery();
    await renderMailMenu(ctx, userId, 'edit');
});

bot.action('mail:back:menu', async (ctx) => {
    await ctx.answerCbQuery();
    await showMenu(ctx);
});

bot.action(/^chats:list:(\d+)$/, async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        await ctx.answerCbQuery(ctx.t('chats.noAccess'));
        return;
    }
    const page = Number.parseInt((ctx as any).match[1], 10);
    await ctx.answerCbQuery();
    await renderChatsMenuList(ctx, userId, Number.isNaN(page) ? 0 : page, 'edit');
});

bot.action(/^chats:use:(\d+):(\d+)$/, async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        await ctx.answerCbQuery(ctx.t('chats.noAccess'));
        return;
    }

    const chatId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    if (Number.isNaN(chatId) || chatId <= 0) {
        await ctx.answerCbQuery(ctx.t('chats.notFound', { id: chatId }));
        return;
    }

    try {
        const activated = await runBackendActivateChat(userId, chatId);
        await ctx.answerCbQuery(ctx.t('chats.switched', {
            id: activated.chat.id,
            title: activated.chat.title
        }));
        await renderChatsMenuList(ctx, userId, Number.isNaN(page) ? 0 : page, 'edit');
    } catch {
        await ctx.answerCbQuery(ctx.t('chats.notFound', { id: chatId }));
    }
});

bot.action('chats:new', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        await ctx.answerCbQuery(ctx.t('chats.noAccess'));
        return;
    }

    const created = await runBackendCreateChat(userId);
    await ctx.answerCbQuery(ctx.t('chats.created', {
        id: created.chat.id,
        title: created.chat.title
    }));
    await renderChatsMenuList(ctx, userId, 0, 'edit');
});

bot.action('chats:back:menu', async (ctx) => {
    await ctx.answerCbQuery();
    await showMenu(ctx);
});

bot.action(/^notes:list:(\d+)$/, async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        await ctx.answerCbQuery(ctx.t('common.noAccess'));
        return;
    }
    const page = Number.parseInt((ctx as any).match[1], 10);
    await ctx.answerCbQuery();
    await renderNotesMenuList(ctx, userId, Number.isNaN(page) ? 0 : page, 'edit');
});

bot.action(/^notes:view:(\d+):(\d+)$/, async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        await ctx.answerCbQuery(ctx.t('common.noAccess'));
        return;
    }
    const noteId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    await ctx.answerCbQuery();
    if (Number.isNaN(noteId) || noteId <= 0) {
        await ctx.reply(ctx.t('notes.invalidId'));
        return;
    }
    await renderNoteView(ctx, userId, noteId, Number.isNaN(page) ? 0 : page, 'edit');
});

bot.action(/^notes:edit:(\d+):(\d+)$/, async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        await ctx.answerCbQuery(ctx.t('common.noAccess'));
        return;
    }
    const noteId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    if (Number.isNaN(noteId) || noteId <= 0) {
        await ctx.answerCbQuery(ctx.t('notes.invalidIdShort'));
        return;
    }
    const note = await runBackendGetNote(userId, noteId);
    if (!note) {
        await ctx.answerCbQuery(ctx.t('notes.notFoundShort'));
        return;
    }
    noteEditFlows.set(userId, { noteId, page: Number.isNaN(page) ? 0 : page });
    await ctx.answerCbQuery(ctx.t('notes.awaitText'));
    await ctx.reply(ctx.t('notes.enterEditText', {
        id: noteId,
        cancel: ctx.t('common.cancelWord')
    }));
});

bot.action(/^notes:delete:(\d+):(\d+)$/, async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user || (user.status !== 'approved' && user.role !== 'admin')) {
        await ctx.answerCbQuery(ctx.t('common.noAccess'));
        return;
    }
    const noteId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const safePage = Number.isNaN(page) ? 0 : page;
    if (Number.isNaN(noteId) || noteId <= 0) {
        await ctx.answerCbQuery(ctx.t('notes.invalidIdShort'));
        return;
    }
    const note = await runBackendGetNote(userId, noteId);
    if (!note) {
        await ctx.answerCbQuery(ctx.t('notes.alreadyDeleted'));
        await renderNotesMenuList(ctx, userId, safePage, 'edit');
        return;
    }
    const deleted = await runBackendDeleteNote(userId, noteId);
    if (!deleted) {
        await ctx.answerCbQuery(ctx.t('notes.deleteErrorShort'));
        return;
    }
    const totalAfter = (await runBackendGetNotes(userId, 1, 0)).total;
    const maxPage = Math.max(0, Math.ceil(totalAfter / NOTES_MENU_PAGE_SIZE) - 1);
    const nextPage = Math.min(safePage, maxPage);
    await ctx.answerCbQuery(ctx.t('notes.deletedShort'));
    await renderNotesMenuList(ctx, userId, nextPage, 'edit');
});

bot.action('notes:back:menu', async (ctx) => {
    const userId = ctx.state.accountId;
    if (userId) noteEditFlows.delete(userId);
    await ctx.answerCbQuery();
    await showMenu(ctx);
});

bot.action(/^mod:pv:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery(ctx.t('common.adminOnly'));
        return;
    }

    const userId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const user = await getUser(userId);
    if (!user || user.status !== 'none') {
        await ctx.answerCbQuery(ctx.t('admin.requestProcessed'));
        await renderPendingList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
        return;
    }

    await renderPendingCard(ctx, user, Number.isNaN(page) ? 0 : page, 'edit');
    await ctx.answerCbQuery();
});

bot.action(/^mod:ok:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery(ctx.t('common.adminOnly'));
        return;
    }

    const targetUserId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const ok = await approveUserAccess(targetUserId);
    if (!ok) {
        await ctx.answerCbQuery(ctx.t('admin.userNotFound'));
        return;
    }

    await renderPendingList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
    await ctx.answerCbQuery(ctx.t('admin.approved'));
});

bot.action(/^mod:no:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery(ctx.t('common.adminOnly'));
        return;
    }

    const targetUserId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const ok = await disapproveUserAccess(targetUserId);
    if (!ok) {
        await ctx.answerCbQuery(ctx.t('admin.userNotFound'));
        return;
    }

    await renderPendingList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
    await ctx.answerCbQuery(ctx.t('admin.rejected'));
});

bot.action(/^mod:ban:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery(ctx.t('common.adminOnly'));
        return;
    }

    const adminId = ctx.state.accountId;
    if (!adminId) return;
    const targetUserId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);

    const ok = await banUserAccess(targetUserId, adminId, ctx.t('admin.defaultBanReason'));
    if (!ok) {
        await ctx.answerCbQuery(ctx.t('admin.userNotFound'));
        return;
    }

    await renderPendingList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
    await ctx.answerCbQuery(ctx.t('admin.banned'));
});

bot.action(/^mod:bp:(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery(ctx.t('common.adminOnly'));
        return;
    }

    const page = Number.parseInt((ctx as any).match[1], 10);
    await renderBannedList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
    await ctx.answerCbQuery();
});

bot.action(/^mod:bv:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery(ctx.t('common.adminOnly'));
        return;
    }

    const userId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const user = await getUser(userId);
    if (!user || user.status !== 'banned') {
        await ctx.answerCbQuery(ctx.t('admin.notBanned'));
        await renderBannedList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
        return;
    }

    await renderBannedCard(ctx, user, Number.isNaN(page) ? 0 : page, 'edit');
    await ctx.answerCbQuery();
});

bot.action(/^mod:unban:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery(ctx.t('common.adminOnly'));
        return;
    }

    const targetUserId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const ok = await unbanUserAccess(targetUserId);
    if (!ok) {
        await ctx.answerCbQuery(ctx.t('admin.userNotFound'));
        return;
    }

    await renderBannedList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
    await ctx.answerCbQuery(ctx.t('admin.unbanned'));
});

bot.action(/^usr:list:(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery(ctx.t('common.adminOnly'));
        return;
    }

    const page = Number.parseInt((ctx as any).match[1], 10);
    await renderAdminUsersList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
    await ctx.answerCbQuery();
});

bot.action(/^usr:view:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery(ctx.t('common.adminOnly'));
        return;
    }

    const userId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const user = await getUser(userId);
    if (!user) {
        await ctx.answerCbQuery(ctx.t('admin.userNotFound'));
        await renderAdminUsersList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
        return;
    }

    await renderAdminUserCard(ctx, user, Number.isNaN(page) ? 0 : page, 'edit');
    await ctx.answerCbQuery();
});

bot.action(/^usr:plan:open:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery(ctx.t('common.adminOnly'));
        return;
    }

    const userId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const user = await getUser(userId);
    if (!user) {
        await ctx.answerCbQuery(ctx.t('admin.userNotFound'));
        await renderAdminUsersList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
        return;
    }

    await renderAdminPlanChoiceCard(ctx, user, Number.isNaN(page) ? 0 : page, 'edit');
    await ctx.answerCbQuery();
});

bot.action(/^usr:plan:pick:(\d+):(\d+):(free|standart|pro)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery(ctx.t('common.adminOnly'));
        return;
    }

    const userId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const plan = (ctx as any).match[3] as UserPlan;
    const user = await getUser(userId);
    if (!user) {
        await ctx.answerCbQuery(ctx.t('admin.userNotFound'));
        await renderAdminUsersList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
        return;
    }

    await renderAdminPlanDurationCard(ctx, user, Number.isNaN(page) ? 0 : page, plan, 'edit');
    await ctx.answerCbQuery();
});

bot.action(/^usr:plan:dur:(\d+):(\d+):(free|standart|pro):(day|week|month|year|forever)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery(ctx.t('common.adminOnly'));
        return;
    }

    const adminId = ctx.state.accountId;
    if (!adminId) return;
    const userId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const plan = (ctx as any).match[3] as UserPlan;
    const duration = (ctx as any).match[4] as PlanDurationCode;
    const user = await getUser(userId);
    if (!user) {
        await ctx.answerCbQuery(ctx.t('admin.userNotFound'));
        await renderAdminUsersList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
        return;
    }

    const endsAt = getEndsAtForDuration(duration);
    await applyUserPlan(userId, plan, endsAt, adminId);
    const refreshed = await getUser(userId);
    if (!refreshed) {
        await ctx.answerCbQuery(ctx.t('admin.updateError'));
        return;
    }

    await renderAdminUserCard(ctx, refreshed, Number.isNaN(page) ? 0 : page, 'edit');
    await ctx.answerCbQuery(ctx.t('admin.planApplied', { plan: getPlanLabel(plan), duration: ctx.t(`admin.durations.${duration}`) }));
});

bot.action(/^usr:ctx:ask:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery(ctx.t('common.adminOnly'));
        return;
    }

    const adminId = ctx.state.accountId;
    if (!adminId) return;
    const targetUserId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const user = await getUser(targetUserId);
    if (!user) {
        await ctx.answerCbQuery(ctx.t('admin.userNotFound'));
        return;
    }

    adminUserContextLimitFlows.set(adminId, { targetUserId, page: Number.isNaN(page) ? 0 : page });
    await ctx.answerCbQuery(ctx.t('admin.awaitNumber'));
    const maxTokens = (user.max_context_tokens_limit ?? 0) > 0
        ? Math.floor(user.max_context_tokens_limit!) : getPlanMaxContextTokens(parsePlanFromDb(user.plan));
    await ctx.reply(ctx.t('admin.enterContextLimit', { id: targetUserId, current: (resolveMaxContextTokens(user) / 1000).toFixed(0), max: (maxTokens / 1000).toFixed(0), cancel: ctx.t('common.cancelWord') }));
});

bot.action(/^usr:ban:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery(ctx.t('common.adminOnly'));
        return;
    }
    const adminId = ctx.state.accountId;
    if (!adminId) return;

    const targetUserId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const user = await getUser(targetUserId);
    if (!user) {
        await ctx.answerCbQuery(ctx.t('admin.userNotFound'));
        return;
    }
    if (user.role === 'admin') {
        await ctx.answerCbQuery(ctx.t('admin.cannotBanAdmin'));
        return;
    }

    await banUserAccess(targetUserId, adminId, ctx.t('admin.defaultBanReason'));
    const refreshed = await getUser(targetUserId);
    if (refreshed) await renderAdminUserCard(ctx, refreshed, Number.isNaN(page) ? 0 : page, 'edit');

    await ctx.answerCbQuery(ctx.t('admin.banned'));
});

bot.action(/^usr:unban:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery(ctx.t('common.adminOnly'));
        return;
    }

    const targetUserId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const user = await getUser(targetUserId);
    if (!user) {
        await ctx.answerCbQuery(ctx.t('admin.userNotFound'));
        return;
    }
    if (user.status !== 'banned') {
        await ctx.answerCbQuery(ctx.t('admin.notBanned'));
        return;
    }

    await unbanUserAccess(targetUserId);
    const refreshed = await getUser(targetUserId);
    if (refreshed) await renderAdminUserCard(ctx, refreshed, Number.isNaN(page) ? 0 : page, 'edit');

    await ctx.answerCbQuery(ctx.t('admin.unbanned'));
});

bot.action(/^usr:remove:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery(ctx.t('common.adminOnly'));
        return;
    }

    const targetUserId = Number.parseInt((ctx as any).match[1], 10);
    const page = Number.parseInt((ctx as any).match[2], 10);
    const user = await getUser(targetUserId);
    if (!user) {
        await ctx.answerCbQuery(ctx.t('admin.alreadyDeleted'));
        await renderAdminUsersList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
        return;
    }
    if (user.role === 'admin') {
        await ctx.answerCbQuery(ctx.t('admin.cannotDeleteAdmin'));
        return;
    }

    await removeUser(targetUserId);
    await renderAdminUsersList(ctx, Number.isNaN(page) ? 0 : page, 'edit');
    await ctx.answerCbQuery(ctx.t('admin.deleted'));
});

bot.action(/^ai_send:(\d+)$/, async (ctx) => {
    if (ctx.state.role !== 'admin') {
        await ctx.answerCbQuery(ctx.t('common.adminOnly'));
        return;
    }

    const adminId = ctx.state.accountId;
    if (!adminId) return;

    const targetId = Number.parseInt((ctx as any).match[1], 10);
    const targetUser = await getUser(targetId);
    if (!targetUser) {
        await ctx.answerCbQuery();
        await ctx.reply(ctx.t('admin.userNotFound'));
        return;
    }

    adminAiMessageFlow.set(adminId, targetId);
    await ctx.answerCbQuery(ctx.t('admin.awaitText'));
    await ctx.reply(
        ctx.t('admin.aiMessagePrompt', { user: targetUser.name || targetUser.telegram_username || targetId }),
        { parse_mode: 'Markdown' }
    );
});

bot.action('prompt:list', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;

    const user = await getUser(userId);
    if (!user) {
        await ctx.answerCbQuery(ctx.t('common.noAccess'));
        return;
    }

    if (ctx.state.role === 'admin') {
        await ctx.answerCbQuery(ctx.t('prompt.adminUsePrompts'));
        return;
    }

    await renderPromptListInteractive(ctx, user, 'edit');
    await ctx.answerCbQuery();
});

bot.action('prompt:custom:view', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;

    const user = await getUser(userId);
    if (!user) {
        await ctx.answerCbQuery(ctx.t('common.noAccess'));
        return;
    }

    if (ctx.state.role === 'admin') {
        await ctx.answerCbQuery(ctx.t('prompt.adminUseSet'));
        return;
    }

    await renderCustomPromptCardInteractive(ctx, user, 'edit');
    await ctx.answerCbQuery();
});

bot.action('prompt:custom:use', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;

    const user = await getUser(userId);
    if (!user) {
        await ctx.answerCbQuery(ctx.t('common.noAccess'));
        return;
    }
    if (ctx.state.role === 'admin') {
        await ctx.answerCbQuery(ctx.t('common.unavailable'));
        return;
    }

    const customContent = (user.custom_prompt_content || '').trim();
    if (!customContent) {
        customPromptEditFlows.set(userId, 'await_content');
        await ctx.answerCbQuery(ctx.t('prompt.needCustomText'));
        await ctx.reply(ctx.t('prompt.enterCustomText', {
            limit: MAX_CUSTOM_PROMPT_LENGTH
        }));
        return;
    }

    await selectUserCustomPrompt(userId);
    const refreshed = await getUser(userId);
    if (!refreshed) {
        await ctx.answerCbQuery(ctx.t('common.profileError'));
        return;
    }
    await renderCustomPromptCardInteractive(ctx, refreshed, 'edit');
    await ctx.answerCbQuery(ctx.t('prompt.customSelected'));
});

bot.action('prompt:custom:edit', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    const user = await getUser(userId);
    if (!user) {
        await ctx.answerCbQuery(ctx.t('common.noAccess'));
        return;
    }
    if (ctx.state.role === 'admin') {
        await ctx.answerCbQuery(ctx.t('common.unavailable'));
        return;
    }

    customPromptEditFlows.set(userId, 'await_content');
    await ctx.answerCbQuery(ctx.t('prompt.awaitText'));
    const currentText = getCustomPromptPreview(user.custom_prompt_content, ctx.t, 280);
    await ctx.reply(ctx.t('prompt.editCustomText', {
        current: currentText,
        limit: MAX_CUSTOM_PROMPT_LENGTH
    }));
});

bot.action('prompt:custom:keep', async (ctx) => {
    await ctx.answerCbQuery(ctx.t('prompt.keepCurrent'));
});

bot.action(/^prompt:view:(\d+)$/, async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;

    const user = await getUser(userId);
    if (!user) {
        await ctx.answerCbQuery(ctx.t('common.noAccess'));
        return;
    }

    if (ctx.state.role === 'admin') {
        await ctx.answerCbQuery(ctx.t('prompt.adminUseShow'));
        return;
    }

    const promptId = Number.parseInt((ctx as any).match[1], 10);
    let prompt;
    try {
        const data = await runBackendGetPrompt(promptId);
        prompt = data.prompt;
    } catch {
        await ctx.answerCbQuery(ctx.t('prompt.notFound'));
        return;
    }

    await renderPromptCardInteractive(ctx, user, prompt);
    await ctx.answerCbQuery();
});

bot.action(/^prompt:use:(\d+)$/, async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;

    const user = await getUser(userId);
    if (!user) {
        await ctx.answerCbQuery(ctx.t('common.noAccess'));
        return;
    }

    if (ctx.state.role === 'admin') {
        await ctx.answerCbQuery(ctx.t('prompt.adminUseSelect'));
        return;
    }

    const promptId = Number.parseInt((ctx as any).match[1], 10);
    let prompt;
    try {
        const data = await runBackendGetPrompt(promptId);
        prompt = data.prompt;
    } catch {
        await ctx.answerCbQuery(ctx.t('prompt.notFound'));
        return;
    }

    await updateUserPrompt(userId, promptId);
    const refreshedUser = await getUser(userId);
    if (!refreshedUser) {
        await ctx.answerCbQuery(ctx.t('common.profileError'));
        return;
    }

    await renderPromptCardInteractive(ctx, refreshedUser, prompt);
    await ctx.answerCbQuery(ctx.t('prompt.selected'));
});

bot.action(/^prompt:noop:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery(ctx.t('prompt.alreadySelected'));
});

bot.action('prompt:cancel', async (ctx) => {
    const userId = ctx.state.accountId;
    if (userId) {
        customPromptEditFlows.delete(userId);
    }
    await ctx.editMessageText(ctx.t('prompt.cancelled'));
    await ctx.answerCbQuery();
});

// ── Model selector callbacks ─────────────────────────────────────────────────

bot.action(/^model:select:(.+)$/, async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;
    const rawId = (ctx as any).match[1] as string;
    const modelId = rawId === 'auto' ? null : rawId;
    try {
        await runBackendSetPreferredModel(userId, modelId);
        const label = modelId || ctx.t('model.auto');
        await ctx.editMessageText(ctx.t('model.changed', { model: label }));
        await ctx.answerCbQuery(ctx.t('model.callbackChanged', { model: label }));
    } catch {
        await ctx.answerCbQuery(ctx.t('model.changeError'));
    }
});

bot.action('model:cancel', async (ctx) => {
    await ctx.editMessageText(ctx.t('model.cancelled'));
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
    const userId = ctx.state.accountId;
    if (!userId) {
        await ctx.answerCbQuery(ctx.t('confirmations.error'));
        return;
    }
    pendingRejectionComments.set(userId, { endpoint, confirmationId, label });
    await ctx.answerCbQuery(ctx.t('confirmations.awaitComment'));
    await ctx.reply(ctx.t('confirmations.commentPrompt', { label }));
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

bot.action(/^pcconfirm:(allow|site|always|review|reject|reject_comment):(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const confirmationId = ctx.match[2];
    const userId = ctx.state.accountId;

    if (!userId) {
        await ctx.answerCbQuery(ctx.t('confirmations.userUnknown'));
        return;
    }

    // Answer callback query immediately — Telegram requires it within ~15s
    if (action === 'reject') {
        const pendingLabel = pendingPcCommandTexts.get(confirmationId) || '';
        const isBrowserAction = pendingLabel.startsWith('browser:');
        await ctx.answerCbQuery(ctx.t('confirmations.rejected'));
        try {
            await rejectWithOptionalComment('/internal/pc-commands/approve', confirmationId, userId);
            pendingPcCommandTexts.delete(confirmationId);
            await ctx.editMessageText(ctx.t(isBrowserAction ? 'browserConfirmation.rejected' : 'confirmations.commandRejected'));
        } catch {
            await ctx.editMessageText(ctx.t('confirmations.rejectFailed')).catch(() => {});
        }
        return;
    }

    if (action === 'reject_comment') {
        const cmd = (pendingPcCommandTexts.get(confirmationId) || ctx.t('confirmations.labels.pcCommand')).replace(/^browser:/, '');
        await requestRejectionComment(ctx, '/internal/pc-commands/approve', confirmationId, cmd.slice(0, 120));
        return;
    }

    if (action === 'allow' || action === 'site') {
        const pendingLabel = pendingPcCommandTexts.get(confirmationId) || '';
        const isBrowserAction = pendingLabel.startsWith('browser:');
        await ctx.answerCbQuery(ctx.t('confirmations.executing'));
        // Run in background — don't block Telegraf
        (async () => {
            try {
                const resp = await axios.post(
                    `${BACKEND_API_BASE_URL}/internal/pc-commands/approve`,
                    {
                        confirmation_id: confirmationId,
                        approved: true,
                        user_id: userId,
                        ...(action === 'site' ? { allow_browser_site_session: true } : {}),
                    },
                    { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` }, timeout: 120000 }
                );
                const output = typeof resp.data?.result === 'string' ? resp.data.result : '';
                const preview = output.slice(0, 500) || ctx.t('confirmations.noOutput');
                pendingPcCommandTexts.delete(confirmationId);
                if (isBrowserAction) {
                    await ctx.editMessageText(ctx.t(action === 'site' ? 'browserConfirmation.siteAllowedSession' : 'browserConfirmation.completed')).catch(() => {});
                } else {
                    await ctx.editMessageText(ctx.t('confirmations.commandDoneMarkdown', { output: preview.replace(/```/g, "'''") }), { parse_mode: 'Markdown' }).catch(() => {
                        ctx.editMessageText(ctx.t('confirmations.commandDone', { output: preview })).catch(() => {});
                    });
                }
            } catch (err: any) {
                const msg = err?.response?.data?.error || err?.message || ctx.t('confirmations.unknownError');
                await ctx.editMessageText(ctx.t('confirmations.executionError', { error: msg })).catch(() => {});
            }
        })();
        return;
    }

    if (action === 'always') {
        // Confirm: "Are you sure?"
        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback(ctx.t('confirmations.buttons.alwaysConfirm'), `pcconfirm:always_confirm:${confirmationId}`),
                Markup.button.callback(ctx.t('confirmations.buttons.back'), `pcconfirm:always_cancel:${confirmationId}`),
            ]
        ]);
        await ctx.editMessageText(ctx.t('confirmations.createPermanentRule'), keyboard);
        await ctx.answerCbQuery();
        return;
    }

    if (action === 'review') {
        await ctx.answerCbQuery(ctx.t('confirmations.sendingForReview'));
        // Run in background
        (async () => {
            try {
                const cmd = pendingPcCommandTexts.get(confirmationId) || ctx.t('confirmations.unknownCommand');

                const liteResp = await axios.post(
                    `${BACKEND_API_BASE_URL}/internal/ai/lite`,
                    {
                        text: ctx.t('confirmations.reviewPcPrompt', { command: cmd }),
                        user_id: ctx.state.accountId,
                    },
                    { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` }, timeout: 30000 }
                );
                const verdict = liteResp.data?.reply_text || liteResp.data?.text || ctx.t('confirmations.noResponse');
                await ctx.reply(ctx.t('confirmations.reviewResult', { verdict }));
            } catch (err: any) {
                const msg = err?.response?.data?.message || err?.message || ctx.t('confirmations.error');
                await ctx.reply(ctx.t('confirmations.reviewFailed', { error: msg })).catch(() => {});
            }
        })();
        return;
    }
});

// "Always" confirmation sub-flow
bot.action(/^pcconfirm:always_confirm:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    const userId = ctx.state.accountId;
    if (!userId) {
        await ctx.answerCbQuery(ctx.t('confirmations.error'));
        return;
    }

    await ctx.answerCbQuery(ctx.t('confirmations.executing'));

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
            const preview = output.slice(0, 500) || ctx.t('confirmations.noOutput');
            await ctx.editMessageText(ctx.t('confirmations.commandAlwaysDoneMarkdown', { output: preview.replace(/```/g, "'''") }), { parse_mode: 'Markdown' }).catch(() => {
                ctx.editMessageText(ctx.t('confirmations.commandAlwaysDone', { output: preview })).catch(() => {});
            });
            // answerCbQuery already sent above
        } catch (err: any) {
            const msg = err?.response?.data?.error || err?.message || ctx.t('confirmations.unknownError');
            await ctx.editMessageText(ctx.t('confirmations.genericError', { error: msg })).catch(() => {});
        }
    })();
});

bot.action(/^pcconfirm:always_cancel:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    const cmd = pendingPcCommandTexts.get(confirmationId) || '';
    const preview = cmd.slice(0, 200);
    const keyboard = Markup.inlineKeyboard([
        [
            Markup.button.callback(ctx.t('confirmations.buttons.allow'), `pcconfirm:allow:${confirmationId}`),
            Markup.button.callback(ctx.t('confirmations.buttons.alwaysAllow'), `pcconfirm:always:${confirmationId}`),
        ],
        [
            Markup.button.callback(ctx.t('confirmations.buttons.review'), `pcconfirm:review:${confirmationId}`),
            Markup.button.callback(ctx.t('confirmations.buttons.reject'), `pcconfirm:reject:${confirmationId}`),
            Markup.button.callback(ctx.t('confirmations.buttons.rejectWithComment'), `pcconfirm:reject_comment:${confirmationId}`),
        ]
    ]);
    const escapedPreview = preview.replace(/`/g, '\\`');
    await ctx.editMessageText(ctx.t('confirmations.pcPromptMarkdown', { command: escapedPreview }), { parse_mode: 'Markdown', ...keyboard }).catch(() => {
        ctx.editMessageText(ctx.t('confirmations.pcPrompt', { command: preview }), keyboard).catch(() => {});
    });
    await ctx.answerCbQuery();
});

// ── File Action Confirmation (Telegram inline buttons) ────────────────────

bot.action(/^fileconfirm:(allow|workspace|reject|reject_comment):(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const confirmationId = ctx.match[2];
    const userId = ctx.state.accountId;

    if (!userId) {
        await ctx.answerCbQuery(ctx.t('confirmations.userUnknown'));
        return;
    }

    if (action === 'reject') {
        await ctx.answerCbQuery(ctx.t('confirmations.rejected'));
        try {
            await rejectWithOptionalComment('/internal/pc-commands/approve', confirmationId, userId);
            await ctx.editMessageText(ctx.t('confirmations.fileRejected'));
        } catch {
            await ctx.editMessageText(ctx.t('confirmations.rejectFailed')).catch(() => {});
        }
        return;
    }

    if (action === 'reject_comment') {
        await requestRejectionComment(ctx, '/internal/pc-commands/approve', confirmationId, ctx.t('confirmations.labels.fileAction'));
        return;
    }

    const allowWorkspaceSession = action === 'workspace';
    await ctx.answerCbQuery(ctx.t('confirmations.executing'));
    (async () => {
        try {
            const resp = await axios.post(
                `${BACKEND_API_BASE_URL}/internal/pc-commands/approve`,
                { confirmation_id: confirmationId, approved: true, user_id: userId, allow_workspace_session: allowWorkspaceSession },
                { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` }, timeout: 120000 }
            );
            const result = resp.data?.result;
            // For read_file — show content preview; for write_file — show success
            if (result && typeof result === 'object' && result.content) {
                const contentPreview = typeof result.content === 'string' ? result.content.slice(0, 3000) : '';
                const linesInfo = result.total_lines ? ctx.t('confirmations.totalLines', { count: result.total_lines }) : '';
                await ctx.editMessageText(ctx.t('confirmations.fileReadMarkdown', { lines: linesInfo, content: contentPreview.replace(/```/g, "'''") }), { parse_mode: 'Markdown' }).catch(() => {
                    ctx.editMessageText(ctx.t('confirmations.fileRead', { lines: linesInfo, content: contentPreview })).catch(() => {});
                });
            } else {
                let successText = ctx.t('confirmations.fileWritten');
                if (allowWorkspaceSession) {
                    const workspace = resp.data?.workspace;
                    successText += workspace?.granted && workspace?.folder
                        ? `\n\n${ctx.t('confirmations.workspaceAllowed', { folder: workspace.folder })}`
                        : `\n\n${ctx.t('confirmations.workspaceNotAllowed')}`;
                }
                await ctx.editMessageText(successText).catch(() => {});
            }
        } catch (err: any) {
            const msg = err?.response?.data?.error || err?.message || ctx.t('confirmations.unknownError');
            await ctx.editMessageText(ctx.t('confirmations.genericError', { error: msg })).catch(() => {});
        }
    })();
});

// ── Visual Click Confirmation (Telegram inline buttons) ───────────────────

bot.action(/^vclick:(allow|reject):(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const confirmationId = ctx.match[2];
    const userId = ctx.state.accountId;

    if (!userId) {
        await ctx.answerCbQuery(ctx.t('confirmations.userUnknown'));
        return;
    }

    if (action === 'reject') {
        await ctx.answerCbQuery(ctx.t('confirmations.rejected'));
        try {
            await axios.post(
                `${BACKEND_API_BASE_URL}/internal/visual-click/approve`,
                { confirmation_id: confirmationId, approved: false, user_id: userId },
                { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` }, timeout: 15000 }
            );
            await ctx.editMessageText(ctx.t('confirmations.clickCancelled'));
        } catch {
            await ctx.editMessageText(ctx.t('confirmations.rejectFailed')).catch(() => {});
        }
        return;
    }

    // action === 'allow'
    await ctx.answerCbQuery(ctx.t('confirmations.clicking'));
    (async () => {
        try {
            const resp = await axios.post(
                `${BACKEND_API_BASE_URL}/internal/visual-click/approve`,
                { confirmation_id: confirmationId, approved: true, user_id: userId },
                { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` }, timeout: 30000 }
            );
            const data = resp.data?.result;
            if (data?.status === 'ok') {
                await ctx.editMessageText(ctx.t('confirmations.clickDoneAt', { x: data.x, y: data.y })).catch(() => {});
            } else {
                await ctx.editMessageText(ctx.t('confirmations.clickDone')).catch(() => {});
            }
        } catch (err: any) {
            const msg = err?.response?.data?.error || err?.message || ctx.t('confirmations.unknownError');
            await ctx.editMessageText(ctx.t('confirmations.clickError', { error: msg })).catch(() => {});
        }
    })();
});

// ── DevOps SSH Confirmation (Telegram inline buttons) ─────────────────────

bot.action(/^devops:allow:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    const userId = ctx.state.accountId;
    if (!userId) {
        await ctx.answerCbQuery(ctx.t('confirmations.error'));
        return;
    }
    await ctx.answerCbQuery(ctx.t('confirmations.executingSsh'));
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
            if (!output) output = ctx.t('confirmations.noOutputExit', { code: exitCode ?? '?' });
            await ctx.editMessageText(ctx.t('confirmations.sshDoneMarkdown', { output: output.replace(/```/g, "'''") }), { parse_mode: 'Markdown' }).catch(() => {
                ctx.editMessageText(ctx.t('confirmations.sshDone', { output })).catch(() => {});
            });
        } catch (err: any) {
            const msg = err?.response?.data?.error || err?.message || ctx.t('confirmations.unknownError');
            await ctx.editMessageText(ctx.t('confirmations.sshError', { error: msg })).catch(() => {});
        }
    })();
});

bot.action(/^devops:reject:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    const userId = ctx.state.accountId;
    if (!userId) {
        await ctx.answerCbQuery(ctx.t('confirmations.error'));
        return;
    }
    await ctx.answerCbQuery(ctx.t('confirmations.rejected'));
    try {
        await rejectWithOptionalComment('/internal/devops/approve', confirmationId, userId);
        await ctx.editMessageText(ctx.t('confirmations.sshRejected'));
    } catch {
        await ctx.editMessageText(ctx.t('confirmations.rejectFailed')).catch(() => {});
    }
});

bot.action(/^devops:reject_comment:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    const cmd = pendingPcCommandTexts.get(`devops:${confirmationId}`) || ctx.t('confirmations.labels.sshCommand');
    await requestRejectionComment(ctx, '/internal/devops/approve', confirmationId, cmd.slice(0, 120));
});

bot.action(/^email:allow:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    const userId = ctx.state.accountId;
    if (!userId) {
        await ctx.answerCbQuery(ctx.t('confirmations.error'));
        return;
    }
    await ctx.answerCbQuery(ctx.t('confirmations.sending'));
    (async () => {
        try {
            const resp = await axios.post(
                `${BACKEND_API_BASE_URL}/internal/email/approve`,
                { confirmation_id: confirmationId, approved: true, user_id: userId },
                { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` }, timeout: 60000 }
            );
            const result = typeof resp.data?.result === 'string' ? resp.data.result : '';
            await ctx.editMessageText(ctx.t('confirmations.emailSent', { result: result ? `\n${result}` : '' })).catch(() => {});
        } catch (err: any) {
            const msg = err?.response?.data?.error || err?.message || ctx.t('confirmations.unknownError');
            await ctx.editMessageText(ctx.t('confirmations.emailError', { error: msg })).catch(() => {});
        }
    })();
});

bot.action(/^email:reject:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    const userId = ctx.state.accountId;
    if (!userId) {
        await ctx.answerCbQuery(ctx.t('confirmations.error'));
        return;
    }
    await ctx.answerCbQuery(ctx.t('confirmations.rejected'));
    try {
        await rejectWithOptionalComment('/internal/email/approve', confirmationId, userId);
        await ctx.editMessageText(ctx.t('confirmations.emailRejected'));
    } catch {
        await ctx.editMessageText(ctx.t('confirmations.rejectFailed')).catch(() => {});
    }
});

bot.action(/^email:reject_comment:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    await requestRejectionComment(ctx, '/internal/email/approve', confirmationId, ctx.t('confirmations.labels.emailSending'));
});

bot.action(/^devops:always:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    const userId = ctx.state.accountId;
    if (!userId) {
        await ctx.answerCbQuery(ctx.t('confirmations.error'));
        return;
    }
    // Confirm: "Are you sure?"
    const keyboard = Markup.inlineKeyboard([
        [
            Markup.button.callback(ctx.t('confirmations.buttons.alwaysConfirm'), `devops:always_confirm:${confirmationId}`),
            Markup.button.callback(ctx.t('confirmations.buttons.back'), `devops:always_cancel:${confirmationId}`),
        ]
    ]);
    await ctx.editMessageText(ctx.t('confirmations.createPermanentSshRule'), keyboard);
    await ctx.answerCbQuery();
});

bot.action(/^devops:always_confirm:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    const userId = ctx.state.accountId;
    if (!userId) {
        await ctx.answerCbQuery(ctx.t('confirmations.error'));
        return;
    }
    await ctx.answerCbQuery(ctx.t('confirmations.executing'));
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
            if (!output) output = ctx.t('confirmations.noOutput');
            await ctx.editMessageText(ctx.t('confirmations.sshAlwaysDoneMarkdown', { output: output.replace(/```/g, "'''") }), { parse_mode: 'Markdown' }).catch(() => {
                ctx.editMessageText(ctx.t('confirmations.sshAlwaysDone', { output })).catch(() => {});
            });
        } catch (err: any) {
            const msg = err?.response?.data?.error || err?.message || ctx.t('confirmations.error');
            await ctx.editMessageText(ctx.t('confirmations.genericError', { error: msg })).catch(() => {});
        }
    })();
});

bot.action(/^devops:always_cancel:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    // Just go back — re-show would need original text, just leave as is
    await ctx.editMessageText(ctx.t('confirmations.buttonsRestored')).catch(() => {});
});

bot.action(/^devops:review:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    const userId = ctx.state.accountId;
    if (!userId) {
        await ctx.answerCbQuery(ctx.t('confirmations.error'));
        return;
    }
    await ctx.answerCbQuery(ctx.t('confirmations.sendingForReview'));
    (async () => {
        try {
            const cmd = pendingPcCommandTexts.get(`devops:${confirmationId}`) || ctx.t('confirmations.unknownCommand');
            const liteResp = await axios.post(
                `${BACKEND_API_BASE_URL}/internal/ai/lite`,
                {
                    prompt_type: 'review_ssh',
                    command: cmd,
                    user_id: userId,
                },
                { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` }, timeout: 30000 }
            );
            const verdict = liteResp.data?.reply_text || liteResp.data?.text || ctx.t('confirmations.noResponse');
            await ctx.reply(ctx.t('confirmations.reviewResult', { verdict }));
        } catch (err: any) {
            const msg = err?.response?.data?.message || err?.message || ctx.t('confirmations.error');
            await ctx.reply(ctx.t('confirmations.reviewFailed', { error: msg })).catch(() => {});
        }
    })();
});

bot.action(/^devops:creds_apply:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    const userId = ctx.state.accountId;
    if (!userId) {
        await ctx.answerCbQuery(ctx.t('confirmations.error'));
        return;
    }
    await ctx.answerCbQuery(ctx.t('confirmations.applying'));
    (async () => {
        try {
            const resp = await axios.post(
                `${BACKEND_API_BASE_URL}/internal/devops/approve`,
                { confirmation_id: confirmationId, approved: true, user_id: userId },
                { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` }, timeout: 120000 }
            );
            const result = resp.data?.result;
            const output = typeof result === 'string' ? result.slice(0, 500) : ctx.t('confirmations.done');
            await ctx.editMessageText(ctx.t('confirmations.credentialsUpdated', { output })).catch(() => {});
        } catch (err: any) {
            const msg = err?.response?.data?.error || err?.message || ctx.t('confirmations.error');
            await ctx.editMessageText(ctx.t('confirmations.genericError', { error: msg })).catch(() => {});
        }
    })();
});

bot.action(/^devops:creds_reject:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    const userId = ctx.state.accountId;
    if (!userId) {
        await ctx.answerCbQuery(ctx.t('confirmations.error'));
        return;
    }
    await ctx.answerCbQuery(ctx.t('confirmations.rejected'));
    try {
        await rejectWithOptionalComment('/internal/devops/approve', confirmationId, userId);
        await ctx.editMessageText(ctx.t('confirmations.credentialsRejected'));
    } catch {
        await ctx.editMessageText(ctx.t('confirmations.rejectFailedShort')).catch(() => {});
    }
});

bot.action(/^devops:creds_reject_comment:(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    await requestRejectionComment(ctx, '/internal/devops/approve', confirmationId, ctx.t('confirmations.labels.credentialsUpdate'));
});

// ───────────────────────────────────────────────────────────────────────────
// Rich streaming helper (Bot API 10.1+: sendRichMessageDraft / sendRichMessage)
// Реализует вариант C: сначала стримим RichBlockThinking ("Думаю..."),
// когда пошёл обычный текст — замораживаем thinking и стримим только RichBlockParagraph.
// На done — финальный sendRichMessage, чтобы сообщение осталось в истории.
// ───────────────────────────────────────────────────────────────────────────

// Базовый throttle. Подобран эмпирически: 4 апдейта/сек ловят 429,
// 2 апдейта/сек (~500мс) работают стабильно для длинных ответов.
const STREAM_FLUSH_BASE_INTERVAL_MS = 500;
const STREAM_FLUSH_MAX_INTERVAL_MS = 5000;   // потолок адаптивного throttle
const STREAM_MIN_DELTA_CHARS = 30;            // минимальный прирост текста для мгновенного flush
const STREAM_DRAFT_TEXT_LIMIT = 4000;         // потолок суммарной длины draft-HTML (теги + контент)
const STREAM_FINAL_TEXT_LIMIT = 4000;         // потолок для одного финального persisted-сообщения (резерв под HTML-теги)
const STREAM_DEBUG_LOG = process.env.TG_STREAM_DEBUG === '1';

type RichStreamPhase = 'idle' | 'thinking' | 'answering';

/**
 * Разбить текст на куски ≤ maxLen, предпочитая разрез по `\n`.
 * Копия splitTextForTelegram из backend-api/src/services/telegram-send.ts
 * (бот и API — отдельные процессы, импорт между ними невозможен).
 */
const splitTextForFinal = (text: string, maxLen = 4000): string[] => {
    const source = typeof text === 'string' ? text : String(text ?? '');
    if (source.length <= maxLen) return [source];

    const chunks: string[] = [];
    let remaining = source;
    while (remaining.length > maxLen) {
        let cut = remaining.lastIndexOf('\n', maxLen);
        if (cut <= 0) cut = maxLen;
        chunks.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut).replace(/^\n/, '');
    }
    if (remaining) chunks.push(remaining);
    return chunks;
};

/**
 * Экранирование спецсимволов Rich HTML.
 * Обязательно — иначе знак < или & в ответе сломает HTML-парсер Telegram.
 */
function escapeRichHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function isSafeRichUrl(url: string): boolean {
    return /^(https?:|mailto:|tel:|tg:\/\/)/i.test(url.trim());
}

function cleanCodeLanguage(lang?: string): string {
    return (lang || '')
        .split(/\s+/)[0]
        .replace(/[^a-zA-Z0-9_+#.-]/g, '')
        .slice(0, 40);
}

function createTelegramRichMarkdownRenderer(): Renderer {
    const renderer = new Renderer();
    const inline = (tokens: any[]) => renderer.parser.parseInline(tokens);
    const block = (tokens: any[]) => renderer.parser.parse(tokens);
    const listItemContent = (tokens: any[]) => tokens
        .map(token => {
            if ((token?.type === 'paragraph' || token?.type === 'text') && Array.isArray(token.tokens)) {
                return inline(token.tokens);
            }
            return block([token]);
        })
        .join('');

    renderer.code = ({ text, lang }) => {
        const language = cleanCodeLanguage(lang);
        const classAttr = language ? ` class="language-${escapeRichHtml(language)}"` : '';
        return `<pre><code${classAttr}>${escapeRichHtml(text)}</code></pre>\n`;
    };

    renderer.blockquote = ({ tokens }) => `<blockquote>${block(tokens)}</blockquote>\n`;
    renderer.heading = ({ tokens, depth }) => {
        const level = Math.min(Math.max(depth, 1), 6);
        return `<h${level}>${inline(tokens)}</h${level}>\n`;
    };
    renderer.hr = () => '<hr/>\n';
    renderer.paragraph = ({ tokens }) => `<p>${inline(tokens)}</p>\n`;
    renderer.strong = ({ tokens }) => `<b>${inline(tokens)}</b>`;
    renderer.em = ({ tokens }) => `<i>${inline(tokens)}</i>`;
    renderer.codespan = ({ text }) => `<code>${escapeRichHtml(text)}</code>`;
    renderer.br = () => '<br>';
    renderer.del = ({ tokens }) => `<s>${inline(tokens)}</s>`;
    renderer.text = ({ text }) => escapeRichHtml(text);
    renderer.html = ({ text, block }) => block
        ? `<p>${escapeRichHtml(text)}</p>\n`
        : escapeRichHtml(text);
    renderer.image = ({ href, text }) => {
        const alt = text?.trim() || href;
        if (!href || !isSafeRichUrl(href)) return escapeRichHtml(alt || '');
        return `<a href="${escapeRichHtml(href)}">${escapeRichHtml(alt)}</a>`;
    };
    renderer.link = ({ href, tokens }) => {
        const label = inline(tokens);
        if (!href || !isSafeRichUrl(href)) return label;
        return `<a href="${escapeRichHtml(href)}">${label}</a>`;
    };

    renderer.list = ({ ordered, start, items }) => {
        const tag = ordered ? 'ol' : 'ul';
        const startAttr = ordered && typeof start === 'number' && start > 1
            ? ` start="${start}"`
            : '';
        const body = items.map(item => renderer.listitem(item)).join('');
        return `<${tag}${startAttr}>${body}</${tag}>\n`;
    };
    renderer.listitem = (item) => {
        const checkbox = item.task
            ? `<code>${item.checked ? 'x' : ' '}</code> `
            : '';
        return `<li>${checkbox}${listItemContent(item.tokens)}</li>`;
    };

    renderer.table = ({ header, rows }) => {
        const head = `<tr>${header.map(cell => renderer.tablecell({ ...cell, header: true })).join('')}</tr>`;
        const body = rows
            .map(row => `<tr>${row.map(cell => renderer.tablecell({ ...cell, header: false })).join('')}</tr>`)
            .join('');
        return `<table>${head}${body}</table>\n`;
    };
    renderer.tablecell = ({ tokens, header, align }) => {
        const tag = header ? 'th' : 'td';
        const alignAttr = align ? ` align="${align}"` : '';
        return `<${tag}${alignAttr}>${inline(tokens)}</${tag}>`;
    };

    return renderer;
}

function markdownToTelegramRichHtml(text: string): string {
    const markdown = text.trim();
    if (!markdown) return '';

    try {
        const html = marked.parse(markdown, {
            async: false,
            gfm: true,
            breaks: true,
            renderer: createTelegramRichMarkdownRenderer(),
        });
        return typeof html === 'string' ? html.trim() : escapeRichHtml(markdown);
    } catch (err: any) {
        console.warn('[tg][rich-stream] markdown render failed:', formatSafeError(err));
        return `<p>${escapeRichHtml(markdown)}</p>`;
    }
}

/**
 * Контейнер состояния одного стримящегося ответа.
 * Создаётся на каждый вызов processUserTextThroughAi, живёт до done/error.
 */
class RichStreamSession {
    private chatId: number;
    private telegram: any; // ctx.telegram
    private draftId: number;
    private messageThreadId: number | null = null;
    private phase: RichStreamPhase = 'idle';

    private reasoningBuf = '';
    private lastToolStatus = '';
    private intermediateBuf = '';
    private textBuf = '';

    private lastFlushAt = 0;
    private lastTextLenAtFlush = 0;
    private nextAllowedFlushAt = 0;
    private flushTimer: NodeJS.Timeout | null = null;

    // AIMD-адаптивный throttle: при 429 интервал растёт (multiplicative decrease),
    // при N успешных flush подряд — плавно возвращается к базе (additive increase).
    private currentFlushIntervalMs = STREAM_FLUSH_BASE_INTERVAL_MS;
    private consecutiveOkFlushes = 0;

    private draftFailed = false;     // если callApi упал — переключаемся в fallback (safeReply)
    private draftShownAtLeastOnce = false;
    private finalized = false;

    public messageId: number | null = null; // message_id финального persisted сообщения

    constructor(telegram: any, chatId: number, messageThreadId?: number | null) {
        this.telegram = telegram;
        this.chatId = chatId;
        if (messageThreadId && Number.isFinite(messageThreadId)) {
            this.messageThreadId = messageThreadId;
        }
        // Уникальный draft_id — timestamp + random, чтобы черновики разных запросов не конфликтовали.
        this.draftId = Date.now();
    }

    /** Вызов sendRichMessageDraft с HTML. Тихо гасит ошибки → fallback. */
    private async callDraft(html: string): Promise<void> {
        if (this.draftFailed || this.finalized) return;
        const payload: any = {
            chat_id: this.chatId,
            draft_id: this.draftId,
            rich_message: { html },
        };
        if (this.messageThreadId) {
            payload.message_thread_id = this.messageThreadId;
        }
        try {
            if (STREAM_DEBUG_LOG) {
                console.log('[tg][rich-stream] sendRichMessageDraft html_len=', html.length, 'interval=', this.currentFlushIntervalMs, 'ms');
            }
            await this.telegram.callApi('sendRichMessageDraft', payload);
            this.draftShownAtLeastOnce = true;

            // AIMD additive increase: после каждого успешного flush плавно возвращаем интервал к базе.
            this.consecutiveOkFlushes++;
            if (this.consecutiveOkFlushes >= 4 && this.currentFlushIntervalMs > STREAM_FLUSH_BASE_INTERVAL_MS) {
                this.currentFlushIntervalMs = Math.max(
                    STREAM_FLUSH_BASE_INTERVAL_MS,
                    this.currentFlushIntervalMs - 100
                );
                this.consecutiveOkFlushes = 0;
                if (STREAM_DEBUG_LOG) {
                    console.log('[tg][rich-stream] AIMD decrease interval →', this.currentFlushIntervalMs, 'ms');
                }
            }
        } catch (err: any) {
            const description = err?.response?.description || err?.description || err?.message || String(err);

            // Умный back-off: Telegram вернул 429 Too Many Requests.
            // AIMD multiplicative decrease: удваиваем интервал + учитываем retry_after.
            if (description.toLowerCase().includes('too many requests')) {
                const retryAfter = Number(err?.response?.parameters?.retry_after) || 3;
                const newInterval = Math.min(
                    STREAM_FLUSH_MAX_INTERVAL_MS,
                    Math.max(this.currentFlushIntervalMs * 2, retryAfter * 1000 + 500)
                );
                console.warn(`[tg][rich-stream] Rate limit hit! retry_after=${retryAfter}s, interval ${this.currentFlushIntervalMs}ms → ${newInterval}ms`);
                this.currentFlushIntervalMs = newInterval;
                this.consecutiveOkFlushes = 0;
                this.nextAllowedFlushAt = Date.now() + (retryAfter * 1000) + 500;
                // НЕ ставим draftFailed — пережидаем и продолжаем.
                return;
            }

            console.error('[CRITICAL][tg][rich-stream] sendRichMessageDraft error:', description);
            this.draftFailed = true;
            this.clearTimer();
        }
    }

    private escapeHtml(text: string): string {
        return escapeRichHtml(text);
    }

    /**
     * Генерируем Rich HTML строку.
     *
     * Архитектура «эфемерный лог»:
     *  - В ЧЕРНОВИКЕ (isFinal=false) показываем всё: <tg-thinking>, статусы тулзов
     *    курсивом, intermediate-блок, печатающийся textBuf.
     *  - В ФИНАЛЕ (isFinal=true) выкидываем reasoning / toolStatus / intermediate
     *    ПОЛНОСТЬЮ — остаётся только чистый textBuf (ответ модели).
     *    Чат после генерации остаётся чистым, никаких blockquote expandable.
     *
     * Динамическая обрезка draft'а: суммарная длина HTML ≤ STREAM_DRAFT_TEXT_LIMIT.
     * Приоритет — textBuf (всегда целиком насколько влезает), остаток делится между
     * reasoning и toolStatus. Если не влезает — режем с «…».
     */
    private buildRichHtml(isFinal: boolean = false): string {
        // ── ФИНАЛ ─────────────────────────────────────────────────────────────
        // Только чистый ответ модели. Никаких эфемерных буферов.
        if (isFinal) {
            const safeText = markdownToTelegramRichHtml(this.textBuf.slice(0, STREAM_FINAL_TEXT_LIMIT));
            return safeText || '';
        }

        // ── ЧЕРНОВИК ──────────────────────────────────────────────────────────
        const PART_OVERHEAD = 80;   // запас на теги вокруг каждой части
        const STATUS_OVERHEAD = 16; // <i>🔧 ...</i><br> на одну строку статуса

        // Сначала рендерим textBuf (приоритет). Если он один длинный — режем.
        const textBudget = STREAM_DRAFT_TEXT_LIMIT - 600; // резервируем минимум под reasoning/status
        const textPart = markdownToTelegramRichHtml(this.textBuf.slice(0, textBudget)) || '<p>...</p>';

        // Остаток бюджета делим между reasoning и toolStatus/intermediate.
        let remaining = STREAM_DRAFT_TEXT_LIMIT - textPart.length - PART_OVERHEAD;
        if (remaining < 0) remaining = 0;

        // Сначала tool_status и intermediate (короткие, важные для понимания «что делает бот»).
        const statusLines: string[] = [];
        if (this.lastToolStatus.trim()) {
            // Показываем только ОДНУ последнюю строку статуса — индикатор «сейчас делаю X».
            const lineHtml = `<i>🔧 ${this.escapeHtml(this.lastToolStatus.trim())}</i><br>`;
            if (remaining >= lineHtml.length + STATUS_OVERHEAD) {
                statusLines.push(lineHtml);
                remaining -= lineHtml.length;
            }
        }

        // intermediate НЕ рендерим отдельным блоком — его контент всё равно
        // попадёт в textBuf через stream_token / reply_text (fullDbHistory).
        // Отдельный blockquote был бы чистым дублем.
        // (intermediateBuf остаётся только для hasContent() и reset-логики.)

        // Reasoning — что осталось. Показываем ХВОСТ (последние мысли важнее для «думаю…»).
        let thinkingPart = '';
        if (this.reasoningBuf.trim() && remaining > 60) {
            const budget = Math.max(0, remaining - 60);
            const source = this.reasoningBuf.length > budget
                ? '…' + this.reasoningBuf.slice(-budget)   // хвост с многоточием
                : this.reasoningBuf;
            thinkingPart = `<tg-thinking>${this.escapeHtml(source)}</tg-thinking>`;
        }

        // Порядок: thinking → статусы → основной текст.
        // Telegram показывает их последовательно в одном сообщении.
        let html = '';
        if (thinkingPart) html += thinkingPart;
        if (statusLines.length) html += statusLines.join('');
        html += textPart;

        return html;
    }

    /** Отправка черновика. */
    private async flush(): Promise<void> {
        if (this.draftFailed || this.finalized) return;

        // Draft показывается, если есть ЛЮБОЙ контент (включая tool_status/intermediate),
        // не только когда phase !== 'idle'. Это важно: tool_status может прийти до reasoning.
        const hasAny =
            this.phase !== 'idle' ||
            this.reasoningBuf.trim() ||
            this.lastToolStatus.trim() ||
            this.intermediateBuf.trim() ||
            this.textBuf.trim();
        if (hasAny) {
            await this.callDraft(this.buildRichHtml(false));
        }

        this.lastFlushAt = Date.now();
        // Сохраняем суммарную длину всех буферов для корректной дельты в maybeFlush.
        this.lastTextLenAtFlush = this.textBuf.length + this.lastToolStatus.length
            + this.intermediateBuf.length + this.reasoningBuf.length;
    }

    private scheduleFlush(): void {
        if (this.draftFailed || this.finalized) return;
        if (this.flushTimer) return;
        const now = Date.now();
        const cooldownDelay = Math.max(0, this.nextAllowedFlushAt - now);
        const elapsed = now - this.lastFlushAt;
        const throttleDelay = Math.max(0, this.currentFlushIntervalMs - elapsed);
        const delay = Math.max(cooldownDelay, throttleDelay);
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush().catch(err => console.warn('[tg][rich-stream] flush error:', formatSafeError(err)));
        }, delay);
    }

    private clearTimer(): void {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
    }

    /** Получен reasoning_token. */
    onReasoning(text: string): void {
        if (this.draftFailed || this.finalized) return;
        // Если уже в answering — thinking заморожен, больше не трогаем (вариант C).
        if (this.phase === 'answering') return;
        this.phase = 'thinking';
        this.reasoningBuf += text;
        this.maybeFlush();
    }

    /**
     * Получен tool_status (например «Выполняю команду на ПК…»).
     * Эфемерный: показываем только ПОСЛЕДНИЙ статус как индикатор «сейчас делаю это».
     * Не накапливаем историю (иначе 10 tool calls = 10 строк шума в draft).
     * В финале выкидывается полностью.
     */
    onToolStatus(text: string): void {
        if (this.draftFailed || this.finalized) return;
        const line = typeof text === 'string' ? text.trim() : '';
        if (!line) return;
        // Запоминаем только последний статус — пользователь видит «сейчас делаю X»,
        // а не всю историю вызовов.
        this.lastToolStatus = line;
        this.maybeFlush();
    }

    /**
     * Получен intermediate-текст модели (между tool-call итерациями).
     * Эфемерный: в финале выкидывается.
     * Не пушим в textBuf, чтобы не портить чистый финальный ответ.
     */
    onIntermediate(text: string): void {
        if (this.draftFailed || this.finalized) return;
        const piece = typeof text === 'string' ? text.trim() : '';
        if (!piece) return;
        this.intermediateBuf += (this.intermediateBuf ? '\n\n' : '') + piece;
        // Инструмент отработал, модель продолжает рассуждать — статус больше не актуален.
        this.lastToolStatus = '';
        this.maybeFlush();
    }

    /** Получен stream_token (обычный текст). */
    onToken(text: string): void {
        if (this.draftFailed || this.finalized) return;
        // Первый token → переключаемся в answering.
        // Thinking остаётся в буфере и попадёт в финал, но в draft больше не обновляется.
        this.phase = 'answering';
        // Модель начала финальный ответ — статус/intermediate больше не показываем.
        this.lastToolStatus = '';
        this.textBuf += text;
        this.maybeFlush();
    }

    /** Throttle: мгновенный flush, если прошло >= INTERVAL или накопилось >= MIN_DELTA. */
    private maybeFlush(): void {
        if (this.draftFailed || this.finalized) return;
        const now = Date.now();
        // Телеграм сказал «подожди» — и мы ждём. Не спорим с тем, кто старше по протоколу.
        if (now < this.nextAllowedFlushAt) {
            this.scheduleFlush();
            return;
        }
        const sinceFlush = now - this.lastFlushAt;
        // Дельта по всем буферам — tool_status/intermediate тоже должны триггерить flush.
        const totalLen = this.textBuf.length + this.lastToolStatus.length
            + this.intermediateBuf.length + this.reasoningBuf.length;
        const delta = totalLen - this.lastTextLenAtFlush;
        if (sinceFlush >= this.currentFlushIntervalMs || delta >= STREAM_MIN_DELTA_CHARS) {
            this.clearTimer();
            this.flush().catch(err => console.warn('[tg][rich-stream] flush error:', formatSafeError(err)));
        } else {
            this.scheduleFlush();
        }
    }

    /**
     * Финализация: вызвать sendRichMessage с HTML.
     * Возвращает true при успехе, false при fallback.
     *
     * Если textBuf длиннее STREAM_FINAL_TEXT_LIMIT — дробим на несколько
     * persisted-сообщений (аналог splitTextForTelegram, но для Rich HTML).
     * Каждое сообщение рендерится отдельно через marked.
     */
    async finalize(): Promise<boolean> {
        if (this.finalized) return this.messageId !== null;
        this.finalized = true;
        this.clearTimer();

        if (!TG_USE_RICH_STREAMING) return false;

        // Эфемерная архитектура: финал содержит ТОЛЬКО textBuf.
        // reasoning / toolStatus / intermediate выкидываются.
        // Если textBuf пуст (модель не дала ответа) — финалить нечего, fallback.
        if (!this.textBuf.trim()) return false;

        // Дробим textBuf на куски ≤ STREAM_FINAL_TEXT_LIMIT, режем по \n
        // (splitTextForFinal — локальная копия splitTextForTelegram).
        // Каждый кусок конвертируется в Rich HTML отдельно и отправляется
        // как самостоятельное persisted-сообщение.
        const rawChunks = splitTextForFinal(this.textBuf, STREAM_FINAL_TEXT_LIMIT);
        if (STREAM_DEBUG_LOG) {
            console.log(`[tg][rich-stream] finalize: textBuf len=${this.textBuf.length}, chunks=${rawChunks.length}`);
        }

        try {
            for (let i = 0; i < rawChunks.length; i++) {
                const chunkHtml = markdownToTelegramRichHtml(rawChunks[i]);
                if (!chunkHtml) continue;
                const payload: any = {
                    chat_id: this.chatId,
                    rich_message: { html: chunkHtml },
                };
                if (this.messageThreadId) {
                    payload.message_thread_id = this.messageThreadId;
                }
                if (STREAM_DEBUG_LOG) {
                    console.log(`[tg][rich-stream] sendRichMessage chunk ${i + 1}/${rawChunks.length}, html_len=${chunkHtml.length}`);
                }
                const result = await this.telegram.callApi('sendRichMessage', payload);
                // message_id первого сообщения используем для бинда в БД.
                if (i === 0) {
                    this.messageId = Number.isFinite(Number(result?.message_id)) ? Number(result.message_id) : null;
                }
            }
            return this.messageId !== null;
        } catch (err: any) {
            const description = err?.response?.description || err?.description || err?.message || String(err);
            console.error(`[CRITICAL][tg][rich-stream] sendRichMessage error:`, description);
            return false;
        }
    }

    /** Получал ли сессия хотя бы один токен (для решения нужен ли rich pipeline). */
    hasContent(): boolean {
        return Boolean(this.reasoningBuf.trim())
            || Boolean(this.lastToolStatus.trim())
            || Boolean(this.intermediateBuf.trim())
            || Boolean(this.textBuf.trim());
    }

    /** Полный текст ответа (для safeReply в fallback). */
    getText(): string {
        return this.textBuf;
    }
}

const processUserTextThroughAi = async (
    ctx: any,
    rawText: string,
    options?: {
        forcePro?: boolean;
        persistUserText?: string;
        onAssistantReply?: (assistantText: string) => Promise<void> | void;
        suppressFinalReply?: boolean;
        countAsUserMessage?: boolean;
        skipHistory?: boolean;
        documents?: Array<{ filename: string; base64: string }>;
    }
) => {
    const userId = ctx.state.accountId;
    if (!userId) return null;

    let userText = rawText.trim();
    const hasDocuments = Array.isArray(options?.documents) && options!.documents!.length > 0;
    // Allow empty text when documents are attached (placeholder for AI).
    if (!userText && !hasDocuments) {
        if (!options?.suppressFinalReply) {
            await ctx.reply(ctx.t('generated.emptyMessage'));
        }
        return null;
    }
    const forceProRoute = Boolean(options?.forcePro) || userText.startsWith('!!!');
    if (forceProRoute && !options?.forcePro) {
        userText = userText.replace(/^!{3,}/, '').trim();
    }
    if (forceProRoute && !userText && !hasDocuments) {
        if (!options?.suppressFinalReply) {
            await ctx.reply(ctx.t('generated.missingQueryAfterExclamation'));
        }
        return null;
    }
    // If no text but documents present — use a neutral placeholder so backend "empty_text" check passes.
    if (!userText && hasDocuments) {
        userText = ctx.t('ai.documentsInstruction');
    }
    const userTextForHistory = options?.persistUserText?.trim() || userText;

    const userName = (ctx.state.userName as string | undefined) || ctx.t('ai.defaultUserName');
    const userRecord = await getUser(userId);
    if (!userRecord) {
        if (!options?.suppressFinalReply) {
            await ctx.reply(ctx.t('common.userMissing'));
        }
        return null;
    }

    try {
        await ctx.sendChatAction('typing');
        const userChatId = Number.isFinite(Number(ctx.chat?.id)) ? Math.floor(Number(ctx.chat?.id)) : null;
        const userMessageId = Number.isFinite(Number(ctx.message?.message_id)) ? Math.floor(Number(ctx.message?.message_id)) : null;

        // Rich streaming session (Bot API 10.1+). Если TG_USE_RICH_STREAMING выключен —
        // сессия всё равно создается (для согласованности), но finalize() вернёт false → fallback на safeReply.
        const threadId = Number.isFinite(Number(ctx.message?.message_thread_id))
            ? Math.floor(Number(ctx.message?.message_thread_id))
            : null;
        const richStream = (TG_USE_RICH_STREAMING && userChatId && !options?.suppressFinalReply)
            ? new RichStreamSession(ctx.telegram, userChatId, threadId)
            : null;

        const backend = await runBackendAiStream(userId, userText, {
            forcePro: forceProRoute,
            persistUserText: userTextForHistory,
            countAsUserMessage: options?.countAsUserMessage,
            skipHistory: options?.skipHistory,
            userTelegramChatId: userChatId,
            userTelegramMessageId: userMessageId,
            assistantTelegramChatId: userChatId,
            documents: options?.documents
        }, {
            onIntermediate: async (stepText) => {
                if (options?.suppressFinalReply) return;
                // Эфемерный rich-path: пушим в буфер, в финале выкидывается.
                if (richStream) {
                    richStream.onIntermediate(stepText);
                    return;
                }
                // Fallback (rich выключен или уже упал): старый режим — отдельным сообщением.
                try {
                    await ctx.reply(stepText.slice(0, 4096));
                } catch {
                    // ignore
                }
            },
            onToolStatus: async (statusText) => {
                if (options?.suppressFinalReply) return;
                // Эфемерный rich-path: накапливается в черновике серым курсивом, в финале исчезает.
                if (richStream) {
                    richStream.onToolStatus(statusText);
                    return;
                }
                // Fallback: отдельным сообщением (как раньше).
                try {
                    await ctx.reply(`_${statusText}_`);
                } catch {
                    // ignore
                }
            },
            onStreamToken: async (text) => {
                if (richStream) richStream.onToken(text);
            },
            onReasoningStream: async (text) => {
                if (richStream) richStream.onReasoning(text);
            },
            onDesktopAction: async (action) => {
                if (action?.action === 'pc_command_confirmation' && action?.value?.confirmation_id) {
                    const confirmationId = action.value.confirmation_id;
                    const command = action.value.command || '';
                    pendingPcCommandTexts.set(confirmationId, command);
                    const preview = command.slice(0, 200);
                    const keyboard = Markup.inlineKeyboard([
                        [
                            Markup.button.callback(ctx.t('confirmations.buttons.allow'), `pcconfirm:allow:${confirmationId}`),
                            Markup.button.callback(ctx.t('confirmations.buttons.alwaysAllow'), `pcconfirm:always:${confirmationId}`),
                        ],
                        [
                            Markup.button.callback(ctx.t('confirmations.buttons.review'), `pcconfirm:review:${confirmationId}`),
                            Markup.button.callback(ctx.t('admin.buttons.reject'), `pcconfirm:reject:${confirmationId}`),
                        ]
                        ,
                        [
                            Markup.button.callback(ctx.t('confirmations.buttons.rejectWithComment'), `pcconfirm:reject_comment:${confirmationId}`),
                        ]
                    ]);
                    const escapedCmd = preview.replace(/`/g, '\\`');
                    try {
                        await ctx.reply(
                            ctx.t('generated.pcCommandConfirmation', { escapedCmd: escapedCmd }),
                            { parse_mode: 'Markdown', ...keyboard }
                        );
                    } catch {
                        try {
                            await ctx.reply(ctx.t('generated.pcCommandConfirmationPreview', { preview: preview }), keyboard);
                        } catch {
                            // ignore
                        }
                    }
                }
                if (action?.action === 'browser_action_confirmation' && action?.value?.confirmation_id) {
                    const confirmationId = action.value.confirmation_id;
                    const actionType = action.value.action_type === 'open'
                        ? 'open'
                        : action.value.action_type === 'fill'
                            ? 'fill'
                            : 'click';
                    const actionLabel = ctx.t(`browserConfirmation.actions.${actionType}`);
                    const target = `${action.value.url || action.value.description || ''}`.slice(0, 1000);
                    const textPreview = actionType === 'fill' && typeof action.value.text === 'string'
                        ? action.value.text.slice(0, 800)
                        : '';
                    const origin = actionType !== 'open' && typeof action.value.origin === 'string'
                        ? action.value.origin
                        : '';
                    pendingPcCommandTexts.set(confirmationId, `browser:${actionLabel}: ${target}`);

                    const keyboard = Markup.inlineKeyboard([
                        [
                            Markup.button.callback(ctx.t('confirmations.buttons.allow'), `pcconfirm:allow:${confirmationId}`),
                            Markup.button.callback(ctx.t('admin.buttons.reject'), `pcconfirm:reject:${confirmationId}`),
                        ],
                        ...(origin ? [[
                            Markup.button.callback(ctx.t('browserConfirmation.allowSiteSession'), `pcconfirm:site:${confirmationId}`),
                        ]] : []),
                        [
                            Markup.button.callback(ctx.t('confirmations.buttons.rejectWithComment'), `pcconfirm:reject_comment:${confirmationId}`),
                        ]
                    ]);

                    console.log('[tg][desktop_action] browser_action_confirmation', {
                        confirmationId,
                        actionType,
                    });
                    try {
                        let message = ctx.t('browserConfirmation.prompt', { action: actionLabel, target });
                        if (textPreview) {
                            message += ctx.t('browserConfirmation.textPreview', { text: textPreview });
                        }
                        if (origin) {
                            message += ctx.t('browserConfirmation.currentSite', { site: origin });
                        }
                        await ctx.reply(message, keyboard);
                    } catch (err: any) {
                        console.warn('[tg][desktop_action] browser_action reply failed:', formatSafeError(err));
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
                        ? ctx.t(mode === 'append' ? 'fileConfirmation.writeAppendTitle' : 'fileConfirmation.writeTitle')
                        : ctx.t('fileConfirmation.readTitle');

                    const sizeLine = isWrite && sizeBytes > 0
                        ? ctx.t('fileConfirmation.sizeLine', { size: (sizeBytes / 1024).toFixed(1) })
                        : '';
                    const confirmationQuestion = ctx.t(isWrite
                        ? 'fileConfirmation.allowWriteQuestion'
                        : 'fileConfirmation.allowReadQuestion');

                    let msgText = `${titleIcon} ${titleText}\n\n${filePath}${sizeLine}`;
                    if (contentPreview) {
                        const preview = contentPreview.slice(0, 800).replace(/```/g, "'''");
                        msgText += `\n\n${preview}`;
                    }
                    msgText += `\n\n${confirmationQuestion}`;

                    const keyboardRows = [
                        [
                            Markup.button.callback(ctx.t(isWrite
                                ? 'fileConfirmation.buttons.write'
                                : 'fileConfirmation.buttons.read'), `fileconfirm:allow:${confirmationId}`),
                            Markup.button.callback(ctx.t('admin.buttons.reject'), `fileconfirm:reject:${confirmationId}`),
                        ],
                    ];
                    if (isWrite) {
                        keyboardRows.push([
                            Markup.button.callback(ctx.t('fileConfirmation.buttons.allowFolderSession'), `fileconfirm:workspace:${confirmationId}`),
                        ]);
                    }
                    keyboardRows.push([
                        Markup.button.callback(ctx.t('confirmations.buttons.rejectWithComment'), `fileconfirm:reject_comment:${confirmationId}`),
                    ]);
                    const keyboard = Markup.inlineKeyboard(keyboardRows);
                    console.log('[tg][desktop_action] file_action_confirmation', {
                        confirmationId,
                        actionType,
                        filePath
                    });
                    try {
                        await ctx.reply(msgText, keyboard);
                    } catch (err: any) {
                        console.warn('[tg][desktop_action] file_action reply failed:', formatSafeError(err));
                        try {
                            await ctx.reply(`${titleIcon} ${titleText}\n\n${filePath}${sizeLine}\n\n${confirmationQuestion}`, keyboard);
                        } catch (fallbackErr: any) {
                            console.warn('[tg][desktop_action] file_action fallback reply failed:', formatSafeError(fallbackErr));
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

                    let msgText = ctx.t('desktopActions.editFile.header', { filePath, startLine, endLine });
                    if (oldPreview) {
                        msgText += ctx.t('desktopActions.editFile.removing', { content: oldPreview.replace(/```/g, "'''") });
                    }
                    if (newPreview) {
                        msgText += ctx.t('desktopActions.editFile.adding', { content: newPreview.replace(/```/g, "'''") });
                    }
                    if (!newPreview && oldPreview) {
                        msgText += ctx.t('desktopActions.editFile.linesWillBeDeleted');
                    }
                    msgText += ctx.t('desktopActions.editFile.applyQuestion');

                    const keyboard = Markup.inlineKeyboard([
                        [
                            Markup.button.callback(ctx.t('generated.applyButton'), `fileconfirm:allow:${confirmationId}`),
                            Markup.button.callback(ctx.t('admin.buttons.reject'), `fileconfirm:reject:${confirmationId}`),
                        ],
                        [
                            Markup.button.callback(ctx.t('fileConfirmation.buttons.allowFolderSession'), `fileconfirm:workspace:${confirmationId}`),
                        ],
                        [
                            Markup.button.callback(ctx.t('confirmations.buttons.rejectWithComment'), `fileconfirm:reject_comment:${confirmationId}`),
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
                        console.warn('[tg][desktop_action] edit_file_lines reply failed:', formatSafeError(err));
                        try {
                            await ctx.reply(ctx.t('generated.fileEditConfirmation', { filePath: filePath, startLine: startLine, endLine: endLine }), keyboard);
                        } catch (fallbackErr: any) {
                            console.warn('[tg][desktop_action] edit_file_lines fallback reply failed:', formatSafeError(fallbackErr));
                            throw fallbackErr;
                        }
                    }
                }
                if (action?.action === 'webcam_capture_confirmation' && action?.value?.confirmation_id) {
                    const confirmationId = action.value.confirmation_id;
                    const purpose = action.value.purpose || ctx.t('desktopActions.webcam.defaultPurpose');
                    const cameraName = action.value.camera_name || 'default';

                    const keyboard = Markup.inlineKeyboard([
                        [
                            Markup.button.callback(ctx.t('generated.allowPhotoButton'), `pcconfirm:allow:${confirmationId}`),
                            Markup.button.callback(ctx.t('admin.buttons.reject'), `pcconfirm:reject:${confirmationId}`),
                        ],
                        [
                            Markup.button.callback(ctx.t('confirmations.buttons.rejectWithComment'), `pcconfirm:reject_comment:${confirmationId}`),
                        ]
                    ]);
                    console.log('[tg][desktop_action] webcam_capture_confirmation', {
                        confirmationId,
                        purpose,
                        cameraName
                    });
                    try {
                        await ctx.reply(
                            ctx.t('generated.webcamCaptureConfirmation', { cameraName: cameraName, purpose: purpose }),
                            { parse_mode: 'Markdown', ...keyboard }
                        );
                    } catch {
                        try {
                            await ctx.reply(ctx.t('generated.webcamCaptureConfirmationPlain', { cameraName: cameraName, purpose: purpose }), keyboard);
                        } catch {
                            // ignore
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
                    let msgText = ctx.t('desktopActions.ssh.confirmationMarkdown', { serverName, host, command: escapedCmd });
                    const keyboard = Markup.inlineKeyboard([
                        [
                            Markup.button.callback(ctx.t('confirmations.buttons.allow'), `devops:allow:${confirmationId}`),
                            Markup.button.callback(ctx.t('confirmations.buttons.alwaysAllow'), `devops:always:${confirmationId}`),
                        ],
                        [
                            Markup.button.callback(ctx.t('confirmations.buttons.review'), `devops:review:${confirmationId}`),
                            Markup.button.callback(ctx.t('admin.buttons.reject'), `devops:reject:${confirmationId}`),
                        ],
                        [
                            Markup.button.callback(ctx.t('confirmations.buttons.rejectWithComment'), `devops:reject_comment:${confirmationId}`),
                        ]
                    ]);
                    try {
                        await ctx.reply(msgText, { parse_mode: 'Markdown', ...keyboard });
                    } catch {
                        try {
                            await ctx.reply(ctx.t('generated.sshCommandConfirmation', { serverName: serverName, host: host, preview: preview }), keyboard);
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
                            Markup.button.callback(ctx.t('generated.applyButton'), `devops:creds_apply:${confirmationId}`),
                            Markup.button.callback(ctx.t('admin.buttons.reject'), `devops:creds_reject:${confirmationId}`),
                        ],
                        [
                            Markup.button.callback(ctx.t('confirmations.buttons.rejectWithComment'), `devops:creds_reject_comment:${confirmationId}`),
                        ]
                    ]);
                    try {
                        await ctx.reply(
                            ctx.t('generated.updateCredentialsConfirmation', { serverName: serverName, reason: reason }),
                            { parse_mode: 'Markdown', ...keyboard }
                        );
                    } catch {
                        try {
                            await ctx.reply(ctx.t('generated.updateCredentialsConfirmationPlain', { serverName: serverName, reason: reason }), keyboard);
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
                            Markup.button.callback(ctx.t('generated.sendButton'), `email:allow:${confirmationId}`),
                            Markup.button.callback(ctx.t('admin.buttons.reject'), `email:reject:${confirmationId}`),
                        ],
                        [
                            Markup.button.callback(ctx.t('confirmations.buttons.rejectWithComment'), `email:reject_comment:${confirmationId}`),
                        ]
                    ]);
                    const fromLine = fromAddr ? ctx.t('desktopActions.email.fromLine', { address: fromAddr }) : '';
                    const msgText = ctx.t('desktopActions.email.confirmationMarkdown', {
                        fromLine,
                        to: toAddr,
                        subject,
                        body: bodyPreview.replace(/```/g, "'''")
                    });
                    try {
                        await ctx.reply(msgText, { parse_mode: 'Markdown', ...keyboard });
                    } catch {
                        try {
                            await ctx.reply(ctx.t('generated.emailSendConfirmation', { fromLine: fromLine, toAddr: toAddr, subject: subject, bodyPreview: bodyPreview }), keyboard);
                        } catch {
                            // ignore
                        }
                    }
                }
                if (action?.action === 'visual_click_confirmation' && action?.value?.confirmation_id) {
                    const confirmationId = action.value.confirmation_id;
                    const reason = action.value.reason || ctx.t('desktopActions.visualClick.defaultReason');
                    const btn = ctx.t(action.value.button === 'right'
                        ? 'desktopActions.visualClick.rightButton'
                        : 'desktopActions.visualClick.leftButton');
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
                            Markup.button.callback(ctx.t('generated.clickButton'), `vclick:allow:${confirmationId}`),
                            Markup.button.callback(ctx.t('admin.buttons.reject'), `vclick:reject:${confirmationId}`),
                        ]
                    ]);
                    const caption = ctx.t('desktopActions.visualClick.caption', { reason, x: xPct, y: yPct, button: btn });

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
                            console.error('[visual_click] failed to send preview photo:', formatSafeError(err));
                        }
                    }
                    if (!photoSent) {
                        try {
                            await ctx.reply(ctx.t('generated.genericConfirmation', { caption: caption }), keyboard);
                        } catch {
                            // ignore
                        }
                    }
                }
            }
        });

        const assistantText = typeof backend?.reply_text === 'string' && backend.reply_text.trim()
            ? backend.reply_text.trim()
            : ctx.t('ai.fallbackAnswer');
        let sentMessage: any = null;
        if (!options?.suppressFinalReply) {
            // Сначала пытаемся финализировать rich-stream черновик → persisted sendRichMessage.
            // Если не получилось (флаг выключен, не было ни одного токена, ошибка API) — fallback на safeReply.
            let richFinalized = false;
            if (richStream) {
                richFinalized = await richStream.finalize();
                if (richFinalized && richStream.messageId) {
                    sentMessage = { message_id: richStream.messageId };
                }
            }
            // Если rich-stream успешно финализирован — tool_user_messages уже были показаны
            // в эфемерном draft (🔧 статусы), НЕ дублируем их отдельными сообщениями.
            // Шлём только в fallback-режиме (rich выключен/упал).
            if (!richFinalized
                && Array.isArray(backend?.tool_user_messages)
                && backend.tool_user_messages.length > 0) {
                for (const msg of backend.tool_user_messages) {
                    const trimmed = typeof msg === 'string' ? msg.trim() : '';
                    if (trimmed) {
                        await ctx.reply(trimmed);
                    }
                }
            }
            if (!richFinalized) {
                sentMessage = await safeReply(ctx, assistantText);
            }
            // Уведомление о fallback модели (не rich-связанное) — оставляем как было.
            if (typeof backend?.model_fallback_notice === 'string' && backend.model_fallback_notice.trim()) {
                await ctx.reply(backend.model_fallback_notice.trim());
            }
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
                    console.warn('Не удалось привязать telegram_message_id к backend сообщению:', formatSafeError(bindErr));
                }
            }
            // Отправка сгенерированных изображений
            if (Array.isArray(backend?.generated_images) && backend.generated_images.length > 0) {
                for (const img of backend.generated_images) {
                    try {
                        const imageBuffer = Buffer.from(img.image_base64, 'base64');
                        await ctx.replyWithPhoto({ source: imageBuffer });
                    } catch (imgErr) {
                        console.error('Ошибка отправки сгенерированного изображения:', formatSafeError(imgErr));
                        await ctx.reply(ctx.t('generated.sendGeneratedImageFailed')).catch(() => {});
                    }
                }
            }
        }
        if (options?.onAssistantReply) {
            await options.onAssistantReply(assistantText);
        }
        return assistantText;
    } catch (err: any) {
        console.error('Ошибка backend-ai вызова:', formatSafeError(err));
        if (!options?.suppressFinalReply) {
            const localized = err?.localizedMessage || ctx.t('generated.systemErrorCheckBackendLogs');
            await ctx.reply(localized);
        }
        return null;
    }
    }

bot.on('text', async (ctx) => {
    const userId = ctx.state.accountId;
    if (!userId) return;

    const userText = ctx.message.text.trim();
    const directMessageTargetId = adminAiMessageFlow.get(userId);
    if (directMessageTargetId) {
        await withUserRequestLock(ctx, async () => {
            adminAiMessageFlow.delete(userId);
            await handleAiDirectMessage(ctx, directMessageTargetId, userText);
        });
        return;
    }

    const mailSetupFlow = mailSetupFlows.get(userId);
    if (mailSetupFlow) {
        const lowered = userText.toLowerCase();
        if ([ctx.t('common.cancelWord').toLowerCase(), 'отмена', 'cancel', '/cancel'].includes(lowered)) {
            mailSetupFlows.delete(userId);
            await ctx.reply(ctx.t('mail.setupCancelled'));
            await renderMailMenu(ctx, userId, 'reply');
            return;
        }

        if (mailSetupFlow.step === 'await_email') {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userText)) {
                return ctx.reply(ctx.t('mail.invalidEmailInteractive'));
            }
            mailSetupFlows.set(userId, {
                step: 'await_password',
                provider: mailSetupFlow.provider,
                email: userText
            });
            return ctx.reply(
                ctx.t('mail.enterPasswordInteractive', { email: userText }),
                Markup.inlineKeyboard([[Markup.button.callback(ctx.t('mail.buttons.cancel'), 'mail:setup_cancel')]])
            );
        }

        try {
            await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id);
        } catch (error) {
            console.warn('Не удалось удалить сообщение с mail credentials:', formatSafeError(error));
        }

        await ctx.reply(ctx.t('mail.checkingConnection'));
        try {
            await runBackendMailSetup(
                userId,
                mailSetupFlow.provider,
                mailSetupFlow.email,
                userText
            );
            mailSetupFlows.delete(userId);
            await ctx.reply(ctx.t('mail.connectedInteractive', { email: mailSetupFlow.email }));
            await renderMailMenu(ctx, userId, 'reply');
        } catch (error: any) {
            const code = axios.isAxiosError(error) ? error.response?.data?.error : '';
            const key = ['mail_auth_failed', 'mail_smtp_auth_failed'].includes(code)
                ? 'mail.authFailedInteractive'
                : ['mail_connection_failed', 'mail_smtp_connection_failed'].includes(code)
                    ? 'mail.connectionFailedInteractive'
                    : 'mail.setupError';
            await ctx.reply(
                ctx.t(key),
                Markup.inlineKeyboard([[Markup.button.callback(ctx.t('mail.buttons.cancel'), 'mail:setup_cancel')]])
            );
        }
        return;
    }

    const pendingRejection = pendingRejectionComments.get(userId);
    if (pendingRejection) {
        if (userText.toLowerCase() === '/cancel' || userText.toLowerCase() === 'отмена') {
            pendingRejectionComments.delete(userId);
            await ctx.reply(ctx.t('generated.rejectWithCommentCancelled'));
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
            await ctx.reply(ctx.t('generated.rejectedWithComment'));
        } catch {
            await ctx.reply(ctx.t('generated.rejectFailedExpiredOrProcessed'));
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
            return ctx.reply(ctx.t('link.invalidCodeFormat'));
        }
        try {
            const response = await axios.post(
                `${BACKEND_API_BASE_URL}/internal/link/verify`,
                { code, tg_id: ctx.state.telegramId, tg_username: ctx.from?.username || null },
                { headers: { Authorization: `Bearer ${BACKEND_INTERNAL_TOKEN}` } }
            );
            if (response.data?.ok) {
                return ctx.reply(
                    ctx.t('link.success'),
                    buildMenuTriggerKeyboard(ctx.t)
                );
            }
            return ctx.reply(ctx.t('link.failed'));
        } catch (err: any) {
            const msg = err?.response?.data?.error;
            if (msg === 'invalid_or_expired_code') {
                return ctx.reply(ctx.t('link.expired'));
            }
            if (msg === 'telegram_user_not_approved') {
                return ctx.reply(ctx.t('link.notApproved'));
            }
            if (msg === 'telegram_user_not_found') {
                return ctx.reply(ctx.t('link.userNotFound'));
            }
            if (msg === 'too_many_link_attempts') {
                const retryAfter = Math.max(1, Number(err?.response?.data?.retry_after) || 60);
                return ctx.reply(ctx.t('link.tooManyAttempts', { seconds: retryAfter }));
            }
            console.error('Link verify error:', formatSafeError(err));
            return ctx.reply(ctx.t('link.error'));
        }
    }

    const adminContextFlow = adminUserContextLimitFlows.get(userId);
    if (adminContextFlow) {
        const lowered = userText.toLowerCase();
        if ([ctx.t('common.cancelWord').toLowerCase(), 'отмена', 'cancel', '/cancel'].includes(lowered)) {
            adminUserContextLimitFlows.delete(userId);
            return ctx.reply(ctx.t('admin.contextCancelled'));
        }

        const parsed = Number.parseInt(userText, 10);
        if (!Number.isFinite(parsed) || parsed < 1000) {
            return ctx.reply(ctx.t('admin.invalidContext', { cancel: ctx.t('common.cancelWord') }));
        }

        const targetUser = await getUser(adminContextFlow.targetUserId);
        if (!targetUser) {
            adminUserContextLimitFlows.delete(userId);
            return ctx.reply(ctx.t('admin.userNotFound'));
        }

        const nextValue = Math.max(1000, Math.floor(parsed));
        await runBackendSetContextTokens(adminContextFlow.targetUserId, nextValue);
        adminUserContextLimitFlows.delete(userId);
        const refreshed = await getUser(adminContextFlow.targetUserId);
        if (refreshed) {
            const maxTokens = (refreshed.max_context_tokens_limit ?? 0) > 0
                ? Math.floor(refreshed.max_context_tokens_limit!) : getPlanMaxContextTokens(parsePlanFromDb(refreshed.plan));
            await ctx.reply(ctx.t('admin.contextUpdatedMax', { id: adminContextFlow.targetUserId, value: (resolveMaxContextTokens(refreshed) / 1000).toFixed(0), max: (maxTokens / 1000).toFixed(0) }));
            await renderAdminUserCard(ctx, refreshed, adminContextFlow.page, 'reply');
            return;
        }
        return ctx.reply(ctx.t('admin.contextUpdated', { id: adminContextFlow.targetUserId, value: nextValue }));
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
            return ctx.reply(ctx.t('timezone.invalidOffset'));
        }

        try {
            await runBackendSetTimezone(userId, offset);
        } catch {
            return ctx.reply(ctx.t('timezone.error'));
        }
        timezoneSetupFlows.delete(userId);
        const sign = offset >= 0 ? '+' : '';
        return ctx.reply(ctx.t('timezone.setForTimers', { offset: `${sign}${offset}` }), buildMenuTriggerKeyboard(ctx.t));
    }

    if (!isAdmin) {
        const renameFlow = renameFlows.get(userId);

        if (renameFlow === 'confirm') {
            const answer = userText.toLowerCase();
            const yes = ctx.t('common.yes').toLowerCase();
            const no = ctx.t('common.no').toLowerCase();
            if (answer === yes || answer === 'да' || answer === 'yes') {
                renameFlows.set(userId, 'await_name');
                return ctx.reply(ctx.t('profile.enterName'));
            }

            if (answer === no || answer === 'нет' || answer === 'no') {
                renameFlows.delete(userId);
                return ctx.reply(ctx.t('profile.renameCancelled'), buildMenuTriggerKeyboard(ctx.t));
            }

            return ctx.reply(
                ctx.t('profile.answerYesNo', {
                    yes: ctx.t('common.yes'),
                    no: ctx.t('common.no')
                }),
                Markup.keyboard([[ctx.t('common.yes'), ctx.t('common.no')]]).resize().oneTime()
            );
        }

        if (renameFlow === 'await_name') {
            if (!userText || userText.startsWith('/')) {
                return ctx.reply(ctx.t('profile.nameEmpty'));
            }

            if (userText.length > 64) {
                return ctx.reply(ctx.t('profile.nameTooLong'));
            }

            const userRecord = await getUser(userId);
            if (!userRecord) {
                renameFlows.delete(userId);
                return ctx.reply(ctx.t('common.userMissingAgain'));
            }

            await updateUserName(userId, userText);
            ctx.state.userName = userText;
            renameFlows.delete(userId);
            return ctx.reply(ctx.t('profile.nameAccepted'), buildMenuTriggerKeyboard(ctx.t));
        }

        const customPromptFlow = customPromptEditFlows.get(userId);
        if (customPromptFlow === 'await_content') {
            if (!userText || userText.startsWith('/')) {
                return ctx.reply(ctx.t('prompt.input.empty'));
            }
            if (userText.length > MAX_CUSTOM_PROMPT_LENGTH) {
                return ctx.reply(ctx.t('prompt.input.tooLong', {
                    length: userText.length,
                    limit: MAX_CUSTOM_PROMPT_LENGTH
                }));
            }

            const userRecord = await getUser(userId);
            if (!userRecord) {
                customPromptEditFlows.delete(userId);
                return ctx.reply(ctx.t('common.userMissingAgain'));
            }

            await updateUserCustomPrompt(userId, userText.trim());
            try { await runBackendUpdateCustomPrompt(userId, userText.trim()); } catch {}
            await selectUserCustomPrompt(userId);
            customPromptEditFlows.delete(userId);
            return ctx.reply(ctx.t('prompt.input.saved'), buildMenuTriggerKeyboard(ctx.t));
        }
    }

    const contextLimitFlow = contextLimitFlows.get(userId);
    if (contextLimitFlow === 'await_limit') {
        const lowered = userText.toLowerCase();
        const localizedCancel = ctx.t('common.cancelWord').toLowerCase();
        if (
            lowered === localizedCancel
            || lowered === 'отмена'
            || lowered === 'cancel'
            || lowered === '/cancel'
        ) {
            contextLimitFlows.delete(userId);
            return ctx.reply(ctx.t('context.cancelled'));
        }

        const parsed = Number.parseInt(userText, 10);
        if (!Number.isFinite(parsed) || parsed < 1000) {
            return ctx.reply(ctx.t('context.invalidNumber', {
                cancel: ctx.t('common.cancelWord')
            }));
        }

        const userRecord = await getUser(userId);
        if (!userRecord) {
            contextLimitFlows.delete(userId);
            return ctx.reply(ctx.t('common.userMissingAgain'));
        }

        const maxAllowed = (userRecord.max_context_tokens_limit ?? 0) > 0
            ? Math.floor(userRecord.max_context_tokens_limit!) : getPlanMaxContextTokens(parsePlanFromDb(userRecord.plan));
        const isUserAdmin = userRecord.role === 'admin';
        if (!isUserAdmin && parsed > maxAllowed) {
            return ctx.reply(ctx.t('context.aboveMaximum', {
                max: (maxAllowed / 1000).toFixed(0)
            }));
        }

        const ctxValue = Math.max(1000, Math.floor(parsed));
        await runBackendSetContextTokens(userId, ctxValue);
        contextLimitFlows.delete(userId);
        const refreshed = await getUser(userId);
        if (refreshed) {
            return ctx.reply(ctx.t('context.updatedWithMaximum', {
                current: (resolveMaxContextTokens(refreshed) / 1000).toFixed(0),
                max: (maxAllowed / 1000).toFixed(0)
            }));
        }
        return ctx.reply(ctx.t('context.updated', { value: ctxValue }));
    }

    const noteEditFlow = noteEditFlows.get(userId);
    if (noteEditFlow) {
        const lowered = userText.toLowerCase();
        const localizedCancel = ctx.t('common.cancelWord').toLowerCase();
        if (
            lowered === localizedCancel
            || lowered === 'отмена'
            || lowered === 'cancel'
            || lowered === '/cancel'
        ) {
            noteEditFlows.delete(userId);
            return ctx.reply(ctx.t('notes.editCancelled'));
        }

        const userRecord = await getUser(userId);
        if (!userRecord) {
            noteEditFlows.delete(userId);
            return ctx.reply(ctx.t('common.userMissingAgain'));
        }

        if (!userText) {
            return ctx.reply(ctx.t('notes.enterEditText', {
                id: noteEditFlow.noteId,
                cancel: ctx.t('common.cancelWord')
            }));
        }

        const note = await runBackendGetNote(userId, noteEditFlow.noteId);
        if (!note) {
            noteEditFlows.delete(userId);
            return ctx.reply(ctx.t('notes.notFound', { id: noteEditFlow.noteId }));
        }

        await runBackendUpdateNote(userId, noteEditFlow.noteId, userText.trim());
        noteEditFlows.delete(userId);

        await ctx.reply(ctx.t('notes.updated', { id: noteEditFlow.noteId }));
        await renderNoteView(ctx, userId, noteEditFlow.noteId, noteEditFlow.page, 'reply');
        return;
    }

    runUserRequestInBackground(ctx, () => processUserTextThroughAi(ctx, userText));
});

// ── Document (file attachment) handler ──
bot.on('document', async (ctx) => {
    if (ctx.message.media_group_id) {
        await processUserDocumentThroughAi(ctx);
        return;
    }
    runUserRequestInBackground(ctx, () => processUserDocumentThroughAi(ctx));
});

const processUserVoiceThroughAi = async (ctx: any) => {
    const voice = ctx.message?.voice;
    const chatId = ctx.chat?.id;
    if (!voice || !chatId) return;

    if (typeof voice.file_size === 'number' && voice.file_size > MAX_TELEGRAM_VOICE_BYTES) {
        await ctx.reply(ctx.t('generated.voiceTooLarge', { value: formatBytes(voice.file_size) }));
        return;
    }

    const processingMsg = await ctx.reply(ctx.t('generated.transcribingAudioToText'));

    try {
        const fileLink = await ctx.telegram.getFileLink(voice.file_id);
        const response = await fetch(fileLink.href);
        if (!response.ok) {
            throw new Error(`Не удалось скачать голосовое из Telegram: ${response.status} ${response.statusText}`);
        }

        const audioBuffer = await response.arrayBuffer();
        if (audioBuffer.byteLength > MAX_TELEGRAM_VOICE_BYTES) {
            await ctx.telegram.editMessageText(
                chatId,
                processingMsg.message_id,
                undefined,
                ctx.t('generated.voiceTooLarge', { value: formatBytes(audioBuffer.byteLength) })
            );
            return;
        }
        const mimeType = voice.mime_type || 'audio/ogg';
        const userId = Math.floor(Number(ctx.state.accountId));
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
            await ctx.telegram.editMessageText(chatId, processingMsg.message_id, undefined, ctx.t('generated.voiceNotRecognized'));
            return;
        }

        await ctx.telegram.editMessageText(chatId, processingMsg.message_id, undefined, ctx.t('generated.voiceRecognized', { text: text }));

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
            : ctx.t('ai.fallbackAnswer');
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
                console.warn('Не удалось привязать telegram_message_id к backend voice сообщению:', formatSafeError(bindErr));
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
        console.error('Ошибка работы с голосовым:', formatSafeError(error));
        try {
            await ctx.telegram.editMessageText(
                chatId,
                processingMsg.message_id,
                undefined,
                ctx.t('generated.transcriptionServerError')
            );
        } catch {
            await ctx.reply(ctx.t('generated.transcriptionServerError'));
        }
    }
};

bot.on('voice', async (ctx) => {
    runUserRequestInBackground(ctx, () => processUserVoiceThroughAi(ctx));
});

bot.on('photo', async (ctx) => {
    if (ctx.message.media_group_id) {
        await processUserPhotoThroughAi(ctx);
        return;
    }
    runUserRequestInBackground(ctx, () => processUserPhotoThroughAi(ctx));
});


if (AUTO_SYNC_PLAN_LIMITS_ON_BOOT) {
    (async () => {
        try {
            await syncAllUsersPlanLimits();
            console.log('Автосинхронизация лимитов по планам выполнена.');
        } catch (err) {
            console.error('Ошибка автосинхронизации лимитов по планам:', formatSafeError(err));
        }
    })();
}

scheduleDailyCounterReset();

bot.launch();
console.log('Chatter запущен с базой данных!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

