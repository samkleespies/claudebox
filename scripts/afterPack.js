exports.default = async function(context) {
  // Using @homebridge/node-pty-prebuilt-multiarch which provides prebuilt binaries
  // No rebuild necessary
  console.log('Using prebuilt node-pty binaries for Electron', context.electronVersion);
};
