// test_brick1.js — tamper-evident ledger gate. Every probe must pass; exit 0.
//  1 HASH-LINK   2 MERKLE ROOT (+CVE-2012-2459)   3 TIP HASH (+GET /tip)
//  4 TAMPER DETECTION   5 INDEPENDENT VERIFY   6 DETERMINISM (+restart)
//  7 REGRESSION (Phase 0–3 suites still pass)

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nacl = require('tweetnacl');
const { buildChain, verifyChain, merkleRoot, tipHash, ZERO } = require('./ledger_chain');

let fails = 0;
const ok  = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };
const clone = (x) => JSON.parse(JSON.stringify(x));
const flatten = (blocks) => blocks.reduce((a, b) => a.concat(b.txs), []);

function mkTx(i) {
  return { from: 'M_' + String(i).padStart(32, '0'), to: 'M_' + String(i + 1).padStart(32, '0'),
           amount: 1000 + i, reason: i % 3 === 0 ? 'gift' : null, time: '10:00', timestamp: 1700000000000 + i, sigPrefix: 'sig' + i };
}
const sampleTxs = (n) => Array.from({ length: n }, (_, i) => mkTx(i));

// ── deterministic wallets + HTTP for the server probes ───────────────────────
const toHex = (u8) => Buffer.from(u8).toString('hex');
const seed = (l) => new Uint8Array(crypto.createHash('sha256').update(l).digest());
function wallet(l) { const kp = nacl.sign.keyPair.fromSeed(seed(l)); const pub = toHex(kp.publicKey); return { address: 'M_' + pub.slice(0, 32).toUpperCase(), publicKey: pub, secretKey: kp.secretKey }; }
function signMsg(from, to, amount, ts, sk) { const m = `${from}:${to}:${amount}:${ts}`; return toHex(nacl.sign.detached(Uint8Array.from(Array.from(m).map((c) => c.charCodeAt(0))), sk)); }

const TMP = path.join(__dirname, '.brick1_tmp');
let portCounter = 39160, BASE = '', child = null, logs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function boot(reset) {
  if (reset) { fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true }); }
  const port = portCounter++; BASE = `http://127.0.0.1:${port}`; logs = [];
  const env = { ...process.env, NODE_ENV: 'test', PORT: String(port), MONEY_DATA_DIR: TMP,
    MONEY_LEDGER_FILE: path.join(TMP, 'ledger.json'), MONEY_FENCE_FILE: path.join(TMP, 'replay_fence.json'),
    MONEY_CODES_FILE: path.join(TMP, 'ignition_codes_used.json'), IGNITION_CODES: 'CODE1,CODE2,CODE3,CODE4', LEDGER_BACKEND: 'central' };
  child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => logs.push(d.toString())); child.stderr.on('data', (d) => logs.push(d.toString()));
}
async function kill() { if (!child) return; const c = child; child = null; await new Promise((r) => { c.once('exit', r); try { c.kill('SIGKILL'); } catch { r(); } }); await sleep(150); }
async function ready(ms = 10000) { const dl = Date.now() + ms; while (Date.now() < dl) { try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch {} await sleep(100); } throw new Error('server not ready\n' + logs.join('')); }
const get = async (u) => (await fetch(`${BASE}${u}`)).json();
function ignite(w, code, amt) { const ts = Date.now(); return fetch(`${BASE}/transaction`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: 'FAUCET', to: w.address, amount: amt, signature: signMsg('FAUCET', w.address, amt, ts, w.secretKey), publicKey: w.publicKey, timestamp: ts, ignitionCode: code }) }).then((r) => r.json()); }
function send(w, to, amt) { const ts = Date.now(); return fetch(`${BASE}/transaction`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: w.address, to, amount: amt, signature: signMsg(w.address, to, amt, ts, w.secretKey), publicKey: w.publicKey, timestamp: ts }) }).then((r) => r.json()); }
function runNode(file) { return new Promise((res) => { const c = spawn(process.execPath, [path.join(__dirname, file)], { stdio: 'ignore' }); c.on('exit', (code) => res(code)); }); }

(async () => {
  console.log('\n  BRICK 1 — TAMPER-EVIDENT LEDGER\n');

  // (1) HASH-LINK
  console.log('  (1) HASH-LINK');
  {
    const c = buildChain(sampleTxs(20), 4);   // 5 blocks
    let linked = c.blocks[0].prevHash === ZERO;
    for (let i = 1; i < c.blocks.length; i++) if (c.blocks[i].prevHash !== c.blocks[i - 1].blockHash) linked = false;
    (c.blocks.length === 5 && linked) ? ok('genesis prevHash = 0…0; every block links to the previous') : bad('hash-link broken');
    const t = clone(c); t.blocks[2].prevHash = ZERO;
    const v = verifyChain({ blocks: t.blocks });
    (!v.valid && v.firstBadIndex === 2) ? ok('broken link → verify invalid at block 2') : bad(`broken link not caught: ${JSON.stringify(v)}`);
  }

  // (2) MERKLE ROOT (+ CVE-2012-2459)
  console.log('  (2) MERKLE ROOT');
  {
    const c = buildChain(sampleTxs(7), 7);
    (merkleRoot(c.blocks[0].txs) === c.blocks[0].merkleRoot) ? ok('recomputed Merkle root == stored root') : bad('root recompute mismatch');
    const t = clone(c); t.blocks[0].txs[3].amount += 1;
    const v = verifyChain({ blocks: t.blocks });
    (!v.valid && v.firstBadIndex === 0 && /merkleRoot/.test(v.reason)) ? ok('altered tx → root mismatch → verify invalid') : bad(`altered tx not caught: ${JSON.stringify(v)}`);
    const three = sampleTxs(3), dupLast = [...three, three[2]];
    (merkleRoot(three) !== merkleRoot(dupLast)) ? ok('CVE-2012-2459: duplicated-final-leaf yields a DIFFERENT root (not malleable)') : bad('CVE-2012-2459: duplicate-last-leaf collides!');
  }

  // (3) TIP HASH
  console.log('  (3) TIP HASH');
  {
    const c = buildChain(sampleTxs(10), 4);
    (c.tip === c.blocks[c.blocks.length - 1].blockHash && c.tip !== ZERO) ? ok('tip = hash of latest block header (commits to all prior blocks)') : bad('tip wrong');
    (buildChain([], 4).tip === ZERO) ? ok('empty ledger → tip = 0…0 (defined genesis)') : bad('empty tip wrong');
  }

  // (4) TAMPER DETECTION (core property)
  console.log('  (4) TAMPER DETECTION');
  {
    const c = buildChain(sampleTxs(30), 8);   // 4 blocks
    const tip0 = c.tip;
    const t = clone(c); t.blocks[0].txs[2].amount = 999999;             // mutate an OLD block's tx
    const reTip = buildChain(flatten(t.blocks), c.blockSize).tip;
    (reTip !== tip0) ? ok(`tip CHANGED after mutating an old tx (${tip0.slice(0, 8)}… → ${reTip.slice(0, 8)}…)`) : bad('tip unchanged after tamper');
    const v = verifyChain({ blocks: t.blocks });
    (!v.valid && v.firstBadIndex === 0) ? ok('verify() reports INVALID, first broken block = 0') : bad(`verify wrong: ${JSON.stringify(v)}`);
  }

  // (5) INDEPENDENT VERIFY (chain data only)
  console.log('  (5) INDEPENDENT VERIFY');
  {
    const c = buildChain(sampleTxs(25), 8);
    const v = verifyChain(c);
    (v.valid && v.firstBadIndex === -1 && v.tip === c.tip) ? ok('valid chain verifies from genesis using ONLY chain data') : bad(`valid chain failed: ${JSON.stringify(v)}`);
    const trunc = verifyChain({ blocks: c.blocks.slice(0, -1), tip: c.tip });   // drop newest block, keep claimed tip
    (!trunc.valid) ? ok('TRUNCATION caught (chain ends at the wrong head vs the trusted tip)') : bad('truncation not caught');
    const h = clone(c); h.blocks[1].merkleRoot = ZERO;                          // edit a header field only
    const vh = verifyChain({ blocks: h.blocks });
    (!vh.valid && vh.firstBadIndex === 1) ? ok('header tamper caught at block 1') : bad(`header tamper missed: ${JSON.stringify(vh)}`);
  }

  // (6) DETERMINISM
  console.log('  (6) DETERMINISM');
  {
    const txs = sampleTxs(15);
    const a = buildChain(txs, 6).tip;
    (buildChain(txs, 6).tip === a) ? ok('same ledger → same tip (repeatable)') : bad('non-deterministic across calls');
    (buildChain(JSON.parse(JSON.stringify(txs)), 6).tip === a) ? ok('tip stable across serialize/parse (process restart)') : bad('tip changed across restart');
    const reordered = txs.map((t) => { const o = {}; for (const k of Object.keys(t).reverse()) o[k] = t[k]; return o; });
    (buildChain(reordered, 6).tip === a) ? ok('tip independent of tx field insertion order (canonical hashing)') : bad('tip depends on field order');
  }

  // (3/6) SERVER — GET /tip over the REAL ledger + restart determinism
  console.log('  (3/6) SERVER /tip');
  try {
    boot(true); await ready();
    const A = wallet('brick1-a'), B = wallet('brick1-b');
    await ignite(A, 'CODE1', 200000); await ignite(B, 'CODE2', 200000); await send(A, B.address, 40000);
    const tipResp = await get('/tip');
    const ledgerTxs = await get('/ledger');
    const rebuilt = buildChain([...ledgerTxs].reverse());   // verifier rebuilds from public /ledger
    (rebuilt.tip === tipResp.tip && tipResp.tip !== ZERO) ? ok(`GET /tip == chain rebuilt from GET /ledger (${tipResp.tip.slice(0, 10)}…)`) : bad(`/tip mismatch: server ${tipResp.tip} vs rebuilt ${rebuilt.tip}`);
    (verifyChain(rebuilt).valid) ? ok('rebuilt chain verifies from genesis (verify without trusting operator)') : bad('rebuilt chain failed verify');
    await send(B, A.address, 1000);                          // one more tx
    const tip2 = (await get('/tip')).tip;
    (tip2 !== tipResp.tip) ? ok('tip advances when a new tx is committed') : bad('tip did not advance on new tx');
    await kill();
    boot(false); await ready();                              // restart, same data dir
    const tip3 = (await get('/tip')).tip;
    (tip3 === tip2) ? ok('tip identical after process restart (same ledger → same tip)') : bad(`tip changed across restart: ${tip2} vs ${tip3}`);
  } catch (e) { bad('server /tip probe error: ' + e.message); }
  finally { await kill(); }

  // (7) REGRESSION — Phase 0–3 suites still pass (integrity layer is additive)
  console.log('  (7) REGRESSION — Phase 0–3 suites');
  for (const t of ['test_phase0.js', 'test_phase1.js', 'test_phase2.js', 'test_phase3.js']) {
    const code = await runNode(t);
    (code === 0) ? ok(`${t} → exit 0`) : bad(`${t} → exit ${code}`);
  }

  console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Brick 1: ${fails === 0 ? 'ALL PROBES PASS' : fails + ' FAILURE(S)'} — tamper-evident, deterministic, independently verifiable; money rules unchanged.\n`);
  process.exit(fails === 0 ? 0 : 1);
})();
