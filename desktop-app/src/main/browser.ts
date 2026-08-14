import { app, BrowserWindow, dialog, WebContentsView, type DownloadItem, type Rectangle, type WebContents, type WebFrameMain } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statfsSync, unlinkSync } from 'node:fs';
import { copyFile, rename, unlink } from 'node:fs/promises';
import { click as naturalClick, generateTrajectory, pickTargetPoint, scrollWheel, type CancellationToken, type MouseEventDispatcher, type Point } from './cursor-input';

export type BrowserState = {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  visible: boolean;
};

export type BrowserControlPayload = {
  action: 'open' | 'read' | 'back' | 'forward' | 'reload' | 'scroll' | 'click' | 'fill' | 'check_site_permission' | 'grant_site_permission' | 'resolve_download';
  url?: string;
  ref?: string;
  text?: string;
  permission_action?: 'click' | 'fill';
  origin?: string;
  expected_origin?: string;
  mode?: 'viewport' | 'delta' | 'full';
  direction?: 'up' | 'down';
  amount?: number;
  download_id?: string;
  approved?: boolean;
  destination?: 'prompt' | 'downloads';
};

export type BrowserDownloadRequest = {
  download_id: string;
  filename: string;
  url: string;
  mime_type: string;
  total_bytes: number;
  origin: string | null;
  created_at: number;
};

type PendingBrowserDownload = {
  item: DownloadItem;
  request: BrowserDownloadRequest;
  timer: ReturnType<typeof setTimeout>;
  provisionalPath: string;
  finalPath?: string;
  approved: boolean;
};

type BrowserElement = {
  ref: string;
  tag: string;
  role: string;
  text: string;
  href?: string;
  inputType?: string;
  placeholder?: string;
  sensitive?: boolean;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  frame?: string;
};

type BrowserFrameSnapshot = {
  frameTreeNodeId: number;
  frameUrl: string;
  internalRef: string;
};

type BrowserFrameInfo = {
  id: string;
  parent_id: string | null;
  url: string;
  name: string;
  title: string;
};

type BrowserFrameReadResult = {
  title?: string;
  url?: string;
  text?: string;
  elements?: BrowserElement[];
  truncated?: boolean;
  scroll?: { y: number; viewport_width: number; viewport_height: number; document_height: number };
};

type BrowserFrameInputSession = {
  dispatch: MouseEventDispatcher;
  dispose: () => Promise<void>;
};

const HOME_URL = 'https://www.google.com/';
const MAX_PAGE_TEXT = 30_000;
const MAX_VIEWPORT_TEXT = 10_000;
const MAX_ELEMENTS = 160;
const MAX_VIEWPORT_ELEMENTS = 80;
const MAX_BROWSER_FRAMES = 20;
const BROWSER_WORLD_ID = 1004;
const DOWNLOAD_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

type BrowserReadSnapshot = {
  url: string;
  text: string;
  elements: BrowserElement[];
  mode: 'viewport' | 'full';
};

type CdpFrameTree = {
  frame?: { id?: string; url?: string; name?: string };
  childFrames?: CdpFrameTree[];
};

/**
 * Locates the CDP frameId for `frame` inside `tree`. We first build the index
 * path from main frame to `frame` via parent.frames[], then walk the same
 * path through the CDP frame tree. Index-based matching disambiguates
 * multiple iframes that share the same URL or name.
 */
function findCdpFrameIdFor(
  frame: WebFrameMain,
  tree: CdpFrameTree | undefined,
): string | undefined {
  if (!tree?.frame) return undefined;

  // Build the chain of frame indices from main frame down to `frame`.
  const chain: number[] = [];
  let child: WebFrameMain | null = frame;
  // Walk up via parent.frames[] and reverse to get top-down ordering.
  while (child && child.parent) {
    const parent: WebFrameMain = child.parent;
    const childId = child.frameTreeNodeId;
    const idx = parent.frames.findIndex((f: WebFrameMain) => f.frameTreeNodeId === childId);
    if (idx < 0) return undefined;
    chain.unshift(idx);
    child = parent;
  }
  // `child` is now the top-level (main) frame; the chain is complete.

  let node: CdpFrameTree | undefined = tree;
  for (const idx of chain) {
    if (!node?.childFrames || idx >= node.childFrames.length) return undefined;
    node = node.childFrames[idx];
  }
  return node?.frame?.id;
}

function buildTextDelta(previous: string, current: string): string {
  if (previous === current) return '';
  let prefix = 0;
  const prefixLimit = Math.min(previous.length, current.length);
  while (prefix < prefixLimit && previous[prefix] === current[prefix]) prefix += 1;

  let suffix = 0;
  const suffixLimit = Math.min(previous.length - prefix, current.length - prefix);
  while (suffix < suffixLimit && previous[previous.length - 1 - suffix] === current[current.length - 1 - suffix]) suffix += 1;

  const changedStart = Math.max(0, prefix - 240);
  const changedEnd = Math.min(current.length, current.length - suffix + 240);
  const delta = current.slice(changedStart, changedEnd);
  return delta.length >= current.length * 0.8 ? current : delta;
}

function normalizeBrowserUrl(value: string): string {
  const raw = value.trim();
  if (!raw) return HOME_URL;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported_protocol');
    return parsed.toString();
  } catch {
    if (/^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(raw)) {
      return `https://${raw}`;
    }
    return `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
  }
}

function isAllowedRemoteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isAbortedNavigationError(error: any): boolean {
  return error?.code === -3
    || error?.code === 'ERR_ABORTED'
    || `${error?.message || ''}`.includes('ERR_ABORTED');
}

export class ChatterBrowser {
  private host: BrowserWindow;
  private readonly view: WebContentsView;
  private visible = false;
  private activeLayoutOwner = '';
  private nextLayoutOwnerRank = 0;
  private readonly layoutOwnerRanks = new Map<string, number>();
  private snapshotUrl = '';
  private snapshotElements = new Map<string, BrowserElement>();
  private snapshotFrames = new Map<string, BrowserFrameSnapshot>();
  /**
   * Cached isolated execution contexts for child frames. Keyed by
   * frameTreeNodeId. The world is created lazily on first access and
   * disposed when the snapshot is invalidated.
   */
  private oopifWorlds = new Map<number, {
    sessionId: string;
    contextId: number;
    sameOrigin: boolean;
    released: boolean;
  }>();
  /**
   * Refcount for the top-level CDP debugger attachment. We attach once on
   * the first isolated-world request and detach when the last consumer
   * releases. Each cached world holds one ref while alive.
   */
  private debuggerRefs = 0;
  private debuggerAttachPromise: Promise<void> | null = null;
  /**
   * True only when we attached the top-level debugger ourselves. If the
   * debugger was already attached by an external caller we ride on their
   * attachment and never detach it.
   */
  private debuggerOwnedByBrowser = false;
  private lastReadSnapshot: BrowserReadSnapshot | null = null;
  /** True once the current main document is usable by browser tools. */
  private mainDocumentReady = false;
  private interactionInProgress = false;
  private initialNavigationStarted = false;
  private initialNavigationPromise: Promise<void> | null = null;
  private explicitNavigationRequested = false;
  private readonly sessionClickOrigins = new Set<string>();
  private readonly sessionFillOrigins = new Set<string>();
  private readonly pendingDownloads = new Map<string, PendingBrowserDownload>();
  private readonly willDownloadHandler: (event: Electron.Event, item: DownloadItem, webContents: WebContents) => void;

  /** Last known pointer position inside the WebContentsView (local CSS px). */
  private cursorPos: Point = { x: 0, y: 0 };
  /** Active cancellation token for the in-flight pointer sequence (if any). */
  private clickToken: CancellationToken | null = null;

  constructor(host: BrowserWindow) {
    this.host = host;
    this.view = new WebContentsView({
      webPreferences: {
        partition: 'persist:chatter-browser',
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });

    host.contentView.addChildView(this.view);
    this.view.setVisible(false);

    const contents = this.view.webContents;
    const browserSession = contents.session;

    const defaultUA = browserSession.getUserAgent();
    const cleanedUA = defaultUA
      .replace(/\s*Electron\/[\d.]+/gi, '')
      .replace(/\s*chatter\/[\d.a-z-]+/gi, '');
    browserSession.setUserAgent(cleanedUA.trim());

    browserSession.setPermissionCheckHandler(() => false);
    browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

    this.willDownloadHandler = (_event, item, webContents) => {
      if (webContents.id !== contents.id) return;
      this.handleWillDownload(item);
    };
    browserSession.on('will-download', this.willDownloadHandler);

    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedRemoteUrl(url)) void contents.loadURL(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (!isAllowedRemoteUrl(url)) event.preventDefault();
    });
    contents.on('did-start-loading', () => this.emitState());
    contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) this.setMainDocumentReady(false);
    });
    contents.on('dom-ready', () => this.setMainDocumentReady(true));
    contents.on('did-stop-loading', () => {
      this.setMainDocumentReady(true);
      this.emitState();
    });
    contents.on('did-navigate', () => {
      this.abortInteraction();
      this.clearSnapshot();
      this.emitState();
    });
    contents.on('did-navigate-in-page', () => {
      this.clearSnapshot();
      this.emitState();
    });
    contents.on('page-title-updated', () => this.emitState());

  }

  destroy(): void {
    this.abortInteraction();
    void this.disposeOopifWorlds();
    this.view.webContents.session.removeListener('will-download', this.willDownloadHandler);
    for (const downloadId of [...this.pendingDownloads.keys()]) {
      this.cancelPendingDownload(downloadId, 'browser_destroyed');
    }
    this.visible = false;
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
  }

  private attachToHost(host: BrowserWindow): void {
    if (host === this.host || host.isDestroyed()) return;
    if (!this.host.isDestroyed()) this.host.contentView.removeChildView(this.view);
    host.contentView.addChildView(this.view);
    this.host = host;
  }

  moveToHost(host: BrowserWindow): void {
    this.visible = false;
    this.view.setVisible(false);
    this.attachToHost(host);
  }

  getState(): BrowserState {
    const contents = this.view.webContents;
    return {
      url: contents.isDestroyed() ? '' : contents.getURL(),
      title: contents.isDestroyed() ? '' : contents.getTitle(),
      canGoBack: !contents.isDestroyed() && contents.navigationHistory.canGoBack(),
      canGoForward: !contents.isDestroyed() && contents.navigationHistory.canGoForward(),
      // Background ads and analytics can keep Chromium's raw loading flag
      // active after the main document is already usable.
      isLoading: !contents.isDestroyed() && contents.isLoading() && !this.mainDocumentReady,
      visible: this.visible,
    };
  }

  setVisible(visible: boolean, bounds?: Rectangle, ownerId?: string, host?: BrowserWindow): BrowserState {
    const owner = `${ownerId || ''}`.trim();
    if (owner) {
      let rank = this.layoutOwnerRanks.get(owner);
      if (rank === undefined) {
        rank = ++this.nextLayoutOwnerRank;
        this.layoutOwnerRanks.set(owner, rank);
      }

      const activeRank = this.layoutOwnerRanks.get(this.activeLayoutOwner) || 0;
      if (visible && rank < activeRank) return this.getState();
      if (!visible) {
        this.layoutOwnerRanks.delete(owner);
        if (this.activeLayoutOwner !== owner) return this.getState();
        this.activeLayoutOwner = '';
      } else {
        this.activeLayoutOwner = owner;
      }
    }

    if (visible && host) this.attachToHost(host);
    this.visible = visible;
    if (bounds) this.setBounds(bounds);
    this.view.setVisible(visible);
    if (
      visible
      && !this.explicitNavigationRequested
      && !this.initialNavigationStarted
      && (!this.view.webContents.getURL() || this.view.webContents.getURL() === 'about:blank')
    ) {
      this.initialNavigationStarted = true;
      const initialNavigation = this.view.webContents.loadURL(HOME_URL).catch((error) => {
        if (!isAbortedNavigationError(error)) console.error('[browser] initial navigation failed:', error);
      }).finally(() => {
        if (this.initialNavigationPromise === initialNavigation) this.initialNavigationPromise = null;
        if (!this.view.webContents.isDestroyed() && (!this.view.webContents.getURL() || this.view.webContents.getURL() === 'about:blank')) {
          this.initialNavigationStarted = false;
        }
      });
      this.initialNavigationPromise = initialNavigation;
    }
    this.emitState();
    return this.getState();
  }

  setBounds(bounds: Rectangle): void {
    const windowBounds = this.host.getContentBounds();
    const zoomFactor = this.host.webContents.getZoomFactor();
    const x = Math.max(0, Math.min(Math.floor((Number(bounds?.x) || 0) * zoomFactor), windowBounds.width - 1));
    const y = Math.max(0, Math.min(Math.floor((Number(bounds?.y) || 0) * zoomFactor), windowBounds.height - 1));
    const width = Math.max(1, Math.min(Math.floor((Number(bounds?.width) || 1) * zoomFactor), windowBounds.width - x));
    const height = Math.max(1, Math.min(Math.floor((Number(bounds?.height) || 1) * zoomFactor), windowBounds.height - y));
    this.view.setBounds({ x, y, width, height });
  }

  async control(payload: BrowserControlPayload): Promise<unknown> {
    const action = payload?.action;
    const contents = this.view.webContents;
    if (contents.isDestroyed()) throw new Error('browser_unavailable');

    if (action === 'check_site_permission') {
      const permissionAction = payload.permission_action;
      if (permissionAction !== 'click' && permissionAction !== 'fill') {
        throw new Error('browser_permission_action_required');
      }
      const origin = this.getCurrentHttpOrigin();
      let target: BrowserElement | undefined;
      if (payload.ref) {
        try {
          target = this.getSnapshotElement(payload.ref);
        } catch {
          // Site permission belongs to the current origin, not to a DOM
          // snapshot. The action itself still validates the ref strictly.
        }
      }
      return {
        allowed: Boolean(origin && this.getPermissionOrigins(permissionAction).has(origin)),
        origin,
        ...(target ? {
          target: {
            tag: target.tag,
            role: target.role,
            text: target.text,
            href: target.href,
            inputType: target.inputType,
            placeholder: target.placeholder,
            sensitive: target.sensitive === true,
          },
        } : {}),
      };
    }
    if (action === 'grant_site_permission') {
      const permissionAction = payload.permission_action;
      if (permissionAction !== 'click' && permissionAction !== 'fill') {
        throw new Error('browser_permission_action_required');
      }
      const currentOrigin = this.getCurrentHttpOrigin();
      const requestedOrigin = this.normalizeHttpOrigin(payload.origin);
      if (!currentOrigin || !requestedOrigin || currentOrigin !== requestedOrigin) {
        throw new Error('browser_origin_changed');
      }
      this.getPermissionOrigins(permissionAction).add(currentOrigin);
      return { granted: true, origin: currentOrigin, permission_action: permissionAction };
    }
    if (action === 'resolve_download') {
      return this.resolveDownload(
        `${payload.download_id || ''}`,
        payload.approved === true,
        payload.destination === 'downloads' ? 'downloads' : 'prompt',
      );
    }

    if (action === 'open') {
      if (this.interactionInProgress) throw new Error('browser_interaction_in_progress');
      this.interactionInProgress = true;
      this.explicitNavigationRequested = true;
      const url = normalizeBrowserUrl(`${payload.url || ''}`);
      try {
        const initialNavigation = this.initialNavigationPromise;
        if (initialNavigation) {
          contents.stop();
          await initialNavigation;
        }
        await this.navigateToUrl(url);
        return this.getState();
      } finally {
        this.interactionInProgress = false;
      }
    }
    if (action === 'back') {
      if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      return this.getState();
    }
    if (action === 'forward') {
      if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
      return this.getState();
    }
    if (action === 'reload') {
      contents.reload();
      return this.getState();
    }
    if (action === 'read') return this.readPage(payload.mode || 'viewport');
    if (action === 'scroll') {
      if (this.interactionInProgress) throw new Error('browser_interaction_in_progress');
      this.interactionInProgress = true;

      try {
        const direction = payload.direction === 'up' ? -1 : 1;
        const requestedAmount = Math.max(100, Math.min(4000, Math.floor(Number(payload.amount) || 700)));
        const distanceVariance = 0.86 + Math.random() * 0.28;
        const distance = direction * Math.max(80, Math.round(requestedAmount * distanceVariance));

        // Read scroll position and viewport before scrolling.
        const before = await this.executeInBrowserWorld<{ startY: number; viewportW: number; viewportH: number }>(
          `(() => ({ startY: Math.round(window.scrollY), viewportW: window.innerWidth, viewportH: window.innerHeight }))()`,
        );

        // Ensure cursor is positioned within the viewport.
        const wheelCursorPos: Point = (this.cursorPos.x > 0 && this.cursorPos.y > 0)
          ? {
              x: Math.min(this.cursorPos.x, before.viewportW - 1),
              y: Math.min(this.cursorPos.y, before.viewportH - 1),
            }
          : { x: before.viewportW / 2, y: before.viewportH / 2 };

        this.clickToken = { cancelled: false };
        try {
          await scrollWheel(this.view.webContents, distance, wheelCursorPos, this.clickToken);
        } finally {
          this.clickToken = null;
        }

        // Read scroll position after to report actual delta.
        const endY = await this.executeInBrowserWorld<number>(`(window.scrollY)`);
        const actual = endY - before.startY;

        return {
          status: 'success',
          scroll: {
            requested: distance,
            actual,
            startY: before.startY,
            endY,
          },
          ...this.getState(),
        };
      } finally {
        this.interactionInProgress = false;
      }
    }
    if (action === 'click' || action === 'fill') {
      const expectedOrigin = payload.expected_origin ? this.normalizeHttpOrigin(payload.expected_origin) : null;
      if (payload.expected_origin && (!expectedOrigin || expectedOrigin !== this.getCurrentHttpOrigin())) {
        throw new Error('browser_origin_changed');
      }
      if (action === 'click') return this.clickElement(`${payload.ref || ''}`);
      return this.fillElement(`${payload.ref || ''}`, `${payload.text || ''}`);
    }

    throw new Error('unsupported_browser_action');
  }

  private normalizeHttpOrigin(value: unknown): string | null {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
    } catch {
      return null;
    }
  }

  private getCurrentHttpOrigin(): string | null {
    return this.normalizeHttpOrigin(this.view.webContents.getURL());
  }

  private getPermissionOrigins(action: 'click' | 'fill'): Set<string> {
    return action === 'click' ? this.sessionClickOrigins : this.sessionFillOrigins;
  }

  private clearSnapshot(): void {
    this.snapshotUrl = '';
    this.snapshotElements.clear();
    this.snapshotFrames.clear();
    this.lastReadSnapshot = null;
    // Dispose any cached frame worlds.
    void this.disposeOopifWorlds();
  }

  /** Aborts any in-flight pointer sequence (called on navigation, destroy, etc.). */
  private abortInteraction(): void {
    if (this.clickToken) this.clickToken.cancelled = true;
    this.clickToken = null;
  }

  private emitState(): void {
    if (this.host.isDestroyed()) return;
    this.host.webContents.send('browser:state', this.getState());
  }

  private setMainDocumentReady(ready: boolean): void {
    if (this.mainDocumentReady === ready) return;
    this.mainDocumentReady = ready;
    this.emitState();
  }

  private emitDownloadEvent(channel: 'browser:download-requested' | 'browser:download-resolved', payload: unknown): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
  }

  private handleWillDownload(item: DownloadItem): void {
    const rawUrl = item.getURL();
    let displayUrl = rawUrl;
    let origin: string | null = null;
    try {
      const parsedUrl = new URL(rawUrl);
      origin = parsedUrl.origin === 'null' ? null : parsedUrl.origin;
      parsedUrl.username = '';
      parsedUrl.password = '';
      displayUrl = parsedUrl.protocol === 'data:'
        ? `${rawUrl.slice(0, Math.max(0, rawUrl.indexOf(',') + 1))}…`
        : parsedUrl.toString();
    } catch { /* leave the original URL and null origin */ }

    const downloadId = randomUUID();
    const filename = path.basename(item.getFilename() || 'download');
    const provisionalDirectory = path.join(app.getPath('temp'), 'chatter-browser-downloads');
    const provisionalPath = path.join(provisionalDirectory, `${downloadId}-${filename}`);
    try {
      mkdirSync(provisionalDirectory, { recursive: true });
      // Suppress Chromium's automatic save dialog. The path is replaced with
      // the user's chosen path before the paused item is resumed.
      item.setSavePath(provisionalPath);
      item.pause();
    } catch {
      try { item.cancel(); } catch { /* ignore */ }
      return;
    }

    const request: BrowserDownloadRequest = {
      download_id: downloadId,
      filename,
      url: displayUrl.slice(0, 4000),
      mime_type: `${item.getMimeType() || ''}`.slice(0, 200),
      total_bytes: Math.max(0, Number(item.getTotalBytes()) || 0),
      origin,
      created_at: Date.now(),
    };

    const timer = setTimeout(() => {
      this.cancelPendingDownload(request.download_id, 'expired');
    }, DOWNLOAD_CONFIRMATION_TTL_MS);
    this.pendingDownloads.set(request.download_id, { item, request, timer, provisionalPath, approved: false });

    item.once('done', (_event, state) => {
      void this.finishPendingDownload(request.download_id, state);
    });

    // Every download follows the same confirmation route, regardless of what
    // initiated it (model action, direct URL, page script, or manual click).
    this.emitDownloadEvent('browser:download-requested', request);
  }

  private cancelPendingDownload(downloadId: string, status: string): void {
    const pending = this.pendingDownloads.get(downloadId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingDownloads.delete(downloadId);
    try { pending.item.cancel(); } catch { /* already completed/cancelled */ }
    try { unlinkSync(pending.provisionalPath); } catch { /* no partial file was created */ }
    this.emitDownloadEvent('browser:download-resolved', { download_id: downloadId, status });
  }

  private async finishPendingDownload(downloadId: string, state: string): Promise<void> {
    const pending = this.pendingDownloads.get(downloadId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingDownloads.delete(downloadId);
    let finalState = state;
    if (state === 'completed' && pending.finalPath) {
      try {
        try {
          await rename(pending.provisionalPath, pending.finalPath);
        } catch {
          await copyFile(pending.provisionalPath, pending.finalPath);
        }
      } catch {
        finalState = 'interrupted';
      }
    }
    try { await unlink(pending.provisionalPath); } catch { /* no partial file was created */ }
    this.emitDownloadEvent('browser:download-resolved', {
      download_id: downloadId,
      status: finalState,
      ...(finalState === 'completed' && pending.finalPath ? { file_path: pending.finalPath } : {}),
    });
  }

  private getAvailableDownloadPath(filename: string): string {
    const directory = app.getPath('downloads');
    const parsed = path.parse(filename);
    let candidate = path.join(directory, filename);
    for (let suffix = 1; existsSync(candidate); suffix += 1) {
      candidate = path.join(directory, `${parsed.name} (${suffix})${parsed.ext}`);
    }
    return candidate;
  }

  private async resolveDownload(
    downloadId: string,
    approved: boolean,
    destination: 'prompt' | 'downloads',
  ): Promise<unknown> {
    const pending = this.pendingDownloads.get(downloadId);
    if (!downloadId || !pending) throw new Error('browser_download_not_found_or_expired');
    if (pending.approved) {
      return {
        status: 'started',
        download_id: downloadId,
        filename: pending.request.filename,
        file_path: pending.finalPath,
      };
    }

    if (!approved) {
      this.cancelPendingDownload(downloadId, 'cancelled');
      return { status: 'cancelled', download_id: downloadId };
    }

    let finalPath: string | undefined;
    if (destination === 'downloads') {
      const downloadsDirectory = app.getPath('downloads');
      try {
        if (pending.request.total_bytes > 0) {
          const stats = statfsSync(downloadsDirectory);
          const availableBytes = Number(stats.bavail) * Number(stats.bsize);
          if (Number.isFinite(availableBytes) && availableBytes < pending.request.total_bytes) {
            throw new Error('browser_download_insufficient_space');
          }
        }
        finalPath = this.getAvailableDownloadPath(pending.request.filename);
      } catch (error) {
        this.cancelPendingDownload(downloadId, 'failed');
        throw error;
      }
    } else {
      const saveDialogOptions = {
        defaultPath: path.join(app.getPath('downloads'), pending.request.filename),
      };
      const result = this.host.isDestroyed()
        ? await dialog.showSaveDialog(saveDialogOptions)
        : await dialog.showSaveDialog(this.host, saveDialogOptions);
      if (!result.canceled && result.filePath) finalPath = result.filePath;
    }

    const current = this.pendingDownloads.get(downloadId);
    if (!current || current !== pending) throw new Error('browser_download_not_found_or_expired');
    if (!finalPath) {
      this.cancelPendingDownload(downloadId, 'cancelled');
      return { status: 'cancelled', download_id: downloadId };
    }

    clearTimeout(pending.timer);
    pending.approved = true;
    pending.finalPath = finalPath;
    pending.item.resume();
    this.emitDownloadEvent('browser:download-resolved', {
      download_id: downloadId,
      status: 'started',
      file_path: finalPath,
    });
    return {
      status: 'started',
      download_id: downloadId,
      filename: pending.request.filename,
      file_path: finalPath,
    };
  }

  private executeInBrowserWorld<T = unknown>(code: string): Promise<T> {
    return this.view.webContents.executeJavaScriptInIsolatedWorld(
      BROWSER_WORLD_ID,
      [{ code }],
      true,
    ) as Promise<T>;
  }

  private findFrame(frameTreeNodeId: number): WebFrameMain | null {
    const contents = this.view.webContents;
    if (contents.isDestroyed()) return null;
    if (!contents.mainFrame.isDestroyed() && contents.mainFrame.frameTreeNodeId === frameTreeNodeId) {
      return contents.mainFrame;
    }
    return contents.mainFrame.framesInSubtree.find(
      (frame) => !frame.isDestroyed() && frame.frameTreeNodeId === frameTreeNodeId,
    ) || null;
  }

  /**
   * Runs `code` in the parent frame of `frame`. Used for layout queries that
   * require access to the iframe owner element (getBoundingClientRect,
   * contentWindow). Executes in the same world as `executeInBrowserWorld`
   * for the main frame, or in the child frame's main world otherwise.
   */
  private executeInFrameLayout<T = unknown>(frame: WebFrameMain, code: string): Promise<T> {
    if (frame.isDestroyed()) return Promise.reject(new Error('browser_frame_stale'));
    if (frame.frameTreeNodeId === this.view.webContents.mainFrame.frameTreeNodeId) {
      return this.executeInBrowserWorld<T>(code);
    }
    return frame.executeJavaScript(code, true) as Promise<T>;
  }

  /**
   * Runs `code` in an isolated execution context of `frame`. The main frame
   * uses world 1004 (via executeInBrowserWorld). Same-origin and cross-origin
   * (OOPIF) child frames use a CDP-attached isolated world created via
   * Page.createIsolatedWorld on the appropriate CDP session.
   */
  private async executeInFrameIsolated<T = unknown>(frame: WebFrameMain, code: string): Promise<T> {
    if (frame.isDestroyed()) return Promise.reject(new Error('browser_frame_stale'));
    const mainFrame = this.view.webContents.mainFrame;
    if (frame.frameTreeNodeId === mainFrame.frameTreeNodeId) {
      return this.executeInBrowserWorld<T>(code);
    }
    if (this.isSameOriginWithMain(frame)) {
      return this.executeInSameOriginFrame<T>(frame, code);
    }
    return this.executeInOopifIsolated<T>(frame, code);
  }

  /**
   * Walks the parent chain from `frame` to the main frame and returns true
   * only if every hop is same-origin. A single cross-origin boundary makes
   * the frame tree cross-origin from the main frame's perspective.
   */
  private isSameOriginWithMain(frame: WebFrameMain): boolean {
    const mainFrame = this.view.webContents.mainFrame;
    const mainOrigin = mainFrame.origin;
    let current: WebFrameMain | null = frame;
    while (current) {
      if (current.origin !== mainOrigin) return false;
      if (current.frameTreeNodeId === mainFrame.frameTreeNodeId) break;
      current = current.parent;
    }
    return true;
  }

  /**
   * Executes `code` in an isolated world of the same-origin child `frame`.
   * Same-origin iframes live in the same renderer process as the main frame,
   * so we reuse the main frame's CDP session: no separate Target.attach is
   * needed. We look up the child's CDP frameId via Page.getFrameTree on the
   * main session, then call Page.createIsolatedWorld with that frameId.
   */
  private async executeInSameOriginFrame<T = unknown>(frame: WebFrameMain, code: string): Promise<T> {
    const contents = this.view.webContents;
    if (contents.isDestroyed()) throw new Error('webcontents_destroyed');

    const frameKey = frame.frameTreeNodeId;
    let entry = this.oopifWorlds.get(frameKey);

    if (!entry) {
      entry = await this.createSameOriginWorld(frame);
      if (entry) this.oopifWorlds.set(frameKey, entry);
    }
    if (!entry) throw new Error('browser_isolated_world_unavailable');

    try {
      const evaluateResp = await this.cdpEval(code, entry.contextId, entry.sessionId) as {
        result?: { value?: T }; exceptionDetails?: unknown;
      };
      if (evaluateResp.exceptionDetails) throw new Error('browser_frame_eval_failed');
      return evaluateResp.result?.value as T;
    } catch (error) {
      await this.releaseFrameWorld(frameKey, entry).catch(() => {});
      throw error;
    }
  }

  /**
   * Same as executeInSameOriginFrame but for cross-origin (OOPIF) child
   * frames. OOPIFs run in a separate renderer process and need their own
   * Target.attachToTarget before Page.createIsolatedWorld can be called.
   */
  private async executeInOopifIsolated<T = unknown>(frame: WebFrameMain, code: string): Promise<T> {
    const contents = this.view.webContents;
    if (contents.isDestroyed()) throw new Error('webcontents_destroyed');

    const frameKey = frame.frameTreeNodeId;
    let entry = this.oopifWorlds.get(frameKey);

    if (!entry) {
      entry = await this.createOopifWorld(frame);
      if (entry) this.oopifWorlds.set(frameKey, entry);
    }
    if (!entry) throw new Error('browser_isolated_world_unavailable');

    try {
      const evaluateResp = await this.cdpEval(code, entry.contextId, entry.sessionId) as {
        result?: { value?: T }; exceptionDetails?: unknown;
      };
      if (evaluateResp.exceptionDetails) throw new Error('browser_frame_eval_failed');
      return evaluateResp.result?.value as T;
    } catch (error) {
      // Context may be stale after navigation. Drop the cached entry so the
      // next call rebuilds it.
      await this.releaseFrameWorld(frameKey, entry).catch(() => {});
      throw error;
    }
  }

  /**
   * Wrapper around debugger.sendCommand for Runtime.evaluate that calls the
   * two-argument form when sessionId is empty. Electron does not document
   * an empty-string sessionId as equivalent to "no sessionId".
   */
  private async cdpEval(
    code: string,
    contextId: number,
    sessionId: string,
  ): Promise<{ result?: { value?: unknown }; exceptionDetails?: unknown }> {
    const debuggerApi = this.view.webContents.debugger;
    const params = {
      expression: code,
      contextId,
      returnByValue: true,
      awaitPromise: true,
      silent: true,
    };
    type EvalResp = { result?: { value?: unknown }; exceptionDetails?: unknown };
    if (sessionId) {
      return debuggerApi.sendCommand('Runtime.evaluate', params, sessionId) as Promise<EvalResp>;
    }
    return debuggerApi.sendCommand('Runtime.evaluate', params) as Promise<EvalResp>;
  }

  /**
   * Acquires the top-level CDP debugger attachment. Concurrent callers share
   * the same attach promise. Each successful acquire bumps the refcount; the
   * matching release in `releaseDebugger` decrements it and detaches when it
   * reaches zero.
   */
  private async acquireDebugger(): Promise<void> {
    if (this.debuggerAttachPromise) {
      await this.debuggerAttachPromise;
      this.debuggerRefs += 1;
      return;
    }
    const debuggerApi = this.view.webContents.debugger;
    if (debuggerApi.isAttached()) {
      // Someone else (not us) owns the debugger. We ride on the existing
      // attachment without taking ownership and never detach it ourselves.
      if (!this.debuggerOwnedByBrowser) {
        // Externally owned: do not increment our refcount.
        return;
      }
      this.debuggerRefs += 1;
      return;
    }
    this.debuggerAttachPromise = (async () => {
      debuggerApi.attach('1.3');
    })();
    try {
      await this.debuggerAttachPromise;
      this.debuggerOwnedByBrowser = true;
      this.debuggerRefs += 1;
    } finally {
      this.debuggerAttachPromise = null;
    }
  }

  private async releaseDebugger(): Promise<void> {
    if (!this.debuggerOwnedByBrowser) return;
    if (this.debuggerRefs <= 0) return;
    this.debuggerRefs -= 1;
    if (this.debuggerRefs === 0) {
      const debuggerApi = this.view.webContents.debugger;
      if (debuggerApi.isAttached()) debuggerApi.detach();
      this.debuggerOwnedByBrowser = false;
    }
  }

  /**
   * Creates an isolated world for a same-origin child frame via the main
   * CDP session. No Target.attach is needed because same-origin frames run
   * in the same renderer process as the main frame.
   */
  private async createSameOriginWorld(frame: WebFrameMain): Promise<{
    sessionId: string;
    contextId: number;
    sameOrigin: boolean;
    released: boolean;
  } | undefined> {
    const debuggerApi = this.view.webContents.debugger;
    await this.acquireDebugger();
    try {
      // Walk the full CDP frame tree and locate the node whose path matches
      // `frame`. We compare by index-path from main frame, so multiple
      // same-url frames are disambiguated by their position in the tree.
      const frameTreeResp = await debuggerApi.sendCommand('Page.getFrameTree') as {
        frameTree?: CdpFrameTree;
      };
      const cdpFrameId = findCdpFrameIdFor(frame, frameTreeResp.frameTree);
      if (!cdpFrameId) throw new Error('browser_frame_id_not_found');

      const worldResp = await debuggerApi.sendCommand('Page.createIsolatedWorld', {
        frameId: cdpFrameId,
        worldName: '',
        grantUniveralAccess: false,
      }) as { executionContextId?: number };
      const contextId = worldResp.executionContextId;
      if (typeof contextId !== 'number') throw new Error('browser_isolated_world_unavailable');

      return { sessionId: '', contextId, sameOrigin: true, released: false };
    } catch (error) {
      await this.releaseDebugger();
      throw error;
    }
  }

  /**
   * Attaches a CDP session to the OOPIF target, creates an isolated world,
   * and returns the session/contextId.
   */
  private async createOopifWorld(frame: WebFrameMain): Promise<{
    sessionId: string;
    contextId: number;
    sameOrigin: boolean;
    released: boolean;
  } | undefined> {
    const debuggerApi = this.view.webContents.debugger;
    await this.acquireDebugger();
    let sessionId = '';
    try {
      const targets = await debuggerApi.sendCommand('Target.getTargets') as {
        targetInfos?: Array<{
          targetId?: string;
          type?: string;
          url?: string;
        }>;
      };
      const frameUrl = `${frame.url || ''}`;
      const candidates = (targets.targetInfos || []).filter(
        (target) => target.type === 'iframe' && target.url === frameUrl && target.targetId,
      );
      if (candidates.length === 0) throw new Error('browser_frame_target_not_found');

      let targetFrameId: string | undefined;
      if (candidates.length > 1) {
        const mainTreeResp = await debuggerApi.sendCommand('Page.getFrameTree') as {
          frameTree?: CdpFrameTree;
        };
        targetFrameId = findCdpFrameIdFor(frame, mainTreeResp.frameTree);
        if (!targetFrameId) throw new Error('browser_frame_id_not_found');
      }

      let cdpFrameId = '';
      for (const candidate of candidates) {
        const attached = await debuggerApi.sendCommand('Target.attachToTarget', {
          targetId: candidate.targetId,
          flatten: true,
        }) as { sessionId?: string };
        const candidateSessionId = `${attached.sessionId || ''}`;
        if (!candidateSessionId) continue;

        try {
          // The attached target's frame tree is rooted at the OOPIF itself.
          // Compare that root id with the target frame id from the main tree;
          // unlike URL/parent matching, this also distinguishes identical
          // sibling iframes.
          const frameTreeResp = await debuggerApi.sendCommand(
            'Page.getFrameTree',
            {},
            candidateSessionId,
          ) as { frameTree?: CdpFrameTree };
          const candidateFrameId = frameTreeResp.frameTree?.frame?.id;
          const matches = candidates.length === 1
            ? typeof candidateFrameId === 'string'
            : candidateFrameId === targetFrameId;
          if (matches && candidateFrameId) {
            sessionId = candidateSessionId;
            cdpFrameId = candidateFrameId;
            break;
          }
        } catch {
          // Detach this candidate below and continue probing the others.
        }

        await debuggerApi.sendCommand(
          'Target.detachFromTarget',
          { sessionId: candidateSessionId },
        ).catch(() => {});
      }
      if (!sessionId || !cdpFrameId) throw new Error('browser_frame_attach_failed');

      const worldResp = await debuggerApi.sendCommand('Page.createIsolatedWorld', {
        frameId: cdpFrameId,
        worldName: '',
        grantUniveralAccess: false,
      }, sessionId) as { executionContextId?: number };
      const contextId = worldResp.executionContextId;
      if (typeof contextId !== 'number') throw new Error('browser_isolated_world_unavailable');

      return { sessionId, contextId, sameOrigin: false, released: false };
    } catch (error) {
      if (sessionId) {
        await debuggerApi.sendCommand('Target.detachFromTarget', { sessionId }).catch(() => {});
      }
      await this.releaseDebugger();
      throw error;
    }
  }

  /**
   * Releases a single cached frame world: detaches OOPIF Target session if
   * applicable, and decrements the shared debugger refcount. Idempotent —
   * a second release on the same entry is a no-op.
   */
  private async releaseFrameWorld(
    frameKey: number,
    entry: { sessionId: string; contextId: number; sameOrigin: boolean; released: boolean },
  ): Promise<void> {
    if (entry.released) return;
    entry.released = true;
    // Only delete the map entry if it still points at `entry`. A newer
    // entry may have been inserted under the same frameKey during the
    // async release chain (e.g. read after navigation).
    if (this.oopifWorlds.get(frameKey) === entry) {
      this.oopifWorlds.delete(frameKey);
    }
    const debuggerApi = this.view.webContents.debugger;
    if (!entry.sameOrigin && entry.sessionId && debuggerApi.isAttached()) {
      await debuggerApi.sendCommand('Target.detachFromTarget', { sessionId: entry.sessionId }).catch(() => {});
    }
    await this.releaseDebugger();
  }

  private async disposeOopifWorlds(): Promise<void> {
    const entries = Array.from(this.oopifWorlds.entries());
    this.oopifWorlds.clear();
    for (const [key, entry] of entries) {
      await this.releaseFrameWorld(key, entry).catch(() => {});
    }
  }

  private async navigateToUrl(url: string): Promise<void> {
    const contents = this.view.webContents;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let navigationStarted = false;
      const cleanup = () => {
        contents.removeListener('did-start-navigation', onDidStartNavigation);
        contents.removeListener('did-navigate', onDidNavigate);
        contents.removeListener('did-navigate-in-page', onDidNavigateInPage);
        contents.removeListener('did-fail-load', onDidFailLoad);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onDidStartNavigation = (
        _event: Electron.Event,
        _navigationUrl: string,
        _isInPlace: boolean,
        isMainFrame: boolean,
      ) => {
        if (isMainFrame) navigationStarted = true;
      };
      const onDidNavigate = () => {
        if (navigationStarted) finish();
      };
      const onDidNavigateInPage = (_event: Electron.Event, _navigatedUrl: string, isMainFrame: boolean) => {
        if (navigationStarted && isMainFrame) finish();
      };
      const onDidFailLoad = (
        _event: Electron.Event,
        errorCode: number,
        errorDescription: string,
        _validatedUrl: string,
        isMainFrame: boolean,
      ) => {
        if (!navigationStarted || !isMainFrame) return;
        // Chromium aborts the navigation when the response becomes a file
        // download. will-download already owns that flow and asks the user.
        if (errorCode === -3 || errorDescription.includes('ERR_ABORTED')) finish();
        else finish(new Error(`${errorDescription} (${errorCode})`));
      };

      contents.on('did-start-navigation', onDidStartNavigation);
      contents.on('did-navigate', onDidNavigate);
      contents.on('did-navigate-in-page', onDidNavigateInPage);
      contents.on('did-fail-load', onDidFailLoad);
      void contents.loadURL(url).then(
        () => finish(),
        (error: any) => {
          if (isAbortedNavigationError(error)) finish();
          else finish(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private async ensureReadablePage(): Promise<void> {
    const contents = this.view.webContents;
    if (!contents.getURL() || contents.getURL() === 'about:blank') {
      await this.navigateToUrl(HOME_URL);
    }
    if (!contents.isLoading()) return;

    const isDomReady = async (): Promise<boolean> => {
      if (contents.isDestroyed()) return false;
      try {
        return await this.executeInBrowserWorld<boolean>(
          `Boolean(document.body && (document.readyState === 'interactive' || document.readyState === 'complete'))`,
        );
      } catch {
        // The frame can be briefly unavailable while a navigation commits.
        return false;
      }
    };

    // Chromium's loading state includes subresources, ads and analytics.
    // Those may remain pending long after the main DOM is interactive, so
    // don't block browser tools on did-stop-loading alone.
    if (await isDomReady()) {
      this.setMainDocumentReady(true);
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      let poller: ReturnType<typeof setInterval>;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poller);
        contents.removeListener('dom-ready', onDomReady);
        contents.removeListener('did-stop-loading', done);
        // Even if a broken page never reaches DOMContentLoaded, browser tools
        // proceed after the safety timeout instead of advertising an endless
        // loading state to the model.
        this.setMainDocumentReady(true);
        resolve();
      };
      const check = () => {
        void isDomReady().then((ready) => {
          if (ready) done();
        });
      };
      const onDomReady = () => done();

      contents.once('dom-ready', onDomReady);
      contents.once('did-stop-loading', done);
      poller = setInterval(check, 100);
      timer = setTimeout(done, 3_000);
      check();
    });
  }

  private async readPage(mode: 'viewport' | 'delta' | 'full'): Promise<unknown> {
    await this.ensureReadablePage();
    const documentSeed = `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const effectiveMode = mode === 'full' ? 'full' : 'viewport';
    const maxText = effectiveMode === 'full' ? MAX_PAGE_TEXT : MAX_VIEWPORT_TEXT;
    const maxElements = effectiveMode === 'full' ? MAX_ELEMENTS : MAX_VIEWPORT_ELEMENTS;
    const script = `(() => {
      const documentSeed = ${JSON.stringify(documentSeed)};
      const mode = ${JSON.stringify(effectiveMode)};
      const maxText = ${maxText};
      const maxElements = ${maxElements};
      const clean = (value, max = 500) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max);
      const clipValue = (value, max = 4000) => String(value ?? '').slice(0, max);
      const getComposedParent = (element) => {
        if (element.assignedSlot) return element.assignedSlot;
        if (element.parentElement) return element.parentElement;
        const root = element.getRootNode?.();
        return root instanceof ShadowRoot ? root.host : null;
      };
      const hasVisibleStyles = (element) => {
        if (typeof element.checkVisibility === 'function') {
          try {
            if (!element.checkVisibility({
              checkOpacity: true,
              checkVisibilityCSS: true,
              opacityProperty: true,
              visibilityProperty: true,
            })) return false;
          } catch { /* fall through to the explicit checks below */ }
        }
        let current = element;
        while (current) {
          const style = window.getComputedStyle(current);
          if (
            style.display === 'none'
            || style.visibility === 'hidden'
            || style.visibility === 'collapse'
            || style.contentVisibility === 'hidden'
            || Number.parseFloat(style.opacity || '1') <= 0
          ) return false;
          current = getComposedParent(current);
        }
        return true;
      };
      const clipRectToAncestors = (element, sourceRect) => {
        let left = sourceRect.left;
        let top = sourceRect.top;
        let right = sourceRect.right;
        let bottom = sourceRect.bottom;
        let ancestor = getComposedParent(element);
        while (ancestor) {
          const style = window.getComputedStyle(ancestor);
          const clipsX = /^(hidden|clip|auto|scroll)$/.test(style.overflowX);
          const clipsY = /^(hidden|clip|auto|scroll)$/.test(style.overflowY);
          if (clipsX || clipsY) {
            const ancestorRect = ancestor.getBoundingClientRect();
            if (clipsX) {
              left = Math.max(left, ancestorRect.left);
              right = Math.min(right, ancestorRect.right);
            }
            if (clipsY) {
              top = Math.max(top, ancestorRect.top);
              bottom = Math.min(bottom, ancestorRect.bottom);
            }
            if (right - left <= 0.5 || bottom - top <= 0.5) return null;
          }
          ancestor = getComposedParent(ancestor);
        }
        return { left, top, right, bottom, width: right - left, height: bottom - top };
      };
      const getVisibleRects = (element) => {
        if (!hasVisibleStyles(element)) return [];
        return Array.from(element.getClientRects())
          .filter((rect) => rect.width > 0.5 && rect.height > 0.5)
          .map((rect) => clipRectToAncestors(element, rect))
          .filter(Boolean);
      };
      const deepElementFromPoint = (x, y) => {
        let hit = document.elementFromPoint(x, y);
        const visitedRoots = new Set();
        while (hit?.shadowRoot && !visitedRoots.has(hit.shadowRoot)) {
          visitedRoots.add(hit.shadowRoot);
          const shadowHit = hit.shadowRoot.elementFromPoint(x, y);
          if (!shadowHit || shadowHit === hit) break;
          hit = shadowHit;
        }
        return hit;
      };
      const composedContains = (ancestor, node) => {
        let current = node;
        while (current) {
          if (current === ancestor) return true;
          if (current.parentNode) {
            current = current.parentNode;
          } else if (current instanceof ShadowRoot) {
            current = current.host;
          } else {
            const root = current.getRootNode?.();
            current = root instanceof ShadowRoot ? root.host : null;
          }
        }
        return false;
      };
      const isHitTestVisible = (element, visibleRects) => {
        let hasViewportRect = false;
        for (const rect of visibleRects) {
          const left = Math.max(0, rect.left);
          const top = Math.max(0, rect.top);
          const right = Math.min(window.innerWidth, rect.right);
          const bottom = Math.min(window.innerHeight, rect.bottom);
          if (right - left <= 0.5 || bottom - top <= 0.5) continue;
          hasViewportRect = true;
          const insetX = Math.min(3, (right - left) / 4);
          const insetY = Math.min(3, (bottom - top) / 4);
          const points = [
            [(left + right) / 2, (top + bottom) / 2],
            [left + insetX, top + insetY],
            [right - insetX, top + insetY],
            [left + insetX, bottom - insetY],
            [right - insetX, bottom - insetY],
          ];
          if (points.some(([x, y]) => {
            const hit = deepElementFromPoint(x, y);
            return composedContains(element, hit) || (hit?.shadowRoot && composedContains(hit, element));
          })) return true;
        }
        return !hasViewportRect;
      };
      const isVisible = (element) => {
        const visibleRects = getVisibleRects(element);
        if (visibleRects.length === 0) return false;
        return mode === 'full' || isHitTestVisible(element, visibleRects);
      };
      const isNearViewport = (element) => {
        const rect = element.getBoundingClientRect();
        const margin = 300;
        return rect.bottom >= -margin && rect.top <= window.innerHeight + margin && rect.right >= -margin && rect.left <= window.innerWidth + margin;
      };
      const getComposedChildren = (node) => {
        if (node instanceof HTMLSlotElement) {
          const assigned = node.assignedNodes({ flatten: true });
          return assigned.length > 0 ? assigned : Array.from(node.childNodes);
        }
        if (node instanceof Element && node.shadowRoot) {
          return Array.from(node.shadowRoot.childNodes);
        }
        return Array.from(node.childNodes || []);
      };
      const getComposedText = (root) => {
        const parts = [];
        const stack = getComposedChildren(root).reverse();
        while (stack.length > 0) {
          const node = stack.pop();
          if (node.nodeType === Node.TEXT_NODE) {
            const value = clean(node.nodeValue || '', 500);
            if (value && parts[parts.length - 1] !== value) parts.push(value);
            if (parts.join(' ').length >= 500) break;
            continue;
          }
          if (node instanceof Element && node.matches('script,style,noscript,template')) continue;
          const children = getComposedChildren(node);
          for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
        }
        return clean(parts.join(' '), 500);
      };
      const collectText = (root, viewportOnly) => {
        const parts = [];
        let totalLength = 0;
        let truncated = false;
        const stack = getComposedChildren(root).reverse();
        while (stack.length > 0) {
          if (totalLength >= maxText) {
            truncated = true;
            break;
          }
          const node = stack.pop();
          if (node.nodeType === Node.TEXT_NODE) {
            const parent = node.parentElement;
            if (!parent || parent.closest('script,style,noscript,template')) continue;
            const value = clean(node.nodeValue || '', 4000);
            if (!value || !hasVisibleStyles(parent)) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            const rects = Array.from(range.getClientRects())
              .map((rect) => clipRectToAncestors(parent, rect))
              .filter(Boolean);
            if (rects.length === 0) continue;
            if (viewportOnly && !rects.some((rect) => rect.bottom >= -100 && rect.top <= window.innerHeight + 100 && rect.right >= 0 && rect.left <= window.innerWidth)) continue;
            if (parts[parts.length - 1] !== value) {
              parts.push(value);
              totalLength += value.length + (parts.length > 1 ? 1 : 0);
            }
            continue;
          }
          if (node instanceof Element && node.matches('script,style,noscript,template')) continue;
          const children = getComposedChildren(node);
          for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
        }
        return { text: parts.join('\\n'), truncated };
      };

      globalThis.__cb_di ||= documentSeed;
      globalThis.__cb_rc ||= 0;
      globalThis.__cb_rbe ||= new WeakMap();
      globalThis.__cb_e = new Map();
      const selectors = 'a,button,input,textarea,select,label,[onclick],[role="button"],[role="link"],[role="radio"],[role="checkbox"],[role="switch"],[contenteditable="true"]';
      const candidates = [];
      const seenCandidates = new WeakSet();
      const collectCandidates = (root) => {
        const stack = getComposedChildren(root).reverse();
        while (stack.length > 0) {
          const element = stack.pop();
          if (!(element instanceof Element)) continue;
          if (element.matches(selectors) && !seenCandidates.has(element)) {
            let supported = true;
            if (element instanceof HTMLLabelElement) {
              const control = element.control;
              supported = control instanceof HTMLInputElement && ['radio', 'checkbox'].includes((control.type || '').toLowerCase());
            }
            if (supported && isVisible(element) && (mode === 'full' || isNearViewport(element))) {
              seenCandidates.add(element);
              candidates.push(element);
            }
          }
          const children = getComposedChildren(element);
          for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
        }
      };
      collectCandidates(document.body);
      const elements = candidates.slice(0, maxElements).map((element) => {
        let ref = globalThis.__cb_rbe.get(element);
        if (!ref) {
          globalThis.__cb_rc += 1;
          ref = globalThis.__cb_di + '-' + globalThis.__cb_rc;
          globalThis.__cb_rbe.set(element, ref);
        }
        globalThis.__cb_e.set(ref, element);
        const tag = element.tagName.toLowerCase();
        const associatedInput = element instanceof HTMLInputElement
          ? element
          : element instanceof HTMLLabelElement && element.control instanceof HTMLInputElement
            ? element.control
            : undefined;
        const inputType = associatedInput ? clean(associatedInput.getAttribute('type') || 'text', 40).toLowerCase() : undefined;
        const attributeSource = associatedInput || element;
        const sensitiveHint = [
          inputType,
          attributeSource.getAttribute('autocomplete'),
          attributeSource.getAttribute('name'),
          attributeSource.getAttribute('id'),
          attributeSource.getAttribute('aria-label'),
          attributeSource.getAttribute('placeholder'),
        ].filter(Boolean).join(' ').toLowerCase();
        const sensitive = inputType === 'password' || /current-password|new-password|one-time-code|\\botp\\b|\\btotp\\b|\\b2fa\\b|verification.?code|auth(?:entication)?.?code|cc-number|cc-csc|cc-exp|credit.?card|card.?number|\\bcvv\\b|\\bcvc\\b|security.?code/.test(sensitiveHint);
        const readableInputTypes = new Set(['text', 'search', 'email', 'url', 'tel']);
        const buttonInputTypes = new Set(['button', 'submit', 'reset']);
        const toggleInputTypes = new Set(['radio', 'checkbox']);
        const associatedLabelText = associatedInput?.labels
          ? Array.from(associatedInput.labels).map(label => clean(label.innerText || label.textContent || '', 500)).filter(Boolean).join(' ')
          : '';
        const inputButtonText = associatedInput && buttonInputTypes.has(inputType || '') ? associatedInput.value : '';
        const nearbyToggleText = associatedInput && toggleInputTypes.has(inputType || '') && !associatedLabelText
          ? clean(associatedInput.parentElement?.innerText || associatedInput.parentElement?.textContent || '', 500)
          : '';
        const ariaChecked = element.getAttribute('aria-checked');
        const ariaExpanded = element.getAttribute('aria-expanded');
        const directText = clean(element.innerText || element.textContent || '', 500);
        const composedText = directText || getComposedText(element);
        const role = clean(
          element.getAttribute('role')
          || (element.hasAttribute('onclick') || buttonInputTypes.has(inputType || '') ? 'button' : '')
          || (toggleInputTypes.has(inputType || '') ? inputType : ''),
          60,
        );
        const disabled = associatedInput
          ? associatedInput.disabled
          : element instanceof HTMLButtonElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement
            ? element.disabled
            : element.getAttribute('aria-disabled') === 'true';
        let value;
        if (!sensitive) {
          if (associatedInput && readableInputTypes.has(inputType || 'text')) {
            value = clipValue(associatedInput.value);
          } else if (element instanceof HTMLTextAreaElement) {
            value = clipValue(element.value);
          } else if (element.isContentEditable) {
            value = clipValue(element.innerText || element.textContent || '');
          }
        }
        return {
          ref,
          tag,
          role,
          text: clean(element.getAttribute('aria-label') || composedText || associatedLabelText || inputButtonText || nearbyToggleText || element.getAttribute('title') || attributeSource.getAttribute('name') || '', 500),
          href: tag === 'a' ? clean(element.href || '', 1000) : undefined,
          inputType,
          placeholder: associatedInput || element instanceof HTMLTextAreaElement ? clean(attributeSource.getAttribute('placeholder') || '', 300) : undefined,
          sensitive,
          value,
          checked: associatedInput && toggleInputTypes.has(inputType || '')
            ? associatedInput.checked
            : ariaChecked === 'true' ? true : ariaChecked === 'false' ? false : undefined,
          disabled,
          expanded: ariaExpanded === 'true' ? true : ariaExpanded === 'false' ? false : undefined,
        };
      });
      const textResult = collectText(document.body, mode !== 'full');
      const rawText = textResult.text;
      return {
        title: clean(document.title, 500),
        url: location.href,
        text: rawText.slice(0, maxText),
        elements,
        truncated: textResult.truncated,
        scroll: {
          y: Math.round(window.scrollY),
          viewport_width: Math.round(window.innerWidth),
          viewport_height: Math.round(window.innerHeight),
          document_height: Math.round(document.documentElement?.scrollHeight || document.body?.scrollHeight || 0),
        },
      };
    })()`;

    const contents = this.view.webContents;
    const mainFrame = contents.mainFrame;
    const allFrames = [
      mainFrame,
      ...mainFrame.framesInSubtree.filter(
        (frame) => !frame.isDestroyed() && frame.frameTreeNodeId !== mainFrame.frameTreeNodeId,
      ),
    ];
    const frames = allFrames.slice(0, MAX_BROWSER_FRAMES);
    const frameReads = await Promise.allSettled(frames.map(async (frame) => ({
      frame,
      result: await this.executeInFrameIsolated<BrowserFrameReadResult>(frame, script),
    })));

    const successfulReads = frameReads.flatMap((read) => read.status === 'fulfilled' ? [read.value] : []);
    const mainRead = successfulReads.find(({ frame }) => frame.frameTreeNodeId === mainFrame.frameTreeNodeId);
    if (!mainRead) throw new Error('browser_main_frame_unreadable');

    const frameLayouts = await Promise.allSettled(successfulReads.map(async (read) => {
      if (read.frame.frameTreeNodeId === mainFrame.frameTreeNodeId) return { ...read, include: true };
      const transform = await this.getFrameTransform(read.frame);
      const frameViewportWidth = Math.max(0, read.result.scroll?.viewport_width || 0) * Math.abs(transform.scaleX);
      const frameViewportHeight = Math.max(0, read.result.scroll?.viewport_height || 0) * Math.abs(transform.scaleY);
      const margin = 300;
      const nearViewport = transform.offsetX + frameViewportWidth >= -margin
        && transform.offsetY + frameViewportHeight >= -margin
        && transform.offsetX <= transform.viewportW + margin
        && transform.offsetY <= transform.viewportH + margin;
      return {
        ...read,
        include: transform.visible && (effectiveMode === 'full' || nearViewport),
      };
    }));
    const readableReads = frameLayouts.flatMap((layout) => (
      layout.status === 'fulfilled' && layout.value.include ? [layout.value] : []
    ));

    const url = `${mainRead.result.url || contents.getURL()}`;
    const textParts: string[] = [];
    const elements: BrowserElement[] = [];
    const frameInfos: BrowserFrameInfo[] = [];
    const frameSnapshots = new Map<string, BrowserFrameSnapshot>();
    let textLength = 0;
    let truncated = allFrames.length > frames.length
      || frameReads.some((read) => read.status === 'rejected')
      || frameLayouts.some((layout) => layout.status === 'rejected');

    for (const { frame, result } of readableReads) {
      const isMainFrame = frame.frameTreeNodeId === mainFrame.frameTreeNodeId;
      const frameId = isMainFrame ? 'main' : `frame-${frame.frameTreeNodeId}`;
      const liveFrameUrl = `${frame.url || ''}`;
      const frameUrl = `${result.url || liveFrameUrl}`;
      const frameTitle = `${result.title || ''}`;
      const frameText = `${result.text || ''}`;

      if (!isMainFrame && (frameText || (result.elements?.length || 0) > 0)) {
        frameInfos.push({
          id: frameId,
          parent_id: frame.parent && frame.parent.frameTreeNodeId !== mainFrame.frameTreeNodeId
            ? `frame-${frame.parent.frameTreeNodeId}`
            : 'main',
          url: frameUrl.slice(0, 1000),
          name: `${frame.name || ''}`.slice(0, 200),
          title: frameTitle.slice(0, 500),
        });
      }

      if (frameText && textLength < maxText) {
        const prefix = isMainFrame
          ? ''
          : `[iframe ${frameId}${frameTitle ? ` title=${JSON.stringify(frameTitle)}` : ''}${frameUrl ? ` url=${JSON.stringify(frameUrl)}` : ''}]\n`;
        const separator = textParts.length > 0 ? '\n' : '';
        const segment = `${separator}${prefix}${frameText}`;
        const remaining = maxText - textLength;
        textParts.push(segment.slice(0, remaining));
        textLength += Math.min(segment.length, remaining);
        if (segment.length > remaining) truncated = true;
      } else if (frameText) {
        truncated = true;
      }

      if (result.truncated === true) truncated = true;
      for (const element of result.elements || []) {
        if (elements.length >= maxElements) {
          truncated = true;
          break;
        }
        const internalRef = element.ref;
        const externalRef = isMainFrame ? internalRef : `${frameId}:${internalRef}`;
        const externalElement: BrowserElement = {
          ...element,
          ref: externalRef,
          ...(isMainFrame ? {} : { frame: frameId }),
        };
        elements.push(externalElement);
        frameSnapshots.set(externalRef, {
          frameTreeNodeId: frame.frameTreeNodeId,
          frameUrl: liveFrameUrl,
          internalRef,
        });
      }
    }

    const text = textParts.join('');
    const previous = this.lastReadSnapshot;
    const current: BrowserReadSnapshot = { url, text, elements, mode: effectiveMode };

    this.snapshotUrl = url;
    this.snapshotElements = new Map(elements.map((element) => [element.ref, element]));
    this.snapshotFrames = frameSnapshots;
    this.lastReadSnapshot = current;

    const common = {
      status: 'success',
      title: mainRead.result.title || '',
      url,
      scroll: mainRead.result.scroll,
      truncated,
      ...(frameInfos.length > 0 ? { frames: frameInfos } : {}),
    };

    if (mode === 'delta' && previous?.url === url && previous.mode === effectiveMode) {
      const previousElements = new Map(previous.elements.map((element) => [element.ref, element]));
      const currentRefs = new Set(elements.map((element) => element.ref));
      const changedElements = elements.filter((element) => JSON.stringify(previousElements.get(element.ref)) !== JSON.stringify(element));
      const removedRefs = previous.elements.filter((element) => !currentRefs.has(element.ref)).map((element) => element.ref);
      const textDelta = buildTextDelta(previous.text, text);
      const unchanged = !textDelta && changedElements.length === 0 && removedRefs.length === 0;
      return {
        ...common,
        mode: 'delta',
        unchanged,
        ...(textDelta ? { text_delta: textDelta } : {}),
        ...(changedElements.length > 0 ? { changed_elements: changedElements } : {}),
        ...(removedRefs.length > 0 ? { removed_refs: removedRefs } : {}),
      };
    }

    return {
      ...common,
      mode: effectiveMode,
      ...(mode === 'delta' ? { delta_reset: true } : {}),
      text,
      elements,
    };
  }

  private getSnapshotElement(ref: string): BrowserElement {
    if (!ref || this.snapshotUrl !== this.view.webContents.getURL()) throw new Error('browser_snapshot_stale');
    const element = this.snapshotElements.get(ref);
    if (!element) throw new Error('browser_element_not_found');
    return element;
  }

  private getSnapshotTarget(ref: string): {
    element: BrowserElement;
    frame: WebFrameMain;
    internalRef: string;
  } {
    const element = this.getSnapshotElement(ref);
    const snapshot = this.snapshotFrames.get(ref);
    if (!snapshot) throw new Error('browser_snapshot_stale');
    const frame = this.findFrame(snapshot.frameTreeNodeId);
    if (!frame || frame.url !== snapshot.frameUrl) throw new Error('browser_frame_stale');
    return { element, frame, internalRef: snapshot.internalRef };
  }

  private async getTargetCheckedState(frame: WebFrameMain, internalRef: string): Promise<boolean | undefined> {
    return this.executeInFrameIsolated<boolean | undefined>(frame, `(() => {
      const target = globalThis.__cb_e?.get(${JSON.stringify(internalRef)});
      if (!target || !target.isConnected) return undefined;
      const element = target instanceof HTMLLabelElement && target.control ? target.control : target;
      if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type.toLowerCase())) {
        return element.checked;
      }
      const ariaChecked = element.getAttribute?.('aria-checked');
      return ariaChecked === 'true' ? true : ariaChecked === 'false' ? false : undefined;
    })()`);
  }

  private getChildFrameIndex(parent: WebFrameMain, child: WebFrameMain): number {
    const index = parent.frames.findIndex((frame) => frame.frameTreeNodeId === child.frameTreeNodeId);
    if (index < 0) throw new Error('browser_frame_stale');
    return index;
  }

  private async getFrameOwnerMetrics(
    parent: WebFrameMain,
    child: WebFrameMain,
    scrollIntoView: boolean,
  ): Promise<{
    left: number;
    top: number;
    width: number;
    height: number;
    clientLeft: number;
    clientTop: number;
    offsetWidth: number;
    offsetHeight: number;
    visible: boolean;
  }> {
    const childIndex = this.getChildFrameIndex(parent, child);
    const script = `(async () => {
      const childWindow = window.frames[${childIndex}];
      const childUrl = ${JSON.stringify(child.url)};
      const getComposedChildren = (node) => {
        if (node instanceof HTMLSlotElement) {
          const assigned = node.assignedNodes({ flatten: true });
          return assigned.length > 0 ? assigned : Array.from(node.childNodes);
        }
        if (node instanceof Element && node.shadowRoot) return Array.from(node.shadowRoot.childNodes);
        return Array.from(node.childNodes || []);
      };
      const frameElements = [];
      const stack = getComposedChildren(document).reverse();
      while (stack.length > 0) {
        const node = stack.pop();
        if (!(node instanceof Element)) continue;
        if (node instanceof HTMLIFrameElement || node instanceof HTMLFrameElement) frameElements.push(node);
        const children = getComposedChildren(node);
        for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
      }
      let owner = frameElements.find((element) => childWindow && element.contentWindow === childWindow) || null;
      if (!owner && childUrl) {
        const urlMatches = frameElements.filter((element) => element.src === childUrl);
        if (urlMatches.length === 1) owner = urlMatches[0];
      }
      if (!owner) owner = frameElements[${childIndex}] || null;
      if (!owner) throw new Error('browser_frame_owner_not_found');
      if (${scrollIntoView ? 'true' : 'false'}) {
        owner.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        await new Promise(resolve => setTimeout(resolve, 350));
      }
      if (!owner.isConnected) throw new Error('browser_frame_stale');
      const rect = owner.getBoundingClientRect();
      const style = window.getComputedStyle(owner);
      let visible = rect.width > 0.5
        && rect.height > 0.5
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.visibility !== 'collapse'
        && style.contentVisibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0;
      if (visible && typeof owner.checkVisibility === 'function') {
        try {
          visible = owner.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
            opacityProperty: true,
            visibilityProperty: true,
          });
        } catch { /* explicit checks above are the fallback */ }
      }
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        clientLeft: owner.clientLeft,
        clientTop: owner.clientTop,
        offsetWidth: owner.offsetWidth,
        offsetHeight: owner.offsetHeight,
        visible,
      };
    })()`;
    return this.executeInFrameLayout(parent, script);
  }

  private async scrollFrameChainIntoView(frame: WebFrameMain): Promise<void> {
    const chain: Array<{ parent: WebFrameMain; child: WebFrameMain }> = [];
    let child: WebFrameMain | null = frame;
    while (child) {
      const parent: WebFrameMain | null = child.parent;
      if (!parent) break;
      chain.push({ parent, child });
      child = parent;
    }
    for (const pair of chain.reverse()) {
      await this.getFrameOwnerMetrics(pair.parent, pair.child, true);
    }
  }

  private async getFrameTransform(frame: WebFrameMain): Promise<{
    offsetX: number;
    offsetY: number;
    scaleX: number;
    scaleY: number;
    viewportW: number;
    viewportH: number;
    visible: boolean;
  }> {
    let offsetX = 0;
    let offsetY = 0;
    let scaleX = 1;
    let scaleY = 1;
    let visible = true;
    let child: WebFrameMain | null = frame;

    while (child) {
      const parent: WebFrameMain | null = child.parent;
      if (!parent) break;
      const owner = await this.getFrameOwnerMetrics(parent, child, false);
      const ownerScaleX = owner.offsetWidth > 0 ? owner.width / owner.offsetWidth : 1;
      const ownerScaleY = owner.offsetHeight > 0 ? owner.height / owner.offsetHeight : 1;
      offsetX = owner.left + owner.clientLeft * ownerScaleX + offsetX * ownerScaleX;
      offsetY = owner.top + owner.clientTop * ownerScaleY + offsetY * ownerScaleY;
      scaleX *= ownerScaleX;
      scaleY *= ownerScaleY;
      visible = visible && owner.visible;
      child = parent;
    }

    const viewport = await this.executeInBrowserWorld<{ width: number; height: number }>(
      `({ width: window.innerWidth, height: window.innerHeight })`,
    );
    return { offsetX, offsetY, scaleX, scaleY, viewportW: viewport.width, viewportH: viewport.height, visible };
  }

  private async createFrameInputSession(
    frame: WebFrameMain,
    internalRef: string,
    transform: Awaited<ReturnType<ChatterBrowser['getFrameTransform']>>,
  ): Promise<BrowserFrameInputSession | null> {
    const contents = this.view.webContents;
    if (frame.frameTreeNodeId === contents.mainFrame.frameTreeNodeId) return null;

    // Reuse the cached world for this frame. If none exists yet (frame was
    // not visited during the read phase), open one on demand. The branch
    // matches the same-origin / OOPIF decision used by executeInFrameIsolated.
    const sameOrigin = this.isSameOriginWithMain(frame);
    let entry = this.oopifWorlds.get(frame.frameTreeNodeId);
    if (!entry) {
      entry = sameOrigin
        ? await this.createSameOriginWorld(frame).catch(() => undefined)
        : await this.createOopifWorld(frame).catch(() => undefined);
      if (entry) this.oopifWorlds.set(frame.frameTreeNodeId, entry);
    }
    if (!entry) throw new Error('browser_frame_input_unavailable');

    // Verify the ref is present in the element map before dispatching.
    const probe = await this.cdpEval(
      `Boolean(globalThis.__cb_e?.has(${JSON.stringify(internalRef)}))`,
      entry.contextId,
      entry.sessionId,
    ) as { result?: { value?: boolean } };
    if (probe?.result?.value !== true) {
      throw new Error('browser_frame_input_unavailable');
    }

    // For same-origin frames we dispatch via the main CDP session using
    // global viewport coordinates (x, y as-is). For OOPIFs we dispatch via
    // the child session using local frame coordinates (transformed).
    const debuggerApi = contents.debugger;
    const dispatch: MouseEventDispatcher = async (type, x, y, button = 'left', clickCount = 1) => {
      const cdpType = type === 'mouseMove' ? 'mouseMoved' : type === 'mouseDown' ? 'mousePressed' : 'mouseReleased';
      const params = {
        type: cdpType,
        x: sameOrigin ? x : (x - transform.offsetX) / transform.scaleX,
        y: sameOrigin ? y : (y - transform.offsetY) / transform.scaleY,
        button: type === 'mouseMove' ? 'none' : button,
        buttons: type === 'mouseDown' ? 1 : 0,
        clickCount,
      };
      if (sameOrigin) {
        await debuggerApi.sendCommand('Input.dispatchMouseEvent', params);
      } else {
        await debuggerApi.sendCommand('Input.dispatchMouseEvent', params, entry.sessionId);
      }
    };

    return { dispatch, dispose: async () => {} };
  }

  private async clickElement(ref: string): Promise<unknown> {
    if (this.interactionInProgress) throw new Error('browser_interaction_in_progress');
    const { element: expected, frame, internalRef } = this.getSnapshotTarget(ref);
    this.interactionInProgress = true;

    const contents = this.view.webContents;

    // -- Phase 1: bring the element into view and read a stable clickable rect --
    const rectScript = `(async () => {
      const element = globalThis.__cb_e?.get(${JSON.stringify(internalRef)});
      if (!element) throw new Error('browser_element_not_found');
      element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      await new Promise(resolve => setTimeout(resolve, 350));
      if (!element.isConnected) throw new Error('browser_element_not_found');

      const visibleRects = Array.from(element.getClientRects()).filter(r =>
        r.width > 0 && r.height > 0
        && r.bottom > 0 && r.right > 0
        && r.top < window.innerHeight && r.left < window.innerWidth
      );
      const r = visibleRects.sort((a, b) => (b.width * b.height) - (a.width * a.height))[0]
        || element.getBoundingClientRect();
      return {
        x: r.left, y: r.top, width: r.width, height: r.height,
        viewportW: window.innerWidth, viewportH: window.innerHeight,
      };
    })()`;

    let rect: { x: number; y: number; width: number; height: number; viewportW: number; viewportH: number };
    let transform: Awaited<ReturnType<ChatterBrowser['getFrameTransform']>>;
    try {
      await this.scrollFrameChainIntoView(frame);
      rect = await this.executeInFrameIsolated(frame, rectScript);
      transform = await this.getFrameTransform(frame);
      if (!transform.visible || Math.abs(transform.scaleX) < 0.001 || Math.abs(transform.scaleY) < 0.001) {
        throw new Error('click_target_moved');
      }
    } catch (error) {
      this.interactionInProgress = false;
      throw error;
    }

    const viewport = { width: transform.viewportW, height: transform.viewportH };

    // Initialise cursor position if this is the first interaction.
    if (this.cursorPos.x === 0 && this.cursorPos.y === 0) {
      this.cursorPos = { x: viewport.width / 2, y: viewport.height / 2 };
    }

    // -- Phase 2: pick a single target (used by both visual + native) --
    const elementRect = {
      x: transform.offsetX + rect.x * transform.scaleX,
      y: transform.offsetY + rect.y * transform.scaleY,
      width: rect.width * transform.scaleX,
      height: rect.height * transform.scaleY,
    };
    // pickTargetPoint clips to viewport internally, so partially off-screen
    // elements and tiny elements are handled correctly.
    const target = pickTargetPoint(elementRect, viewport);
    const localTarget = {
      x: (target.x - transform.offsetX) / transform.scaleX,
      y: (target.y - transform.offsetY) / transform.scaleY,
    };
    const trajectory = generateTrajectory(this.cursorPos, target);

    // -- Phase 3: show visual cursor overlay --
    const showCursorScript = `(() => {
      let cursor = document.getElementById('__cb-c');
      if (!cursor) {
        cursor = document.createElement('div');
        cursor.id = '__cb-c';
        Object.assign(cursor.style, {
          position: 'fixed', width: '14px', height: '14px', borderRadius: '50%',
          background: 'rgba(34, 105, 225, 0.92)', border: '2px solid white',
          boxShadow: '0 2px 9px rgba(0,0,0,.4)', pointerEvents: 'none',
          zIndex: '2147483647', left: '0', top: '0', transform: 'translate(-50%, -50%)',
          opacity: '0', transition: 'opacity 120ms ease'
        });
        document.documentElement.appendChild(cursor);
      }
      cursor.style.left = ${this.cursorPos.x} + 'px';
      cursor.style.top = ${this.cursorPos.y} + 'px';
      cursor.style.opacity = '1';
      return true;
    })()`;
    await this.executeInBrowserWorld(showCursorScript).catch(() => {});

    // Animate the DOM cursor along the same trajectory (best-effort, visual only).
    const visualAnimation = this.executeInBrowserWorld(`(() => {
      const cursor = document.getElementById('__cb-c');
      if (!cursor) return false;
      const points = ${JSON.stringify(trajectory)};
      let i = 0;
      const step = () => {
        if (i >= points.length) return;
        cursor.style.left = points[i].x + 'px';
        cursor.style.top = points[i].y + 'px';
        i++;
        if (i < points.length) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      return true;
    })()`).catch(() => {});

    // -- Phase 4: stream native sendInputEvent via cursor-input module --
    this.clickToken = { cancelled: false };
    const token = this.clickToken;
    let frameInputSession: BrowserFrameInputSession | null = null;
    let actualChecked = expected.checked;

    // Highlight element outline — save original values for restoration.
    this.executeInFrameIsolated(frame, `(() => {
      const element = globalThis.__cb_e?.get(${JSON.stringify(internalRef)});
      if (!element) return false;
      globalThis.__cb_so = element.style.outline;
      globalThis.__cb_soo = element.style.outlineOffset;
      element.style.outline = '2px solid rgba(34, 105, 225, .9)';
      element.style.outlineOffset = '3px';
      return true;
    })()`).catch(() => {});

    try {
      frameInputSession = await this.createFrameInputSession(frame, internalRef, transform);
      // Pass the pre-selected target AND trajectory so visual cursor and
      // native events follow the exact same path and speed.
      const validateTarget = async () => {
        const localTargetValid = await this.executeInFrameIsolated<boolean>(frame, `(() => {
        const element = globalThis.__cb_e?.get(${JSON.stringify(internalRef)});
        if (!element || !element.isConnected) return false;
        let hit = document.elementFromPoint(${localTarget.x}, ${localTarget.y});
        const visitedRoots = new Set();
        while (hit?.shadowRoot && !visitedRoots.has(hit.shadowRoot)) {
          visitedRoots.add(hit.shadowRoot);
          const shadowHit = hit.shadowRoot.elementFromPoint(${localTarget.x}, ${localTarget.y});
          if (!shadowHit || shadowHit === hit) break;
          hit = shadowHit;
        }
        const composedContains = (ancestor, node) => {
          let current = node;
          while (current) {
            if (current === ancestor) return true;
            if (current.parentNode) {
              current = current.parentNode;
            } else if (current instanceof ShadowRoot) {
              current = current.host;
            } else {
              const root = current.getRootNode?.();
              current = root instanceof ShadowRoot ? root.host : null;
            }
          }
          return false;
        };
        return !!hit && (
          composedContains(element, hit)
          || (hit.shadowRoot && composedContains(hit, element))
        );
        })()`);
        if (!localTargetValid) return false;
        const currentTransform = await this.getFrameTransform(frame);
        if (!currentTransform.visible) return false;
        const currentTargetX = currentTransform.offsetX + localTarget.x * currentTransform.scaleX;
        const currentTargetY = currentTransform.offsetY + localTarget.y * currentTransform.scaleY;
        return Math.abs(currentTargetX - target.x) <= 2 && Math.abs(currentTargetY - target.y) <= 2;
      };
      this.cursorPos = await naturalClick(
        contents,
        elementRect,
        this.cursorPos,
        token,
        target,
        trajectory,
        validateTarget,
        frameInputSession?.dispatch,
      );

      if (expected.checked !== undefined) {
        const shouldChange = expected.inputType === 'checkbox'
          || expected.role === 'checkbox'
          || expected.role === 'switch'
          || ((expected.inputType === 'radio' || expected.role === 'radio') && expected.checked === false);
        for (let attempt = 0; attempt < 4; attempt += 1) {
          actualChecked = await this.getTargetCheckedState(frame, internalRef);
          if (!shouldChange || actualChecked === undefined || actualChecked !== expected.checked) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (shouldChange && actualChecked === expected.checked) throw new Error('browser_click_no_effect');
      }

      // Brief settle, then restore outline + hide cursor.
      await new Promise(resolve => setTimeout(resolve, 200));
      await this.executeInFrameIsolated(frame, `(() => {
        const element = globalThis.__cb_e?.get(${JSON.stringify(internalRef)});
        if (element && element.isConnected) {
          element.style.outline = globalThis.__cb_so || '';
          element.style.outlineOffset = globalThis.__cb_soo || '';
        }
        delete globalThis.__cb_so;
        delete globalThis.__cb_soo;
        return true;
      })()`).catch(() => {});
      await this.executeInBrowserWorld(`(() => {
        const cursor = document.getElementById('__cb-c');
        if (cursor) cursor.style.opacity = '0';
        globalThis.__cb_cp = { x: ${target.x}, y: ${target.y} };
        return true;
      })()`).catch(() => {});

      await visualAnimation;

      const resultElement = actualChecked === undefined ? expected : { ...expected, checked: actualChecked };
      this.snapshotElements.set(ref, resultElement);

      return {
        status: 'success',
        action: 'click',
        element: resultElement,
        ...this.getState(),
      };
    } catch (error) {
      // Clean up: restore outline + hide visual cursor on error / cancellation.
      await this.executeInFrameIsolated(frame, `(() => {
        const element = globalThis.__cb_e?.get(${JSON.stringify(internalRef)});
        if (element && element.isConnected) {
          element.style.outline = globalThis.__cb_so || '';
          element.style.outlineOffset = globalThis.__cb_soo || '';
        }
        delete globalThis.__cb_so;
        delete globalThis.__cb_soo;
        return true;
      })()`).catch(() => {});
      await this.executeInBrowserWorld(`(() => {
        const cursor = document.getElementById('__cb-c');
        if (cursor) cursor.style.opacity = '0';
        return true;
      })()`).catch(() => {});
      throw error;
    } finally {
      await frameInputSession?.dispose();
      this.clickToken = null;
      this.interactionInProgress = false;
    }
  }

  private async fillElement(ref: string, text: string): Promise<unknown> {
    if (this.interactionInProgress) throw new Error('browser_interaction_in_progress');
    const { element: expected, frame, internalRef } = this.getSnapshotTarget(ref);
    this.interactionInProgress = true;
    if (expected.sensitive) {
      this.interactionInProgress = false;
      throw new Error('browser_sensitive_fields_are_manual_only');
    }
    if (text.length > 10_000) {
      this.interactionInProgress = false;
      throw new Error('browser_input_too_large');
    }

    const script = `(() => {
      const element = globalThis.__cb_e?.get(${JSON.stringify(internalRef)});
      if (!element) throw new Error('browser_element_not_found');
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) {
        throw new Error('browser_element_not_editable');
      }
      const sensitiveHint = [element.getAttribute('type'), element.getAttribute('autocomplete'), element.getAttribute('name'), element.id, element.getAttribute('aria-label'), element.getAttribute('placeholder')].filter(Boolean).join(' ').toLowerCase();
      if ((element instanceof HTMLInputElement && element.type.toLowerCase() === 'password') || /current-password|new-password|one-time-code|\\botp\\b|\\btotp\\b|\\b2fa\\b|verification.?code|auth(?:entication)?.?code|cc-number|cc-csc|cc-exp|credit.?card|card.?number|\\bcvv\\b|\\bcvc\\b|security.?code/.test(sensitiveHint)) {
        throw new Error('browser_sensitive_fields_are_manual_only');
      }
      element.focus();
      if (element.isContentEditable) {
        element.textContent = ${JSON.stringify(text)};
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} }));
      } else {
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        setter?.call(element, ${JSON.stringify(text)});
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    })()`;
    try {
      await this.executeInFrameIsolated(frame, script);
      return { status: 'success', action: 'fill', element: expected, characters: text.length, ...this.getState() };
    } finally {
      this.interactionInProgress = false;
    }
  }
}
