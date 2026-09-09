// test_phase1.js — Phase-1 committee SHADOW gate.
//
// WHAT THIS PROVES
//   (a) LIVE UNCHANGED: with the committee shadow active (LEDGER_BACKEND=
//       committee-shadow), central's responses are byte-identical to the frozen
//       Phase-0 golden — the shadow changes nothing a user sees.
//   (b) RECONCILED EXACTLY: the committee, computing balance & standing
//       independently from per-account state, agrees with central EXACTLY on
//       {balance, standing, size} for every account across the whole battery —
//       including a multi-counterparty sequence that moves standing.
//   "Done" = this exits 0.
//
// SAFETY: boots mobile/server.js as a child against a THROWAWAY data dir. Never
//   touches the real ledger.json / pm2 / prod.

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const nacl = require('tweetnacl');

const HERE        = __dirname;
const SERVER      = path.join(HERE, 'server.js');
const TMP         = path.join(HERE, '.phase1_tmp');
const GOLDEN      = path.join(HERE, 'phase0_golden.json');   // the frozen Phase-0 contract
const REAL_LEDGER = path.join(HERE, 'ledger.json');          // must never be written
const PORT        = Number(process.env.PHASE1_PORT || (39138 + Math.floor(Math.random() * 8000)));  // random base avoids TIME_WAIT port collisions across nested re-runs
const BASE        = `http://127.0.0.1:${PORT}`;
const CODES       = ['CODE1','CODE2','CODE3','CODE4','CODE5','CODE6','CODE7'];
const PHASE0_CASES = ['ignite_A','ignite_B','ignite_C','valid','over_cap','over_balance',
                      'ignite_D','standing_boundary','ledger','balance_A','tx_from_A','usercount','health'];

// ── deterministic wallets (seeded → identical addresses every run) ───────────
const toHex = (u8) => Buffer.from(u8).toString('hex');
const seed  = (label) => new Uint8Array(crypto.createHash('sha256').update(label).digest());
function wallet(label) {
  const kp = nacl.sign.keyPair.fromSeed(seed(label));
  const pub = toHex(kp.publicKey);
  return { address: 'M_' + pub.slice(0, 32).toUpperCase(), publicKey: pub, secretKey: kp.secretKey };
}
function signMsg(from, to, amount, ts, sk) {
  const msg = `${from}:${to}:${amount}:${ts}`;
  const bytes = Uint8Array.from(Array.from(msg).map((c) => c.charCodeAt(0)));
  return toHex(nacl.sign.detached(bytes, sk));
}

// ── child server lifecycle ───────────────────────────────────────────────────
let serverLogs = [];
function bootServer(backend) {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const tmpLedger = path.join(TMP, 'ledger.json');
  if (fs.existsSync(REAL_LEDGER)) fs.copyFileSync(REAL_LEDGER, tmpLedger);
  if (path.resolve(tmpLedger) === path.resolve(REAL_LEDGER))
    throw new Error('SAFETY: throwaway ledger path collides with the real ledger.json');
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(PORT),
    MONEY_DATA_DIR:   TMP,
    MONEY_LEDGER_FILE: tmpLedger,
    MONEY_FENCE_FILE:  path.join(TMP, 'replay_fence.json'),
    MONEY_CODES_FILE:  path.join(TMP, 'ignition_codes_used.json'),
    IGNITION_CODES: CODES.join(','),
    LEDGER_BACKEND: backend,
  };
  serverLogs = [];
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => serverLogs.push(d.toString()));
  child.stderr.on('data', (d) => serverLogs.push(d.toString()));
  return child;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitReady(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return true; } catch {}
    await sleep(100);
  }
  throw new Error(`server did not become ready on ${BASE}\n--- server output ---\n${serverLogs.join('')}`);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function post(url, body) {
  const r = await fetch(`${BASE}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function get(url) {
  const r = await fetch(`${BASE}${url}`);
  return { status: r.status, body: await r.json().catch(() => null) };
}
function ignite(w, code, amount) {
  const ts = Date.now();
  return post('/transaction', { from: 'FAUCET', to: w.address, amount,
    signature: signMsg('FAUCET', w.address, amount, ts, w.secretKey), publicKey: w.publicKey, timestamp: ts, ignitionCode: code });
}
function send(w, to, amount) {
  const ts = Date.now();
  return post('/transaction', { from: w.address, to, amount,
    signature: signMsg(w.address, to, amount, ts, w.secretKey), publicKey: w.publicKey, timestamp: ts });
}

// ── the battery: Phase-0 prefix (13 golden cases) + Phase-1 standing sequence ─
async function runFullBattery() {
  const A = wallet('phase0-alice'), B = wallet('phase0-bob'), C = wallet('phase0-carol'), D = wallet('phase0-dave');
  const Eve = wallet('phase1-eve'), Frank = wallet('phase1-frank'), Grace = wallet('phase1-grace');
  const cases = {};

  // --- Phase-0 prefix: IDENTICAL sequence to test_phase0 → the 13 golden cases ---
  cases.ignite_A = await ignite(A, 'CODE1', 200000);
  cases.ignite_B = await ignite(B, 'CODE2', 200000);
  cases.ignite_C = await ignite(C, 'CODE3', 200000);
  cases.valid            = await send(A, B.address, 40000);
  cases.over_cap         = await send(A, C.address, 80000);
  cases.over_balance     = await send(B, C.address, 2000000);
  cases.ignite_D = await ignite(D, 'CODE4', 200000);
  cases.standing_boundary = await send(D, A.address, 50000);
  cases.ledger    = await get('/ledger');
  cases.balance_A = await get('/balance/' + A.address);
  cases.tx_from_A = await get('/tx?from=' + A.address);
  cases.usercount = await get('/usercount');
  cases.health    = await get('/health');

  // --- Phase-1 extra: a multi-counterparty sequence that MOVES standing ---
  // Eve trades with 3 DISTINCT counterparties (standing 5→6→7→8) with a
  // ping-pong in the middle that must NOT raise standing (diversity, not volume).
  await ignite(Eve,   'CODE5', 200000);
  await ignite(Frank, 'CODE6', 200000);
  await ignite(Grace, 'CODE7', 200000);
  await send(Eve, Frank.address, 1000);   // Eve cp {Frank}        → standing 6
  await send(Eve, Grace.address, 1000);   // Eve cp {Frank,Grace}  → standing 7
  await send(Eve, Frank.address, 1000);   // ping-pong (same cp)   → standing STAYS 7
  await send(Eve, A.address,     1000);   // Eve cp {Frank,Grace,A}→ standing 8

  return { cases, wallets: { A, B, C, D, Eve, Frank, Grace } };
}

// ── normalise volatile fields (identical to Phase 0) ─────────────────────────
const VOLATILE = new Set(['timestamp', 'time', 'sigPrefix']);
function normalize(v) {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = VOLATILE.has(k) ? '<volatile>' : normalize(v[k]);
    return out;
  }
  return v;
}
const norm = (c) => ({ status: c.status, body: normalize(c.body) });

// ── golden: use the frozen Phase-0 contract; regenerate from central if absent ─
async function ensureGolden() {
  if (fs.existsSync(GOLDEN)) return JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  console.log('  (phase0_golden.json missing — regenerating the Phase-0 baseline from a central-mode server)');
  const child = bootServer('central');
  try {
    await waitReady();
    const { cases } = await runFullBattery();
    const golden = {};
    for (const k of PHASE0_CASES) golden[k] = norm(cases[k]);
    fs.writeFileSync(GOLDEN, JSON.stringify(golden, null, 2));
    return golden;
  } finally { try { child.kill('SIGKILL'); } catch {} }
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  if (typeof fetch !== 'function') { console.error('Need Node >=18 for global fetch'); process.exit(2); }
  const golden = await ensureGolden();

  const child = bootServer('committee-shadow');
  let fails = 0;
  const fail = (m) => { fails++; console.log(`   ❌  ${m}`); };
  const okln = (m) => console.log(`   ✅  ${m}`);
  try {
    await waitReady();
    const { cases, wallets } = await runFullBattery();

    // ── (a) central responses byte-identical to the Phase-0 golden ──────────
    console.log('\n  (a) LIVE UNCHANGED — central responses vs frozen Phase-0 golden\n');
    for (const k of PHASE0_CASES) {
      const want = JSON.stringify(golden[k]);
      const got  = JSON.stringify(norm(cases[k] || {}));
      if (want === got) okln(k);
      else { fail(`${k} diverged from golden`); console.log(`       golden:   ${want}`); console.log(`       shadow:   ${got}`); }
    }

    // ── (b) committee reconciles EXACTLY against central ────────────────────
    console.log('\n  (b) RECONCILED EXACTLY — committee shadow vs central\n');
    const shadow = (await get('/debug/shadow')).body;
    if (!shadow) { fail('/debug/shadow returned nothing (shadow endpoint missing?)'); }
    else {
      shadow.reconciled === true ? okln(`reconciled = true (driftCount ${shadow.driftCount}, errorCount ${shadow.errorCount})`)
        : fail(`reconciled = false — drifts=${JSON.stringify(shadow.drifts)} errors=${JSON.stringify(shadow.errors)}`);
      shadow.driftCount === 0 ? okln('driftCount = 0 across the whole battery') : fail(`driftCount = ${shadow.driftCount}`);
      shadow.errorCount === 0 ? okln('errorCount = 0 (committee never faulted)') : fail(`errorCount = ${shadow.errorCount}`);
      (shadow.size && shadow.size.central === shadow.size.committee)
        ? okln(`size matches: central ${shadow.size.central} = committee ${shadow.size.committee}`)
        : fail(`size mismatch: ${JSON.stringify(shadow.size)}`);

      // cross-check committee balance vs central /balance for every touched wallet
      for (const [name, w] of Object.entries(wallets)) {
        const central = (await get('/balance/' + w.address)).body;
        const acct = shadow.accounts && shadow.accounts[w.address];
        if (acct && acct.balance === central.balance) okln(`${name} balance reconciles (committee ${acct.balance} = central ${central.balance})`);
        else fail(`${name} balance drift: committee ${acct && acct.balance} vs central ${central && central.balance}`);
      }

      // sanity: the standing-moving sequence really moved standing (and ping-pong didn't over-count)
      const acc = shadow.accounts || {};
      const eve = acc[wallets.Eve.address], frank = acc[wallets.Frank.address], grace = acc[wallets.Grace.address];
      (eve && eve.standing === 8 && eve.counterparties.length === 3)
        ? okln('standing MOVED: Eve standing 8 via 3 distinct counterparties (ping-pong did not inflate it)')
        : fail(`Eve standing/counterparties wrong: ${JSON.stringify(eve)}`);
      (frank && frank.standing === 6) ? okln('Frank standing 6 (1 distinct counterparty)') : fail(`Frank standing wrong: ${JSON.stringify(frank)}`);
      (grace && grace.standing === 6) ? okln('Grace standing 6 (1 distinct counterparty)') : fail(`Grace standing wrong: ${JSON.stringify(grace)}`);
    }

    console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Phase-1 shadow: ${fails === 0 ? 'ALL CHECKS PASS' : fails + ' FAILURE(S)'} — central unchanged AND committee reconciles exactly.\n`);
  } catch (e) {
    console.error('\n💥  test error:', e.message);
    fails++;
  } finally {
    try { child.kill('SIGKILL'); } catch {}
  }
  process.exit(fails === 0 ? 0 : 1);
})();
