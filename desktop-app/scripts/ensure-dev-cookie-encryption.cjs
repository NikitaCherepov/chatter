const { enableCookieEncryption } = require('./electron-cookie-encryption.cjs');

async function main() {
  const executablePath = require('electron');
  await enableCookieEncryption(executablePath, {
    resetAdHocDarwinSignature: process.platform === 'darwin' && process.arch === 'arm64',
  });
  console.log(`[security] Development Electron cookieEncryption fuse enabled: ${executablePath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
