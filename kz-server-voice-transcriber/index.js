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

const processQueue = async () => {
    if (isProcessing || queue.length === 0) return;
    isProcessing = true;

    const { res, inputPath } = queue.shift();
    const wavPath = `${inputPath}.wav`;

    try {
        console.log(`[${new Date().toISOString()}] Processing file: ${inputPath}`);

        execSync(`ffmpeg -i ${inputPath} -ar 16000 -ac 1 -c:a pcm_s16le ${wavPath} -y`);
        const output = execSync(`../whisper.cpp/build/bin/whisper-cli -m ../whisper.cpp/models/ggml-small.bin -f ${wavPath} -nt -l ru`);

        res.json({ text: output.toString().trim() });
    } catch (error) {
        console.error('Queue processing error:', error);
        res.status(500).json({ error: 'Ошибка на стороне KZ' });
    } finally {
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

app.post('/api/voice', upload.single('audio'), (req, res) => {
    if (req.headers.authorization !== `Bearer ${SECRET_TOKEN}`) {
        return res.status(403).send('Отказано в доступе');
    }
    if (!req.file?.path) {
        return res.status(400).json({ error: 'Файл не получен' });
    }

    queue.push({ res, inputPath: req.file.path });
    console.log(`Добавлено в очередь. Позиция: ${queue.length}`);
    processQueue();
});

app.listen(3030, () => console.log('KZ Voice API с очередью запущен...'));
