// test_hardening.js — atomic fail-closed storage + crash-safe self-gate mint.
// Every probe must pass; exit 0.
//   1 ATOMICITY        (torn write → last GOOD state, never garbage/empty)
//   2 FAIL-CLOSED      (corrupt→.bak; both→THROW / server REFUSES boot; null-shape + empty-wipe caught; first boot clean)
//   3 NO RE-MINT ON CORRUPTION  (dual-.bak + union survive the last-seal window; auditSeals refuses a dropped seal;
//                                LIVE reproduced attack yields no 2nd mint — Cowork WARN P2c, dead)
//   4 CRASH REPAIR     (seal-without-mint → repairPending mints once, idempotent; standing 5; tip advances)
//   5 ORDER            (seal-before-commit in claim(); a verifier failure mints/seals nothing)
//   6 REGRESSION       (Self gate / Brick 1 / Brick 2 both bites / Phase 0–3 pass; no bare writeFileSync for the 3 stores)

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const S = require('./safe_store');
const SG = require('./self_gate');
const { buildChain, ZERO } = require('./ledger_chain');
const { standingOf } = require('./swarm/committee_bridge');

let fails = 0;
const ok  = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };

const TMP = path.join(__dirname, '.hardening_tmp');
const freshDir = (name) => { const d = path.join(TMP, name); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; };
const corrupt = (file) => fs.writeFileSync(file, 'GARBAGE}}}{{{ not json');

// faithful mock LedgerBackend (FAUCET mint semantics + isIgnited), chronological
function mockLedger() {
  const txs = [];
  return { _txs: txs, commit: (t) => txs.push(t), isIgnited: (a) => txs.some((t) => t.from === 'FAUCET' && t.to === a), all: () => txs.slice() };
}
const memStorage = (init = {}) => { let map = { ...init }; return { load: () => map, save: (m) => { map = m; }, _get: () => map }; };
// a real file-backed storage using safe_store (what the server uses)
// the EXACT production wiring for the nullifier set: union-load + dual-.bak write.
const fileStorage = (file) => ({ load: () => S.loadUnion(file, {}), save: (m) => S.saveAtomicDual(file, m) });
const W = (c) => 'M_' + c.repeat(32);

// ── server boot harness (for the refuse-boot + crash-repair integration probes) ──
const toHex = (u8) => Buffer.from(u8).toString('hex');
const nacl = require('tweetnacl');
const crypto = require('crypto');
const seed = (l) => new Uint8Array(crypto.createHash('sha256').update(l).digest());
function wallet(l) { const kp = nacl.sign.keyPair.fromSeed(seed(l)); const pub = toHex(kp.publicKey); return { address: 'M_' + pub.slice(0, 32).toUpperCase(), publicKey: pub, secretKey: kp.secretKey }; }
function signMsg(from, to, amount, ts, sk) { const m = `${from}:${to}:${amount}:${ts}`; return toHex(nacl.sign.detached(Uint8Array.from(Array.from(m).map((c) => c.charCodeAt(0))), sk)); }
let portCounter = 39360;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function envFor(dir, port) {
  return { ...process.env, NODE_ENV: 'test', PORT: String(port), MONEY_DATA_DIR: dir,
    MONEY_LEDGER_FILE: path.join(dir, 'ledger.json'), MONEY_FENCE_FILE: path.join(dir, 'replay_fence.json'),
    MONEY_CODES_FILE: path.join(dir, 'ignition_codes_used.json'), MONEY_SELF_FILE: path.join(dir, 'self_nullifiers.json'),
    LEDGER_BACKEND: 'central', IGNITION_CODES: '', SELF_GATE: '1', SELF_GATE_STUB: '1' };
}
function bootLive(dir) {
  const port = portCounter++; const BASE = `http://127.0.0.1:${port}`; const logs = [];
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: envFor(dir, port), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => logs.push(d.toString())); child.stderr.on('data', (d) => logs.push(d.toString()));
  return { child, BASE, logs };
}
async function ready(BASE, logs, ms = 10000) { const dl = Date.now() + ms; while (Date.now() < dl) { try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch {} await sleep(100); } throw new Error('server not ready\n' + logs.join('')); }
async function killChild(child) { if (!child) return; await new Promise((r) => { child.once('exit', r); try { child.kill('SIGKILL'); } catch { r(); } }); await sleep(150); }
// boot expecting the process to EXIT on its own (refuse-boot). Returns {code, out}.
function bootExpectExit(dir, ms = 8000) {
  return new Promise((resolve) => {
    const port = portCounter++; const out = [];
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: envFor(dir, port), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => out.push(d.toString())); child.stderr.on('data', (d) => out.push(d.toString()));
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve({ code: 'TIMEOUT', out: out.join('') }); }, ms);
    child.on('exit', (code) => { clearTimeout(t); resolve({ code, out: out.join('') }); });
  });
}
const getJSON = async (BASE, u) => (await fetch(`${BASE}${u}`)).json();
const mintSelf = (BASE, addr, n) => fetch(`${BASE}/ignite/self`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: addr, stub: { valid: true, nullifier: n } }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
function runNode(file) { return new Promise((res) => { const c = spawn(process.execPath, [path.join(__dirname, file)], { stdio: 'ignore' }); c.on('exit', (code) => res(code)); }); }

(async () => {
  console.log('\n  HARDENING — atomic fail-closed storage + crash-safe self-gate\n');
  fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true });

  // (1) ATOMICITY
  console.log('  (1) ATOMICITY');
  {
    const d = freshDir('atomic'); const f = path.join(d, 'store.json');
    S.saveAtomic(f, { v: 1 }); S.saveAtomic(f, { v: 2 });                 // two good saves → .bak exists
    fs.writeFileSync(f + '.tmp', 'HALF-WRITTEN GARBAGE {');              // simulate an interrupted write (torn .tmp)
    const loaded = S.loadStrict(f, null);
    const noTmpLeak = loaded && loaded.v === 2;
    const neverEmpty = JSON.stringify(loaded) !== '{}' && JSON.stringify(loaded) !== '[]';
    (noTmpLeak && neverEmpty && S.isParseable(fs.readFileSync(f, 'utf8')))
      ? ok('torn write (garbage .tmp) → next load returns the last GOOD state (v=2), never garbage, never empty')
      : bad(`atomicity failed: ${JSON.stringify(loaded)}`);
  }

  // (2) FAIL-CLOSED
  console.log('  (2) FAIL-CLOSED');
  {
    const d = freshDir('failclosed'); const f = path.join(d, 'store.json');
    S.saveAtomic(f, { keep: 'A' }); S.saveAtomic(f, { keep: 'B' });      // file={B}, bak={A}
    corrupt(f);                                                          // corrupt MAIN only
    const rec = S.loadStrict(f, null);
    (rec && rec.keep === 'A') ? ok('corrupt main file → loadStrict recovers from .bak (keep=A)') : bad(`bak recovery failed: ${JSON.stringify(rec)}`);
    corrupt(f + '.bak');                                                 // now corrupt BOTH
    let threw = false; try { S.loadStrict(f, null); } catch { threw = true; }
    (threw) ? ok('corrupt BOTH main + .bak → loadStrict THROWS (fail-closed, refuses silent reset)') : bad('corrupt-both did not throw');
    const fresh = path.join(freshDir('firstboot'), 'nope.json');
    (JSON.stringify(S.loadStrict(fresh, [])) === '[]') ? ok('first boot (no file, no .bak) → clean fallback []') : bad('first boot fallback wrong');

    // a file that PARSES but to a non-object (literal null / primitive) is corruption,
    // NOT a first boot — must not slip past as a silent reset.
    const sd = path.join(freshDir('shape'), 'store.json');
    S.saveAtomic(sd, { keep: 'X' }); S.saveAtomic(sd, { keep: 'Y' });   // bak={X}
    fs.writeFileSync(sd, 'null');                                       // parses to null (not garbage)
    const shapeRec = S.loadStrict(sd, null);
    (shapeRec && shapeRec.keep === 'X') ? ok('a file of literal `null` is treated as corruption → recovers .bak, never a silent {}') : bad(`null-shape not caught: ${JSON.stringify(shapeRec)}`);
    fs.writeFileSync(sd + '.bak', '12345');                             // both non-object now
    let shapeThrew = false; try { S.loadStrict(sd, {}); } catch { shapeThrew = true; }
    (shapeThrew) ? ok('null/primitive in BOTH main + .bak → THROWS (no silent reset via a parseable non-object)') : bad('null-shape both did not throw');

    // a valid-but-EMPTY main while .bak holds data is a suspicious wipe → recover .bak
    const ed = path.join(freshDir('emptywipe'), 'ledger.json');
    S.saveAtomic(ed, [1, 2, 3]); S.saveAtomic(ed, [1, 2, 3, 4]);        // bak=[1,2,3]
    fs.writeFileSync(ed, '[]');                                         // main externally reset to empty
    const wipeRec = S.loadStrict(ed, []);
    (Array.isArray(wipeRec) && wipeRec.length === 3) ? ok('empty [] main while .bak is non-empty → recovers .bak (never a silent wipe)') : bad(`empty-wipe not caught: ${JSON.stringify(wipeRec)}`);

    // nullifier store fails closed on corruption (does NOT reset to {})
    const nf = path.join(freshDir('nullstore'), 'self.json');
    S.saveAtomic(nf, { N1: W('A') }); S.saveAtomic(nf, { N1: W('A'), N2: W('B') });  // bak={N1}
    corrupt(nf); corrupt(nf + '.bak');
    let storeThrew = false; try { SG.createNullifierStore(fileStorage(nf)); } catch { storeThrew = true; }
    (storeThrew) ? ok('nullifier store on a doubly-corrupt file → createNullifierStore THROWS (never silently empty)') : bad('nullifier store silently reset on corruption');

    // LEDGER: server REFUSES to boot on an unrecoverable corrupt ledger
    const ld = freshDir('ledgerboot');
    fs.writeFileSync(path.join(ld, 'ledger.json'), 'CORRUPT LEDGER {{{');
    fs.writeFileSync(path.join(ld, 'ledger.json.bak'), 'CORRUPT BAK {{{');
    const res = await bootExpectExit(ld);
    (res.code !== 0 && res.code !== 'TIMEOUT' && /Refusing to boot/i.test(res.out))
      ? ok(`corrupt ledger + .bak → server REFUSES to boot (exit ${res.code}, "Refusing to boot…") — never a silently-empty ledger`)
      : bad(`ledger refuse-boot failed: code=${res.code} out=${res.out.slice(-200)}`);
  }

  // (3) NO RE-MINT ON CORRUPTION (Cowork WARN P2c) — the reviewer reproduced a 2nd mint
  //     via the ".bak lags by one" window; dual-.bak + union-load + the auditSeals
  //     backstop close it: a used nullifier survives single-copy corruption, and a
  //     truly-lost seal REFUSES rather than silently re-mints.
  console.log('  (3) NO RE-MINT ON CORRUPTION');
  {
    // DUAL-.bak RECOVERY: the exact reviewer window — N2 is the LAST seal — now survives
    const d = freshDir('remint'); const f = path.join(d, 'self.json');
    const led = mockLedger();
    const g1 = SG.createSelfGate({ verify: () => Promise.resolve({ valid: true, nullifier: 'N1' }), ledger: led, store: SG.createNullifierStore(fileStorage(f)) });
    await g1.claim({}, W('A'));                                          // seal N1 → mint A (main=bak={N1})
    const g2 = SG.createSelfGate({ verify: () => Promise.resolve({ valid: true, nullifier: 'N2' }), ledger: led, store: SG.createNullifierStore(fileStorage(f)) });
    await g2.claim({}, W('B'));                                          // seal N2 → mint B (main=bak={N1,N2})
    const mintsBefore = led._txs.length;
    corrupt(f);                                                         // corrupt MAIN only (the reviewer's trigger)
    const recovered = SG.createNullifierStore(fileStorage(f));          // loadUnion → dual .bak still has N2
    const reclaim = SG.createSelfGate({ verify: () => Promise.resolve({ valid: true, nullifier: 'N2' }), ledger: led, store: recovered });
    const r = await reclaim.claim({}, W('C'));                          // re-present the LAST nullifier on a new wallet
    (recovered.has('N2') && !r.ok && r.code === 'nullifier-used' && led._txs.length === mintsBefore)
      ? ok('the LAST-sealed nullifier survives main-file corruption (dual-.bak + union) → re-claim REJECTED, no second mint')
      : bad(`dual-bak re-mint hole: ${JSON.stringify({ hasN2: recovered.has('N2'), r, mints: led._txs.length, before: mintsBefore })}`);

    // BOTH copies corrupt → union THROWS → the gate refuses (fail-closed, no re-mint)
    corrupt(f + '.bak');
    let refused = false; try { SG.createNullifierStore(fileStorage(f)); } catch { refused = true; }
    (refused) ? ok('both copies corrupt → store load THROWS → gate refuses (a used nullifier can never re-mint)') : bad('corrupt-both did not refuse');

    // auditSeals BACKSTOP (unit): a self_ignition mint with NO backing seal is an orphan
    const led3 = mockLedger();
    led3.commit({ from: 'FAUCET', to: W('Z'), amount: 1_000_000, reason: 'self_ignition' });  // minted, seal lost
    const emptyStore = SG.createNullifierStore(memStorage());
    const boundStore = SG.createNullifierStore(memStorage({ NZ: W('Z') }));
    (SG.auditSeals(led3, emptyStore).includes(W('Z')) && SG.auditSeals(led3, boundStore).length === 0)
      ? ok('auditSeals flags a minted-but-unsealed wallet (dropped seal) and passes when the binding is present')
      : bad('auditSeals wrong');

    // END-TO-END on the real server: the reviewer's exact attack now yields NO 2nd mint
    const d2 = freshDir('remint_live');
    const A = wallet('remint-A'); const Bw = wallet('remint-B'); const C = wallet('remint-C');
    let s = bootLive(d2); await ready(s.BASE, s.logs);
    await mintSelf(s.BASE, A.address, 'RN1');
    await mintSelf(s.BASE, Bw.address, 'RN2');                          // RN2 is the last seal (main-only pre-dual; now dual)
    const balB1 = (await getJSON(s.BASE, `/balance/${Bw.address}`)).balance;
    await killChild(s.child);
    corrupt(path.join(d2, 'self_nullifiers.json'));                    // corrupt MAIN self store only
    s = bootLive(d2); await ready(s.BASE, s.logs);                      // reboot → union recovers RN2 from .bak
    const reMint = await mintSelf(s.BASE, C.address, 'RN2');           // re-present RN2 on a fresh wallet
    const balC = (await getJSON(s.BASE, `/balance/${C.address}`)).balance;
    await killChild(s.child);
    (balB1 === 1_000_000 && reMint.status === 409 && reMint.body.code === 'nullifier-used' && balC === 0)
      ? ok('LIVE reproduced attack: corrupt-main + reboot + re-present last nullifier → 409, new wallet gets 0 (one human, one 1,000,000)')
      : bad(`live re-mint: ${JSON.stringify({ balB1, reMint, balC })}`);

    // auditSeals REFUSE-BOOT (live): a seal truly lost from BOTH copies while the mint
    // persists → server refuses to boot rather than leave the nullifier re-mintable.
    const d3 = freshDir('audit_refuse');
    const Aw = wallet('audit-A');
    let s2 = bootLive(d3); await ready(s2.BASE, s2.logs);
    await mintSelf(s2.BASE, Aw.address, 'AUD1');                        // ledger: self_ignition → Aw; store {AUD1:Aw}
    await killChild(s2.child);
    const sf = path.join(d3, 'self_nullifiers.json');
    fs.writeFileSync(sf, '{}'); fs.writeFileSync(sf + '.bak', '{}');    // seal wiped from BOTH copies (mint remains)
    const refuseRes = await bootExpectExit(d3);
    (refuseRes.code !== 0 && refuseRes.code !== 'TIMEOUT' && /no nullifier seal/i.test(refuseRes.out))
      ? ok(`minted wallet with its seal wiped from both copies → server REFUSES to boot (exit ${refuseRes.code}) — never leaves a nullifier re-mintable`)
      : bad(`auditSeals refuse-boot failed: code=${refuseRes.code} out=${refuseRes.out.slice(-200)}`);
  }

  // (4) CRASH REPAIR
  console.log('  (4) CRASH REPAIR');
  {
    // simulate a crash BETWEEN seal and mint: nullifier sealed, wallet NOT ignited
    const led = mockLedger();
    const store = SG.createNullifierStore(memStorage());
    store.seal('N', W('R'));                                            // sealed, no mint
    const tip0 = buildChain(led.all()).tip;
    const n1 = SG.repairPending(led, store);                            // completes the pending mint
    const tip1 = buildChain(led.all()).tip;
    const n2 = SG.repairPending(led, store);                            // idempotent
    const balR = led.all().reduce((b, t) => t.to === W('R') ? b + t.amount : t.from === W('R') ? b - t.amount : b, 0);
    const mintsToR = led.all().filter((t) => t.from === 'FAUCET' && t.to === W('R')).length;
    (n1 === 1 && n2 === 0 && balR === 1_000_000 && mintsToR === 1 && standingOf(led.all(), W('R')) === 5 && tip0 === ZERO && tip1 !== ZERO)
      ? ok('seal-without-mint → repairPending mints exactly 1,000,000 once (idempotent 2nd run = 0); standing 5; Brick 1 tip advanced once')
      : bad(`repair failed: ${JSON.stringify({ n1, n2, balR, mintsToR, standing: standingOf(led.all(), W('R')), tipAdvanced: tip0 === ZERO && tip1 !== ZERO })}`);

    // INTEGRATION: the real server runs repairPending at boot
    const d = freshDir('repairboot');
    const A = wallet('harden-A'); const R2 = wallet('harden-R2');
    let s = bootLive(d); await ready(s.BASE, s.logs);
    await mintSelf(s.BASE, A.address, 'NULL_A');                        // normal claim (self file = {NULL_A: A})
    const tipBefore = (await getJSON(s.BASE, '/tip')).tip;
    await killChild(s.child);
    // inject a sealed-but-unminted nullifier (a crash between seal and commit)
    const selfFile = path.join(d, 'self_nullifiers.json');
    const map = S.loadStrict(selfFile, {}); map['NULL_R2'] = R2.address; S.saveAtomic(selfFile, map);
    s = bootLive(d); await ready(s.BASE, s.logs);                       // reboot → repairPending completes R2's mint
    const balR2 = (await getJSON(s.BASE, `/balance/${R2.address}`)).balance;
    const tipAfter = (await getJSON(s.BASE, '/tip')).tip;
    const repairLogged = s.logs.join('').includes('crash repair');
    await killChild(s.child);
    s = bootLive(d); await ready(s.BASE, s.logs);                       // reboot AGAIN → idempotent (no 2nd mint)
    const balR2b = (await getJSON(s.BASE, `/balance/${R2.address}`)).balance;
    await killChild(s.child);
    (balR2 === 1_000_000 && tipAfter !== tipBefore && repairLogged && balR2b === 1_000_000)
      ? ok('server boot repairPending completes a pending mint (R2 → 1,000,000, tip advanced, logged); reboot again = idempotent (still 1,000,000)')
      : bad(`boot-repair failed: ${JSON.stringify({ balR2, tipMoved: tipAfter !== tipBefore, repairLogged, balR2b })}`);
  }

  // (5) ORDER — seal BEFORE commit; verifier failure seals/mints nothing
  console.log('  (5) ORDER');
  {
    const order = [];
    const led = mockLedger();
    const base = SG.createNullifierStore(memStorage());
    const tracked = { has: base.has, get: base.get, entries: base.entries, seal: (n, w) => { order.push('seal'); return base.seal(n, w); } };
    const led2 = { commit: (t) => { order.push('commit'); led._txs.push(t); }, isIgnited: led.isIgnited };
    const g = SG.createSelfGate({ verify: () => Promise.resolve({ valid: true, nullifier: 'N' }), ledger: led2, store: tracked });
    const r = await g.claim({}, W('A'));
    const orderOK = r.ok && JSON.stringify(order) === JSON.stringify(['seal', 'commit']);

    const led3 = mockLedger(); const s3 = SG.createNullifierStore(memStorage());
    const gBad = SG.createSelfGate({ verify: () => Promise.resolve({ valid: false }), ledger: led3, store: s3 });
    const rBad = await gBad.claim({}, W('A'));
    (orderOK && !rBad.ok && rBad.code === 'invalid-proof' && s3.size() === 0 && led3._txs.length === 0)
      ? ok('claim() SEALS before it commits ([seal,commit]); a verifier failure mints nothing and seals nothing')
      : bad(`order failed: order=${JSON.stringify(order)} rBad=${JSON.stringify(rBad)} sealed=${s3.size()} minted=${led3._txs.length}`);
  }

  // (6) REGRESSION + grep gate
  console.log('  (6) REGRESSION / GREP GATE');
  {
    // grep gate: no bare fs.writeFileSync for the 3 stores + self store in server.js.
    const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const saveJSONatomic = /const saveJSON =[\s\S]*?safeStore\.saveAtomic/.test(src);
    const selfUsesSafe = /save:\s*\(map\)\s*=>\s*safeStore\.saveAtomic/.test(src);
    // the ONLY remaining bare fs.writeFileSync is the committee SHADOW state (out of
    // scope: it throws-on-failure, is not fail-open, and rebuilds from central).
    const bareWrites = (src.match(/fs\.writeFileSync/g) || []).length;
    const onlyCommittee = bareWrites === 1 && /STATE_FILE, JSON\.stringify/.test(src);
    (saveJSONatomic && selfUsesSafe && onlyCommittee)
      ? ok(`saveJSON → saveAtomic, self store → saveAtomic; the sole remaining fs.writeFileSync is the committee shadow (out of scope)`)
      : bad(`grep gate failed: saveJSONatomic=${saveJSONatomic} selfUsesSafe=${selfUsesSafe} bareWrites=${bareWrites} onlyCommittee=${onlyCommittee}`);

    for (const t of ['test_self_gate.js', 'test_brick2.js', 'test_brick2_cap.js']) {
      const code = await runNode(t);
      (code === 0) ? ok(`${t} → exit 0 (transitively covers Brick 1 + Phase 0–3)`) : bad(`${t} → exit ${code}`);
    }
  }

  console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Hardening: ${fails === 0 ? 'ALL PROBES PASS' : fails + ' FAILURE(S)'} — atomic, fail-closed, crash-safe; the fail-open re-mint class is dead.\n`);
  process.exit(fails === 0 ? 0 : 1);
})();
