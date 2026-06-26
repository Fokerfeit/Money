// test_brick2_cap.js — BRICK 2 (Bite 2): committee ENFORCES the STANDING movement
// cap. Every probe must pass; exit 0.
//   1 CAP ENFORCED (the change bites)   2 CAP PARITY (committee==central WITH cap)
//   3 DYNAMIC STANDING (grows w/ distinct cps; ping-pong flat)   4 BASELINE/NOT-IGNITED
//   5 BOUNDARY (exactly movable applies, +1 rejects)   6 FAUCET/SELF EXCLUSION
//   7 REAL-SERVER PARITY (committee cap decisions == live server 403/400; 3-way balance)
//   8 REGRESSION (Bite 1 + Self gate → Brick 1 → Phase 0–3 still exit 0)
//
// The cap is DYNAMIC: standing = (ignited?5:0) + distinct counterparties (excl
// FAUCET/self, Set-dedup), movable = min(balance, standing×10000). It is evaluated at
// each transfer's point in replay against the committee's OWN evolving state — the
// same per-tx evaluation central does — so the committee rejects exactly the txs
// central 403s and keeps balance-for-balance parity with the cap active.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const nacl = require('tweetnacl');
const B = require('./swarm/committee_bridge');
const E = require('./swarm/swarm_engine');
const { createBridge, mkIdentity, MINT, FAUCET, MOVE_PER_STANDING, IGNITED_BASELINE } = B;

let fails = 0;
const ok  = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };

// a cap-enforcing bridge of n sealed founders (enforceCap default ON here)
function fresh(n, prefix, enforceCap = true) {
  const founders = Array.from({ length: n }, (_, i) => mkIdentity(prefix + i));
  const br = createBridge({ founders, enforceCap });
  founders.forEach((f) => br.sealMember(f));
  return { br, founders, A: founders.map((f) => f.address) };
}
const allInt = (br) => Object.values(br.fold().bal).every(Number.isInteger);

// ── integration harness (real server child) ─────────────────────────────────
const toHex = (u8) => Buffer.from(u8).toString('hex');
function signMsg(from, to, amount, ts, sk) { const m = `${from}:${to}:${amount}:${ts}`; return toHex(nacl.sign.detached(Uint8Array.from(Array.from(m).map((c) => c.charCodeAt(0))), sk)); }
const TMP = path.join(__dirname, '.brick2cap_tmp');
let portCounter = 39320, BASE = '', child = null, logs = [];
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
  console.log('\n  BRICK 2 (Bite 2) — COMMITTEE ENFORCES THE STANDING MOVEMENT CAP\n');
  console.log(`  cap = min(balance, ((ignited?${IGNITED_BASELINE}:0)+distinctCounterparties) × ${MOVE_PER_STANDING})\n`);

  // (1) CAP ENFORCED — the change bites
  console.log('  (1) CAP ENFORCED');
  {
    const { br, A } = fresh(8, 'cap1_', true);
    const r = br.pay(A[0], A[1], 60000);     // standing 5 → movable 50,000 → over cap
    const withheld = !r.admitted && r.reason === 'cap' && br.committeeBalanceOf(A[0]) === MINT && br.committeeBalanceOf(A[1]) === MINT;
    // contrast: WITHOUT the cap (Bite 1 behavior) the same 60k WOULD apply
    const { br: br0, A: A0 } = fresh(8, 'cap1b_', false);
    br0.pay(A0[0], A0[1], 60000);
    const bite1LetItThrough = br0.committeeBalanceOf(A0[0]) === 940000;
    (withheld && bite1LetItThrough)
      ? ok('standing-5 member sending 60,000 is REFUSED by the committee (movable 50,000); Bite 1 (no cap) would have applied it — the change bites')
      : bad(`cap enforce failed: withheld=${withheld} bite1=${bite1LetItThrough} r=${JSON.stringify(r)}`);
  }

  // (2) CAP PARITY — committee fold == central, WITH the cap active, integer money
  console.log('  (2) CAP PARITY (core)');
  {
    const { br, A } = fresh(8, 'cap2_', true);
    br.pay(A[0], A[1], 60000);   // rej (cap, standing 5)
    br.pay(A[0], A[1], 50000);   // ok  → A0 950k, cp{A1} standing 6
    br.pay(A[0], A[2], 70000);   // rej (cap, movable 60k)
    br.pay(A[0], A[2], 60000);   // ok  → A0 890k, cp{A1,A2} standing 7
    const rec = br.reconcile();
    const bals = A.slice(0, 3).map((a) => br.committeeBalanceOf(a));
    (rec.agree && br.rejected.length === 2 && bals[0] === 890000 && bals[1] === 1050000 && bals[2] === 1060000 && allInt(br))
      ? ok('mixed over/under-cap sequence: committee == central for every member (integer); the 2 over-cap txs moved nothing')
      : bad(`cap parity failed: agree=${rec.agree} rej=${br.rejected.length} bals=${bals} int=${allInt(br)} mm=${JSON.stringify(rec.mismatches)}`);
  }

  // (3) DYNAMIC STANDING — grows with distinct counterparties; ping-pong stays flat
  console.log('  (3) DYNAMIC STANDING');
  {
    const { br, A } = fresh(8, 'cap3_', true);
    const before = br.pay(A[0], A[4], 70000);                       // standing 5 → 70k over cap
    br.pay(A[0], A[1], 10000); br.pay(A[0], A[2], 10000); br.pay(A[0], A[3], 10000); // +3 distinct cps → standing 8
    const standing = br.committeeStandingOf(A[0]);
    const after = br.pay(A[0], A[4], 70000);                        // now movable 80k → 70k valid
    (!before.admitted && standing === 8 && after.admitted && br.reconcile().agree)
      ? ok('70k over-cap at standing 5 becomes VALID at standing 8 (3 new distinct counterparties); committee re-evaluates dynamically, matches central')
      : bad(`dynamic standing failed: before=${before.admitted} standing=${standing} after=${after.admitted}`);

    const { br: pp, A: P } = fresh(8, 'cap3pp_', true);
    pp.pay(P[0], P[1], 50000); pp.pay(P[1], P[0], 50000); pp.pay(P[0], P[1], 55000); pp.pay(P[1], P[0], 55000); // ping-pong, one counterparty
    const flat = pp.committeeStandingOf(P[0]) === 6 && pp.committeeStandingOf(P[1]) === 6;
    const stillCapped = !pp.pay(P[0], P[1], 70000).admitted;        // 70k still > 60k movable
    (flat && stillCapped)
      ? ok('2-party ping-pong does NOT raise standing (Set-dedup keeps it at 6 = baseline+1); 70k stays over cap')
      : bad(`ping-pong failed: flat=${flat} stillCapped=${stillCapped} s0=${pp.committeeStandingOf(P[0])}`);
  }

  // (4) BASELINE / NOT-IGNITED
  console.log('  (4) BASELINE / NOT-IGNITED');
  {
    const { br, founders, A } = fresh(8, 'cap4_', true);
    const ghost = mkIdentity('cap4_ghost');
    br.register(ghost);                                            // known key, NOT sealed → not ignited
    const preStanding = br.committeeStandingOf(ghost.address), preMovable = br.committeeMovableNow(ghost.address);
    const preSend = br.pay(ghost.address, A[0], 1);                // can move nothing
    br.sealMember(ghost, { inviter: founders[0], inviteId: 'cap4-invite' }); // ignition via invite (a FAUCET seal)
    const postStanding = br.committeeStandingOf(ghost.address), postMovable = br.committeeMovableNow(ghost.address);
    const postSend = br.pay(ghost.address, A[0], 50000);          // now movable 50k
    (preStanding === 0 && preMovable === 0 && !preSend.admitted && postStanding === IGNITED_BASELINE && postMovable === 50000 && postSend.admitted)
      ? ok('not-ignited → standing 0, movable 0 (moves nothing); after FAUCET seal → baseline 5, movable 50,000 — committee matches central')
      : bad(`baseline failed: pre(${preStanding}/${preMovable}/${preSend.admitted}) post(${postStanding}/${postMovable}/${postSend.admitted})`);
  }

  // (5) BOUNDARY — exactly movable applies; movable+1 rejects
  console.log('  (5) BOUNDARY');
  {
    const { br, A } = fresh(8, 'cap5_', true);
    const exact = br.pay(A[0], A[1], 50000);                       // == movable
    const { br: br2, A: A2 } = fresh(8, 'cap5b_', true);
    const over = br2.pay(A2[0], A2[1], 50001);                     // movable + 1
    (exact.admitted && !over.admitted && over.reason === 'cap')
      ? ok('exactly movableNow (50,000) APPLIES; movableNow+1 (50,001) REJECTS — off-by-one exact on both sides')
      : bad(`boundary failed: exact=${exact.admitted} over=${over.admitted}/${over.reason}`);
  }

  // (6) FAUCET / SELF EXCLUSION
  console.log('  (6) FAUCET / SELF EXCLUSION');
  {
    // FAUCET not counted: after only a seal (a FAUCET mint), standing is baseline 5, not 6.
    const { br, A } = fresh(8, 'cap6_', true);
    const faucetExcluded = br.committeeStandingOf(A[0]) === 5;
    // self not counted: a self-transfer does not raise standing.
    const selfBefore = br.committeeStandingOf(A[0]);
    const selfTx = br.pay(A[0], A[0], 40000);                      // A0 → A0 (≤ movable 50k)
    const selfAfter = br.committeeStandingOf(A[0]);
    (faucetExcluded && selfTx.admitted && selfBefore === 5 && selfAfter === 5 && br.committeeBalanceOf(A[0]) === MINT)
      ? ok('FAUCET seal is NOT a counterparty (standing stays 5); a self-transfer does NOT inflate standing (stays 5) — identical to central')
      : bad(`exclusion failed: faucet=${faucetExcluded} self ${selfBefore}->${selfAfter} bal=${br.committeeBalanceOf(A[0])}`);
  }

  // (7) REAL-SERVER PARITY — committee cap decisions == live server; 3-way balances
  console.log('  (7) REAL-SERVER PARITY (live central code)');
  try {
    const { br, founders, A } = fresh(8, 'cap7_', true);
    // a mixed scenario: cap rejections, dynamic growth, a fan, all amounts ≤ balance
    br.pay(A[0], A[1], 60000);   // rej cap
    br.pay(A[0], A[1], 50000);   // ok  (standing 5)
    br.pay(A[0], A[2], 70000);   // rej cap (movable 60k)
    br.pay(A[0], A[2], 55000);   // ok  (cp{A1,A2} standing 7 after)
    br.pay(A[0], A[3], 80000);   // rej cap (movable 70k)
    br.pay(A[0], A[3], 65000);   // ok  → standing 8
    br.pay(A[0], A[4], 75000);   // ok  (movable 80k)
    br.pay(A[5], A[6], 50000);   // ok  (A5 standing 5)
    br.pay(A[5], A[7], 60000);   // rej? A5 cp{A6} standing 6 movable 60k → 60k ok
    const idOf = (addr) => founders.find((f) => f.address === addr);

    boot(); await ready();
    for (const a of A) { const m = await mintSelf(a); if (m.status !== 200) throw new Error('mint failed ' + a); }

    // replay EVERY attempt in order; the live server's verdict must match the committee's
    let verdictMatch = true; const mism = [];
    for (const at of br.attempts) {
      const resp = await postTransfer(idOf(at.from), at.to, at.amount);
      const expect = at.admitted ? 200 : at.reason === 'balance' ? 400 : 403;
      if (resp.status !== expect) { verdictMatch = false; mism.push({ from: at.from.slice(0, 8), amt: at.amount, committee: at.admitted ? 'admit' : at.reason, expect, got: resp.status, err: resp.body.error }); }
    }
    (verdictMatch)
      ? ok(`live server's per-tx verdict matches the committee for ALL ${br.attempts.length} attempts (admit→200, cap→403, balance→400)`)
      : bad(`verdict divergence: ${JSON.stringify(mism)}`);

    // three-way balance agreement WITH the cap enforced on both sides
    let threeWay = true; const sample = [];
    for (const a of A) {
      const srv = (await getJSON(`/balance/${a}`)).balance, cm = br.committeeBalanceOf(a), ce = br.centralBalance(a);
      if (!(srv === cm && cm === ce && Number.isInteger(srv))) { threeWay = false; sample.push({ a: a.slice(0, 10), srv, cm, ce }); }
    }
    (threeWay)
      ? ok('committee == central-reduction == live /balance for all 8 members, with the cap rejecting the same txs on both sides')
      : bad(`3-way divergence: ${JSON.stringify(sample)}`);
  } catch (e) { bad('integration error: ' + e.message + '\n' + logs.slice(-6).join('')); }
  finally { await kill(); }

  // (8) REGRESSION — Bite 1 parity + the whole prior stack
  console.log('  (8) REGRESSION / ADDITIVE');
  {
    const c1 = await runNode('test_brick2.js');      // Bite 1 (enforceCap default off → unchanged)
    (c1 === 0) ? ok('test_brick2.js (Bite 1 parity, cap OFF) → exit 0: existing behavior unchanged') : bad(`test_brick2.js → exit ${c1}`);
    const c2 = await runNode('test_self_gate.js');   // → Brick 1 → Phase 0–3
    (c2 === 0) ? ok('test_self_gate.js (→ Brick 1 → Phase 0–3) → exit 0: central/chain/Self gate intact') : bad(`test_self_gate.js → exit ${c2}`);
  }

  console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Brick 2 (Bite 2): ${fails === 0 ? 'ALL PROBES PASS' : fails + ' FAILURE(S)'} — the committee ENFORCES the standing cap dynamically, parity with central preserved.\n`);
  process.exit(fails === 0 ? 0 : 1);
})();
