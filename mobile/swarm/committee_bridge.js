// mobile/swarm/committee_bridge.js — BRICK 2: bridge MONEY transactions onto the
// swarm committee, single process.
//   • Bite 1: drive txs through the committee and prove committee balances == central.
//   • Bite 2: createBridge({enforceCap:true}) makes the committee ENFORCE the STANDING
//     movement cap itself — dynamic, per-tx, identical math to central (default off,
//     so Bite 1 behavior is byte-identical for already-valid transactions).
//
// ADDITIVE. Imports the swarm engine read-only; changes no money rule, no central
// write path, no Brick 1 chain, no Self gate. It runs a simulated N-member BFT
// committee BESIDE central and proves the two AGREE on every balance.
//
// THE MAPPING (MONEY tx  ↔  swarm message):
//   • FAUCET mint  {from:'FAUCET', to:X, amount:1,000,000}   ↔  a `seal` (membership):
//     in the engine, sealing mints exactly MINT=1,000,000 to the new member, which
//     equals a faucet/Self-gate grant IN THE FIXED-1M REGIME (see SCOPE) — so both
//     models start a member at 1M.
//   • transfer     {from:A, to:B, amount:N}                   ↔  the promise→accept
//     →vote→certify→apply cycle: A signs a nonce-ordered promise, B counter-signs
//     (accept), A's deterministic 5-of-7 committee votes to quorum, and fold()
//     applies it. Money moves ONLY for a quorum-certified, accepted, non-fraudulent
//     promise — the engine's BFT guarantee.
//
// SCOPE (honest) — what this brick does and the boundaries it does NOT cross:
//   1. STANDING / MOVEMENT-CAP: Bite 2 makes the committee ENFORCE the cap (refuse to
//      certify an over-cap promise), dynamically per-tx, with central's exact math —
//      a RULE ported into the committee. Still single-process and NOT multi-node, and
//      NOT flipping real money onto committee authority (that's the live Phase-4
//      human-audit gate). This de-risks authority before distribution.
//   2. FAUCET REWARD DECAY: the seal↔mint 1:1 equality assumes the fixed-1M regime —
//      Self-gate ignition, or the faucet while userCount < 1,000,000. The live
//      server's calcReward decays ×0.8 per 1,000,000 users (so at 1e6 users a mint
//      is 800,000, not 1,000,000), while the engine MINT is hard-coded 1,000,000.
//      This brick stays in the pre-decay regime; beyond it, a seal would over-credit
//      vs the decayed central mint and the models would diverge by design.
'use strict';

const E = require('./swarm_engine');
const { MINT, Ledger, founderSeal, makeInvite, seal, makePromise, acceptPromise,
        makeVote, phashOf, committeeFor, quorumOf, addrOf, toHex, nacl } = E;

const FAUCET = 'FAUCET';

// Deterministic identity from a label — reproducible keys → reproducible committees
// → reproducible fold (the determinism probe depends on this). Shape matches the
// engine's identities ({name,address,pub,sk}); the 64-byte tweetnacl secret signs
// BOTH committee messages (CF.signRaw) and central txs (nacl.sign.detached).
function mkIdentity(label) {
  const seed = hashSeed(label);                // deterministic 32-byte seed
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const pub = toHex(kp.publicKey);
  return { name: label, address: addrOf(pub), pub, sk: kp.secretKey };
}
// 32-byte seed = first 32 bytes of the engine's SHA-256 of the label (hex → bytes).
function hashSeed(label) {
  const hex = E.sha256(label);                 // 64 hex chars = 32 bytes
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
  return b;
}

// central balance = server.js getBalance's EXACT formula — credits − debits over the
// committed MONEY tx set. This matches the authoritative central balance FOR THE TXS
// CENTRAL ACCEPTS; the cap/validation gate that decides WHICH txs commit is a
// separate brick (see SCOPE), so feed this only txs central would commit.
function centralBalanceOf(txs, addr) {
  return txs.reduce((b, t) => (t.to === addr ? b + t.amount : t.from === addr ? b - t.amount : b), 0);
}

// ── BRICK 2 (Bite 2): the STANDING movement cap, computed IDENTICALLY to central ──
// server.js: standingOf = (isIgnited?5:0) + distinctCounterparties; movableNow =
// min(balance, standing × 10000). distinctCounterparties = unique addresses traded
// with, EXCLUDING FAUCET and self, as a Set (ping-pong with one party stays 1).
const IGNITED_BASELINE  = 5;        // server.js IGNITED_BASELINE
const MOVE_PER_STANDING = 10000;    // server.js MOVE_PER_STANDING
// VERBATIM port of server.js distinctCounterparties: a Set over the committed tx set,
// excluding FAUCET and self, counting BOTH a tx's sender and recipient as the other
// party's counterparty (so receiving raises standing too).
function distinctCounterparties(txs, addr) {
  const seen = new Set();
  for (const t of txs) {
    if (t.from === addr && t.to !== FAUCET && t.to !== addr) seen.add(t.to);
    if (t.to === addr && t.from !== FAUCET && t.from !== addr) seen.add(t.from);
  }
  return seen.size;
}
const isIgnitedOf = (txs, addr) => txs.some((t) => t.from === FAUCET && t.to === addr);
const standingOf  = (txs, addr) => (isIgnitedOf(txs, addr) ? IGNITED_BASELINE : 0) + distinctCounterparties(txs, addr);

// enforceCap (Bite 2): when true, pay() makes the committee's validation REFUSE a
// promise whose amount exceeds the sender's movableNow — computed dynamically from
// the committee's OWN certified state at that point (current fold balance + distinct
// counterparties over the certified-transfer set), exactly as central does per tx.
// Default false → Bite 1 behavior is byte-identical (already-valid txs unchanged).
function createBridge({ founders, epoch = 0, enforceCap = false } = {}) {
  if (!Array.isArray(founders) || founders.length === 0) throw new Error('createBridge: founders[] required');
  const ledger = new Ledger(founders.map((f) => f.address));
  const idByAddr = new Map();                 // address → identity (with sk) — needed to sign
  const moneyTxs = [];                        // the MONEY transaction set (drives central) = the committee's certified transfers + seals
  const nextNonce = new Map();                // address → next nonce to assign (mirrors fold's `next`)
  const sealedSet = new Set();
  const attempts = [];                        // ordered log of pay() attempts: {from,to,amount,admitted,reason}
  founders.forEach((f) => idByAddr.set(f.address, f));

  const register = (id) => { idByAddr.set(id.address, id); };

  // ── membership: seal a member and mint its 1,000,000 in BOTH models ──────────
  function sealMember(id, opts = {}) {
    register(id);
    if (opts.inviter) {
      const inv = makeInvite(opts.inviter, opts.inviteId);
      ledger.add(seal(id, inv));
    } else {
      ledger.add(founderSeal(id));            // founder membership
    }
    // central side: the matching FAUCET mint of exactly MINT (one per member)
    moneyTxs.push({ from: FAUCET, to: id.address, amount: MINT, reason: 'seal' });
    nextNonce.set(id.address, 1);             // engine sets next=1 after a seal
    sealedSet.add(id.address);
    return id;
  }

  // ── low-level spend: drive one promise through the committee ─────────────────
  // opts.nonce   — override the auto-assigned nonce (for the double-spend probe)
  // opts.voters  — addresses that vote (default: the FULL deterministic committee)
  // opts.accept  — receiver counter-signs (default true)
  // opts.record  — also append the MONEY tx for central (default true)
  function promise(fromAddr, toAddr, amount, opts = {}) {
    const fromId = idByAddr.get(fromAddr), toId = idByAddr.get(toAddr);
    if (!fromId || !toId) throw new Error(`promise: unknown identity ${fromAddr}→${toAddr}`);
    const useAuto = opts.nonce === undefined;
    const nonce = useAuto ? (nextNonce.get(fromAddr) || 1) : opts.nonce;
    const p = makePromise(fromId, toAddr, amount, nonce, epoch);
    ledger.add(p);
    if (opts.accept !== false) ledger.add(acceptPromise(toId, p));
    const pool = ledger.fold().pool;
    const cmte = committeeFor(fromAddr, epoch, pool);
    const voters = opts.voters || cmte;
    const ref = phashOf(p);
    for (const v of voters) { if (cmte.includes(v) && idByAddr.get(v)) ledger.add(makeVote(idByAddr.get(v), ref)); }
    if (useAuto) nextNonce.set(fromAddr, nonce + 1);
    if (opts.record !== false) moneyTxs.push({ from: fromAddr, to: toAddr, amount, reason: opts.reason || null });
    return { promise: p, ref, committee: cmte, quorum: quorumOf(cmte.length), votes: (opts.voters || cmte).filter((v) => cmte.includes(v)).length };
  }

  // ── committee STANDING cap (Bite 2) ──────────────────────────────────────────
  // The committee's view of standing/movable, computed at the CURRENT point in
  // replay: balance from the committee's own fold(), counterparties from the
  // certified-transfer set (moneyTxs minus seals — FAUCET is excluded by the
  // formula). Identical math to central; proven equal by the parity probes.
  const committeeStandingOf = (addr) => standingOf(moneyTxs, addr);
  const committeeMovableNow = (addr) => Math.min(fold().bal[addr] || 0, committeeStandingOf(addr) * MOVE_PER_STANDING);

  // ── high-level payment ───────────────────────────────────────────────────────
  // With enforceCap, the committee REFUSES (does not certify/apply) an over-cap or
  // over-balance promise — recorded as a rejected attempt, no nonce consumed, no
  // state change — exactly as central 403s/400s it. Within-cap → admitted via the
  // Bite 1 path (unchanged). Cap is evaluated against the state BEFORE this tx, so a
  // tx's own counterparty is not yet counted (matches central's per-tx evaluation).
  function pay(fromAddr, toAddr, amount) {
    if (enforceCap) {
      const bal = fold().bal[fromAddr] || 0;                 // central checks balance first (400)
      if (amount > bal) { attempts.push({ from: fromAddr, to: toAddr, amount, admitted: false, reason: 'balance' }); return { ok: false, admitted: false, reason: 'balance', movable: committeeMovableNow(fromAddr), standing: committeeStandingOf(fromAddr) }; }
      const cap = committeeStandingOf(fromAddr) * MOVE_PER_STANDING;  // then the standing cap (403)
      if (amount > cap) { attempts.push({ from: fromAddr, to: toAddr, amount, admitted: false, reason: 'cap' }); return { ok: false, admitted: false, reason: 'cap', movable: committeeMovableNow(fromAddr), standing: committeeStandingOf(fromAddr) }; }
    }
    const r = promise(fromAddr, toAddr, amount);             // admit (Bite 1 path — certify + apply)
    attempts.push({ from: fromAddr, to: toAddr, amount, admitted: true, reason: null });
    return { ok: true, admitted: true, ...r };
  }

  // ── views ────────────────────────────────────────────────────────────────────
  const fold = () => ledger.fold();
  const members = () => fold().pool.slice();
  const committeeBalanceOf = (addr) => (fold().bal[addr] || 0);
  const centralBalance = (addr) => centralBalanceOf(moneyTxs, addr);
  // The core claim: committee fold == central reduction, for EVERY address — not
  // just sealed members. We iterate the union of the committee pool and every
  // address appearing in the MONEY tx set (minus FAUCET), so a credit to a
  // non-member "ghost" recipient (which central counts but the committee withholds,
  // since the engine only applies to sealed recipients) is flagged DIRECTLY on the
  // recipient, not merely incidentally via the sender's debit.
  function reconcile() {
    const f = fold();
    const addrs = new Set(f.pool);
    for (const t of moneyTxs) { if (t.from !== FAUCET) addrs.add(t.from); if (t.to !== FAUCET) addrs.add(t.to); }
    const out = { agree: true, perAddress: {}, mismatches: [] };
    for (const addr of addrs) {
      const c = centralBalance(addr), k = f.bal[addr] || 0;
      out.perAddress[addr] = { committee: k, central: c, equal: c === k };
      if (c !== k) { out.agree = false; out.mismatches.push({ addr, committee: k, central: c }); }
    }
    return out;
  }

  return {
    ledger, epoch, FAUCET, enforceCap,
    sealMember, register, promise, pay,
    fold, members, committeeBalanceOf, centralBalance, reconcile,
    committeeStandingOf, committeeMovableNow,
    get moneyTxs() { return moneyTxs.slice(); },
    get attempts() { return attempts.slice(); },
    get rejected() { return attempts.filter((a) => !a.admitted); },
    idByAddr,
  };
}

module.exports = {
  createBridge, mkIdentity, centralBalanceOf, distinctCounterparties, standingOf,
  MINT, FAUCET, IGNITED_BASELINE, MOVE_PER_STANDING,
};
