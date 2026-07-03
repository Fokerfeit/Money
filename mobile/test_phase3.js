// test_phase3.js — Phase-3 read-from-committee gate. Every probe must pass; exit 0.
//
//  1 SOURCE FLIP        — read endpoints are committee-sourced (proven via /debug/read
//                          source + the reconciler read tally).
//  2 CONTRACT IDENTICAL — every read endpoint is BYTE-IDENTICAL to the Phase-0/2 golden.
//  3 DIVERGENCE SAFETY  — inject committee≠central → system serves CENTRAL + logs it.
//  4 FALLBACK           — committee read throws → serve central, no user-facing 500.
//  5 PERSIST SURFACING  — unwritable committee_state.json → error in /debug/shadow.
//  6 REGRESSION         — restart durability, idempotency, integer money, standing parity.
//
// SAFETY: child server vs a THROWAWAY dir. Never touches real ledger.json / pm2 / prod.

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const nacl = require('tweetnacl');

const HERE        = __dirname;
const SERVER      = path.join(HERE, 'server.js');
const TMP         = path.join(HERE, '.phase3_tmp');
const COMMITTEE_FILE = path.join(TMP, 'committee_state.json');
const GOLDEN      = path.join(HERE, 'phase0_golden.json');
const REAL_LEDGER = path.join(HERE, 'ledger.json');
const CODES       = Array.from({ length: 12 }, (_, i) => 'CODE' + (i + 1));
const PHASE0_CASES = ['ignite_A','ignite_B','ignite_C','valid','over_cap','over_balance',
                      'ignite_D','standing_boundary','ledger','balance_A','tx_from_A','usercount','health'];
const calcReward = (count) => { const t = Math.floor(count / 1_000_000); let r = 1_000_000; for (let i = 0; i < t; i++) r *= 0.8; return Math.max(Math.floor(r), 1); };

const toHex = (u8) => Buffer.from(u8).toString('hex');
const seed  = (l) => new Uint8Array(crypto.createHash('sha256').update(l).digest());
function wallet(l) { const kp = nacl.sign.keyPair.fromSeed(seed(l)); const pub = toHex(kp.publicKey); return { address: 'M_' + pub.slice(0, 32).toUpperCase(), publicKey: pub, secretKey: kp.secretKey }; }
function signMsg(from, to, amount, ts, sk) { const m = `${from}:${to}:${amount}:${ts}`; return toHex(nacl.sign.detached(Uint8Array.from(Array.from(m).map((c) => c.charCodeAt(0))), sk)); }

let portCounter = Number(process.env.PHASE3_PORT || (39150 + Math.floor(Math.random() * 8000)));  // random base avoids TIME_WAIT port collisions across nested re-runs
let BASE = '', serverLogs = [], currentChild = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function bootServer(reset, committeeFile = COMMITTEE_FILE) {
  if (reset) { fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true }); if (fs.existsSync(REAL_LEDGER)) fs.copyFileSync(REAL_LEDGER, path.join(TMP, 'ledger.json')); }
  const tmpLedger = path.join(TMP, 'ledger.json');
  if (path.resolve(tmpLedger) === path.resolve(REAL_LEDGER)) throw new Error('SAFETY: throwaway collides with real ledger.json');
  const port = portCounter++;
  BASE = `http://127.0.0.1:${port}`;
  const env = { ...process.env, NODE_ENV: 'test', PORT: String(port), MONEY_DATA_DIR: TMP, MONEY_LEDGER_FILE: tmpLedger,
    MONEY_FENCE_FILE: path.join(TMP, 'replay_fence.json'), MONEY_CODES_FILE: path.join(TMP, 'ignition_codes_used.json'),
    MONEY_COMMITTEE_FILE: committeeFile, IGNITION_CODES: CODES.join(','), LEDGER_BACKEND: 'committee-shadow' };
  serverLogs = [];
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => serverLogs.push(d.toString())); child.stderr.on('data', (d) => serverLogs.push(d.toString()));
  currentChild = child; return child;
}
async function killServer() { if (!currentChild) return; const c = currentChild; currentChild = null; await new Promise((res) => { c.once('exit', res); try { c.kill('SIGKILL'); } catch { res(); } }); await sleep(150); }
async function waitReady(ms = 10000) { const dl = Date.now() + ms; while (Date.now() < dl) { try { const r = await fetch(`${BASE}/health`); if (r.ok) return true; } catch {} await sleep(100); } throw new Error(`not ready ${BASE}\n${serverLogs.join('')}`); }

async function post(u, b) { const r = await fetch(`${BASE}${u}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; }
async function get(u) { const r = await fetch(`${BASE}${u}`); return { status: r.status, body: await r.json().catch(() => null) }; }
function ignite(w, code, amount) { const ts = Date.now(); return post('/transaction', { from: 'FAUCET', to: w.address, amount, signature: signMsg('FAUCET', w.address, amount, ts, w.secretKey), publicKey: w.publicKey, timestamp: ts, ignitionCode: code }); }
function send(w, to, amount) { const ts = Date.now(); return post('/transaction', { from: w.address, to, amount, signature: signMsg(w.address, to, amount, ts, w.secretKey), publicKey: w.publicKey, timestamp: ts }); }

const VOLATILE = new Set(['timestamp', 'time', 'sigPrefix']);
function normalize(v) { if (Array.isArray(v)) return v.map(normalize); if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = VOLATILE.has(k) ? '<volatile>' : normalize(v[k]); return o; } return v; }
const norm = (c) => ({ status: c.status, body: normalize(c.body) });

const A = wallet('phase0-alice'), B = wallet('phase0-bob'), C = wallet('phase0-carol'), D = wallet('phase0-dave');
async function runPrefix() {
  const cases = {};
  cases.ignite_A = await ignite(A, 'CODE1', 200000); cases.ignite_B = await ignite(B, 'CODE2', 200000); cases.ignite_C = await ignite(C, 'CODE3', 200000);
  cases.valid = await send(A, B.address, 40000); cases.over_cap = await send(A, C.address, 80000); cases.over_balance = await send(B, C.address, 2000000);
  cases.ignite_D = await ignite(D, 'CODE4', 200000); cases.standing_boundary = await send(D, A.address, 50000);
  cases.ledger = await get('/ledger'); cases.balance_A = await get('/balance/' + A.address); cases.tx_from_A = await get('/tx?from=' + A.address);
  cases.usercount = await get('/usercount'); cases.health = await get('/health');
  return cases;
}
async function ensureGolden() {
  if (fs.existsSync(GOLDEN)) return JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  bootServer(true); try { await waitReady(); const c = await runPrefix(); const g = {}; for (const k of PHASE0_CASES) g[k] = norm(c[k]); fs.writeFileSync(GOLDEN, JSON.stringify(g, null, 2)); return g; } finally { await killServer(); }
}

let fails = 0;
const ok = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };
const shadow = async () => (await get('/debug/shadow')).body;

(async () => {
  if (typeof fetch !== 'function') { console.error('Need Node >=18'); process.exit(2); }
  const golden = await ensureGolden();
  try {
    // ===== STAGE 1: boot + prefix; probes 1, 2, 6a/6b =====
    console.log('\n  STAGE 1 — read source flip + contract identity\n');
    bootServer(true); await waitReady();
    const cases = await runPrefix();

    console.log('  (2) CONTRACT IDENTICAL — every endpoint vs frozen golden');
    let allEq = true;
    for (const k of PHASE0_CASES) { const same = JSON.stringify(norm(cases[k])) === JSON.stringify(golden[k]); if (!same) { allEq = false; bad(`${k} diverged: got ${JSON.stringify(norm(cases[k]))}`); } }
    if (allEq) ok('all 13 endpoints byte-identical to golden (reads committee-sourced, writes unchanged)');

    console.log('\n  (1) SOURCE FLIP — reads computed from committee, not central');
    for (const [what, addr, exp] of [['balance', A.address, 210000], ['standing', A.address, 7], ['usercount', null, 4], ['ledgerlen', null, 6]]) {
      const r = (await get(`/debug/read?what=${what}${addr ? '&addr=' + addr : ''}`)).body;
      (r.source === 'committee' && r.value === exp) ? ok(`/debug/read ${what} → source=committee, value=${r.value}`) : bad(`${what} not committee-sourced: ${JSON.stringify(r)}`);
    }
    const c0 = (await shadow()).reads.committee;
    await get('/balance/' + A.address); await get('/ledger'); await get('/usercount');
    const c1 = (await shadow()).reads.committee;
    (c1 - c0 === 3) ? ok(`read tally: /balance + /ledger + /usercount did ${c1 - c0} committee reads`) : bad(`expected 3 committee reads, got ${c1 - c0}`);

    console.log('\n  (6) REGRESSION — clean reconcile + idempotency + standing parity + integer');
    const s1 = await shadow();
    (s1.reconciled && s1.driftCount === 0 && s1.errorCount === 0 && s1.size.central === s1.size.committee) ? ok(`reconciled clean — drift 0, errors 0, size ${s1.size.central}`) : bad(`not clean: ${JSON.stringify({ d: s1.driftCount, e: s1.errorCount, sz: s1.size })}`);
    const re = (await post('/debug/shadow/resync', {})).body; const re2 = (await post('/debug/shadow/resync', {})).body;
    (re.applied === 0 && re2.applied === 0) ? ok('idempotent: resync ×2 applied 0') : bad(`resync double-applied: ${re.applied},${re2.applied}`);
    let tiersInt = true; for (let t = 0; t <= 15; t++) if (!Number.isInteger(calcReward(t * 1_000_000))) tiersInt = false;
    tiersInt ? ok('integer money: calcReward integer at every tier 0..15') : bad('calcReward non-integer');
    // standing parity: committee-sourced standing/movable match the rule (5 + distinct cp; min(bal, standing×10000))
    for (const [w, st, mv] of [[A, 7, 70000], [B, 6, 60000], [C, 5, 50000], [D, 6, 60000]]) {
      const rs = (await get(`/debug/read?what=standing&addr=${w.address}`)).body;
      const rm = (await get(`/debug/read?what=movable&addr=${w.address}`)).body;
      (rs.value === st && rs.source === 'committee' && rm.value === mv) ? ok(`standing parity ${w === A ? 'A' : w === B ? 'B' : w === C ? 'C' : 'D'}: standing ${st}, movable ${mv} (committee)`) : bad(`standing parity off: ${JSON.stringify({ rs, rm })}`);
    }

    // ===== STAGE 2: RESTART durability (regression) =====
    console.log('\n  (6) RESTART — committee reloads its own state, reads stay correct');
    await killServer(); bootServer(false); await waitReady();
    const s2 = await shadow();
    (s2.reconciled && s2.driftCount === 0) ? ok(`after restart: reconciled, drift 0, size ${s2.size.committee}`) : bad(`restart drift: ${JSON.stringify(s2)}`);
    const ll = (await get('/debug/read?what=ledgerlen')).body;
    (ll.source === 'committee' && ll.value === s2.size.central) ? ok(`/ledger committee-sourced after restart (len ${ll.value})`) : bad(`ledger not durable: ${JSON.stringify(ll)}`);
    const bA = (await get('/balance/' + A.address)).body;
    (bA.balance === 210000) ? ok('balance committee-sourced + correct after restart (210000)') : bad(`balance wrong after restart: ${bA.balance}`);

    // ===== STAGE 3: DIVERGENCE SAFETY =====
    console.log('\n  (3) DIVERGENCE — committee≠central must serve CENTRAL + log');
    const eBefore = (await shadow()).errorCount;
    await post('/debug/shadow/perturb', { addr: A.address, balanceDelta: 999 });
    const dr = (await get('/debug/read?what=balance&addr=' + A.address)).body;
    const dbal = (await get('/balance/' + A.address)).body;
    const sDiv = await shadow();
    (dr.source === 'central' && dr.value === 210000 && dbal.balance === 210000) ? ok('served CENTRAL (210000) despite committee=210999 — no wrong value') : bad(`served wrong value: read=${JSON.stringify(dr)} bal=${JSON.stringify(dbal)}`);
    (sDiv.errorCount > eBefore && sDiv.errors.some((e) => e.kind === 'divergence')) ? ok(`divergence logged (errorCount ${eBefore}→${sDiv.errorCount}, errors[] has kind:divergence)`) : bad(`divergence not logged: ${JSON.stringify(sDiv.errors)}`);
    await post('/debug/shadow/perturb', { addr: A.address, balanceDelta: -999 }); // restore
    const drR = (await get('/debug/read?what=balance&addr=' + A.address)).body;
    (drR.source === 'committee' && drR.value === 210000) ? ok('after restore: committee-sourced again') : bad(`restore failed: ${JSON.stringify(drR)}`);

    // ===== STAGE 4: FALLBACK =====
    console.log('\n  (4) FALLBACK — committee read throws → central, no user 500');
    const e4 = (await shadow()).errorCount;
    await post('/debug/shadow/fault', { on: true });
    const fr = await get('/debug/read?what=balance&addr=' + A.address);
    const fbal = await get('/balance/' + A.address);
    const sF = await shadow();
    (fr.body.source === 'central' && fr.body.value === 210000) ? ok('read layer fell back to central on committee fault') : bad(`fallback read wrong: ${JSON.stringify(fr.body)}`);
    (fbal.status === 200 && fbal.body.balance === 210000) ? ok('GET /balance returned 200 + correct value under fault (no 500)') : bad(`fallback endpoint wrong: status ${fbal.status} ${JSON.stringify(fbal.body)}`);
    (sF.errorCount > e4 && sF.errors.some((e) => e.kind === 'fallback')) ? ok(`fault logged (errorCount ${e4}→${sF.errorCount})`) : bad(`fault not logged: ${JSON.stringify(sF.errors)}`);
    await post('/debug/shadow/fault', { on: false });
    const fok = (await get('/debug/read?what=balance&addr=' + A.address)).body;
    (fok.source === 'committee') ? ok('after fault cleared: committee-sourced again') : bad(`fault not cleared: ${JSON.stringify(fok)}`);

    // ===== STAGE 5: PERSIST-ERROR SURFACING (separate boot, unwritable committee file) =====
    console.log('\n  (5) PERSIST SURFACING — unwritable committee_state.json → error visible');
    await killServer();
    fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true });
    const dirAsFile = path.join(TMP, 'committee_dir'); fs.mkdirSync(dirAsFile); // a directory → writeFileSync EISDIR
    bootServer(false, dirAsFile); await waitReady();
    const E = wallet('phase3-eve');
    const ig = await ignite(E, 'CODE5', 123456);
    const sP = await shadow();
    (ig.status === 200 && ig.body.success === true) ? ok('commit succeeded (200) despite committee persist failure — central unaffected') : bad(`commit not 200: ${ig.status} ${JSON.stringify(ig.body)}`);
    (sP.errorCount > 0 && sP.errors.some((e) => /persist failed/.test(e.error || ''))) ? ok(`persist error SURFACED in /debug/shadow (errorCount ${sP.errorCount})`) : bad(`persist error not surfaced: ${JSON.stringify(sP.errors)}`);
    const eb = (await get('/balance/' + E.address)).body;
    (eb.balance === 123456) ? ok('balance still correct under persist failure (123456)') : bad(`balance wrong under persist failure: ${eb.balance}`);

    console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Phase-3 read-from-committee: ${fails === 0 ? 'ALL PROBES PASS' : fails + ' FAILURE(S)'} — committee-sourced reads, central verify/fallback, persist surfacing; writes unchanged.\n`);
  } catch (e) { console.error('\n💥  test error:', e.message); fails++; }
  finally { await killServer(); }
  process.exit(fails === 0 ? 0 : 1);
})();
