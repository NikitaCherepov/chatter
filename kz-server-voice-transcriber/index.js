const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
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

const parseWhisperLanguage = (value) => {
    const language = `${value || 'auto'}`.trim().toLowerCase();
    if (language === 'auto' || /^[a-z]{2,3}$/.test(language)) return language;
    throw new Error('[config] VOICE_TRANSCRIBE_LANGUAGE must be auto or a 2-3 letter language code');
};

const parseTtsLanguage = (name, value, fallback) => {
    const language = `${value || fallback}`.trim().toLowerCase();
    if (language === 'ru' || language === 'en') return language;
    throw new Error(`[config] ${name} must be ru or en`);
};

const parseTtsProvider = (name, value, fallback, allowEmpty = false) => {
    const provider = `${value ?? fallback}`.trim().toLowerCase();
    if (allowEmpty && !provider) return '';
    if (provider === 'silero' || provider === 'piper' || provider === 'edge') return provider;
    throw new Error(`[config] ${name} must be silero, piper${allowEmpty ? ', edge, or empty' : ', or edge'}`);
};

const resolveOptionalPath = (value) => {
    const configuredPath = `${value || ''}`.trim();
    if (!configuredPath) return '';
    return path.isAbsolute(configuredPath)
        ? path.normalize(configuredPath)
        : path.resolve(__dirname, configuredPath);
};

const app = express();
const SECRET_TOKEN = requireEnv('VOICE_TRANSCRIBE_TOKEN');
const VOICE_API_PORT = parsePort(process.env.VOICE_API_PORT || '3030');
const MAX_UPLOAD_MB = parsePositiveInteger('VOICE_MAX_UPLOAD_MB', process.env.VOICE_MAX_UPLOAD_MB, 50);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const MAX_QUEUE_SIZE = parsePositiveInteger('VOICE_MAX_QUEUE_SIZE', process.env.VOICE_MAX_QUEUE_SIZE, 20);
const MAX_TTS_QUEUE_SIZE = parsePositiveInteger('VOICE_MAX_TTS_QUEUE_SIZE', process.env.VOICE_MAX_TTS_QUEUE_SIZE, 20);
const MAX_TTS_CHARS = parsePositiveInteger('VOICE_MAX_TTS_CHARS', process.env.VOICE_MAX_TTS_CHARS, 10000);
const TTS_TIMEOUT_MS = parsePositiveInteger('VOICE_TTS_TIMEOUT_MS', process.env.VOICE_TTS_TIMEOUT_MS, 300000);
const TMP_MAX_AGE_HOURS = parsePositiveInteger('VOICE_TMP_MAX_AGE_HOURS', process.env.VOICE_TMP_MAX_AGE_HOURS, 24);
const TMP_MAX_AGE_MS = TMP_MAX_AGE_HOURS * 60 * 60 * 1000;
const TTS_DEFAULT_LANGUAGE = parseTtsLanguage('TTS_DEFAULT_LANGUAGE', process.env.TTS_DEFAULT_LANGUAGE, 'ru');
const TTS_RU_PROVIDER = parseTtsProvider('TTS_RU_PROVIDER', process.env.TTS_RU_PROVIDER, 'silero');
const TTS_EN_PROVIDER = parseTtsProvider('TTS_EN_PROVIDER', process.env.TTS_EN_PROVIDER, 'piper');
const TTS_FALLBACK_PROVIDER = parseTtsProvider('TTS_FALLBACK_PROVIDER', process.env.TTS_FALLBACK_PROVIDER, '', true);
const EDGE_TTS_VOICE_RU = process.env.EDGE_TTS_VOICE_RU || process.env.TTS_VOICE || 'ru-RU-DmitryNeural';
const EDGE_TTS_VOICE_EN = process.env.EDGE_TTS_VOICE_EN || 'en-US-GuyNeural';
const PYTHON_BIN = `${process.env.PYTHON_BIN || 'python3'}`.trim();
const PIPER_MODEL_PATH = resolveOptionalPath(process.env.PIPER_MODEL_PATH);
const PIPER_CONFIG_PATH = resolveOptionalPath(process.env.PIPER_CONFIG_PATH);
const WHISPER_LANGUAGE = parseWhisperLanguage(process.env.VOICE_TRANSCRIBE_LANGUAGE);
const TMP_DIR = path.resolve(__dirname, 'tmp');
const WHISPER_BIN = path.resolve(__dirname, '../whisper.cpp/build/bin/whisper-cli');
const WHISPER_MODEL = path.resolve(__dirname, '../whisper.cpp/models/ggml-small.bin');
const SILERO_SCRIPT = path.resolve(__dirname, 'silero_tts.py');
const PIPER_WORKER_SCRIPT = path.resolve(__dirname, 'piper_tts_worker.py');

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
let ttsQueue = [];
let isTtsProcessing = false;
let cleanupRunning = false;
let computeBusy = false;
const computeWaiters = [];

const acquireComputeSlot = () => new Promise((resolve) => {
    if (!computeBusy) {
        computeBusy = true;
        return resolve();
    }
    computeWaiters.push(resolve);
});

const releaseComputeSlot = () => {
    const next = computeWaiters.shift();
    if (next) return next();
    computeBusy = false;
};

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
    let hasComputeSlot = false;
    let cleanupCompleted = false;

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
        await acquireComputeSlot();
        hasComputeSlot = true;
        if (res.destroyed || res.writableEnded) {
            cleanupAndNext();
            return;
        }

        console.log(`[${new Date().toISOString()}] Processing file: ${inputPath}`);
        sseSend({ status: 'progress', percent: 0, stage: 'converting' });

        await convertToWav(inputPath, wavPath);

        sseSend({ status: 'progress', percent: 0, stage: 'transcribing' });

        // Убрали выдуманный флаг. Оставляем только -pp
        const whisper = spawn(WHISPER_BIN, [
            '-m', WHISPER_MODEL,
            '-f', wavPath,
            '-nt',
            '-l', WHISPER_LANGUAGE,
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
            sseSend({ status: 'error', error: 'Ошибка конвертации на сервере расшифровки' });
            sseEnd();
        } else {
            res.status(500).json({ error: 'Ошибка на сервере расшифровки' });
        }
        cleanupAndNext();
    }

    function cleanupAndNext() {
        if (cleanupCompleted) return;
        cleanupCompleted = true;
        removeTempFile(inputPath);
        removeTempFile(wavPath);
        if (hasComputeSlot) releaseComputeSlot();
        isProcessing = false;
        processQueue();
    }
};

const sendAndCleanup = (res, filePath, fileName) => {
    res.download(filePath, fileName, () => {
        removeTempFile(filePath);
    });
};

const runEdgeTts = (text, filePath, language, onDone, onFail) => {
    const voice = language === 'en' ? EDGE_TTS_VOICE_EN : EDGE_TTS_VOICE_RU;
    const ttsProcess = spawn('edge-tts', ['--voice', voice, '--text', text, '--write-media', filePath], { shell: false });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ttsProcess.kill('SIGKILL');
        onFail(new Error(`Edge TTS timed out after ${TTS_TIMEOUT_MS} ms`));
    }, TTS_TIMEOUT_MS);

    ttsProcess.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
    });

    ttsProcess.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        onFail(err);
    });
    ttsProcess.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0 || !fs.existsSync(filePath)) {
            return onFail(new Error(stderr || `edge-tts exit code ${code}`));
        }
        return onDone();
    });
};

const runSilero = (text, filePath, onDone, onFail) => {
    const sileroProcess = spawn(PYTHON_BIN, [SILERO_SCRIPT, text, filePath], {
        cwd: __dirname,
        shell: false
    });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        sileroProcess.kill('SIGKILL');
        onFail(new Error(`Silero synthesis timed out after ${TTS_TIMEOUT_MS} ms`));
    }, TTS_TIMEOUT_MS);

    sileroProcess.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-8000);
    });
    sileroProcess.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        onFail(error);
    });
    sileroProcess.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0 || !fs.existsSync(filePath)) {
            return onFail(new Error(stderr || `silero exit code ${code}`));
        }
        return onDone();
    });
};

let piperState = null;

const failPiperState = (state, error) => {
    if (piperState === state) piperState = null;
    clearTimeout(state.readyTimer);
    if (!state.readySettled) {
        state.readySettled = true;
        state.rejectReady(error);
    }
    for (const pending of state.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
    }
    state.pending.clear();
};

const ensurePiperWorker = () => {
    if (piperState) return piperState.ready;
    if (!PIPER_MODEL_PATH) {
        return Promise.reject(new Error('PIPER_MODEL_PATH is not configured'));
    }
    if (!fs.existsSync(PIPER_MODEL_PATH)) {
        return Promise.reject(new Error('Piper model file is missing'));
    }
    const inferredConfigPath = PIPER_CONFIG_PATH || `${PIPER_MODEL_PATH}.json`;
    if (!fs.existsSync(inferredConfigPath)) {
        return Promise.reject(new Error('Piper model config file is missing'));
    }

    const child = spawn(PYTHON_BIN, [PIPER_WORKER_SCRIPT], {
        cwd: __dirname,
        shell: false,
        env: {
            ...process.env,
            PIPER_MODEL_PATH,
            PIPER_CONFIG_PATH: PIPER_CONFIG_PATH
        }
    });
    const state = {
        child,
        pending: new Map(),
        sequence: 0,
        stderr: '',
        readySettled: false,
        resolveReady: null,
        rejectReady: null,
        readyTimer: null,
        ready: null
    };
    state.ready = new Promise((resolve, reject) => {
        state.resolveReady = resolve;
        state.rejectReady = reject;
    });
    state.readyTimer = setTimeout(() => {
        state.child.kill('SIGKILL');
        failPiperState(state, new Error(`Piper worker startup timed out after ${TTS_TIMEOUT_MS} ms`));
    }, TTS_TIMEOUT_MS);
    piperState = state;

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            state.stderr = `${state.stderr}\n${line}`.slice(-8000);
            return;
        }

        if (message.event === 'ready') {
            if (!state.readySettled) {
                clearTimeout(state.readyTimer);
                state.readySettled = true;
                state.resolveReady(state);
            }
            return;
        }

        const pending = state.pending.get(message.id);
        if (!pending) return;
        state.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) return pending.resolve();
        return pending.reject(new Error(message.error || 'Piper synthesis failed'));
    });
    child.stderr.on('data', (chunk) => {
        state.stderr = `${state.stderr}${chunk.toString()}`.slice(-8000);
    });
    child.on('error', (error) => failPiperState(state, error));
    child.on('exit', (code, signal) => {
        const details = state.stderr.trim() || `Piper worker exited with code ${code}, signal ${signal}`;
        failPiperState(state, new Error(details));
    });

    return state.ready;
};

const runPiper = async (text, filePath) => {
    const state = await ensurePiperWorker();
    return new Promise((resolve, reject) => {
        const id = `piper-${++state.sequence}`;
        const timer = setTimeout(() => {
            state.pending.delete(id);
            removeTempFile(filePath);
            state.child.kill('SIGKILL');
            reject(new Error(`Piper synthesis timed out after ${TTS_TIMEOUT_MS} ms`));
        }, TTS_TIMEOUT_MS);
        state.pending.set(id, { resolve, reject, timer });
        state.child.stdin.write(`${JSON.stringify({ id, text, output_path: filePath })}\n`, (error) => {
            if (!error) return;
            const pending = state.pending.get(id);
            if (!pending) return;
            state.pending.delete(id);
            clearTimeout(timer);
            pending.reject(error);
        });
    });
};

process.once('exit', () => {
    if (piperState?.child && !piperState.child.killed) piperState.child.kill('SIGTERM');
});

const removeTempFile = (filePath) => {
    if (!filePath) return;
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (error) {
        console.warn('[cleanup] unlink failed:', formatSafeError(error));
    }
};

const detectTtsLanguage = (text) => {
    const cyrillicCount = (text.match(/[А-Яа-яЁё]/g) || []).length;
    const latinCount = (text.match(/[A-Za-z]/g) || []).length;
    if (cyrillicCount === 0 && latinCount === 0) return TTS_DEFAULT_LANGUAGE;
    return latinCount > cyrillicCount ? 'en' : 'ru';
};

const resolveTtsLanguage = (requestedLanguage, text) => {
    const language = `${requestedLanguage || 'auto'}`.trim().toLowerCase();
    if (language === 'auto') return detectTtsLanguage(text);
    if (language === 'ru' || language === 'en') return language;
    return null;
};

const getLocalTtsProvider = (language) => language === 'en' ? TTS_EN_PROVIDER : TTS_RU_PROVIDER;

const runCallbackTts = (runner) => new Promise((resolve, reject) => runner(resolve, reject));

const runTtsProvider = async (provider, text, language) => {
    const extension = provider === 'edge' ? 'mp3' : 'wav';
    const fileName = `tts_${provider}_${crypto.randomUUID()}.${extension}`;
    const filePath = path.resolve(TMP_DIR, fileName);

    try {
        if (provider === 'edge') {
            await runCallbackTts((resolve, reject) => runEdgeTts(text, filePath, language, resolve, reject));
        } else if (provider === 'silero') {
            await runCallbackTts((resolve, reject) => runSilero(text, filePath, resolve, reject));
        } else if (provider === 'piper') {
            await runPiper(text, filePath);
        } else {
            throw new Error(`Unsupported TTS provider: ${provider}`);
        }

        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile() || stat.size <= 44) throw new Error(`${provider} produced an empty audio file`);
        return { provider, language, fileName, filePath };
    } catch (error) {
        removeTempFile(filePath);
        throw error;
    }
};

const synthesizeWithFallback = async (primaryProvider, fallbackProvider, text, language) => {
    try {
        return await runTtsProvider(primaryProvider, text, language);
    } catch (error) {
        if (!fallbackProvider || fallbackProvider === primaryProvider) throw error;
        console.warn(`[TTS] ${primaryProvider} failed; trying ${fallbackProvider}:`, formatSafeError(error));
        return runTtsProvider(fallbackProvider, text, language);
    }
};

const processTtsQueue = async () => {
    if (isTtsProcessing || ttsQueue.length === 0) return;
    isTtsProcessing = true;
    const item = ttsQueue.shift();
    let hasComputeSlot = false;

    try {
        await acquireComputeSlot();
        hasComputeSlot = true;
        if (item.res.destroyed || item.res.writableEnded) return;

        const result = await synthesizeWithFallback(
            item.primaryProvider,
            item.fallbackProvider,
            item.text,
            item.language
        );
        if (item.res.destroyed || item.res.writableEnded) {
            removeTempFile(result.filePath);
            return;
        }
        item.res.setHeader('X-TTS-Language', result.language);
        item.res.setHeader('X-TTS-Provider', result.provider);
        sendAndCleanup(item.res, result.filePath, result.fileName);
    } catch (error) {
        console.error('[TTS] synthesis failed:', formatSafeError(error));
        if (!item.res.destroyed && !item.res.writableEnded) {
            item.res.status(500).json({ error: 'tts_generation_failed' });
        }
    } finally {
        if (hasComputeSlot) releaseComputeSlot();
        isTtsProcessing = false;
        processTtsQueue();
    }
};

const enqueueTts = (item) => {
    const totalPending = ttsQueue.length + (isTtsProcessing ? 1 : 0);
    if (totalPending >= MAX_TTS_QUEUE_SIZE) return false;
    ttsQueue.push(item);
    item.res.once('close', () => {
        const index = ttsQueue.indexOf(item);
        if (index !== -1) ttsQueue.splice(index, 1);
    });
    processTtsQueue();
    return true;
};

const handleTtsRequest = (req, res, forcedProvider = '') => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'text_required' });
    if (text.length > MAX_TTS_CHARS) {
        return res.status(413).json({ error: 'text_too_long', max_chars: MAX_TTS_CHARS });
    }

    const language = resolveTtsLanguage(req.body?.language, text);
    if (!language) return res.status(400).json({ error: 'language_must_be_auto_ru_or_en' });

    const localProvider = getLocalTtsProvider(language);
    const primaryProvider = forcedProvider || localProvider;
    const fallbackProvider = forcedProvider === 'edge'
        ? (localProvider === 'edge' ? TTS_FALLBACK_PROVIDER : localProvider)
        : TTS_FALLBACK_PROVIDER;
    const item = { res, text, language, primaryProvider, fallbackProvider };
    if (enqueueTts(item)) return;

    res.setHeader('Retry-After', '30');
    return res.status(429).json({ error: 'tts_queue_full', max_queue_size: MAX_TTS_QUEUE_SIZE });
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
    return handleTtsRequest(req, res, 'edge');
});

app.post('/api/silero', requireBearerAuth, jsonBody, (req, res) => {
    // Legacy route name kept for backend compatibility. Provider is selected by language.
    return handleTtsRequest(req, res);
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

app.listen(VOICE_API_PORT, () => console.log(`Voice Transcription API с очередью запущен на порту ${VOICE_API_PORT}...`));
