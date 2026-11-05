import type { WebContents } from 'electron';

/**
 * Chrome version the embedded browser reports as its own. Electron ships an
 * older Chromium (e.g. 130 while the real stable Chrome is far ahead), and an
 * outdated Chrome/<major> in the UA makes the app look stale to websites.
 * Keep these in sync with the current stable Chrome when bumping the
 * Electron version.
 */
export const REPORTED_CHROME_MAJOR = '152';
/** Plausible full build for high-entropy client hints (the reduced UA zeroes it out). */
export const REPORTED_CHROME_FULL_VERSION = '152.0.8065.128';

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
 * - strips the `Electron/...` and `chatter/...` tokens;
 * - bumps the frozen Chrome version to the reported one (reduced-UA form);
 * - derives userAgentMetadata so Sec-CH-UA headers and navigator.userAgentData
 *   report the same brands/versions as the UA string instead of "Electron".
 * The real OS section of the UA is preserved: fonts, WebGL and other
 * platform fingerprints must stay consistent with the claimed platform.
 */
export function buildBrowserIdentity(defaultUA: string, acceptLanguage = 'en-US'): BrowserIdentity {
  const cleaned = String(defaultUA || '')
    .replace(/\s*Electron\/[\d.]+/gi, '')
    .replace(/\s*chatter\/[\d.a-z-]+/gi, '');
  // Modern Chrome reports the reduced UA (major-only, zeroed minor/build/patch)
  // while the full version lives in client hints.
  const userAgent = cleaned
    .replace(/Chrome\/\d+(?:\.\d+)*/gi, `Chrome/${REPORTED_CHROME_MAJOR}.0.0.0`)
    .replace(/\s{2,}/g, ' ')
    .trim();
  const { platform, navigatorPlatform, platformVersion, architecture, bitness } = detectPlatformInfo();
  const metadata: UserAgentMetadata = {
    brands: [
      { brand: 'Not.A/Brand', version: '99' },
      { brand: 'Chromium', version: REPORTED_CHROME_MAJOR },
      { brand: 'Google Chrome', version: REPORTED_CHROME_MAJOR },
    ],
    fullVersionList: [
      { brand: 'Not.A/Brand', version: '99' },
      { brand: 'Chromium', version: REPORTED_CHROME_FULL_VERSION },
      { brand: 'Google Chrome', version: REPORTED_CHROME_FULL_VERSION },
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
 * - `permissions.query({name:'notifications'})` must agree with the above;
 * - `navigator.webdriver` is locked to false (belt and suspenders next to
 *   the `disable-blink-features=AutomationControlled` switch).
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
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: function () { return false; }, configurable: true });
  } catch (error) { /* already patched or prototype frozen */ }
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

export type BrowserIdentityHandle = { dispose: () => void };

const noopIdentityHandle: BrowserIdentityHandle = { dispose: () => {} };

/**
 * Applies the browser identity via the Chromium DevTools Protocol:
 * - `Network.setUserAgentOverride` synchronizes the UA string, request
 *   headers (including Sec-CH-UA* client hints) and navigator.userAgentData
 *   in one shot — this is what `session.setUserAgent` alone cannot do;
 * - `Page.addScriptToEvaluateOnNewDocument` installs the JS fingerprint
 *   patch in the main world before any page script runs.
 *
 * The debugger attachment stays alive for the lifetime of the webContents
 * (the isolated-world machinery in browser.ts rides on top of it). On any
 * failure the caller still keeps the session-level UA set earlier, so this
 * degrades gracefully.
 */
export async function applyBrowserIdentity(contents: WebContents, profile: BrowserIdentity): Promise<BrowserIdentityHandle> {
  if (contents.isDestroyed()) return noopIdentityHandle;
  const debuggerApi = contents.debugger;
  let attachedByUs = false;
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
    await debuggerApi.sendCommand('Network.setUserAgentOverride', {
      userAgent: profile.userAgent,
      acceptLanguage: profile.acceptLanguage,
      platform: profile.navigatorPlatform,
      userAgentMetadata: profile.metadata,
    });
    await debuggerApi.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: IDENTITY_INIT_SCRIPT_SOURCE });
  } catch (error) {
    console.warn('[browser-identity] CDP override failed; keeping the session-level UA only:', error);
  }
  return {
    dispose: () => {
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
