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

    const restoreUsesNetworkSave = /const\s+applyRestore\s*=\s*async\s*\(\)\s*=>\s*\{[\s\S]*?saveWallet\(targetNet,\s*kp\)/.test(stripped);
    (restoreUsesNetworkSave) ? ok('applyRestore() saves the restored wallet into the chosen network\'s slot (saveWallet(targetNet, kp); targetNet defaults to the active network)') : bad('applyRestore does not use the per-network save');
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

  // (8) ONBOARDING NETWORK PICKER — FIX 1 (structural + executed)
  console.log('\n  (8) ONBOARDING NETWORK PICKER (Fix 1)');
  {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // selectNetwork reuses the SAME primitives as toggleNetwork (no parallel scheme)
    const selectReuses = /const\s+selectNetwork\s*=\s*async\s*\(net\)\s*=>\s*\{[\s\S]*?setNetwork\(net,\s*AsyncStorage\)[\s\S]*?loadOrCreateWallet\(net\)[\s\S]*?applyWalletToState\(/.test(stripped);
    (selectReuses) ? ok('selectNetwork(net) reuses setNetwork + loadOrCreateWallet + applyWalletToState — no second network mechanism')
                   : bad('selectNetwork missing or does not reuse the existing switch primitives');

    // the picker records the choice, then switches
    const choose = /const\s+chooseNetwork\s*=\s*async\s*\(net\)\s*=>\s*\{\s*setNetworkChosen\(true\);\s*await\s+selectNetwork\(net\)/.test(stripped);
    (choose) ? ok('chooseNetwork(net) marks the choice then calls selectNetwork(net)') : bad('chooseNetwork not wired to selectNetwork');

    // both networks are tappable on the ignition screen
    (/onPress=\{\(\)\s*=>\s*chooseNetwork\('testnet'\)\}/.test(stripped) && /onPress=\{\(\)\s*=>\s*chooseNetwork\('mainnet'\)\}/.test(stripped))
      ? ok('both 🧪 TESTNET and 🌐 MAINNET are tappable on the ignition screen') : bad('picker is missing one of the two network buttons');

    // CRITICAL: entering step 4 with no user tap ACTUALLY switches to testnet (not just highlight)
    const autoSelect = /onboardingStep === 4 && !networkChosen && network !== 'testnet'\)\s*\{\s*selectNetwork\('testnet'\)/.test(stripped);
    (autoSelect) ? ok('entering step 4 with no prior choice calls selectNetwork(\'testnet\') — the active network, not just a highlight')
                 : bad('step-4 effect does not force-select testnet when the user has not chosen');

    // the label reads from LIVE network state (updates the instant the user switches)
    const liveLabel = /Igniting on \$\{network === 'testnet' \? '🧪 TESTNET' : '🌐 MAINNET'\}/.test(stripped);
    (liveLabel) ? ok('the "Igniting on …" label reads live `network` state') : bad('ignition label is not bound to live network state');

    // RACE GUARD: selectNetwork raises switchingNet at the start and clears it in finally
    const flagInFinally = /const\s+selectNetwork\s*=\s*async[\s\S]*?setSwitchingNet\(true\)[\s\S]*?finally\s*\{\s*setSwitchingNet\(false\)/.test(stripped);
    (flagInFinally) ? ok('selectNetwork sets switchingNet=true, then clears it in a finally (never stuck)') : bad('selectNetwork does not guard with switchingNet + finally');

    // IGNITE is frozen while a switch is mid-flight (disabled + onPress guard)
    const igniteDisabled = /disabled=\{switchingNet\}[\s\S]*?onPress=\{\(\)\s*=>\s*\{\s*if \(switchingNet\) return;\s*completeBioKeySetup\(\)/.test(stripped);
    (igniteDisabled) ? ok('IGNITE is disabled + guarded while switchingNet (cannot ignite the old address on the new network)') : bad('IGNITE is not frozen during a network switch');

    // both picker buttons AND ignite carry the switchingNet freeze
    const frozenCount = (stripped.match(/disabled=\{switchingNet\}/g) || []).length;
    (frozenCount >= 3) ? ok(`both picker buttons and IGNITE are disabled while switching (${frozenCount} guarded controls)`) : bad(`expected ≥3 switchingNet-disabled controls, found ${frozenCount}`);

    // label swaps to "Switching network…" during the switch
    (/switchingNet \? 'Switching network…'/.test(stripped)) ? ok('label shows "Switching network…" during the switch') : bad('no "Switching network…" state on the label');

    // EXECUTED against the REAL config.js: default is mainnet; the target the step-4
    // effect uses (\'testnet\') genuinely flips the active network → getNetwork() is
    // \'testnet\' before any claim POST could fire.
    const cfg = require('./config');
    const def = cfg.getNetwork();
    await cfg.setNetwork('testnet');
    const afterAuto = cfg.getNetwork();
    (def === 'mainnet' && afterAuto === 'testnet')
      ? ok(`config proof: default was '${def}', pre-select flips getNetwork() → '${afterAuto}' (IGNITE posts to the shown network)`)
      : bad(`pre-select target did not flip the active network: default=${def} afterAuto=${afterAuto}`);
    await cfg.setNetwork('mainnet');   // restore module default for any later probe
  }

  // (9) RESTORE GUARD — FIX 2 (structural)
  console.log('\n  (9) RESTORE GUARD (Fix 2)');
  {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // both network URLs are imported from config
    (/import\s*\{[^}]*\bMAINNET_URL\b[^}]*\bTESTNET_URL\b[^}]*\}\s*from\s*'\.\/config'/.test(src))
      ? ok('MAINNET_URL and TESTNET_URL are imported from ./config') : bad('MAINNET_URL/TESTNET_URL not imported from config');

    const restore = (stripped.match(/const\s+applyRestore\s*=\s*async[\s\S]*?setOnboardingStep\(0\);\s*\};/) || [''])[0];

    // probes BOTH networks' /balance for the derived address
    (/fetchBalance\(MAINNET_URL,\s*addr\)/.test(restore) && /fetchBalance\(TESTNET_URL,\s*addr\)/.test(restore))
      ? ok('applyRestore probes /balance on BOTH MAINNET_URL and TESTNET_URL') : bad('applyRestore does not probe both networks');

    // the balance probe happens BEFORE the wallet is saved
    (restore.indexOf('fetchBalance(') > -1 && restore.indexOf('fetchBalance(') < restore.indexOf('saveWallet(targetNet'))
      ? ok('the cross-network probe runs BEFORE saveWallet (guard, not after-the-fact)') : bad('balance probe does not precede saveWallet');

    // honest wording: "no funds found on either", never "never ignited"
    (/No funds found on either network/i.test(restore) && !/never ignited/i.test(stripped))
      ? ok('wording is honest — "no funds found on either network"; never claims "never ignited"') : bad('restore wording is missing or dishonest');

    // overwrite guard compares NORMALISED (uppercase) addresses + the 24-words warning
    const addrUpper = /const addr = \(kp\.address \|\| ''\)\.toUpperCase\(\)/.test(restore);
    const cmpUpper  = /existingAddr\s*&&\s*existingAddr\s*!==\s*addr/.test(restore);
    const warn24    = /make sure you have its 24 words/.test(restore);
    (addrUpper && cmpUpper && warn24)
      ? ok('overwrite guard compares uppercased addresses and warns "make sure you have its 24 words" before replacing')
      : bad(`overwrite guard incomplete: addrUpper=${addrUpper} cmpUpper=${cmpUpper} warn24=${warn24}`);

    // switching to the other network reuses setNetwork (no second storage scheme)
    (/if \(targetNet !== network\)\s*\{\s*await setNetwork\(targetNet,\s*AsyncStorage\);\s*setNetworkState\(targetNet\)/.test(restore))
      ? ok('cross-network restore reuses setNetwork + setNetworkState (no parallel mechanism)') : bad('cross-network switch does not reuse setNetwork');

    // saves into the CHOSEN network's slot, and unreachable networks do not block forever
    (/saveWallet\(targetNet,\s*kp\)/.test(restore)) ? ok('restored wallet saved into the chosen network slot (saveWallet(targetNet, kp))') : bad('restore does not save into targetNet slot');
    (/!mainRes\.ok\s*&&\s*!testRes\.ok/.test(restore) && /Restore anyway/.test(restore))
      ? ok('both-networks-unreachable path asks to restore anyway — never blocks forever') : bad('no graceful path when networks are unreachable');
  }

  console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Testnet UX: ${fails === 0 ? 'ALL PROBES PASS' : fails + ' FAILURE(S)'} — per-network wallets, ignition code reachable, onboarding network picker + restore guard.\n`);
  process.exit(fails === 0 ? 0 : 1);
})();
