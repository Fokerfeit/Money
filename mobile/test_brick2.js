// test_brick2.js — BRICK 2 (Bite 1): committee bridge. Every probe must pass; exit 0.
//   1 MEMBERSHIP+MINT   2 SINGLE TRANSFER   3 CHAIN   4 FAN-OUT/FAN-IN
//   5 INVITED MEMBER    6 QUORUM ENFORCED   7 DOUBLE-SPEND CAUGHT   8 DETERMINISM
//   8b NON-MEMBER RECIPIENT (reconcile covers every address, not just members)
//   9 REAL-SERVER AGREEMENT (committee == central reduction == live /balance)
//  10 REGRESSION (Self gate -> Brick 1 -> Phase 0-3 still exit 0)
//
// The core claim: drive MONEY transactions through the swarm committee's
// promise->accept->vote->certify->apply cycle and prove the committee-certified
// balances EQUAL the central balances on the same transaction set — single process,
// simulated 7-member committee, no real network. Probes 6 & 7 prove the agreement
// is NOT a trivial pass-through: the committee genuinely enforces quorum and catches
// double-spends (BFT), so it agrees with central because it VALIDATES, not because
// it mirrors.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nacl = require('tweetnacl');
const B = require('./swarm/committee_bridge');
const E = require('./swarm/swarm_engine');
const { createBridge, mkIdentity, MINT, FAUCET } = B;

let fails = 0;
const ok  = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };

// build a bridge of n founders, all sealed (each minted 1,000,000 in both models)
function freshBridge(n, prefix) {
  const founders = Array.from({ length: n }, (_, i) => mkIdentity(prefix + i));
  const br = createBridge({ founders });
  founders.forEach((f) => br.sealMember(f));
  return { br, founders, A: founders.map((f) => f.address) };
}
// total money across all members (must be conserved at MINT × members)
const totalCommittee = (br) => Object.values(br.fold().bal).reduce((s, v) => s + v, 0);

// ── integration harness (real server.js child) ──────────────────────────────
const toHex = (u8) => Buffer.from(u8).toString('hex');
function signMsg(from, to, amount, ts, sk) { const m = `${from}:${to}:${amount}:${ts}`; return toHex(nacl.sign.detached(Uint8Array.from(Array.from(m).map((c) => c.charCodeAt(0))), sk)); }
const TMP = path.join(__dirname, '.brick2_tmp');
let portCounter = 39280, BASE = '', child = null, logs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function boot() {
  fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true });
  const port = portCounter++; BASE = `http://127.0.0.1:${port}`; logs = [];
  const env = { ...process.env, NODE_ENV: 'test', PORT: String(port), MONEY_DATA_DIR: TMP,
    MONEY_LEDGER_FILE: path.join(TMP, 'ledger.json'), MONEY_FENCE_FILE: path.join(TMP, 'replay_fence.json'),
    MONEY_CODES_FILE: path.join(TMP, 'ignition_codes_used.json'), MONEY_SELF_FILE: path.join(TMP, 'self_nullifiers.json'),
    LEDGER_BACKEND: 'central', IGNITION_CODES: '', SELF_GATE: '1', SELF_GATE_STUB: '1' };
  child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => logs.push(d.toString())); child.stderr.on('data', (d) => logs.push(d.toString()));
}
async function kill() { if (!child) return; const c = child; child = null; await new Promise((r) => { c.once('exit', r); try { c.kill('SIGKILL'); } catch { r(); } }); await sleep(150); }
async function ready(ms = 10000) { const dl = Date.now() + ms; while (Date.now() < dl) { try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch {} await sleep(100); } throw new Error('server not ready\n' + logs.join('')); }
const getJSON = async (u) => (await fetch(`${BASE}${u}`)).json();
const mintSelf = (addr) => fetch(`${BASE}/ignite/self`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: addr, stub: { valid: true, nullifier: 'NULL_' + addr } }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
function postTransfer(id, to, amt) { const ts = Date.now(); return fetch(`${BASE}/transaction`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: id.address, to, amount: amt, signature: signMsg(id.address, to, amt, ts, id.sk), publicKey: id.pub, timestamp: ts }) }).then(async (r) => ({ status: r.status, body: await r.json() })); }
function runNode(file) { return new Promise((res) => { const c = spawn(process.execPath, [path.join(__dirname, file)], { stdio: 'ignore' }); c.on('exit', (code) => res(code)); }); }

(async () => {
  console.log('\n  BRICK 2 (Bite 1) — COMMITTEE BRIDGE (committee balances == central balances)\n');
  console.log(`  crypto backend: ${E.cryptoBackend}\n`);

  // (1) MEMBERSHIP + MINT
  console.log('  (1) MEMBERSHIP + MINT');
  {
    const { br, A } = freshBridge(8, 'b2m1_');
    const f = br.fold();
    const allMint = A.every((a) => br.committeeBalanceOf(a) === MINT && br.centralBalance(a) === MINT);
    const cmte = E.committeeFor(A[0], br.epoch, br.members());
    (br.members().length === 8 && allMint && br.reconcile().agree)
      ? ok('8 seals → each member holds exactly 1,000,000 in BOTH models; committee == central')
      : bad(`membership mint failed: members=${br.members().length}, agree=${br.reconcile().agree}`);
    (cmte.length === 7 && E.quorumOf(7) === 5)
      ? ok('deterministic committee = 7 validators, quorum = 5 (5-of-7 BFT)')
      : bad(`committee/quorum wrong: |cmte|=${cmte.length}, q=${E.quorumOf(cmte.length)}`);
    (totalCommittee(br) === 8 * MINT) ? ok('total supply conserved = 8 × 1,000,000') : bad(`supply wrong: ${totalCommittee(br)}`);
  }

  // (2) SINGLE CERTIFIED TRANSFER
  console.log('  (2) SINGLE CERTIFIED TRANSFER');
  {
    const { br, A } = freshBridge(8, 'b2m2_');
    const r = br.pay(A[0], A[1], 30000);
    const rec = br.reconcile();
    (r.votes >= r.quorum && rec.agree && br.committeeBalanceOf(A[0]) === 970000 && br.committeeBalanceOf(A[1]) === 1030000)
      ? ok('certified transfer (accept + 5-of-7 votes) applied; committee == central for every member')
      : bad(`single transfer failed: ${JSON.stringify({ votes: r.votes, q: r.quorum, agree: rec.agree, m: rec.mismatches })}`);
    (totalCommittee(br) === 8 * MINT) ? ok('supply still conserved after the transfer') : bad('supply broke');
  }

  // (3) CHAIN (multi-hop)
  console.log('  (3) CHAIN (multi-hop)');
  {
    const { br, A } = freshBridge(8, 'b2m3_');
    br.pay(A[0], A[1], 40000); br.pay(A[1], A[2], 25000); br.pay(A[2], A[3], 10000);
    const rec = br.reconcile();
    (rec.agree && br.committeeBalanceOf(A[0]) === 960000 && br.committeeBalanceOf(A[1]) === 1015000 && br.committeeBalanceOf(A[2]) === 1015000 && br.committeeBalanceOf(A[3]) === 1010000)
      ? ok('A→B→C→D chain: every hop certified; committee == central across all members')
      : bad(`chain failed: ${JSON.stringify(rec.mismatches)} bals=${A.slice(0,4).map((a)=>br.committeeBalanceOf(a))}`);
  }

  // (4) FAN-OUT / FAN-IN
  console.log('  (4) FAN-OUT / FAN-IN');
  {
    const { br, A } = freshBridge(10, 'b2m4_');
    for (let i = 1; i <= 5; i++) br.pay(A[0], A[i], 10000);     // fan-out: A0 → A1..A5
    for (let i = 6; i <= 9; i++) br.pay(A[i], A[0], 5000);      // fan-in:  A6..A9 → A0
    const rec = br.reconcile();
    // A0: -50000 (out) +20000 (in) = -30000 → 970000
    (rec.agree && br.committeeBalanceOf(A[0]) === 970000)
      ? ok('fan-out then fan-in on one hub: committee == central for all 10 members')
      : bad(`fan failed: ${JSON.stringify(rec.mismatches)} A0=${br.committeeBalanceOf(A[0])}`);
  }

  // (5) INVITED MEMBER (non-founder membership path)
  console.log('  (5) INVITED MEMBER');
  {
    const founders = Array.from({ length: 8 }, (_, i) => mkIdentity('b2m5_F' + i));
    const br = createBridge({ founders });
    founders.forEach((f) => br.sealMember(f));
    const invitee = mkIdentity('b2m5_INV');
    br.sealMember(invitee, { inviter: founders[0], inviteId: 'invite-1' });
    const isMember = br.members().includes(invitee.address);
    br.pay(founders[1].address, invitee.address, 20000);   // invited member receives
    br.pay(invitee.address, founders[2].address, 15000);   // ...and spends
    const rec = br.reconcile();
    (isMember && rec.agree && br.committeeBalanceOf(invitee.address) === 1005000 && br.centralBalance(invitee.address) === 1005000)
      ? ok('member sealed via INVITE (not founder) gets 1,000,000, transacts; committee == central')
      : bad(`invited member failed: member=${isMember}, agree=${rec.agree}, inv=${br.committeeBalanceOf(invitee.address)}`);
  }

  // (6) QUORUM ENFORCED — votes are load-bearing (4 withholds, the 5th applies)
  console.log('  (6) QUORUM ENFORCED');
  {
    const { br, A } = freshBridge(8, 'b2m6_');
    const cmte = E.committeeFor(A[0], br.epoch, br.members());
    const r = br.promise(A[0], A[1], 40000, { nonce: 1, voters: cmte.slice(0, 4), record: false }); // 4 votes
    const withheld = br.committeeBalanceOf(A[0]) === MINT && br.committeeBalanceOf(A[1]) === MINT;
    br.ledger.add(E.makeVote(br.idByAddr.get(cmte[4]), r.ref));                                       // the 5th vote
    const applied = br.committeeBalanceOf(A[0]) === 960000 && br.committeeBalanceOf(A[1]) === 1040000;
    (withheld && applied)
      ? ok('quorum−1 (4) votes → money WITHHELD; adding the 5th vote → applied (quorum is exact + load-bearing)')
      : bad(`quorum enforcement failed: withheld=${withheld} applied=${applied} bal0=${br.committeeBalanceOf(A[0])}`);
  }

  // (7) DOUBLE-SPEND CAUGHT — same nonce, two recipients, both certified → fraud
  console.log('  (7) DOUBLE-SPEND CAUGHT');
  {
    const { br, A } = freshBridge(8, 'b2m7_');
    br.promise(A[0], A[1], 50000, { nonce: 1, record: false });     // spend #1
    br.promise(A[0], A[2], 50000, { nonce: 1, record: false });     // spend #2 — SAME nonce (equivocation)
    const f = br.fold();
    const caught = f.frauds.length === 1 && f.frauds[0].cheater === A[0] && f.ejectedAt[A[0]] === 1;
    const voided = br.committeeBalanceOf(A[0]) === MINT && br.committeeBalanceOf(A[1]) === MINT && br.committeeBalanceOf(A[2]) === MINT;
    (caught && voided)
      ? ok('double-spend (1 sender, 2 certified promises @ same nonce) → fraud logged, cheater ejected, BOTH voided')
      : bad(`double-spend not caught: ${JSON.stringify({ frauds: f.frauds.length, eject: f.ejectedAt[A[0]], voided })}`);
  }

  // (8) DETERMINISM — same scenario twice → identical certified state
  console.log('  (8) DETERMINISM');
  {
    const build = (pfx) => { const { br, A } = freshBridge(8, pfx); br.pay(A[0], A[1], 33000); br.pay(A[2], A[3], 17000); return br; };
    const h1 = build('b2det_').ledger.hash();
    const h2 = build('b2det_').ledger.hash();          // identical seeds → identical keys → identical fold
    const br = build('b2det_');
    const f1 = JSON.stringify(br.fold().bal), f2 = JSON.stringify(br.fold().bal);  // memoized re-fold is stable
    (h1 === h2 && f1 === f2)
      ? ok(`same scenario → identical ledger hash (${h1}); re-fold is byte-stable (memoization)`)
      : bad(`determinism failed: h1=${h1} h2=${h2} stable=${f1 === f2}`);
  }

  // (8b) NON-MEMBER RECIPIENT — reconcile flags a ghost credit DIRECTLY (coverage)
  console.log('  (8b) NON-MEMBER RECIPIENT');
  {
    const { br, A } = freshBridge(8, 'b2ghost_');
    const ghost = mkIdentity('b2ghost_OUTSIDER');          // never sealed → not a member
    br.register(ghost);                                    // known key (can sign accept), no membership
    br.promise(A[0], ghost.address, 20000, { record: true }); // central debits A0 + credits ghost; committee withholds (recipient unsealed)
    const rec = br.reconcile();
    const ghostFlagged = rec.mismatches.some((m) => m.addr === ghost.address && m.committee === 0 && m.central === 20000);
    (!rec.agree && ghostFlagged && !br.members().includes(ghost.address))
      ? ok('credit to a NON-member recipient is caught DIRECTLY on the ghost (reconcile covers every address, not just members)')
      : bad(`ghost coverage failed: agree=${rec.agree} flagged=${ghostFlagged} member=${br.members().includes(ghost.address)}`);
  }

  // (9) REAL-SERVER AGREEMENT — committee == central reduction == live /balance
  console.log('  (9) REAL-SERVER AGREEMENT (live central code)');
  try {
    // a comprehensive scenario: 8 members, several transfers ≤ 50k (within the live
    // movement cap), each sender solvent in issue order. Mints stay in the fixed-1M
    // regime (Self-gate ignition), so seal↔mint is 1:1 (no calcReward decay — see
    // committee_bridge.js SCOPE).
    const { br, founders, A } = freshBridge(8, 'b2srv_');
    br.pay(A[0], A[1], 50000); br.pay(A[1], A[2], 30000); br.pay(A[2], A[3], 20000);
    br.pay(A[3], A[4], 10000); br.pay(A[0], A[5], 25000); br.pay(A[6], A[7], 40000);
    const idOf = (addr) => founders.find((f) => f.address === addr);

    boot(); await ready();
    // mint every member via the Self gate (1,000,000 FAUCET each — no invite codes)
    for (const a of A) { const m = await mintSelf(a); if (m.status !== 200) throw new Error('mint failed ' + a + ' ' + JSON.stringify(m.body)); }
    // replay the bridge's transfers, in order, through the live /transaction path
    let rejected = 0;
    for (const t of br.moneyTxs) {
      if (t.from === FAUCET) continue;
      const resp = await postTransfer(idOf(t.from), t.to, t.amount);
      if (resp.status !== 200) { rejected++; logs.push(`server rejected ${t.from}->${t.to} ${t.amount}: ${JSON.stringify(resp.body)}`); }
    }
    // three-way compare for EVERY member
    let threeWay = true; const sample = [];
    for (const a of A) {
      const srv = (await getJSON(`/balance/${a}`)).balance;
      const cm = br.committeeBalanceOf(a), ce = br.centralBalance(a);
      if (!(srv === cm && cm === ce)) { threeWay = false; sample.push({ a: a.slice(0, 10), srv, cm, ce }); }
    }
    (rejected === 0 && threeWay)
      ? ok('every transfer accepted by LIVE server; committee == central-reduction == live /balance for all 8 members')
      : bad(`real-server divergence: rejected=${rejected} mismatches=${JSON.stringify(sample)}\n${logs.slice(-4).join('')}`);
    // and the live tamper-evident tip moved (the bridge txs really landed on the chain)
    const tip = (await getJSON('/tip')).tip;
    (tip && tip !== '0'.repeat(64)) ? ok('live Brick 1 /tip is non-genesis (bridge txs committed to the real ledger)') : bad('tip not advanced');
  } catch (e) { bad('integration probe error: ' + e.message + '\n' + logs.slice(-6).join('')); }
  finally { await kill(); }

  // (10) REGRESSION — the whole prior stack still passes (this brick is additive)
  console.log('  (10) REGRESSION — Self gate → Brick 1 → Phase 0–3');
  {
    const code = await runNode('test_self_gate.js');   // transitively runs test_brick1 → phase 0–3
    (code === 0) ? ok('test_self_gate.js (→ Brick 1 → Phase 0–3) → exit 0: nothing existing changed')
                 : bad(`test_self_gate.js → exit ${code}`);
  }

  console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Brick 2 (Bite 1): ${fails === 0 ? 'ALL PROBES PASS' : fails + ' FAILURE(S)'} — the BFT committee validates real MONEY transactions and agrees with central, balance-for-balance.\n`);
  process.exit(fails === 0 ? 0 : 1);
})();
