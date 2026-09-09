// test_networktoggle.js — mainnet/testnet network toggle. Every probe must pass;
// exit 0.
//   1 DEFAULT IS MAINNET      (BACKEND_URL === MAINNET_URL on a fresh module load)
//   2 SWITCHING UPDATES THE ACTIVE URL (setNetwork flips BACKEND_URL live)
//   3 EXISTING CALLS SEE THE RUNTIME URL (a template-literal read, mirroring
//     App.js's `${BACKEND_URL}` call sites, reflects the switch with NO re-require)
//   4 PERSISTENCE ROUND-TRIP (a fresh module load restores a saved choice via
//     loadNetwork — simulates an app restart)
//   5 INVALID NETWORK REJECTED, ATOMIC (throws; no partial state change)
//   6 APP.JS WIRING (structural source-scan — App.js cannot be executed under
//     plain Node; this proves the toggle/badge/reload are wired, not that they
//     render correctly on-device. See the summary for what was and wasn't run.)
//
// Probe 6 is the one honest caveat: it is a SOURCE-LEVEL check (same technique
// test_self_gate.js's "NO GATEKEEPER" probe used for self_gate.js), not a live
// UI render. This gate's job is to prove config.js's runtime-URL logic is
// correct and that App.js is wired to it — actual on-device rendering was
// separately checked via an Expo web preview (see the task summary).

const fs = require('fs');
const path = require('path');

let fails = 0;
const ok  = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };

const APP_JS = path.join(__dirname, 'App.js');
const CONFIG_JS = path.join(__dirname, 'config.js');

// a tiny AsyncStorage-shaped mock: async getItem/setItem over a plain object.
function mockStorage(init = {}) {
  const store = { ...init };
  return { store, getItem: (k) => Promise.resolve(Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null), setItem: (k, v) => { store[k] = v; return Promise.resolve(); } };
}
// force a FRESH module instance (simulates a real app restart, where currentNetwork
// resets to its in-module default before loadNetwork restores a persisted choice).
function freshConfig() {
  delete require.cache[require.resolve(CONFIG_JS)];
  return require(CONFIG_JS);
}

(async () => {
  console.log('\n  NETWORK TOGGLE — mainnet ⇄ testnet, no rebuild\n');

  // (1) DEFAULT IS MAINNET
  console.log('  (1) DEFAULT IS MAINNET');
  {
    const config = freshConfig();
    (config.getNetwork() === 'mainnet' && config.BACKEND_URL === config.MAINNET_URL && !config.isTestnet())
      ? ok(`fresh module load → network='mainnet', BACKEND_URL=${config.BACKEND_URL}, isTestnet()=false`)
      : bad(`default wrong: network=${config.getNetwork()} url=${config.BACKEND_URL} testnet=${config.isTestnet()}`);
  }

  // (2) SWITCHING UPDATES THE ACTIVE URL
  console.log('  (2) SWITCHING UPDATES THE ACTIVE URL');
  {
    const config = freshConfig();
    const storage = mockStorage();
    const returned = await config.setNetwork('testnet', storage);
    (config.getNetwork() === 'testnet' && config.BACKEND_URL === config.TESTNET_URL && config.isTestnet() && returned === config.TESTNET_URL)
      ? ok(`setNetwork('testnet') → network='testnet', BACKEND_URL=${config.BACKEND_URL}, isTestnet()=true`)
      : bad(`switch to testnet failed: ${JSON.stringify({ network: config.getNetwork(), url: config.BACKEND_URL, returned })}`);
    await config.setNetwork('mainnet', storage);
    (config.getNetwork() === 'mainnet' && config.BACKEND_URL === config.MAINNET_URL && !config.isTestnet())
      ? ok(`setNetwork('mainnet') → switches back cleanly`)
      : bad('switch back to mainnet failed');
  }

  // (3) EXISTING CALLS SEE THE RUNTIME URL
  console.log('  (3) EXISTING CALLS SEE THE RUNTIME URL');
  {
    // Mirrors every App.js call site: `fetch(`${BACKEND_URL}/ledger`, ...)`. Since
    // Babel's CommonJS interop rewrites a named `import { BACKEND_URL }` usage to a
    // property read on this module's exports AT EACH REFERENCE (not a one-time
    // destructure), reading config.BACKEND_URL repeatedly — with no re-require in
    // between — is the faithful Node-side equivalent of what every App.js fetch call
    // sees. BACKEND_URL is implemented as a getter, so this is guaranteed by plain JS
    // semantics regardless of the bundler.
    const config = freshConfig();
    const storage = mockStorage();
    const before = `${config.BACKEND_URL}/ledger`;
    await config.setNetwork('testnet', storage);
    const after = `${config.BACKEND_URL}/ledger`;
    (before === `${config.MAINNET_URL}/ledger` && after === `${config.TESTNET_URL}/ledger` && before !== after)
      ? ok(`template-literal read of BACKEND_URL (no re-require) changes after the switch: ${before} → ${after}`)
      : bad(`runtime URL not reflected: before=${before} after=${after}`);
  }

  // (4) PERSISTENCE ROUND-TRIP (simulated app restart)
  console.log('  (4) PERSISTENCE ROUND-TRIP');
  {
    const c1 = freshConfig();
    const storage = mockStorage();
    await c1.setNetwork('testnet', storage);   // user switches to testnet; persisted to storage
    // simulate an app restart: a FRESH module instance (back to the in-memory default)
    const c2 = freshConfig();
    const restartDefault = c2.getNetwork();
    await c2.loadNetwork(storage);              // startup: restore the persisted choice
    (restartDefault === 'mainnet' && c2.getNetwork() === 'testnet' && c2.BACKEND_URL === c2.TESTNET_URL)
      ? ok('a fresh module starts at mainnet, then loadNetwork() restores the persisted testnet choice')
      : bad(`persistence round-trip failed: restartDefault=${restartDefault} afterLoad=${c2.getNetwork()}`);

    // no persisted choice → stays on the default, never throws
    const c3 = freshConfig();
    await c3.loadNetwork(mockStorage());
    (c3.getNetwork() === 'mainnet') ? ok('no persisted choice → loadNetwork() leaves the default (mainnet) untouched') : bad('empty-storage loadNetwork changed the default');

    // a storage that throws → loadNetwork degrades to the default, never throws
    const throwingStorage = { getItem: () => Promise.reject(new Error('disk error')), setItem: () => Promise.reject(new Error('disk error')) };
    const c4 = freshConfig();
    let loadThrew = false;
    try { await c4.loadNetwork(throwingStorage); } catch { loadThrew = true; }
    (!loadThrew && c4.getNetwork() === 'mainnet') ? ok('a storage read failure degrades to the default network, never throws') : bad('loadNetwork threw or left a bad state on storage failure');
  }

  // (5) INVALID NETWORK REJECTED, ATOMIC
  console.log('  (5) INVALID NETWORK REJECTED, ATOMIC');
  {
    const config = freshConfig();
    const before = config.getNetwork();
    let threw = false;
    try { await config.setNetwork('bogus-network', mockStorage()); } catch { threw = true; }
    (threw && config.getNetwork() === before && config.BACKEND_URL === config.MAINNET_URL)
      ? ok('setNetwork("bogus-network") throws; network/BACKEND_URL unchanged (atomic — no partial switch)')
      : bad(`invalid network not atomic: threw=${threw} network=${config.getNetwork()}`);
  }

  // (6) APP.JS WIRING (structural source-scan — see the header note on scope)
  console.log('  (6) APP.JS WIRING (structural)');
  {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const configImportMatch = stripped.match(/import\s*\{[^}]*\}\s*from\s*['"]\.\/config['"]/);
    const importsHelpers = !!configImportMatch && ['getNetwork', 'isTestnet', 'setNetwork', 'loadNetwork'].every((h) => new RegExp(`\\b${h}\\b`).test(configImportMatch[0]));
    (importsHelpers) ? ok('App.js imports getNetwork/isTestnet/setNetwork/loadNetwork from ./config') : bad('App.js does not import all four network helpers from ./config');

    // toggle handler: a function that calls setNetwork(...) and then reload (sync())
    const hasToggleFn = /const\s+toggleNetwork\s*=\s*async\s*\(\)\s*=>\s*\{[\s\S]*?setNetwork\([\s\S]*?\)[\s\S]*?sync\(\)[\s\S]*?\}/.test(stripped);
    (hasToggleFn) ? ok('a toggleNetwork handler calls setNetwork(...) AND sync() (reload from the new URL) on switch') : bad('no toggle handler found that calls both setNetwork and sync');

    // boot-time restore: loadNetwork is called (independent of the toggle handler)
    const callsLoadOnBoot = /loadNetwork\(AsyncStorage\)/.test(stripped);
    (callsLoadOnBoot) ? ok('loadNetwork(AsyncStorage) is called (restores a persisted choice at startup)') : bad('loadNetwork(AsyncStorage) is not called anywhere');

    // the testnet banner: rendered ONLY behind a single-branch `&&` guard (never a
    // ternary with a mainnet-else-branch), so mainnet truly renders nothing extra.
    const bannerMatch = stripped.match(/\{\s*network\s*===\s*['"]testnet['"]\s*&&\s*\(\s*<View[^]*?testnetBanner[^]*?<\/View>\s*\)\s*\}/);
    (bannerMatch) ? ok('the 🧪 TESTNET banner is gated behind `network === \'testnet\' && (...)` — a single-branch guard, so mainnet renders nothing extra') : bad('testnet banner not found behind the expected single-branch guard');
    // \b won't break on `testnetBanner` -> `testnetBannerText` (both are one "word" to
    // \b), so match the exact identifier and reject a trailing word character instead.
    const onlyOneBannerRef = (stripped.match(/testnetBanner(?![a-zA-Z])/g) || []).length;
    (onlyOneBannerRef === 2) ? ok('testnetBanner referenced exactly twice (the JSX guard + its style definition) — no stray unconditional render') : bad(`testnetBanner referenced ${onlyOneBannerRef} times (expected 2)`);

    // the toggle pill shows a different label per network (mainnet vs testnet)
    const hasBothLabels = /MAINNET · tap for Testnet/.test(stripped) && /TESTNET · tap for Mainnet/.test(stripped);
    (hasBothLabels) ? ok('the toggle pill shows a distinct label for each network state') : bad('toggle pill labels missing for one or both states');
  }

  console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Network toggle: ${fails === 0 ? 'ALL PROBES PASS' : fails + ' FAILURE(S)'} — mainnet/testnet switch, no rebuild required.\n`);
  process.exit(fails === 0 ? 0 : 1);
})();
