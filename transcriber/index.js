const { Telegraf } = require('telegraf');
const axios = require('axios');
const FormData = require('form-data');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const dotenv = require('dotenv');

// Prefer a component-specific .env, then use the project root .env as fallback.
dotenv.config({ path: path.resolve(__dirname, '.env') });
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const requireEnv = (name) => {
    const value = `${process.env[name] || ''}`.trim();
    if (!value) throw new Error(`[config] ${name} is required`);
    return value;
};

// --- НАСТРОЙКИ ---
const BOT_TOKEN = requireEnv('TELEGRAM_TOKEN');
const KZ_SERVER_URL = requireEnv('VOICE_TRANSCRIBE_URL');
const KZ_SECRET = requireEnv('VOICE_TRANSCRIBE_TOKEN');
const ADMIN_ID = Number(requireEnv('TRANSCRIBER_ADMIN_ID'));

if (!Number.isSafeInteger(ADMIN_ID) || ADMIN_ID <= 0) {
    throw new Error('[config] TRANSCRIBER_ADMIN_ID must be a positive integer');
}

const formatSafeError = (error) => {
    if (axios.isAxiosError(error)) {
        const details = [
            error.message,
            error.code ? `code=${error.code}` : '',
            error.response?.status ? `status=${error.response.status}` : ''
        ].filter(Boolean);
        return details.join(' ');
    }
    return error instanceof Error ? error.message : String(error);
};

const TRANSCRIBER_TMP_MAX_AGE_HOURS = Number(process.env.TRANSCRIBER_TMP_MAX_AGE_HOURS || 24);
const TRANSCRIBER_TMP_MAX_AGE_MS = (
    Number.isFinite(TRANSCRIBER_TMP_MAX_AGE_HOURS) && TRANSCRIBER_TMP_MAX_AGE_HOURS > 0
        ? TRANSCRIBER_TMP_MAX_AGE_HOURS
        : 24
) * 60 * 60 * 1000;
let cleanupRunning = false;

const cleanupStaleTranscriberFiles = async () => {
    if (cleanupRunning) return;
    cleanupRunning = true;
    try {
        const entries = await fs.promises.readdir(__dirname, { withFileTypes: true });
        const now = Date.now();
        await Promise.all(entries
            .filter((entry) => entry.isFile() && (
                entry.name.startsWith('temp_audio_') || entry.name.startsWith('transcription_')
            ))
            .map(async (entry) => {
                const filePath = path.resolve(__dirname, entry.name);
                try {
                    const stat = await fs.promises.stat(filePath);
                    if (now - stat.mtimeMs > TRANSCRIBER_TMP_MAX_AGE_MS) {
                        await fs.promises.unlink(filePath);
                    }
                } catch (error) {
                    if (error?.code !== 'ENOENT') {
                        console.warn('[cleanup] failed:', formatSafeError(error));
                    }
                }
            }));
    } catch (error) {
        console.warn('[cleanup] scan failed:', formatSafeError(error));
    } finally {
        cleanupRunning = false;
    }
};

const removeTempFile = (filePath) => {
    if (!filePath) return;
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (error) {
        console.warn('[cleanup] unlink failed:', formatSafeError(error));
    }
};

void cleanupStaleTranscriberFiles();

// --- RICH STREAMING (Bot API 10.1+: sendRichMessageDraft / sendRichMessage) ---
// Адаптация RichStreamSession из index.ts основного бота.
// Только toolStatus (прогресс) + textBuf (финальный текст), без reasoning/intermediate.

const STREAM_FLUSH_BASE_INTERVAL_MS = 600;   // базовый throttle (~1.6 апдейта/сек)
const STREAM_FLUSH_MAX_INTERVAL_MS = 5000;   // потолок при 429
const STREAM_MIN_DELTA_CHARS = 5;            // минимальный прирост для досрочного flush
const STREAM_DRAFT_TEXT_LIMIT = 4000;        // потолок длины draft-HTML

class RichStreamSession {
    constructor(telegram, chatId) {
        this.telegram = telegram;
        this.chatId = chatId;
        this.draftId = Date.now() + Math.floor(Math.random() * 1000);

        this.toolStatus = '';   // текущий статус («Расшифровка: 35%»)
        this.textBuf = '';      // финальный текст (чистый, без статусов)

        this.lastFlushAt = 0;
        this.lastTotalLenAtFlush = 0;
        this.nextAllowedFlushAt = 0;
        this.flushTimer = null;

        // AIMD throttle
        this.currentFlushIntervalMs = STREAM_FLUSH_BASE_INTERVAL_MS;
        this.consecutiveOkFlushes = 0;

        this.draftFailed = false;
        this.finalized = false;
        this.messageId = null;
    }

    escapeHtml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    buildRichHtml(isFinal = false) {
        if (isFinal) {
            // Финал — только чистый текст расшифровки
            return `<p>${this.escapeHtml(this.textBuf.slice(0, STREAM_DRAFT_TEXT_LIMIT))}</p>`;
        }

        // Draft: показываем текущий прогресс
        let html = '';
        if (this.toolStatus.trim()) {
            html += `<i>${this.escapeHtml(this.toolStatus.trim())}</i><br>`;
        }
        if (this.textBuf.trim()) {
            html += `<p>${this.escapeHtml(this.textBuf.slice(0, STREAM_DRAFT_TEXT_LIMIT - 200))}</p>`;
        }
        if (!html) html = '<p>...</p>';
        return html;
    }

    async callDraft(html) {
        if (this.draftFailed || this.finalized) return;
        const payload = {
            chat_id: this.chatId,
            draft_id: this.draftId,
            rich_message: { html },
        };
        try {
            await this.telegram.callApi('sendRichMessageDraft', payload);

            // AIMD additive increase
            this.consecutiveOkFlushes++;
            if (this.consecutiveOkFlushes >= 4 && this.currentFlushIntervalMs > STREAM_FLUSH_BASE_INTERVAL_MS) {
                this.currentFlushIntervalMs = Math.max(
                    STREAM_FLUSH_BASE_INTERVAL_MS,
                    this.currentFlushIntervalMs - 100
                );
                this.consecutiveOkFlushes = 0;
            }
        } catch (err) {
            const description = typeof err?.response?.description === 'string'
                ? err.response.description
                : formatSafeError(err);

            if (description.toLowerCase().includes('too many requests')) {
                // 429 — не сдаёмся, пережидаем
                const retryAfter = Number(err?.response?.parameters?.retry_after) || 3;
                const newInterval = Math.min(
                    STREAM_FLUSH_MAX_INTERVAL_MS,
                    Math.max(this.currentFlushIntervalMs * 2, retryAfter * 1000 + 500)
                );
                console.warn(`[rich-stream] 429! retry_after=${retryAfter}s, interval ${this.currentFlushIntervalMs}ms → ${newInterval}ms`);
                this.currentFlushIntervalMs = newInterval;
                this.consecutiveOkFlushes = 0;
                this.nextAllowedFlushAt = Date.now() + (retryAfter * 1000) + 500;
                return;
            }

            console.error(`[rich-stream] sendRichMessageDraft error:`, description);
            this.draftFailed = true;
            this.clearTimer();
        }
    }

    async flush() {
        if (this.draftFailed || this.finalized) return;
        const hasAny = this.toolStatus.trim() || this.textBuf.trim();
        if (hasAny) {
            await this.callDraft(this.buildRichHtml(false));
        }
        this.lastFlushAt = Date.now();
        this.lastTotalLenAtFlush = this.toolStatus.length + this.textBuf.length;
    }

    scheduleFlush() {
        if (this.draftFailed || this.finalized) return;
        if (this.flushTimer) return;
        const now = Date.now();
        const cooldownDelay = Math.max(0, this.nextAllowedFlushAt - now);
        const elapsed = now - this.lastFlushAt;
        const throttleDelay = Math.max(0, this.currentFlushIntervalMs - elapsed);
        const delay = Math.max(cooldownDelay, throttleDelay);
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush().catch(err => console.warn('[rich-stream] flush error:', formatSafeError(err)));
        }, delay);
    }

    maybeFlush() {
        if (this.draftFailed || this.finalized) return;
        const now = Date.now();
        if (now < this.nextAllowedFlushAt) {
            this.scheduleFlush();
            return;
        }
        const sinceFlush = now - this.lastFlushAt;
        const totalLen = this.toolStatus.length + this.textBuf.length;
        const delta = totalLen - this.lastTotalLenAtFlush;
        if (sinceFlush >= this.currentFlushIntervalMs || delta >= STREAM_MIN_DELTA_CHARS) {
            this.clearTimer();
            this.flush().catch(err => console.warn('[rich-stream] flush error:', formatSafeError(err)));
        } else {
            this.scheduleFlush();
        }
    }

    clearTimer() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
    }

    /** Обновить статус прогресса */
    onStatus(status) {
        if (this.draftFailed || this.finalized) return;
        this.toolStatus = status;
        this.maybeFlush();
    }

    /** Финальный текст расшифровки */
    onText(text) {
        if (this.draftFailed || this.finalized) return;
        this.textBuf = text;
        this.maybeFlush();
    }

    /** Финализация — sendRichMessage, текст остаётся в истории чата */
    async finalize() {
        if (this.finalized) return this.messageId !== null;
        this.finalized = true;
        this.clearTimer();

        if (!this.textBuf.trim()) return false;

        try {
            const html = this.buildRichHtml(true);
            const payload = {
                chat_id: this.chatId,
                rich_message: { html },
            };
            const result = await this.telegram.callApi('sendRichMessage', payload);
            if (Number.isFinite(Number(result?.message_id))) {
                this.messageId = Number(result.message_id);
            }
            return this.messageId !== null;
        } catch (err) {
            const description = typeof err?.response?.description === 'string'
                ? err.response.description
                : formatSafeError(err);
            console.error(`[rich-stream] sendRichMessage error:`, description);
            return false;
        }
    }

    hasContent() {
        return Boolean(this.toolStatus.trim() || this.textBuf.trim());
    }
}

const bot = new Telegraf(BOT_TOKEN);

// Защита от левых юзеров
bot.use((ctx, next) => {
    if (ctx.from?.id !== ADMIN_ID) return ctx.reply('Доступ запрещен.');
    return next();
});

bot.on(['voice', 'audio', 'document'], async (ctx) => {
    let richStream = null;
    let tempFilePath = null;
    let textFilePath = null;
    void cleanupStaleTranscriberFiles();

    try {
        const message = ctx.message;
        const fileId = message.voice?.file_id || message.audio?.file_id || message.document?.file_id;

        if (!fileId) return ctx.reply('Я не вижу здесь аудиофайла.');

        // 1. Создаём rich streaming draft сразу — всё летит в одно сообщение
        const chatId = ctx.chat.id;
        richStream = new RichStreamSession(ctx.telegram, chatId);
        richStream.onStatus('⏳ Скачиваю файл из Telegram...');

        // 2. Скачиваем файл из Telegram
        const fileUrl = await ctx.telegram.getFileLink(fileId);
        tempFilePath = path.resolve(__dirname, `temp_audio_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.ogg`);

        const fileStream = fs.createWriteStream(tempFilePath);
        await new Promise((resolve, reject) => {
            https.get(fileUrl, (response) => {
                if (response.statusCode !== 200) {
                    response.resume();
                    reject(new Error(`telegram_download_failed_${response.statusCode || 'unknown'}`));
                    return;
                }
                response.on('error', reject);
                fileStream.on('error', reject);
                response.pipe(fileStream);
                fileStream.on('finish', resolve);
            }).on('error', reject);
        });

        // 3. Отправляем на KZ сервер
        richStream.onStatus('📨 Отправляю на сервер...');

        // 3. Отправляем файл на KZ сервер и слушаем SSE-стрим
        const formData = new FormData();
        formData.append('audio', fs.createReadStream(tempFilePath));

        const kzResponse = await axios.post(KZ_SERVER_URL, formData, {
            headers: {
                'Authorization': `Bearer ${KZ_SECRET}`,
                ...formData.getHeaders()
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            timeout: 0,
            responseType: 'stream'
        });

        let transcribedText = '';
        let streamError = null;

        await new Promise((resolve, reject) => {
            let buffer = '';

            kzResponse.data.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                // Последний элемент может быть неполным — оставляем в буфере
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    try {
                        const data = JSON.parse(line.slice(6));

                        if (data.status === 'queued') {
                            richStream.onStatus(`⏳ В очереди. Позиция: ${data.position}`);
                        } else if (data.status === 'progress') {
                            if (data.stage === 'converting') {
                                richStream.onStatus('⚙️ Конвертация аудио...');
                            } else {
                                // transcribing — прогресс whisper
                                const pct = data.percent;
                                if (typeof pct === 'number') {
                                    richStream.onStatus(`🎙 Расшифровка: ${pct}%`);
                                } else {
                                    richStream.onStatus('🎙 Расшифровка...');
                                }
                            }
                        } else if (data.status === 'done') {
                            transcribedText = data.text || '';
                        } else if (data.status === 'error') {
                            streamError = data.error || 'unknown_error';
                        }
                    } catch {
                        // partial JSON — проигнорируем
                    }
                }
            });

            kzResponse.data.on('end', resolve);
            kzResponse.data.on('error', reject);
        });

        // 4. Удаляем временный аудиофайл
        removeTempFile(tempFilePath);
        tempFilePath = null;

        if (streamError) {
            throw new Error(streamError);
        }

        if (!transcribedText || transcribedText.trim() === '') {
            // Пустая расшифровка
            richStream.onStatus('');
            richStream.onText('❌ Расшифровка пуста. Возможно, на фоне была только тишина или музыка.');
            const ok = await richStream.finalize();
            if (!ok) {
                await ctx.reply('❌ Расшифровка пуста. Возможно, на фоне была только тишина или музыка.');
            }
            return;
        }

        // 5. Текст > 4000 — отправляем .txt файлом, иначе rich-сообщением
        if (transcribedText.length > STREAM_DRAFT_TEXT_LIMIT) {
            // Финализируем draft коротким статусом
            richStream.onStatus('');
            richStream.onText('📄 Расшифровка слишком длинная, отправляю файлом...');
            await richStream.finalize();

            const textFileName = `transcription_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
            textFilePath = path.resolve(__dirname, textFileName);
            fs.writeFileSync(textFilePath, transcribedText);
            await ctx.replyWithDocument({ source: textFilePath, filename: textFileName });
            removeTempFile(textFilePath);
            textFilePath = null;
        } else {
            richStream.onText(transcribedText);
            const richOk = await richStream.finalize();

            if (!richOk) {
                // Fallback: отправляем .txt файлом
                const textFileName = `transcription_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
                textFilePath = path.resolve(__dirname, textFileName);
                fs.writeFileSync(textFilePath, transcribedText);
                await ctx.replyWithDocument({ source: textFilePath, filename: textFileName });
                removeTempFile(textFilePath);
                textFilePath = null;
            }
        }

    } catch (error) {
        console.error('[transcriber] request failed:', formatSafeError(error));
        const errText = '❌ Произошла ошибка при расшифровке.';
        // Пытаемся показать ошибку в rich draft, если он есть
        if (richStream && !richStream.finalized) {
            richStream.onStatus('');
            richStream.onText(errText);
            const ok = await richStream.finalize();
            if (!ok) await ctx.reply(errText);
        } else {
            await ctx.reply(errText);
        }
    } finally {
        removeTempFile(tempFilePath);
        removeTempFile(textFilePath);
    }
});

bot.launch();
console.log('Транскрибатор запущен...');
