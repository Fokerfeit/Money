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

// ── Nullifier store (persistence-injected, FAIL-CLOSED) ──────────────────────
// Records nullifier → wallet. `storage` is { load(): map|throws, save(map): void }.
// The server backs it with safe_store (atomic write, fail-closed load); a test backs
// it with a plain object. Crucially, storage.load() must THROW on corruption rather
// than return {} — corruption ≠ first boot — so a damaged store can never silently
// reset and free a used nullifier to mint again. A THROW propagates to the caller,
// which refuses to enable the gate. A nullifier, once sealed, can never be re-sealed.
function createNullifierStore(storage) {
  let map = storage.load();                          // may THROW (fail-closed) — do NOT swallow
  if (!map || typeof map !== 'object') map = {};
  function persist() { storage.save(map); }
  const has = (n) => Object.prototype.hasOwnProperty.call(map, n);
  return {
    has,
    get:  (n) => (has(n) ? map[n] : null),
    size: () => Object.keys(map).length,
    // Seal ONLY if unused — returns false on a repeat so the caller can never
    // overwrite an existing binding (defence in depth behind the gate's own check).
    seal: (n, wallet) => {
      if (has(n)) return false;
      map[n] = wallet; persist(); return true;       // persist is atomic (safe_store)
    },
    all:     () => ({ ...map }),
    entries: () => Object.entries(map),              // for repairPending() crash recovery
    reload:  () => { const m = storage.load(); map = (m && typeof m === 'object') ? m : {}; return map; },
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

    // 2b) WALLET BINDING — the proof names the wallet it was issued for (self_qr.js
    //     put it in userDefinedData, and the circuit hashes it). Without this check a
    //     genuine proof could be replayed with a swapped `wallet` field, redirecting
    //     someone else's one-and-only ignition. Checked BEFORE the seal, which is
    //     irreversible. A verifier that reports no bound wallet is refused, not trusted.
    const bound = result && result.boundWallet;
    if (typeof bound !== 'string' || !bound)
      return { ok: false, code: 'no-bound-wallet', reason: 'Verified proof carried no bound wallet' };
    if (bound.trim().toUpperCase() !== wallet)
      return { ok: false, code: 'wallet-mismatch', reason: 'This proof was issued for a different wallet' };

    // 3) SYBIL CORE — one nullifier = one ignition. A second proof from the SAME
    //    human (same nullifier) is rejected even if it targets a fresh wallet.
    if (store.has(nullifier))
      return { ok: false, code: 'nullifier-used', reason: 'This person has already ignited a wallet', boundTo: store.get(nullifier) };

    // 4) Never double-mint to a wallet that already ignited via ANY path
    //    (mirrors the invite-code faucet's one-claim-per-address gate).
    if (typeof ledger.isIgnited === 'function' && ledger.isIgnited(wallet))
      return { ok: false, code: 'wallet-ignited', reason: 'This wallet has already been ignited' };

    const amt = amount;
    if (!Number.isInteger(amt) || amt <= 0)
      return { ok: false, code: 'bad-amount', reason: 'mint amount must be a positive integer' };

    // 5) SEAL the nullifier FIRST — crash-safe / fail-closed. A durable seal BEFORE
    //    the mint means a crash between the two leaves the nullifier used but the
    //    wallet unminted → repairPending() completes the mint once on boot, and NO
    //    second wallet can ever claim this nullifier. (Seal-AFTER-mint had the
    //    opposite, dangerous failure: a crash after the mint but before the seal
    //    freed the nullifier to mint a SECOND time.) The seal write is atomic; if it
    //    cannot be durably persisted we refuse to mint at all.
    try {
      if (!store.seal(nullifier, wallet))
        return { ok: false, code: 'nullifier-used', reason: 'This person has already ignited a wallet', boundTo: store.get(nullifier) };
    } catch (e) {
      return { ok: false, code: 'seal-failed', reason: 'could not durably record the nullifier — mint refused' };
    }

    // 6) MINT via the SAME FAUCET mechanism: a from:'FAUCET' tx of exactly `amount`,
    //    committed through the ledger's single write path. Integer money.
    const ts = now();
    const tx = {
      from: 'FAUCET', to: wallet, amount: amt,
      reason: 'self_ignition',
      time: new Date(ts).toLocaleTimeString(),
      timestamp: ts,
      sigPrefix: null,                       // gate-minted: no user signature to record
    };
    ledger.commit(tx);                       // append + index + persist — identical to the faucet path

    return { ok: true, nullifier, wallet, amount: amt, tx };
  }

  return { claim };
}

// ── repairPending: crash recovery for the seal-before-mint order ─────────────
// A claim seals the nullifier, then mints. A crash between the two leaves a sealed
// nullifier whose wallet is NOT yet ignited. On boot, complete each such pending
// mint EXACTLY ONCE. Idempotent: a wallet already ignited is skipped, so running it
// repeatedly (or after a clean boot) mints nothing — no double-mint, no free re-mint.
function repairPending(ledger, store, { amount = MINT_AMOUNT, now = () => Date.now() } = {}) {
  if (!ledger || typeof ledger.commit !== 'function' || typeof ledger.isIgnited !== 'function') return 0;
  if (!store || typeof store.entries !== 'function') return 0;
  let repaired = 0;
  for (const [, wallet] of store.entries()) {
    if (ledger.isIgnited(wallet)) continue;          // already minted → idempotent skip
    const ts = now();
    ledger.commit({
      from: 'FAUCET', to: wallet, amount,
      reason: 'self_ignition',                        // indistinguishable from a normal Self mint
      time: new Date(ts).toLocaleTimeString(), timestamp: ts, sigPrefix: null,
    });
    repaired++;
  }
  return repaired;
}

// ── auditSeals: the HUMAN-keyed backstop against a dropped seal ───────────────
// The per-mint check (ledger.isIgnited) is per-WALLET, so a nullifier whose seal was
// LOST (corruption, a stale-.bak recovery) could mint AGAIN to a fresh wallet. The
// durable money record catches it: every self_ignition FAUCET mint MUST have a
// nullifier binding pointing at it. A minted wallet with NO backing seal means a seal
// was dropped → that nullifier is silently re-mintable. Returns the orphan wallets;
// the caller REFUSES to enable the gate rather than proceed (fail-closed, not re-mint).
function auditSeals(ledger, store) {
  if (!ledger || typeof ledger.all !== 'function' || !store || typeof store.entries !== 'function') return [];
  const sealedWallets = new Set(store.entries().map(([, w]) => w));
  const orphans = [];
  for (const t of ledger.all()) {
    if (t && t.from === 'FAUCET' && t.reason === 'self_ignition' && !sealedWallets.has(t.to) && !orphans.includes(t.to))
      orphans.push(t.to);
  }
  return orphans;   // minted-but-unsealed self_ignition wallets → a seal was lost
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
    // Default is PRODUCTION (real passports). SELF_MOCK=1 opts into mock mode for
    // testnet drills (T0-T2); leaving it unset is what lets a real scan verify (T3).
    mockPassport = process.env.SELF_MOCK === '1',
  } = config;

  const verifier = new SelfBackendVerifier(
    scope, endpoint,
    mockPassport,         // env-driven: SELF_MOCK=1 → mock (staging), unset → production
    allowedIds, configStore, userIdType
  );

  return {
    async verify(payload) {
      const p = payload || {};
      const r = await verifier.verify(p.attestationId, p.proof, p.publicSignals, p.userContextData);
      const valid     = !!(r && r.isValidDetails && r.isValidDetails.isValid);
      const nullifier = r && r.discloseOutput && r.discloseOutput.nullifier;
      // boundWallet is the M_ mark self_qr.js baked into userDefinedData. It is a
      // hashed public signal of the proof, so it cannot be swapped in flight; the
      // gate compares it to the wallet being ignited and refuses on a mismatch.
      const boundWallet = r && r.userData && r.userData.userDefinedData;
      return {
        valid,
        nullifier:   nullifier   != null ? String(nullifier)   : undefined,
        boundWallet: boundWallet != null ? String(boundWallet) : undefined,
      };
    },
  };
}

module.exports = { createSelfGate, createNullifierStore, realSelfVerifier, repairPending, auditSeals, MINT_AMOUNT, WALLET_RE };
