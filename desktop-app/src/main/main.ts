import { app, BrowserWindow, dialog, ipcMain, net } from 'electron';
import dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile, spawn, ChildProcessWithoutNullStreams } from 'child_process';
import util from 'util';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';

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

// Register sync IPC handlers before createWindow (preload calls these at load time)
ipcMain.on('get-app-version', (event) => {
  event.returnValue = app.getVersion();
});

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
  ipcMain.handle('tts:generate', async (_event, text: string, voiceId?: string) => {
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

  // ── Macro IPC: execute commands ──

  ipcMain.handle('execute-commands', async (_event, commands: string[]) => {
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
        // Fix кракозябр: на Windows кодируем вывод в UTF-8.
        // chcp 65001 переключает кодовую страницу консоли перед выполнением команды.
        const execCmd = process.platform === 'win32'
          ? `chcp 65001 >nul 2>&1 && ${cmd}`
          : cmd;
        const { stdout, stderr } = await execAsync(execCmd, {
          encoding: 'utf-8',
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        });
        results.push(stdout || stderr || '[no output]');
      } catch (err: any) {
        results.push(`[error] ${err?.message || String(err)}`);
      }
    }

    return results.join('\n---\n');
  });

  // ── Macro IPC: read directory (read-only) ──

  ipcMain.handle('read-directory', async (_event, targetPath: string) => {
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

  ipcMain.handle('read-ssh-keys', async () => {
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

const DEFAULT_UPDATES_BASE = 'http://***REMOVED_IP***:3050/updates';

function getUpdatesBaseUrl(): string {
  return process.env.UPDATES_FEED_URL
    || (process.env.VITE_API_BASE_URL ? `${process.env.VITE_API_BASE_URL.replace(/\/$/, '')}/updates` : null)
    || DEFAULT_UPDATES_BASE;
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

  const logPath = path.join(app.getPath('userData'), 'updater.log');
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    logStream.write(line);
    console.log(`[updater] ${msg}`);
  };

  log('=== app started ===');
  log(`version: ${app.getVersion()}`);

  const baseUrl = getUpdatesBaseUrl();
  const manifestUrl = `${baseUrl}/version.json`;

  // ── IPC: check-for-updates ────────────────────────────────────────────
  ipcMain.handle('update:check', async () => {
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
  ipcMain.handle('update:download', async (_event, downloadUrl: string) => {
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
  ipcMain.handle('update:install-minor', async (_event, tempPath: string) => {
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
  ipcMain.handle('update:install-major', async (_event, tempPath: string) => {
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
  createWindow();
  setupCustomUpdater();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
