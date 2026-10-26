// The iPhone app shares the protocol and crypto with the desktop: src/core and server/src/shared
// are bundled from the main project.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const root = path.resolve(__dirname, '..');
const config = getDefaultConfig(__dirname);

// Plus the desktop's formatting helpers (dates, sizes, initials), which touch no DOM.
config.watchFolders = [path.join(root, 'src/core'), path.join(root, 'server/src/shared'), path.join(root, 'src/renderer/src/lib')];
// Files from the main project find their packages here when the main project has no node_modules.
config.resolver.nodeModulesPaths = [path.join(__dirname, 'node_modules')];

module.exports = config;
