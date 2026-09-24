// check_fold_old_vs_new.js — REAL-DATA SAFETY CHECK for the fold() well-formedness gate.
//
// Folds the SAME ledger with the OLD engine (swarm_engine.js exactly as it was at
// 93c4c0a, read straight out of git) and the NEW engine (this working tree), and
// reports whether the two agree. The gate is only allowed to drop malformed /
// re-typed frames — it must never change the state of a real network.
//
//   node check_fold_old_vs_new.js <file> [--genesis genesis.json | --founders '["M_..",..]']
//
//   <file>  a node's persisted STORE_FILE  ({ txs:[...], locks, accepted })
//           or a relay archive (JSONL, one signed message per line).
//   founders default to genesis.json beside this script — the same set run_node uses.
//
// With NO file it says so plainly and checks a SYNTHETIC ledger instead (live-shaped:
// 2 founders + 1 invited member, plus a busier variant with certified payments).
// Read-only: never writes the file, never touches the network. Exit 0 = identical.
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

const OLD_REF = '93c4c0a';

function loadOldEngine() {
  const src = execFileSync('git', ['show', `${OLD_REF}:mobile/swarm/swarm_engine.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 24 });
  const filename = path.join(__dirname, `__old_swarm_engine_${OLD_REF}.js`);   // virtual — never written to disk
  const m = new Module(filename, module);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(__dirname);
  m._compile(src, filename);
  return m.exports;
}

const canon = (o) => Array.isArray(o) ? o.map(canon)
  : (o && typeof o === 'object') ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, canon(o[k])])) : o;

function foldWith(E, founders, txs) {
  try {
    const L = new E.Ledger(founders);
    let added = 0; for (const t of txs) if (L.add(t)) added++;
    const f = L.fold();
    return { ok: true, added, hash: L.hash(), members: Object.keys(f.members).length, bal: f.bal,
      state: JSON.stringify(canon({ bal: f.bal, next: f.next, members: f.members, frauds: f.frauds, channels: f.channels, locked: f.locked })) };
  } catch (e) { return { ok: false, err: `${e.constructor.name}: ${e.message}` }; }
}

// Compare OLD vs NEW on one ledger. Returns { identical, old, neu, rejected }.
function compare(txs, founders, OLD = loadOldEngine(), NEW = require('./swarm_engine')) {
  const old = foldWith(OLD, founders, txs), neu = foldWith(NEW, founders, txs);
  const identical = old.ok && neu.ok && old.hash === neu.hash && old.state === neu.state;
  return { identical, old, neu, rejected: old.ok && neu.ok ? old.added - neu.added : null };
}

function readLedgerFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  try { const j = JSON.parse(raw); if (j && Array.isArray(j.txs)) return { kind: 'STORE_FILE snapshot', txs: j.txs }; if (Array.isArray(j)) return { kind: 'JSON array', txs: j }; } catch {}
  const txs = [];
  for (const line of raw.split('\n')) { if (!line.trim()) continue; try { txs.push(JSON.parse(line)); } catch {} }
  return { kind: 'relay archive (JSONL)', txs };
}

// A synthetic ledger shaped like the live testnet (2 genesis founders + 1 invited
// member, 3 × 1,000,000), plus a busier variant with certified, countersigned payments.
function syntheticLedgers() {
  const E = require('./swarm_engine');
  const { mkIdentity } = require('./committee_bridge');
  const [F1, F2, M, X] = ['synth-F1', 'synth-F2', 'synth-M', 'synth-X'].map(mkIdentity);
  const founders = [F1.address, F2.address];
  const live = [E.founderSeal(F1), E.founderSeal(F2), E.seal(M, E.makeInvite(F1, 'synth-inv-m', M.address))];
  const busy = live.slice();
  busy.push(E.seal(X, E.makeInvite(F2, 'synth-inv-x', X.address)));
  const ids = { [F1.address]: F1, [F2.address]: F2, [M.address]: M, [X.address]: X };
  const pool = Object.keys(ids).sort();
  const pay = (from, to, amt, nonce) => {
    const p = E.makePromise(from, to.address, amt, nonce, 0); busy.push(p);
    for (const a of E.committeeFor(from.address, 0, pool)) busy.push(E.makeVote(ids[a], E.phashOf(p)));
    busy.push(E.acceptPromise(to, p));
  };
  pay(F1, M, 1234, 1); pay(M, X, 200, 1); pay(F1, X, 5, 2); pay(X, F2, 1, 1);
  busy.push(E.makePromise(F2, M.address, 999, 1, 0));   // uncertified — must stay pending in both
  busy.push({ type: 'note', id: 'synth-unknown-type' });   // unknown type — inert in both
  return { founders, ledgers: { 'live-shaped (2 founders + 1 invitee)': live, 'busy (4 members, 4 certified payments)': busy } };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const file = args.find((a, i) => !a.startsWith('--') && !['--genesis', '--founders'].includes(args[i - 1]));
  let OLD;
  try { OLD = loadOldEngine(); }
  catch (e) { console.error(`cannot load the OLD engine from git (${OLD_REF}): ${e.message}`); process.exit(2); }

  let founders, ledgers;
  if (file) {
    founders = opt('--founders') ? JSON.parse(opt('--founders'))
      : JSON.parse(fs.readFileSync(opt('--genesis') || path.join(__dirname, 'genesis.json'), 'utf8')).founders;
    const { kind, txs } = readLedgerFile(file);
    console.log(`REAL DATA: ${file} (${kind}, ${txs.length} messages); founders: ${founders.join(', ')}`);
    ledgers = { [path.basename(file)]: txs };
  } else {
    console.log('NO FILE SUPPLIED — checking a SYNTHETIC ledger, NOT live data. Pass the founder node\'s STORE_FILE to check the real one.');
    ({ founders, ledgers } = syntheticLedgers());
  }
  let allOk = true;
  for (const [name, txs] of Object.entries(ledgers)) {
    const r = compare(txs, founders, OLD);
    allOk = allOk && r.identical;
    const show = (x) => x.ok ? `hash ${x.hash}  members ${x.members}  balances ${JSON.stringify(Object.values(x.bal).sort((a, b) => b - a))}` : `THREW ${x.err}`;
    console.log(`\n  ${name}`);
    console.log(`    OLD (${OLD_REF}): ${show(r.old)}`);
    console.log(`    NEW (gated)  : ${show(r.neu)}`);
    if (r.rejected !== null) console.log(`    messages the gate refused: ${r.rejected}`);
    console.log(`    ${r.identical ? 'IDENTICAL — same hash, same full state' : 'DIFFERENT — do NOT ship until explained'}`);
  }
  process.exit(allOk ? 0 : 1);
}

module.exports = { compare, loadOldEngine, syntheticLedgers, readLedgerFile };
if (require.main === module) main();
