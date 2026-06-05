// Standard Expo Metro config (extends expo/metro-config so .web.js / .native.js
// platform resolution and SDK defaults work correctly for EAS builds).
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

module.exports = config;
