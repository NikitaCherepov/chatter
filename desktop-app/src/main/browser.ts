import { BrowserWindow, WebContentsView, type Rectangle } from 'electron';
import { click as naturalClick, generateTrajectory, pickTargetPoint, scrollWheel, type CancellationToken, type Point } from './cursor-input';

export type BrowserState = {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  visible: boolean;
};

export type BrowserControlPayload = {
  action: 'open' | 'read' | 'back' | 'forward' | 'reload' | 'scroll' | 'click' | 'fill' | 'check_site_permission' | 'grant_site_permission';
  url?: string;
  ref?: string;
  text?: string;
  permission_action?: 'click' | 'fill';
  origin?: string;
  expected_origin?: string;
  mode?: 'viewport' | 'delta' | 'full';
  direction?: 'up' | 'down';
  amount?: number;
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
};

const HOME_URL = 'https://www.google.com/';
const MAX_PAGE_TEXT = 30_000;
const MAX_VIEWPORT_TEXT = 10_000;
const MAX_ELEMENTS = 160;
const MAX_VIEWPORT_ELEMENTS = 80;
const BROWSER_WORLD_ID = 1004;

type BrowserReadSnapshot = {
  url: string;
  text: string;
  elements: BrowserElement[];
  mode: 'viewport' | 'full';
};

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

export class ChatterBrowser {
  private host: BrowserWindow;
  private readonly view: WebContentsView;
  private visible = false;
  private activeLayoutOwner = '';
  private nextLayoutOwnerRank = 0;
  private readonly layoutOwnerRanks = new Map<string, number>();
  private snapshotUrl = '';
  private snapshotElements = new Map<string, BrowserElement>();
  private lastReadSnapshot: BrowserReadSnapshot | null = null;
  private interactionInProgress = false;
  private initialNavigationStarted = false;
  private explicitNavigationRequested = false;
  private readonly sessionClickOrigins = new Set<string>();
  private readonly sessionFillOrigins = new Set<string>();

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

    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedRemoteUrl(url)) void contents.loadURL(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (!isAllowedRemoteUrl(url)) event.preventDefault();
    });
    contents.on('did-start-loading', () => this.emitState());
    contents.on('did-stop-loading', () => this.emitState());
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
      isLoading: !contents.isDestroyed() && contents.isLoading(),
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
      void this.view.webContents.loadURL(HOME_URL).catch((error) => {
        if (error?.code !== 'ERR_ABORTED') console.error('[browser] initial navigation failed:', error);
      }).finally(() => {
        if (!this.view.webContents.isDestroyed() && (!this.view.webContents.getURL() || this.view.webContents.getURL() === 'about:blank')) {
          this.initialNavigationStarted = false;
        }
      });
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
      return {
        allowed: Boolean(origin && this.getPermissionOrigins(permissionAction).has(origin)),
        origin,
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

    if (action === 'open') {
      if (this.interactionInProgress) throw new Error('browser_interaction_in_progress');
      this.interactionInProgress = true;
      this.explicitNavigationRequested = true;
      const url = normalizeBrowserUrl(`${payload.url || ''}`);
      try {
        await contents.loadURL(url);
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
    this.lastReadSnapshot = null;
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

  private executeInBrowserWorld<T = unknown>(code: string): Promise<T> {
    return this.view.webContents.executeJavaScriptInIsolatedWorld(
      BROWSER_WORLD_ID,
      [{ code }],
      true,
    ) as Promise<T>;
  }

  private async ensureReadablePage(): Promise<void> {
    const contents = this.view.webContents;
    if (!contents.getURL() || contents.getURL() === 'about:blank') {
      await contents.loadURL(HOME_URL);
      return;
    }
    if (!contents.isLoading()) return;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(timer);
        contents.removeListener('did-stop-loading', done);
        resolve();
      };
      contents.once('did-stop-loading', done);
      timer = setTimeout(done, 15_000);
    });
  }

  private async readPage(mode: 'viewport' | 'delta' | 'full'): Promise<unknown> {
    await this.ensureReadablePage();
    const documentSeed = `chatter-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const isNearViewport = (element) => {
        const rect = element.getBoundingClientRect();
        const margin = 300;
        return rect.bottom >= -margin && rect.top <= window.innerHeight + margin && rect.right >= -margin && rect.left <= window.innerWidth + margin;
      };
      const viewportText = () => {
        if (!document.body) return '';
        const parts = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const parent = node.parentElement;
          if (!parent || parent.closest('script,style,noscript,template')) continue;
          const value = clean(node.nodeValue || '', 4000);
          if (!value) continue;
          const style = window.getComputedStyle(parent);
          if (style.visibility === 'hidden' || style.display === 'none') continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const intersects = Array.from(range.getClientRects()).some((rect) => rect.bottom >= -100 && rect.top <= window.innerHeight + 100 && rect.right >= 0 && rect.left <= window.innerWidth);
          if (!intersects) continue;
          if (parts[parts.length - 1] !== value) parts.push(value);
          if (parts.join('\\n').length >= maxText) break;
        }
        return parts.join('\\n');
      };

      globalThis.__chatterBrowserDocumentId ||= documentSeed;
      globalThis.__chatterBrowserRefCounter ||= 0;
      globalThis.__chatterBrowserRefByElement ||= new WeakMap();
      globalThis.__chatterBrowserElements = new Map();
      const selectors = 'a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]';
      const candidates = Array.from(document.querySelectorAll(selectors)).filter((element) => isVisible(element) && (mode === 'full' || isNearViewport(element)));
      const elements = candidates.slice(0, maxElements).map((element) => {
        let ref = globalThis.__chatterBrowserRefByElement.get(element);
        if (!ref) {
          globalThis.__chatterBrowserRefCounter += 1;
          ref = globalThis.__chatterBrowserDocumentId + '-' + globalThis.__chatterBrowserRefCounter;
          globalThis.__chatterBrowserRefByElement.set(element, ref);
        }
        globalThis.__chatterBrowserElements.set(ref, element);
        const tag = element.tagName.toLowerCase();
        const inputType = tag === 'input' ? clean(element.getAttribute('type') || 'text', 40).toLowerCase() : undefined;
        const sensitiveHint = [
          inputType,
          element.getAttribute('autocomplete'),
          element.getAttribute('name'),
          element.getAttribute('id'),
          element.getAttribute('aria-label'),
          element.getAttribute('placeholder'),
        ].filter(Boolean).join(' ').toLowerCase();
        const sensitive = inputType === 'password' || /current-password|new-password|one-time-code|\\botp\\b|\\btotp\\b|\\b2fa\\b|verification.?code|auth(?:entication)?.?code|cc-number|cc-csc|cc-exp|credit.?card|card.?number|\\bcvv\\b|\\bcvc\\b|security.?code/.test(sensitiveHint);
        const readableInputTypes = new Set(['text', 'search', 'email', 'url', 'tel']);
        let value;
        if (!sensitive) {
          if (element instanceof HTMLInputElement && readableInputTypes.has(inputType || 'text')) {
            value = clipValue(element.value);
          } else if (element instanceof HTMLTextAreaElement) {
            value = clipValue(element.value);
          } else if (element.isContentEditable) {
            value = clipValue(element.innerText || element.textContent || '');
          }
        }
        return {
          ref,
          tag,
          role: clean(element.getAttribute('role') || '', 60),
          text: clean(element.getAttribute('aria-label') || element.innerText || element.textContent || element.getAttribute('title') || element.getAttribute('name') || '', 500),
          href: tag === 'a' ? clean(element.href || '', 1000) : undefined,
          inputType,
          placeholder: (tag === 'input' || tag === 'textarea') ? clean(element.getAttribute('placeholder') || '', 300) : undefined,
          sensitive,
          value,
        };
      });
      const rawText = mode === 'full' ? String(document.body?.innerText || '') : viewportText();
      return {
        title: clean(document.title, 500),
        url: location.href,
        text: rawText.slice(0, maxText),
        elements,
        truncated: rawText.length > maxText,
        scroll: {
          y: Math.round(window.scrollY),
          viewport_height: Math.round(window.innerHeight),
          document_height: Math.round(document.documentElement?.scrollHeight || document.body?.scrollHeight || 0),
        },
      };
    })()`;

    const result = await this.executeInBrowserWorld<{
      title?: string;
      url?: string;
      text?: string;
      elements?: BrowserElement[];
      truncated?: boolean;
      scroll?: { y: number; viewport_height: number; document_height: number };
    }>(script);

    const url = `${result.url || this.view.webContents.getURL()}`;
    const text = result.text || '';
    const elements = result.elements || [];
    const previous = this.lastReadSnapshot;
    const current: BrowserReadSnapshot = { url, text, elements, mode: effectiveMode };

    this.snapshotUrl = url;
    this.snapshotElements = new Map(elements.map((element) => [element.ref, element]));
    this.lastReadSnapshot = current;

    const common = {
      status: 'success',
      title: result.title || '',
      url,
      scroll: result.scroll,
      truncated: result.truncated === true,
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

  private async clickElement(ref: string): Promise<unknown> {
    if (this.interactionInProgress) throw new Error('browser_interaction_in_progress');
    const expected = this.getSnapshotElement(ref);
    this.interactionInProgress = true;

    const contents = this.view.webContents;

    // -- Phase 1: bring the element into view and read a stable clickable rect --
    const rectScript = `(async () => {
      const element = globalThis.__chatterBrowserElements?.get(${JSON.stringify(ref)});
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
    try {
      rect = await this.executeInBrowserWorld(rectScript);
    } catch (error) {
      this.interactionInProgress = false;
      throw error;
    }

    const viewport = { width: rect.viewportW, height: rect.viewportH };

    // Initialise cursor position if this is the first interaction.
    if (this.cursorPos.x === 0 && this.cursorPos.y === 0) {
      this.cursorPos = { x: viewport.width / 2, y: viewport.height / 2 };
    }

    // -- Phase 2: pick a single target (used by both visual + native) --
    const elementRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    // pickTargetPoint clips to viewport internally, so partially off-screen
    // elements and tiny elements are handled correctly.
    const target = pickTargetPoint(elementRect, viewport);
    const trajectory = generateTrajectory(this.cursorPos, target);

    // -- Phase 3: show visual cursor overlay --
    const showCursorScript = `(() => {
      let cursor = document.getElementById('__chatter-browser-cursor');
      if (!cursor) {
        cursor = document.createElement('div');
        cursor.id = '__chatter-browser-cursor';
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
      const cursor = document.getElementById('__chatter-browser-cursor');
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

    // Highlight element outline — save original values for restoration.
    this.executeInBrowserWorld(`(() => {
      const element = globalThis.__chatterBrowserElements?.get(${JSON.stringify(ref)});
      if (!element) return false;
      globalThis.__chatterBrowserSavedOutline = element.style.outline;
      globalThis.__chatterBrowserSavedOutlineOffset = element.style.outlineOffset;
      element.style.outline = '2px solid rgba(34, 105, 225, .9)';
      element.style.outlineOffset = '3px';
      return true;
    })()`).catch(() => {});

    try {
      // Pass the pre-selected target AND trajectory so visual cursor and
      // native events follow the exact same path and speed.
      const validateTarget = () => this.executeInBrowserWorld<boolean>(`(() => {
        const element = globalThis.__chatterBrowserElements?.get(${JSON.stringify(ref)});
        if (!element || !element.isConnected) return false;
        const hit = document.elementFromPoint(${target.x}, ${target.y});
        return !!hit && (hit === element || element.contains(hit));
      })()`);
      this.cursorPos = await naturalClick(
        contents,
        elementRect,
        this.cursorPos,
        token,
        target,
        trajectory,
        validateTarget,
      );

      // Brief settle, then restore outline + hide cursor.
      await new Promise(resolve => setTimeout(resolve, 200));
      await this.executeInBrowserWorld(`(() => {
        const element = globalThis.__chatterBrowserElements?.get(${JSON.stringify(ref)});
        if (element && element.isConnected) {
          element.style.outline = globalThis.__chatterBrowserSavedOutline || '';
          element.style.outlineOffset = globalThis.__chatterBrowserSavedOutlineOffset || '';
        }
        delete globalThis.__chatterBrowserSavedOutline;
        delete globalThis.__chatterBrowserSavedOutlineOffset;
        const cursor = document.getElementById('__chatter-browser-cursor');
        if (cursor) cursor.style.opacity = '0';
        globalThis.__chatterBrowserCursorPosition = { x: ${target.x}, y: ${target.y} };
        return true;
      })()`).catch(() => {});

      await visualAnimation;

      return { status: 'success', action: 'click', element: expected, ...this.getState() };
    } catch (error) {
      // Clean up: restore outline + hide visual cursor on error / cancellation.
      await this.executeInBrowserWorld(`(() => {
        const element = globalThis.__chatterBrowserElements?.get(${JSON.stringify(ref)});
        if (element && element.isConnected) {
          element.style.outline = globalThis.__chatterBrowserSavedOutline || '';
          element.style.outlineOffset = globalThis.__chatterBrowserSavedOutlineOffset || '';
        }
        delete globalThis.__chatterBrowserSavedOutline;
        delete globalThis.__chatterBrowserSavedOutlineOffset;
        const cursor = document.getElementById('__chatter-browser-cursor');
        if (cursor) cursor.style.opacity = '0';
        return true;
      })()`).catch(() => {});
      throw error;
    } finally {
      this.clickToken = null;
      this.interactionInProgress = false;
    }
  }

  private async fillElement(ref: string, text: string): Promise<unknown> {
    if (this.interactionInProgress) throw new Error('browser_interaction_in_progress');
    const expected = this.getSnapshotElement(ref);
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
      const element = globalThis.__chatterBrowserElements?.get(${JSON.stringify(ref)});
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
      await this.executeInBrowserWorld(script);
      return { status: 'success', action: 'fill', element: expected, characters: text.length, ...this.getState() };
    } finally {
      this.interactionInProgress = false;
    }
  }
}
