import { app, BrowserWindow, dialog } from 'electron';
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
}

// ── Auto-updater ──────────────────────────────────────────────────────────

autoUpdater.autoDownload = false;

// Log updater events to file in production for debugging
let logStream: fs.WriteStream | null = null;
if (app.isPackaged) {
  const logPath = path.join(app.getPath('userData'), 'updater.log');
  logStream = fs.createWriteStream(logPath, { flags: 'a' });
  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    logStream!.write(line);
    console.log(`[updater] ${msg}`);
  };

  autoUpdater.on('error', (err) => { log(`error: ${err}`); });
  autoUpdater.on('checking-for-update', () => { log('checking for update...'); });
  autoUpdater.on('update-available', (info) => { log(`update available: ${info.version}`); });
  autoUpdater.on('update-not-available', () => { log('no update available'); });
  autoUpdater.on('download-progress', (p) => { log(`downloading: ${p.percent.toFixed(1)}%`); });
  autoUpdater.on('update-downloaded', (info) => { log(`downloaded: ${info.version}`); });

  autoUpdater.on('update-available', (info) => {
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Available',
      message: `Version ${info.version} is available. Download now?`,
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then((result) => {
      if (result.response === 0) {
        autoUpdater.downloadUpdate();
      }
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `Version ${info.version} has been downloaded. Restart now to install?`,
      buttons: ['Restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then((result) => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  });
} else {
  // Dev mode — just log to console
  autoUpdater.on('error', (err) => { console.error('[updater] error:', err); });
  autoUpdater.on('update-available', (info) => { console.log(`[updater] update available: ${info.version}`); });
  autoUpdater.on('update-not-available', () => { console.log('[updater] no update available'); });
  autoUpdater.on('download-progress', (p) => { console.log(`[updater] downloading: ${p.percent.toFixed(1)}%`); });
  autoUpdater.on('update-downloaded', (info) => { console.log(`[updater] downloaded: ${info.version}`); });
}

// ── App lifecycle ─────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();

  if (!app.isPackaged) {
    console.log('[updater] skipped (dev mode)');
    return;
  }

  // Build feed URL: UPDATES_FEED_URL > VITE_API_BASE_URL > publish URL from package.json
  const updatesFeedUrl = process.env.UPDATES_FEED_URL
    || (() => {
      const apiBase = process.env.VITE_API_BASE_URL;
      if (apiBase) return `${apiBase.replace(/\/$/, '')}/updates/win/`;
      // Fallback: read from package.json publish config
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
        const publishUrl = pkg.build?.publish?.[0]?.url;
        if (publishUrl) return publishUrl;
      } catch {}
      return null;
    })();

  if (!updatesFeedUrl) {
    console.error('[updater] no feed URL configured');
    return;
  }

  autoUpdater.setFeedURL({ provider: 'generic', url: updatesFeedUrl });
  console.log(`[updater] feed url: ${updatesFeedUrl}`);
  logStream?.write(`[${new Date().toISOString()}] feed url: ${updatesFeedUrl}\n`);

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[updater] check failed:', err);
    });
  }, 3000);
});

app.on('window-all-closed', () => {
  if (logStream) logStream.end();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
