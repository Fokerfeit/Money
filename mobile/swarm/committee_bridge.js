// mobile/swarm/committee_bridge.js — BRICK 2 (Bite 1): bridge MONEY transactions
// onto the swarm committee, single process.
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
// SCOPE (honest) — two boundaries this brick deliberately does NOT cross:
//   1. STANDING / MOVEMENT-CAP: the committee validates BFT correctness (quorum +
//      double-spend), NOT MONEY's standing/movement-cap policy. That policy decides
//      which txs central COMMITS; we drive the committee with the txs central
//      accepts and prove balances match. We do NOT make the committee re-derive the
//      cap (it doesn't, by design, yet — a later brick).
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

function createBridge({ founders, epoch = 0 } = {}) {
  if (!Array.isArray(founders) || founders.length === 0) throw new Error('createBridge: founders[] required');
  const ledger = new Ledger(founders.map((f) => f.address));
  const idByAddr = new Map();                 // address → identity (with sk) — needed to sign
  const moneyTxs = [];                        // the MONEY transaction set (drives central)
  const nextNonce = new Map();                // address → next nonce to assign (mirrors fold's `next`)
  const sealedSet = new Set();
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

  // ── high-level: a fully-certified payment recorded in both models ────────────
  const pay = (fromAddr, toAddr, amount) => promise(fromAddr, toAddr, amount);

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
    ledger, epoch, FAUCET,
    sealMember, register, promise, pay,
    fold, members, committeeBalanceOf, centralBalance, reconcile,
    get moneyTxs() { return moneyTxs.slice(); },
    idByAddr,
  };
}

module.exports = { createBridge, mkIdentity, centralBalanceOf, MINT, FAUCET };
