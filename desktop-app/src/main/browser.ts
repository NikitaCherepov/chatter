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
  action: 'open' | 'read' | 'back' | 'forward' | 'reload' | 'scroll' | 'click' | 'fill' | 'press_key' | 'check_site_permission' | 'grant_site_permission' | 'resolve_download' | 'youtube_music';
  url?: string;
  ref?: string;
  text?: string;
  key?: 'Enter' | 'Space';
  permission_action?: 'click' | 'fill';
  origin?: string;
  expected_origin?: string;
  mode?: 'viewport' | 'delta' | 'full';
  direction?: 'up' | 'down';
  amount?: number;
  download_id?: string;
  approved?: boolean;
  destination?: 'prompt' | 'downloads';
  music_action?: 'search_and_play' | 'play' | 'pause' | 'toggle_play_pause' | 'next' | 'previous' | 'set_volume' | 'mute' | 'unmute' | 'get_state' | 'show';
  query?: string;
  volume?: number;
};

export type ChatterBrowserOptions = {
  homeUrl?: string;
  stateChannel?: string;
  partition?: string;
  backgroundSize?: { width: number; height: number };
};

export type BrowserSearchPayload = {
  query?: string;
  mode?: 'web' | 'wikipedia';
  searchType?: 'web' | 'news';
  sort?: 'relevance' | 'date';
  freshness?: 'any' | 'day' | 'week' | 'month' | 'year';
  page?: number;
  language?: string;
};

export type GoogleAiPayload = {
  action?: 'ask' | 'new_chat' | 'reload' | 'close_session';
  message?: string;
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
const YOUTUBE_MUSIC_ORIGIN = 'https://music.youtube.com';

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
  private googleAiInProgress = false;
  private googleAiRunId = 0;
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
  private readonly homeUrl: string;
  private readonly stateChannel: string;

  constructor(host: BrowserWindow, options: ChatterBrowserOptions = {}) {
    this.host = host;
    this.homeUrl = options.homeUrl || HOME_URL;
    this.stateChannel = options.stateChannel || 'browser:state';
    this.view = new WebContentsView({
      webPreferences: {
        partition: options.partition || 'persist:chatter-browser',
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        // Browser tools must keep running while the host Chatter window is minimized or hidden.
        backgroundThrottling: false,
      },
    });

    host.contentView.addChildView(this.view);
    if (options.backgroundSize) {
      this.view.setBounds({
        x: 0,
        y: 0,
        width: Math.max(800, Math.floor(options.backgroundSize.width)),
        height: Math.max(600, Math.floor(options.backgroundSize.height)),
      });
    }
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
    this.cancelGoogleAi();
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

  async capturePreview(width = 192, height = 192): Promise<string | null> {
    const contents = this.view.webContents;
    if (contents.isDestroyed()) return null;

    try {
      const image = await contents.capturePage();
      if (image.isEmpty()) return null;
      const resized = image.resize({
        width: Math.max(32, Math.floor(width)),
        height: Math.max(32, Math.floor(height)),
        quality: 'good',
      });
      return `data:image/jpeg;base64,${resized.toJPEG(58).toString('base64')}`;
    } catch (error) {
      console.warn('[browser] failed to capture preview:', error);
      return null;
    }
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
      const initialNavigation = this.view.webContents.loadURL(this.homeUrl).catch((error) => {
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
    if (action === 'youtube_music') {
      return this.controlYouTubeMusic(payload);
    }

    if (action === 'open') {
      // Explicit navigation must remain an escape hatch when a complex SPA leaves
      // an earlier click or fill waiting on a stale renderer context.
      if (this.interactionInProgress) this.abortInteraction();
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
      this.abortInteraction();
      if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      return this.getState();
    }
    if (action === 'forward') {
      this.abortInteraction();
      if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
      return this.getState();
    }
    if (action === 'reload') {
      this.abortInteraction();
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
    if (action === 'press_key') {
      const expectedOrigin = payload.expected_origin ? this.normalizeHttpOrigin(payload.expected_origin) : null;
      if (payload.expected_origin && (!expectedOrigin || expectedOrigin !== this.getCurrentHttpOrigin())) {
        throw new Error('browser_origin_changed');
      }
      const key = payload.key;
      if (key !== 'Enter' && key !== 'Space') throw new Error('browser_key_not_allowed');
      if (this.interactionInProgress) throw new Error('browser_interaction_in_progress');
      this.interactionInProgress = true;
      try {
        contents.focus();
        contents.sendInputEvent({ type: 'keyDown', keyCode: key });
        contents.sendInputEvent({ type: 'keyUp', keyCode: key });
        await new Promise(resolve => setTimeout(resolve, 150));
        return { status: 'success', action, key, ...this.getState() };
      } finally {
        this.interactionInProgress = false;
      }
    }

    throw new Error('unsupported_browser_action');
  }

  async search(payload: BrowserSearchPayload): Promise<unknown> {
    const query = `${payload?.query || ''}`.trim();
    if (!query || query.length > 500) throw new Error('desktop_search_query_invalid');
    const mode = payload?.mode === 'wikipedia' ? 'wikipedia' : 'web';
    const searchType = payload?.searchType === 'news' ? 'news' : 'web';
    const sort = payload?.sort === 'date' ? 'date' : 'relevance';
    const freshness = payload?.freshness === 'day'
      || payload?.freshness === 'week'
      || payload?.freshness === 'month'
      || payload?.freshness === 'year'
      ? payload.freshness
      : 'any';
    const page = Math.max(1, Math.min(10, Math.floor(Number(payload?.page) || 1)));
    const language = `${payload?.language || 'en'}`.trim().toLowerCase().split('-')[0];
    const safeLanguage = /^[a-z]{2,3}$/.test(language) ? language : 'en';
    let targetUrl: string;
    if (mode === 'wikipedia') {
      targetUrl = `https://${safeLanguage}.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}&title=Special%3ASearch&fulltext=1&offset=${(page - 1) * 20}`;
    } else {
      const googleUrl = new URL('https://www.google.com/search');
      googleUrl.searchParams.set('q', query);
      googleUrl.searchParams.set('start', `${(page - 1) * 10}`);
      googleUrl.searchParams.set('filter', '0');
      if (searchType === 'news') googleUrl.searchParams.set('tbm', 'nws');
      const timeFilters: string[] = [];
      const freshnessFilter = freshness === 'day'
        ? 'qdr:d'
        : freshness === 'week'
          ? 'qdr:w'
          : freshness === 'month'
            ? 'qdr:m'
            : freshness === 'year'
              ? 'qdr:y'
              : '';
      if (freshnessFilter) timeFilters.push(freshnessFilter);
      if (sort === 'date') timeFilters.push('sbd:1');
      if (timeFilters.length) googleUrl.searchParams.set('tbs', timeFilters.join(','));
      targetUrl = googleUrl.toString();
    }

    if (this.interactionInProgress) throw new Error('desktop_search_in_progress');
    this.interactionInProgress = true;
    this.explicitNavigationRequested = true;
    try {
      await this.navigateToUrl(targetUrl);
      await this.ensureReadablePage();

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const state = await this.executeInBrowserWorld<{ ready: boolean; challenge: boolean; resultCount: number }>(`(() => {
          const body = String(document.body?.innerText || '').toLowerCase();
          const challenge = location.pathname.startsWith('/sorry/')
            || Boolean(document.querySelector('#captcha-form, iframe[src*="recaptcha"], [data-sitekey]'))
            || /unusual traffic|verify you are human/.test(body);
          const mode = ${JSON.stringify(mode)};
          const searchType = ${JSON.stringify(searchType)};
          const resultCount = mode === 'wikipedia'
            ? document.querySelectorAll('.mw-search-result-heading a').length
            : document.querySelectorAll(searchType === 'news' ? 'a h3, a [role="heading"][aria-level="3"]' : 'a h3').length;
          return {
            ready: document.readyState === 'complete' || document.readyState === 'interactive',
            challenge,
            resultCount,
          };
        })()`);
        if (state.challenge || (state.ready && state.resultCount > 0)) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }

      return await this.executeInBrowserWorld(`(() => {
        const mode = ${JSON.stringify(mode)};
        const searchType = ${JSON.stringify(searchType)};
        const clean = (value, max = 2000) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max);
        const bodyText = clean(document.body?.innerText || '', 20000).toLowerCase();
        const challenge = location.pathname.startsWith('/sorry/')
          || Boolean(document.querySelector('#captcha-form, iframe[src*="recaptcha"], [data-sitekey]'))
          || /unusual traffic|verify you are human/.test(bodyText);
        const results = [];
        const seen = new Set();
        const snippetSelectors = [
          '.VwiC3b',
          '.IsZvec',
          '.aCOpRe',
          '.yXK7lf',
          '[data-sncf]',
          '[data-content-feature]'
        ];
        const add = (title, url, content = '', engine = mode === 'web' ? 'google' : mode) => {
          title = clean(title, 500);
          content = clean(content, 1500);
          try {
            const parsed = new URL(url, location.href);
            if (!['http:', 'https:'].includes(parsed.protocol)) return;
            if (parsed.hostname.endsWith('google.com') && parsed.pathname === '/url') {
              const redirected = parsed.searchParams.get('q') || parsed.searchParams.get('url');
              if (redirected) url = redirected;
            } else {
              url = parsed.href;
            }
          } catch {
            return;
          }
          if (!title || !url || seen.has(url)) return;
          seen.add(url);
          results.push({ title, content, url, engine, engines: [engine] });
        };
        const extractGoogleSnippet = (heading, anchor) => {
          const roots = [];
          const knownRoot = heading.closest('div.MjjYud, div.g, div[data-snhf]');
          if (knownRoot) roots.push(knownRoot);

          let ancestor = anchor.parentElement;
          for (let depth = 0; ancestor && depth < 8; depth += 1, ancestor = ancestor.parentElement) {
            if (!roots.includes(ancestor)) roots.push(ancestor);
          }

          for (const root of roots) {
            const snippets = [];
            root.querySelectorAll(snippetSelectors.join(',')).forEach((node) => {
              const value = clean(node.innerText || node.textContent || '', 1500);
              if (value && !snippets.includes(value)) snippets.push(value);
            });
            if (snippets.length) return clean(snippets.join(' '), 1500);
          }

          const title = clean(heading.innerText || heading.textContent || '', 500);
          const fallback = roots
            .map((root) => clean(root.innerText || root.textContent || '', 2500))
            .filter((text) => text.length > title.length + 20 && text.length < 2500)
            .sort((left, right) => left.length - right.length)[0] || '';
          return clean(fallback.replace(title, ''), 1500);
        };

        if (mode === 'wikipedia') {
          document.querySelectorAll('.mw-search-result').forEach((item) => {
            const anchor = item.querySelector('.mw-search-result-heading a');
            if (anchor instanceof HTMLAnchorElement) {
              add(anchor.textContent, anchor.href, item.querySelector('.searchresult')?.textContent || '', 'wikipedia');
            }
          });
        } else {
          const weatherCard = searchType === 'web' ? document.querySelector('#wob_wc') : null;
          if (weatherCard) {
            const locationName = clean(weatherCard.querySelector('#wob_loc')?.textContent || '', 200);
            const temperature = clean(weatherCard.querySelector('#wob_tm')?.textContent || '', 50);
            const temperatureUnit = Array.from(weatherCard.querySelectorAll('.wob-unit .wob_t, [aria-label*="Celsius"], [aria-label*="Fahrenheit"]'))
              .map((node) => ({ node, value: clean(node.textContent || '', 20) }))
              .find(({ node, value }) => value && getComputedStyle(node).display !== 'none')?.value || '';
            const condition = clean(weatherCard.querySelector('#wob_dc')?.textContent || '', 200);
            const observedAt = clean(weatherCard.querySelector('#wob_dts')?.textContent || '', 200);
            const precipitation = clean(weatherCard.querySelector('#wob_pp')?.textContent || '', 100);
            const humidity = clean(weatherCard.querySelector('#wob_hm')?.textContent || '', 100);
            const wind = clean(weatherCard.querySelector('#wob_ws')?.textContent || '', 100);
            const details = [
              temperature && ('Temperature: ' + temperature + (temperatureUnit ? ' ' + temperatureUnit : '')),
              condition && ('Conditions: ' + condition),
              observedAt && ('Observed: ' + observedAt),
              precipitation && ('Precipitation: ' + precipitation),
              humidity && ('Humidity: ' + humidity),
              wind && ('Wind: ' + wind)
            ].filter(Boolean).join('. ');
            if (temperature || condition) {
              add(locationName ? ('Weather in ' + locationName) : 'Weather', location.href, details, 'google');
            }
          }

          const resultSelector = searchType === 'news' ? 'a h3, a [role="heading"][aria-level="3"]' : 'a h3';
          document.querySelectorAll(resultSelector).forEach((heading) => {
            const anchor = heading.closest('a');
            if (!(anchor instanceof HTMLAnchorElement)) return;
            const title = clean(heading.textContent || '', 500);
            add(title, anchor.href, extractGoogleSnippet(heading, anchor), searchType === 'news' ? 'google-news' : 'google');
          });
        }

        return {
          mode,
          searchType,
          sort: ${JSON.stringify(sort)},
          freshness: ${JSON.stringify(freshness)},
          page: ${page},
          url: location.href,
          title: document.title,
          challenge: challenge ? 'captcha' : null,
          results: results.slice(0, 20),
        };
      })()`);
    } finally {
      this.interactionInProgress = false;
    }
  }

  async googleAi(payload: GoogleAiPayload): Promise<unknown> {
    const action = payload?.action === 'new_chat' || payload?.action === 'reload' ? payload.action : 'ask';
    const message = `${payload?.message || ''}`.trim();
    const normalizedMessage = message.replace(/\s+/g, ' ').trim();
    if ((action === 'ask' || (action === 'new_chat' && message)) && (!message || message.length > 8_000)) {
      throw new Error(message ? 'google_ai_message_too_long' : 'google_ai_message_required');
    }
    // Reload/new_chat are recovery actions: they must be able to interrupt a
    // request which is stuck waiting for Google instead of being rejected by it.
    if ((action === 'reload' || action === 'new_chat') && this.googleAiInProgress) {
      this.cancelGoogleAi();
    }
    if (this.googleAiInProgress) throw new Error('google_ai_in_progress');

    const contents = this.view.webContents;
    const runId = ++this.googleAiRunId;
    const assertActive = () => {
      if (runId !== this.googleAiRunId) throw new Error('google_ai_cancelled');
    };
    this.googleAiInProgress = true;
    this.explicitNavigationRequested = true;
    try {
      const currentUrl = contents.getURL();
      let onAiMode = false;
      try {
        const parsed = new URL(currentUrl);
        onAiMode = parsed.hostname.endsWith('google.com')
          && (parsed.pathname === '/ai' || parsed.searchParams.get('udm') === '50');
      } catch {
        onAiMode = false;
      }

      if (action === 'new_chat' || !onAiMode) {
        await this.navigateToUrl('https://www.google.com/ai');
        await this.ensureReadablePage();
        assertActive();
      } else if (action === 'reload') {
        contents.reload();
        await this.ensureReadablePage();
        assertActive();
      }

      if (action === 'reload') {
        return { status: 'reloaded', url: contents.getURL(), title: contents.getTitle() };
      }
      type AiSnapshot = {
        challenge: boolean;
        inputAvailable: boolean;
        busy: boolean;
        text: string;
        blocks: string[];
        sources: Array<{ title: string; url: string }>;
        url: string;
        title: string;
      };
      const readSnapshot = () => this.executeInBrowserWorld<AiSnapshot>(`(() => {
        const clean = (value, max = 30000) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max);
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 20 && rect.height > 10;
        };
        const editable = Array.from(document.querySelectorAll('textarea, input[type="text"], input[type="search"], [contenteditable="true"]'))
          .filter(visible);
        const main = document.querySelector('main') || document.body;
        const bodyText = clean(document.body?.innerText || '', 30000).toLowerCase();
        const challenge = location.pathname.startsWith('/sorry/')
          || Boolean(document.querySelector('#captcha-form, iframe[src*="recaptcha"], [data-sitekey]'))
          || /unusual traffic|verify you are human/.test(bodyText);
        const blocks = [];
        main?.querySelectorAll('p, li, h1, h2, h3, [role="heading"]').forEach((node) => {
          const value = clean(node.innerText || node.textContent || '', 3000);
          if (value && !blocks.includes(value)) blocks.push(value);
        });
        const sources = [];
        const seenSources = new Set();
        document.querySelectorAll('a[href]').forEach((anchor) => {
          try {
            let url = new URL(anchor.href, location.href);
            if (url.hostname.endsWith('google.com') && url.pathname === '/url') {
              const redirected = url.searchParams.get('q') || url.searchParams.get('url');
              if (redirected) url = new URL(redirected);
            }
            const googleHost = /(^|\.)google\.[a-z.]+$/i.test(url.hostname);
            const googleSourceRedirect = googleHost
              && (url.pathname === '/goto' || url.pathname.includes('/grounding-api-redirect/'));
            if (
              !['http:', 'https:'].includes(url.protocol)
              || (googleHost && !googleSourceRedirect)
            ) return;
            if (seenSources.has(url.href)) return;
            seenSources.add(url.href);
            sources.push({ title: clean(anchor.innerText || anchor.textContent || url.hostname, 300), url: url.href });
          } catch {
            // Ignore malformed and internal links.
          }
        });
        return {
          challenge,
          inputAvailable: editable.length > 0,
          busy: Array.from(document.querySelectorAll('[aria-busy="true"], [data-loading="true"], [role="progressbar"], mat-progress-spinner'))
            .some(visible)
            || Array.from(document.querySelectorAll('button')).some((button) => {
              const hint = String(button.getAttribute('aria-label') || '') + ' '
                + String(button.getAttribute('title') || '') + ' ' + String(button.textContent || '');
              return visible(button)
                && /(?:^|\s)stop(?:\s+(?:generating|response))?(?:\s|$)|остановить(?:\s+(?:генерацию|ответ))?/i.test(hint.trim());
            }),
          text: clean(main?.innerText || main?.textContent || '', 30000),
          blocks: blocks.slice(-200),
          sources: sources.slice(-20),
          url: location.href,
          title: document.title
        };
      })()`);

      let baseline: AiSnapshot | null = null;
      let stableInputSamples = 0;
      let previousReadyText = '';
      let previousReadyUrl = '';
      for (let attempt = 0; attempt < 60; attempt += 1) {
        assertActive();
        baseline = await readSnapshot();
        if (baseline.challenge) return { challenge: 'captcha', url: baseline.url, title: baseline.title };
        if (baseline.inputAvailable) {
          if (action !== 'new_chat') break;
          if (baseline.text === previousReadyText && baseline.url === previousReadyUrl) {
            stableInputSamples += 1;
          } else {
            stableInputSamples = 1;
            previousReadyText = baseline.text;
            previousReadyUrl = baseline.url;
          }
          // Google hydrates /ai after dom-ready and can replace the composer.
          // Wait until the new composer has survived several observations.
          if (stableInputSamples >= 3) break;
        } else {
          stableInputSamples = 0;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!baseline?.inputAvailable) throw new Error('google_ai_input_not_found');
      if (action === 'new_chat' && stableInputSamples < 3) throw new Error('google_ai_input_not_found');
      if (action === 'new_chat' && !message) {
        return { status: 'new_chat_started', url: contents.getURL(), title: contents.getTitle() };
      }

      const filled = await this.executeInBrowserWorld<boolean>(`(() => {
        const message = ${JSON.stringify(message)};
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 20 && rect.height > 10;
        };
        const candidates = Array.from(document.querySelectorAll('textarea, input[type="text"], input[type="search"], [contenteditable="true"]'))
          .filter(visible)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const hint = String(element.getAttribute('placeholder') || '') + ' ' + String(element.getAttribute('aria-label') || '');
            const semantic = /ask|anything|follow|question|спрос|задайте|вопрос|что угодно/i.test(hint) ? 1000 : 0;
            const kind = element instanceof HTMLTextAreaElement ? 200 : element.isContentEditable ? 100 : 0;
            return { element, score: semantic + kind + rect.top + rect.width / 10 };
          })
          .sort((left, right) => right.score - left.score);
        const element = candidates[0]?.element;
        if (!(element instanceof HTMLElement)) return false;
        element.focus();
        if (element.isContentEditable) {
          element.textContent = message;
          element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
        } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          setter?.call(element, message);
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          return false;
        }
        return true;
      })()`);
      if (!filled) throw new Error('google_ai_input_not_found');

      contents.focus();
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

      // Google can replace the composer between filling it and pressing Enter.
      // Confirm submission against the current composer, not document.activeElement:
      // focus often moves to body even when nothing was actually submitted.
      let submission: {
        inputCleared: boolean;
        submitClicked: boolean;
        busy: boolean;
        inputAvailable: boolean;
      } = { inputCleared: false, submitClicked: false, busy: false, inputAvailable: true };
      for (let submitAttempt = 0; submitAttempt < 4; submitAttempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 700));
        assertActive();
        submission = await this.executeInBrowserWorld<{
          inputCleared: boolean;
          submitClicked: boolean;
          busy: boolean;
          inputAvailable: boolean;
        }>(`(() => {
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 10 && rect.height > 10;
        };
        const candidates = Array.from(document.querySelectorAll('textarea, input[type="text"], input[type="search"], [contenteditable="true"]'))
          .filter(visible)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const hint = String(element.getAttribute('placeholder') || '') + ' ' + String(element.getAttribute('aria-label') || '');
            const semantic = /ask|anything|follow|question|спрос|задайте|вопрос|что угодно/i.test(hint) ? 1000 : 0;
            const kind = element instanceof HTMLTextAreaElement ? 200 : element.isContentEditable ? 100 : 0;
            return { element, score: semantic + kind + rect.top + rect.width / 10 };
          })
          .sort((left, right) => right.score - left.score);
        const editable = candidates[0]?.element instanceof HTMLElement ? candidates[0].element : null;
        const value = editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement
          ? editable.value
          : editable?.textContent || '';
        const busy = Boolean(document.querySelector('[aria-busy="true"], [data-loading="true"]'))
          || Array.from(document.querySelectorAll('button')).some((button) => {
            const hint = String(button.getAttribute('aria-label') || '') + ' '
              + String(button.getAttribute('title') || '') + ' ' + String(button.textContent || '');
            return visible(button)
              && /(?:^|\\s)stop(?:\\s+(?:generating|response))?(?:\\s|$)|остановить(?:\\s+(?:генерацию|ответ))?/i.test(hint.trim());
          });
        let submitClicked = false;
        if (${submitAttempt === 0 || submitAttempt === 2} && value.trim() && !busy && editable) {
          const formButton = editable?.closest('form')?.querySelector('button[type="submit"]');
          const semanticButton = Array.from(document.querySelectorAll('button')).find((button) => {
            const hint = String(button.getAttribute('aria-label') || '') + ' '
              + String(button.getAttribute('title') || '') + ' ' + String(button.textContent || '');
            return visible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true'
              && /send|submit|search|отправ|поиск/i.test(hint);
          });
          const button = visible(formButton) ? formButton : semanticButton;
          if (button instanceof HTMLElement) {
            button.click();
            submitClicked = true;
          }
        }
        editable?.focus();
        return {
          inputCleared: Boolean(editable) && !value.trim(),
          submitClicked,
          busy,
          inputAvailable: Boolean(editable)
        };
      })()`);

        if (submission.inputCleared || submission.busy) break;
        if (submission.submitClicked) continue;
        if (!submission.inputAvailable) break;
        if (submitAttempt >= 3) break;

        // Retry through native input. This updates Google's controlled editor more
        // reliably than assigning DOM values after a hydration/re-render race.
        contents.focus();
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
        contents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
        contents.insertText(message);
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        contents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      }
      console.log('[google-ai] submission', {
        action,
        messageLength: message.length,
        inputCleared: submission.inputCleared,
        submitClicked: submission.submitClicked,
        busy: submission.busy,
        url: contents.getURL(),
      });
      if (!submission.inputCleared && !submission.busy) {
        throw new Error('google_ai_submit_failed');
      }

      const baselineBlocks = new Set(baseline.blocks);
      let latest = baseline;
      let previousText = baseline.text;
      let stableSamples = 0;
      let stableTextSamples = 0;
      let answerObserved = false;
      for (let attempt = 0; attempt < 180; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
        assertActive();
        latest = await readSnapshot();
        if (latest.challenge) return { challenge: 'captcha', url: latest.url, title: latest.title };
        const newBlocks = latest.blocks.filter(block => !baselineBlocks.has(block) && block !== normalizedMessage);
        answerObserved ||= newBlocks.length > 0 || (latest.text !== baseline.text && attempt >= 8);
        stableSamples = answerObserved && latest.text === previousText && !latest.busy ? stableSamples + 1 : 0;
        stableTextSamples = answerObserved && latest.text === previousText ? stableTextSamples + 1 : 0;
        previousText = latest.text;
        // Google occasionally leaves an accessibility loading marker behind.
        // A stable response for six seconds is therefore also a valid finish.
        if (stableSamples >= 6 || stableTextSamples >= 12) break;
      }
      if (!answerObserved) {
        console.warn('[google-ai] response timeout', {
          action,
          messageLength: message.length,
          baselineTextLength: baseline.text.length,
          latestTextLength: latest.text.length,
          baselineBlockCount: baseline.blocks.length,
          latestBlockCount: latest.blocks.length,
          busy: latest.busy,
          url: latest.url,
        });
        throw new Error('google_ai_response_timeout');
      }

      const newBlocks = latest.blocks.filter(block => !baselineBlocks.has(block) && block !== normalizedMessage);
      const blockAnswer = newBlocks.join('\n').trim();
      let addedText = '';
      const baselineOffset = latest.text.indexOf(baseline.text);
      if (baselineOffset >= 0) {
        addedText = `${latest.text.slice(0, baselineOffset)} ${latest.text.slice(baselineOffset + baseline.text.length)}`.trim();
      } else {
        let commonPrefixLength = 0;
        const maxPrefixLength = Math.min(baseline.text.length, latest.text.length);
        while (
          commonPrefixLength < maxPrefixLength
          && baseline.text[commonPrefixLength] === latest.text[commonPrefixLength]
        ) commonPrefixLength += 1;
        addedText = latest.text.slice(commonPrefixLength).trim();
      }
      const promptOffset = addedText.indexOf(normalizedMessage);
      if (promptOffset >= 0) {
        addedText = `${addedText.slice(0, promptOffset)} ${addedText.slice(promptOffset + normalizedMessage.length)}`.trim();
      }
      // Google AI frequently renders prose in plain nested divs while headings
      // remain semantic h-elements. In that layout blockAnswer is only an
      // outline, so prefer the complete text delta when it contains more data.
      const answer = addedText.length > blockAnswer.length ? addedText : blockAnswer;
      let sources = latest.sources;
      const resolvedSources = await this.resolveGoogleAiSources(sources);
      return {
        status: 'success',
        action,
        answer: answer.slice(0, 24_000),
        // Include the currently visible session sources, not only links added
        // during this turn. Follow-up questions may explicitly refer to an
        // earlier answer and its citations.
        sources: resolvedSources,
        url: latest.url,
        title: latest.title,
      };
    } finally {
      if (runId === this.googleAiRunId) this.googleAiInProgress = false;
    }
  }

  cancelGoogleAi(): { cancelled: boolean } {
    const cancelled = this.googleAiInProgress;
    this.googleAiRunId += 1;
    this.googleAiInProgress = false;
    return { cancelled };
  }

  private async resolveGoogleAiSources(
    sources: Array<{ title: string; url: string }>,
  ): Promise<Array<{ title: string; url: string; domain: string }>> {
    const resolveSource = async (source: { title: string; url: string }) => {
      let resolvedUrl = source.url;
      try {
        const parsed = new URL(source.url);
        const googleHost = /(^|\.)google\.[a-z.]+$/i.test(parsed.hostname);
        const isGoogleSourceRedirect = googleHost
          && (parsed.pathname === '/goto' || parsed.pathname.includes('/grounding-api-redirect/'));
        if (isGoogleSourceRedirect) {
          const response = await this.view.webContents.session.fetch(source.url, {
            redirect: 'follow',
            signal: AbortSignal.timeout(6_000),
          });
          if (isAllowedRemoteUrl(response.url)) resolvedUrl = response.url;
          await response.body?.cancel().catch(() => undefined);
        }
      } catch {
        // The Google redirect itself remains a usable source link.
      }
      let domain = '';
      try {
        domain = new URL(resolvedUrl).hostname.replace(/^www\./i, '');
      } catch {
        // URL was already validated while reading the page.
      }
      return { title: source.title || domain, url: resolvedUrl, domain };
    };

    const resolved: Array<{ title: string; url: string; domain: string }> = [];
    for (let offset = 0; offset < sources.length; offset += 4) {
      resolved.push(...await Promise.all(sources.slice(offset, offset + 4).map(resolveSource)));
    }
    const seen = new Set<string>();
    return resolved.filter((source) => {
      if (!source.url || seen.has(source.url)) return false;
      seen.add(source.url);
      return true;
    });
  }

  private async controlYouTubeMusic(payload: BrowserControlPayload): Promise<unknown> {
    const musicAction = payload.music_action;
    const supportedActions = new Set([
      'search_and_play', 'play', 'pause', 'toggle_play_pause',
      'next', 'previous', 'set_volume', 'mute', 'unmute', 'get_state', 'show',
    ]);
    if (!musicAction || !supportedActions.has(musicAction)) {
      throw new Error('youtube_music_action_required');
    }

    if (this.interactionInProgress) this.abortInteraction();
    this.interactionInProgress = true;
    this.explicitNavigationRequested = true;
    try {
      const initialNavigation = this.initialNavigationPromise;
      if (initialNavigation) {
        this.view.webContents.stop();
        await initialNavigation;
      }

      if (musicAction === 'search_and_play') {
        const query = `${payload.query || ''}`.trim();
        if (!query) throw new Error('youtube_music_query_required');
        await this.navigateToUrl(`${YOUTUBE_MUSIC_ORIGIN}/search?q=${encodeURIComponent(query)}`);
        await this.ensureReadablePage();
        const before = await this.readYouTubeMusicState();

        const selected = await this.waitForYouTubeMusicResult(15_000);
        if (!selected) {
          const currentUrl = this.view.webContents.getURL();
          if (/accounts\.google\.com|consent\.youtube\.com/i.test(currentUrl)) {
            throw new Error('youtube_music_authentication_required');
          }
          throw new Error('youtube_music_no_results');
        }

        await this.waitForYouTubeMusicPlaybackChange(before, 8_000);
        return {
          status: 'success',
          action: musicAction,
          query,
          selected,
          ...(await this.readYouTubeMusicState()),
        };
      }

      if (musicAction === 'show') {
        if (!this.isYouTubeMusicPage()) {
          await this.navigateToUrl(YOUTUBE_MUSIC_ORIGIN);
          await this.ensureReadablePage();
        }
        return { status: 'success', action: musicAction, ...(await this.readYouTubeMusicState()) };
      }

      if (!this.isYouTubeMusicPage()) {
        throw new Error('youtube_music_not_open');
      }
      if (musicAction === 'get_state') {
        return { status: 'success', action: musicAction, ...(await this.readYouTubeMusicState()) };
      }

      if (musicAction === 'set_volume' || musicAction === 'mute' || musicAction === 'unmute') {
        const volume = Number(payload.volume);
        if (musicAction === 'set_volume' && (!Number.isFinite(volume) || volume < 0 || volume > 100)) {
          throw new Error('youtube_music_volume_out_of_range');
        }
        const changed = await this.executeInBrowserWorld<boolean>(`(() => {
          const media = document.querySelector('video, audio');
          if (!(media instanceof HTMLMediaElement)) return false;
          const action = ${JSON.stringify(musicAction)};
          if (action === 'set_volume') {
            media.volume = ${JSON.stringify(Number.isFinite(volume) ? volume / 100 : 0)};
            if (media.volume > 0) media.muted = false;
          } else {
            media.muted = action === 'mute';
          }
          return true;
        })()`);
        if (!changed) throw new Error('youtube_music_control_unavailable');
        await new Promise(resolve => setTimeout(resolve, 100));
        return { status: 'success', action: musicAction, ...(await this.readYouTubeMusicState()) };
      }

      const result = await this.executeInBrowserWorld<{ clicked: boolean; already?: boolean; playback_state?: string }>(`(() => {
        const action = ${JSON.stringify(musicAction)};
        const playbackState = navigator.mediaSession?.playbackState || 'none';
        const playerBar = document.querySelector('ytmusic-player-bar');
        if (!playerBar) return { clicked: false, playback_state: playbackState };
        if (action === 'play' && playbackState === 'playing') return { clicked: false, already: true, playback_state: playbackState };
        if (action === 'pause' && playbackState === 'paused') return { clicked: false, already: true, playback_state: playbackState };
        if (action === 'pause' && playbackState === 'none') return { clicked: false, playback_state: playbackState };

        const selector = action === 'next'
          ? '.next-button'
          : action === 'previous'
            ? '.previous-button'
            : '.play-pause-button';
        const button = playerBar.querySelector(selector);
        if (!(button instanceof HTMLElement)) return { clicked: false, playback_state: playbackState };
        button.click();
        return { clicked: true, playback_state: playbackState };
      })()`);
      if (!result.clicked && !result.already) throw new Error('youtube_music_control_unavailable');
      await new Promise(resolve => setTimeout(resolve, 350));
      return { status: 'success', action: musicAction, ...result, ...(await this.readYouTubeMusicState()) };
    } finally {
      this.interactionInProgress = false;
    }
  }

  private isYouTubeMusicPage(): boolean {
    try {
      return new URL(this.view.webContents.getURL()).origin === YOUTUBE_MUSIC_ORIGIN;
    } catch {
      return false;
    }
  }

  private async readYouTubeMusicState(): Promise<{
    url: string;
    track: string | null;
    artist: string | null;
    album: string | null;
    artwork_url: string | null;
    playback_state: string;
    volume_percent: number | null;
    muted: boolean | null;
  }> {
    const url = this.view.webContents.getURL();
    if (!this.isYouTubeMusicPage()) {
      return { url, track: null, artist: null, album: null, artwork_url: null, playback_state: 'none', volume_percent: null, muted: null };
    }
    return this.executeInBrowserWorld(`(() => {
      const metadata = navigator.mediaSession?.metadata;
      const playerBar = document.querySelector('ytmusic-player-bar');
      const text = (selector) => playerBar?.querySelector(selector)?.textContent?.trim() || null;
      const artwork = metadata?.artwork;
      const media = document.querySelector('video, audio');
      return {
        url: location.href,
        track: metadata?.title || text('.title'),
        artist: metadata?.artist || text('.byline'),
        album: metadata?.album || null,
        artwork_url: Array.isArray(artwork) && artwork.length ? artwork[artwork.length - 1]?.src || null : null,
        playback_state: navigator.mediaSession?.playbackState || 'none',
        volume_percent: media instanceof HTMLMediaElement ? Math.round(media.volume * 100) : null,
        muted: media instanceof HTMLMediaElement ? media.muted : null,
      };
    })()`);
  }

  private async waitForYouTubeMusicResult(timeoutMs: number): Promise<{ title: string; url: string } | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.isYouTubeMusicPage()) return null;
      const selected = await this.executeInBrowserWorld<{ title: string; url: string } | null>(`(() => {
        const anchors = Array.from(document.querySelectorAll('a[href*="watch?v="]'));
        const candidate = anchors.find((node) => {
          if (!(node instanceof HTMLAnchorElement) || node.closest('ytmusic-player-bar')) return false;
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        if (!(candidate instanceof HTMLAnchorElement)) return null;
        const title = candidate.getAttribute('title')
          || candidate.textContent?.trim()
          || candidate.closest('ytmusic-responsive-list-item-renderer')?.querySelector('.title')?.textContent?.trim()
          || 'First result';
        const url = candidate.href;
        candidate.click();
        return { title, url };
      })()`).catch(() => null);
      if (selected) return selected;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    return null;
  }

  private async waitForYouTubeMusicPlaybackChange(
    before: { url: string; track: string | null; playback_state: string },
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      const current = await this.readYouTubeMusicState().catch(() => null);
      if (!current) continue;
      if (current.url !== before.url || current.track !== before.track || current.playback_state === 'playing') return;
    }
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
    this.host.webContents.send(this.stateChannel, this.getState());
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
        contents.removeListener('will-prevent-unload', onWillPreventUnload);
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
      const onWillPreventUnload = (event: Electron.Event) => {
        // An explicit browser-tool navigation is already a decision to leave the
        // current page. Media sites may otherwise cancel loadURL via beforeunload.
        event.preventDefault();
      };

      contents.on('did-start-navigation', onDidStartNavigation);
      contents.on('did-navigate', onDidNavigate);
      contents.on('did-navigate-in-page', onDidNavigateInPage);
      contents.on('did-fail-load', onDidFailLoad);
      contents.on('will-prevent-unload', onWillPreventUnload);
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
      await this.navigateToUrl(this.homeUrl);
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
          // Root scrolling elements can legitimately have a zero layout height
          // while their document paints far beyond it (YouTube does this).
          // The viewport check handles the root clip separately.
          if (ancestor === document.body || ancestor === document.documentElement) {
            ancestor = getComposedParent(ancestor);
            continue;
          }
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
    const urlBeforeClick = contents.getURL();
    if (expected.tag === 'a' && expected.href) {
      try {
        const parsed = new URL(expected.href);
        if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.toString() !== urlBeforeClick) {
          await contents.loadURL(parsed.toString());
          this.interactionInProgress = false;
          return {
            status: 'success',
            action: 'click',
            element: expected,
            ...this.getState(),
          };
        }
      } catch {
        // Non-navigation anchors still use the native pointer path below.
      }
    }

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
