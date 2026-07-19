// mobile/self_gate.js — personhood-bound ignition (Self protocol, MOCK mode).
//
// ADDITIVE + FLAG-GATED. This module does NOT touch the central money rules or
// the Brick 1 chain. It adds a SECOND ignition path next to the invite-code gate:
// a user proves they are a unique human via the Self protocol; the proof yields a
// NULLIFIER — a per-app fingerprint of that human that reveals no identity. One
// nullifier = one ignition. The FIRST valid proof seals that nullifier to an M_
// wallet and mints exactly 1,000,000 through the SAME FAUCET mint mechanism the
// invite-code path uses (a from:'FAUCET' commit), so standing + the Brick 1 chain
// behave identically. Any later proof carrying an already-used nullifier is
// rejected — no second mint, even from a brand-new wallet. No invite code is ever
// consulted on this path. "One human, one million, decided by math."
//
// TESTABILITY: the zk verifier is injected (`verify(payload) -> {valid,nullifier}`).
// Production wires `realSelfVerifier()` (real SelfBackendVerifier, mock mode);
// tests inject a stub returning a chosen verdict, since a real zk proof cannot be
// fabricated in CI. The pure gate below has NO dependency on @selfxyz/core — that
// package is lazy-required ONLY inside realSelfVerifier(), so the gate and its
// test run without it installed.
'use strict';

const MINT_AMOUNT = 1_000_000;               // one human, one million — fixed integer
const WALLET_RE   = /^M_[0-9A-Fa-f]{32}$/i;  // the shape App.js seals (toAddress)

// ── Nullifier store (persistence-injected) ───────────────────────────────────
// Records nullifier → wallet. `storage` is a tiny sync KV ({getItem,setItem}),
// so the server backs it with a file (see server.js — routed through
// safe_store.js's atomic dual-bak write, the same fail-closed pattern used by
// identity_store.js) and a test backs it with a plain object. A nullifier, once
// sealed, can never be re-sealed (the Sybil ledger).
//
// FAIL-CLOSED (CRITICAL fix — Cowork's first audit of d819aa3): this used to
// catch ANY load failure — a torn write, truncated file, hand-edited garbage —
// and silently reset to `map = {}`. That would let an already-sealed nullifier
// "come back" and mint a SECOND time after the store's own file was corrupted,
// which is exactly the Sybil hole this whole gate exists to close. A corrupted
// store must refuse to load, not quietly forget every human who already
// ignited. `getItem() === null/undefined` is the ONLY case treated as a
// genuine first boot — everything else that isn't valid, well-shaped JSON
// THROWS, and the throw propagates out of createNullifierStore() (load() runs
// at construction) so a broken store can never come up looking healthy.
function createNullifierStore(storage) {
  const KEY = 'self_nullifiers_v1';
  let map = {};
  function load() {
    const raw = storage.getItem(KEY);
    if (raw === null || raw === undefined) { map = {}; return map; }   // no store at all yet = genuine first boot
    if (raw === '') {
      throw new Error(
        `self_gate nullifier store ("${KEY}") is present but EMPTY — a fresh store has no file/entry at all, ` +
        `so an empty one looks like a torn or interrupted write, not a first boot. Refusing to silently reset ` +
        `(fail-closed): that could let an already-sealed nullifier re-mint. Restore from a backup, or if you are ` +
        `certain no nullifier was ever sealed, remove the store and restart.`
      );
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) {
      throw new Error(`self_gate nullifier store ("${KEY}") is not valid JSON — refusing to silently reset (fail-closed): ${e.message}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        `self_gate nullifier store ("${KEY}") parsed to ${Array.isArray(parsed) ? 'an array' : parsed === null ? 'null' : typeof parsed} ` +
        `(expected a plain {nullifier: wallet} object) — refusing to silently reset (fail-closed).`
      );
    }
    map = parsed;
    return map;
  }
  function persist() { storage.setItem(KEY, JSON.stringify(map)); }
  load();
  return {
    has:  (n) => Object.prototype.hasOwnProperty.call(map, n),
    get:  (n) => (Object.prototype.hasOwnProperty.call(map, n) ? map[n] : null),
    size: () => Object.keys(map).length,
    // Seal ONLY if unused — returns false on a repeat so the caller can never
    // overwrite an existing binding (defence in depth behind the gate's own check).
    seal: (n, wallet) => {
      if (Object.prototype.hasOwnProperty.call(map, n)) return false;
      map[n] = wallet; persist(); return true;
    },
    all:  () => ({ ...map }),
    load,
  };
}

// ── The gate ─────────────────────────────────────────────────────────────────
// createSelfGate({ verify, ledger, store, amount?, now? }) -> { claim }
//   verify(payload) -> Promise<{ valid:boolean, nullifier?:string }>   (INJECTED)
//   ledger : LedgerBackend — needs commit(tx); uses isIgnited(addr) if present.
//   store  : createNullifierStore(...)
function createSelfGate({ verify, ledger, store, amount = MINT_AMOUNT, now = () => Date.now() }) {
  if (typeof verify !== 'function') throw new Error('createSelfGate: verify(payload) function required');
  if (!ledger || typeof ledger.commit !== 'function') throw new Error('createSelfGate: ledger backend with commit() required');
  if (!store || typeof store.has !== 'function') throw new Error('createSelfGate: nullifier store required');

  // payload: the Self proof bundle (opaque to the gate — handed to `verify`).
  // wallet : the M_ address the human wants to ignite.
  async function claim(payload, wallet) {
    wallet = String(wallet || '').toUpperCase();
    if (!WALLET_RE.test(wallet))
      return { ok: false, code: 'bad-wallet', reason: 'Destination must be a valid M_ wallet address' };

    // 1) Verify the proof through the injected verifier. A throw is treated as
    //    "unverified" — we NEVER mint on a verifier error.
    let result;
    try { result = await verify(payload); }
    catch (e) { return { ok: false, code: 'verify-error', reason: (e && e.message) || 'verification failed' }; }

    const valid     = !!(result && result.valid);
    const nullifier = result && result.nullifier;

    // 2) INVALID PROOF → nothing minted, nothing stored.
    if (!valid)
      return { ok: false, code: 'invalid-proof', reason: 'Self proof did not verify' };
    if (typeof nullifier !== 'string' || !nullifier)
      return { ok: false, code: 'no-nullifier', reason: 'Verified proof carried no nullifier' };

    // 3) SYBIL CORE — one nullifier = one ignition. A second proof from the SAME
    //    human (same nullifier) is rejected even if it targets a fresh wallet.
    if (store.has(nullifier))
      return { ok: false, code: 'nullifier-used', reason: 'This person has already ignited a wallet', boundTo: store.get(nullifier) };

    // 4) Never double-mint to a wallet that already ignited via ANY path
    //    (mirrors the invite-code faucet's one-claim-per-address gate).
    if (typeof ledger.isIgnited === 'function' && ledger.isIgnited(wallet))
      return { ok: false, code: 'wallet-ignited', reason: 'This wallet has already been ignited' };

    // 5) MINT via the SAME FAUCET mechanism: a from:'FAUCET' tx of exactly
    //    `amount`, committed through the ledger's single write path. Integer money —
    //    the amount must ALREADY be a whole number (no silent truncation).
    const amt = amount;
    if (!Number.isInteger(amt) || amt <= 0)
      return { ok: false, code: 'bad-amount', reason: 'mint amount must be a positive integer' };
    const ts = now();
    const tx = {
      from: 'FAUCET', to: wallet, amount: amt,
      reason: 'self_ignition',
      time: new Date(ts).toLocaleTimeString(),
      timestamp: ts,
      sigPrefix: null,                       // gate-minted: no user signature to record
    };
    ledger.commit(tx);                       // append + index + persist — identical to the faucet path

    // 6) SEAL the nullifier → wallet binding AFTER the mint lands. (central
    //    commit() never throws — saveJSON swallows disk errors — so the in-memory
    //    append has already happened by here; sealing now records the human.)
    store.seal(nullifier, wallet);

    return { ok: true, nullifier, wallet, amount: amt, tx };
  }

  return { claim };
}

// ── Production verifier (LAZY — @selfxyz/core loaded only when the gate runs) ──
// Wraps SelfBackendVerifier in MOCK mode (mockPassport=true → staging/testnet,
// per the Self docs: older <1.1.0-beta.1 used the wrong network for mock).
//   verify(payload) reads { attestationId, proof, publicSignals, userContextData }
//   and returns { valid, nullifier }:
//     • validity  = result.isValidDetails.isValid     (VerificationResult type)
//     • NULLIFIER = result.discloseOutput.nullifier    (GenericDiscloseOutput.nullifier)
//   — confirmed against @selfxyz/core@1.2.0-beta.1 dist/index.d.ts.
function realSelfVerifier(config = {}) {
  let core;
  try { core = require('@selfxyz/core'); }
  catch (e) {
    throw new Error('Self gate enabled but @selfxyz/core is not installed. Run: npm i @selfxyz/core@">=1.1.0-beta.1"');
  }
  const { SelfBackendVerifier, AllIds, DefaultConfigStore } = core;
  const {
    scope    = process.env.SELF_SCOPE    || 'money-app',
    endpoint = process.env.SELF_ENDPOINT || 'https://api.moneyforeveryone.app/ignite/self',
    allowedIds  = AllIds,                                  // accept all supported document types
    configStore = new DefaultConfigStore({}),              // empty policy: personhood only, no extra disclosure
    userIdType  = 'hex',                                   // M_ wallet identifiers are hex
  } = config;

  const verifier = new SelfBackendVerifier(
    scope, endpoint,
    true,                 // mockPassport = true  → MOCK MODE (staging/testnet)
    allowedIds, configStore, userIdType
  );

  return {
    async verify(payload) {
      const p = payload || {};
      const r = await verifier.verify(p.attestationId, p.proof, p.publicSignals, p.userContextData);
      const valid     = !!(r && r.isValidDetails && r.isValidDetails.isValid);
      const nullifier = r && r.discloseOutput && r.discloseOutput.nullifier;
      return { valid, nullifier: nullifier != null ? String(nullifier) : undefined };
    },
  };
}

module.exports = { createSelfGate, createNullifierStore, realSelfVerifier, MINT_AMOUNT, WALLET_RE };
