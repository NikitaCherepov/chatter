import { app, BrowserWindow, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import dotenv from 'dotenv';
import * as path from 'path';

// Load .env from project root (for UPDATES_FEED_URL / VITE_API_BASE_URL)
dotenv.config({ path: path.join(__dirname, '../../.env') });

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

autoUpdater.on('error', (err) => {
  console.error('[updater] error:', err);
});

autoUpdater.on('update-available', (info) => {
  console.log(`[updater] update available: ${info.version}`);
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

autoUpdater.on('update-not-available', () => {
  console.log('[updater] no update available');
});

autoUpdater.on('download-progress', (progress) => {
  console.log(`[updater] downloading: ${progress.percent.toFixed(1)}%`);
});

autoUpdater.on('update-downloaded', (info) => {
  console.log(`[updater] update downloaded: ${info.version}`);
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

// ── App lifecycle ─────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();

  // Check for updates after a short delay (only in production)
  if (!app.isPackaged) {
    console.log('[updater] skipped (dev mode)');
    return;
  }

  // Build feed URL from env: UPDATES_FEED_URL or derive from VITE_API_BASE_URL
  const updatesFeedUrl = process.env.UPDATES_FEED_URL
    || (() => {
      const apiBase = process.env.VITE_API_BASE_URL || 'http://127.0.0.1:3050';
      return `${apiBase.replace(/\/$/, '')}/updates/win/`;
    })();

  autoUpdater.setFeedURL({ provider: 'generic', url: updatesFeedUrl });
  console.log(`[updater] feed url: ${updatesFeedUrl}`);

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[updater] check failed:', err);
    });
  }, 3000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
