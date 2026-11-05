import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { buildBrowserIdentity, REPORTED_CHROME_MAJOR, REPORTED_CHROME_FULL_VERSION } = createRequire(import.meta.url)('../src/main/browser-identity.ts');

const electronWinUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) chatter-desktop/2.0.0 Chrome/130.0.0.0 Electron/33.4.11 Safari/537.36';
const electronMacUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) chatter-desktop/2.0.0 Chrome/130.0.0.0 Electron/33.4.11 Safari/537.36';

const expectedPlatform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';

try {
  const profile = buildBrowserIdentity(electronWinUA, 'ru');

  // UA rebuild: no Electron/chatter tokens survive, whatever the app token is.
  assert.ok(!/Electron/i.test(profile.userAgent), 'UA must not leak Electron');
  assert.ok(!/chatter/i.test(profile.userAgent), 'UA must not leak chatter (incl. chatter-desktop)');
  assert.ok(!/chatter-desktop/i.test(profile.userAgent), 'UA must not leak the package name token');
  assert.ok(!/\s{2,}/.test(profile.userAgent), 'UA must not contain double spaces');

  // The UA is rebuilt byte-for-byte in genuine Chrome form.
  assert.equal(
    profile.userAgent,
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${REPORTED_CHROME_MAJOR}.0.0.0 Safari/537.36`,
    'UA must be rebuilt in genuine Chrome form',
  );

  // Reported Chrome version in reduced-UA form.
  assert.ok(profile.userAgent.includes(`Chrome/${REPORTED_CHROME_MAJOR}.0.0.0`), 'UA must carry the reported Chrome major');
  assert.ok(!/Chrome\/130/.test(profile.userAgent), 'UA must not carry the frozen Electron Chromium version');

  // The real OS section is preserved so platform fingerprints stay consistent.
  assert.ok(profile.userAgent.includes('(Windows NT 10.0; Win64; x64)'), 'UA must keep the real OS section');

  // Client hints agree with the UA string.
  assert.equal(profile.metadata.mobile, false);
  assert.equal(profile.metadata.fullVersion, REPORTED_CHROME_FULL_VERSION);
  assert.equal(profile.metadata.platform, expectedPlatform);
  const brandNames = profile.metadata.brands.map((brand: { brand: string }) => brand.brand);
  assert.ok(brandNames.includes('Google Chrome'), 'brands must claim Google Chrome');
  assert.ok(brandNames.includes('Chromium'), 'brands must claim Chromium');
  assert.ok(!brandNames.some((name: string) => /electron/i.test(name)), 'brands must not claim Electron');
  for (const brand of profile.metadata.brands) {
    if (brand.brand !== 'Not.A/Brand') assert.equal(brand.version, REPORTED_CHROME_MAJOR, 'reduced brands must use the reported major');
  }
  for (const brand of profile.metadata.fullVersionList) {
    if (brand.brand !== 'Not.A/Brand') assert.equal(brand.version, REPORTED_CHROME_FULL_VERSION, 'full brands must use the reported full version');
  }

  // macOS UA keeps its frozen OS token too.
  const macProfile = buildBrowserIdentity(electronMacUA);
  assert.ok(macProfile.userAgent.includes('Macintosh; Intel Mac OS X 10_15_7'), 'macOS UA must keep the frozen OS section');
  assert.ok(macProfile.userAgent.includes(`Chrome/${REPORTED_CHROME_MAJOR}.0.0.0`), 'macOS UA must carry the reported Chrome major');

  // Idempotence: an already-clean UA survives a second pass unchanged.
  const once = buildBrowserIdentity(electronWinUA).userAgent;
  const twice = buildBrowserIdentity(once).userAgent;
  assert.equal(twice, once, 'profile must be stable when applied twice');

  // A missing default UA still yields a valid Chrome UA for the real OS.
  const fallback = buildBrowserIdentity('');
  assert.ok(fallback.userAgent.startsWith('Mozilla/5.0 ('), 'fallback UA must be well-formed');
  assert.ok(fallback.userAgent.includes(`Chrome/${REPORTED_CHROME_MAJOR}.0.0.0`), 'fallback UA must carry the reported Chrome major');

  // acceptLanguage passes through untouched (as plain tags; Chromium adds ;q= itself).
  assert.equal(buildBrowserIdentity(electronWinUA, 'ru-RU').acceptLanguage, 'ru-RU');
  assert.equal(buildBrowserIdentity(electronWinUA).acceptLanguage, 'en-US');

  console.log('browser-identity tests passed');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
