import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile, spawn, ChildProcessWithoutNullStreams } from 'child_process';
import util from 'util';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';

const execFileAsync = util.promisify(execFile);

// Set ffmpeg binary path
if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

// ── Wakeword (openWakeWord Python process) ────────────────────────────────

const getWakewordPythonPath = () => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'wakeword', 'python.exe');
  }
  return path.join(__dirname, '..', '..', '.venv-wakeword', 'Scripts', 'python.exe');
};

const getWakewordScriptPath = () => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'wakeword', 'listener.py');
  }
  return path.join(__dirname, '..', '..', 'wakeword', 'listener.py');
};

let wakewordProcess: ChildProcessWithoutNullStreams | null = null;

function startWakewordListener() {
  if (wakewordProcess) {
    return { ok: true, alreadyRunning: true };
  }

  const pythonPath = getWakewordPythonPath();
  const scriptPath = getWakewordScriptPath();

  wakewordProcess = spawn(pythonPath, [
    scriptPath,
    '--threshold', '0.55',
    '--debounce', '2.0',
    '--vad-threshold', '0.45',
  ]);

  wakewordProcess.stdout.on('data', (chunk: Buffer) => {
    const lines = chunk.toString('utf-8').split(/\r?\n/).filter(Boolean);

    for (const line of lines) {
      try {
        const payload = JSON.parse(line);

        if (payload.type === 'wakeword') {
          console.log('[wakeword] detected:', payload);

          mainWindow?.webContents.send('wakeword:detected', payload);

          // Visually wake up the avatar
          mainWindow?.webContents.send('pixel-avatar:state', {
            state: 'listening',
            source: 'wakeword',
          });
        }

        if (payload.type === 'error') {
          console.error('[wakeword] listener error:', payload.message);
        }
      } catch {
        console.log('[wakeword stdout]', line);
      }
    }
  });

  wakewordProcess.stderr.on('data', (chunk: Buffer) => {
    console.log('[wakeword stderr]', chunk.toString('utf-8'));
  });

  wakewordProcess.on('close', (code) => {
    console.log('[wakeword] process closed:', code);
    wakewordProcess = null;
  });

  wakewordProcess.on('error', (error) => {
    console.error('[wakeword] process error:', error);
    wakewordProcess = null;
  });

  return { ok: true, alreadyRunning: false };
}

function stopWakewordListener() {
  if (!wakewordProcess) {
    return { ok: true, alreadyStopped: true };
  }

  wakewordProcess.kill();
  wakewordProcess = null;

  return { ok: true, alreadyStopped: false };
}

// Dynamic model path: dev vs packaged
const getModelPath = () => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'models', 'ggml-small.bin');
  }
  return path.join(__dirname, '..', '..', 'models', 'ggml-small.bin');
};

// Dynamic whisper.exe path: dev vs packaged
const getWhisperExePath = () => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'models', 'whisper.exe');
  }
  return path.join(__dirname, '..', '..', 'models', 'whisper.exe');
};

// Load .env — in dev it's at project root, in packaged app it's bundled inside dist/main/
const envPath = app.isPackaged
  ? path.join(__dirname, '.env')        // packaged: dist/main/.env (bundled by electron-builder)
  : path.join(__dirname, '../../.env'); // dev: desktop-app/.env
dotenv.config({ path: envPath });

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 600,
    minHeight: 500,
    title: 'Chatter',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const isDev = !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // ── IPC: save-file (shows save dialog, writes blob to disk) ─────────────
  ipcMain.handle('save-file', async (_event, fileName: string, data: ArrayBuffer) => {
    if (!mainWindow) return { canceled: true };
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: fileName,
      filters: [{ name: 'Documents', extensions: ['docx'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, Buffer.from(data));
    return { canceled: false, filePath: result.filePath };
  });

  // ── IPC: zoom ──────────────────────────────────────────────────────────
  ipcMain.handle('set-zoom-level', (_event, level: number) => {
    if (!mainWindow) return;
    mainWindow.webContents.setZoomLevel(level);
  });

  ipcMain.handle('get-zoom-level', () => {
    if (!mainWindow) return 0;
    return mainWindow.webContents.getZoomLevel();
  });

  // ── IPC: transcribe-audio (voice → wav → whisper.exe → text) ──────────
  ipcMain.handle('transcribe-audio', async (_event, arrayBuffer: ArrayBuffer) => {
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

      console.log('[transcribe] 3. Running whisper.exe...');

      await execFileAsync(whisperExe, [
        '-m', modelPath,
        '-f', outputPath,
        '-l', 'ru',
        '-otxt',
      ]);

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
  ipcMain.handle('wakeword:start', () => {
    return startWakewordListener();
  });

  ipcMain.handle('wakeword:stop', () => {
    return stopWakewordListener();
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();

  if (!app.isPackaged) {
    console.log('[updater] skipped (dev mode)');
    return;
  }

  // ── Auto-updater (production only) ──────────────────────────────────────

  autoUpdater.autoDownload = false;

  // Log file
  const logPath = path.join(app.getPath('userData'), 'updater.log');
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    logStream.write(line);
    console.log(`[updater] ${msg}`);
  };

  log('=== app started ===');
  log(`version: ${app.getVersion()}`);
  log(`isPackaged: ${app.isPackaged}`);

  // Build feed URL: UPDATES_FEED_URL > VITE_API_BASE_URL > hardcoded fallback
  const DEFAULT_UPDATES_URL = 'http://***REMOVED_IP***:3050/updates/win/';
  const updatesFeedUrl = process.env.UPDATES_FEED_URL
    || (process.env.VITE_API_BASE_URL ? `${process.env.VITE_API_BASE_URL.replace(/\/$/, '')}/updates/win/` : null)
    || DEFAULT_UPDATES_URL;

  log(`feed url: ${updatesFeedUrl}`);
  autoUpdater.setFeedURL({ provider: 'generic', url: updatesFeedUrl });

  autoUpdater.on('error', (err) => { log(`error: ${err}`); });
  autoUpdater.on('checking-for-update', () => { log('checking for update...'); });
  autoUpdater.on('update-not-available', (info) => { log(`no update available (server version: ${info.version})`); });

  autoUpdater.on('update-available', (info) => {
    log(`update available: ${info.version}`);
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Available',
      message: `Version ${info.version} is available. Download now?`,
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then((result) => {
      if (result.response === 0) {
        log('user chose to download');
        autoUpdater.downloadUpdate();
      } else {
        log('user chose later');
      }
    });
  });

  autoUpdater.on('download-progress', (p) => { log(`downloading: ${p.percent.toFixed(1)}%`); });

  autoUpdater.on('update-downloaded', (info) => {
    log(`downloaded: ${info.version}`);
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `Version ${info.version} has been downloaded. Restart now to install?`,
      buttons: ['Restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then((result) => {
      if (result.response === 0) {
        log('user chose to restart and install');
        autoUpdater.quitAndInstall();
      } else {
        log('user chose later (update will install on next launch)');
      }
    });
  });

  setTimeout(() => {
    log('checking for updates...');
    autoUpdater.checkForUpdates().catch((err) => {
      log(`check failed: ${err}`);
    });
  }, 3000);

  app.on('window-all-closed', () => {
    logStream.end();
    if (process.platform !== 'darwin') app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
