// probe_self_tamper.js — the four attacks on the Self ignition gate. Every probe
// must be REJECTED and the Brick 1 tip must not move. Exit 0 iff all four hold.
//
//   1 REPLAY      a used proof (same nullifier, fresh wallet)     → rejected
//   2 FLIPPED     a proof the verifier rejects (one byte flipped) → rejected
//   3 GARBAGE     a malformed body carrying no valid proof         → rejected
//   4 SWAPPED     a VALID proof paired with a DIFFERENT wallet     → rejected  ← the 1a attack
//
// This runs the REAL server.js with the test stub verifier (NODE_ENV=test,
// SELF_GATE_STUB=1) — the same seam test_self_gate.js uses, since a real zk proof
// cannot be fabricated in CI. HONEST SCOPE: probes 1, 3 and 4 are end-to-end at the
// gate/HTTP layer. Probe 2 exercises the gate's "verifier rejected → no mint" path;
// the CRYPTOGRAPHIC rejection of a byte-flipped real proof is @selfxyz/core's job
// (it recomputes the userContextData hash and THROWS on mismatch — verified by code
// inspection, not reproducible with a stub). Probe 4 is the wallet-binding fix and
// is genuinely end-to-end: the stub returns a valid verdict bound to wallet A while
// the request asks to ignite wallet B.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let fails = 0;
const ok  = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };

const A = 'M_' + 'A'.repeat(32);
const B = 'M_' + 'B'.repeat(32);
const G = 'M_' + 'C'.repeat(32);

const TMP = path.join(__dirname, '.selftamper_tmp');
const SELF_FILE = path.join(TMP, 'self_nullifiers.json');
let BASE = '', child = null, logs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function boot() {
  fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true });
  const port = 47000 + Math.floor(Math.random() * 8000); BASE = `http://127.0.0.1:${port}`; logs = [];
  const env = { ...process.env, NODE_ENV: 'test', PORT: String(port), MONEY_DATA_DIR: TMP,
    MONEY_LEDGER_FILE: path.join(TMP, 'ledger.json'), MONEY_FENCE_FILE: path.join(TMP, 'replay_fence.json'),
    MONEY_CODES_FILE: path.join(TMP, 'ignition_codes_used.json'), MONEY_SELF_FILE: SELF_FILE,
    LEDGER_BACKEND: 'central', IGNITION_CODES: '', SELF_GATE: '1', SELF_GATE_STUB: '1' };
  child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => logs.push(d.toString())); child.stderr.on('data', (d) => logs.push(d.toString()));
}
async function kill() { if (!child) return; const c = child; child = null; try { c.stdout.removeAllListeners(); c.stderr.removeAllListeners(); } catch {} await new Promise((r) => { c.once('exit', r); try { c.kill('SIGKILL'); } catch { r(); } }); await sleep(200); }
async function ready(ms = 10000) { const dl = Date.now() + ms; while (Date.now() < dl) { try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch {} await sleep(100); } throw new Error('server not ready\n' + logs.join('')); }
const tip = async () => (await (await fetch(`${BASE}/tip`)).json());
const balance = async (w) => (await (await fetch(`${BASE}/balance/${w}`)).json());

// POST /ignite/self with an arbitrary body (each probe crafts its own).
async function ignite(body) {
  const r = await fetch(`${BASE}/ignite/self`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

(async () => {
  console.log('\n  🛡️   SELF GATE — TAMPER PROBES\n');
  boot();
  try {
    await ready();

    // Seed a legitimate ignition so REPLAY has a used nullifier to reuse.
    const good = await ignite({ wallet: A, stub: { valid: true, nullifier: 'NULL_SEED_1' } });
    (good.status === 200 && good.body && good.body.success)
      ? ok('setup: an honest proof ignited wallet A (baseline)')
      : bad(`setup FAILED — honest ignite did not succeed: ${JSON.stringify(good.body)}`);

    const tipAfterSetup = await tip();

    // 1 REPLAY — same nullifier, brand-new wallet B. The sybil core must reject.
    const replay = await ignite({ wallet: B, stub: { valid: true, nullifier: 'NULL_SEED_1' } });
    (replay.status === 409 && replay.body.code === 'nullifier-used')
      ? ok('1 REPLAY rejected — a used nullifier cannot ignite a second wallet')
      : bad(`1 REPLAY not rejected as expected: ${replay.status} ${JSON.stringify(replay.body)}`);
    ((await balance(B)).balance === 0)
      ? ok('   wallet B stayed at 0 after the replay')
      : bad('   wallet B gained a balance from a replayed nullifier');

    // 2 FLIPPED — a proof the verifier rejects (valid:false stands in for a byte-
    //   flipped proof that fails the zk check). Must not mint, must not seal.
    const flipped = await ignite({ wallet: G, stub: { valid: false, nullifier: 'NULL_FLIP' } });
    (flipped.status === 401 && flipped.body.code === 'invalid-proof')
      ? ok('2 FLIPPED rejected — verifier said invalid, no mint')
      : bad(`2 FLIPPED not rejected as expected: ${flipped.status} ${JSON.stringify(flipped.body)}`);

    // 3 GARBAGE — a malformed body with no stub verdict at all.
    const garbage = await ignite({ wallet: G, proof: 'not-a-proof', publicSignals: ['garbage'] });
    (garbage.status === 401 && (garbage.body.code === 'invalid-proof' || garbage.body.code === 'verify-error'))
      ? ok('3 GARBAGE rejected — a body with no valid proof mints nothing')
      : bad(`3 GARBAGE not rejected as expected: ${garbage.status} ${JSON.stringify(garbage.body)}`);

    // 4 SWAPPED WALLET — the 1a attack. A VALID proof bound to A, replayed to ignite
    //   G. The nullifier is fresh, so ONLY the wallet-binding guard can catch it.
    const swapped = await ignite({ wallet: G, stub: { valid: true, nullifier: 'NULL_SWAP', boundWallet: A } });
    (swapped.status === 400 && swapped.body.code === 'wallet-mismatch')
      ? ok('4 SWAPPED rejected — proof bound to A cannot ignite G (the 1a fix)')
      : bad(`4 SWAPPED not rejected as expected: ${swapped.status} ${JSON.stringify(swapped.body)}`);
    ((await balance(G)).balance === 0)
      ? ok('   wallet G stayed at 0 after the swap attempt')
      : bad('   wallet G gained a balance from a swapped-wallet proof');

    // The nullifier from the swap must NOT have been sealed (guard is before the seal).
    const swapReuse = await ignite({ wallet: A, stub: { valid: true, nullifier: 'NULL_SWAP', boundWallet: A } });
    // A is already ignited, so this is rejected as wallet-ignited — NOT nullifier-used.
    // If it came back nullifier-used, the swap had wrongly sealed NULL_SWAP.
    (swapReuse.body.code !== 'nullifier-used')
      ? ok('   the swapped proof never sealed its nullifier (guard runs before the seal)')
      : bad('   the swapped proof sealed its nullifier — seal happened before the guard');

    // TIP UNCHANGED — no rejected attack advanced the ledger.
    const tipEnd = await tip();
    (tipEnd.tip === tipAfterSetup.tip && tipEnd.txs === tipAfterSetup.txs)
      ? ok(`tip unchanged across all four attacks (txs=${tipEnd.txs})`)
      : bad(`tip MOVED: ${JSON.stringify(tipAfterSetup)} → ${JSON.stringify(tipEnd)}`);

  } catch (e) {
    bad('probe crashed: ' + e.message);
  } finally {
    await kill();
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Tamper probes: ${fails === 0 ? 'ALL FOUR ATTACKS REJECTED' : fails + ' FAILURE(S)'}\n`);
  process.exit(fails === 0 ? 0 : 1);
})();
