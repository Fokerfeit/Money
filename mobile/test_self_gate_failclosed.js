// mobile/test_self_gate_failclosed.js — regression test for Cowork's CRITICAL
// finding on d819aa3: self_gate.js's nullifier store failed OPEN on corruption
// (a torn/truncated/hand-edited file silently reset to {}, letting an already-
// sealed nullifier re-mint). Every probe must pass; exit 0.
//
//   UNIT (in-memory storage stub, no disk):
//     1  missing store (getItem→null) is a genuine first boot — does NOT throw
//     2  a valid object loads fine, content is readable
//     3  '' (empty string) → THROWS (looks like a torn write, not "no file")
//     4  invalid JSON → THROWS
//     5  non-object JSON: 'null', '[]', '42', '"str"', 'true' → each THROWS
//   FILE-BASED, hand-rolled raw-fs storage (the literal task scenario — "truncate
//   the persisted file, create a fresh store instance, assert it throws"):
//     6  seal → truncate the file → fresh store instance → THROWS
//   FILE-BASED, via safe_store's dual-bak (the ACTUAL server.js wiring after this
//   fix — reusing the atomic pattern per the task, not hand-rolling a new one):
//     7  seal → corrupt ONLY the main copy (.bak intact) → fresh store → RECOVERS
//        (does not throw, nullifier is still there) — dual-bak resilience works
//        end-to-end through self_gate.js, not just in safe_store.js's own tests
//     8  seal → corrupt BOTH main and .bak → fresh store → THROWS (no recovery
//        possible when both copies are gone)
//   INTEGRATION (real server.js, SELF_GATE=1, store pre-corrupted before boot):
//     9  server still BOOTS and serves other endpoints normally
//     10 POST /ignite/self → 500 {error:'Ignition system error', code:'store-unavailable'}
//     11 a CRITICAL error is logged; no fallback/alternate ignition path is served

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const selfGate = require('./self_gate');
const safeStore = require('./safe_store');

let fails = 0;
const ok  = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };

(async () => {
console.log('\n  SELF-GATE NULLIFIER STORE — FAIL-CLOSED ON CORRUPTION (Cowork CRITICAL finding on d819aa3)\n');

// ── UNIT: in-memory storage stub, direct control over getItem()'s return value ─
console.log('  UNIT — createNullifierStore() with a raw string storage stub');
function stubStorage(returnValue) {
  return { getItem: () => returnValue, setItem: () => {} };
}
{
  let threw = false;
  try { selfGate.createNullifierStore(stubStorage(null)); } catch { threw = true; }
  threw ? bad('(1) getItem()===null (genuine first boot) incorrectly THREW') : ok('(1) getItem()===null (no store yet) does NOT throw — genuine first boot');
}
{
  let threw = false, store;
  try { store = selfGate.createNullifierStore(stubStorage(JSON.stringify({ NULL_A: 'M_' + 'A'.repeat(32) }))); } catch { threw = true; }
  (!threw && store && store.has('NULL_A')) ? ok('(2) a valid object loads without throwing, content is readable') : bad('(2) valid object load failed');
}
for (const [label, raw] of [["'' (empty string)", ''], ['invalid JSON', 'not valid json{{{']]) {
  let threw = false;
  try { selfGate.createNullifierStore(stubStorage(raw)); } catch { threw = true; }
  threw ? ok(`(3/4) ${label} → THROWS (fail-closed)`) : bad(`(3/4) ${label} did NOT throw — silently reset to {} (the exact bug)`);
}
for (const raw of ['null', '[]', '42', '"a string"', 'true']) {
  let threw = false;
  try { selfGate.createNullifierStore(stubStorage(raw)); } catch { threw = true; }
  threw ? ok(`(5) non-object JSON ${JSON.stringify(raw)} → THROWS (fail-closed)`) : bad(`(5) non-object JSON ${JSON.stringify(raw)} did NOT throw`);
}

// ── FILE-BASED, hand-rolled raw fs storage: the literal task scenario ──────────
console.log('\n  FILE-BASED — hand-rolled raw-fs storage, truncate the real file');
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'self_gate_fc_'));
  const FILE = path.join(TMP, 'self_nullifiers.json');
  const rawFsStorage = {
    getItem: () => { try { return fs.readFileSync(FILE, 'utf8'); } catch { return null; } },
    setItem: (_k, v) => fs.writeFileSync(FILE, v),
  };
  const store1 = selfGate.createNullifierStore(rawFsStorage);
  store1.seal('HUMAN_1', 'M_' + '1'.repeat(32));
  const before = fs.readFileSync(FILE, 'utf8');
  if (before.includes('HUMAN_1')) ok('(6a) sealed nullifier persisted to disk'); else bad('(6a) seal did not persist');

  fs.writeFileSync(FILE, before.slice(0, Math.floor(before.length / 2)));   // truncate mid-write
  let threw = false;
  try { selfGate.createNullifierStore(rawFsStorage); } catch { threw = true; }
  threw ? ok('(6b) a fresh store instance over the TRUNCATED file THROWS — does not silently forget HUMAN_1') : bad('(6b) truncated file did NOT throw — a reused nullifier could re-mint');

  fs.rmSync(TMP, { recursive: true, force: true });
}

// ── FILE-BASED, via safe_store dual-bak: the ACTUAL server.js wiring ───────────
console.log('\n  FILE-BASED — safe_store dual-bak (matches server.js after this fix)');
function safeStoreStorage(file) {
  return {
    getItem: () => { const obj = safeStore.loadUnion(file, null); return obj === null ? null : JSON.stringify(obj); },
    setItem: (_k, v) => safeStore.saveAtomicDual(file, v),
  };
}
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'self_gate_fc_dualbak_'));
  const FILE = path.join(TMP, 'self_nullifiers.json');
  const storage = safeStoreStorage(FILE);
  const store1 = selfGate.createNullifierStore(storage);
  store1.seal('HUMAN_2', 'M_' + '2'.repeat(32));

  // (7) corrupt ONLY the main copy — .bak is intact (dualBak always carries the
  // newest content, so it has HUMAN_2 too) — a fresh store must RECOVER.
  fs.writeFileSync(FILE, 'GARBAGE-NOT-JSON');
  let recovered = false, threw7 = false;
  try {
    const store2 = selfGate.createNullifierStore(storage);
    recovered = store2.has('HUMAN_2');
  } catch { threw7 = true; }
  (recovered && !threw7) ? ok('(7) main copy corrupted, .bak intact → fresh store RECOVERS via .bak, HUMAN_2 still sealed (no data loss, no false throw)')
                         : bad(`(7) dual-bak recovery failed: recovered=${recovered} threw=${threw7}`);

  // (8) now corrupt BOTH copies — no recovery is possible → must THROW.
  fs.writeFileSync(FILE, 'GARBAGE-NOT-JSON');
  fs.writeFileSync(FILE + '.bak', 'ALSO-GARBAGE');
  let threw8 = false;
  try { selfGate.createNullifierStore(storage); } catch { threw8 = true; }
  threw8 ? ok('(8) BOTH main and .bak corrupted → fresh store THROWS (no silent reset — this is the actual unrecoverable case)')
         : bad('(8) both copies corrupted did NOT throw — silent reset would let a used nullifier re-mint');

  fs.rmSync(TMP, { recursive: true, force: true });
}

// ── INTEGRATION: real server.js boots with a pre-corrupted store ───────────────
console.log('\n  INTEGRATION — real server.js, SELF_GATE=1, nullifier store corrupted BEFORE boot');
{
  const TMP = path.join(__dirname, '.self_gate_failclosed_tmp');
  fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true });
  const SELF_FILE = path.join(TMP, 'self_nullifiers.json');
  fs.writeFileSync(SELF_FILE, 'CORRUPTED-BEFORE-BOOT');
  fs.writeFileSync(SELF_FILE + '.bak', 'ALSO-CORRUPTED');

  const port = 39400 + Math.floor(Math.random() * 4000);
  const BASE = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, NODE_ENV: 'test', PORT: String(port), MONEY_DATA_DIR: TMP,
    MONEY_LEDGER_FILE: path.join(TMP, 'ledger.json'), MONEY_FENCE_FILE: path.join(TMP, 'replay_fence.json'),
    MONEY_CODES_FILE: path.join(TMP, 'ignition_codes_used.json'), MONEY_SELF_FILE: SELF_FILE,
    LEDGER_BACKEND: 'central', IGNITION_CODES: '',
    SELF_GATE: '1', SELF_GATE_STUB: '1',
  };
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function ready(ms = 10000) {
    const dl = Date.now() + ms;
    while (Date.now() < dl) { try { const r = await fetch(`${BASE}/health`); if (r.ok) return true; } catch {} await sleep(100); }
    return false;
  }

  try {
    const booted = await ready();
    if (booted) ok('(9) server BOOTED despite the corrupted nullifier store — one broken flag-gated feature did not take down the whole process');
    else bad('(9) server did NOT boot — corrupted store crashed the ENTIRE money server, not just /ignite/self\n' + logs.join(''));

    if (booted) {
      const igniteRes = await fetch(`${BASE}/ignite/self`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wallet: 'M_' + '9'.repeat(32), stub: { valid: true, nullifier: 'SHOULD_NOT_MINT' } }),
      });
      const igniteBody = await igniteRes.json();
      (igniteRes.status === 500 && igniteBody.error === 'Ignition system error' && igniteBody.code === 'store-unavailable')
        ? ok('(10) POST /ignite/self → 500 "Ignition system error" (code: store-unavailable) — no silent fallback, no mint')
        : bad(`(10) unexpected /ignite/self response: ${igniteRes.status} ${JSON.stringify(igniteBody)}`);

      const balRes = await fetch(`${BASE}/balance/M_${'9'.repeat(32)}`);
      (balRes.ok)
        ? ok('a completely unrelated endpoint (/balance) still works — the rest of the server is unaffected')
        : bad(`unrelated endpoint /balance failed too: ${balRes.status}`);
    }

    const logText = logs.join('');
    (/CRITICAL/i.test(logText) && /nullifier store/i.test(logText))
      ? ok('(11) a CRITICAL error naming the nullifier store was logged at boot')
      : bad(`(11) expected a CRITICAL nullifier-store log line, got:\n${logText.slice(-500)}`);
  } finally {
    const c = child;
    if (c.exitCode === null && c.signalCode === null) {
      await new Promise((r) => { c.once('exit', r); try { c.kill('SIGKILL'); } catch { r(); } });
    }
    await sleep(100);
    fs.rmSync(TMP, { recursive: true, force: true });
  }
}

console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Self-gate fail-closed: ${fails === 0 ? 'ALL PROBES PASS' : fails + ' FAILURE(S)'}\n`);
process.exit(fails === 0 ? 0 : 1);
})();
