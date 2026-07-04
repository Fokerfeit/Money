// ── MONEY Network Configuration ───────────────────────────────────────────
//
// NETWORK TOGGLE: the app can switch between MAINNET and TESTNET without a
// rebuild. BACKEND_URL is a RUNTIME value (a live getter), not a build-time
// constant — getNetwork()/setNetwork()/loadNetwork() below read/write it and
// persist the choice. Every existing `${BACKEND_URL}` call site is unchanged
// and automatically sees the current network: Metro/Babel's CommonJS interop
// rewrites a named `import { BACKEND_URL } from './config'` usage to a property
// read on this module's exports at each reference (not a one-time snapshot),
// so BACKEND_URL — a getter — is re-evaluated live on every access.
//
// This module is intentionally PURE (no AsyncStorage import, no RN dependency):
// storage is INJECTED by the caller (App.js passes the real AsyncStorage), which
// keeps this file plain-Node-testable and matches every other storage-backed
// module in this codebase (self_gate.js, safe_store.js).
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const MAINNET_URL = 'https://api.moneyforeveryone.app';
const TESTNET_URL = 'https://testnet.moneyforeveryone.app';

const NETWORK_STORAGE_KEY = 'MONEY_NETWORK';   // AsyncStorage key the choice is persisted under
const DEFAULT_NETWORK     = 'mainnet';

const URLS = { mainnet: MAINNET_URL, testnet: TESTNET_URL };
const isValidNetwork = (n) => Object.prototype.hasOwnProperty.call(URLS, n);

let currentNetwork = DEFAULT_NETWORK;   // in-memory; restored by loadNetwork() at app startup

const getNetwork    = () => currentNetwork;
const isTestnet     = () => currentNetwork === 'testnet';
const getBackendUrl = () => URLS[currentNetwork];

// setNetwork(name, storage?): switch the ACTIVE network immediately (BACKEND_URL
// reflects it on the very next read) and persist the choice. `storage` is any
// {getItem,setItem}-shaped async store (AsyncStorage in production; a plain
// object-backed mock in tests). Persistence is best-effort — a save failure
// does NOT roll back the in-memory switch (the user is already looking at the
// new network; a lost preference just means it defaults back on next restart).
// Throws on an unknown network name WITHOUT changing any state (atomic).
async function setNetwork(name, storage) {
  if (!isValidNetwork(name))
    throw new Error(`setNetwork: unknown network "${name}" (expected "mainnet" or "testnet")`);
  currentNetwork = name;
  if (storage) {
    try { await storage.setItem(NETWORK_STORAGE_KEY, name); }
    catch { /* best-effort persistence — the in-memory switch already applied */ }
  }
  return getBackendUrl();
}

// loadNetwork(storage?): call ONCE at app startup, before the first network
// request, to restore a persisted choice. No-op (stays on the in-memory
// default 'mainnet') if nothing was saved, storage is unreachable, or the
// saved value is unrecognized — never throws.
async function loadNetwork(storage) {
  if (storage) {
    try {
      const saved = await storage.getItem(NETWORK_STORAGE_KEY);
      if (isValidNetwork(saved)) currentNetwork = saved;
    } catch { /* fall back to whatever is already current */ }
  }
  return currentNetwork;
}

module.exports = {
  MAINNET_URL, TESTNET_URL,
  FAUCET_ADDRESS:      'FAUCET',
  RESERVE_ADDRESS:     'SWARM_RESERVE',
  BASE_PENALTY:        100,           // MONEY burned per disconnect infraction
  DISCONNECT_GRACE_MS: 5 * 60 * 1000, // 5-minute grace period before penalty
  getNetwork, isTestnet, setNetwork, loadNetwork,
  get BACKEND_URL() { return getBackendUrl(); },   // LIVE — re-read on every access, never a stale snapshot
};
