// test_selftransfer.js — close the self-transfer money-printer. Every probe passes; exit 0.
//   1 POST from===to → 400, balance unchanged, no tx appended, Brick 1 tip unchanged
//   2 getBalance nets a HISTORICAL planted self-tx to zero (no inflation)
//   3 committee bridge rejects from===to; committee == central parity on a mixed sequence
//   4 a correctly SIGNED self-transfer still rejects (a valid sig does NOT bypass)
//   5 REGRESSION: Phase 0–3, Brick 1, Brick 2 (both bites), Self-gate, hardening suites pass
//
// BUG: POST /transaction with from===to returned 200 and INFLATED the balance — the
// credit branch of getBalance fired, the debit never did (5×50k self-sends grew a wallet
// 1,000,000 → 1,250,000). Fixed at both layers: reject from===to at the endpoint, and net
// self-sends to zero in getBalance so historical self-txs can't inflate.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nacl = require('tweetnacl');
const B = require('./swarm/committee_bridge');
const { buildChain, ZERO } = require('./ledger_chain');

let fails = 0;
const ok  = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };

const TMP = path.join(__dirname, '.selftransfer_tmp');
const toHex = (u8) => Buffer.from(u8).toString('hex');
const seed = (l) => new Uint8Array(crypto.createHash('sha256').update(l).digest());
function wallet(l) { const kp = nacl.sign.keyPair.fromSeed(seed(l)); const pub = toHex(kp.publicKey); return { address: 'M_' + pub.slice(0, 32).toUpperCase(), publicKey: pub, secretKey: kp.secretKey }; }
function signMsg(from, to, amount, ts, sk) { const m = `${from}:${to}:${amount}:${ts}`; return toHex(nacl.sign.detached(Uint8Array.from(Array.from(m).map((c) => c.charCodeAt(0))), sk)); }

let portCounter = 39400 + Math.floor(Math.random() * 8000);  // random base avoids TIME_WAIT collisions
let BASE = '', child = null, logs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function boot(dir) {
  const port = portCounter++; BASE = `http://127.0.0.1:${port}`; logs = [];
  const env = { ...process.env, NODE_ENV: 'test', PORT: String(port), MONEY_DATA_DIR: dir,
    MONEY_LEDGER_FILE: path.join(dir, 'ledger.json'), MONEY_FENCE_FILE: path.join(dir, 'replay_fence.json'),
    MONEY_CODES_FILE: path.join(dir, 'ignition_codes_used.json'), MONEY_SELF_FILE: path.join(dir, 'self_nullifiers.json'),
    LEDGER_BACKEND: 'central', IGNITION_CODES: '', SELF_GATE: '1', SELF_GATE_STUB: '1' };
  child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => logs.push(d.toString())); child.stderr.on('data', (d) => logs.push(d.toString()));
}
async function kill() { if (!child) return; const c = child; child = null; await new Promise((r) => { c.once('exit', r); try { c.kill('SIGKILL'); } catch { r(); } }); await sleep(150); }
async function ready(ms = 10000) { const dl = Date.now() + ms; while (Date.now() < dl) { try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch {} await sleep(100); } throw new Error('server not ready\n' + logs.join('')); }
const getJSON = async (u) => (await fetch(`${BASE}${u}`)).json();
const mintSelf = (addr, n) => fetch(`${BASE}/ignite/self`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: addr, stub: { valid: true, nullifier: n } }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
function post(id, to, amt) { const ts = Date.now(); return fetch(`${BASE}/transaction`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: id.address, to, amount: amt, signature: signMsg(id.address, to, amt, ts, id.secretKey), publicKey: id.publicKey, timestamp: ts }) }).then(async (r) => ({ status: r.status, body: await r.json() })); }
function runNode(file) { return new Promise((res) => { const c = spawn(process.execPath, [path.join(__dirname, file)], { stdio: 'ignore' }); c.on('exit', (code) => res(code)); }); }
const freshDir = (name) => { const d = path.join(TMP, name); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; };

(async () => {
  console.log('\n  FIX — self-transfer money-printer (central + committee)\n');
  fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true });

  // (1) POST from===to → 400, nothing changes; the reproduced attack neutralised
  console.log('  (1) REJECT AT ENDPOINT');
  try {
    boot(freshDir('reject')); await ready();
    const A = wallet('st-A');
    await mintSelf(A.address, 'NULL_A');
    const bal0 = (await getJSON(`/balance/${A.address}`)).balance;
    const len0 = (await getJSON('/ledger')).length;
    const tip0 = (await getJSON('/tip')).tip;
    const r = await post(A, A.address, 50000);                         // self-send
    const bal1 = (await getJSON(`/balance/${A.address}`)).balance;
    const len1 = (await getJSON('/ledger')).length;
    const tip1 = (await getJSON('/tip')).tip;
    (r.status === 400 && /self-transfer/i.test(r.body.error) && bal1 === bal0 && len1 === len0 && tip1 === tip0)
      ? ok('POST from===to → 400 "Self-transfers are not allowed"; balance/ledger/tip all unchanged')
      : bad(`endpoint reject failed: ${JSON.stringify({ r, bal0, bal1, len0, len1, tipSame: tip0 === tip1 })}`);
    // the exact reproduced attack: 5×50k self-sends must NOT inflate
    for (let i = 0; i < 5; i++) await post(A, A.address, 50000);
    const balN = (await getJSON(`/balance/${A.address}`)).balance;
    (balN === 1_000_000) ? ok('the reproduced attack (5×50k self-sends) leaves the wallet at exactly 1,000,000 — money-printer dead') : bad(`printer still live: balance ${balN}`);
  } catch (e) { bad('endpoint probe error: ' + e.message + '\n' + logs.slice(-4).join('')); }
  finally { await kill(); }

  // (2) getBalance nets a HISTORICAL planted self-tx to zero
  console.log('  (2) DEFENSIVE getBalance');
  try {
    const d = freshDir('historical');
    const A = wallet('st-hist');
    // plant a ledger that ALREADY contains a self-tx (as if committed before the fix)
    const planted = [
      { from: A.address, to: A.address, amount: 500000, reason: null, time: '10:00', timestamp: 1700000000001, sigPrefix: 'x' },
      { from: 'FAUCET', to: A.address, amount: 1000000, reason: null, time: '10:00', timestamp: 1700000000000, sigPrefix: null },
    ]; // newest-first; a generic (non-self_ignition) faucet mint so auditSeals doesn't require a seal
    fs.writeFileSync(path.join(d, 'ledger.json'), JSON.stringify(planted));
    boot(d); await ready();
    const bal = (await getJSON(`/balance/${A.address}`)).balance;
    (bal === 1_000_000)
      ? ok('a historical self-tx of 500,000 in the ledger nets to zero → balance is 1,000,000, not 1,500,000')
      : bad(`historical self-tx inflated balance: ${bal} (expected 1,000,000)`);
  } catch (e) { bad('historical probe error: ' + e.message + '\n' + logs.slice(-4).join('')); }
  finally { await kill(); }

  // (3) committee bridge rejects from===to; committee == central parity
  console.log('  (3) COMMITTEE PARITY');
  {
    const founders = Array.from({ length: 8 }, (_, i) => B.mkIdentity('stc_' + i));
    const br = B.createBridge({ founders, enforceCap: true });
    founders.forEach((f) => br.sealMember(f));
    const A = founders.map((f) => f.address);
    br.pay(A[0], A[1], 30000);                                          // normal
    const self1 = br.pay(A[0], A[0], 40000);                           // self → rejected
    br.pay(A[1], A[2], 20000);                                          // normal
    const self2 = br.pay(A[2], A[2], 10000);                           // self → rejected
    const pRej = br.promise(A[3], A[3], 5000, { record: false });      // low-level self → rejected
    const rec = br.reconcile();
    const noSelfInTxs = !br.moneyTxs.some((t) => t.from === t.to && t.from !== 'FAUCET');
    (!self1.admitted && self1.reason === 'self-transfer' && !self2.admitted && pRej.rejected && rec.agree && noSelfInTxs)
      ? ok('committee bridge REJECTS from===to (pay + promise); committee == central on a mixed sequence; no self-tx in the committed set')
      : bad(`committee parity failed: ${JSON.stringify({ self1, self2, pRej, agree: rec.agree, noSelfInTxs, mm: rec.mismatches })}`);
  }

  // (4) a correctly SIGNED self-transfer still rejects (valid sig ≠ bypass)
  console.log('  (4) SIGNED-REQUEST PATH');
  try {
    boot(freshDir('signed')); await ready();
    const A = wallet('st-signed');
    await mintSelf(A.address, 'NULL_S');
    const ts = Date.now();
    const sig = signMsg(A.address, A.address, 25000, ts, A.secretKey);  // a VALID signature over a self-send
    const r = await fetch(`${BASE}/transaction`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: A.address, to: A.address, amount: 25000, signature: sig, publicKey: A.publicKey, timestamp: ts }) });
    const body = await r.json();
    // 400 self-transfer (NOT 401 sig error) proves the sig was valid but the self-check still fired
    (r.status === 400 && /self-transfer/i.test(body.error))
      ? ok('a correctly SIGNED self-transfer → 400 self-transfer (400 not 401: the valid signature did not bypass the check)')
      : bad(`signed self-transfer not rejected as expected: status=${r.status} body=${JSON.stringify(body)}`);
  } catch (e) { bad('signed probe error: ' + e.message + '\n' + logs.slice(-4).join('')); }
  finally { await kill(); }

  // (5) REGRESSION — the whole stack (hardening transitively runs Self-gate → Brick 1 →
  //     Phase 0–3, plus Brick 2 both bites); brick2_cap run explicitly (its self probe changed)
  console.log('  (5) REGRESSION');
  {
    for (const t of ['test_hardening.js', 'test_brick2_cap.js']) {
      const code = await runNode(t);
      (code === 0) ? ok(`${t} → exit 0`) : bad(`${t} → exit ${code}`);
    }
  }

  console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Self-transfer fix: ${fails === 0 ? 'ALL PROBES PASS' : fails + ' FAILURE(S)'} — from===to rejected, historical self-txs net to zero, committee parity kept.\n`);
  process.exit(fails === 0 ? 0 : 1);
})();
