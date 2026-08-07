const path = require('node:path');
const { enableCookieEncryption } = require('./electron-cookie-encryption.cjs');

function getExecutablePath(context) {
  const productFilename = context.packager.appInfo.productFilename;

  if (context.electronPlatformName === 'win32') {
    return path.join(context.appOutDir, `${productFilename}.exe`);
  }
  if (context.electronPlatformName === 'darwin') {
    return path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename);
  }

  const linuxExecutable = context.packager.executableName || productFilename;
  return path.join(context.appOutDir, linuxExecutable);
}

module.exports = async function afterPack(context) {
  const executablePath = getExecutablePath(context);
  await enableCookieEncryption(executablePath);

  console.log(`[security] Electron cookieEncryption fuse enabled: ${executablePath}`);
};
