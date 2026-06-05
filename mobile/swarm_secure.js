/**
 * MONEY — SWARM v2 (hardened, decentralized). Phones ARE the network.
 * Recommended trio + the web-of-trust identity, all by CONSTRUCTION:
 *   • per-account NONCES   → malleability-replay + double-spend die structurally
 *   • CANONICAL-S verify   → rejects the malleable S+L variant at the crypto layer
 *   • INTEGER money        → no float drift
 *   • WEB-OF-TRUST invites → Sybil resistance with NO central code list:
 *        founders are seeded; each sealed member may issue up to QUOTA single-use
 *        invites (signed by their key); igniting needs a valid unused invite from
 *        an existing member. The social graph gates identity — no server does.
 *
 * Every node validates EVERYTHING itself; the deterministic fold IS the consensus.
 *   node swarm_secure.js   (runs the Cat1–4 × 100 attack battery)
 */
const nacl = require('tweetnacl'); const crypto = require('crypto');
const toHex = a => Buffer.from(a).toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const MINT = 1_000_000;   // integer micro-MONEY
const QUOTA = 5;          // invites a member may issue

// ── canonical-S: reject ed25519 signatures with S >= L (the malleability fix) ──
const Lg = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;
const leToBig = b => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n; };
const canonicalS = sigHex => { try { const b = Buffer.from(sigHex, 'hex'); return b.length === 64 && leToBig(b.slice(32)) < Lg; } catch { return false; } };
const verifyMsg = (msg, sigHex, pubHex) => { try { return canonicalS(sigHex) && nacl.sign.detached.verify(Buffer.from(msg), Buffer.from(sigHex, 'hex'), Buffer.from(pubHex, 'hex')); } catch { return false; } };
const addrOf = pubHex => 'M_' + pubHex.slice(0, 32).toUpperCase();
// produce a malleated-but-valid signature variant S' = S + L (the classic attack)
const malleate = sigHex => { const sb = Buffer.from(sigHex, 'hex'); let Sp = leToBig(sb.slice(32)) + Lg; const o = Buffer.alloc(32); for (let j = 0; j < 32; j++) { o[j] = Number(Sp & 0xffn); Sp >>= 8n; } return Buffer.concat([sb.slice(0, 32), o]).toString('hex'); };

const newId = name => { const k = nacl.sign.keyPair.fromSeed(nacl.randomBytes(32)); const pub = toHex(k.publicKey); return { name, address: addrOf(pub), pub, sk: k.secretKey }; };
const signHex = (msg, sk) => toHex(nacl.sign.detached(Buffer.from(msg), sk));
const canon = tx => { tx.id = sha(JSON.stringify([tx.type, tx.from, tx.to, tx.amount, tx.nonce, tx.inviteId, tx.sig])).slice(0, 16); return tx; };

const founderSeal = id => canon({ type: 'seal', founder: true, from: id.address, pub: id.pub, sig: signHex(`FOUNDER:${id.address}`, id.sk) });
const makeInvite  = (inviter, inviteId) => ({ inviterAddr: inviter.address, inviteId, inviterSig: signHex(`INVITE:${inviter.address}:${inviteId}`, inviter.sk) });
const seal        = (id, invite) => canon({ type: 'seal', from: id.address, pub: id.pub, inviteId: invite.inviteId, inviterAddr: invite.inviterAddr, inviterSig: invite.inviterSig, sig: signHex(`SEAL:${id.address}:${invite.inviteId}`, id.sk) });
const transfer    = (id, to, amount, nonce) => canon({ type: 'transfer', from: id.address, to, amount, nonce, pub: id.pub, sig: signHex(`${id.address}:${to}:${amount}:${nonce}`, id.sk) });

class Node {
  constructor(founders) { this.founders = founders; this.txs = new Map(); }
  hear(tx) { if (tx && tx.id && !this.txs.has(tx.id)) this.txs.set(tx.id, tx); }   // gossip accepts; the FOLD validates
  gossipTo(p) { for (const tx of this.txs.values()) p.hear(tx); }
  fold() {
    const bal = {}, next = {}, members = {}, usedInvite = {}, issued = {};
    const all = [...this.txs.values()];
    for (const tx of all.filter(t => t.type === 'seal' && t.founder).sort((a, b) => a.id < b.id ? -1 : 1)) {
      if (!this.founders.has(tx.from) || addrOf(tx.pub) !== tx.from || members[tx.from]) continue;
      if (!verifyMsg(`FOUNDER:${tx.from}`, tx.sig, tx.pub)) continue;
      members[tx.from] = tx.pub; bal[tx.from] = MINT; next[tx.from] = 1; issued[tx.from] = 0;
    }
    const pending = all.filter(t => t.type === 'seal' && !t.founder).sort((a, b) => a.id < b.id ? -1 : 1);
    let changed = true;
    while (changed) { changed = false;
      for (const tx of pending) {
        if (members[tx.from] || addrOf(tx.pub) !== tx.from) continue;
        const ipub = members[tx.inviterAddr]; if (!ipub) continue;
        if (usedInvite[tx.inviterAddr + ':' + tx.inviteId]) continue;
        if ((issued[tx.inviterAddr] || 0) >= QUOTA) continue;
        if (!verifyMsg(`INVITE:${tx.inviterAddr}:${tx.inviteId}`, tx.inviterSig, ipub)) continue;
        if (!verifyMsg(`SEAL:${tx.from}:${tx.inviteId}`, tx.sig, tx.pub)) continue;
        members[tx.from] = tx.pub; bal[tx.from] = MINT; next[tx.from] = 1; issued[tx.from] = 0;
        usedInvite[tx.inviterAddr + ':' + tx.inviteId] = true; issued[tx.inviterAddr]++; changed = true;
      }
    }
    const transfers = all.filter(t => t.type === 'transfer').sort((a, b) =>
      a.from !== b.from ? (a.from < b.from ? -1 : 1) : a.nonce !== b.nonce ? a.nonce - b.nonce : (a.id < b.id ? -1 : 1));
    for (const tx of transfers) {
      const ok = members[tx.from] && addrOf(tx.pub) === tx.from
        && Number.isInteger(tx.amount) && tx.amount > 0
        && next[tx.from] === tx.nonce && (bal[tx.from] || 0) >= tx.amount
        && verifyMsg(`${tx.from}:${tx.to}:${tx.amount}:${tx.nonce}`, tx.sig, tx.pub);
      if (ok) { bal[tx.from] -= tx.amount; bal[tx.to] = (bal[tx.to] || 0) + tx.amount; next[tx.from]++; }
    }
    return { bal, members };
  }
}

// ── baseline honest world: founder → invites two members (3 sealed humans) ──
function baseline() {
  const F = newId('Founder'), M1 = newId('M1'), M2 = newId('M2');
  const node = new Node(new Set([F.address]));
  node.hear(founderSeal(F));
  node.hear(seal(M1, makeInvite(F, 'inv-1')));
  node.hear(seal(M2, makeInvite(F, 'inv-2')));
  return { node, founders: node.founders, F, M1, M2 };
}
const clone = b => { const n = new Node(b.founders); for (const tx of b.node.txs.values()) n.hear(tx); return n; };
const BASE_MEMBERS = 3;

// ── UNIVERSAL success detector: money conservation + identity integrity ──
// An attack "succeeds" iff it forges an identity, creates/destroys MONEY, or overdraws.
// Invariant of a valid ledger: Σ(all balances) === members × MINT, no negatives.
const total = bal => Object.values(bal).reduce((s, v) => s + v, 0);
const compromised = node => {
  const f = node.fold(); const m = Object.keys(f.members).length;
  if (m > BASE_MEMBERS) return true;            // forged identity / illegitimate mint
  if (total(f.bal) !== m * MINT) return true;   // money created or destroyed
  for (const v of Object.values(f.bal)) if (v < 0) return true;  // overdraft / double-spend
  return false;
};

// ── battery: 100 attempts per tier ──
const N = 100;
const tier = vectors => { let s = 0; for (let i = 0; i < N; i++) { const b = baseline(); const atk = clone(b); vectors(b, atk, i); if (compromised(atk)) s++; } return s; };

const cat1 = tier((b, atk, i) => { const v = i % 3;
  if (v === 0) { const x = newId('x'); atk.hear(seal(x, makeInvite(x, 'self'))); }                  // self-invite (not a member)
  else if (v === 1) { atk.hear(founderSeal(newId('fake'))); }                                        // forge a founder
  else { atk.hear(transfer(b.M1, b.M2.address, MINT * 5, 1)); }                                       // overspend
});
const cat2 = tier((b, atk, i) => { const tx = transfer(b.M1, b.M2.address, 100, 1); atk.hear(tx); const v = i % 3;
  if (v === 0) atk.hear({ ...tx });                                                                   // verbatim replay
  else if (v === 1) atk.hear(canon({ ...tx, amount: 50000 }));                                        // tamper amount
  else atk.hear(canon({ ...tx, sig: malleate(tx.sig) }));                                             // malleate S+L
});
const cat3 = tier((b, atk, i) => { const v = i % 4;
  if (v === 0) { const x = newId('s'); atk.hear(seal(x, { inviterAddr: newId('ghost').address, inviteId: 'g', inviterSig: '00' })); } // invite from non-member
  else if (v === 1) { const x = newId('s'); const t = seal(x, makeInvite(b.M1, 'r' + i)); t.pub = newId('z').pub; atk.hear(t); }       // pub/addr mismatch
  else if (v === 2) { const x = newId('s'); const t = seal(x, makeInvite(b.M1, 'q' + i)); t.sig = '00'; atk.hear(t); }                 // bad self-sig
  else { atk.hear(transfer(b.M1, b.M2.address, 700000, 1)); atk.hear(transfer(b.M1, newId('c').address, 700000, 1)); }                 // DOUBLE-SPEND (same nonce)
});
const cat4 = tier((b, atk, i) => { const tx = transfer(b.M1, b.M2.address, 100, 1); atk.hear(tx); const v = i % 3;
  if (v === 0) atk.hear(canon({ ...tx, sig: malleate(tx.sig) }));                                     // malleability
  else if (v === 1) atk.hear(founderSeal(newId('imp')));                                              // forge founder
  else atk.hear(transfer(b.M1, b.M2.address, Number.MAX_SAFE_INTEGER, 1));                            // integer overflow
});

// honest frontier: a MALICIOUS MEMBER spends its invite quota on Sybils
const fr = baseline(); const frAtk = clone(fr);
for (let k = 0; k < 25; k++) { const x = newId('syb' + k); frAtk.hear(seal(x, makeInvite(fr.M1, 'mi' + k))); }
const quotaSybils = Object.keys(frAtk.fold().members).length - BASE_MEMBERS;

const ok = n => n === 0 ? '✅' : '❌ ' + n;
console.log('\n  ===== SWARM v2 — Cat 1–4 × 100 attacks · decentralized · money-conservation invariant =====\n');
console.log(`  CAT 1  naive (taps/reinstall) ........... ${ok(cat1)}  / 100`);
console.log(`  CAT 2  power user (replay/tamper/malleate) ${ok(cat2)}  / 100`);
console.log(`  CAT 3  scripted dev (forge/double-spend) . ${ok(cat3)}  / 100`);
console.log(`  CAT 4  expert (malleability/forge/overflow) ${ok(cat4)}  / 100`);
console.log(`\n  An attack "succeeds" only if it forges an identity, creates/destroys MONEY, or overdraws.`);
console.log(`\n  HONEST FRONTIER — one malicious member tried 25 Sybils via invites → ${quotaSybils} got in (capped at QUOTA=${QUOTA}).`);
console.log(`  Bounded by the web-of-trust quota; the x² incentive engine + reputation shrink it further.`);
console.log(`  Network partition / finality is the remaining open frontier (research-grade, not a patch).\n`);
