/**
 * MONEY — SWARM ENGINE (shared brain). Single source of truth for BOTH the
 * phone client and anything that needs to validate. Proven logic from
 * swarm_quorum.js, packaged as a module so the relay can stay dumb and the
 * phones can hold all the power.
 *
 *   • countersigned promises   (a transfer needs the receiver's signature)
 *   • deterministic committees (hash(sender+epoch) → the same 7 validators)
 *   • 5-of-7 quorum certificate (double-spend impossible up to 2 corrupt)
 *   • fraud backstop           (beyond that: convicted, voided, ejected)
 *
 * Runs in Node AND React Native unchanged: no node:crypto, no Buffer —
 * pure-JS SHA-256 (self-tested at load) + tweetnacl (already in the app).
 *
 * PERFORMANCE (the 75-second lesson):
 *   • verifyMsg is CACHED — every signature is verified exactly once, ever.
 *     Safe because a (msg, sig, pubkey) triple can never change validity.
 *   • Ledger.fold() is MEMOIZED — recomputed only when a new message arrives.
 */
const nacl = require('tweetnacl');
const CF = require('./crypto_fast');   // fastest available ed25519 (native, falls back to tweetnacl)

// ── pure-JS SHA-256 (no node:crypto — must produce identical hashes on phone & server) ──
const sha256 = (() => {
  const K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  return (input) => {
    const m = typeof input === 'string' ? strBytes(input) : input;
    const L = m.length, bitLen = L * 8;
    const padded = new Uint8Array((((L + 8) >> 6) + 1) << 6);
    padded.set(m); padded[L] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
    dv.setUint32(padded.length - 4, bitLen >>> 0);
    let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
    const W = new Uint32Array(64);
    for (let off = 0; off < padded.length; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(W[i-15],7) ^ rotr(W[i-15],18) ^ (W[i-15] >>> 3);
        const s1 = rotr(W[i-2],17) ^ rotr(W[i-2],19) ^ (W[i-2] >>> 10);
        W[i] = (W[i-16] + s0 + W[i-7] + s1) >>> 0;
      }
      let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
        const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
      }
      h0=(h0+a)>>>0; h1=(h1+b)>>>0; h2=(h2+c)>>>0; h3=(h3+d)>>>0;
      h4=(h4+e)>>>0; h5=(h5+f)>>>0; h6=(h6+g)>>>0; h7=(h7+h)>>>0;
    }
    return [h0,h1,h2,h3,h4,h5,h6,h7].map(x => x.toString(16).padStart(8,'0')).join('');
  };
})();

// byte/hex/utf8 helpers — no Buffer, identical behavior in Node and RN
const strBytes = (s) => {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.codePointAt(i);
    if (c > 0xffff) i++;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
};
const hexBytes = (hex) => { const b = new Uint8Array(hex.length >> 1); for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16); return b; };
const toHex = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0'); return s; };

// self-test at load: a wrong hash here would silently corrupt every id/committee
if (sha256('abc') !== 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  throw new Error('SHA-256 self-test failed — refusing to run with a broken hash');

const sha = sha256;
const MINT = 1_000_000, QUOTA = 5, COMMITTEE = 7;

const Lg = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;
const leToBig = b => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n; };
const canonicalS = s => { try { const b = hexBytes(s); return b.length === 64 && leToBig(b.slice(32)) < Lg; } catch { return false; } };

// ── verify cache: each (msg, sig, pub) triple is checked exactly once, ever ──
const _vcache = new Map();
const verifyMsg = (m, s, p) => {
  const k = s + '|' + p + '|' + m;
  const hit = _vcache.get(k);
  if (hit !== undefined) return hit;
  let ok;
  try { ok = canonicalS(s) && CF.verifyRaw(strBytes(m), hexBytes(s), hexBytes(p)); }
  catch { ok = false; }
  if (_vcache.size > 200_000) _vcache.clear();   // bound memory; correctness unaffected
  _vcache.set(k, ok);
  return ok;
};

const addrOf = p => 'M_' + p.slice(0, 32).toUpperCase();
const signHex = (m, sk) => toHex(CF.signRaw(strBytes(m), sk));

const newId = name => { const k = nacl.sign.keyPair.fromSeed(nacl.randomBytes(32)); const pub = toHex(k.publicKey); return { name, address: addrOf(pub), pub, sk: k.secretKey }; };

const founderSeal = id => { const sig = signHex(`FOUNDER:${id.address}`, id.sk); return { type: 'seal', founder: true, from: id.address, pub: id.pub, sig, id: sha(`F:${id.address}:${sig}`).slice(0, 16) }; };
// BOUND INVITES (protocol change, 2026-07): an invite names its redeemer and the
// inviter's signature COVERS that target address, so only the named address can
// ever produce a seal that verifies in fold() — closing both the retroactive
// same-invite contest (rival seal displacing an admitted member by hash order)
// and interception (a stolen invite is unredeemable by the thief). The binding
// lives entirely in the signature: the seal tx format is unchanged, and fold()
// verifies the invite signature against the SEALER'S OWN address (tx.from).
// Old unbound invites (signed without a target) no longer verify — clean break.
const makeInvite  = (inv, inviteId, target) => {
  if (typeof target !== 'string' || !/^M_[0-9A-F]{32}$/.test(target)) throw new Error('makeInvite: a target M_ address is required — invites are bound to one redeemer');
  return { inviterAddr: inv.address, inviteId, target, inviterSig: signHex(`INVITE:${inv.address}:${inviteId}:${target}`, inv.sk) };
};
const seal        = (id, invite) => { const sig = signHex(`SEAL:${id.address}:${invite.inviteId}`, id.sk); return { type: 'seal', from: id.address, pub: id.pub, inviteId: invite.inviteId, inviterAddr: invite.inviterAddr, inviterSig: invite.inviterSig, sig, id: sha(`S:${id.address}:${invite.inviteId}:${sig}`).slice(0, 16) }; };

const phashOf       = p => sha(`P:${p.from}:${p.to}:${p.amount}:${p.nonce}:${p.epoch}:${p.sig}`);
const makePromise   = (id, to, amount, nonce, epoch) => { const sig = signHex(`PROMISE:${id.address}:${to}:${amount}:${nonce}:${epoch}`, id.sk); const p = { type: 'promise', from: id.address, to, amount, nonce, epoch, pub: id.pub, sig }; p.id = phashOf(p).slice(0, 16); return p; };
const acceptPromise = (recv, p) => { const ref = phashOf(p); return { type: 'accept', ref, from: recv.address, pub: recv.pub, sig: signHex(`ACCEPT:${ref}`, recv.sk), id: sha(`A:${ref}:${recv.address}`).slice(0, 16) }; };
const makeVote      = (vid, ref) => ({ type: 'vote', ref, from: vid.address, pub: vid.pub, sig: signHex(`VOTE:${ref}`, vid.sk), id: sha(`V:${ref}:${vid.address}`).slice(0, 16) });

const committeeFor = (sender, epoch, pool) => {
  const cands = pool.filter(a => a !== sender).sort();
  const C = Math.min(COMMITTEE, cands.length); const picked = []; let i = 0;
  while (picked.length < C && i < 100000) {
    const a = cands[parseInt(sha(`CMTE:${sender}:${epoch}:${i}`).slice(0, 8), 16) % cands.length];
    if (!picked.includes(a)) picked.push(a); i++;
  }
  return picked;
};
const quorumOf = n => n - Math.floor((n - 1) / 3);   // 7 -> 5
const byId = (a, b) => a.id < b.id ? -1 : 1;

// ── CHANNEL BRIDGE (Layer 1 ↔ Layer 2) ──────────────────────────────────────
// A channel is OPENED and CLOSED by committee-certified events; in between the
// two parties stream signed states off-chain (channels.js). The committee is
// deterministic on the channel id, exactly like a sender's committee.
const chanOpenHash  = o => sha(`CO:${o.cid}:${o.depositA}:${o.depositB}:${o.nonceA}:${o.nonceB}:${o.sigA}:${o.sigB}`);
const chanCloseHash = c => sha(`CC:${c.cid}:${c.finalBalA}:${c.finalBalB}:${c.version}:${c.sigA}:${c.sigB}`);

// OPEN — BOTH parties sign the same terms; each spends one nonce, so the locked
// funds compete with their normal spending and can never be double-spent.
const makeChanOpen = (A, B, depositA, depositB, nonceA, nonceB, epoch) => {
  const cid = sha(`CHID:${A.address}:${B.address}:${depositA}:${depositB}:${nonceA}:${nonceB}:${epoch}`).slice(0, 16);
  const msg = `COPEN:${cid}:${A.address}:${B.address}:${depositA}:${depositB}:${nonceA}:${nonceB}:${epoch}`;
  const sigA = signHex(msg, A.sk), sigB = signHex(msg, B.sk);
  const o = { type: 'chan_open', cid, A: A.address, B: B.address, pubA: A.pub, pubB: B.pub, depositA, depositB, nonceA, nonceB, epoch, sigA, sigB };
  o.ref = chanOpenHash(o); o.id = o.ref.slice(0, 16); return o;
};
// CLOSE — both parties sign the FINAL split + version. Highest version wins, so
// submitting a stale state is beaten by the newest co-signed one (watchtower).
const makeChanClose = (A, B, cid, finalBalA, finalBalB, version, epoch) => {
  const msg = `CCLOSE:${cid}:${finalBalA}:${finalBalB}:${version}`;
  const sigA = signHex(msg, A.sk), sigB = signHex(msg, B.sk);
  const c = { type: 'chan_close', cid, A: A.address, B: B.address, finalBalA, finalBalB, version, epoch, sigA, sigB };
  c.ref = chanCloseHash(c); c.id = c.ref.slice(0, 16); return c;
};

const _certifiedRef = (votesByRef, members, pool, cid, epoch, ref) => {
  const cmte = committeeFor(cid, epoch, pool); const q = quorumOf(cmte.length);
  const seen = new Set(); let cnt = 0;
  for (const v of votesByRef.get(ref) || []) {
    if (seen.has(v.from) || !cmte.includes(v.from)) continue;
    const vpub = members[v.from]; if (!vpub || v.pub !== vpub) continue;
    if (!verifyMsg(`VOTE:${ref}`, v.sig, vpub)) continue;
    seen.add(v.from); cnt++;
  }
  return cnt >= q;
};

class Ledger {
  constructor(founders) {
    this.founders = new Set(founders); this.txs = new Map();
    this._v = 0; this._foldV = -1; this._fold = null;   // fold memo
  }
  add(tx) { if (tx && tx.id && !this.txs.has(tx.id)) { this.txs.set(tx.id, tx); this._v++; return true; } return false; }
  has(id) { return this.txs.has(id); }
  all() { return [...this.txs.values()]; }

  fold() {
    if (this._foldV === this._v) return this._fold;     // nothing new → cached result
    const bal = {}, next = {}, members = {}, inviterOf = {}, usedInvite = {}, issued = {};
    const all = this.all();
    for (const tx of all.filter(t => t.type === 'seal' && t.founder).sort(byId)) {
      if (!this.founders.has(tx.from) || addrOf(tx.pub) !== tx.from || members[tx.from]) continue;
      if (!verifyMsg(`FOUNDER:${tx.from}`, tx.sig, tx.pub)) continue;
      members[tx.from] = tx.pub; bal[tx.from] = MINT; next[tx.from] = 1; issued[tx.from] = 0; inviterOf[tx.from] = null;
    }
    const pend = all.filter(t => t.type === 'seal' && !t.founder).sort(byId);
    let changed = true;
    while (changed) { changed = false;
      for (const tx of pend) {
        if (members[tx.from] || addrOf(tx.pub) !== tx.from) continue;
        const ipub = members[tx.inviterAddr]; if (!ipub) continue;
        if (usedInvite[tx.inviterAddr + ':' + tx.inviteId] || (issued[tx.inviterAddr] || 0) >= QUOTA) continue;
        // Bound invite: the invite signature must cover THIS sealer's address
        // (tx.from). Any seal from an address other than the invite's bound
        // target simply fails this check — rival seals for a spent invite and
        // stolen invites both die here, regardless of seal-id hash order.
        if (!verifyMsg(`INVITE:${tx.inviterAddr}:${tx.inviteId}:${tx.from}`, tx.inviterSig, ipub)) continue;
        if (!verifyMsg(`SEAL:${tx.from}:${tx.inviteId}`, tx.sig, tx.pub)) continue;
        members[tx.from] = tx.pub; bal[tx.from] = MINT; next[tx.from] = 1; issued[tx.from] = 0; inviterOf[tx.from] = tx.inviterAddr;
        usedInvite[tx.inviterAddr + ':' + tx.inviteId] = true; issued[tx.inviterAddr]++; changed = true;
      }
    }
    const pool = Object.keys(members);

    const acceptsByRef = new Map(), votesByRef = new Map();
    for (const a of all.filter(t => t.type === 'accept').sort(byId)) { if (!acceptsByRef.has(a.ref)) acceptsByRef.set(a.ref, []); acceptsByRef.get(a.ref).push(a); }
    for (const v of all.filter(t => t.type === 'vote').sort(byId)) { if (!votesByRef.has(v.ref)) votesByRef.set(v.ref, []); votesByRef.get(v.ref).push(v); }

    const valid = [];
    for (const p of all.filter(t => t.type === 'promise')) {
      if (!members[p.from] || addrOf(p.pub) !== p.from || p.pub !== members[p.from]) continue;
      if (!Number.isInteger(p.amount) || p.amount <= 0 || !Number.isInteger(p.nonce) || !Number.isInteger(p.epoch) || p.epoch < 0) continue;
      if (!verifyMsg(`PROMISE:${p.from}:${p.to}:${p.amount}:${p.nonce}:${p.epoch}`, p.sig, p.pub)) continue;
      const ph = phashOf(p); const rpub = members[p.to]; if (!rpub) continue;
      const cmte = committeeFor(p.from, p.epoch, pool); const q = quorumOf(cmte.length);
      const seen = new Set(); let cnt = 0;
      for (const v of votesByRef.get(ph) || []) {
        if (seen.has(v.from) || !cmte.includes(v.from)) continue;
        const vpub = members[v.from]; if (!vpub || v.pub !== vpub) continue;
        if (!verifyMsg(`VOTE:${ph}`, v.sig, vpub)) continue;
        seen.add(v.from); cnt++;
      }
      if (cnt < q) continue;
      const a = (acceptsByRef.get(ph) || []).find(c => c.from === p.to && c.pub === rpub && verifyMsg(`ACCEPT:${ph}`, c.sig, rpub));
      if (!a) continue;
      valid.push({ ...p, ph });
    }

    const groups = new Map();
    for (const p of valid) { const k = `${p.from}:${p.nonce}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
    const voided = new Set(), ejectedAt = {}, frauds = [], burned = new Set();
    for (const [, g] of groups) {
      const distinct = [...new Set(g.map(x => x.ph))].sort(); if (distinct.length < 2) continue;
      const cheater = g[0].from, nonce = g[0].nonce;
      ejectedAt[cheater] = Math.min(ejectedAt[cheater] ?? Infinity, nonce);
      frauds.push({ cheater, nonce, proofs: distinct.map(h => h.slice(0, 16)) });
      if (inviterOf[cheater]) burned.add(inviterOf[cheater]);
      for (const x of g) voided.add(x.ph);
    }

    // ── unified spend apply: certified promises AND certified channel opens ──
    // Both draw on the same per-account nonce + balance, so locked channel
    // funds can never also be spent as a normal payment. Fixpoint loop because
    // an open consumes TWO nonces (one from each party) at once.
    const channels = {};
    const events = [];
    for (const p of valid) if (!voided.has(p.ph) && !(p.from in ejectedAt && p.nonce >= ejectedAt[p.from]))
      events.push({ k: 'p', key: `${p.from}|${String(p.nonce).padStart(12, '0')}|${p.ph}`, p });
    for (const o of all.filter(t => t.type === 'chan_open')) {
      if (!members[o.A] || !members[o.B] || o.pubA !== members[o.A] || o.pubB !== members[o.B]) continue;
      if (![o.depositA, o.depositB, o.nonceA, o.nonceB, o.epoch].every(Number.isInteger)) continue;
      if (o.depositA < 0 || o.depositB < 0 || o.depositA + o.depositB <= 0 || o.epoch < 0) continue;
      const msg = `COPEN:${o.cid}:${o.A}:${o.B}:${o.depositA}:${o.depositB}:${o.nonceA}:${o.nonceB}:${o.epoch}`;
      if (!verifyMsg(msg, o.sigA, o.pubA) || !verifyMsg(msg, o.sigB, o.pubB)) continue;
      if (!_certifiedRef(votesByRef, members, pool, o.cid, o.epoch, chanOpenHash(o))) continue;
      events.push({ k: 'o', key: `OPEN|${o.cid}`, o });
    }
    events.sort((a, b) => a.key < b.key ? -1 : 1);

    const done = new Set(); let chg = true;
    while (chg) { chg = false;
      for (let i = 0; i < events.length; i++) {
        if (done.has(i)) continue; const e = events[i];
        if (e.k === 'p') { const p = e.p;
          if (next[p.from] === p.nonce && (bal[p.from] || 0) >= p.amount) {
            bal[p.from] -= p.amount; bal[p.to] = (bal[p.to] || 0) + p.amount; next[p.from]++; done.add(i); chg = true; }
        } else { const o = e.o;
          if (!channels[o.cid] && next[o.A] === o.nonceA && next[o.B] === o.nonceB && (bal[o.A] || 0) >= o.depositA && (bal[o.B] || 0) >= o.depositB) {
            bal[o.A] -= o.depositA; bal[o.B] -= o.depositB; next[o.A]++; next[o.B]++;
            channels[o.cid] = { cid: o.cid, A: o.A, B: o.B, total: o.depositA + o.depositB, state: 'open' }; done.add(i); chg = true; }
        }
      }
    }

    // ── channel closes: highest-version, both-signed, committee-certified wins ──
    for (const cid of Object.keys(channels)) {
      const ch = channels[cid]; if (ch.state !== 'open') continue; let best = null;
      for (const c of all.filter(t => t.type === 'chan_close' && t.cid === cid)) {
        if (c.A !== ch.A || c.B !== ch.B) continue;
        if (![c.finalBalA, c.finalBalB, c.version, c.epoch].every(Number.isInteger)) continue;
        if (c.finalBalA < 0 || c.finalBalB < 0 || c.finalBalA + c.finalBalB !== ch.total) continue;
        const msg = `CCLOSE:${cid}:${c.finalBalA}:${c.finalBalB}:${c.version}`;
        if (!verifyMsg(msg, c.sigA, members[ch.A]) || !verifyMsg(msg, c.sigB, members[ch.B])) continue;
        if (!_certifiedRef(votesByRef, members, pool, cid, c.epoch, chanCloseHash(c))) continue;
        if (!best || c.version > best.version) best = c;
      }
      if (best) { bal[ch.A] = (bal[ch.A] || 0) + best.finalBalA; bal[ch.B] = (bal[ch.B] || 0) + best.finalBalB; ch.state = 'closed'; ch.final = { A: best.finalBalA, B: best.finalBalB, version: best.version }; }
    }
    const locked = Object.values(channels).reduce((s, c) => s + (c.state === 'open' ? c.total : 0), 0);

    this._fold = { bal, next, members, pool, frauds, ejectedAt, channels, locked };
    this._foldV = this._v;
    return this._fold;
  }

  hash() { const { bal } = this.fold(); return sha(Object.keys(bal).sort().map(a => `${a}:${bal[a]}`).join('|')).slice(0, 10); }

  votesFor(p) {
    const { members, pool } = this.fold(); const ph = phashOf(p);
    const cmte = committeeFor(p.from, p.epoch, pool); const seen = new Set(); let cnt = 0;
    for (const v of this.all().filter(t => t.type === 'vote' && t.ref === ph)) {
      if (seen.has(v.from) || !cmte.includes(v.from)) continue;
      const vpub = members[v.from]; if (!vpub || v.pub !== vpub) continue;
      if (!verifyMsg(`VOTE:${ph}`, v.sig, vpub)) continue;
      seen.add(v.from); cnt++;
    }
    return { votes: cnt, quorum: quorumOf(cmte.length), committee: cmte };
  }
  certified(p) { const r = this.votesFor(p); return r.votes >= r.quorum; }
}

module.exports = {
  MINT, QUOTA, COMMITTEE, nacl, toHex, hexBytes, strBytes, sha, sha256, addrOf, verifyMsg, signHex,
  verifyRaw: CF.verifyRaw, signRaw: CF.signRaw, cryptoBackend: CF.backend,
  newId, founderSeal, makeInvite, seal,
  phashOf, makePromise, acceptPromise, makeVote,
  makeChanOpen, makeChanClose, chanOpenHash, chanCloseHash,
  committeeFor, quorumOf, Ledger,
};
