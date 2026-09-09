// test_phase0.js — behavioural equivalence gate for the Phase-0 ledger seam.
//
// WHAT THIS PROVES
//   The server's observable behaviour is IDENTICAL before and after the
//   LedgerBackend seam is introduced. "Done" = this exits 0.
//
// HOW
//   1. Boot mobile/server.js as a child process against a THROWAWAY data dir
//      (mobile/.phase0_tmp/). The real ledger.json / prod / pm2 are never touched.
//   2. Fire a fixed, deterministic battery of requests (seeded wallets → stable
//      addresses) covering: faucet ignition, a valid transfer, an over-cap
//      transfer (403 Standing limit), an over-balance transfer (400), the
//      standing boundary (exactly standing×10 000 → allowed), and the read
//      endpoints (/ledger, /balance, /tx, /usercount, /health).
//   3. `--golden` captures the PRE-seam responses to phase0_golden.json.
//      Default (verify) re-runs the same battery and compares every status +
//      body to golden EXACTLY (after redacting only volatile fields:
//      timestamp / time / sigPrefix). Any mismatch → non-zero exit.
//
// The golden file is captured ONCE from the pre-seam server and never rewritten
// during the fix loop — so the test can only pass by making the seam behave like
// the original, never by moving the goalposts.

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const nacl = require('tweetnacl');

const HERE       = __dirname;
const SERVER     = path.join(HERE, 'server.js');
const TMP        = path.join(HERE, '.phase0_tmp');
const GOLDEN     = path.join(HERE, 'phase0_golden.json');
const REAL_LEDGER = path.join(HERE, 'ledger.json');           // must never be written
const PORT       = Number(process.env.PHASE0_PORT || (39137 + Math.floor(Math.random() * 8000)));  // random base avoids TIME_WAIT port collisions across nested re-runs
const BASE       = `http://127.0.0.1:${PORT}`;
const CODES      = ['CODE1', 'CODE2', 'CODE3', 'CODE4'];
const MODE       = process.argv.includes('--golden') ? 'golden' : 'verify';

// ── deterministic wallets (seeded → identical addresses every run) ───────────
const toHex = (u8) => Buffer.from(u8).toString('hex');
const seed  = (label) => new Uint8Array(crypto.createHash('sha256').update(label).digest());
function wallet(label) {
  const kp = nacl.sign.keyPair.fromSeed(seed(label));
  const pub = toHex(kp.publicKey);
  return { address: 'M_' + pub.slice(0, 32).toUpperCase(), publicKey: pub, secretKey: kp.secretKey };
}
// mirrors signTx() in App.js: sign the ASCII bytes of `from:to:amount:timestamp`
function signMsg(from, to, amount, ts, sk) {
  const msg = `${from}:${to}:${amount}:${ts}`;
  const bytes = Uint8Array.from(Array.from(msg).map((c) => c.charCodeAt(0)));
  return toHex(nacl.sign.detached(bytes, sk));
}

// ── child server lifecycle ───────────────────────────────────────────────────
let serverLogs = [];
function bootServer() {
  // Fresh throwaway dir. Honour "copy the ledger to a throwaway file": if a real
  // ledger.json exists we copy it in (read-only on the source); otherwise start
  // empty. Either way the server only ever writes inside TMP.
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const tmpLedger = path.join(TMP, 'ledger.json');
  if (fs.existsSync(REAL_LEDGER)) fs.copyFileSync(REAL_LEDGER, tmpLedger);

  // Safety assertion: we are NOT pointing the server at the real ledger.
  if (path.resolve(tmpLedger) === path.resolve(REAL_LEDGER))
    throw new Error('SAFETY: throwaway ledger path collides with the real ledger.json');

  const env = {
    ...process.env,
    NODE_ENV: 'test',                 // relaxes ignition/code throttles
    PORT: String(PORT),
    MONEY_DATA_DIR:   TMP,
    MONEY_LEDGER_FILE: tmpLedger,
    MONEY_FENCE_FILE:  path.join(TMP, 'replay_fence.json'),
    MONEY_CODES_FILE:  path.join(TMP, 'ignition_codes_used.json'),
    IGNITION_CODES: CODES.join(','),
    LEDGER_BACKEND: process.env.LEDGER_BACKEND || 'central',
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
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`server did not become ready on ${BASE}\n--- server output ---\n${serverLogs.join('')}`);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function post(url, body) {
  const r = await fetch(`${BASE}${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function get(url) {
  const r = await fetch(`${BASE}${url}`);
  return { status: r.status, body: await r.json().catch(() => null) };
}
function ignite(w, code, amount) {
  const ts = Date.now();
  return post('/transaction', {
    from: 'FAUCET', to: w.address, amount,
    signature: signMsg('FAUCET', w.address, amount, ts, w.secretKey),
    publicKey: w.publicKey, timestamp: ts, ignitionCode: code,
  });
}
function send(w, to, amount) {
  const ts = Date.now();
  return post('/transaction', {
    from: w.address, to, amount,
    signature: signMsg(w.address, to, amount, ts, w.secretKey),
    publicKey: w.publicKey, timestamp: ts,
  });
}

// ── the battery — identical sequence in both modes ───────────────────────────
async function runBattery() {
  const A = wallet('phase0-alice');
  const B = wallet('phase0-bob');
  const C = wallet('phase0-carol');
  const D = wallet('phase0-dave');
  const cases = {};

  // setup: ignite A, B, C (each gets 200 000; baseline standing 5 → movable 50 000)
  cases.ignite_A = await ignite(A, 'CODE1', 200000);
  cases.ignite_B = await ignite(B, 'CODE2', 200000);
  cases.ignite_C = await ignite(C, 'CODE3', 200000);

  // valid: A → B 40 000  (≤ 50 000 cap, ≤ balance)            → 200 success
  cases.valid = await send(A, B.address, 40000);

  // over-cap: A → C 80 000  (A now standing 6 → movable 60 000, balance 160 000)
  //           passes balance, fails the movement cap          → 403 Standing limit
  cases.over_cap = await send(A, C.address, 80000);

  // over-balance: B → C 2 000 000  (B balance 240 000)          → 400 Insufficient
  cases.over_balance = await send(B, C.address, 2000000);

  // setup: ignite D for an isolated baseline-standing case
  cases.ignite_D = await ignite(D, 'CODE4', 200000);

  // standing boundary: D → A 50 000  (exactly standing 5 × 10 000) → 200 success
  cases.standing_boundary = await send(D, A.address, 50000);

  // read endpoints
  cases.ledger    = await get('/ledger');
  cases.balance_A = await get('/balance/' + A.address);
  cases.tx_from_A = await get('/tx?from=' + A.address);
  cases.usercount = await get('/usercount');
  cases.health    = await get('/health');
  return cases;
}

// ── normalise: redact ONLY genuinely volatile fields ─────────────────────────
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
const norm = (caseResult) => ({ status: caseResult.status, body: normalize(caseResult.body) });

// ── sanity: assert the golden actually exercised the intended code paths ─────
// (runs only at capture time, against the pre-seam server; a failure here means
//  the TEST is wrong and must be fixed BEFORE the seam — not the seam.)
function assertGoldenIsMeaningful(c) {
  const fail = (m) => { throw new Error(`golden sanity failed: ${m}`); };
  const ok = (cond, m) => { if (!cond) fail(m); };
  ok(c.ignite_A.status === 200 && c.ignite_A.body.success === true, 'ignite_A should 200/success');
  ok(c.valid.status === 200 && c.valid.body.success === true, 'valid transfer should 200/success');
  ok(c.over_cap.status === 403 && /Standing limit/.test(c.over_cap.body.error || ''), 'over_cap should 403 Standing limit');
  ok(c.over_cap.body.movable === 60000 && c.over_cap.body.standing === 6, `over_cap math off: ${JSON.stringify(c.over_cap.body)}`);
  ok(c.over_balance.status === 400 && /Insufficient balance/.test(c.over_balance.body.error || ''), 'over_balance should 400 Insufficient balance');
  ok(c.standing_boundary.status === 200 && c.standing_boundary.body.success === true, 'standing boundary (==cap) should 200/success');
  ok(c.ledger.status === 200 && Array.isArray(c.ledger.body) && c.ledger.body.length === 6, `ledger should have exactly 6 txs, got ${c.ledger.body && c.ledger.body.length}`);
  ok(c.usercount.body.count === 4, `usercount should be 4, got ${c.usercount.body && c.usercount.body.count}`);
  ok(c.health.body.transactions === 6, `health.transactions should be 6, got ${c.health.body && c.health.body.transactions}`);
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  if (typeof fetch !== 'function') { console.error('Need Node >=18 for global fetch'); process.exit(2); }
  const child = bootServer();
  let exitCode = 0;
  try {
    await waitReady();
    const cases = await runBattery();

    if (MODE === 'golden') {
      assertGoldenIsMeaningful(cases);
      const golden = {};
      for (const k of Object.keys(cases)) golden[k] = norm(cases[k]);
      fs.writeFileSync(GOLDEN, JSON.stringify(golden, null, 2));
      console.log(`\n✅  GOLDEN captured from PRE-seam server → ${path.basename(GOLDEN)}  (${Object.keys(golden).length} cases)`);
      console.log('    sanity: valid=200, over_cap=403 Standing limit, over_balance=400, boundary=200, ledger=6 txs — all confirmed.');
    } else {
      if (!fs.existsSync(GOLDEN)) { console.error(`No golden file (${GOLDEN}). Run with --golden against the pre-seam server first.`); process.exit(2); }
      const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
      let pass = 0, failN = 0;
      console.log(`\n  Phase-0 seam equivalence — verifying ${Object.keys(golden).length} cases (LEDGER_BACKEND=${process.env.LEDGER_BACKEND || 'central'})\n`);
      for (const k of Object.keys(golden)) {
        const want = JSON.stringify(golden[k]);
        const got  = JSON.stringify(norm(cases[k] || {}));
        if (want === got) { pass++; console.log(`   ✅  ${k}`); }
        else {
          failN++; console.log(`   ❌  ${k}`);
          console.log(`       golden:    ${want}`);
          console.log(`       seam got:  ${got}`);
        }
      }
      console.log(`\n  ${failN === 0 ? '🎉' : '💥'}  ${pass}/${pass + failN} cases match golden exactly.\n`);
      exitCode = failN === 0 ? 0 : 1;
    }
  } catch (e) {
    console.error('\n💥  test error:', e.message);
    exitCode = 2;
  } finally {
    try { child.kill('SIGKILL'); } catch {}
  }
  process.exit(exitCode);
})();
