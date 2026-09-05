import { BrowserWindow, screen } from 'electron';
import { ChatterBrowser } from './browser';

export type BrowserPreviewSource = 'google_ai' | 'web_search';

export type BrowserPreviewPayload = {
  active: boolean;
  source: BrowserPreviewSource;
  image?: string;
};

type BrowserPreviewSessionOptions = {
  source: BrowserPreviewSource;
  getMainWindow: () => BrowserWindow | null;
  emit: (payload: BrowserPreviewPayload) => void;
  captureIntervalMs?: number;
};

export class BrowserPreviewSession {
  private previewWindow: BrowserWindow | null = null;
  private captureTimer: ReturnType<typeof setTimeout> | null = null;
  private activeBrowser: ChatterBrowser | null = null;
  private run = 0;

  constructor(private readonly options: BrowserPreviewSessionOptions) {}

  start(browser: ChatterBrowser): number {
    if (this.activeBrowser) this.finish(this.activeBrowser, this.run, true);

    const run = ++this.run;
    const previewWindow = this.getPreviewWindow();
    const [width, height] = previewWindow.getContentSize();
    this.activeBrowser = browser;
    browser.setVisible(true, { x: 0, y: 0, width, height }, `browser-preview:${this.options.source}`, previewWindow);
    previewWindow.showInactive();
    this.options.emit({ active: true, source: this.options.source });

    const capture = async () => {
      if (run !== this.run || this.activeBrowser !== browser) return;
      const image = await browser.capturePreview();
      if (run !== this.run || this.activeBrowser !== browser) return;
      if (image) this.options.emit({ active: true, source: this.options.source, image });
      this.captureTimer = setTimeout(capture, this.options.captureIntervalMs ?? 500);
    };
    this.captureTimer = setTimeout(capture, 100);
    return run;
  }

  stop(browser: ChatterBrowser, run: number): void {
    this.finish(browser, run, true);
  }

  release(browser: ChatterBrowser): void {
    if (this.activeBrowser === browser) this.finish(browser, this.run, true);
    if (this.previewWindow && !this.previewWindow.isDestroyed()) this.previewWindow.destroy();
    this.previewWindow = null;
  }

  destroy(): void {
    if (this.activeBrowser) this.finish(this.activeBrowser, this.run, false);
    if (this.previewWindow && !this.previewWindow.isDestroyed()) this.previewWindow.destroy();
    this.previewWindow = null;
  }

  private finish(browser: ChatterBrowser, run: number, moveBack: boolean): void {
    if (run !== this.run || this.activeBrowser !== browser) return;
    this.run += 1;
    if (this.captureTimer) clearTimeout(this.captureTimer);
    this.captureTimer = null;
    this.activeBrowser = null;
    this.options.emit({ active: false, source: this.options.source });

    const mainWindow = this.options.getMainWindow();
    if (moveBack && mainWindow && !mainWindow.isDestroyed()) browser.moveToHost(mainWindow);
    if (this.previewWindow && !this.previewWindow.isDestroyed()) this.previewWindow.hide();
  }

  private getPreviewWindow(): BrowserWindow {
    if (this.previewWindow && !this.previewWindow.isDestroyed()) return this.previewWindow;

    const displays = screen.getAllDisplays();
    const virtualRight = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width));
    const virtualTop = Math.min(...displays.map((display) => display.bounds.y));
    const previewWindow = new BrowserWindow({
      // Place the real, composited window beyond the entire virtual desktop,
      // not merely beyond the primary monitor (which may be another display).
      x: virtualRight + 200,
      y: virtualTop,
      width: 1280,
      height: 900,
      show: false,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      opacity: 0.01,
      backgroundColor: '#ffffff',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    previewWindow.on('closed', () => {
      if (this.previewWindow === previewWindow) this.previewWindow = null;
    });
    this.previewWindow = previewWindow;
    return previewWindow;
  }
}
