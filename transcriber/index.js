const { Telegraf } = require('telegraf');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const https = require('https'); // Для скачивания файла из ТГ

// --- НАСТРОЙКИ ---
const BOT_TOKEN = '***REMOVED_TELEGRAM_TOKEN***';
const KZ_SERVER_URL = 'http://***REMOVED_VOICE_ENDPOINT***/api/voice';
const KZ_SECRET = '***REMOVED_VOICE_SECRET***'; // Токен, который мы задали на казахе
const ADMIN_ID = 0; // Твой ID, чтобы другие не грузили твой сервер

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

        const statusMsg = await ctx.reply('⏳ Скачиваю файл из Telegram...');

        // 1. Получаем ссылку на файл
        const fileUrl = await ctx.telegram.getFileLink(fileId);
        const tempFilePath = path.resolve(__dirname, `temp_audio_${Date.now()}.ogg`);

        // 2. Скачиваем файл локально на NL сервер
        const fileStream = fs.createWriteStream(tempFilePath);
        await new Promise((resolve, reject) => {
            https.get(fileUrl, (response) => {
                response.pipe(fileStream);
                fileStream.on('finish', resolve);
            }).on('error', reject);
        });

        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, '⚙️ Отправил казахам. Расшифровываю...');

        // 3. Отправляем файл на KZ сервер
        const formData = new FormData();
        formData.append('audio', fs.createReadStream(tempFilePath));

        const kzResponse = await axios.post(KZ_SERVER_URL, formData, {
            headers: {
                'Authorization': `Bearer ${KZ_SECRET}`,
                ...formData.getHeaders()
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            // Убираем таймаут, длинные файлы могут расшифровываться 10+ минут
            timeout: 0 
        });

        const transcribedText = kzResponse.data.text;

        // 4. Удаляем временный аудиофайл
        fs.unlinkSync(tempFilePath);

        if (!transcribedText || transcribedText.trim() === '') {
            return ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, '❌ Расшифровка пуста. Возможно, на фоне была только тишина или музыка.');
        }

        // 5. Создаем текстовый файл
        const textFileName = `transcription_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
        const textFilePath = path.resolve(__dirname, textFileName);
        fs.writeFileSync(textFilePath, transcribedText);

        // 6. Отправляем результат и убираем за собой
        await ctx.replyWithDocument({ source: textFilePath, filename: textFileName });
        fs.unlinkSync(textFilePath);
        
        // Удаляем статусное сообщение
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

    } catch (error) {
        console.error(error);
        ctx.reply(`❌ Произошла ошибка: ${error.message}`);
    }
});

bot.launch();
console.log('Транскрибатор запущен...');
