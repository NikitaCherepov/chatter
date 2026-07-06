const express = require('express');
const multer = require('multer');
const { execSync, exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ dest: 'tmp/' });
const SECRET_TOKEN = '***REMOVED_VOICE_SECRET***';

let queue = [];
let isProcessing = false;

// Общая очередь для обоих эндпоинтов (старый JSON и новый SSE-стрим).
// res может быть обычным Express Response (старый /api/voice) или SSE-стримом (/api/voice/stream).
// Тип ответа определяется флагом isStream в элементе очереди.

const processQueue = async () => {
    if (isProcessing || queue.length === 0) return;
    isProcessing = true;

    const item = queue.shift();
    const { res, inputPath, isStream } = item;
    const wavPath = `${inputPath}.wav`;

    // Хелперы: отправка SSE-события или молчаливый no-op для старого JSON-режима
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

        // ffmpeg через spawn — не блокирует event loop
        const ffmpegProc = spawn('ffmpeg', [
            '-i', inputPath,
            '-ar', '16000',
            '-ac', '1',
            '-c:a', 'pcm_s16le',
            wavPath,
            '-y'
        ]);

        let ffmpegDone = false;
        const runWhisper = () => {
            if (ffmpegDone) return;
            ffmpegDone = true;

            sseSend({ status: 'progress', percent: 0, stage: 'transcribing' });

            // spawn whisper с шагом прогресса 1% (whisper.cpp поддерживает --progress-step)
            const whisper = spawn('../whisper.cpp/build/bin/whisper-cli', [
                '-m', '../whisper.cpp/models/ggml-small.bin',
                '-f', wavPath,
                '-nt',
                '-l', 'ru',
                '-pp',
                '--progress-step', '1'
            ]);

            let finalOutput = '';

            whisper.stdout.on('data', (data) => {
                finalOutput += data.toString();
            });

            whisper.stderr.on('data', (data) => {
                const str = data.toString();
                const match = str.match(/progress\s*=\s*(\d+)%/);
                if (match) {
                    sseSend({ status: 'progress', percent: parseInt(match[1], 10), stage: 'transcribing' });
                }
            });

            whisper.on('error', (err) => {
                console.error('Whisper spawn error:', err);
                sseSend({ status: 'error', error: 'Ошибка при расшифровке' });
                sseEnd();
                cleanupAndNext();
            });

            whisper.on('close', (code) => {
                if (code !== 0) {
                    console.error(`whisper-cli exited with code ${code}`);
                    sseSend({ status: 'error', error: `whisper-cli exit code ${code}` });
                    sseEnd();
                } else if (isStream) {
                    sseSend({ status: 'done', text: finalOutput.trim() });
                    sseEnd();
                } else {
                    res.json({ text: finalOutput.trim() });
                }
                cleanupAndNext();
            });
        };

        ffmpegProc.on('error', (err) => {
            console.error('ffmpeg spawn error:', err);
            sseSend({ status: 'error', error: 'Ошибка конвертации аудио' });
            sseEnd();
            cleanupAndNext();
        });

        ffmpegProc.on('close', (code) => {
            if (code !== 0) {
                console.error(`ffmpeg exited with code ${code}`);
                sseSend({ status: 'error', error: `ffmpeg exit code ${code}` });
                sseEnd();
                cleanupAndNext();
                return;
            }
            runWhisper();
        });

    } catch (error) {
        console.error('Queue processing error:', error);
        if (isStream) {
            sseSend({ status: 'error', error: 'Ошибка на стороне KZ' });
            sseEnd();
        } else {
            res.status(500).json({ error: 'Ошибка на стороне KZ' });
        }
        cleanupAndNext();
    }

    function cleanupAndNext() {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
        isProcessing = false;
        processQueue();
    }
};

const TTS_VOICE = process.env.TTS_VOICE || 'ru-RU-DmitryNeural';
const TMP_DIR = path.resolve(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

app.use(express.json({ limit: '1mb' }));

const sendAndCleanup = (res, filePath, fileName) => {
    res.download(filePath, fileName, () => {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    });
};

const runEdgeTts = (text, filePath, onDone, onFail) => {
    const ttsProcess = spawn('edge-tts', ['--voice', TTS_VOICE, '--text', text, '--write-media', filePath], { shell: false });
    let stderr = '';

    ttsProcess.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
    });

    ttsProcess.on('error', (err) => onFail(err));
    ttsProcess.on('close', (code) => {
        if (code !== 0 || !fs.existsSync(filePath)) {
            return onFail(new Error(stderr || `edge-tts exit code ${code}`));
        }
        return onDone();
    });
};

const runSilero = (text, filePath, onDone, onFail) => {
    const safeText = text.replace(/"/g, '\\"');
    const cmd = `python3 silero_tts.py "${safeText}" "${filePath}"`;

    exec(cmd, (error) => {
        if (error || !fs.existsSync(filePath)) {
            return onFail(error || new Error('silero output file not found'));
        }
        return onDone();
    });
};

app.post('/api/tts', (req, res) => {
    if (req.headers.authorization !== `Bearer ${SECRET_TOKEN}`) {
        return res.status(403).send('Отказано в доступе');
    }

    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Нет текста' });

    const fileName = `tts_${Date.now()}.mp3`;
    const filePath = path.resolve(TMP_DIR, fileName);

    runEdgeTts(
        text,
        filePath,
        () => sendAndCleanup(res, filePath, fileName),
        (err) => {
            console.error('[TTS] edge-tts недоступен, переключаюсь на локальный Silero:', err);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

            const fallbackName = `tts_fallback_${Date.now()}.wav`;
            const fallbackPath = path.resolve(TMP_DIR, fallbackName);
            console.warn('[TTS] fallback активирован: endpoint=/api/tts, engine=edge-tts -> silero');
            runSilero(
                text,
                fallbackPath,
                () => sendAndCleanup(res, fallbackPath, fallbackName),
                (fallbackErr) => {
                    console.error('Ошибка fallback silero:', fallbackErr);
                    if (fs.existsSync(fallbackPath)) fs.unlinkSync(fallbackPath);
                    return res.status(500).json({ error: 'Ошибка генерации' });
                }
            );
        }
    );
});

app.post('/api/silero', (req, res) => {
    if (req.headers.authorization !== `Bearer ${SECRET_TOKEN}`) {
        return res.status(403).json({ error: 'Доступ запрещен' });
    }

    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Нет текста' });

    const fileName = `silero_${Date.now()}.wav`;
    const filePath = path.resolve(TMP_DIR, fileName);

    runSilero(
        text,
        filePath,
        () => sendAndCleanup(res, filePath, fileName),
        (err) => {
            console.error('Ошибка silero:', err);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            return res.status(500).json({ error: 'Ошибка генерации' });
        }
    );
});

// Старый эндпоинт — обычный JSON ответ. Не трогаем, chatter зависит от него.
app.post('/api/voice', upload.single('audio'), (req, res) => {
    if (req.headers.authorization !== `Bearer ${SECRET_TOKEN}`) {
        return res.status(403).send('Отказано в доступе');
    }
    if (!req.file?.path) {
        return res.status(400).json({ error: 'Файл не получен' });
    }

    queue.push({ res, inputPath: req.file.path, isStream: false });
    console.log(`[JSON] Добавлено в очередь. Позиция: ${queue.length}`);
    processQueue();
});

// Новый эндпоинт — SSE-стрим прогресса whisper.
// Отвечает text/event-stream с событиями: queued, converting, progress, done, error.
app.post('/api/voice/stream', upload.single('audio'), (req, res) => {
    if (req.headers.authorization !== `Bearer ${SECRET_TOKEN}`) {
        return res.status(403).send('Отказано в доступе');
    }
    if (!req.file?.path) {
        return res.status(400).json({ error: 'Файл не получен' });
    }

    // SSE-заголовки
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const queuePos = queue.length + (isProcessing ? 1 : 0);
    res.write(`data: ${JSON.stringify({ status: 'queued', position: queuePos })}\n\n`);

    queue.push({ res, inputPath: req.file.path, isStream: true });
    console.log(`[SSE] Добавлено в очередь. Позиция: ${queuePos}`);
    processQueue();
});

app.listen(3030, () => console.log('KZ Voice API с очередью запущен...'));
