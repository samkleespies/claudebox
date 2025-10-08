const { execSync } = require('child_process');
const path = require('path');

exports.default = async function(context) {
  const appOutDir = context.appOutDir;
  const electronVersion = context.electronVersion;

  console.log('Rebuilding node-pty for Electron...');

  // Rebuild node-pty for the current electron version
  try {
    execSync(
      `npm rebuild node-pty --runtime=electron --target=${electronVersion} --disturl=https://electronjs.org/headers --build-from-source`,
      {
        cwd: context.appOutDir,
        stdio: 'inherit'
      }
    );
  } catch (error) {
    console.error('Failed to rebuild node-pty:', error);
  }
};
