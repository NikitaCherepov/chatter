import { BrowserWindow, session, net, View, WebContentsView, type WebContents, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { INTERACTIVE_CSP, INTERACTIVE_SCHEME, interactiveDocument, validateInteractiveInput } from './interactive-document';
import type { InteractivePlacement, InteractiveStatus } from './interactive-types';
import { parseAppearanceShellAction, canRunAppearanceAction, parseAppearanceDocumentRequest, canReadAppearanceDocument,
  type AppearanceShellState, type AppearanceImageRequest, type AppearanceDocumentRequest } from './appearance-shell-types';

type Entry = {
  id: string; host: BrowserWindow; owner: WebContents; clip: View; view: WebContentsView;
  visible: boolean; timer?: ReturnType<typeof setInterval>; deadline?: ReturnType<typeof setTimeout>;
  isolated: Session;
  expanded?: boolean;
  appearance?: { state?: AppearanceShellState; window: number; count: number; handlesNavigation?: boolean; handlesConfirmations?: boolean };
  cleanup: () => void;
  imageRequests: Map<string, { request: AppearanceImageRequest; controller: AbortController; resolve: (url: string | null) => void }>;
  imageLoads: Set<Promise<void>>;
  documentRequests: Map<string, { request: AppearanceDocumentRequest; timer: ReturnType<typeof setTimeout> }>;
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
      const idle = [...this.entries.values()].find(entry => !entry.visible && !entry.appearance);
      if (!idle) throw new Error('Too many active previews');
      this.remove(idle.id, 'stopped');
    }
    if (input.language !== 'html' && this.runtime === null) this.runtime = fs.readFileSync(this.runtimeFile, 'utf8');
    const id = randomUUID();
    const url = `${INTERACTIVE_SCHEME}://${id}/${input.language === 'html' && input.project ? input.project.entry : 'index.html'}`;
    const projectResource = (resource: URL) => input.language === 'html' && input.project && resource.protocol === INTERACTIVE_SCHEME + ':' && resource.hostname === id
      && /\.(js|css)$/.test(resource.pathname) && Object.prototype.hasOwnProperty.call(input.project.files, resource.pathname.slice(1));
    const isolated = session.fromPartition(`interactive-${id}`, { cache: false });
    isolated.enableNetworkEmulation({ offline: true });
    isolated.setPermissionCheckHandler(() => false);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setDevicePermissionHandler(() => false);
    isolated.on('will-download', (event, item) => { event.preventDefault(); item.cancel(); });
    isolated.webRequest.onBeforeRequest((details, callback) => {
      const resource = new URL(details.url);
      const image = Boolean(input.bridge && details.resourceType === 'image' && resource.protocol === INTERACTIVE_SCHEME + ':'
        && resource.hostname === id && resource.pathname === '/_image');
      callback({ cancel: details.method !== 'GET' || !(image || projectResource(resource) || details.url === url && details.resourceType === 'mainFrame') });
    });
    const document = interactiveDocument(input, this.runtime ?? '');
    isolated.protocol.handle(INTERACTIVE_SCHEME, request => {
      const resource = new URL(request.url);
      if (input.bridge && resource.hostname === id && resource.pathname === '/_image' && request.method === 'GET')
        return this.loadAppearanceImage(id, resource);
      if (request.method === 'GET' && projectResource(resource)) return new Response(input.project!.files[resource.pathname.slice(1)], { headers: {
        'Content-Type': resource.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
        'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff',
      } });
      return new Response(request.url === url ? document : '', {
      status: request.url === url ? 200 : 403,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': INTERACTIVE_CSP,
        'X-DNS-Prefetch-Control': 'off', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), display-capture=(), usb=(), serial=(), bluetooth=()' },
      });
    });
    const clip = new View();
    const view = new WebContentsView({ webPreferences: {
      session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webSecurity: true,
      webviewTag: false, allowRunningInsecureContent: false, navigateOnDragDrop: false, spellcheck: false,
      ...(input.bridge === 'appearance-chat-list-v1'
        ? { preload: path.join(__dirname, 'appearance-shell-preload.js') } : {}),
    } });
    clip.addChildView(view);
    host.contentView.addChildView(clip);
    clip.setVisible(false);
    const gone = () => this.remove(id);
    const entry: Entry = { id, host, owner, clip, view, isolated, visible: false,
      imageRequests: new Map(), imageLoads: new Set(), documentRequests: new Map(),
      cleanup: () => { owner.removeListener('destroyed', gone); } };
    if (input.bridge) entry.appearance = { window: Date.now(), count: 0 };
    this.entries.set(id, entry);
    owner.once('destroyed', gone);
    const contents = view.webContents;
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
    contents.on('will-frame-navigate', event => event.preventDefault());
    contents.on('will-redirect', event => event.preventDefault());
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('ipc-message', (event, channel, value) => {
      if (!entry.appearance || event.senderFrame !== contents.mainFrame || !this.entries.has(id)) return;
      if (channel === 'appearance-shell:failed') { this.remove(id, 'failed'); return; }
      if (channel === 'appearance-shell:escape') { this.emit(entry, 'ready', { escape: true }); return; }
      if (channel === 'appearance-shell:request') {
        const request = parseAppearanceDocumentRequest(value);
        if (!request || !entry.appearance.state || !canReadAppearanceDocument(entry.appearance.state, request)
            || entry.documentRequests.has(request.requestId) || entry.documentRequests.size >= 4) {
          if (request) contents.send('appearance-shell:result', { requestId: request.requestId, error: 'attachment_request_unavailable' });
          return;
        }
        const timer = setTimeout(() => this.resolveAppearanceDocument(owner, id, request.requestId, null, 'attachment_request_timeout'), 30000);
        entry.documentRequests.set(request.requestId, { request, timer });
        owner.send('interactive-preview:appearance-document', { id, request });
        return;
      }
      if (channel === 'appearance-shell:navigation') {
        entry.appearance.handlesNavigation = value === true;
        return;
      }
      if (channel === 'appearance-shell:confirmations') {
        entry.appearance.handlesConfirmations = value === true;
        this.emit(entry, 'ready', { confirmations: value === true });
        return;
      }
      if (channel !== 'appearance-shell:action') return;
      const action = parseAppearanceShellAction(value);
      const bridge = entry.appearance;
      if (!action || !bridge.state) return;
      if (!canRunAppearanceAction(bridge.state, action)) return;
      if (Date.now() - bridge.window >= 1000) { bridge.window = Date.now(); bridge.count = 0; }
      if (++bridge.count > 60) return;
      if (action.type === 'openChat' && !bridge.state.chats.some(chat => chat.id === action.id)) return;
      if ('chatId' in action && action.chatId !== bridge.state.activeChatId) return;
      if (action.type === 'sendMessage' && !bridge.state.canSend) return;
      if (action.type === 'loadMore' && !bridge.state.sections.some(section =>
          section.folderId === action.folderId && section.hasMore && !section.loading)) return;
      if (!owner.isDestroyed()) owner.send('interactive-preview:appearance-action', { id, action });
    });
    contents.on('before-input-event', (event, input) => {
      if (entry.appearance && input.type === 'keyDown'
          && input.alt && (input.control || input.meta) && input.key === 'Backspace') {
        event.preventDefault();
        this.emit(entry, 'ready', { reset: true });
        return;
      }
      if (entry.expanded && !entry.appearance && input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        this.emit(entry, 'ready', { escape: true });
      }
    });
    contents.on('unresponsive', () => this.remove(id, 'failed', true));
    contents.on('render-process-gone', () => this.remove(id, 'failed'));
    contents.on('did-finish-load', () => {
      if (!this.entries.has(id)) return;
      clearTimeout(entry.deadline);
      if (entry.appearance?.state) contents.send('appearance-shell:state', entry.appearance.state);
      this.emit(entry, 'ready');
      clearInterval(entry.timer);
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
    entry.expanded = payload.expanded === true;
    const x = Math.max(0, Math.round(c.x * factor)), y = Math.max(0, Math.round(c.y * factor));
    const width = Math.max(0, Math.min(Math.round(c.width * factor), hostWidth - x));
    const height = Math.max(0, Math.min(Math.round(c.height * factor), hostHeight - y));
    entry.visible = !!payload.visible && width > 0 && height > 0 && b.width > 0 && b.height > 0;
    entry.clip.setVisible(entry.visible);
    if (!entry.visible) return;
    entry.clip.setBounds({ x, y, width, height });
    entry.view.setBounds({ x: Math.round(b.x * factor) - x, y: Math.round(b.y * factor) - y,
      width: Math.max(1, Math.min(5000, Math.round(b.width * factor))),
      height: Math.max(1, Math.min(8192, Math.round(b.height * factor))) });
    entry.view.webContents.setZoomFactor(factor);
  }

  updateAppearanceState(owner: WebContents, id: string, state: AppearanceShellState): void {
    const entry = this.entries.get(id);
    if (!entry?.appearance || entry.owner !== owner || !state || !Array.isArray(state.chats)
        || !Array.isArray(state.sections)) return;
    const resetLegacyNavigation = entry.appearance.state?.view === 'conversation'
      && state.view === 'home' && !entry.appearance.handlesNavigation;
    entry.appearance.state = state;
    for (const [requestId, pending] of entry.documentRequests) if (!canReadAppearanceDocument(state, pending.request))
      this.resolveAppearanceDocument(owner, id, requestId, null, 'attachment_scope_changed');
    for (const pending of entry.imageRequests.values()) {
      if (!this.imageScopeCurrent(entry, pending.request)) { pending.controller.abort(); pending.resolve(null); }
    }
    if (resetLegacyNavigation && !entry.view.webContents.isDestroyed()
        && !entry.view.webContents.isLoading()) {
      entry.view.webContents.reload();
      return;
    }
    if (!entry.view.webContents.isDestroyed() && !entry.view.webContents.isLoading())
      entry.view.webContents.send('appearance-shell:state', state);
  }

  stop(owner: WebContents, id: string): void {
    if (this.entries.get(id)?.owner === owner) this.remove(id, 'stopped');
  }

  resolveAppearanceImage(owner: WebContents, id: string, requestId: string, url: string | null): void {
    const entry = this.entries.get(id), pending = entry?.imageRequests.get(requestId);
    if (!entry || entry.owner !== owner || !pending) return;
    pending.resolve(typeof url === 'string' && (/^https?:\/\//i.test(url) && url.length <= 16384
      || (Boolean(pending.request.pendingId) || pending.request.messageId < 0) && /^data:image\/[a-z0-9.+-]+;base64,/i.test(url) && url.length <= 24 * 1024 * 1024)
      && this.imageScopeCurrent(entry, pending.request) ? url : null);
  }

  resolveAppearanceDocument(owner: WebContents, id: string, requestId: string, result: unknown, error?: string): void {
    const entry = this.entries.get(id), pending = entry?.documentRequests.get(requestId);
    if (!entry || entry.owner !== owner || !pending) return;
    clearTimeout(pending.timer); entry.documentRequests.delete(requestId);
    if (!entry.appearance?.state || !canReadAppearanceDocument(entry.appearance.state, pending.request)) error = 'attachment_scope_changed';
    if (!error && JSON.stringify(result)?.length > 16 * 1024 * 1024) error = 'attachment_preview_too_large';
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.send('appearance-shell:result', {
      requestId, ...(error ? { error } : { result }),
    });
  }

  private imageScopeCurrent(entry: Entry, request: AppearanceImageRequest): boolean {
    const state = entry.appearance?.state;
    return state?.activeChatId === request.chatId && (request.pendingId
      ? Boolean(state.composer?.items.some(item => item.id === request.pendingId && item.kind === 'image'))
      : Boolean(state.messages.some(message => message.id === request.messageId && message.variantIndex === request.variantIndex)));
  }

  private async loadAppearanceImage(id: string, url: URL): Promise<Response> {
    const entry = this.entries.get(id), state = entry?.appearance?.state;
    const blocked = () => new Response('', { status: 404 });
    if (!entry || !state || entry.imageRequests.size >= 64) return blocked();
    const request: AppearanceImageRequest = { id, requestId: randomUUID(), chatId: Number(url.searchParams.get('chatId')),
      messageId: Number(url.searchParams.get('messageId')), variantIndex: Number(url.searchParams.get('variantIndex')),
      url: url.searchParams.get('url') ?? '', width: Number(url.searchParams.get('width')),
      ...(url.searchParams.has('pendingId') ? { pendingId: url.searchParams.get('pendingId')! } : {}) };
    if (!Number.isSafeInteger(request.chatId) || !Number.isSafeInteger(request.messageId) || (!request.pendingId && request.messageId === 0)
        || request.pendingId && (!/^[a-zA-Z0-9-]{1,100}$/.test(request.pendingId) || request.url !== 'pending:' + request.pendingId)
        || !Number.isSafeInteger(request.variantIndex) || request.variantIndex < 0 || !this.imageScopeCurrent(entry, request)
        || !request.url || request.url.length > 8192 || !Number.isSafeInteger(request.width)
        || request.width !== 0 && (request.width < 64 || request.width > 1600)) return blocked();
    const controller = new AbortController();
    let resolve!: (url: string | null) => void;
    const resolved = new Promise<string | null>(done => { resolve = done; });
    entry.imageRequests.set(request.requestId, { request, controller, resolve });
    const timeout = setTimeout(() => { controller.abort(); resolve(null); }, 20000);
    try {
      entry.owner.send('interactive-preview:appearance-image', request);
      const source = await resolved;
      if (!source || controller.signal.aborted || !this.imageScopeCurrent(entry, request)) return blocked();
      while (entry.imageLoads.size >= 4) await Promise.race(entry.imageLoads);
      if (controller.signal.aborted) return blocked();
      let release!: () => void;
      const loading = new Promise<void>(done => { release = done; });
      entry.imageLoads.add(loading);
      try {
        const embedded = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]*)$/i.exec(source);
        const response = embedded ? new Response(Buffer.from(embedded[2], 'base64'), { headers: { 'Content-Type': embedded[1] } })
          : await net.fetch(source, { signal: controller.signal, credentials: 'omit' });
        const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
        const limit = 16 * 1024 * 1024;
        if (!response.ok || !/^image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/.test(mime)
            || Number(response.headers.get('content-length')) > limit) { controller.abort(); return blocked(); }
        const reader = response.body?.getReader();
        if (!reader) return blocked();
        const chunks: Uint8Array[] = []; let size = 0;
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > limit) { await reader.cancel(); return blocked(); }
          chunks.push(value);
        }
        if (!this.imageScopeCurrent(entry, request) || controller.signal.aborted) return blocked();
        return new Response(Buffer.concat(chunks), { headers: { 'Content-Type': mime, 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff' } });
      } finally { release(); entry.imageLoads.delete(loading); }
    } catch { return blocked(); }
    finally { clearTimeout(timeout); entry.imageRequests.delete(request.requestId); }
  }

  destroy(): void { for (const id of [...this.entries.keys()]) this.remove(id); }

  private emit(entry: Entry, phase: InteractiveStatus['phase'], detail: Pick<InteractiveStatus, 'escape' | 'reset' | 'confirmations'> = {}): void {
    if (!entry.owner.isDestroyed()) entry.owner.send('interactive-preview:status', {
      id: entry.id, phase, ...(entry.appearance ? { confirmations: Boolean(entry.appearance.handlesConfirmations) } : {}), ...detail,
    } satisfies InteractiveStatus);
  }

  private remove(id: string, phase?: InteractiveStatus['phase'], crash = false): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    for (const pending of entry.imageRequests.values()) { pending.controller.abort(); pending.resolve(null); }
    for (const pending of entry.documentRequests.values()) clearTimeout(pending.timer);
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
