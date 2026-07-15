const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '.env') });

const requireEnv = (name) => {
    const value = `${process.env[name] || ''}`.trim();
    if (!value) throw new Error(`[config] ${name} is required`);
    return value;
};

const parsePort = (value) => {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('[config] VOICE_API_PORT must be an integer between 1 and 65535');
    }
    return port;
};

const parsePositiveInteger = (name, value, fallback) => {
    const parsed = Number(value ?? fallback);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`[config] ${name} must be a positive integer`);
    }
    return parsed;
};

const app = express();
const SECRET_TOKEN = requireEnv('VOICE_TRANSCRIBE_TOKEN');
const VOICE_API_PORT = parsePort(process.env.VOICE_API_PORT || '3030');
const MAX_UPLOAD_MB = parsePositiveInteger('VOICE_MAX_UPLOAD_MB', process.env.VOICE_MAX_UPLOAD_MB, 50);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const MAX_QUEUE_SIZE = parsePositiveInteger('VOICE_MAX_QUEUE_SIZE', process.env.VOICE_MAX_QUEUE_SIZE, 20);
const MAX_TTS_CHARS = parsePositiveInteger('VOICE_MAX_TTS_CHARS', process.env.VOICE_MAX_TTS_CHARS, 10000);
const TMP_MAX_AGE_HOURS = parsePositiveInteger('VOICE_TMP_MAX_AGE_HOURS', process.env.VOICE_TMP_MAX_AGE_HOURS, 24);
const TMP_MAX_AGE_MS = TMP_MAX_AGE_HOURS * 60 * 60 * 1000;
const TTS_VOICE = process.env.TTS_VOICE || 'ru-RU-DmitryNeural';
const TMP_DIR = path.resolve(__dirname, 'tmp');
const WHISPER_BIN = path.resolve(__dirname, '../whisper.cpp/build/bin/whisper-cli');
const WHISPER_MODEL = path.resolve(__dirname, '../whisper.cpp/models/ggml-small.bin');
const SILERO_SCRIPT = path.resolve(__dirname, 'silero_tts.py');

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const upload = multer({
    dest: TMP_DIR,
    limits: {
        files: 1,
        fileSize: MAX_UPLOAD_BYTES
    }
});
const jsonBody = express.json({ limit: '1mb' });

const formatSafeError = (error) => error instanceof Error ? error.message : String(error);

const requireBearerAuth = (req, res, next) => {
    const header = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const prefix = 'Bearer ';
    if (!header.startsWith(prefix)) return res.status(401).json({ error: 'unauthorized' });

    const supplied = Buffer.from(header.slice(prefix.length), 'utf8');
    const expected = Buffer.from(SECRET_TOKEN, 'utf8');
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    return next();
};

const uploadAudio = (req, res, next) => {
    upload.single('audio')(req, res, (error) => {
        if (!error) return next();
        if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'audio_too_large', max_mb: MAX_UPLOAD_MB });
        }
        console.warn('[upload] rejected:', formatSafeError(error));
        return res.status(400).json({ error: 'invalid_audio_upload' });
    });
};

let queue = [];
let isProcessing = false;
let cleanupRunning = false;

const cleanupStaleTempFiles = async () => {
    if (cleanupRunning) return;
    cleanupRunning = true;
    try {
        const entries = await fs.promises.readdir(TMP_DIR, { withFileTypes: true });
        const now = Date.now();
        await Promise.all(entries
            .filter((entry) => entry.isFile())
            .map(async (entry) => {
                const filePath = path.join(TMP_DIR, entry.name);
                try {
                    const stat = await fs.promises.stat(filePath);
                    if (now - stat.mtimeMs > TMP_MAX_AGE_MS) {
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

const convertToWav = (inputPath, wavPath) => new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
        '-i', inputPath,
        '-ar', '16000',
        '-ac', '1',
        '-c:a', 'pcm_s16le',
        wavPath,
        '-y'
    ], { shell: false });
    let stderr = '';
    let settled = false;

    ffmpeg.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-8000);
    });
    ffmpeg.on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
    });
    ffmpeg.on('close', (code) => {
        if (settled) return;
        settled = true;
        if (code === 0 && fs.existsSync(wavPath)) return resolve();
        return reject(new Error(stderr || `ffmpeg exit code ${code}`));
    });
});

void cleanupStaleTempFiles();

// Общая очередь для обоих эндпоинтов (старый JSON и новый SSE-стрим).
// res может быть обычным Express Response (старый /api/voice) или SSE-стримом (/api/voice/stream).
// Тип ответа определяется флагом isStream в элементе очереди.

const processQueue = async () => {
    if (isProcessing || queue.length === 0) return;
    isProcessing = true;
    void cleanupStaleTempFiles();

    const item = queue.shift();
    const { res, inputPath, isStream } = item;
    const wavPath = `${inputPath}.wav`;

    const sseSend = (data) => {
        if (isStream && !res.writableEnded) {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
    };
    const sseEnd = () => {
        if (isStream && !res.writableEnded) {
            res.end();
        }
    };

    try {
        console.log(`[${new Date().toISOString()}] Processing file: ${inputPath}`);
        sseSend({ status: 'progress', percent: 0, stage: 'converting' });

        await convertToWav(inputPath, wavPath);

        sseSend({ status: 'progress', percent: 0, stage: 'transcribing' });

        // Убрали выдуманный флаг. Оставляем только -pp
        const whisper = spawn(WHISPER_BIN, [
            '-m', WHISPER_MODEL,
            '-f', wavPath,
            '-nt',
            '-l', 'ru',
            '-pp'
        ]);

        let finalOutput = '';
        let isDone = false;
        let lastProgress = 0; // Запоминаем, на скольки процентах мы остановились

        whisper.stdout.on('data', (data) => {
            finalOutput += data.toString();
        });

        whisper.stderr.on('data', (data) => {
            const str = data.toString();
            
            // ВАЖНО: Выводим все логи виспера в PM2, чтобы больше не быть слепыми
            process.stdout.write(`[WHISPER] ${str}`);
            
            const match = str.match(/progress\s*=\s*(\d+)%/);
            if (match) {
                lastProgress = parseInt(match[1], 10);
                sseSend({ status: 'progress', percent: lastProgress, stage: 'transcribing' });
            }
        });

        whisper.on('error', (err) => {
            if (isDone) return;
            isDone = true;
            console.error('Whisper spawn error:', formatSafeError(err));
            sseSend({ status: 'error', error: 'Ошибка при запуске расшифровки' });
            sseEnd();
            cleanupAndNext();
        });

        whisper.on('exit', (code, signal) => {
            if (isDone) return;
            isDone = true;

            const text = finalOutput.trim();

            // Считаем успехом нормальный выход (0) ИЛИ если он упал в самом конце (прогресс >= 95%)
            const isSuccess = code === 0 || (code === null && lastProgress >= 95);

            if (isSuccess && text.length > 0) {
                if (isStream) {
                    sseSend({ status: 'done', text });
                    sseEnd();
                } else {
                    res.json({ text });
                }
            } else {
                // Если процесс умер, мы честно кидаем ошибку
                console.error(`whisper-cli crashed at ${lastProgress}% with code ${code}, signal ${signal}`);
                if (isStream) {
                    sseSend({ status: 'error', error: `Сбой на ${lastProgress}% (сигнал ${signal})` });
                    sseEnd();
                } else {
                    res.status(500).json({ error: 'Сбой whisper в процессе' });
                }
            }
            cleanupAndNext();
        });

    } catch (error) {
        console.error('Queue processing error:', formatSafeError(error));
        if (isStream) {
            sseSend({ status: 'error', error: 'Ошибка конвертации на стороне KZ' });
            sseEnd();
        } else {
            res.status(500).json({ error: 'Ошибка на стороне KZ' });
        }
        cleanupAndNext();
    }

    function cleanupAndNext() {
        removeTempFile(inputPath);
        removeTempFile(wavPath);
        isProcessing = false;
        processQueue();
    }
};

const sendAndCleanup = (res, filePath, fileName) => {
    res.download(filePath, fileName, () => {
        removeTempFile(filePath);
    });
};

const runEdgeTts = (text, filePath, onDone, onFail) => {
    const ttsProcess = spawn('edge-tts', ['--voice', TTS_VOICE, '--text', text, '--write-media', filePath], { shell: false });
    let stderr = '';
    let settled = false;

    ttsProcess.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
    });

    ttsProcess.on('error', (err) => {
        if (settled) return;
        settled = true;
        onFail(err);
    });
    ttsProcess.on('close', (code) => {
        if (settled) return;
        settled = true;
        if (code !== 0 || !fs.existsSync(filePath)) {
            return onFail(new Error(stderr || `edge-tts exit code ${code}`));
        }
        return onDone();
    });
};

const runSilero = (text, filePath, onDone, onFail) => {
    const sileroProcess = spawn('python3', [SILERO_SCRIPT, text, filePath], {
        cwd: __dirname,
        shell: false
    });
    let stderr = '';
    let settled = false;

    sileroProcess.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-8000);
    });
    sileroProcess.on('error', (error) => {
        if (settled) return;
        settled = true;
        onFail(error);
    });
    sileroProcess.on('close', (code) => {
        if (settled) return;
        settled = true;
        if (code !== 0 || !fs.existsSync(filePath)) {
            return onFail(new Error(stderr || `silero exit code ${code}`));
        }
        return onDone();
    });
};

const removeTempFile = (filePath) => {
    if (!filePath) return;
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (error) {
        console.warn('[cleanup] unlink failed:', formatSafeError(error));
    }
};

const tryEnqueue = (res, inputPath, isStream) => {
    if (queue.length >= MAX_QUEUE_SIZE) return null;
    const item = { res, inputPath, isStream };
    queue.push(item);
    res.once('close', () => {
        const index = queue.indexOf(item);
        if (index === -1) return;
        queue.splice(index, 1);
        removeTempFile(inputPath);
    });
    return item;
};

const rejectQueueFull = (res, inputPath) => {
    removeTempFile(inputPath);
    res.setHeader('Retry-After', '30');
    return res.status(429).json({ error: 'voice_queue_full', max_queue_size: MAX_QUEUE_SIZE });
};

app.post('/api/tts', requireBearerAuth, jsonBody, (req, res) => {

    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Нет текста' });
    if (text.length > MAX_TTS_CHARS) {
        return res.status(413).json({ error: 'text_too_long', max_chars: MAX_TTS_CHARS });
    }

    const fileName = `tts_${crypto.randomUUID()}.mp3`;
    const filePath = path.resolve(TMP_DIR, fileName);

    runEdgeTts(
        text,
        filePath,
        () => sendAndCleanup(res, filePath, fileName),
        (err) => {
            console.error('[TTS] edge-tts недоступен, переключаюсь на локальный Silero:', formatSafeError(err));
            removeTempFile(filePath);

            const fallbackName = `tts_fallback_${crypto.randomUUID()}.wav`;
            const fallbackPath = path.resolve(TMP_DIR, fallbackName);
            console.warn('[TTS] fallback активирован: endpoint=/api/tts, engine=edge-tts -> silero');
            runSilero(
                text,
                fallbackPath,
                () => sendAndCleanup(res, fallbackPath, fallbackName),
                (fallbackErr) => {
                    console.error('Ошибка fallback silero:', formatSafeError(fallbackErr));
                    removeTempFile(fallbackPath);
                    return res.status(500).json({ error: 'Ошибка генерации' });
                }
            );
        }
    );
});

app.post('/api/silero', requireBearerAuth, jsonBody, (req, res) => {

    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Нет текста' });
    if (text.length > MAX_TTS_CHARS) {
        return res.status(413).json({ error: 'text_too_long', max_chars: MAX_TTS_CHARS });
    }

    const fileName = `silero_${crypto.randomUUID()}.wav`;
    const filePath = path.resolve(TMP_DIR, fileName);

    runSilero(
        text,
        filePath,
        () => sendAndCleanup(res, filePath, fileName),
        (err) => {
            console.error('Ошибка silero:', formatSafeError(err));
            removeTempFile(filePath);
            return res.status(500).json({ error: 'Ошибка генерации' });
        }
    );
});

// Старый эндпоинт — обычный JSON ответ. Не трогаем, chatter зависит от него.
app.post('/api/voice', requireBearerAuth, uploadAudio, (req, res) => {
    if (!req.file?.path) {
        return res.status(400).json({ error: 'Файл не получен' });
    }

    if (!tryEnqueue(res, req.file.path, false)) return rejectQueueFull(res, req.file.path);
    console.log(`[JSON] Добавлено в очередь. Позиция: ${queue.length}`);
    processQueue();
});

// Новый эндпоинт — SSE-стрим прогресса whisper.
// Отвечает text/event-stream с событиями: queued, converting, progress, done, error.
app.post('/api/voice/stream', requireBearerAuth, uploadAudio, (req, res) => {
    if (!req.file?.path) {
        return res.status(400).json({ error: 'Файл не получен' });
    }

    if (queue.length >= MAX_QUEUE_SIZE) return rejectQueueFull(res, req.file.path);

    // SSE-заголовки
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const queuePos = queue.length + (isProcessing ? 1 : 0);
    res.write(`data: ${JSON.stringify({ status: 'queued', position: queuePos })}\n\n`);

    tryEnqueue(res, req.file.path, true);
    console.log(`[SSE] Добавлено в очередь. Позиция: ${queuePos}`);
    processQueue();
});

app.listen(VOICE_API_PORT, () => console.log(`KZ Voice API с очередью запущен на порту ${VOICE_API_PORT}...`));
