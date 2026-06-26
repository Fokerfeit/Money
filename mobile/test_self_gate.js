// test_self_gate.js — Self personhood-ignition gate. Every probe must pass; exit 0.
//   1 NULLIFIER DEDUP (Sybil core)   2 BIND + MINT (faucet path: ignited/standing/tip)
//   3 DISTINCT HUMANS   4 NO GATEKEEPER (mints with codes CLOSED)
//   5 INVALID PROOF (no mint, nothing sealed)   6 INTEGER MONEY
//   7 REGRESSION (Brick 1 + Phase 0–3 suites still pass; gate is additive + default-off)
//
// Two levels of proof:
//   • UNIT — createSelfGate() with a DIRECTLY-INJECTED stub verifier + mock ledger,
//     isolating the gate's control flow (a real zk proof can't be made in CI).
//   • INTEGRATION — the REAL server.js booted with SELF_GATE=1 and a test-only stub
//     verifier (NODE_ENV=test, SELF_GATE_STUB=1), proving the mint goes through the
//     real FAUCET commit so /balance, /usercount, standing, and the Brick 1 /tip
//     all behave identically to an invite-code ignition.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nacl = require('tweetnacl');
const selfGate = require('./self_gate');

let fails = 0;
const ok  = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };

// ── UNIT fixtures: mock ledger + mock store (no server, no @selfxyz) ──────────
function mockLedger() {
  const txs = [];
  return {
    _txs: txs,
    commit: (tx) => { txs.push(tx); },
    isIgnited: (addr) => txs.some((t) => t.from === 'FAUCET' && t.to === addr),
    all: () => txs.slice(),
  };
}
function mockStore() {
  const m = {};
  return {
    _map: m,
    has: (n) => Object.prototype.hasOwnProperty.call(m, n),
    get: (n) => (Object.prototype.hasOwnProperty.call(m, n) ? m[n] : null),
    seal: (n, w) => { if (Object.prototype.hasOwnProperty.call(m, n)) return false; m[n] = w; return true; },
    size: () => Object.keys(m).length,
  };
}
// A stub verifier object — exactly the seam the prompt requires: it returns a
// chosen {valid, nullifier} with NO real proof.
const stub = (verdict) => () => Promise.resolve(verdict);
const A1 = 'M_' + 'A'.repeat(32), B1 = 'M_' + 'B'.repeat(32), C1 = 'M_' + 'C'.repeat(32), D1 = 'M_' + 'D'.repeat(32);

// ── INTEGRATION harness: deterministic wallets + real server child ───────────
const toHex = (u8) => Buffer.from(u8).toString('hex');
const seed = (l) => new Uint8Array(crypto.createHash('sha256').update(l).digest());
function wallet(l) { const kp = nacl.sign.keyPair.fromSeed(seed(l)); const pub = toHex(kp.publicKey); return { address: 'M_' + pub.slice(0, 32).toUpperCase(), publicKey: pub, secretKey: kp.secretKey }; }
function signMsg(from, to, amount, ts, sk) { const m = `${from}:${to}:${amount}:${ts}`; return toHex(nacl.sign.detached(Uint8Array.from(Array.from(m).map((c) => c.charCodeAt(0))), sk)); }

const TMP = path.join(__dirname, '.self_gate_tmp');
const SELF_FILE = path.join(TMP, 'self_nullifiers.json');
let portCounter = 39220, BASE = '', child = null, logs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function boot(reset, extraEnv = {}) {
  if (reset) { fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true }); }
  const port = portCounter++; BASE = `http://127.0.0.1:${port}`; logs = [];
  const env = { ...process.env, NODE_ENV: 'test', PORT: String(port), MONEY_DATA_DIR: TMP,
    MONEY_LEDGER_FILE: path.join(TMP, 'ledger.json'), MONEY_FENCE_FILE: path.join(TMP, 'replay_fence.json'),
    MONEY_CODES_FILE: path.join(TMP, 'ignition_codes_used.json'), MONEY_SELF_FILE: SELF_FILE,
    LEDGER_BACKEND: 'central', IGNITION_CODES: '',           // invite-code faucet CLOSED on purpose
    SELF_GATE: '1', SELF_GATE_STUB: '1', ...extraEnv };
  child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => logs.push(d.toString())); child.stderr.on('data', (d) => logs.push(d.toString()));
}
async function kill() { if (!child) return; const c = child; child = null; await new Promise((r) => { c.once('exit', r); try { c.kill('SIGKILL'); } catch { r(); } }); await sleep(150); }
async function ready(ms = 10000) { const dl = Date.now() + ms; while (Date.now() < dl) { try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch {} await sleep(100); } throw new Error('server not ready\n' + logs.join('')); }
const getJSON = async (u) => (await fetch(`${BASE}${u}`)).json();
// POST /ignite/self with a stub verdict carried in the request (test seam).
function igniteSelf(walletAddr, verdict) {
  return fetch(`${BASE}/ignite/self`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallet: walletAddr, stub: verdict }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
}
// Legacy invite-code faucet claim (used to prove the code gate is CLOSED).
function faucetClaim(w, amt) { const ts = Date.now(); return fetch(`${BASE}/transaction`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ from: 'FAUCET', to: w.address, amount: amt, signature: signMsg('FAUCET', w.address, amt, ts, w.secretKey), publicKey: w.publicKey, timestamp: ts }) }).then(async (r) => ({ status: r.status, body: await r.json() })); }
function send(w, to, amt) { const ts = Date.now(); return fetch(`${BASE}/transaction`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ from: w.address, to, amount: amt, signature: signMsg(w.address, to, amt, ts, w.secretKey), publicKey: w.publicKey, timestamp: ts }) }).then(async (r) => ({ status: r.status, body: await r.json() })); }
function runNode(file) { return new Promise((res) => { const c = spawn(process.execPath, [path.join(__dirname, file)], { stdio: 'ignore' }); c.on('exit', (code) => res(code)); }); }
const readSelfFile = () => { try { return JSON.parse(fs.readFileSync(SELF_FILE, 'utf8')); } catch { return {}; } };

(async () => {
  console.log('\n  SELF PERSONHOOD GATE — nullifier-bound ignition (mock mode)\n');

  // ═══════════════════════ UNIT PROBES (pure gate) ═══════════════════════════
  console.log('  UNIT — createSelfGate() with an injected stub verifier');

  // (U1) NULLIFIER DEDUP — the Sybil core
  {
    const led = mockLedger(), st = mockStore();
    const gate = selfGate.createSelfGate({ verify: stub({ valid: true, nullifier: 'NULL_X' }), ledger: led, store: st });
    const r1 = await gate.claim({}, A1);
    const r2 = await gate.claim({}, B1);   // SAME nullifier, DIFFERENT wallet
    const oneMint = led._txs.filter((t) => t.from === 'FAUCET').length === 1;
    (r1.ok && r1.amount === 1_000_000 && !r2.ok && r2.code === 'nullifier-used' && r2.boundTo === A1 && oneMint && st.size() === 1)
      ? ok('(1) same nullifier → first wallet mints 1,000,000; second wallet REJECTED, no second mint')
      : bad(`(1) dedup failed: ${JSON.stringify({ r1, r2, txs: led._txs.length, size: st.size() })}`);
  }

  // (U2) BIND + MINT — sealed, balance, FAUCET path
  {
    const led = mockLedger(), st = mockStore();
    const gate = selfGate.createSelfGate({ verify: stub({ valid: true, nullifier: 'NULL_Y' }), ledger: led, store: st });
    const r = await gate.claim({}, A1);
    const tx = led._txs[0];
    (r.ok && st.get('NULL_Y') === A1 && tx && tx.from === 'FAUCET' && tx.to === A1 && tx.amount === 1_000_000 && tx.reason === 'self_ignition' && led.isIgnited(A1))
      ? ok('(2) nullifier SEALED to wallet; mint is a from:FAUCET tx of 1,000,000 → wallet ignited')
      : bad(`(2) bind+mint failed: ${JSON.stringify({ r, tx, sealed: st.get('NULL_Y') })}`);
  }

  // (U3) DISTINCT HUMANS — two nullifiers both succeed
  {
    const led = mockLedger(), st = mockStore();
    // each human is a distinct verifier verdict → a fresh gate per nullifier
    const g1 = selfGate.createSelfGate({ verify: stub({ valid: true, nullifier: 'NULL_1' }), ledger: led, store: st });
    const g2 = selfGate.createSelfGate({ verify: stub({ valid: true, nullifier: 'NULL_2' }), ledger: led, store: st });
    const r1 = await g1.claim({}, A1);
    const r2 = await g2.claim({}, C1);
    (r1.ok && r2.ok && st.size() === 2 && led._txs.filter((t) => t.from === 'FAUCET').length === 2)
      ? ok('(3) two DIFFERENT nullifiers → both ignite, each wallet its own 1,000,000')
      : bad(`(3) distinct-humans failed: ${JSON.stringify({ r1, r2, size: st.size() })}`);
  }

  // (U4) NO GATEKEEPER — the gate consults no invite code. Proven functionally:
  // (a) it takes no codes dependency (options are only verify/ledger/store); (b) it
  // mints with NO code at all; (c) a bogus code in the payload is ignored — outcome
  // is invariant to it. Also a comment-stripped source scan finds no code reference.
  {
    const led1 = mockLedger(), st1 = mockStore();
    const g1 = selfGate.createSelfGate({ verify: stub({ valid: true, nullifier: 'NULL_NG1' }), ledger: led1, store: st1 });
    const rNone = await g1.claim({}, A1);                                  // no code anywhere
    const led2 = mockLedger(), st2 = mockStore();
    const g2 = selfGate.createSelfGate({ verify: stub({ valid: true, nullifier: 'NULL_NG2' }), ledger: led2, store: st2 });
    const rBogus = await g2.claim({ ignitionCode: 'FAKE', code: 'FAKE', invite: 'FAKE' }, A1);  // bogus code ignored
    // comment-stripped scan: the gate's *logic* must not reference the code gate.
    const stripped = fs.readFileSync(path.join(__dirname, 'self_gate.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const noCodeRef = !/IGNITION_CODES|ignitionCode|usedCodes/.test(stripped);
    (rNone.ok && rBogus.ok && noCodeRef)
      ? ok('(4) mints on the PROOF alone — no code needed, a bogus code is ignored, logic references no code gate')
      : bad(`(4) gatekeeper leak: rNone=${rNone.ok} rBogus=${rBogus.ok} noCodeRef=${noCodeRef}`);
  }

  // (U5) INVALID PROOF — no mint, nothing sealed
  {
    const led = mockLedger(), st = mockStore();
    const gate = selfGate.createSelfGate({ verify: stub({ valid: false, nullifier: 'NULL_BAD' }), ledger: led, store: st });
    const r = await gate.claim({}, A1);
    (!r.ok && r.code === 'invalid-proof' && led._txs.length === 0 && st.size() === 0 && !st.has('NULL_BAD'))
      ? ok('(5) invalid proof → no mint, nullifier NOT sealed, ledger untouched')
      : bad(`(5) invalid-proof leak: ${JSON.stringify({ r, txs: led._txs.length, size: st.size() })}`);
  }

  // (U6) INTEGER MONEY
  {
    const led = mockLedger(), st = mockStore();
    const gate = selfGate.createSelfGate({ verify: stub({ valid: true, nullifier: 'NULL_INT' }), ledger: led, store: st });
    const r = await gate.claim({}, A1);
    const intOK = r.ok && r.amount === 1_000_000 && Number.isInteger(r.amount) && Number.isInteger(led._txs[0].amount);
    // defensive: a non-integer configured amount is refused
    const gBad = selfGate.createSelfGate({ verify: stub({ valid: true, nullifier: 'NULL_F' }), ledger: mockLedger(), store: mockStore(), amount: 1_000_000.5 });
    const rBad = await gBad.claim({}, A1);
    (intOK && selfGate.MINT_AMOUNT === 1_000_000 && !rBad.ok && rBad.code === 'bad-amount')
      ? ok('(6) minted amount is exactly 1,000,000 (integer); fractional amount refused')
      : bad(`(6) integer-money failed: ${JSON.stringify({ r, rBad })}`);
    void gate; void led; void st;
  }
  (typeof selfGate.realSelfVerifier === 'function')
    ? ok('production realSelfVerifier() is exported (wraps SelfBackendVerifier, lazy @selfxyz/core)')
    : bad('realSelfVerifier not exported');

  // ═══════════════════ INTEGRATION PROBES (real server) ══════════════════════
  console.log('\n  INTEGRATION — real server.js, FAUCET commit, real standing + Brick 1 /tip');
  try {
    boot(true); await ready();
    const A = wallet('self-A'), B = wallet('self-B'), C = wallet('self-C'), R = wallet('self-R'), D = wallet('self-D'), E = wallet('self-E');
    const tip0 = (await getJSON('/tip')).tip;

    // (4) NO GATEKEEPER — invite-code faucet is CLOSED (no codes), yet Self mints.
    const closed = await faucetClaim(A, 200000);
    const c1 = await igniteSelf(A.address, { valid: true, nullifier: 'HUMAN_1' });
    const balA = (await getJSON(`/balance/${A.address}`)).balance;
    (closed.status === 503 && c1.status === 200 && c1.body.success && balA === 1_000_000)
      ? ok('(4) invite-code faucet CLOSED (503) yet Self path mints 1,000,000 — no gatekeeper consulted')
      : bad(`(4) gatekeeper integration failed: ${JSON.stringify({ closed: closed.status, c1, balA })}`);

    // (2) BIND + MINT — sealed on disk, balance, FAUCET path, standing=5, tip advanced.
    const tipA = (await getJSON('/tip')).tip;
    const boundOK = readSelfFile()['HUMAN_1'] === A.address;   // server writes the nullifier→wallet map as the file body
    const txToA = await getJSON(`/tx?to=${A.address}`);
    const faucetTx = txToA.find((t) => t.from === 'FAUCET');
    (tipA !== tip0 && boundOK && faucetTx && faucetTx.amount === 1_000_000 && faucetTx.reason === 'self_ignition')
      ? ok('(2) Brick 1 tip ADVANCED; nullifier recorded on disk; mint is a FAUCET tx tagged self_ignition')
      : bad(`(2) bind+mint integration failed: ${JSON.stringify({ tipMoved: tipA !== tip0, boundOK, faucetTx })}`);

    // standing == 5 exactly: an over-cap send is refused with standing:5, movable:50000.
    await igniteSelf(R.address, { valid: true, nullifier: 'HUMAN_R' });   // a registered recipient
    const over = await send(A, R.address, 50001);
    (over.status === 403 && over.body.standing === 5 && over.body.movable === 50000)
      ? ok('(2) Self-minted wallet has standing EXACTLY 5 (movement cap 50,000) — same engine as faucet')
      : bad(`(2) standing check failed: ${JSON.stringify(over)}`);
    const atCap = await send(A, R.address, 50000);
    (atCap.status === 200 && atCap.body.success) ? ok('(2) at-cap send (50,000) succeeds — wallet spends like any ignited wallet')
                                                 : bad(`(2) at-cap send failed: ${JSON.stringify(atCap)}`);

    // (1) NULLIFIER DEDUP — same nullifier, different wallet → rejected, no 2nd mint.
    const uc1 = (await getJSON('/usercount')).count;
    const dup = await igniteSelf(B.address, { valid: true, nullifier: 'HUMAN_1' });
    const balB = (await getJSON(`/balance/${B.address}`)).balance;
    const balA2 = (await getJSON(`/balance/${A.address}`)).balance;   // A spent 50k above → 950k, NOT re-minted
    const uc2 = (await getJSON('/usercount')).count;
    (dup.status === 409 && dup.body.code === 'nullifier-used' && dup.body.boundTo === A.address && balB === 0 && balA2 === 950000 && uc1 === uc2)
      ? ok('(1) reused nullifier on a new wallet → 409; new wallet gets nothing; usercount unchanged; no second mint')
      : bad(`(1) dedup integration failed: ${JSON.stringify({ dup, balB, balA2, uc1, uc2 })}`);

    // (3) DISTINCT HUMANS — a different nullifier ignites a different wallet.
    const c2 = await igniteSelf(C.address, { valid: true, nullifier: 'HUMAN_2' });
    const balC = (await getJSON(`/balance/${C.address}`)).balance;
    (c2.status === 200 && c2.body.success && balC === 1_000_000)
      ? ok('(3) a DIFFERENT nullifier ignites a DIFFERENT wallet with its own 1,000,000')
      : bad(`(3) distinct-humans integration failed: ${JSON.stringify({ c2, balC })}`);

    // (5) INVALID PROOF — no mint; nullifier NOT sealed (a later VALID proof with the
    //     same nullifier still succeeds, proving the bad attempt stored nothing).
    const badc = await igniteSelf(D.address, { valid: false, nullifier: 'HUMAN_3' });
    const balD = (await getJSON(`/balance/${D.address}`)).balance;
    const reclaim = await igniteSelf(E.address, { valid: true, nullifier: 'HUMAN_3' });   // same nullifier, now valid
    const balE = (await getJSON(`/balance/${E.address}`)).balance;
    (badc.status === 401 && badc.body.code === 'invalid-proof' && balD === 0 && reclaim.status === 200 && balE === 1_000_000)
      ? ok('(5) invalid proof mints nothing and seals nothing — the nullifier is still free for a valid proof')
      : bad(`(5) invalid-proof integration failed: ${JSON.stringify({ badc, balD, reclaim, balE })}`);

    // (6) INTEGER MONEY — the minted faucet tx amount is exactly 1,000,000, integer.
    const intTx = (await getJSON(`/tx?to=${C.address}`)).find((t) => t.from === 'FAUCET');
    (intTx && intTx.amount === 1_000_000 && Number.isInteger(intTx.amount))
      ? ok('(6) on-ledger mint amount is exactly 1,000,000 and an integer')
      : bad(`(6) integer-money integration failed: ${JSON.stringify(intTx)}`);

    // usercount = exactly the distinct Self-ignited wallets (A, R, C, E) = 4.
    const finalUC = (await getJSON('/usercount')).count;
    (finalUC === 4) ? ok('usercount counts only successful Self ignitions (A,R,C,E = 4); rejects never counted')
                    : bad(`usercount wrong: ${finalUC} (expected 4)`);
  } catch (e) { bad('integration probe error: ' + e.message + '\n' + logs.join('')); }
  finally { await kill(); }

  // ═══════════════════════ REGRESSION ═══════════════════════════════════════
  console.log('\n  (7) REGRESSION — Brick 1 + Phase 0–3 suites (gate is additive + default-off)');
  {
    const code = await runNode('test_brick1.js');   // test_brick1 itself runs Phase 0–3
    (code === 0) ? ok('test_brick1.js (→ Phase 0–3) → exit 0: existing behavior unchanged')
                 : bad(`test_brick1.js → exit ${code}`);
  }

  console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Self gate: ${fails === 0 ? 'ALL PROBES PASS' : fails + ' FAILURE(S)'} — one human, one million, nullifier-sealed; faucet/standing/chain unchanged.\n`);
  process.exit(fails === 0 ? 0 : 1);
})();
