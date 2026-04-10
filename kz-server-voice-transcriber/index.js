const express = require('express');
const multer = require('multer');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const upload = multer({ dest: 'tmp/' });
const SECRET_TOKEN = '***REMOVED_VOICE_SECRET***';

// Простейшая очередь
let queue = [];
let isProcessing = false;

const processQueue = async () => {
    if (isProcessing || queue.length === 0) return;
    isProcessing = true;

    const { req, res, inputPath } = queue.shift();
    const wavPath = `${inputPath}.wav`;

    try {
        console.log(`[${new Date().toISOString()}] Обработка файла: ${inputPath}`);
        
        // 1. Конвертация
        execSync(`ffmpeg -i ${inputPath} -ar 16000 -ac 1 -c:a pcm_s16le ${wavPath} -y`);

        // 2. Расшифровка (путь к модели изменен на small)
        const output = execSync(`../whisper.cpp/build/bin/whisper-cli -m ../whisper.cpp/models/ggml-small.bin -f ${wavPath} -nt -l ru`);

        res.json({ text: output.toString().trim() });
    } catch (error) {
        console.error('Ошибка в очереди:', error);
        res.status(500).json({ error: 'Ошибка на стороне KZ' });
    } finally {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
        isProcessing = false;
        processQueue(); // Запускаем следующий из очереди
    }
};

const TTS_VOICE = process.env.TTS_VOICE || 'ru-RU-DmitryNeural';
const TMP_DIR = path.resolve(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
}

app.use(express.json({ limit: '1mb' }));

app.post('/api/tts', (req, res) => {
    if (req.headers.authorization !== `Bearer ${SECRET_TOKEN}`) {
        return res.status(403).send('Отказано в доступе');
    }

    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) {
        return res.status(400).json({ error: 'Нет текста' });
    }

    const fileName = `tts_${Date.now()}.mp3`;
    const filePath = path.resolve(TMP_DIR, fileName);

    const ttsProcess = spawn(
        'edge-tts',
        ['--voice', TTS_VOICE, '--text', text, '--write-media', filePath],
        { shell: false }
    );

    let stderr = '';
    ttsProcess.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
    });

    ttsProcess.on('error', (err) => {
        console.error('Ошибка запуска edge-tts:', err);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return res.status(500).json({ error: 'Ошибка генерации' });
    });

    ttsProcess.on('close', (code) => {
        if (code !== 0 || !fs.existsSync(filePath)) {
            console.error('Ошибка TTS:', stderr || `exit code ${code}`);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            return res.status(500).json({ error: 'Ошибка генерации' });
        }

        res.download(filePath, fileName, () => {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        });
    });
});

app.post('/api/voice', upload.single('audio'), (req, res) => {
    if (req.headers.authorization !== `Bearer ${SECRET_TOKEN}`) {
        return res.status(403).send('Отказано в доступе');
    }

    // Добавляем запрос в очередь
    queue.push({ req, res, inputPath: req.file.path });
    console.log(`Добавлено в очередь. Позиция: ${queue.length}`);
    
    processQueue();
});

app.listen(3030, () => console.log('KZ Voice API с очередью запущен...'));
