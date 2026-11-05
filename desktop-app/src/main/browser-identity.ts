import { BrowserWindow, type Session, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function detectReportedChromeVersion(): { major: string; full: string } {
  const engine = String(process.versions?.chrome || '');
  const match = engine.match(/^(\d+)(?:\.\d+)*$/);
  if (match) return { major: match[1]!, full: engine };
  // Static fallback (Electron 33's Chromium) for hosts without versions.chrome.
  return { major: '130', full: '130.0.6723.191' };
}

const reportedChromeVersion = detectReportedChromeVersion();

/**
 * Chrome version the embedded browser reports as its own: derived from the
 * real engine (process.versions.chrome), so the UA string, client hints and
 * the actual feature set always agree — and the identity follows Electron
 * upgrades for free. The reduced UA uses the major only (Chrome/<major>.0.0.0).
 */
export const REPORTED_CHROME_MAJOR: string = reportedChromeVersion.major;
/** Full engine build for high-entropy client hints (the reduced UA zeroes it out). */
export const REPORTED_CHROME_FULL_VERSION: string = reportedChromeVersion.full;

export type UaBrand = { brand: string; version: string };

export type UserAgentMetadata = {
  brands: UaBrand[];
  fullVersionList: UaBrand[];
  fullVersion: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
  bitness: string;
  wow64: boolean;
};

export type BrowserIdentity = {
  userAgent: string;
  acceptLanguage: string;
  /** Human-readable OS name reported by client hints (e.g. "Windows"). */
  platform: string;
  /** Value reported by navigator.platform (e.g. "Win32"). */
  navigatorPlatform: string;
  metadata: UserAgentMetadata;
};

function detectPlatformInfo(): {
  platform: string;
  navigatorPlatform: string;
  platformVersion: string;
  architecture: string;
  bitness: string;
} {
  if (process.platform === 'win32') {
    // UA-CH maps Windows builds onto a synthetic platformVersion scale:
    // 13.x = Win11 21H2/22H2, 14.x = 23H2, 15.x = 24H2+; Win10 stays at 10.x.
    let platformVersion = '15.0.0';
    try {
      const build = Number((process.getSystemVersion() || '').split('.').pop());
      if (Number.isFinite(build) && build < 22000) platformVersion = '10.0.0';
      else if (Number.isFinite(build) && build < 22621) platformVersion = '13.0.0';
      else if (Number.isFinite(build) && build < 26100) platformVersion = '14.0.0';
    } catch {
      // Keep the default when the system version is unavailable.
    }
    return {
      platform: 'Windows',
      navigatorPlatform: 'Win32',
      platformVersion,
      architecture: process.arch === 'arm64' ? 'arm' : 'x86',
      bitness: '64',
    };
  }
  if (process.platform === 'darwin') {
    let platformVersion = '14.5.0';
    try {
      platformVersion = process.getSystemVersion() || platformVersion;
    } catch {
      // Keep the default when the system version is unavailable.
    }
    return {
      platform: 'macOS',
      navigatorPlatform: 'MacIntel',
      platformVersion,
      architecture: process.arch === 'arm64' ? 'arm' : 'x86',
      bitness: '64',
    };
  }
  return {
    platform: 'Linux',
    navigatorPlatform: 'Linux x86_64',
    platformVersion: '',
    architecture: process.arch === 'arm64' ? 'arm' : 'x86',
    bitness: '64',
  };
}

/**
 * Builds a consistent Chrome browser identity from the real Electron UA:
 * - rebuilds the UA string in genuine Chrome form: whatever product tokens
 *   Electron injects (Electron/33.4.11, chatter-desktop/2.0.0, …), only the
 *   authentic platform section survives, so the UA can never leak the app;
 * - reports the actual Chromium version in reduced-UA form;
 * - derives userAgentMetadata so Sec-CH-UA headers and navigator.userAgentData
 *   use Chromium fallback metadata; applyBrowserIdentity replaces it with
 *   the engine's native client hints before loading remote content.
 * The real OS section of the UA is preserved: fonts, WebGL and other
 * platform fingerprints must stay consistent with the claimed platform.
 */
export function buildBrowserIdentity(defaultUA: string, acceptLanguage = 'en-US'): BrowserIdentity {
  // The platform section must stay authentic (real OS, real CPU arc), so it
  // is lifted verbatim from the default UA instead of being guessed.
  const platformSection = String(defaultUA || '').match(/Mozilla\/5\.0\s*\(([^)]+)\)/i)?.[1]?.trim()
    || (process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
      : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
      : 'X11; Linux x86_64');
  // Modern Chrome reports the reduced UA (major-only, zeroed minor/build/patch)
  // while the full version lives in client hints.
  const userAgent = `Mozilla/5.0 (${platformSection}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${REPORTED_CHROME_MAJOR}.0.0.0 Safari/537.36`;
  const { platform, navigatorPlatform, platformVersion, architecture, bitness } = detectPlatformInfo();
  const metadata: UserAgentMetadata = {
    brands: [
      { brand: 'Not.A/Brand', version: '99' },
      { brand: 'Chromium', version: REPORTED_CHROME_MAJOR },
    ],
    fullVersionList: [
      { brand: 'Not.A/Brand', version: '99' },
      { brand: 'Chromium', version: REPORTED_CHROME_FULL_VERSION },
    ],
    fullVersion: REPORTED_CHROME_FULL_VERSION,
    platform,
    platformVersion,
    architecture,
    model: '',
    mobile: false,
    bitness,
    wow64: false,
  };
  return { userAgent, acceptLanguage, platform, navigatorPlatform, metadata };
}

/**
 * Runs in the main world of every new document before any page script.
 * It only fills gaps where Electron differs from real Chrome:
 * - `window.chrome` is absent in Electron but present in every Chrome;
 * - `Notification.permission` reports "denied" because Chatter denies all
 *   permission requests, while typical users sit on "default";
 * - `permissions.query({name:'notifications'})` must agree with the above.
 */
export const IDENTITY_INIT_SCRIPT_SOURCE = `(() => {
  try {
    if (typeof window.chrome === 'undefined') {
      const chromeShim = {
        app: {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
          getDetails: function () { return null; },
          getIsInstalled: function () { return false; },
          installState: function (callback) { if (typeof callback === 'function') callback('not_installed'); }
        },
        runtime: {
          OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', INSTALL_MODULE: 'install_module', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
          OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', RUNTIME_RESTART: 'runtime_restart' },
          PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
          PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
          PlatformOS: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
          RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
          connect: function () { return undefined; },
          sendMessage: function () { return undefined; }
        }
      };
      Object.defineProperty(window, 'chrome', { value: chromeShim, writable: false, enumerable: true, configurable: false });
    }
  } catch (error) { /* page context quirks must never break navigation */ }
  try {
    if (typeof Notification !== 'undefined') {
      Object.defineProperty(Notification, 'permission', { get: function () { return 'default'; }, configurable: true });
    }
  } catch (error) { /* Notification may be read-only in this context */ }
  try {
    if (typeof Permissions !== 'undefined' && typeof Permissions.prototype.query === 'function') {
      const nativeQuery = Permissions.prototype.query;
      Permissions.prototype.query = function (description) {
        return nativeQuery.call(this, description).then(function (status) {
          if (description && String(description.name || '').toLowerCase() === 'notifications' && status && status.state === 'denied') {
            try { Object.defineProperty(status, 'state', { get: function () { return 'prompt'; }, configurable: true }); } catch (error) { /* keep the raw state */ }
          }
          return status;
        });
      };
    }
  } catch (error) { /* keep the native implementation */ }
})();`;

/**
 * Canonical Sec-CH-UA* header values derived from the identity, keyed by the
 * lower-cased header name. Used to rewrite outgoing requests as a safety net
 * for contexts the page-level CDP override cannot reach (Service Workers and
 * Shared Workers live in browser-level targets).
 */
export function clientHintHeaders(identity: BrowserIdentity): Record<string, string> {
  const brands = identity.metadata.brands.map((brand) => `"${brand.brand}";v="${brand.version}"`).join(', ');
  const fullBrands = identity.metadata.fullVersionList.map((brand) => `"${brand.brand}";v="${brand.version}"`).join(', ');
  return {
    'sec-ch-ua': brands,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${identity.metadata.platform}"`,
    'sec-ch-ua-full-version-list': fullBrands,
    'sec-ch-ua-arch': `"${identity.metadata.architecture}"`,
    'sec-ch-ua-bitness': `"${identity.metadata.bitness}"`,
    'sec-ch-ua-platform-version': identity.metadata.platformVersion ? `"${identity.metadata.platformVersion}"` : '',
    'sec-ch-ua-model': '""',
    'sec-ch-ua-wow64': '?0',
  };
}

/**
 * Rewrites identity-related request headers in place: every Sec-CH-UA* hint
 * becomes the canonical value and a User-Agent still carrying Electron/app
 * tokens is replaced. Returns true when the headers were modified. Pure, so
 * it stays unit-testable without Electron.
 */
export function normalizeIdentityHeaders(requestHeaders: Record<string, string>, identity: BrowserIdentity): boolean {
  const hints = clientHintHeaders(identity);
  let changed = false;
  for (const name of Object.keys(requestHeaders)) {
    const canonical = hints[name.toLowerCase()];
    // Empty canonical values (e.g. platform-version on Linux) are skipped:
    // the platform simply does not send that hint.
    if (canonical !== undefined && canonical !== '' && requestHeaders[name] !== canonical) {
      requestHeaders[name] = canonical;
      changed = true;
    }
  }
  const userAgentKey = Object.keys(requestHeaders).find((name) => name.toLowerCase() === 'user-agent');
  if (userAgentKey && typeof requestHeaders[userAgentKey] === 'string' && /Electron|chatter/i.test(requestHeaders[userAgentKey])) {
    requestHeaders[userAgentKey] = identity.userAgent;
    changed = true;
  }
  return changed;
}

type NativeIdentity = { metadata: UserAgentMetadata; language: string; navigatorPlatform: string };
const nativeIdentities = new WeakMap<Session, Promise<NativeIdentity>>();

function readNativeIdentity(session: Session): Promise<NativeIdentity> {
  const existing = nativeIdentities.get(session);
  if (existing) return existing;
  const pending = (async () => {
    const file = path.join(os.tmpdir(), 'chatter-browser-identity-' + randomUUID() + '.html');
    let probe: BrowserWindow | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // file: is a secure local context with UA-CH, unlike initial about:blank.
      await writeFile(file, `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><title>Browser identity</title>`);
      probe = new BrowserWindow({ show: false, webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      const probeContents = probe.webContents;
      const read = (async () => {
        await probe!.loadFile(file);
        return await probeContents.executeJavaScript(`(async () => {
          if (!navigator.userAgentData) throw new Error('native_user_agent_data_unavailable');
          const data = await navigator.userAgentData.getHighEntropyValues([
            'architecture', 'bitness', 'model', 'platformVersion', 'uaFullVersion', 'wow64', 'fullVersionList'
          ]);
          return {
            language: navigator.language,
            navigatorPlatform: navigator.platform,
            metadata: {
              brands: data.brands, fullVersionList: data.fullVersionList, fullVersion: data.uaFullVersion,
              platform: data.platform, platformVersion: data.platformVersion, architecture: data.architecture,
              model: data.model, mobile: data.mobile, bitness: data.bitness, wow64: data.wow64
            }
          };
      })()`) as NativeIdentity;
      })();
      return await Promise.race([read, new Promise<NativeIdentity>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('native_identity_timeout')), 5000);
      })]);
    } finally {
      if (timeout) clearTimeout(timeout);
      probe?.destroy();
      await unlink(file).catch(() => {});
    }
  })();
  nativeIdentities.set(session, pending);
  void pending.catch(() => { if (nativeIdentities.get(session) === pending) nativeIdentities.delete(session); });
  return pending;
}

export type BrowserIdentityHandle = { dispose: () => void };

const noopIdentityHandle: BrowserIdentityHandle = { dispose: () => {} };

const WORKER_TARGET_TYPES = new Set(['worker', 'shared_worker', 'service_worker']);

/**
 * Applies the browser identity via the Chromium DevTools Protocol:
 * - `Network.setUserAgentOverride` synchronizes the UA string, request
 *   headers (including Sec-CH-UA* client hints) and navigator.userAgentData
 *   in one shot — this is what `session.setUserAgent` alone cannot do;
 * - `Page.addScriptToEvaluateOnNewDocument` installs the JS fingerprint
 *   patch in the main world before any page script runs;
 * - `Target.setAutoAttach` catches related worker targets (workers are
 *   separate CDP targets and would otherwise run with the raw embedder UA,
 *   leaking "Electron" and the app token) and repeats the override inside
 *   reachable workers before their first script runs. Shared Worker JS identity
 *   stays native; pages use the same native metadata and language;
 * - a session-level webRequest pass rewrites Sec-CH-UA* headers on every
 *   request: Service Workers / Shared Workers belong to browser-level
 *   targets the page debugger cannot reach, but their requests still flow
 *   through session.webRequest.
 *
 * The debugger attachment stays alive for the lifetime of the webContents
 * (the isolated-world machinery in browser.ts rides on top of it). On any
 * failure the caller still keeps the session-level UA set earlier, so this
 * degrades gracefully.
 */
export async function applyBrowserIdentity(contents: WebContents, profile: BrowserIdentity): Promise<BrowserIdentityHandle> {
  if (contents.isDestroyed()) return noopIdentityHandle;
  try {
    const native = await readNativeIdentity(contents.session);
    // Shared Workers use the engine's native metadata and primary language.
    // Reuse those values in pages and dedicated workers instead of inventing
    // a Google Chrome brand/language list that Shared Workers cannot inherit.
    profile = { ...profile, metadata: native.metadata, acceptLanguage: native.language,
      platform: native.metadata.platform, navigatorPlatform: native.navigatorPlatform };
  } catch (error) {
    console.warn('[browser-identity] native metadata unavailable:', error);
  }
  if (contents.isDestroyed()) return noopIdentityHandle;
  contents.session.setUserAgent(profile.userAgent, profile.acceptLanguage);
  const debuggerApi = contents.debugger;
  let attachedByUs = false;
  const overrideParams = {
    userAgent: profile.userAgent,
    acceptLanguage: profile.acceptLanguage,
    platform: profile.navigatorPlatform,
    userAgentMetadata: profile.metadata,
  };
  const onDebuggerMessage = (_event: unknown, method: string, params: any, sessionId?: string): void => {
    if (method !== 'Target.attachedToTarget' || !params?.targetInfo) return;
    // Electron delivers the flat session id both as the fourth listener
    // argument and inside params; trust whichever one is present.
    const workerSession: string | undefined = params.sessionId || sessionId;
    if (!workerSession) return;
    let released = false;
    const resume = () => {
      if (released) return;
      released = true;
      void debuggerApi.sendCommand('Runtime.runIfWaitingForDebugger', undefined, workerSession).catch(() => {});
    };
    if (WORKER_TARGET_TYPES.has(String(params.targetInfo.type || ''))) {
      // Workers are separate CDP targets: without this they run with the raw
      // embedder UA (Electron + app tokens) regardless of the page override.
      // A worker paused by waitForDebuggerOnStart must NEVER stay frozen: a
      // hung override command would make every worker read as "unsupported",
      // which is a far louder anomaly than a missed hint override. Hence the
      // watchdog plus the guaranteed release below.
      const watchdog = setTimeout(resume, 1500);
      watchdog.unref?.();
      void debuggerApi.sendCommand('Network.enable', undefined, workerSession)
        .then(() => debuggerApi.sendCommand('Network.setUserAgentOverride', overrideParams, workerSession))
        .catch(() => {
          // Some worker targets expose the Emulation domain instead of
          // Network; it accepts the very same override parameters.
          return debuggerApi.sendCommand('Emulation.setUserAgentOverride', overrideParams, workerSession);
        })
        .catch(() => {})
        .then(() => {
          clearTimeout(watchdog);
          resume();
        });
    } else if (String(params.targetInfo.type || '') === 'iframe') {
      // Cross-site frames have their own renderer/CDP session. Enabling Page
      // there both initializes the paused document and installs the same
      // early script; the top-level override does not cover these renderers.
      const watchdog = setTimeout(resume, 1500);
      watchdog.unref?.();
      void debuggerApi.sendCommand('Emulation.setUserAgentOverride', overrideParams, workerSession)
        .then(() => debuggerApi.sendCommand('Page.enable', undefined, workerSession))
        .then(() => debuggerApi.sendCommand('Page.addScriptToEvaluateOnNewDocument',
          { source: IDENTITY_INIT_SCRIPT_SOURCE }, workerSession))
        .catch((error) => console.warn('[browser-identity] iframe override failed:', error))
        .finally(() => { clearTimeout(watchdog); resume(); });
    } else if (params.waitingForDebugger) {
      resume();
    }
  };
  try {
    // A fresh WebContentsView has no renderer document yet. CDP commands such
    // as Network.enable can wait for that renderer indefinitely while the
    // caller waits for this setup before navigating. Bootstrap a local blank
    // document first; the first remote request still uses the full profile.
    if (!contents.getURL()) await contents.loadURL('about:blank');
    if (contents.isDestroyed()) return noopIdentityHandle;
    if (!debuggerApi.isAttached()) {
      debuggerApi.attach('1.3');
      attachedByUs = true;
    }
    await debuggerApi.sendCommand('Network.enable');
    await debuggerApi.sendCommand('Network.setUserAgentOverride', overrideParams);
    await debuggerApi.sendCommand('Page.enable');
    await debuggerApi.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: IDENTITY_INIT_SCRIPT_SOURCE });
    debuggerApi.on('message', onDebuggerMessage);
    await debuggerApi.sendCommand('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
  } catch (error) {
    console.warn('[browser-identity] CDP override failed; keeping the session-level UA only:', error);
  }
  // Network-layer safety net for workers the page debugger cannot see.
  // Registered per session; sibling browsers on a shared partition register
  // an identical handler, so the last registration is still correct.
  try {
    contents.session.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      if (normalizeIdentityHeaders(details.requestHeaders, profile)) {
        callback({ requestHeaders: details.requestHeaders });
        return;
      }
      callback({});
    });
  } catch (error) {
    // The session may already be torn down; requests then flow untouched.
  }
  return {
    dispose: () => {
      try {
        debuggerApi.removeListener('message', onDebuggerMessage);
      } catch {
        // The webContents is already gone.
      }
      // The session-level header rewrite intentionally stays installed: the
      // session can outlive this view on shared partitions, and sibling
      // browsers re-register an identical handler on construction anyway.
      // The isolated-world owners ride on external attachments and never
      // detach, so detaching here can only race with webContents teardown.
      if (!attachedByUs) return;
      try {
        if (debuggerApi.isAttached()) debuggerApi.detach();
      } catch {
        // The webContents is already gone.
      }
    },
  };
}
