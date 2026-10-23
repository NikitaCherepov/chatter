import { BrowserWindow, session, View, WebContentsView, type WebContents, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { INTERACTIVE_CSP, INTERACTIVE_SCHEME, interactiveDocument, validateInteractiveInput } from './interactive-document';
import type { InteractivePlacement, InteractiveStatus } from './interactive-types';

type Entry = {
  id: string; host: BrowserWindow; owner: WebContents; clip: View; view: WebContentsView;
  visible: boolean; timer?: ReturnType<typeof setInterval>; deadline?: ReturnType<typeof setTimeout>;
  isolated: Session;
  cleanup: () => void;
};

/** One non-persistent session and renderer per preview. No preload, IPC or browser-tool reuse. */
export class InteractivePreviews {
  private entries = new Map<string, Entry>();
  private runtime: string | null = null;
  constructor(private runtimeFile = path.join(__dirname, '../interactive/runtime.js')) {}

  create(owner: WebContents, raw: unknown): string {
    const input = validateInteractiveInput(raw);
    const host = BrowserWindow.fromWebContents(owner);
    if (!host) throw new Error('Preview owner unavailable');
    if (this.entries.size >= 4) {
      const idle = [...this.entries.values()].find(entry => !entry.visible);
      if (!idle) throw new Error('Too many active previews');
      this.remove(idle.id, 'stopped');
    }
    if (input.language !== 'html' && this.runtime === null) this.runtime = fs.readFileSync(this.runtimeFile, 'utf8');
    const id = randomUUID();
    const url = `${INTERACTIVE_SCHEME}://${id}/index.html`;
    const isolated = session.fromPartition(`interactive-${id}`, { cache: false });
    isolated.enableNetworkEmulation({ offline: true });
    isolated.setPermissionCheckHandler(() => false);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setDevicePermissionHandler(() => false);
    isolated.on('will-download', (event, item) => { event.preventDefault(); item.cancel(); });
    isolated.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: details.url !== url || details.resourceType !== 'mainFrame' || details.method !== 'GET' });
    });
    const document = interactiveDocument(input, this.runtime ?? '');
    isolated.protocol.handle(INTERACTIVE_SCHEME, request => new Response(request.url === url ? document : '', {
      status: request.url === url ? 200 : 403,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': INTERACTIVE_CSP,
        'X-DNS-Prefetch-Control': 'off', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), display-capture=(), usb=(), serial=(), bluetooth=()' },
    }));
    const clip = new View();
    const view = new WebContentsView({ webPreferences: {
      session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webSecurity: true,
      webviewTag: false, allowRunningInsecureContent: false, navigateOnDragDrop: false, spellcheck: false,
    } });
    clip.addChildView(view);
    host.contentView.addChildView(clip);
    clip.setVisible(false);
    const gone = () => this.remove(id);
    const entry: Entry = { id, host, owner, clip, view, isolated, visible: false,
      cleanup: () => { owner.removeListener('destroyed', gone); } };
    this.entries.set(id, entry);
    owner.once('destroyed', gone);
    const contents = view.webContents;
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
    contents.on('will-frame-navigate', event => event.preventDefault());
    contents.on('will-redirect', event => event.preventDefault());
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('unresponsive', () => this.remove(id, 'failed', true));
    contents.on('render-process-gone', () => this.remove(id, 'failed'));
    contents.once('did-finish-load', () => {
      if (!this.entries.has(id)) return;
      clearTimeout(entry.deadline);
      this.emit(entry, 'ready');
      // Main-process watchdog remains usable even if generated code blocks its renderer.
      entry.timer = setInterval(() => {
        if (entry.deadline || contents.isDestroyed()) return;
        entry.deadline = setTimeout(() => this.remove(id, 'failed', true), 3000);
        void contents.executeJavaScript('void 0').then(() => {
          clearTimeout(entry.deadline); entry.deadline = undefined;
        }).catch(() => this.remove(id, 'failed'));
      }, 3000);
      entry.deadline = undefined;
    });
    entry.deadline = setTimeout(() => this.remove(id, 'failed', true), 12000);
    void contents.loadURL(url).catch(() => this.remove(id, 'failed'));
    return id;
  }

  place(owner: WebContents, payload: InteractivePlacement): void {
    const entry = this.entries.get(payload?.id);
    if (!entry || entry.owner !== owner) return;
    const values = [...Object.values(payload.bounds ?? {}), ...Object.values(payload.clip ?? {})];
    if (values.length !== 8 || values.some(value => typeof value !== 'number' || !Number.isFinite(value))) return;
    const factor = owner.getZoomFactor();
    const [hostWidth, hostHeight] = entry.host.getContentSize();
    const b = payload.bounds, c = payload.clip;
    const x = Math.max(0, Math.round(c.x * factor)), y = Math.max(0, Math.round(c.y * factor));
    const width = Math.max(0, Math.min(Math.round(c.width * factor), hostWidth - x));
    const height = Math.max(0, Math.min(Math.round(c.height * factor), hostHeight - y));
    entry.visible = !!payload.visible && width > 0 && height > 0 && b.width > 0 && b.height > 0;
    entry.clip.setVisible(entry.visible);
    if (!entry.visible) return;
    entry.clip.setBounds({ x, y, width, height });
    entry.view.setBounds({ x: Math.round(b.x * factor) - x, y: Math.round(b.y * factor) - y,
      width: Math.max(1, Math.min(5000, Math.round(b.width * factor))),
      height: Math.max(1, Math.min(1600, Math.round(b.height * factor))) });
    entry.view.webContents.setZoomFactor(factor);
  }

  stop(owner: WebContents, id: string): void {
    if (this.entries.get(id)?.owner === owner) this.remove(id, 'stopped');
  }

  destroy(): void { for (const id of [...this.entries.keys()]) this.remove(id); }

  private emit(entry: Entry, phase: InteractiveStatus['phase']): void {
    if (!entry.owner.isDestroyed()) entry.owner.send('interactive-preview:status', { id: entry.id, phase } satisfies InteractiveStatus);
  }

  private remove(id: string, phase?: InteractiveStatus['phase'], crash = false): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    clearInterval(entry.timer); clearTimeout(entry.deadline);
    entry.cleanup();
    if (phase) this.emit(entry, phase);
    if (!entry.host.isDestroyed()) entry.host.contentView.removeChildView(entry.clip);
    const contents = entry.view.webContents;
    const isolated = entry.isolated;
    if (!contents.isDestroyed()) {
      if (crash) contents.forcefullyCrashRenderer();
      contents.close({ waitForBeforeUnload: false });
    }
    isolated.protocol.unhandle(INTERACTIVE_SCHEME);
    isolated.removeAllListeners('will-download');
    void isolated.clearStorageData().catch(() => {});
    void isolated.clearCache().catch(() => {});
    void isolated.closeAllConnections().catch(() => {});
  }
}
