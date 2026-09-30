// The SDK lives one directory up and is linked with `file:..`. Metro must
// watch it, but resolve every dependency — react and react-native above all —
// from this app's node_modules: the SDK's own devDependencies include a second
// react, and two Reacts in one bundle break every hook. So the SDK's
// node_modules are blocked, and `nodeModulesPaths` is where an import from
// ../src falls through to. Hierarchical lookup stays on: expo nests some of
// its own dependencies (expo-asset) under expo/node_modules.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const sdkRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);
config.watchFolders = [sdkRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];
config.resolver.blockList = [new RegExp(`${sdkRoot.replace(/[/\\]/g, '[/\\\\]')}[/\\\\]node_modules[/\\\\].*`)];

module.exports = config;
