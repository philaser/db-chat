const path = require('node:path');
const fs = require('node:fs');
const { listPackage } = require('@electron/asar');

// electron-builder hook: fail the package if server/runtime files leak into it.
exports.default = async function verifyDesktopPackage(context) {
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const allowed = new Set(['/application.json', '/main.js', '/navigation.js', '/package.json']);
  const files = listPackage(path.join(resources, 'app.asar'));
  if (files.length !== allowed.size || files.some(file => !allowed.has(file))) {
    throw new Error('Desktop package must contain only the hosted web shell.');
  }
  if (fs.existsSync(path.join(resources, 'app.asar.unpacked'))) {
    throw new Error('Desktop package unexpectedly contains unpacked runtime dependencies.');
  }
};
