import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, net, screen, shell } from 'electron';
import dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile, spawn } from 'child_process';
import util from 'util';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { WakeWordOnnxService } from './wakeword';

const originalFs = require('original-fs') as typeof fs;
const execFileAsync = util.promisify(execFile);

function asarUnpackedPath(filePath: string) {
  return app.isPackaged ? filePath.replace('app.asar', 'app.asar.unpacked') : filePath;
}

function firstExistingPath(paths: string[]) {
  return paths.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function requireExistingPath(label: string, paths: string[]) {
  const found = firstExistingPath(paths);
  if (!found) {
    throw new Error(`${label} not found. Checked: ${paths.join('; ')}`);
  }
  return found;
}

const getFfmpegPath = () => {
  if (!ffmpegStatic) {
    throw new Error('ffmpeg-static did not resolve an ffmpeg binary');
  }

  return requireExistingPath('ffmpeg binary', [
    asarUnpackedPath(ffmpegStatic),
    ffmpegStatic,
  ]);
};

try {
  ffmpeg.setFfmpegPath(getFfmpegPath());
} catch (error) {
  console.error('[ffmpeg] failed to resolve binary:', error);
}

// ── Wakeword (openWakeWord ONNX pipeline in Electron main) ────────────────

const getWakewordModelsDir = () => {
  return requireExistingPath('wakeword ONNX models directory', [
    app.isPackaged
      ? path.join(process.resourcesPath, 'wakeword', 'models')
      : path.join(__dirname, '..', '..', 'wakeword', 'models'),
  ]);
};

let wakewordService: WakeWordOnnxService | null = null;

function getWakewordService() {
  if (!wakewordService) {
    wakewordService = new WakeWordOnnxService({
      threshold: 0.55,
      debounceMs: 2000,
      vadThreshold: 0.45,
      modelsDir: getWakewordModelsDir(),
      onDetected: (payload) => {
        console.log('[wakeword] detected:', payload);

        mainWindow?.webContents.send('wakeword:detected', payload);
        mainWindow?.webContents.send('pixel-avatar:state', {
          state: 'listening',
          source: 'wakeword',
        });
      },
    });
  }

  return wakewordService;
}

// Dynamic model path: dev vs packaged
const getModelPath = () => {
  return requireExistingPath('whisper model', [
    app.isPackaged
      ? path.join(process.resourcesPath, 'models', 'ggml-small.bin')
      : path.join(__dirname, '..', '..', 'models', 'ggml-small.bin'),
  ]);
};

// Dynamic whisper.exe path: dev vs packaged
const getWhisperExePath = () => {
  return requireExistingPath('whisper executable', [
    app.isPackaged
      ? path.join(process.resourcesPath, 'models', 'whisper.exe')
      : path.join(__dirname, '..', '..', 'models', 'whisper.exe'),
  ]);
};

// Load .env — in dev it's at project root, in packaged app it's bundled inside dist/main/
const envPath = firstExistingPath(app.isPackaged
  ? [
      path.join(process.resourcesPath, 'app.asar', '.env'),
      path.join(process.resourcesPath, 'app', '.env'),
      path.join(__dirname, '..', '..', '.env'),
      path.join(__dirname, '.env'),
    ]
  : [
      path.join(__dirname, '..', '..', '.env'),
    ]);

if (envPath) {
  dotenv.config({ path: envPath });
} else {
  console.warn('[env] .env file not found');
}

const getPiperDir = () => {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'models', 'piper')
    : path.join(__dirname, '..', '..', 'models', 'piper');
};

const getPiperVoicesDir = () => {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'models', 'piper-voices')
    : path.join(__dirname, '..', '..', 'models', 'piper-voices');
};

function findPiperModelInFolder(folderPath: string) {
  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) return null;

  const files = fs.readdirSync(folderPath).filter((file) => file.endsWith('.onnx'));
  for (const file of files) {
    const modelFile = path.join(folderPath, file);
    const configFile = `${modelFile}.json`;
    if (!fs.existsSync(configFile)) {
      console.error('[tts:piper] config not found for model:', modelFile);
      continue;
    }
    if (fs.statSync(configFile).size === 0) {
      console.error('[tts:piper] config is empty for model:', modelFile);
      continue;
    }
    return modelFile;
  }

  return null;
}

function resolvePiperModel(voicesDir: string, voiceId?: string) {
  if (voiceId && /^[a-z0-9_-]+$/i.test(voiceId)) {
    const selected = findPiperModelInFolder(path.join(voicesDir, voiceId));
    if (selected) return selected;

    console.error('[tts:piper] selected voice is unavailable or invalid:', voiceId);
    return null;
  }

  const voiceFolders = fs.readdirSync(voicesDir).sort();
  for (const folder of voiceFolders) {
    const modelFile = findPiperModelInFolder(path.join(voicesDir, folder));
    if (modelFile) return modelFile;
  }

  return null;
}

let mainWindow: BrowserWindow | null = null;

function getRendererEntryPath(): string {
  return path.join(__dirname, '../renderer/index.html');
}

function isTrustedRendererUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (!app.isPackaged) {
      return url.protocol === 'http:'
        && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
        && url.port === '5173';
    }

    const expected = new URL(`file:///${getRendererEntryPath().replace(/\\/g, '/')}`);
    return url.protocol === 'file:' && url.pathname === expected.pathname;
  } catch {
    return false;
  }
}

function isTrustedIpcSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  const senderFrame = event.senderFrame;
  return mainWindow !== null
    && event.sender === mainWindow.webContents
    && senderFrame !== null
    && senderFrame === mainWindow.webContents.mainFrame
    && isTrustedRendererUrl(senderFrame.url);
}

function assertTrustedIpcSender(event: Electron.IpcMainInvokeEvent): void {
  if (isTrustedIpcSender(event)) return;
  console.warn('[ipc] rejected untrusted sender', { url: event.senderFrame?.url || 'unknown' });
  throw new Error('untrusted_ipc_sender');
}

// Register sync IPC handlers before createWindow (preload calls these at load time)
ipcMain.on('get-app-version', (event) => {
  if (!isTrustedIpcSender(event)) {
    console.warn('[ipc] rejected untrusted sender for get-app-version', { url: event.senderFrame?.url || 'unknown' });
    event.returnValue = null;
    return;
  }
  event.returnValue = app.getVersion();
});

ipcMain.handle('i18n:get-system-languages', (event) => {
  assertTrustedIpcSender(event);
  const languages = [
    app.getSystemLocale(),
    ...app.getPreferredSystemLanguages(),
  ].filter(Boolean);

  return [...new Set(languages)];
});

ipcMain.handle('window:set-title-bar-overlay', (event, colors: { color?: unknown; symbolColor?: unknown }) => {
  assertTrustedIpcSender(event);
  if (process.platform === 'darwin' || !mainWindow) return;

  const isHexColor = (value: unknown): value is string =>
    typeof value === 'string' && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value);

  if (!isHexColor(colors?.color) || !isHexColor(colors?.symbolColor)) {
    throw new Error('invalid_title_bar_colors');
  }

  mainWindow.setTitleBarOverlay({
    color: colors.color,
    symbolColor: colors.symbolColor,
    height: 40,
  });
});

function createWindow() {
  const isDev = !app.isPackaged;
  const rendererEntryPath = getRendererEntryPath();

  const openExternalHttpUrl = (rawUrl: string) => {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      void shell.openExternal(url.toString()).catch((err) => {
        console.error('[navigation] failed to open external URL:', err);
      });
    } catch {
      // Ignore malformed URLs.
    }
  };

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 600,
    minHeight: 500,
    title: 'Chatter',
    titleBarStyle: 'hidden',
    ...(process.platform !== 'darwin' ? {
      titleBarOverlay: {
        // Renderer synchronizes these system colors with global.scss after loading.
        height: 40,
      },
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalHttpUrl(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url)) return;
    event.preventDefault();
    openExternalHttpUrl(url);
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(rendererEntryPath);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // ── IPC: save-file (shows save dialog, writes blob to disk) ─────────────
  ipcMain.handle('save-file', async (event, fileName: string, data: ArrayBuffer) => {
    assertTrustedIpcSender(event);
    if (!mainWindow) return { canceled: true };
    const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
    const imageExts = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'];
    const docExts = ['docx', 'pdf', 'txt', 'md', 'json', 'csv', 'xml', 'yaml', 'ini', 'toml'];
    const filters: Electron.FileFilter[] = [];
    if (imageExts.includes(ext)) {
      filters.push({ name: 'Images', extensions: [ext] });
    } else if (docExts.includes(ext)) {
      filters.push({ name: 'Documents', extensions: [ext] });
    } else {
      filters.push({ name: 'Documents', extensions: ['docx'] });
    }
    filters.push({ name: 'All files', extensions: ['*'] });
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: fileName,
      filters,
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, Buffer.from(data));
    return { canceled: false, filePath: result.filePath };
  });

  // ── IPC: zoom ──────────────────────────────────────────────────────────
  ipcMain.handle('set-zoom-level', (event, level: number) => {
    assertTrustedIpcSender(event);
    if (!mainWindow) return;
    mainWindow.webContents.setZoomLevel(level);
  });

  ipcMain.handle('get-zoom-level', (event) => {
    assertTrustedIpcSender(event);
    if (!mainWindow) return 0;
    return mainWindow.webContents.getZoomLevel();
  });

  // ── IPC: transcribe-audio (voice → wav → whisper.exe → text) ──────────
  ipcMain.handle('transcribe-audio', async (event, arrayBuffer: ArrayBuffer) => {
    assertTrustedIpcSender(event);
    const tempDir = os.tmpdir();
    const inputPath = path.join(tempDir, `voice_input_${Date.now()}.webm`);
    const outputPath = path.join(tempDir, `voice_output_${Date.now()}.wav`);

    try {
      // 1. Save raw webm from browser
      console.log('[transcribe] 1. Saving webm, size:', arrayBuffer.byteLength);
      fs.writeFileSync(inputPath, Buffer.from(arrayBuffer));

      // 2. Convert to 16kHz mono wav
      console.log('[transcribe] 2. Converting to wav...');
      await new Promise<void>((resolve, reject) => {
        ffmpeg(inputPath)
          .outputOptions([
            '-ar 16000',
            '-ac 1',
            '-c:a pcm_s16le',
          ])
          .save(outputPath)
          .on('end', resolve)
          .on('error', reject);
      });

      // 3. Run whisper.exe directly
      const whisperExe = getWhisperExePath();
      const modelPath = getModelPath();

      console.log('[transcribe] 3. Running whisper.exe:', whisperExe);

      await execFileAsync(whisperExe, [
        '-m', modelPath,
        '-f', outputPath,
        '-l', 'ru',
        '-otxt',
      ], {
        cwd: path.dirname(whisperExe),
        windowsHide: true,
      });

      // whisper creates {outputPath}.txt
      const txtFilePath = `${outputPath}.txt`;
      const fullText = fs.readFileSync(txtFilePath, 'utf-8').trim();

      // 4. Clean up
      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
      if (fs.existsSync(txtFilePath)) {
        fs.unlinkSync(txtFilePath);
      }

      console.log('[transcribe] 4. Success:', fullText);
      return fullText;
    } catch (error) {
      console.error('[transcribe-audio] Error:', error);
      try { fs.unlinkSync(inputPath); } catch { /* ignore */ }
      try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
      const txtFilePath = `${outputPath}.txt`;
      try { fs.unlinkSync(txtFilePath); } catch { /* ignore */ }
      throw error;
    }
  });

  // ── IPC: wakeword start/stop ─────────────────────────────────────────────
  ipcMain.handle('wakeword:start', async (event) => {
    assertTrustedIpcSender(event);
    try {
      return await getWakewordService().start();
    } catch (error) {
      console.error('[wakeword] failed to start ONNX listener:', error);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('wakeword:stop', (event) => {
    assertTrustedIpcSender(event);
    return getWakewordService().stop();
  });

  ipcMain.on('wakeword-audio-chunk', (event, buffer: ArrayBuffer | Uint8Array) => {
    if (!isTrustedIpcSender(event)) {
      console.warn('[ipc] rejected untrusted sender for wakeword-audio-chunk', { url: event.senderFrame?.url || 'unknown' });
      return;
    }
    getWakewordService().processAudioChunk(buffer);
  });

  // ── IPC: tts:generate (text → piper.exe → WAV buffer) ──────────────────
  ipcMain.handle('tts:generate', async (event, text: string, voiceId?: string) => {
    assertTrustedIpcSender(event);
    const piperDir = getPiperDir();

    const piperExe = path.join(piperDir, 'piper.exe');
    if (!fs.existsSync(piperExe)) {
      console.error('[tts:piper] piper.exe not found at:', piperExe);
      return null;
    }

    const voicesDir = getPiperVoicesDir();

    if (!fs.existsSync(voicesDir)) {
      console.error('[tts:piper] voices dir not found at:', voicesDir);
      return null;
    }

    const modelFile = resolvePiperModel(voicesDir, voiceId);

    if (!modelFile) {
      console.error('[tts:piper] no valid .onnx voice model found in:', voicesDir);
      return null;
    }

    console.log('[tts:piper] using voice model:', modelFile);

    const outPath = path.join(os.tmpdir(), `chatter_tts_${Date.now()}.wav`);

    return new Promise((resolve) => {
      const piper = spawn(piperExe, ['-m', modelFile, '-f', outPath], {
        cwd: piperDir,
        windowsHide: true,
      });

      piper.stdin.write(text + '\n');
      piper.stdin.end();

      piper.on('close', (code) => {
        if (code === 0 && fs.existsSync(outPath)) {
          const buffer = fs.readFileSync(outPath);
          try { fs.unlinkSync(outPath); } catch { /* ignore */ }
          resolve(buffer);
        } else {
          console.error(`[tts:piper] exited with code ${code}`);
          try { fs.unlinkSync(outPath); } catch { /* ignore */ }
          resolve(null);
        }
      });

      piper.on('error', (err) => {
        console.error('[tts:piper] process error:', err);
        try { fs.unlinkSync(outPath); } catch { /* ignore */ }
        resolve(null);
      });
    });
  });

  // ── IPC: get sounds path ────────────────────────────────────────────────
  ipcMain.handle('get-sounds-path', (event) => {
    assertTrustedIpcSender(event);
    const soundsDir = app.isPackaged
      ? path.join(process.resourcesPath, 'sounds')
      : path.join(__dirname, '..', '..', 'sounds');
    return soundsDir;
  });

  ipcMain.handle('read-sound-file', (event, fileName: string) => {
    assertTrustedIpcSender(event);
    const safeName = path.basename(fileName);
    if (safeName !== fileName || !/\.(mp3|wav|ogg)$/i.test(safeName)) {
      console.error('[sounds] rejected unsafe file name:', fileName);
      return null;
    }

    const soundsDir = app.isPackaged
      ? path.join(process.resourcesPath, 'sounds')
      : path.join(__dirname, '..', '..', 'sounds');
    const soundPath = path.join(soundsDir, safeName);

    if (!fs.existsSync(soundPath)) {
      console.error('[sounds] file not found:', soundPath);
      return null;
    }

    return fs.readFileSync(soundPath);
  });

  // ── Macro IPC: execute commands ──

  ipcMain.handle('execute-commands', async (event, commands: string[], options?: { background?: boolean }) => {
    assertTrustedIpcSender(event);
    const batchStartedAt = Date.now();
    const background = options?.background === true;
    console.log('[execute-commands] batch start', {
      count: Array.isArray(commands) ? commands.length : 0,
      background,
      commands,
    });

    if (!Array.isArray(commands) || commands.length === 0) {
      throw new Error('commands_required');
    }

    const results: string[] = [];
    for (const cmd of commands) {
      if (typeof cmd !== 'string' || !cmd.trim()) {
        results.push('[skip] empty command');
        continue;
      }

      // Block dangerous commands
      const lowerCmd = cmd.toLowerCase().trim();
      const dangerousPatterns = ['rm -rf /', 'format ', 'del /f /s /q c:', 'rd /s /q c:', 'shutdown', 'rmdir /s /q'];
      if (dangerousPatterns.some(p => lowerCmd.includes(p))) {
        results.push(`[blocked] potentially dangerous command: ${cmd}`);
        continue;
      }

      try {
        const { exec } = require('child_process');
        const execAsync = util.promisify(exec);

        // Fix кракозябр на Windows: cmd.exe получает аргументы в системной ANSI
        // кодировке (cp1251/cp866), chcp 65001 срабатывает уже после парсинга.
        // Решение: двойной Base64.
        // 1) Исходная команда кодируется в Base64 (UTF-16LE для .NET) — защищает
        //    от сломанных кавычек, спецсимволов, кириллицы в аргументах.
        // 2) PowerShell-скрипт, который декодирует команду и выполняет её через
        //    `cmd.exe /c` (сохраняем cmd-семантику &&, |, >), сам тоже пакуется в
        //    Base64 и передаётся через -EncodedCommand.
        let execCmd = cmd;
        if (process.platform === 'win32') {
          const cmdB64 = Buffer.from(cmd, 'utf16le').toString('base64');
          const psScript = [
            '$OutputEncoding = [System.Text.Encoding]::UTF8',
            '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
            `$decCmd = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${cmdB64}'))`,
            'cmd.exe /c "$decCmd"',
          ].join('; ');
          const scriptB64 = Buffer.from(psScript, 'utf16le').toString('base64');
          execCmd = `powershell -NoProfile -EncodedCommand ${scriptB64}`;
        }
        const cmdStartedAt = Date.now();
        console.log('[execute-commands] cmd start', {
          cmd,
          execCmd,
          timeoutMs: 30000,
          background,
        });
        if (background) {
          const child = spawn(execCmd, [], {
            detached: true,
            stdio: 'ignore',
            shell: true,
            windowsHide: true,
          });
          child.unref();
          console.log('[execute-commands] cmd background launched', {
            cmd,
            durationMs: Date.now() - cmdStartedAt,
            pid: child.pid,
          });
          results.push(`[background] launched: ${cmd}`);
          continue;
        }
        const { stdout, stderr } = await execAsync(execCmd, {
          encoding: 'utf-8',
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        });
        console.log('[execute-commands] cmd done', {
          cmd,
          durationMs: Date.now() - cmdStartedAt,
          stdoutLength: stdout?.length || 0,
          stderrLength: stderr?.length || 0,
          stdoutPreview: stdout ? stdout.slice(0, 300) : undefined,
          stderrPreview: stderr ? stderr.slice(0, 300) : undefined,
        });
        results.push(stdout || stderr || '[no output]');
      } catch (err: any) {
        console.error('[execute-commands] cmd error', {
          cmd,
          message: err?.message || String(err),
          code: err?.code,
          signal: err?.signal,
          killed: err?.killed,
          stdoutPreview: typeof err?.stdout === 'string' ? err.stdout.slice(0, 300) : undefined,
          stderrPreview: typeof err?.stderr === 'string' ? err.stderr.slice(0, 300) : undefined,
        });
        results.push(`[error] ${err?.message || String(err)}`);
      }
    }

    console.log('[execute-commands] batch done', {
      durationMs: Date.now() - batchStartedAt,
      resultLength: results.join('\n---\n').length,
    });
    return results.join('\n---\n');
  });

  // ── Macro IPC: read directory (read-only) ──

  ipcMain.handle('read-directory', async (event, targetPath: string) => {
    assertTrustedIpcSender(event);
    if (typeof targetPath !== 'string' || !targetPath.trim()) {
      throw new Error('target_path_required');
    }

    const resolved = path.resolve(targetPath);

    // Verify path exists and is a directory
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error('not_a_directory');
    }

    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    return entries.map(entry => {
      try {
        const fullPath = path.join(resolved, entry.name);
        const entryStat = fs.statSync(fullPath);
        return {
          name: entry.name,
          isDirectory: entry.isDirectory(),
          size: entry.isDirectory() ? undefined : entryStat.size,
        };
      } catch {
        return {
          name: entry.name,
          isDirectory: entry.isDirectory(),
        };
      }
    });
  });

  // ── File Action: read file natively (UTF-8, paginated, .docx supported, line numbers) ──

  ipcMain.handle('get-file-info', async (event, payload: { file_path: string; include_line_count?: boolean }) => {
    assertTrustedIpcSender(event);
    const filePath = typeof payload?.file_path === 'string' ? payload.file_path.trim() : '';
    if (!filePath) throw new Error('file_path_required');

    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      return {
        exists: false,
        file_path: filePath,
        resolved_path: resolved,
      };
    }

    const stat = fs.statSync(resolved);
    const isFile = stat.isFile();
    const isDirectory = stat.isDirectory();

    const info: Record<string, unknown> = {
      exists: true,
      file_path: filePath,
      resolved_path: resolved,
      name: path.basename(resolved),
      extension: isFile ? path.extname(resolved).toLowerCase() : '',
      is_file: isFile,
      is_directory: isDirectory,
      size_bytes: stat.size,
      modified_at: stat.mtime.toISOString(),
      created_at: stat.birthtime.toISOString(),
    };

    if (isFile && payload?.include_line_count === true) {
      const readline = require('readline');
      const fileStream = fs.createReadStream(resolved, { encoding: 'utf-8' });
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });
      let lineCount = 0;
      for await (const _line of rl) {
        lineCount++;
      }
      fileStream.destroy();
      info.line_count = lineCount;
    }

    return info;
  });

  ipcMain.handle('read-file', async (event, payload: { file_path: string; start_line?: number; max_lines?: number; line_numbers?: boolean }) => {
    assertTrustedIpcSender(event);
    const filePath = typeof payload?.file_path === 'string' ? payload.file_path.trim() : '';
    if (!filePath) throw new Error('file_path_required');

    const startLine = typeof payload?.start_line === 'number' && payload.start_line > 0 ? Math.floor(payload.start_line) : 1;
    const maxLines = typeof payload?.max_lines === 'number' && payload.max_lines > 0 ? Math.min(Math.floor(payload.max_lines), 2000) : 500;
    const showLineNumbers = payload?.line_numbers === true;

    const resolved = path.resolve(filePath);

    // Verify path exists and is a file
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      throw new Error('not_a_file');
    }

    const ext = path.extname(resolved).toLowerCase();

    // .docx: extract text via mammoth, then paginate by lines
    if (ext === '.docx') {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ path: resolved });
      const fullText: string = result.value || '';
      const allLines = fullText.split('\n');
      const totalLines = allLines.length;
      const endLine = Math.min(startLine + maxLines - 1, totalLines);
      const sliced = allLines.slice(startLine - 1, endLine);

      const formatted = showLineNumbers
        ? sliced.map((line, i) => `${String(startLine + i).padStart(6, ' ')}\t${line}`)
        : sliced;

      return {
        content: formatted.join('\n'),
        start_line: startLine,
        read_lines: sliced.length,
        total_lines: totalLines,
        encoding: 'utf-8',
        format: 'docx',
        line_numbers: showLineNumbers,
      };
    }

    // Default: read text file line by line (memory-efficient for large files)
    const readline = require('readline');
    const fileStream = fs.createReadStream(resolved, { encoding: 'utf-8' });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    const lines: string[] = [];
    let currentLine = 0;
    const endLine = startLine + maxLines - 1;

    for await (const line of rl) {
      currentLine++;
      if (currentLine < startLine) continue;
      if (currentLine <= endLine) {
        lines.push(line);
      }
    }

    const totalLines = currentLine;
    fileStream.destroy();

    const formatted = showLineNumbers
      ? lines.map((line, i) => `${String(startLine + i).padStart(6, ' ')}\t${line}`)
      : lines;

    return {
      content: formatted.join('\n'),
      start_line: startLine,
      read_lines: lines.length,
      total_lines: totalLines,
      encoding: 'utf-8',
      line_numbers: showLineNumbers,
    };
  });

  // ── File Action: write file natively (UTF-8, overwrite or append, .docx supported) ──

  ipcMain.handle('search-file-keywords', async (event, payload: { file_path: string; query: string; max_matches?: number }) => {
    assertTrustedIpcSender(event);
    const filePath = typeof payload?.file_path === 'string' ? payload.file_path.trim() : '';
    if (!filePath) throw new Error('file_path_required');

    const query = typeof payload?.query === 'string' ? payload.query.trim() : '';
    if (!query) throw new Error('query_required');

    const maxMatches = typeof payload?.max_matches === 'number' && payload.max_matches > 0
      ? Math.min(Math.floor(payload.max_matches), 500)
      : 100;
    const normalizedQuery = query.toLowerCase();
    const resolved = path.resolve(filePath);

    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      throw new Error('not_a_file');
    }

    const matches: Array<{ line_number: number; line: string }> = [];
    let totalLines = 0;

    const visitLine = (line: string) => {
      totalLines++;
      if (matches.length >= maxMatches) return;
      if (line.toLowerCase().includes(normalizedQuery)) {
        matches.push({ line_number: totalLines, line: line.trim() });
      }
    };

    const ext = path.extname(resolved).toLowerCase();
    if (ext === '.docx') {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ path: resolved });
      const fullText: string = result.value || '';
      for (const line of fullText.split('\n')) {
        visitLine(line);
      }
    } else {
      const readline = require('readline');
      const fileStream = fs.createReadStream(resolved, { encoding: 'utf-8' });
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        visitLine(line);
      }

      fileStream.destroy();
    }

    const content = matches.length === 0
      ? `No matches for query "${query}".`
      : `Found ${matches.length}${matches.length >= maxMatches ? '+' : ''} matches:\n` +
        matches.map(match => `[Line ${match.line_number}]: ${match.line}`).join('\n');

    return {
      content,
      matches,
      match_count: matches.length,
      truncated: matches.length >= maxMatches,
      total_lines: totalLines,
      query,
      encoding: 'utf-8',
      format: ext === '.docx' ? 'docx' : 'text',
    };
  });

  ipcMain.handle('write-file', async (event, payload: { file_path: string; content: string; mode?: 'overwrite' | 'append' }) => {
    assertTrustedIpcSender(event);
    const filePath = typeof payload?.file_path === 'string' ? payload.file_path.trim() : '';
    if (!filePath) throw new Error('file_path_required');

    const content = typeof payload?.content === 'string' ? payload.content : '';
    const mode = payload?.mode === 'append' ? 'append' : 'overwrite';

    const resolved = path.resolve(filePath);
    const ext = path.extname(resolved).toLowerCase();

    // Ensure parent directory exists
    const parentDir = path.dirname(resolved);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // .docx: generate valid Word document via docx package
    if (ext === '.docx') {
      if (mode === 'append') {
        throw new Error("Режим 'append' не поддерживается для .docx. Прочитайте файл через read_file, добавьте текст и используйте 'overwrite'.");
      }

      const { Document, Packer, Paragraph, TextRun } = require('docx');

      // Split plain text into paragraphs by newlines
      const paragraphs = content.split('\n').map((line: string) =>
        new Paragraph({
          children: [new TextRun(line)],
        })
      );

      const doc = new Document({
        sections: [{
          properties: {},
          children: paragraphs,
        }],
      });

      const buffer = await Packer.toBuffer(doc);
      await fs.promises.writeFile(resolved, buffer);

      return { ok: true, bytes_written: buffer.length, mode, format: 'docx' };
    }

    // Default: plain text write
    if (mode === 'append') {
      await fs.promises.appendFile(resolved, content, { encoding: 'utf-8' });
    } else {
      await fs.promises.writeFile(resolved, content, { encoding: 'utf-8' });
    }

    const bytesWritten = Buffer.byteLength(content, 'utf-8');
    return { ok: true, bytes_written: bytesWritten, mode };
  });

  // ── File Action: edit file lines (surgical splice) ──

  ipcMain.handle('edit-file-lines', async (event, payload: { file_path: string; start_line: number; end_line: number; new_content: string }) => {
    assertTrustedIpcSender(event);
    const filePath = typeof payload?.file_path === 'string' ? payload.file_path.trim() : '';
    if (!filePath) throw new Error('file_path_required');

    const startLine = typeof payload?.start_line === 'number' ? Math.floor(payload.start_line) : 0;
    const endLine = typeof payload?.end_line === 'number' ? Math.floor(payload.end_line) : 0;
    const newContent = typeof payload?.new_content === 'string' ? payload.new_content : '';

    if (startLine < 1) throw new Error('start_line must be >= 1');

    const resolved = path.resolve(filePath);

    // Read entire file and split into lines
    const rawData = await fs.promises.readFile(resolved, 'utf-8');
    const lines = rawData.split('\n');
    const totalLinesBefore = lines.length;

    // Bounds check
    if (startLine > lines.length + 1) {
      throw new Error(`start_line (${startLine}) выходит за пределы файла (всего строк: ${lines.length})`);
    }

    // Convert 1-indexed line numbers to 0-indexed array positions
    const startIndex = startLine - 1;
    const deleteCount = endLine >= startLine ? endLine - startLine + 1 : 0;

    // Split new content into lines
    const newLines = newContent ? newContent.split('\n') : [];

    // Splice: remove old lines, insert new ones
    lines.splice(startIndex, deleteCount, ...newLines);

    // Write back
    await fs.promises.writeFile(resolved, lines.join('\n'), { encoding: 'utf-8' });

    const totalLinesAfter = lines.length;
    return {
      ok: true,
      lines_removed: deleteCount,
      lines_added: newLines.length,
      total_lines_before: totalLinesBefore,
      total_lines_after: totalLinesAfter,
    };
  });

  // ── Visual Control: capture screen (all monitors) ──

  ipcMain.handle('capture-screen', async (event) => {
    assertTrustedIpcSender(event);
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
      fetchWindowIcons: false,
    });

    const displays = screen.getAllDisplays();

    const result = sources.map((source, idx) => {
      const display = displays[idx] || displays[0];
      const thumb = source.thumbnail;
      const pngBuffer = thumb.toPNG();
      // Compress to JPEG via sharp if available, fallback to PNG base64
      const base64 = pngBuffer.toString('base64');

      return {
        display_id: source.display_id || String(source.id),
        name: source.name,
        bounds: {
          x: display.bounds.x,
          y: display.bounds.y,
          width: display.bounds.width,
          height: display.bounds.height,
        },
        scale_factor: display.scaleFactor || 1,
        screenshot_base64: base64,
        screenshot_mime: 'image/png',
        thumbnail_width: thumb.getSize().width,
        thumbnail_height: thumb.getSize().height,
      };
    });

    return { displays: result };
  });

  // ── Visual Control: capture webcam photo ──

  ipcMain.handle('capture-webcam', async (event, payload?: { camera_name?: string }) => {
    assertTrustedIpcSender(event);
    const cameraName = payload?.camera_name || 'Microsoft Modern Webcam';
    const outPath = path.join(app.getPath('temp'), `chatter_webcam_${Date.now()}.jpg`);

    try {
      await new Promise<void>((resolve, reject) => {
        execFile(getFfmpegPath(), [
          '-y', '-f', 'dshow', '-video_size', '1280x720',
          '-i', `video=${cameraName}`,
          '-frames:v', '1',
          outPath,
        ], { timeout: 15000 }, (err) => {
          if (err) reject(new Error(err.message || 'ffmpeg_failed'));
          else resolve();
        });
      });

      const buffer = await fs.promises.readFile(outPath);
      // Clean up temp file
      await fs.promises.unlink(outPath).catch(() => {});

      return {
        screenshot_base64: buffer.toString('base64'),
        camera: cameraName,
      };
    } catch (err: any) {
      return {
        screenshot_base64: null,
        error: `Не удалось сделать фото: ${err.message}. Камера "${cameraName}" может быть занята или отключена.`,
        camera: cameraName,
      };
    }
  });





  // ── Visual Control: execute mouse click ──

  ipcMain.handle('visual-click', async (event, data: {
    display_id?: string;
    x: number;
    y: number;
    button?: string;
  }) => {
    assertTrustedIpcSender(event);
    if (!data || typeof data.x !== 'number' || typeof data.y !== 'number') {
      throw new Error('x_y_required');
    }

    // display_id from desktopCapturer may not match screen.Display.id
    // Match by index: capture-screen returns sources in same order as getAllDisplays
    const displays = screen.getAllDisplays();
    let targetDisplay = displays[0];

    if (data.display_id) {
      // Try matching by id string, then by index
      const byId = displays.find(d => String(d.id) === data.display_id);
      if (byId) {
        targetDisplay = byId;
      } else {
        // display_id might be an index or source name — try parsing as number
        const idx = parseInt(data.display_id, 10);
        if (!isNaN(idx) && idx >= 0 && idx < displays.length) {
          targetDisplay = displays[idx];
        }
      }
    }

    const globalX = Math.round(targetDisplay.bounds.x + data.x * targetDisplay.bounds.width);
    const globalY = Math.round(targetDisplay.bounds.y + data.y * targetDisplay.bounds.height);

    const button = data.button === 'right' ? 'right' : 'left';

    console.log('[visual-click]', {
      display_id: data.display_id,
      normalized: { x: data.x, y: data.y },
      global: { x: globalX, y: globalY },
      button,
      targetDisplay: { id: targetDisplay.id, bounds: targetDisplay.bounds },
    });

    try {
      const { mouse, Point } = await import('@nut-tree-fork/nut-js');
      mouse.config.mouseSpeed = 500;
      await mouse.setPosition(new Point(globalX, globalY));
      await new Promise(resolve => setTimeout(resolve, 150));
      if (button === 'right') {
        await mouse.rightClick();
      } else {
        await mouse.leftClick();
      }
      return { status: 'ok', x: globalX, y: globalY, button };
    } catch (err: any) {
      console.error('[visual-click] nut.js error:', err?.message || String(err));
      throw new Error(`click_failed: ${err?.message || String(err)}`);
    }
  });

  ipcMain.handle('read-ssh-keys', async (event) => {
    assertTrustedIpcSender(event);
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    if (!homeDir) throw new Error('no_home_dir');

    const sshDir = path.join(homeDir, '.ssh');
    if (!fs.existsSync(sshDir)) throw new Error('no_ssh_dir');

    const entries = fs.readdirSync(sshDir).filter(f =>
      f.startsWith('id_') && !f.endsWith('.pub') && !f.endsWith('.pem')
    );

    const keys: { name: string; filename: string; publicKey?: string; privateKey?: string }[] = [];

    for (const filename of entries) {
      const privateKeyPath = path.join(sshDir, filename);
      const publicKeyPath = path.join(sshDir, filename + '.pub');

      const entry: typeof keys[0] = {
        name: filename,
        filename,
      };

      try {
        if (fs.existsSync(publicKeyPath)) {
          entry.publicKey = fs.readFileSync(publicKeyPath, 'utf-8').trim();
        }
      } catch {}
      try {
        entry.privateKey = fs.readFileSync(privateKeyPath, 'utf-8').trim();
      } catch {}

      if (entry.publicKey || entry.privateKey) {
        keys.push(entry);
      }
    }

    return keys;
  });
}

// ── Custom Updater (ASAR Hot-Swap + Full Installer) ──────────────────────

interface VersionManifest {
  version: string;
  type: 'minor' | 'major';
  downloadUrl: string;
  releaseNotes?: string;
  size?: number;
}

function areAutoUpdatesEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.AUTO_UPDATES_ENABLED?.trim() || '');
}

function getUpdatesBaseUrl(): string | null {
  const configuredUrl = process.env.UPDATES_FEED_URL?.trim();
  return configuredUrl ? configuredUrl.replace(/\/$/, '') : null;
}

function compareVersions(a: string, b: string): number {
  const parse = (version: string) => version
    .split('.')
    .map((part) => Number.parseInt(part.replace(/\D.*$/, ''), 10) || 0);

  const left = parse(a);
  const right = parse(b);
  const maxLength = Math.max(left.length, right.length);

  for (let i = 0; i < maxLength; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }

  return 0;
}

function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

function getUpdateTempExtension(downloadUrl: string): string {
  try {
    const parsed = new URL(downloadUrl);
    const ext = path.extname(parsed.pathname).toLowerCase();
    if (ext === '.exe') return ext;
  } catch {
    const ext = path.extname(downloadUrl).toLowerCase();
    if (ext === '.exe') return ext;
  }

  return '.tmp';
}

function setupCustomUpdater() {
  if (!app.isPackaged) return;
  if (!areAutoUpdatesEnabled()) {
    console.log('[updater] disabled (set AUTO_UPDATES_ENABLED=true to enable)');
    return;
  }

  const baseUrl = getUpdatesBaseUrl();
  if (!baseUrl) {
    console.warn('[updater] AUTO_UPDATES_ENABLED is true, but UPDATES_FEED_URL is not configured');
    return;
  }

  const logPath = path.join(app.getPath('userData'), 'updater.log');
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    logStream.write(line);
    console.log(`[updater] ${msg}`);
  };

  log('=== app started ===');
  log(`version: ${app.getVersion()}`);

  const manifestUrl = `${baseUrl}/version.json`;

  // ── IPC: check-for-updates ────────────────────────────────────────────
  ipcMain.handle('update:check', async (event) => {
    assertTrustedIpcSender(event);
    try {
      log(`checking: ${manifestUrl}`);
      const response = await net.fetch(manifestUrl);
      if (!response.ok) {
        log(`manifest fetch failed: ${response.status}`);
        return { error: `manifest_fetch_failed: ${response.status}` };
      }

      const manifest = (await response.json()) as VersionManifest;
      log(`manifest version: ${manifest.version}, type: ${manifest.type}`);

      const currentVersion = app.getVersion();
      if (isNewerVersion(manifest.version, currentVersion)) {
        return {
          updateAvailable: true,
          version: manifest.version,
          type: manifest.type,
          downloadUrl: manifest.downloadUrl.startsWith('http')
            ? manifest.downloadUrl
            : `${baseUrl}/${manifest.downloadUrl}`,
          releaseNotes: manifest.releaseNotes || '',
          size: manifest.size || 0,
        };
      }

      return { updateAvailable: false };
    } catch (err: any) {
      log(`check error: ${err?.message || err}`);
      return { error: err?.message || String(err) };
    }
  });

  // ── IPC: update:download ──────────────────────────────────────────────
  ipcMain.handle('update:download', async (event, downloadUrl: string) => {
    assertTrustedIpcSender(event);
    try {
      log(`downloading: ${downloadUrl}`);

      const response = await net.fetch(downloadUrl);
      if (!response.ok) {
        log(`download failed: ${response.status}`);
        return { error: `download_failed: ${response.status}` };
      }

      const totalBytes = parseInt(response.headers.get('content-length') || '0', 10);
      const tempDir = app.getPath('temp');
      const tempPath = path.join(tempDir, `chatter_update_${Date.now()}${getUpdateTempExtension(downloadUrl)}`);
      const fileStream = fs.createWriteStream(tempPath);
      const streamError = new Promise<never>((_resolve, reject) => {
        fileStream.once('error', reject);
      });

      let downloadedBytes = 0;

      if (!response.body) {
        log('no response body');
        return { error: 'no_response_body' };
      }

      const reader = response.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (!fileStream.write(value)) {
          await Promise.race([
            new Promise<void>((resolve) => fileStream.once('drain', resolve)),
            streamError,
          ]);
        }
        downloadedBytes += value.length;

        mainWindow?.webContents.send('update:progress', {
          percent: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
          transferred: downloadedBytes,
          total: totalBytes,
        });
      }

      fileStream.end();
      await Promise.race([
        new Promise<void>((resolve) => fileStream.once('finish', resolve)),
        streamError,
      ]);

      log(`download complete: ${downloadedBytes} bytes -> ${tempPath}`);
      return { success: true, tempPath };
    } catch (err: any) {
      log(`download error: ${err?.message || err}`);
      return { error: err?.message || String(err) };
    }
  });

  // ── IPC: update:install-minor (ASAR Hot-Swap) ────────────────────────
  ipcMain.handle('update:install-minor', async (event, tempPath: string) => {
    assertTrustedIpcSender(event);
    try {
      if (!fs.existsSync(tempPath)) {
        return { error: 'temp_file_not_found' };
      }

      const asarPath = path.join(process.resourcesPath, 'app.asar');
      const backupPath = `${asarPath}.bak`;

      log(`installing minor update: ${tempPath} -> ${asarPath}`);

      // Electron patches fs for .asar paths; original-fs accesses the real archive file.
      if (!originalFs.existsSync(asarPath)) {
        return { error: `app_asar_not_found: ${asarPath}` };
      }
      originalFs.copyFileSync(asarPath, backupPath);
      log(`backup created: ${backupPath}`);

      // Write helper script for hot-swap (file is locked while app is running).
      const exePath = app.getPath('exe');
      const scriptPath = path.join(app.getPath('temp'), `chatter_hotswap_${Date.now()}.ps1`);
      const launcherPath = path.join(app.getPath('temp'), `chatter_hotswap_${Date.now()}.vbs`);
      const hotswapLogPath = path.join(app.getPath('userData'), 'updater-hotswap.log');
      const currentPid = process.pid;

      const psString = (value: string) => `'${value.replace(/'/g, "''")}'`;
      const scriptContent = [
        '$ErrorActionPreference = "Stop"',
        `$tempFile = ${psString(tempPath)}`,
        `$asarFile = ${psString(asarPath)}`,
        `$exeFile = ${psString(exePath)}`,
        `$logFile = ${psString(hotswapLogPath)}`,
        `$scriptFile = ${psString(scriptPath)}`,
        `$launcherFile = ${psString(launcherPath)}`,
        'try {',
        `  Add-Content -LiteralPath $logFile -Value "[$(Get-Date -Format o)] hotswap started, waiting for pid ${currentPid}"`,
        `  while (Get-Process -Id ${currentPid} -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 500 }`,
        '  Add-Content -LiteralPath $logFile -Value "[$(Get-Date -Format o)] copying update"',
        '  Copy-Item -LiteralPath $tempFile -Destination $asarFile -Force',
        '  Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue',
        '  Add-Content -LiteralPath $logFile -Value "[$(Get-Date -Format o)] restart app"',
        '  Start-Process -FilePath $exeFile -WorkingDirectory (Split-Path -Parent $exeFile)',
        '} catch {',
        '  try { Add-Content -LiteralPath $logFile -Value "[$(Get-Date -Format o)] hotswap failed: $($_.Exception.Message)" } catch {}',
        '  try { Start-Process -FilePath $exeFile -WorkingDirectory (Split-Path -Parent $exeFile) } catch {}',
        '  exit 1',
        '} finally {',
        '  Start-Sleep -Milliseconds 250',
        '  Remove-Item -LiteralPath $launcherFile -Force -ErrorAction SilentlyContinue',
        '  Remove-Item -LiteralPath $scriptFile -Force -ErrorAction SilentlyContinue',
        '}',
      ].join('\r\n');

      fs.writeFileSync(scriptPath, scriptContent, 'utf-8');
      const vbsCommand = `"powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${scriptPath}"`;
      const vbsString = (value: string) => `"${value.replace(/"/g, '""')}"`;
      const launcherContent = [
        'Set shell = CreateObject("WScript.Shell")',
        `shell.Run ${vbsString(vbsCommand)}, 0, False`,
        'Set shell = Nothing',
      ].join('\r\n');
      fs.writeFileSync(launcherPath, launcherContent, 'utf-8');
      log(`hotswap script: ${scriptPath}`);
      log(`hotswap launcher: ${launcherPath}`);

      const child = spawn('wscript.exe', [launcherPath], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      });
      child.unref();
      log(`hotswap launcher pid: ${child.pid || 'unknown'}`);

      setTimeout(() => app.exit(0), 250);
      return { success: true };
    } catch (err: any) {
      log(`install-minor error: ${err?.message || err}`);
      return { error: err?.message || String(err) };
    }
  });

  // ── IPC: update:install-major (run full installer) ───────────────────
  ipcMain.handle('update:install-major', async (event, tempPath: string) => {
    assertTrustedIpcSender(event);
    try {
      if (!fs.existsSync(tempPath)) {
        return { error: 'installer_not_found' };
      }
      if (path.extname(tempPath).toLowerCase() !== '.exe') {
        return { error: 'installer_must_be_exe' };
      }

      log(`installing major update, running: ${tempPath}`);

      spawn(tempPath, ['/S'], {
        detached: true,
        windowsHide: true,
      }).unref();

      app.quit();
      return { success: true };
    } catch (err: any) {
      log(`install-major error: ${err?.message || err}`);
      return { error: err?.message || String(err) };
    }
  });

  // ── Auto-check on startup (notify renderer only) ─────────────────────
  setTimeout(async () => {
    try {
      const response = await net.fetch(manifestUrl);
      if (!response.ok) {
        log(`auto-check failed: ${response.status}`);
        return;
      }

      const manifest = (await response.json()) as VersionManifest;
      const currentVersion = app.getVersion();

      if (isNewerVersion(manifest.version, currentVersion)) {
        log(`auto-check: update ${manifest.version} available (${manifest.type})`);
        mainWindow?.webContents.send('update:available', {
          version: manifest.version,
          type: manifest.type,
          downloadUrl: manifest.downloadUrl.startsWith('http')
            ? manifest.downloadUrl
            : `${baseUrl}/${manifest.downloadUrl}`,
          releaseNotes: manifest.releaseNotes || '',
          size: manifest.size || 0,
        });
      } else {
        log('auto-check: up to date');
      }
    } catch (err: any) {
      log(`auto-check error: ${err?.message || err}`);
    }
  }, 3000);

  app.on('window-all-closed', () => {
    logStream.end();
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────

app.whenReady().then(() => {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
  }
  createWindow();
  setupCustomUpdater();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
