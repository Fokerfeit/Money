// test_fold_malformed.js — one malformed frame must never brick a swarm node.
// Every probe must pass; exit 0.
//
// Cowork audit of 0df3b2c (F): {type:'promise', from:<member>, id:'x'} (no pub) made
// fold() throw on EVERY call after — status(), balance(), _react() all dead, on every
// node, persisted, inherited by fresh nodes on sync. Same for seals. Fix: a per-type
// well-formedness gate in Ledger.add() AND fold() (swarm_engine.js). This test proves:
//
//   R1  OLD vs NEW fold agree on realistic ledgers (check_fold_old_vs_new.js; pass a
//       real STORE_FILE / relay archive to that script for the live check)
//   R2  FUZZ: 13 bad values × every field × every tx type, through add() AND fold()
//       (and _react on a committee member) + random junk frames — never throws; the
//       state equals OLD-engine state for anything accepted, the clean baseline for
//       anything refused
//   R3  poison already in the relay ARCHIVE before nodes connect → fresh nodes
//       converge, payments still certify (votes flow), a real run_node dashboard is right
//   R4  a node restored from a snapshot that CONTAINS poison recovers, correct hash
//   R5  order independence: re-wrapped chan_open and mixed-type ids → one hash for
//       every insertion order
//
// Throwaway relays on 127.0.0.1 with temp files; nothing pushes, deploys, or touches
// the real network.
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
let WS;
try { WS = require('ws'); } catch { console.error('   ❌  the "ws" package is required to run this test'); process.exit(1); }
const E = require('./swarm_engine');
const { NodeClient } = require('./node_client');
const { startRelay } = require('./relay');
const { mkIdentity } = require('./committee_bridge');
const { compare, loadOldEngine, syntheticLedgers } = require('./check_fold_old_vs_new');

let fails = 0;
const ok  = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };
const check = (cond, m, detail) => cond ? ok(m) : bad(detail ? `${m} — ${detail}` : m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = () => {};
const canon = (o) => Array.isArray(o) ? o.map(canon)
  : (o && typeof o === 'object') ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, canon(o[k])])) : o;
const stateOf = (L) => { const f = L.fold(); return JSON.stringify(canon({ bal: f.bal, next: f.next, members: f.members, frauds: f.frauds, channels: f.channels, locked: f.locked })); };
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
async function waitFor(fn, ms, label) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(40); } throw new Error('timeout waiting for ' + label); }
class DeadWS { constructor() { this.readyState = 3; } on() {} send() {} close() {} }   // for driving _react() offline

// ── fixed world: 3 founders, 1 invited member, a certified+countersigned payment,
//    a channel opened and closed (every tx type present and COUNTED) ──────────
const [A, B, C, M] = ['fm-A', 'fm-B', 'fm-C', 'fm-M'].map(mkIdentity);
const founders = [A, B, C].map((i) => i.address);
const byAddr = Object.fromEntries([A, B, C, M].map((i) => [i.address, i]));
const pool = Object.keys(byAddr).sort();
const base = [];
const put = (t) => { base.push(t); return t; };
[A, B, C].forEach((i) => put(E.founderSeal(i)));
const sealM = put(E.seal(M, E.makeInvite(A, 'fm-inv-m', M.address)));
const pay = put(E.makePromise(A, B.address, 100, 1, 0));
const committeeA = E.committeeFor(A.address, 0, pool);
const voteT = committeeA.map((a) => put(E.makeVote(byAddr[a], E.phashOf(pay))))[0];
const accT = put(E.acceptPromise(B, pay));
const open = put(E.makeChanOpen(A, B, 10, 10, 2, 1, 0));
const close = E.makeChanClose(A, B, open.cid, 5, 15, 1, 0);
for (const i of [A, B, C, M]) { put(E.makeVote(i, open.ref)); put(E.makeVote(i, close.ref)); }
put(close);
const N = mkIdentity('fm-N');   // NOT a member: its seal walks every check in the invite loop

const OLD = loadOldEngine();
const ledgerOf = (Eng, txs) => { const L = new Eng.Ledger(founders); for (const t of txs) L.add(t); return L; };
const BASE_L = ledgerOf(E, base);
const BASE = stateOf(BASE_L), BASE_HASH = BASE_L.hash();

(async () => {
  console.log('\n  🧱  FOLD MALFORMED-FRAME GUARD\n');

  // ── R0: the world is what we think it is ────────────────────────────────────
  console.log('  0 BASELINE');
  check(/"state":"closed"/.test(BASE) && BASE_L.fold().bal[B.address] === 1_000_105 && Object.keys(BASE_L.fold().members).length === 4,
    `baseline counts every tx type (4 members, payment certified, channel closed) — hash ${BASE_HASH}`);
  check(stateOf(ledgerOf(OLD, base)) === BASE, 'OLD engine (93c4c0a) folds the baseline to the identical state');

  // ── R1: old vs new on realistic ledgers ─────────────────────────────────────
  console.log('\n  1 OLD vs NEW — synthetic realistic ledgers (live check: node check_fold_old_vs_new.js <STORE_FILE>)');
  {
    const { founders: sf, ledgers } = syntheticLedgers();
    for (const [name, txs] of Object.entries(ledgers)) {
      const r = compare(txs, sf, OLD);
      check(r.identical && r.rejected === 0, `${name}: OLD ${r.old.hash} == NEW ${r.neu.hash}, 0 messages refused`);
    }
    const r = compare(base, founders, OLD);
    check(r.identical && r.rejected === 0, `this test's full-coverage world (all 6 tx types): OLD == NEW, 0 refused`);
  }

  // ── R2: fuzz ─────────────────────────────────────────────────────────────────
  console.log('\n  2 FUZZ — 13 bad values × every field × every tx type, through add() and fold()');
  const BIG = 'f'.repeat(1 << 20);
  const BAD = [
    ['missing', undefined], ['null', null], ['0', 0], ['-1', -1], ['true', true], ['""', ''],
    ['"junk"', 'junk'], ['1MB str', BIG], ['[]', []], ['[orig]', 'WRAP'], ['{}', {}], ['{toString:0}', 'TOSTRING'], ['1e300', 1e300],
  ];
  const TEMPLATES = {
    'seal(founder)': E.founderSeal(C),
    'seal(invite, member)': sealM,
    'seal(invite, newcomer)': E.seal(N, E.makeInvite(A, 'fm-inv-n', N.address)),
    'promise(certified)': pay,
    'promise(fresh nonce)': E.makePromise(A, B.address, 5, 7, 0),
    accept: accT, vote: voteT, chan_open: open, chan_close: close,
  };
  const reactor = byAddr[committeeA[0]];   // on A's committee → _react walks its own raw-field checks
  const receiver = B;                      // p.to → _react walks the receiver path too
  let cases = 0, threw = [], wrong = [], acceptedOddType = [], reactThrew = [];
  const runCase = (label, mut, isPromise) => {
    cases++;
    let accepted, neu;
    try {
      const L = ledgerOf(E, base); accepted = L.add(mut); neu = stateOf(L);
      // fold()'s OWN gate, independent of add(): smuggle the frame straight into the map
      // (skipped when the id collides with a real tx — smuggling would REPLACE it, which is not what we test)
      const L2 = ledgerOf(E, base); if (mut && mut.id !== undefined && mut.id !== null && !L2.txs.has(mut.id)) { L2.txs.set(mut.id, mut); L2._v++; }
      const s2 = stateOf(L2);
      if (!accepted && s2 !== BASE) wrong.push(`${label} (fold gate: smuggled frame changed state)`);
    } catch (e) { threw.push(`${label}: ${e.message}`); return; }
    // expected: refused → the clean baseline; accepted → exactly what the OLD engine computes
    let expected = BASE;
    if (accepted) { try { expected = stateOf(ledgerOf(OLD, base.concat([mut]))); } catch { wrong.push(`${label} (accepted, but OLD engine threw on it)`); } }
    if (neu !== expected) wrong.push(label);
    if (isPromise) {
      for (const me of [reactor, receiver]) {
        try { const n = new NodeClient(me, founders, 'ws://unused', { ws: DeadWS, log: quiet }); for (const t of base) n.ledger.add(t); n.ledger.add(mut); n._react(); }
        catch (e) { reactThrew.push(`${label} as ${me.name}: ${e.message}`); }
      }
    }
    return accepted;
  };
  for (const [tname, tpl] of Object.entries(TEMPLATES)) {
    for (const f of Object.keys(tpl).filter((k) => k !== 'type')) {
      for (const [bname, bval] of BAD) {
        let mut = JSON.parse(JSON.stringify(tpl));
        const v = bval === 'WRAP' ? [tpl[f]] : bval === 'TOSTRING' ? { toString: 0 } : bval;
        if (v === undefined) delete mut[f]; else mut[f] = v;
        if (f !== 'id') mut.id = `fz-${tname}-${f}-${bname}`;
        if (bname !== '{toString:0}') mut = JSON.parse(JSON.stringify(mut));   // arrive exactly as the wire delivers it
        const acc = runCase(`${tname}.${f}=${bname}`, mut, tname.startsWith('promise'));
        // chan_open/chan_close .ref and seal .founder are never read as typed values by fold()
        // (it recomputes the channel hash itself; founder is a plain truthiness flag) — not gated
        const typeOk = (f === 'ref' && tname.startsWith('chan_')) || f === 'founder' ? true
          : typeof tpl[f] === 'string' ? (typeof v === 'string' && v.length > 0) : typeof tpl[f] === 'number' ? Number.isInteger(v) : true;
        if (acc && !typeOk) acceptedOddType.push(`${tname}.${f}=${bname}`);
      }
    }
  }
  // Cowork's exact frames, and non-object frames
  for (const [label, fr] of [
    ['cowork promise', { type: 'promise', from: A.address, id: 'x' }],
    ['seal no from/pub', { type: 'seal', id: 'y' }],
    ['founder seal no pub', { type: 'seal', founder: true, from: B.address, id: 'z' }],
    ['type {toString:0}', { type: { toString: 0 }, id: 'tt' }],
    ['type ["promise"]', { type: ['promise'], from: A.address, id: 'ta' }],
    ['id only', { id: 'only' }], ['string frame', 'garbage'], ['number frame', 42], ['array frame', [1, 2]], ['null', null],
  ]) runCase(label, fr, true);
  // random junk: every field of every template replaced by random JSON-ish values
  let seed = 1234567;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const randVal = (depth = 0) => {
    const r = rnd();
    if (r < 0.12) return undefined; if (r < 0.2) return null; if (r < 0.3) return Math.floor(rnd() * 1e6) - 5e5;
    if (r < 0.36) return rnd() < 0.5; if (r < 0.5) return pick(['', 'x', A.address, A.pub, pay.sig, '__proto__', 'constructor', 'toString', 'M_' + 'F'.repeat(32)]);
    if (r < 0.6) return 'r' + Math.floor(rnd() * 1e9).toString(16); if (r < 0.7 && depth < 2) return [randVal(depth + 1)];
    if (r < 0.8 && depth < 2) return { toString: randVal(depth + 1), valueOf: randVal(depth + 1) };
    if (r < 0.88) return 1e300; return pick([0, -1, 1, 2, 7]);
  };
  const types = ['seal', 'promise', 'accept', 'vote', 'chan_open', 'chan_close', 'note', undefined];
  const tpls = Object.values(TEMPLATES);
  for (let i = 0; i < 400; i++) {
    const tpl = pick(tpls); const mut = JSON.parse(JSON.stringify(tpl));
    for (const k of Object.keys(mut)) if (rnd() < 0.35) { const v = randVal(); if (v === undefined) delete mut[k]; else mut[k] = v; }
    if (rnd() < 0.1) mut.type = pick(types);
    if (rnd() < 0.85 || mut.id === undefined) mut.id = rnd() < 0.9 ? `rz-${i}` : randVal();
    runCase(`random#${i}`, mut, mut.type === 'promise');
  }
  check(cases >= 800, `${cases} malformed frames generated (13 values × every field × 9 templates, + named + 400 random)`);
  check(threw.length === 0, 'add() and fold() NEVER threw', threw.slice(0, 3).join(' | '));
  check(reactThrew.length === 0, '_react() NEVER threw (committee member AND receiver)', reactThrew.slice(0, 3).join(' | '));
  check(wrong.length === 0, 'state == clean baseline for every refused frame; == OLD engine for every accepted one', wrong.slice(0, 5).join(' | '));
  check(acceptedOddType.length === 0, 'no wrong-typed field (number/array/object/empty in a string slot, non-integer in a number slot) is ever accepted', acceptedOddType.slice(0, 5).join(' | '));
  { const L = ledgerOf(E, base); const before = L.hash();
    const n = [['cowork', { type: 'promise', from: A.address, id: 'x' }], ['seal', { type: 'seal', id: 'y' }], ['tostr', { type: 'vote', id: { toString: 0 } }]].filter(([, t]) => L.add(t)).length;
    check(n === 0 && L.hash() === before && L.hash() === BASE_HASH, `the audit's poison frames are refused at add() and the hash stays ${BASE_HASH}`); }

  // ── R3: poisoned relay archive, end to end ──────────────────────────────────
  console.log('\n  3 POISONED RELAY ARCHIVE — poison on disk BEFORE any node connects');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-guard-'));
  const children = [];
  const nodes = [];
  try {
    const R = ['r3-A', 'r3-B', 'r3-C'].map(mkIdentity);
    const rf = R.map((i) => i.address);
    const poison = [
      { type: 'promise', from: R[0].address, id: 'px-cowork' },
      { type: 'seal', id: 'px-seal' },
      { type: 'seal', founder: true, from: R[1].address, id: 'px-fseal' },
      { type: 'promise', from: R[0].address, to: { toString: 0 }, pub: R[0].pub, sig: 'aa', amount: 1, nonce: 9, epoch: 0, id: 'px-tostr' },
      { type: 'vote', ref: 'r', from: R[2].address, pub: R[2].pub, sig: 's', id: { toString: 0 } },
      { type: 'chan_open', cid: { toString: 0 }, A: R[0].address, B: R[1].address, id: 'px-chan' },
    ];
    const dataFile = path.join(dir, 'relay.jsonl');
    fs.writeFileSync(dataFile, poison.map((t) => JSON.stringify(t)).join('\n') + '\n');
    const port = await freePort();
    const relay = startRelay({ port, host: '127.0.0.1', dataFile, log: quiet });
    await new Promise((r) => relay.wss.on('listening', r));
    const url = `ws://127.0.0.1:${port}`;
    check(relay.stats().archived === poison.length, `relay booted with ${poison.length} poison frames already in its archive`);

    for (const id of R) { const n = new NodeClient(id, rf, url, { ws: WS, log: quiet }); nodes.push(n); }
    await Promise.all(nodes.map((n) => n.connect()));
    nodes.forEach((n, k) => n.announce(E.founderSeal(R[k])));
    await waitFor(() => nodes.every((n) => n.status().members === 3), 5000, 'fresh nodes to converge on 3 members');
    ok('fresh nodes synced the poisoned archive, status() works on every node, 3 members');
    check(nodes.every((n) => poison.every((p) => typeof p.id !== 'string' || !n.ledger.has(p.id))), 'no node stored a single poison frame');

    let p1 = null;
    try { p1 = nodes[0].pay(R[1].address, 250, 1, 0); } catch (e) { bad(`pay() threw: ${e.message}`); }
    await waitFor(() => nodes.every((n) => n.balance(R[1].address) === 1_000_250), 5000, 'payment A→B to certify on every node');
    const ph1 = E.phashOf(p1);
    const votes1 = nodes[2].ledger.all().filter((t) => t.type === 'vote' && t.ref === ph1).length;
    check(votes1 >= E.quorumOf(2), `payment A→B certified and countersigned on all 3 nodes — ${votes1} votes flowed (quorum ${E.quorumOf(2)})`);

    // live poison while running, then another payment
    const atk = new WS(url); await new Promise((r) => atk.on('open', r));
    for (const t of poison) atk.send(JSON.stringify({ t: 'gossip', tx: Object.assign({}, t, { id: typeof t.id === 'string' ? t.id + '-live' : t.id }) }));
    await sleep(200);
    nodes[1].pay(R[2].address, 40, 1, 0);
    await waitFor(() => nodes.every((n) => n.balance(R[2].address) === 1_000_040), 5000, 'second payment to certify after live poison');
    ok('poison injected LIVE mid-run → the next payment (B→C) still certified on every node');
    const hashes = nodes.map((n) => n.status().hash);
    check(new Set(hashes).size === 1, `all nodes agree: hash ${hashes[0]}`);
    atk.close();

    // a node that joins AFTER all of it
    const D = new NodeClient(mkIdentity('r3-D'), rf, url, { ws: WS, log: quiet }); nodes.push(D);
    await D.connect();
    await waitFor(() => D.status().hash === hashes[0], 5000, 'late joiner to converge');
    ok(`a late-joining node syncs the whole poisoned archive and lands on the same hash ${hashes[0]}`);

    // a REAL run_node.js process: the dashboard must show the true state
    const dashPort = await freePort();
    const env = Object.assign({}, process.env, { MONEY_JSON: '1', NODE_LABEL: 'r3-dash', FOUNDERS_JSON: JSON.stringify(rf), RELAY_URL: url, DASH_PORT: String(dashPort) });
    const proc = spawn(process.execPath, [path.join(__dirname, 'run_node.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(proc);
    let err = ''; proc.stderr.on('data', (d) => err += d);
    const getState = () => new Promise((res) => http.get({ host: '127.0.0.1', port: dashPort, path: '/state' }, (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }).on('error', () => res(null)));
    let st = null;
    await waitFor(async () => { st = await getState(); return st && st.hash === hashes[0]; }, 8000, 'run_node dashboard to show the converged hash');
    check(st.ready === true && st.members === 3 && st.balances[R[0].address] === 999_750 && st.balances[R[1].address] === 1_000_210 && st.balances[R[2].address] === 1_000_040,
      `run_node dashboard /state: ready, members 3, hash ${st.hash}, balances B ${st.balances[R[1].address]}, C ${st.balances[R[2].address]}`);
    check(!/uncaught exception/.test(err), 'run_node logged no uncaught exception against the poisoned relay');
    await relay.close();
  } catch (e) { bad(`R3 harness: ${e.message}`); }
  finally { for (const n of nodes) { try { n.close(); } catch {} } for (const c of children) { try { c.kill(); } catch {} } }

  // ── R4: recovery from a snapshot that already holds poison ──────────────────
  console.log('\n  4 RECOVERY — a persisted snapshot that ALREADY contains poison');
  {
    const poison = [{ type: 'promise', from: A.address, id: 'x' }, { type: 'seal', id: 'y' }, { type: 'seal', founder: true, from: B.address, id: 'z' }];
    let snap = { txs: base.slice(0, 5).concat(poison, base.slice(5)), locks: [], accepted: [] };   // poison mid-ledger, as a real save would leave it
    const store = { load: () => JSON.parse(JSON.stringify(snap)), save: (s) => { snap = JSON.parse(JSON.stringify(s)); } };
    const oldBrick = (() => { try { ledgerOf(OLD, snap.txs).fold(); return false; } catch { return true; } })();
    check(oldBrick, 'control: the OLD engine throws on this exact snapshot (it is a real brick)');
    const n = new NodeClient(A, founders, 'ws://127.0.0.1:1', { ws: DeadWS, store, log: quiet });
    await n.restore();
    let st = null; try { st = n.status(); } catch (e) { bad(`status() threw after restore: ${e.message}`); }
    check(st && st.hash === BASE_HASH && st.members === 4, `restored OFFLINE with no cleanup → status() works, hash ${st && st.hash} == clean ${BASE_HASH}`);
    check(poison.every((p) => !n.ledger.has(p.id)), 'the poison was dropped at restore() (never re-entered the ledger)');
    try { n._react(); ok('_react() runs on the recovered node'); } catch (e) { bad(`_react() threw: ${e.message}`); }
    n._persist(); await sleep(120);
    check(!snap.txs.some((t) => poison.some((p) => p.id === t.id)) && snap.txs.length === base.length, 'the next save writes a CLEAN snapshot (poison gone from disk)');
    n.close();
  }

  // ── R5: order independence ─────────────────────────────────────────────────
  console.log('\n  5 ORDER INDEPENDENCE — one set, every insertion order, one hash');
  {
    const wrapped = JSON.parse(JSON.stringify(open)); wrapped.A = [open.A]; wrapped.id = 'wrapped-open';
    const numId = JSON.parse(JSON.stringify(E.founderSeal(C))); numId.id = 12345;
    const arrTo = JSON.parse(JSON.stringify(pay)); arrTo.to = [B.address]; arrTo.id = 'wrapped-pay';
    const extras = [wrapped, numId, arrTo];
    const rest = base.filter((t) => t.id !== open.id);
    const hashes = new Set(), states = new Set(), oldHashes = new Set();
    const perms = [[open, wrapped], [wrapped, open]];
    for (const [x, y] of perms) {
      const L = ledgerOf(E, rest.concat([x, y])); hashes.add(L.hash()); states.add(stateOf(L));
      oldHashes.add(ledgerOf(OLD, rest.concat([x, y])).hash());
    }
    check(oldHashes.size === 2, `control: OLD engine gives ${oldHashes.size} different hashes for the two orders of {chan_open, re-wrapped copy}`);
    check(hashes.size === 1 && states.size === 1 && [...hashes][0] === BASE_HASH, `NEW engine: both orders → one hash ${[...hashes][0]} (channel closes normally)`);
    let s = 99;
    const shuffle = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { s = (s * 16807) % 2147483647; const j = s % (i + 1); [b[i], b[j]] = [b[j], b[i]]; } return b; };
    for (let i = 0; i < 60; i++) { const L = ledgerOf(E, shuffle(base.concat(extras))); hashes.add(L.hash()); states.add(stateOf(L)); }
    check(hashes.size === 1 && states.size === 1, `60 random insertion orders of the full set + re-wrapped chan_open + numeric-id seal + array-to promise → 1 hash, 1 state`);
    const L = ledgerOf(E, base); check(extras.every((t) => !L.add(t)), 'all three re-typed copies are refused at add()');
  }

  console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Fold malformed guard: ${fails === 0 ? 'ALL PROBES PASS' : fails + ' FAILURE(S)'} — malformed frames are refused at add() and ignored by fold(); nothing throws; valid state unchanged.\n`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('   ❌  test harness error:', e && e.stack || e); process.exit(1); });
