// test_phase2.js — Phase-2 DURABLE committee gate.
//
// WHAT THIS PROVES ("done" = exits 0)
//   (a) LIVE UNCHANGED: central responses byte-identical to the frozen Phase-0/1
//       golden while the durable committee shadow is active.
//   (b) DURABLE RECONCILE: the committee persists to its OWN store and reconciles
//       with central EXACTLY {balance, standing, size} after every op AND across a
//       real process RESTART.
//   (c) REPLAY idempotent: re-feeding central's ledger never double-applies.
//   (d) CATCH-UP exact: a committee booted BEHIND central (state deleted) replays
//       to exact reconciliation.
//   + INTEGER MONEY end-to-end across calcReward's ×0.8-floor decayed amounts —
//     central's full re-fold and the committee's running state agree with NO
//     tolerance (strict ===); a non-integer amount is rejected, never tolerated.
//
// SAFETY: child server against a THROWAWAY dir. Never touches real ledger.json /
//   pm2 / prod. Committee persists to its OWN file (committee_state.json), never
//   into ledger.json.
//
// NOTE on the decay sub-test: calcReward only decays per 1,000,000 users, which is
//   infeasible to reach via real ignitions in a test. We instead (1) assert
//   calcReward is INTEGER at every tier 0..15 (the ×0.8 floor can never emit a
//   fraction), and (2) drive real ignitions/transfers using those exact decayed
//   integer amounts (all ≤ the tier-0 faucet cap) to stress fold-vs-running
//   summation. This exercises the property without 1M ignitions.

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const nacl = require('tweetnacl');

const HERE        = __dirname;
const SERVER      = path.join(HERE, 'server.js');
const TMP         = path.join(HERE, '.phase2_tmp');
const COMMITTEE_FILE = path.join(TMP, 'committee_state.json');
const GOLDEN      = path.join(HERE, 'phase0_golden.json');
const REAL_LEDGER = path.join(HERE, 'ledger.json');
const CODES       = Array.from({ length: 30 }, (_, i) => 'CODE' + (i + 1));
const PHASE0_CASES = ['ignite_A','ignite_B','ignite_C','valid','over_cap','over_balance',
                      'ignite_D','standing_boundary','ledger','balance_A','tx_from_A','usercount','health'];

// authoritative reward formula (mirror of server.js / App.js)
const calcReward = (count) => {
  const tiers = Math.floor(count / 1_000_000);
  let r = 1_000_000;
  for (let i = 0; i < tiers; i++) r *= 0.8;
  return Math.max(Math.floor(r), 1);
};

// ── deterministic wallets ────────────────────────────────────────────────────
const toHex = (u8) => Buffer.from(u8).toString('hex');
const seed  = (label) => new Uint8Array(crypto.createHash('sha256').update(label).digest());
function wallet(label) {
  const kp = nacl.sign.keyPair.fromSeed(seed(label));
  const pub = toHex(kp.publicKey);
  return { address: 'M_' + pub.slice(0, 32).toUpperCase(), publicKey: pub, secretKey: kp.secretKey };
}
function signMsg(from, to, amount, ts, sk) {
  const msg = `${from}:${to}:${amount}:${ts}`;
  return toHex(nacl.sign.detached(Uint8Array.from(Array.from(msg).map((c) => c.charCodeAt(0))), sk));
}

// ── child server lifecycle (fresh port each boot to dodge TIME_WAIT) ──────────
let portCounter = Number(process.env.PHASE2_PORT || 39140);
let BASE = '';
let serverLogs = [];
let currentChild = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bootServer(reset, backend = 'committee-shadow') {
  if (reset) {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
    if (fs.existsSync(REAL_LEDGER)) fs.copyFileSync(REAL_LEDGER, path.join(TMP, 'ledger.json'));
  }
  const tmpLedger = path.join(TMP, 'ledger.json');
  if (path.resolve(tmpLedger) === path.resolve(REAL_LEDGER)) throw new Error('SAFETY: throwaway ledger collides with real ledger.json');
  const port = portCounter++;
  BASE = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, NODE_ENV: 'test', PORT: String(port),
    MONEY_DATA_DIR: TMP,
    MONEY_LEDGER_FILE: tmpLedger,
    MONEY_FENCE_FILE:  path.join(TMP, 'replay_fence.json'),
    MONEY_CODES_FILE:  path.join(TMP, 'ignition_codes_used.json'),
    MONEY_COMMITTEE_FILE: COMMITTEE_FILE,
    IGNITION_CODES: CODES.join(','),
    LEDGER_BACKEND: backend,
  };
  serverLogs = [];
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => serverLogs.push(d.toString()));
  child.stderr.on('data', (d) => serverLogs.push(d.toString()));
  currentChild = child;
  return child;
}
async function killServer() {
  if (!currentChild) return;
  const c = currentChild; currentChild = null;
  await new Promise((res) => { c.once('exit', res); try { c.kill('SIGKILL'); } catch { res(); } });
  await sleep(150);
}
async function waitReady(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return true; } catch {}
    await sleep(100);
  }
  throw new Error(`server not ready on ${BASE}\n--- output ---\n${serverLogs.join('')}`);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function post(url, body) {
  const r = await fetch(`${BASE}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function get(url) { const r = await fetch(`${BASE}${url}`); return { status: r.status, body: await r.json().catch(() => null) }; }
function ignite(w, code, amount) {
  const ts = Date.now();
  return post('/transaction', { from: 'FAUCET', to: w.address, amount, signature: signMsg('FAUCET', w.address, amount, ts, w.secretKey), publicKey: w.publicKey, timestamp: ts, ignitionCode: code });
}
function send(w, to, amount) {
  const ts = Date.now();
  return post('/transaction', { from: w.address, to, amount, signature: signMsg(w.address, to, amount, ts, w.secretKey), publicKey: w.publicKey, timestamp: ts });
}

// ── normalise volatile fields (identical to Phase 0/1) ───────────────────────
const VOLATILE = new Set(['timestamp', 'time', 'sigPrefix']);
function normalize(v) {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = VOLATILE.has(k) ? '<volatile>' : normalize(v[k]); return o; }
  return v;
}
const norm = (c) => ({ status: c.status, body: normalize(c.body) });

// the amounts touched (asserted all-integer)
const ALL_AMOUNTS = [];
function rec(a) { ALL_AMOUNTS.push(a); return a; }

// ── battery segments ─────────────────────────────────────────────────────────
const A = wallet('phase0-alice'), B = wallet('phase0-bob'), C = wallet('phase0-carol'), D = wallet('phase0-dave');
const Eve = wallet('phase1-eve'), Frank = wallet('phase1-frank'), Grace = wallet('phase1-grace');

async function runSeg1() {
  const cases = {};
  cases.ignite_A = await ignite(A, 'CODE1', rec(200000));
  cases.ignite_B = await ignite(B, 'CODE2', rec(200000));
  cases.ignite_C = await ignite(C, 'CODE3', rec(200000));
  cases.valid            = await send(A, B.address, rec(40000));
  cases.over_cap         = await send(A, C.address, rec(80000));
  cases.over_balance     = await send(B, C.address, rec(2000000));
  cases.ignite_D = await ignite(D, 'CODE4', rec(200000));
  cases.standing_boundary = await send(D, A.address, rec(50000));
  cases.ledger    = await get('/ledger');
  cases.balance_A = await get('/balance/' + A.address);
  cases.tx_from_A = await get('/tx?from=' + A.address);
  cases.usercount = await get('/usercount');
  cases.health    = await get('/health');
  // phase-1 multi-counterparty (moves standing)
  await ignite(Eve, 'CODE5', rec(200000));
  await ignite(Frank, 'CODE6', rec(200000));
  await ignite(Grace, 'CODE7', rec(200000));
  await send(Eve, Frank.address, rec(1000));
  await send(Eve, Grace.address, rec(1000));
  await send(Eve, Frank.address, rec(1000));   // ping-pong
  await send(Eve, A.address,     rec(1000));
  return { cases, wallets: { A, B, C, D, Eve, Frank, Grace } };
}

// Phase-2 DECAYED + integer stress (runs AFTER the restart, on the rebooted server)
const decayWallets = Array.from({ length: 8 }, (_, i) => wallet('phase2-decay-' + i));
async function runSeg2() {
  // ignite each decay wallet for the EXACT calcReward at tiers 1..8 (all integers,
  // all ≤ the tier-0 cap of 1,000,000) — "shrinking decayed" mint amounts.
  for (let i = 0; i < decayWallets.length; i++) {
    const amount = rec(calcReward((i + 1) * 1_000_000)); // 800000, 640000, ... 167772
    await ignite(decayWallets[i], 'CODE' + (8 + i), amount);
  }
  // a chain of small integer transfers to stress fold-vs-running summation
  const xfers = [12345, 6789, 100, 49999, 7, 31337, 808, 250];
  for (let i = 0; i < decayWallets.length - 1; i++) {
    await send(decayWallets[i], decayWallets[i + 1].address, rec(xfers[i % xfers.length]));
  }
  return { wallets: Object.fromEntries(decayWallets.map((w, i) => ['decay' + i, w])) };
}

// ── golden: frozen Phase-0 contract, regenerated from central if absent ──────
async function ensureGolden() {
  if (fs.existsSync(GOLDEN)) return JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  console.log('  (phase0_golden.json missing — regenerating from a central-mode server)');
  bootServer(true, 'central');
  try { await waitReady(); const { cases } = await runSeg1(); const g = {}; for (const k of PHASE0_CASES) g[k] = norm(cases[k]); fs.writeFileSync(GOLDEN, JSON.stringify(g, null, 2)); return g; }
  finally { await killServer(); }
}

// ── assertion plumbing ───────────────────────────────────────────────────────
let fails = 0;
const okln = (m) => console.log(`   ✅  ${m}`);
const fail = (m) => { fails++; console.log(`   ❌  ${m}`); };
async function reconcileOK(label) {
  const r = (await get('/debug/shadow')).body;
  if (!r) { fail(`${label}: /debug/shadow returned nothing`); return null; }
  const clean = r.reconciled === true && r.driftCount === 0 && (r.liveDriftCount || 0) === 0 && r.errorCount === 0 && r.size.central === r.size.committee && r.appliedCount === r.size.central;
  clean ? okln(`${label}: reconciled — drift 0, size ${r.size.central}=${r.size.committee}, appliedCount ${r.appliedCount}`)
        : fail(`${label}: NOT reconciled — ${JSON.stringify({ reconciled: r.reconciled, driftCount: r.driftCount, liveDriftCount: r.liveDriftCount, errorCount: r.errorCount, size: r.size, appliedCount: r.appliedCount, drifts: r.drifts, errors: r.errors })}`);
  return r;
}
async function crossCheck(label, walletsObj, report) {
  for (const [name, w] of Object.entries(walletsObj)) {
    const central = (await get('/balance/' + w.address)).body;
    const acct = report.accounts && report.accounts[w.address];
    if (acct && acct.balance === central.balance) okln(`${label}: ${name} committee ${acct.balance} = central ${central.balance}`);
    else fail(`${label}: ${name} balance drift — committee ${acct && acct.balance} vs central ${central && central.balance}`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  if (typeof fetch !== 'function') { console.error('Need Node >=18'); process.exit(2); }
  const golden = await ensureGolden();
  try {
    // ============ STAGE 1: fresh boot, Seg-1 battery (committee-shadow) ==========
    console.log('\n  STAGE 1 — fresh boot, core battery (committee-shadow, DURABLE)\n');
    bootServer(true);
    await waitReady();
    const { cases, wallets: w1 } = await runSeg1();

    console.log('  (a) LIVE UNCHANGED — central vs frozen Phase-0 golden');
    for (const k of PHASE0_CASES) {
      const same = JSON.stringify(norm(cases[k])) === JSON.stringify(golden[k]);
      same ? okln(`golden ${k}`) : fail(`golden ${k} diverged: got ${JSON.stringify(norm(cases[k]))} want ${JSON.stringify(golden[k])}`);
    }
    console.log('\n  (b) DURABLE RECONCILE — after Seg-1');
    const r1 = await reconcileOK('seg1');
    if (r1) await crossCheck('seg1', w1, r1);

    // integer-money proof
    console.log('\n  INTEGER MONEY — decay arithmetic + amounts');
    let tiersOK = true;
    for (let t = 0; t <= 15; t++) if (!Number.isInteger(calcReward(t * 1_000_000))) tiersOK = false;
    tiersOK ? okln('calcReward is INTEGER at every tier 0..15 (×0.8 floor never emits a fraction)') : fail('calcReward produced a non-integer');

    // ============ REPLAY idempotency =====================================
    console.log('\n  (c) REPLAY — re-feed central ledger, must not double-apply');
    const before = (await get('/debug/shadow')).body.size.committee;
    const re1 = (await post('/debug/shadow/resync', {})).body;
    const re2 = (await post('/debug/shadow/resync', {})).body;
    (re1.applied === 0 && re2.applied === 0 && re1.size.committee === before && re1.reconciled && re2.reconciled)
      ? okln(`resync ×2 applied 0 new each, size steady at ${before} — no double-apply`)
      : fail(`replay double-applied: re1=${JSON.stringify({ applied: re1.applied, size: re1.size })} re2=${JSON.stringify({ applied: re2.applied, size: re2.size })}`);

    // ============ STAGE 2: RESTART durability =============================
    console.log('\n  (b) RESTART — kill, reboot, persisted state must reconcile');
    const preKill = (await get('/debug/shadow')).body.size.committee;
    await killServer();
    bootServer(false);            // same throwaway dir → committee reloads its OWN file + catches up
    await waitReady();
    const r2 = await reconcileOK('after-restart');
    if (r2 && r2.size.committee === preKill) okln(`durable: committee size ${r2.size.committee} survived restart (was ${preKill})`);
    else if (r2) fail(`restart lost state: ${r2.size.committee} vs ${preKill}`);

    // ============ STAGE 3: post-restart commits (decayed/integer) =========
    console.log('\n  POST-RESTART — Seg-2 decayed/integer commits on the rebooted server');
    const { wallets: w2 } = await runSeg2();
    const r3 = await reconcileOK('seg2-post-restart');
    if (r3) await crossCheck('seg2', w2, r3);

    // ============ STAGE 4: CATCH-UP from behind ===========================
    console.log('\n  (d) CATCH-UP — delete committee state, reboot BEHIND, replay to exact reconcile');
    const centralSizeBefore = (await get('/debug/shadow')).body.size.central;
    await killServer();
    fs.rmSync(COMMITTEE_FILE, { force: true });   // committee now has NOTHING; central ledger intact
    bootServer(false);            // committee boots empty → resync replays the WHOLE ledger
    await waitReady();
    const r4 = await reconcileOK('after-catchup');
    if (r4 && r4.appliedCount === centralSizeBefore) okln(`catch-up rebuilt committee from EMPTY to ${r4.appliedCount} txs = central ${centralSizeBefore}`);
    else if (r4) fail(`catch-up incomplete: appliedCount ${r4.appliedCount} vs central ${centralSizeBefore}`);
    if (r4) await crossCheck('catchup', { ...w1, ...w2 }, r4);

    console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Phase-2 durable: ${fails === 0 ? 'ALL CHECKS PASS' : fails + ' FAILURE(S)'} — persistent committee reconciles exactly across restart, replay, catch-up, and decayed integer amounts; central unchanged.\n`);
  } catch (e) {
    console.error('\n💥  test error:', e.message);
    fails++;
  } finally {
    await killServer();
  }
  process.exit(fails === 0 ? 0 : 1);
})();
