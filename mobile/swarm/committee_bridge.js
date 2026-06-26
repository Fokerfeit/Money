// mobile/swarm/committee_bridge.js — BRICK 2 (Bite 1): bridge MONEY transactions
// onto the swarm committee, single process.
//
// ADDITIVE. Imports the swarm engine read-only; changes no money rule, no central
// write path, no Brick 1 chain, no Self gate. It runs a simulated N-member BFT
// committee BESIDE central and proves the two AGREE on every balance.
//
// THE MAPPING (MONEY tx  ↔  swarm message):
//   • FAUCET mint  {from:'FAUCET', to:X, amount:1,000,000}   ↔  a `seal` (membership):
//     in the engine, sealing mints exactly MINT=1,000,000 to the new member — the
//     same 1,000,000 the live faucet grants — so both models start a member at 1M.
//   • transfer     {from:A, to:B, amount:N}                   ↔  the promise→accept
//     →vote→certify→apply cycle: A signs a nonce-ordered promise, B counter-signs
//     (accept), A's deterministic 5-of-7 committee votes to quorum, and fold()
//     applies it. Money moves ONLY for a quorum-certified, accepted, non-fraudulent
//     promise — the engine's BFT guarantee.
//
// SCOPE (honest): the committee validates BFT correctness (quorum + double-spend),
// NOT MONEY's standing/movement-cap policy — that policy decides which txs central
// COMMITS, and is a separate, later brick. So we drive the committee with the txs
// central accepts and prove balances match. We do NOT make the committee re-derive
// the cap (it doesn't, by design, yet).
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

// central balance = the EXACT formula in server.js (getBalance): credits − debits
// over the committed MONEY tx set. This IS the authoritative central balance.
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
  // The core claim: committee fold == central reduction, for every member.
  function reconcile() {
    const f = fold();
    const out = { agree: true, perAddress: {}, mismatches: [] };
    for (const addr of f.pool) {
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
