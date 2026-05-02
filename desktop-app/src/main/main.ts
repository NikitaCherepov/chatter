import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

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
