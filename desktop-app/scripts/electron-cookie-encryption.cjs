const fs = require('node:fs');
const {
  flipFuses,
  getCurrentFuseWire,
  FuseVersion,
  FuseV1Options,
} = require('@electron/fuses');

const ENABLED_FUSE_STATE = '1'.charCodeAt(0);

async function enableCookieEncryption(executablePath, options = {}) {
  if (!fs.existsSync(executablePath)) {
    throw new Error(`Cannot enable Electron cookie encryption: executable not found at ${executablePath}`);
  }

  const current = await getCurrentFuseWire(executablePath);
  if (current[FuseV1Options.EnableCookieEncryption] !== ENABLED_FUSE_STATE) {
    await flipFuses(executablePath, {
      version: FuseVersion.V1,
      resetAdHocDarwinSignature: options.resetAdHocDarwinSignature === true,
      [FuseV1Options.EnableCookieEncryption]: true,
    });
  }

  const verified = await getCurrentFuseWire(executablePath);
  if (verified[FuseV1Options.EnableCookieEncryption] !== ENABLED_FUSE_STATE) {
    throw new Error('Electron cookieEncryption fuse verification failed');
  }
}

module.exports = { enableCookieEncryption };
