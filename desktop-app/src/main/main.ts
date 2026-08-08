import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, screen, session, shell, type OpenDialogOptions } from 'electron';
import { autoUpdater } from 'electron-updater';
import dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile, spawn } from 'child_process';
import util from 'util';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { WakeWordOnnxService } from './wakeword';
import { ChatterBrowser, type BrowserControlPayload } from './browser';

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

type VideoConversionJob = { cancel: () => void };
const activeVideoConversions = new Map<string, VideoConversionJob>();
const activeVideoOutputPaths = new Set<string>();

const sessionWriteFolders = new Set<string>();
const blockedAutoWriteExtensions = new Set([
  '.bat', '.cmd', '.com', '.exe', '.msi', '.ps1', '.reg', '.scr', '.sys',
  '.vbe', '.vbs', '.wsf', '.wsh', '.sh', '.bash', '.zsh', '.fish',
  '.desktop', '.service', '.socket', '.timer', '.dll',
]);

function normalizePathForComparison(filePath: string): string {
  const normalized = path.normalize(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function resolvePathThroughExistingAncestor(filePath: string): string {
  const absolute = path.resolve(filePath);
  let existing = absolute;

  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }

  const canonicalExisting = fs.existsSync(existing)
    ? fs.realpathSync.native(existing)
    : existing;
  return path.resolve(canonicalExisting, path.relative(existing, absolute));
}

function isPathInsideFolder(folderPath: string, targetPath: string): boolean {
  const relative = path.relative(folderPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isSensitiveAutoWritePath(filePath: string): boolean {
  const resolved = normalizePathForComparison(path.resolve(filePath));
  const basename = path.basename(resolved).toLowerCase();
  const extension = path.extname(basename).toLowerCase();
  const segments = resolved.split(path.sep);

  if (blockedAutoWriteExtensions.has(extension)) return true;
  if (basename === '.env' || basename.startsWith('.env.')) return true;
  if (basename === 'package.json' || basename.endsWith('-lock.json')) return true;
  if (basename === 'pnpm-lock.yaml' || basename === 'yarn.lock') return true;
  if (basename === 'dockerfile' || basename.startsWith('docker-compose.')) return true;
  if (segments.includes('.git')) return true;
  if (segments.includes('.github') && segments.includes('workflows')) return true;
  return false;
}

function findGitWorkspaceFolder(filePath: string): string | null {
  let current = resolvePathThroughExistingAncestor(path.dirname(path.resolve(filePath)));

  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function findSuggestedWorkspaceFolder(filePath: string): string {
  return findGitWorkspaceFolder(filePath)
    ?? resolvePathThroughExistingAncestor(path.dirname(path.resolve(filePath)));
}

function grantSessionWriteFolder(folderPath: string): string {
  const folder = normalizePathForComparison(resolvePathThroughExistingAncestor(folderPath));
  sessionWriteFolders.add(folder);
  return folder;
}

function canAutoWriteFile(filePath: string): boolean {
  if (!filePath || isSensitiveAutoWritePath(filePath)) return false;
  const target = normalizePathForComparison(resolvePathThroughExistingAncestor(filePath));
  return [...sessionWriteFolders].some((folder) => isPathInsideFolder(folder, target));
}

function outputPathKey(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
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
    ...[
      'whisper-whisper-cli.exe',
      'whisper-cli.exe',
      'whisper-main.exe',
      'main.exe',
      'whisper.exe',
    ].map((fileName) => app.isPackaged
      ? path.join(process.resourcesPath, 'models', fileName)
      : path.join(__dirname, '..', '..', 'models', fileName)),
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

    console.warn('[tts:piper] selected voice is unavailable; falling back:', voiceId);
  }

  const defaultModel = findPiperModelInFolder(path.join(voicesDir, 'ruslan'));
  if (defaultModel) return defaultModel;

  const voiceFolders = fs.readdirSync(voicesDir).sort();
  for (const folder of voiceFolders) {
    const modelFile = findPiperModelInFolder(path.join(voicesDir, folder));
    if (modelFile) return modelFile;
  }

  return null;
}

function listPiperVoices() {
  const voicesDir = getPiperVoicesDir();
  if (!fs.existsSync(voicesDir)) return [];

  return fs.readdirSync(voicesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-z0-9_-]+$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const modelFile = findPiperModelInFolder(path.join(voicesDir, entry.name));
      if (!modelFile) return [];

      try {
        const config = JSON.parse(fs.readFileSync(`${modelFile}.json`, 'utf8')) as {
          dataset?: string;
          language?: { code?: string; name_english?: string };
        };
        const dataset = `${config.dataset || entry.name}`.trim();
        const name = dataset
          .split(/[_-]+/)
          .filter(Boolean)
          .map((part) => part.toLowerCase() === 'hfc'
            ? 'HFC'
            : part.charAt(0).toUpperCase() + part.slice(1))
          .join(' ') || entry.name;
        return [{
          id: entry.name,
          name,
          lang: `${config.language?.code || 'und'}`.replace(/_/g, '-'),
        }];
      } catch (error) {
        console.error('[tts:piper] failed to read voice config:', modelFile, error);
        return [];
      }
    });
}

function normalizeWhisperLanguage(value: unknown) {
  const normalized = `${value || 'auto'}`.trim().toLowerCase().replace(/_/g, '-');
  if (normalized === 'auto') return 'auto';
  const baseLanguage = normalized.split('-')[0];
  return /^[a-z]{2,3}$/.test(baseLanguage) ? baseLanguage : 'auto';
}

let mainWindow: BrowserWindow | null = null;
let chatterBrowser: ChatterBrowser | null = null;
const detachedToolWindows = new Map<string, BrowserWindow>();

function getRendererEntryPath(): string {
  return path.join(__dirname, '../renderer/index.html');
}

function getAppIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '..', '..', 'build', 'icon.ico');
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
  const belongsToAppWindow = event.sender === mainWindow?.webContents
    || [...detachedToolWindows.values()].some((window) => !window.isDestroyed() && event.sender === window.webContents);
  return belongsToAppWindow
    && senderFrame !== null
    && senderFrame === event.sender.mainFrame
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
    icon: getAppIconPath(),
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

  chatterBrowser = new ChatterBrowser(mainWindow);

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
    for (const window of detachedToolWindows.values()) {
      if (!window.isDestroyed()) window.close();
    }
    detachedToolWindows.clear();
    chatterBrowser?.destroy();
    chatterBrowser = null;
    mainWindow = null;
  });

  // ── Embedded browser ────────────────────────────────────────────────────
  ipcMain.handle('browser:get-state', (event) => {
    assertTrustedIpcSender(event);
    if (!chatterBrowser) throw new Error('browser_unavailable');
    return chatterBrowser.getState();
  });

  ipcMain.handle('browser:set-visible', (event, payload: {
    visible?: boolean;
    ownerId?: string;
    bounds?: Electron.Rectangle;
  }) => {
    assertTrustedIpcSender(event);
    if (!chatterBrowser) throw new Error('browser_unavailable');
    const host = BrowserWindow.fromWebContents(event.sender) || undefined;
    return chatterBrowser.setVisible(payload?.visible === true, payload?.bounds, payload?.ownerId, host);
  });

  ipcMain.handle('browser:set-bounds', (event, bounds: Electron.Rectangle) => {
    assertTrustedIpcSender(event);
    if (!chatterBrowser) throw new Error('browser_unavailable');
    chatterBrowser.setBounds(bounds);
    return chatterBrowser.getState();
  });

  ipcMain.handle('browser:control', async (event, payload: BrowserControlPayload) => {
    assertTrustedIpcSender(event);
    if (!chatterBrowser) throw new Error('browser_unavailable');
    return chatterBrowser.control(payload);
  });

  // ── Detached tool windows ────────────────────────────────────────────────
  const detachableToolIds = new Set(['notebook', 'tasks', 'map', 'gallery', 'documents', 'browser']);

  ipcMain.handle('tool-window:open', async (event, payload: {
    toolId?: string;
    title?: string;
    activeChatId?: number | null;
  }) => {
    assertTrustedIpcSender(event);
    const toolId = `${payload?.toolId || ''}`.trim();
    if (!detachableToolIds.has(toolId)) throw new Error('unknown_tool');

    const existing = detachedToolWindows.get(toolId);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return { opened: true };
    }

    const title = `${payload?.title || 'Chatter'}`.trim().slice(0, 120) || 'Chatter';
    const activeChatId = Number.isInteger(payload?.activeChatId) && Number(payload.activeChatId) > 0
      ? Number(payload.activeChatId)
      : undefined;
    const toolWindow = new BrowserWindow({
      width: toolId === 'browser' ? 920 : 720,
      height: 760,
      minWidth: 380,
      minHeight: 420,
      title,
      icon: getAppIconPath(),
      show: false,
      backgroundColor: '#dfe6ef',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    detachedToolWindows.set(toolId, toolWindow);

    toolWindow.webContents.setWindowOpenHandler(({ url }) => {
      openExternalHttpUrl(url);
      return { action: 'deny' };
    });
    toolWindow.webContents.on('will-navigate', (navigationEvent, url) => {
      if (isTrustedRendererUrl(url)) return;
      navigationEvent.preventDefault();
      openExternalHttpUrl(url);
    });
    toolWindow.once('ready-to-show', () => toolWindow.show());
    toolWindow.on('close', () => {
      if (toolId === 'browser' && mainWindow && !mainWindow.isDestroyed()) {
        chatterBrowser?.moveToHost(mainWindow);
      }
    });
    toolWindow.on('closed', () => {
      detachedToolWindows.delete(toolId);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tool-window:closed', { toolId });
      }
    });

    const query: Record<string, string> = { toolWindow: toolId, title };
    if (activeChatId) query.activeChatId = String(activeChatId);
    if (isDev) {
      const search = new URLSearchParams(query).toString();
      await toolWindow.loadURL(`http://localhost:5173/?${search}`);
    } else {
      await toolWindow.loadFile(rendererEntryPath, { query });
    }
    return { opened: true };
  });

  ipcMain.handle('tool-window:dock', (event, payload: { toolId?: string }) => {
    assertTrustedIpcSender(event);
    const toolId = `${payload?.toolId || ''}`.trim();
    const toolWindow = detachedToolWindows.get(toolId);
    if (toolWindow && !toolWindow.isDestroyed()) toolWindow.close();
    return { docked: true };
  });

  ipcMain.handle('tool-window:update-context', (event, payload: {
    toolId?: string;
    activeChatId?: number | null;
  }) => {
    assertTrustedIpcSender(event);
    const toolId = `${payload?.toolId || ''}`.trim();
    const toolWindow = detachedToolWindows.get(toolId);
    if (!toolWindow || toolWindow.isDestroyed()) return { updated: false };
    const activeChatId = Number.isInteger(payload?.activeChatId) && Number(payload.activeChatId) > 0
      ? Number(payload.activeChatId)
      : null;
    toolWindow.webContents.send('tool-window:context', { activeChatId });
    return { updated: true };
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
  ipcMain.handle('transcribe-audio', async (event, arrayBuffer: ArrayBuffer, language: string = 'auto') => {
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
      const whisperLanguage = normalizeWhisperLanguage(language);

      console.log('[transcribe] 3. Running whisper.exe:', whisperExe, `(language: ${whisperLanguage})`);

      await execFileAsync(whisperExe, [
        '-m', modelPath,
        '-f', outputPath,
        '-l', whisperLanguage,
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
  ipcMain.handle('tts:list-piper-voices', (event) => {
    assertTrustedIpcSender(event);
    return listPiperVoices();
  });

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

        // On Windows, cmd.exe receives arguments in the system ANSI code page
        // (cp1251/cp866). chcp 65001 takes effect only after parsing, so
        // non-ASCII arguments get corrupted before the command runs.
        //
        // Non-ASCII commands (Cyrillic etc.): double Base64 wrapper.
        // 1) The original command + chcp 65001 is encoded in Base64 (UTF-16LE
        //    for .NET) — protects quotes, special chars, and Cyrillic in args.
        // 2) A PowerShell script decodes that Base64 and runs the command via
        //    `cmd.exe /c` (preserving cmd semantics: &&, |, >). The PS script
        //    itself is also Base64-encoded and passed via -EncodedCommand.
        //
        // ASCII-only commands: direct cmd.exe, no PowerShell overhead.
        // chcp 65001 ensures UTF-8 output (npx spinners, checkmarks etc.).
        let execCmd = cmd;
        if (process.platform === 'win32') {
          if (/[^\x00-\x7F]/.test(cmd)) {
            const wrappedCmd = `chcp 65001 >nul && ${cmd}`;
            const cmdB64 = Buffer.from(wrappedCmd, 'utf16le').toString('base64');
            const psScript = [
              '$OutputEncoding = [System.Text.Encoding]::UTF8',
              '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
              `$decCmd = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${cmdB64}'))`,
              '& cmd.exe /c $decCmd',
            ].join('; ');
            const scriptB64 = Buffer.from(psScript, 'utf16le').toString('base64');
            execCmd = `powershell -NoProfile -EncodedCommand ${scriptB64}`;
          } else {
            execCmd = `chcp 65001 >nul && ${cmd}`;
          }
        }
        const cmdStartedAt = Date.now();
        console.log('[execute-commands] cmd start', {
          cmd,
          execCmd,
          timeoutMs: 120000,
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
          timeout: 120000,
          maxBuffer: 4 * 1024 * 1024,
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
        results.push([
          stdout ? `[stdout]\n${stdout}` : '',
          stderr ? `[stderr]\n${stderr}` : '',
        ].filter(Boolean).join('\n') || '[no output]');
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
        const errorStdout = typeof err?.stdout === 'string' ? err.stdout : '';
        const errorStderr = typeof err?.stderr === 'string' ? err.stderr : '';
        results.push([
          `[error] command failed${err?.code !== undefined ? ` (exit ${err.code})` : ''}`,
          errorStdout ? `[stdout]\n${errorStdout}` : '',
          errorStderr ? `[stderr]\n${errorStderr}` : '',
          !errorStdout && !errorStderr ? (err?.message || String(err)) : '',
        ].filter(Boolean).join('\n'));
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

  // ── File converter: constrained video conversion via bundled ffmpeg ──

  ipcMain.handle('convert-video', async (event, payload: {
    request_id: string;
    source_path: string;
    output_path?: string;
    output_format: 'mp4' | 'webm' | 'mkv' | 'mov';
    quality?: 'high' | 'balanced' | 'small';
  }) => {
    assertTrustedIpcSender(event);

    const formats = new Set(['mp4', 'webm', 'mkv', 'mov']);
    const qualities = new Set(['high', 'balanced', 'small']);
    const videoExtensions = new Set([
      '.mp4', '.webm', '.mkv', '.mov', '.avi', '.m4v', '.mpg', '.mpeg',
      '.wmv', '.flv', '.ts', '.mts', '.m2ts',
    ]);
    const requestId = typeof payload?.request_id === 'string' ? payload.request_id.trim() : '';
    const sourcePath = typeof payload?.source_path === 'string' ? payload.source_path.trim() : '';
    const outputFormat = typeof payload?.output_format === 'string' ? payload.output_format.toLowerCase() : '';
    const quality = typeof payload?.quality === 'string' ? payload.quality.toLowerCase() : 'balanced';

    if (!requestId || requestId.length > 128) throw new Error('invalid_request_id');
    if (activeVideoConversions.has(requestId)) throw new Error('conversion_request_already_running');
    if (!sourcePath) throw new Error('source_path_required');
    if (!path.isAbsolute(sourcePath)) throw new Error('source_path_must_be_absolute');
    if (!formats.has(outputFormat)) throw new Error('unsupported_output_format');
    if (!qualities.has(quality)) throw new Error('unsupported_quality');

    const resolvedSource = path.resolve(sourcePath);
    if (!fs.existsSync(resolvedSource)) throw new Error('source_file_not_found');
    if (!fs.statSync(resolvedSource).isFile()) throw new Error('source_path_is_not_a_file');
    if (!videoExtensions.has(path.extname(resolvedSource).toLowerCase())) {
      throw new Error('unsupported_source_video_extension');
    }

    const parsedSource = path.parse(resolvedSource);
    const requestedOutput = typeof payload?.output_path === 'string' ? payload.output_path.trim() : '';
    if (requestedOutput && !path.isAbsolute(requestedOutput)) {
      throw new Error('output_path_must_be_absolute');
    }

    let resolvedOutput: string;
    if (!requestedOutput) {
      resolvedOutput = path.join(parsedSource.dir, `${parsedSource.name}_converted.${outputFormat}`);
    } else {
      const resolvedRequestedOutput = path.resolve(requestedOutput);
      resolvedOutput = fs.existsSync(resolvedRequestedOutput) && fs.statSync(resolvedRequestedOutput).isDirectory()
        ? path.join(resolvedRequestedOutput, `${parsedSource.name}_converted.${outputFormat}`)
        : resolvedRequestedOutput;
    }

    if (path.extname(resolvedOutput).toLowerCase() !== `.${outputFormat}`) {
      throw new Error('output_extension_must_match_format');
    }
    if (outputPathKey(resolvedOutput) === outputPathKey(resolvedSource)) {
      throw new Error('output_path_must_differ_from_source');
    }
    if (!fs.existsSync(path.dirname(resolvedOutput))) {
      throw new Error('output_directory_not_found');
    }
    if (fs.existsSync(resolvedOutput)) {
      throw new Error('output_file_already_exists');
    }

    const outputKey = outputPathKey(resolvedOutput);
    if (activeVideoOutputPaths.has(outputKey)) {
      throw new Error('output_file_conversion_already_running');
    }
    activeVideoOutputPaths.add(outputKey);

    const profiles: Record<string, { crf: string; preset: string; audioBitrate: string }> = {
      high: { crf: '18', preset: 'slow', audioBitrate: '192k' },
      balanced: { crf: '23', preset: 'medium', audioBitrate: '160k' },
      small: { crf: '28', preset: 'fast', audioBitrate: '128k' },
    };
    const profile = profiles[quality];
    const ffmpegArgs = ['-n', '-i', resolvedSource];

    if (outputFormat === 'webm') {
      ffmpegArgs.push(
        '-c:v', 'libvpx-vp9', '-crf', profile.crf, '-b:v', '0',
        '-c:a', 'libopus', '-b:a', profile.audioBitrate,
      );
    } else {
      ffmpegArgs.push(
        '-c:v', 'libx264', '-preset', profile.preset, '-crf', profile.crf,
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', profile.audioBitrate,
      );
      if (outputFormat === 'mp4' || outputFormat === 'mov') {
        ffmpegArgs.push('-movflags', '+faststart');
      }
    }
    ffmpegArgs.push(resolvedOutput);

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(getFfmpegPath(), ffmpegArgs, {
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderrTail = '';
        let cancelled = false;
        let timedOut = false;
        let settled = false;

        const timeout = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, 30 * 60_000);

        const settle = (err?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          activeVideoConversions.delete(requestId);
          if (err) reject(err);
          else resolve();
        };

        activeVideoConversions.set(requestId, {
          cancel: () => {
            if (settled || cancelled) return;
            cancelled = true;
            child.kill();
            setTimeout(() => {
              if (!settled) child.kill('SIGKILL');
            }, 2_000).unref();
          },
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          stderrTail = (stderrTail + chunk.toString('utf8')).slice(-8_000);
        });
        child.once('error', (err) => settle(err));
        child.once('close', (code) => {
          if (cancelled) settle(new Error('ffmpeg_cancelled'));
          else if (timedOut) settle(new Error('ffmpeg_timeout'));
          else if (code === 0) settle();
          else settle(new Error(`ffmpeg_failed_${code}: ${stderrTail.slice(-2_000)}`));
        });
      });

      const outputStat = fs.statSync(resolvedOutput);
      return {
        source_path: resolvedSource,
        output_path: resolvedOutput,
        output_format: outputFormat,
        quality,
        size_bytes: outputStat.size,
      };
    } catch (err) {
      await fs.promises.unlink(resolvedOutput).catch(() => {});
      throw err;
    } finally {
      activeVideoConversions.delete(requestId);
      activeVideoOutputPaths.delete(outputKey);
    }
  });

  ipcMain.handle('cancel-video-conversion', (event, requestId: string) => {
    assertTrustedIpcSender(event);
    const job = activeVideoConversions.get(typeof requestId === 'string' ? requestId : '');
    if (!job) return { cancelled: false };
    job.cancel();
    return { cancelled: true };
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

/** Redacts API-key-like strings (sk-...) from file content before it reaches the AI. */
const REDACT_API_KEY_RE = /\bsk-[A-Za-z0-9_-]{20,}\b/g;
function redactApiKeys(content: string): string {
  return content.replace(REDACT_API_KEY_RE, '<Api_Key>');
}

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
        content: redactApiKeys(formatted.join('\n')),
        start_line: startLine,
        read_lines: sliced.length,
        total_lines: totalLines,
        encoding: 'utf-8',
        format: 'docx',
        line_numbers: showLineNumbers,
        file_version: `${stat.size}:${stat.mtimeMs}`,
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
      content: redactApiKeys(formatted.join('\n')),
      start_line: startLine,
      read_lines: lines.length,
      total_lines: totalLines,
      encoding: 'utf-8',
      line_numbers: showLineNumbers,
      file_version: `${stat.size}:${stat.mtimeMs}`,
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
        matches.push({ line_number: totalLines, line: redactApiKeys(line.trim()) });
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

  ipcMain.handle('workspace:grant-session-write-folder', async (event, filePath: string) => {
    assertTrustedIpcSender(event);
    if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('file_path_required');
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      defaultPath: findSuggestedWorkspaceFolder(filePath.trim()),
      properties: ['openDirectory'],
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return { canceled: false, folder: grantSessionWriteFolder(result.filePaths[0]) };
  });

  ipcMain.handle('workspace:can-auto-write', (event, filePath: string) => {
    assertTrustedIpcSender(event);
    return typeof filePath === 'string' && canAutoWriteFile(filePath.trim());
  });

  ipcMain.handle('workspace:grant-detected-session-write-folder', (event, filePath: string) => {
    assertTrustedIpcSender(event);
    if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('file_path_required');
    const gitRoot = findGitWorkspaceFolder(filePath.trim());
    if (!gitRoot) return { granted: false, reason: 'git_root_not_found' };
    return { granted: true, folder: grantSessionWriteFolder(gitRoot) };
  });

  ipcMain.handle('edit-file-lines', async (event, payload: { file_path: string; start_line: number; end_line: number; new_content: string; expected_content: string; expected_file_version: string }) => {
    assertTrustedIpcSender(event);
    const filePath = typeof payload?.file_path === 'string' ? payload.file_path.trim() : '';
    if (!filePath) throw new Error('file_path_required');

    const startLine = typeof payload?.start_line === 'number' ? Math.floor(payload.start_line) : 0;
    const endLine = typeof payload?.end_line === 'number' ? Math.floor(payload.end_line) : 0;
    const newContent = typeof payload?.new_content === 'string' ? payload.new_content : '';
    const expectedContent = typeof payload?.expected_content === 'string' ? payload.expected_content : null;
    const expectedFileVersion = typeof payload?.expected_file_version === 'string' ? payload.expected_file_version : '';

    if (startLine < 1) throw new Error('start_line must be >= 1');
    if (expectedContent === null || !expectedFileVersion) throw new Error('file_edit_snapshot_required');

    const resolved = path.resolve(filePath);
    const initialStat = await fs.promises.stat(resolved);
    const currentFileVersion = `${initialStat.size}:${initialStat.mtimeMs}`;
    if (currentFileVersion !== expectedFileVersion) throw new Error('file_changed_since_preview');

    // Read entire file and split into lines
    const rawData = await fs.promises.readFile(resolved, 'utf-8');
    const eol = rawData.includes('\r\n') ? '\r\n' : '\n';
    const lines = rawData.split(/\r?\n/);
    const totalLinesBefore = lines.length;
    const statAfterRead = await fs.promises.stat(resolved);
    if (`${statAfterRead.size}:${statAfterRead.mtimeMs}` !== currentFileVersion) {
      throw new Error('file_changed_since_preview');
    }

    // Bounds check
    if (startLine > lines.length + 1) {
      throw new Error(`start_line (${startLine}) выходит за пределы файла (всего строк: ${lines.length})`);
    }

    // Convert 1-indexed line numbers to 0-indexed array positions
    const startIndex = startLine - 1;
    const deleteCount = endLine >= startLine ? endLine - startLine + 1 : 0;
    if (endLine > lines.length) throw new Error(`end_line (${endLine}) exceeds file length (${lines.length})`);
    const actualContent = deleteCount > 0 ? lines.slice(startIndex, startIndex + deleteCount).join('\n') : '';
    if (actualContent !== expectedContent.replace(/\r\n/g, '\n')) {
      throw new Error('file_changed_since_preview');
    }

    // Split new content into lines
    const newLines = newContent ? newContent.split(/\r?\n/) : [];

    // Splice: remove old lines, insert new ones
    lines.splice(startIndex, deleteCount, ...newLines);

    // Write back
    await fs.promises.writeFile(resolved, lines.join(eol), { encoding: 'utf-8' });

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

// ── Desktop updater (public GitHub Releases) ─────────────────────────────


function formatDesktopReleaseNotes(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';

  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object' && 'note' in entry) {
        return typeof entry.note === 'string' ? entry.note : '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

const desktopChangelogRequests = new Map<string, Promise<string>>();

function isValidDesktopChangelog(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const changes = (value as { changes?: unknown }).changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return false;

  const entries = Object.values(changes);
  return entries.length > 0 && entries.every((localeChanges) =>
    Array.isArray(localeChanges)
    && localeChanges.length > 0
    && localeChanges.every((entry) => typeof entry === 'string' && entry.trim().length > 0));
}

function loadDesktopReleaseNotes(
  version: string,
  fallback: unknown,
  log: (message: string) => void,
): Promise<string> {
  const fallbackNotes = formatDesktopReleaseNotes(fallback);
  const safeVersion = version.trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(safeVersion)) {
    return Promise.resolve(fallbackNotes);
  }

  const cached = desktopChangelogRequests.get(safeVersion);
  if (cached) return cached;

  const request = (async () => {
    try {
      const url = `https://github.com/NikitaCherepov/chatter/releases/download/v${safeVersion}/desktop-changelog.json`;
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const notes = await response.text();
      if (Buffer.byteLength(notes, 'utf8') > 512 * 1024) throw new Error('changelog is too large');
      if (!isValidDesktopChangelog(JSON.parse(notes))) throw new Error('invalid changelog format');
      return notes;
    } catch (error) {
      desktopChangelogRequests.delete(safeVersion);
      log(`localized changelog unavailable for ${safeVersion}: ${error instanceof Error ? error.message : String(error)}`);
      return fallbackNotes;
    }
  })();

  desktopChangelogRequests.set(safeVersion, request);
  return request;
}

type TrustedServer = {
  origin: string;
};

let trustedServerOrigin: string | null = null;

function normalizeServerUrl(rawServer: unknown): { apiBase: string; origin: string } {
  if (typeof rawServer !== 'string' || rawServer.length > 2048) {
    throw new Error('invalid_server_url');
  }

  const url = new URL(rawServer.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('invalid_server_url');
  }

  return {
    apiBase: url.toString().replace(/\/+$/, ''),
    origin: url.origin,
  };
}

function getTrustedServerPath(): string {
  return path.join(app.getPath('userData'), 'trusted-server.json');
}

function loadTrustedServerOrigin(): void {
  try {
    const parsed = JSON.parse(fs.readFileSync(getTrustedServerPath(), 'utf8')) as TrustedServer;
    trustedServerOrigin = normalizeServerUrl(parsed.origin).origin;
  } catch {
    trustedServerOrigin = null;
  }
}

function saveTrustedServerOrigin(origin: string): void {
  fs.writeFileSync(getTrustedServerPath(), JSON.stringify({ origin } satisfies TrustedServer), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function serverCspSources(): string[] {
  if (!trustedServerOrigin) return [];
  const httpUrl = new URL(trustedServerOrigin);
  const websocketUrl = new URL(trustedServerOrigin);
  websocketUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return [httpUrl.origin, websocketUrl.origin];
}

function setupContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'mainFrame') {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }

    const developmentSources = app.isPackaged
      ? []
      : [
          'http://127.0.0.1:5173',
          'http://localhost:5173',
          'ws://127.0.0.1:5173',
          'ws://localhost:5173',
          'http://127.0.0.1:3050',
          'ws://127.0.0.1:3050',
        ];
    const connectSources = ["'self'", ...serverCspSources(), ...developmentSources];
    const scriptSources = [
      "'self'",
      ...(!app.isPackaged ? ["'unsafe-eval'", "'unsafe-inline'"] : []),
    ];
    const imageSources = [
      "'self'",
      'data:',
      'blob:',
      ...serverCspSources().filter((source) => source.startsWith('http')),
      'https://*.basemaps.cartocdn.com',
      'https://server.arcgisonline.com',
      'https://*.tile.openstreetmap.org',
    ];
    const policy = [
      "default-src 'self'",
      `script-src ${scriptSources.join(' ')}`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      `img-src ${imageSources.join(' ')}`,
      `media-src ${["'self'", 'data:', 'blob:', ...serverCspSources().filter((source) => source.startsWith('http'))].join(' ')}`,
      `connect-src ${connectSources.join(' ')}`,
      "worker-src 'self' blob:",
      "object-src 'none'",
      "frame-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; ');

    const responseHeaders = { ...details.responseHeaders };
    for (const header of Object.keys(responseHeaders)) {
      if (header.toLowerCase() === 'content-security-policy') delete responseHeaders[header];
    }
    responseHeaders['Content-Security-Policy'] = [policy];
    callback({ responseHeaders });
  });
}

ipcMain.handle('security:authorize-server', async (event, rawServer: unknown, rawKey: unknown, forceValidation = false) => {
  assertTrustedIpcSender(event);
  const { apiBase, origin } = normalizeServerUrl(rawServer);
  if (!forceValidation && origin === trustedServerOrigin) {
    return { apiBase, reloadRequired: false };
  }
  if (typeof rawKey !== 'string' || !rawKey.trim() || rawKey.length > 4096) {
    throw new Error('invalid_server_access_key');
  }

  const response = await fetch(`${apiBase}/api/v1/server-access/validate`, {
    headers: { 'X-Chatter-Server-Key': rawKey.trim() },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('invalid_server_access_key');

  const reloadRequired = origin !== trustedServerOrigin;
  trustedServerOrigin = origin;
  saveTrustedServerOrigin(origin);
  return { apiBase, reloadRequired };
});

ipcMain.handle('security:clear-server', (event) => {
  assertTrustedIpcSender(event);
  trustedServerOrigin = null;
  try {
    fs.rmSync(getTrustedServerPath(), { force: true });
  } catch {}
  return { reloadRequired: true };
});

function setupGithubDesktopUpdater() {
  const enabled = app.isPackaged;
  const logPath = path.join(app.getPath('userData'), 'updater.log');
  const log = (message: string) => {
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
    console.log(`[updater] ${message}`);
  };

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => log('checking for update'));
  autoUpdater.on('update-not-available', (info) => log(`up to date: ${info.version}`));
  autoUpdater.on('update-available', async (info) => {
    log(`update available: ${info.version}`);
    const releaseNotes = await loadDesktopReleaseNotes(info.version, info.releaseNotes, log);
    mainWindow?.webContents.send('update:available', {
      version: info.version,
      releaseNotes,
      size: 0,
    });
  });
  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('update:progress', {
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
    });
  });
  autoUpdater.on('update-downloaded', (info) => log(`update downloaded: ${info.version}`));
  autoUpdater.on('error', (error) => log(`error: ${error.message}`));

  ipcMain.handle('update:check', async (event) => {
    assertTrustedIpcSender(event);
    if (!enabled) return { updateAvailable: false, disabled: true };

    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result?.updateInfo || result.updateInfo.version === app.getVersion()) {
        return { updateAvailable: false };
      }
      const releaseNotes = await loadDesktopReleaseNotes(result.updateInfo.version, result.updateInfo.releaseNotes, log);
      return {
        updateAvailable: true,
        version: result.updateInfo.version,
        releaseNotes,
        size: 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`check failed: ${message}`);
      return { error: message };
    }
  });

  ipcMain.handle('update:download', async (event) => {
    assertTrustedIpcSender(event);
    if (!enabled) return { error: 'updates_disabled' };

    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`download failed: ${message}`);
      return { error: message };
    }
  });

  ipcMain.handle('update:install', (event) => {
    assertTrustedIpcSender(event);
    if (!enabled) return { error: 'updates_disabled' };

    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { success: true };
  });

  if (!enabled) {
    console.log('[updater] disabled in development');
    return;
  }

  log(`app started: ${app.getVersion()}`);
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((error) => {
      log(`startup check failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, 3000);
}

app.whenReady().then(() => {
  loadTrustedServerOrigin();
  setupContentSecurityPolicy();
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
  }
  createWindow();
  setupGithubDesktopUpdater();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  for (const job of activeVideoConversions.values()) {
    job.cancel();
  }
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
