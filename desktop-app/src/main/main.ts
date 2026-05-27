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

// ── Wakeword (openWakeWord Python process) ────────────────────────────────

type WakewordCommand = {
  command: string;
  args: string[];
  cwd: string;
};

const getWakewordCommand = (): WakewordCommand => {
  const listenerArgs = [
    '--threshold', '0.55',
    '--debounce', '2.0',
    '--vad-threshold', '0.45',
  ];

  if (app.isPackaged) {
    const packagedPythonPath = firstExistingPath([
      path.join(process.resourcesPath, '.venv-wakeword', 'Scripts', 'python.exe'),
      path.join(process.resourcesPath, 'wakeword', 'python.exe'),
    ]);
    const packagedScriptPath = firstExistingPath([
      path.join(process.resourcesPath, 'wakeword', 'listener.py'),
    ]);

    if (packagedPythonPath && packagedScriptPath) {
      return {
        command: packagedPythonPath,
        args: [packagedScriptPath, ...listenerArgs],
        cwd: path.dirname(packagedScriptPath),
      };
    }

    const bundledExe = path.join(process.resourcesPath, 'wakeword', 'wakeword-listener.exe');
    if (fs.existsSync(bundledExe)) {
      return {
        command: bundledExe,
        args: listenerArgs,
        cwd: path.dirname(bundledExe),
      };
    }

    throw new Error(`wakeword runtime not found. Checked Python: ${[
      path.join(process.resourcesPath, '.venv-wakeword', 'Scripts', 'python.exe'),
      path.join(process.resourcesPath, 'wakeword', 'python.exe'),
    ].join('; ')}. Checked script: ${path.join(process.resourcesPath, 'wakeword', 'listener.py')}. Checked exe: ${bundledExe}`);
  }

  const pythonPath = requireExistingPath('wakeword Python', [
    path.join(__dirname, '..', '..', '.venv-wakeword', 'Scripts', 'python.exe'),
  ]);
  const scriptPath = requireExistingPath('wakeword listener script', [
    path.join(__dirname, '..', '..', 'wakeword', 'listener.py'),
  ]);

  return {
    command: pythonPath,
    args: [scriptPath, ...listenerArgs],
    cwd: path.dirname(scriptPath),
  };
};

let wakewordProcess: ChildProcessWithoutNullStreams | null = null;

function startWakewordListener() {
  if (wakewordProcess) {
    return { ok: true, alreadyRunning: true };
  }

  let wakewordCommand: WakewordCommand;
  try {
    wakewordCommand = getWakewordCommand();
  } catch (error) {
    console.error('[wakeword] failed to resolve listener:', error);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  console.log('[wakeword] starting:', wakewordCommand.command);

  wakewordProcess = spawn(wakewordCommand.command, wakewordCommand.args, {
    cwd: wakewordCommand.cwd,
    windowsHide: true,
  });

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
  ipcMain.handle('wakeword:start', () => {
    return startWakewordListener();
  });

  ipcMain.handle('wakeword:stop', () => {
    return stopWakewordListener();
  });

  // ── IPC: tts:generate (text → piper.exe → WAV buffer) ──────────────────
  ipcMain.handle('tts:generate', async (_event, text: string) => {
    const piperDir = app.isPackaged
      ? path.join(process.resourcesPath, 'models', 'piper')
      : path.join(__dirname, '..', '..', 'models', 'piper');

    const piperExe = path.join(piperDir, 'piper.exe');
    if (!fs.existsSync(piperExe)) {
      console.error('[tts:piper] piper.exe not found at:', piperExe);
      return null;
    }

    // Find available voice models
    const voicesDir = app.isPackaged
      ? path.join(process.resourcesPath, 'models', 'piper-voices')
      : path.join(__dirname, '..', '..', 'models', 'piper-voices');

    if (!fs.existsSync(voicesDir)) {
      console.error('[tts:piper] voices dir not found at:', voicesDir);
      return null;
    }

    // Find first .onnx model file (any subfolder)
    let modelFile: string | null = null;
    const voiceFolders = fs.readdirSync(voicesDir);
    for (const folder of voiceFolders) {
      const folderPath = path.join(voicesDir, folder);
      if (!fs.statSync(folderPath).isDirectory()) continue;
      const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.onnx'));
      if (files.length > 0) {
        modelFile = path.join(folderPath, files[0]);
        break;
      }
    }

    if (!modelFile) {
      console.error('[tts:piper] no .onnx voice model found in:', voicesDir);
      return null;
    }

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
  ipcMain.handle('get-sounds-path', () => {
    const soundsDir = app.isPackaged
      ? path.join(process.resourcesPath, 'sounds')
      : path.join(__dirname, '..', '..', 'sounds');
    return soundsDir;
  });

  ipcMain.handle('read-sound-file', (_event, fileName: string) => {
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
