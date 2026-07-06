const { Telegraf } = require('telegraf');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const https = require('https');

// --- НАСТРОЙКИ ---
const BOT_TOKEN = '***REMOVED_TELEGRAM_TOKEN***';
const KZ_SERVER_URL = 'http://***REMOVED_VOICE_ENDPOINT***/api/voice/stream';
const KZ_SECRET = '***REMOVED_VOICE_SECRET***';
const ADMIN_ID = 0;

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
            const description = err?.response?.description || err?.description || err?.message || String(err);

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
            this.flush().catch(err => console.warn('[rich-stream] flush error:', err?.message || err));
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
            this.flush().catch(err => console.warn('[rich-stream] flush error:', err?.message || err));
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
            const description = err?.response?.description || err?.description || err?.message || String(err);
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
    try {
        const message = ctx.message;
        const fileId = message.voice?.file_id || message.audio?.file_id || message.document?.file_id;

        if (!fileId) return ctx.reply('Я не вижу здесь аудиофайла.');

        // 1. Скачиваем файл из Telegram
        const statusMsg = await ctx.reply('⏳ Скачиваю файл из Telegram...');

        const fileUrl = await ctx.telegram.getFileLink(fileId);
        const tempFilePath = path.resolve(__dirname, `temp_audio_${Date.now()}.ogg`);

        const fileStream = fs.createWriteStream(tempFilePath);
        await new Promise((resolve, reject) => {
            https.get(fileUrl, (response) => {
                response.pipe(fileStream);
                fileStream.on('finish', resolve);
            }).on('error', reject);
        });

        // 2. Создаём rich streaming draft
        const chatId = ctx.chat.id;
        const richStream = new RichStreamSession(ctx.telegram, chatId);
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
                        } else if (data.status === 'converting') {
                            richStream.onStatus('⚙️ Конвертация аудио...');
                        } else if (data.status === 'progress') {
                            richStream.onStatus(`🎙 Расшифровка: ${data.percent}%`);
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
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);

        if (streamError) {
            throw new Error(streamError);
        }

        if (!transcribedText || transcribedText.trim() === '') {
            // Пустая расшифровка
            richStream.onStatus('');
            richStream.onText('❌ Расшифровка пуста. Возможно, на фоне была только тишина или музыка.');
            const ok = await richStream.finalize();
            if (!ok) {
                await ctx.telegram.editMessageText(chatId, statusMsg.message_id, undefined,
                    '❌ Расшифровка пуста. Возможно, на фоне была только тишина или музыка.');
            }
            return;
        }

        // 5. Финализируем rich-сообщение с текстом расшифровки
        richStream.onText(transcribedText);
        const richOk = await richStream.finalize();

        if (!richOk) {
            // Fallback: отправляем как раньше — .txt файлом
            const textFileName = `transcription_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
            const textFilePath = path.resolve(__dirname, textFileName);
            fs.writeFileSync(textFilePath, transcribedText);
            await ctx.replyWithDocument({ source: textFilePath, filename: textFileName });
            fs.unlinkSync(textFilePath);
            try { await ctx.telegram.deleteMessage(chatId, statusMsg.message_id); } catch {}
        }

    } catch (error) {
        console.error(error);
        ctx.reply(`❌ Произошла ошибка: ${error.message}`);
    }
});

bot.launch();
console.log('Транскрибатор запущен...');
