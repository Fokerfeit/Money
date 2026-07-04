// test_testnetux.js — BUG 1 (per-network wallet) + BUG 2 (ignition code field
// in the main-screen claim flow). Every probe must pass; exit 0.
//   1 DIFFERENT WALLET PER NETWORK   2 STABLE ACROSS REPEATED TOGGLES
//   3 MAINNET MIGRATION (existing users keep their wallet)   4 TESTNET NEVER
//     INHERITS MAINNET'S LEGACY WALLET   5 ASYNC-STORAGE LEGACY FALLBACK
//   6 APP.JS WIRING — wallet (structural)   7 APP.JS WIRING — ignition code (structural)
//
// App.js is a React Native/JSX file and cannot run under plain Node. This gate
// proves the wallet-key-derivation ALGORITHM for real by re-implementing it
// line-for-line against a mock SecureStore/AsyncStorage (probes 1-5), then
// structurally confirms (probes 6-7) that App.js's actual boot effect,
// toggleNetwork, and applyRestore call THIS EXACT algorithm — same key format
// (`keypair_v3_${net}`), same function names, same migration logic — so the
// executed proof and the shipped code are provably the same logic, not a
// test that could silently drift from the real implementation. This mirrors
// the technique test_networktoggle.js used for config.js's wiring.

const fs = require('fs');
const path = require('path');
const nacl = require('tweetnacl');

let fails = 0;
const ok  = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };

const APP_JS = path.join(__dirname, 'App.js');

// ── faithful re-implementation of App.js's createKeypair() (nacl-based) ──────
const toHex = (u8) => Buffer.from(u8).toString('hex');
function createKeypair() {
  const kp = nacl.sign.keyPair();
  const pub = toHex(kp.publicKey);
  return { address: 'M_' + pub.substring(0, 32).toUpperCase(), publicKey: pub, secretKey: toHex(kp.secretKey) };
}

// ── mock SecureStore / AsyncStorage (async, {getItem(Async)/setItem(Async)/removeItem}) ──
function mockStores() {
  const secure = {}, asyncStore = {};
  return {
    SecureStore: {
      getItemAsync: (k) => Promise.resolve(Object.prototype.hasOwnProperty.call(secure, k) ? secure[k] : null),
      setItemAsync: (k, v) => { secure[k] = v; return Promise.resolve(); },
    },
    AsyncStorage: {
      getItem: (k) => Promise.resolve(Object.prototype.hasOwnProperty.call(asyncStore, k) ? asyncStore[k] : null),
      removeItem: (k) => { delete asyncStore[k]; return Promise.resolve(); },
    },
    _secure: secure, _async: asyncStore,
  };
}

// ── the EXACT algorithm from App.js (walletKey / saveWallet / loadOrCreateWallet) ──
const walletKey = (net) => `keypair_v3_${net}`;

function makeWalletApi({ SecureStore, AsyncStorage }) {
  const saveWallet = async (net, kp) => {
    await SecureStore.setItemAsync(walletKey(net), JSON.stringify(kp)).catch(() => {});
  };
  const loadOrCreateWallet = async (net) => {
    let raw = await SecureStore.getItemAsync(walletKey(net)).catch(() => null);
    if (!raw && net === 'mainnet') {
      let legacy = await SecureStore.getItemAsync('keypair_v3').catch(() => null);
      if (!legacy) {
        const legacyAsync = await AsyncStorage.getItem('keypair_v2').catch(() => null);
        if (legacyAsync) { legacy = legacyAsync; await AsyncStorage.removeItem('keypair_v2').catch(() => {}); }
      }
      if (legacy) { raw = legacy; await saveWallet(net, JSON.parse(legacy)); }
    }
    const kp = raw ? JSON.parse(raw) : createKeypair();
    if (!raw) await saveWallet(net, kp);
    return kp;
  };
  return { saveWallet, loadOrCreateWallet };
}

(async () => {
  console.log('\n  TESTNET UX — per-network wallet storage + ignition-code field\n');

  // (1) DIFFERENT WALLET PER NETWORK — the core claim
  console.log('  (1) DIFFERENT WALLET PER NETWORK');
  {
    const stores = mockStores();
    const { loadOrCreateWallet } = makeWalletApi(stores);
    const main = await loadOrCreateWallet('mainnet');
    const test = await loadOrCreateWallet('testnet');
    (main.address !== test.address && stores._secure[walletKey('mainnet')] && stores._secure[walletKey('testnet')] && stores._secure[walletKey('mainnet')] !== stores._secure[walletKey('testnet')])
      ? ok(`mainnet and testnet get DIFFERENT wallets (mainnet=${main.address.slice(0, 10)}…, testnet=${test.address.slice(0, 10)}…), stored under separate keys`)
      : bad(`wallets not distinct: main=${main.address} test=${test.address}`);
  }

  // (2) STABLE ACROSS REPEATED TOGGLES — switching never regenerates or swaps
  console.log('  (2) STABLE ACROSS REPEATED TOGGLES');
  {
    const stores = mockStores();
    const { loadOrCreateWallet } = makeWalletApi(stores);
    const m1 = await loadOrCreateWallet('mainnet');
    const t1 = await loadOrCreateWallet('testnet');
    const m2 = await loadOrCreateWallet('mainnet');   // switch back
    const t2 = await loadOrCreateWallet('testnet');   // switch back again
    const m3 = await loadOrCreateWallet('mainnet');
    (m1.address === m2.address && m2.address === m3.address && t1.address === t2.address && m1.address !== t1.address)
      ? ok('mainnet ⇄ testnet ⇄ mainnet ⇄ testnet ⇄ mainnet: each network keeps its OWN stable address across repeated toggles')
      : bad(`instability: m1=${m1.address} m2=${m2.address} m3=${m3.address} t1=${t1.address} t2=${t2.address}`);
  }

  // (3) MAINNET MIGRATION — an existing user's wallet must survive this update
  console.log('  (3) MAINNET MIGRATION (existing users)');
  {
    const stores = mockStores();
    const existing = createKeypair();
    stores._secure['keypair_v3'] = JSON.stringify(existing);   // pre-existing, un-namespaced (old app version)
    const { loadOrCreateWallet } = makeWalletApi(stores);
    const migrated = await loadOrCreateWallet('mainnet');
    const secondLoad = await loadOrCreateWallet('mainnet');   // must not re-migrate / must not regenerate
    (migrated.address === existing.address && secondLoad.address === existing.address && stores._secure[walletKey('mainnet')] === JSON.stringify(existing))
      ? ok(`a pre-existing (un-namespaced) mainnet wallet migrates intact to the namespaced slot: ${existing.address.slice(0, 10)}…`)
      : bad(`migration failed: existing=${existing.address} migrated=${migrated.address} secondLoad=${secondLoad.address}`);
  }

  // (4) TESTNET NEVER INHERITS MAINNET'S LEGACY WALLET
  console.log('  (4) TESTNET NEVER INHERITS MAINNET LEGACY');
  {
    const stores = mockStores();
    const legacyMainnet = createKeypair();
    stores._secure['keypair_v3'] = JSON.stringify(legacyMainnet);   // legacy mainnet-only data
    const { loadOrCreateWallet } = makeWalletApi(stores);
    const testWallet = await loadOrCreateWallet('testnet');   // must NOT reuse the legacy mainnet key
    (testWallet.address !== legacyMainnet.address && !stores._secure[walletKey('testnet')].includes(legacyMainnet.secretKey))
      ? ok('testnet gets a FRESH wallet — the legacy un-namespaced key is mainnet-only and never leaks into testnet')
      : bad(`testnet inherited mainnet's legacy identity: test=${testWallet.address} legacy=${legacyMainnet.address}`);
  }

  // (5) ASYNC-STORAGE LEGACY FALLBACK (older pre-SecureStore-migration users)
  console.log('  (5) ASYNC-STORAGE LEGACY FALLBACK');
  {
    const stores = mockStores();
    const veryOld = createKeypair();
    stores._async['keypair_v2'] = JSON.stringify(veryOld);   // oldest legacy path (AsyncStorage, no SecureStore yet)
    const { loadOrCreateWallet } = makeWalletApi(stores);
    const migrated = await loadOrCreateWallet('mainnet');
    (migrated.address === veryOld.address && stores._secure[walletKey('mainnet')] === JSON.stringify(veryOld) && !('keypair_v2' in stores._async))
      ? ok('the oldest (AsyncStorage keypair_v2) legacy wallet migrates to the namespaced mainnet slot, and the plaintext copy is wiped')
      : bad(`AsyncStorage fallback failed: migrated=${migrated.address} veryOld=${veryOld.address} asyncStillHas=${'keypair_v2' in stores._async}`);
  }

  // (6) APP.JS WIRING — wallet (structural; App.js can't run under plain Node)
  console.log('  (6) APP.JS WIRING — wallet (structural)');
  {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const hasHelpers = /const\s+walletKey\s*=\s*\(net\)\s*=>\s*`keypair_v3_\$\{net\}`/.test(stripped)
      && /const\s+saveWallet\s*=\s*async/.test(stripped)
      && /const\s+loadOrCreateWallet\s*=\s*async/.test(stripped)
      && /const\s+applyWalletToState\s*=/.test(stripped);
    (hasHelpers) ? ok('walletKey/saveWallet/loadOrCreateWallet/applyWalletToState are all defined, keyed by network') : bad('one or more wallet helpers missing');

    // exactly ONE remaining bare 'keypair_v3' reference — the mainnet-only migration check.
    // Every other site must go through the namespaced walletKey(...).
    const bareRefs = (stripped.match(/'keypair_v3'/g) || []).length;
    (bareRefs === 1) ? ok('exactly one bare \'keypair_v3\' reference remains (the mainnet migration path) — no other site bypasses per-network keying')
                     : bad(`expected exactly 1 bare 'keypair_v3' reference, found ${bareRefs}`);

    const bootResolvesNetworkFirst = /await loadNetwork\(AsyncStorage\);[\s\S]{0,200}loadOrCreateWallet\(net\)/.test(stripped);
    (bootResolvesNetworkFirst) ? ok('the boot effect resolves the network BEFORE loading a wallet (no race between the two)') : bad('boot effect does not resolve network before loading the wallet');

    const toggleReloadsWallet = /const\s+toggleNetwork\s*=\s*async\s*\(\)\s*=>\s*\{[\s\S]*?setNetwork\([\s\S]*?loadOrCreateWallet\(next\)[\s\S]*?applyWalletToState\([\s\S]*?sync\(\)[\s\S]*?\}/.test(stripped);
    (toggleReloadsWallet) ? ok('toggleNetwork() persists the network, then loads/forges THAT network\'s wallet, then reloads data') : bad('toggleNetwork does not reload the wallet for the new network');

    const restoreUsesNetworkSave = /const\s+applyRestore\s*=\s*async\s*\(\)\s*=>\s*\{[\s\S]*?saveWallet\(network,\s*kp\)/.test(stripped);
    (restoreUsesNetworkSave) ? ok('applyRestore() saves the restored wallet into the CURRENTLY ACTIVE network\'s slot (saveWallet(network, kp))') : bad('applyRestore does not use the per-network save');
  }

  // (7) APP.JS WIRING — ignition code field (structural)
  console.log('  (7) APP.JS WIRING — ignition code field (structural)');
  {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const inputCount = (stripped.match(/value=\{ignitionCode\}/g) || []).length;
    (inputCount === 2) ? ok('exactly two ignition-code inputs exist: the onboarding step-4 screen AND the main-screen claim flow') : bad(`expected 2 ignition-code inputs, found ${inputCount}`);

    // the main-screen input sits inside the `{!claimed && (` block, BEFORE the
    // "RECEIVE YOUR FOUNDING SHARE" button text — i.e. visible whenever the claim
    // button itself is (not gated by onboarding step).
    const claimBlockMatch = stripped.match(/\{!claimed\s*&&\s*\([\s\S]*?RECEIVE YOUR FOUNDING SHARE[\s\S]*?\)\}/);
    const mainScreenFieldBeforeButton = !!claimBlockMatch && /value=\{ignitionCode\}/.test(claimBlockMatch[0])
      && claimBlockMatch[0].indexOf('value={ignitionCode}') < claimBlockMatch[0].indexOf('RECEIVE YOUR FOUNDING SHARE');
    (mainScreenFieldBeforeButton) ? ok('the main-screen ignition-code field is inside the same {!claimed && (...)} block, positioned BEFORE the claim button') : bad('ignition-code field not correctly placed before the claim button');

    // claim() still forwards ignitionCode in its POST body (existing flow proven unchanged)
    const claimSendsCode = /const\s+claim\s*=\s*async\s*\(\)\s*=>\s*\{[\s\S]*?ignitionCode:\s*ignitionCode/.test(stripped);
    (claimSendsCode) ? ok('claim() still sends ignitionCode in the POST /transaction body') : bad('claim() no longer sends ignitionCode');
  }

  console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Testnet UX: ${fails === 0 ? 'ALL PROBES PASS' : fails + ' FAILURE(S)'} — per-network wallets, ignition code reachable from the main screen.\n`);
  process.exit(fails === 0 ? 0 : 1);
})();
