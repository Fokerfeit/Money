// test_brick3.js — BRICK 3 (Bite 1): two committee nodes converge via a relay,
// single machine, real WebSocket transport. Every probe must pass; exit 0.
//   1 TWO NODES CONVERGE   2 ORDER INDEPENDENCE   3 LATE JOINER
//   4 NO DIVERGENCE (temporary partition self-heals)   5 REGRESSION
//
// Nodes run as GENUINELY SEPARATE OS PROCESSES (mobile/swarm/run_node.js, spawned
// via child_process) with no shared JS state — they only ever communicate through
// a real WebSocket relay (mobile/swarm/relay.js, run IN-PROCESS here since its own
// job — being a real TCP/WS server other processes dial into — doesn't require it
// to be a separate process to be a genuine network boundary; what matters for
// rigor is that the NODES are isolated, and they are). This proves convergence
// isn't an artifact of nodes secretly sharing references in one JS heap.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { startRelay } = require('./swarm/relay');
const { mkIdentity } = require('./swarm/committee_bridge');
const E = require('./swarm/swarm_engine');

let fails = 0;
const ok  = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = path.join(__dirname, '.brick3_tmp');
let portCounter = 39500 + Math.floor(Math.random() * 8000);   // random base avoids TIME_WAIT collisions across re-runs

// ── node-process harness ─────────────────────────────────────────────────────
function bootNode(label, relayUrl, founders, opts = {}) {
  const env = { ...process.env, RELAY_URL: relayUrl, NODE_LABEL: label, FOUNDERS_JSON: JSON.stringify(founders) };
  if (opts.storeFile) env.STORE_FILE = opts.storeFile;
  const child = spawn(process.execPath, [path.join(__dirname, 'swarm', 'run_node.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = []; const errLines = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    const parts = buf.split('\n'); buf = parts.pop();
    for (const l of parts) if (l.trim()) { try { lines.push(JSON.parse(l)); } catch {} }
  });
  child.stderr.on('data', (d) => errLines.push(d.toString()));
  return {
    child, lines, errLines,
    send: (obj) => child.stdin.write(JSON.stringify(obj) + '\n'),
    lastStatus: () => lines.filter((l) => l.type === 'status').pop(),
    ready: () => lines.some((l) => l.type === 'ready'),
  };
}
async function waitUntil(predicate, timeoutMs = 8000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return true; await sleep(stepMs); }
  return predicate();
}
async function killNode(n) { if (!n || !n.child) return; try { n.child.kill('SIGKILL'); } catch {} await sleep(100); }
function runNode(file) { return new Promise((res) => { const c = spawn(process.execPath, [path.join(__dirname, file)], { stdio: 'ignore' }); c.on('exit', (code) => res(code)); }); }

(async () => {
  console.log('\n  BRICK 3 (Bite 1) — TWO COMMITTEE NODES CONVERGE VIA RELAY\n');
  fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true });

  // (1) TWO NODES CONVERGE
  console.log('  (1) TWO NODES CONVERGE');
  let relay1;
  try {
    const port = portCounter++; const url = `ws://127.0.0.1:${port}`;
    relay1 = startRelay({ port, log: () => {} });
    const A = mkIdentity('b3_1_A'), B = mkIdentity('b3_1_B');
    const founders = [A.address, B.address];
    const nA = bootNode('b3_1_A', url, founders), nB = bootNode('b3_1_B', url, founders);

    await waitUntil(() => nA.ready() && nB.ready(), 6000);
    nA.send({ op: 'seal_founder' }); nB.send({ op: 'seal_founder' });
    await waitUntil(() => {
      const sa = nA.lastStatus(), sb = nB.lastStatus();
      return sa && sb && sa.members === 2 && sb.members === 2;
    }, 6000);

    nA.send({ op: 'pay', to: B.address, amount: 40000, nonce: 1, epoch: 0 });
    const converged = await waitUntil(() => {
      const sa = nA.lastStatus(), sb = nB.lastStatus();
      return sa && sb && sa.hash === sb.hash && sa.balances[A.address] === 960000 && sb.balances[A.address] === 960000;
    }, 8000);

    const sa = nA.lastStatus(), sb = nB.lastStatus();
    const intMoney = Number.isInteger(sa.balances[A.address]) && Number.isInteger(sa.balances[B.address]);
    (converged && sa.hash === sb.hash && sa.balances[B.address] === 1040000 && sb.balances[B.address] === 1040000 && intMoney)
      ? ok(`two SEPARATE processes converge to IDENTICAL tip (${sa.hash}) and balances (A=960000, B=1040000) via a real relay — real WebSocket transport, no shared JS state`)
      : bad(`convergence failed: A=${JSON.stringify(sa)} B=${JSON.stringify(sb)}`);

    await killNode(nA); await killNode(nB);
  } catch (e) { bad('probe 1 error: ' + e.message); }
  finally { if (relay1) await relay1.close(); }

  // (2) ORDER INDEPENDENCE — deterministic, direct against E.Ledger (the fold
  // engine every node runs). Build a certified message SET once, then feed the
  // SAME set into two fresh ledgers in DIFFERENT insertion orders — fold() must
  // sort internally and reach the identical hash regardless of arrival order,
  // which is exactly the property that makes network-order irrelevant.
  console.log('  (2) ORDER INDEPENDENCE');
  {
    const founders = Array.from({ length: 3 }, (_, i) => mkIdentity('b3_2_F' + i));
    const build = new E.Ledger(founders.map((f) => f.address));
    founders.forEach((f) => build.add(E.founderSeal(f)));
    const pool = () => build.fold().pool;
    const p1 = E.makePromise(founders[0], founders[1].address, 30000, 1, 0);
    build.add(p1); build.add(E.acceptPromise(founders[1], p1));
    for (const v of E.committeeFor(founders[0].address, 0, pool())) build.add(E.makeVote(founders.find((f) => f.address === v), E.phashOf(p1)));
    const p2 = E.makePromise(founders[1], founders[2].address, 15000, 1, 0);
    build.add(p2); build.add(E.acceptPromise(founders[2], p2));
    for (const v of E.committeeFor(founders[1].address, 0, pool())) build.add(E.makeVote(founders.find((f) => f.address === v), E.phashOf(p2)));

    const msgs = build.all();
    const forward = new E.Ledger(founders.map((f) => f.address));
    for (const m of msgs) forward.add(m);
    const reversed = new E.Ledger(founders.map((f) => f.address));
    for (const m of [...msgs].reverse()) reversed.add(m);
    // a third, shuffled order (deterministic shuffle, not random — reproducible)
    const shuffled = new E.Ledger(founders.map((f) => f.address));
    const shuffledMsgs = msgs.filter((_, i) => i % 2 === 0).concat(msgs.filter((_, i) => i % 2 === 1));
    for (const m of shuffledMsgs) shuffled.add(m);

    const hf = forward.hash(), hr = reversed.hash(), hs = shuffled.hash();
    const bf = forward.fold().bal, br = reversed.fold().bal, bs = shuffled.fold().bal;
    (hf === hr && hr === hs && JSON.stringify(bf) === JSON.stringify(br) && JSON.stringify(br) === JSON.stringify(bs))
      ? ok(`the SAME message set fed in 3 different insertion orders (forward/reverse/interleaved) → identical hash (${hf}) and balances — fold() is order-independent by construction`)
      : bad(`order dependence detected: hf=${hf} hr=${hr} hs=${hs}`);
  }

  // (3) LATE JOINER — connects AFTER txs exist, catches up via the relay's sync replay
  console.log('  (3) LATE JOINER');
  let relay3;
  try {
    const port = portCounter++; const url = `ws://127.0.0.1:${port}`;
    relay3 = startRelay({ port, log: () => {} });
    const A = mkIdentity('b3_3_A'), B = mkIdentity('b3_3_B'), C = mkIdentity('b3_3_C');
    const founders = [A.address, B.address];
    const nA = bootNode('b3_3_A', url, founders), nB = bootNode('b3_3_B', url, founders);
    await waitUntil(() => nA.ready() && nB.ready(), 6000);
    nA.send({ op: 'seal_founder' }); nB.send({ op: 'seal_founder' });
    await waitUntil(() => { const sa = nA.lastStatus(); return sa && sa.members === 2; }, 6000);
    nA.send({ op: 'pay', to: B.address, amount: 25000, nonce: 1, epoch: 0 });
    await waitUntil(() => { const sa = nA.lastStatus(), sb = nB.lastStatus(); return sa && sb && sa.hash === sb.hash && sa.balances[A.address] === 975000; }, 6000);
    const preJoinHash = nA.lastStatus().hash;

    // NOW connect a third node — C is NOT a founder/committee member, just an
    // observer proving the relay's on-connect archive replay reconstructs the
    // identical state independently, without ever having been online before.
    const nC = bootNode('b3_3_C', url, founders);
    await waitUntil(() => nC.ready(), 6000);
    const caughtUp = await waitUntil(() => { const sc = nC.lastStatus(); return sc && sc.hash === preJoinHash; }, 6000);
    const sc = nC.lastStatus();
    (caughtUp && sc && sc.balances[A.address] === 975000 && sc.balances[B.address] === 1025000)
      ? ok(`a node connecting AFTER the txs happened catches up via the relay's archive replay to the IDENTICAL tip (${sc.hash}) and balances`)
      : bad(`late joiner failed to converge: expected=${preJoinHash} got=${JSON.stringify(sc)}`);

    await killNode(nA); await killNode(nB); await killNode(nC);
  } catch (e) { bad('probe 3 error: ' + e.message); }
  finally { if (relay3) await relay3.close(); }

  // (4) NO DIVERGENCE — a node offline for a certified payment self-heals via
  // the SAME relay-replay mechanism once it reconnects; the network never
  // permanently splits into two disagreeing states.
  //
  // Needs >=4 non-sender candidates for quorum to tolerate ANY absence at all
  // (quorumOf(n) = n - floor((n-1)/3); quorum is UNANIMOUS for n<4 — with only
  // 2 or 3 founders total, the single offline node would be a REQUIRED voter
  // and the payment could never certify while it's down, which would test the
  // wrong thing). 5 founders → a sender's committee is the other 4 → quorum 3,
  // tolerating exactly 1 absent validator — a genuine BFT partition scenario.
  console.log('  (4) NO DIVERGENCE (partition self-heals)');
  let relay4;
  try {
    const port = portCounter++; const url = `ws://127.0.0.1:${port}`;
    relay4 = startRelay({ port, log: () => {} });
    const ids = Array.from({ length: 5 }, (_, i) => mkIdentity('b3_4_' + i));
    const [A, B, C, D, Eid] = ids;   // A sends, B receives, C/D always-on voters, E goes offline
    const founders = ids.map((x) => x.address);
    let nodes = ids.map((x) => bootNode(x.name, url, founders));
    await waitUntil(() => nodes.every((n) => n.ready()), 8000);
    nodes.forEach((n) => n.send({ op: 'seal_founder' }));
    await waitUntil(() => nodes.every((n) => { const s = n.lastStatus(); return s && s.members === 5; }), 8000);

    nodes[0].send({ op: 'pay', to: B.address, amount: 10000, nonce: 1, epoch: 0 });
    const firstOk = await waitUntil(() => nodes.every((n) => { const s = n.lastStatus(); return s && s.balances[A.address] === 990000; }), 8000);
    if (!firstOk) throw new Error('setup payment never certified across all 5 nodes');

    // E goes OFFLINE (killed) — a message it will never see live.
    await killNode(nodes[4]);
    nodes[0].send({ op: 'pay', to: B.address, amount: 5000, nonce: 2, epoch: 0 });
    // certifies via B+C+D (quorum 3-of-4) WITHOUT E — proves the network doesn't stall on one absent validator
    const secondOk = await waitUntil(() => [nodes[0], nodes[1], nodes[2], nodes[3]].every((n) => { const s = n.lastStatus(); return s && s.balances[A.address] === 985000; }), 8000);
    if (!secondOk) throw new Error('second payment never certified with E offline (quorum-3-of-4 should not need E)');
    const partitionedHash = nodes[0].lastStatus().hash;   // the 4 online nodes moved on WITHOUT E seeing it live

    // E comes back — a FRESH process (as if the app restarted), same identity,
    // no persisted local state, reconnects to the SAME relay.
    const nE2 = bootNode(Eid.name, url, founders);
    await waitUntil(() => nE2.ready(), 6000);
    const healed = await waitUntil(() => { const se = nE2.lastStatus(); return se && se.hash === partitionedHash; }, 6000);
    const se = nE2.lastStatus();
    (healed && se && se.balances[A.address] === 985000 && se.balances[B.address] === 1015000)
      ? ok(`E was offline for a certified payment (quorum reached 3-of-4 WITHOUT it) — reconnecting replays the archive and CONVERGES to the same state (${se.hash}), never a permanent split`)
      : bad(`partition did not heal: expected=${partitionedHash} got=${JSON.stringify(se)}`);

    await Promise.all([nodes[0], nodes[1], nodes[2], nodes[3], nE2].map(killNode));
  } catch (e) { bad('probe 4 error: ' + e.message); }
  finally { if (relay4) await relay4.close(); }

  // (5) REGRESSION — additive: nothing in the proven stack changed
  console.log('  (5) REGRESSION');
  {
    const code = await runNode('test_brick2_cap.js');   // transitively: brick2 -> self-gate -> brick1 -> phase0-3
    (code === 0) ? ok('test_brick2_cap.js (→ Brick 2 bites 1-2 → Self gate → Brick 1 → Phase 0–3) → exit 0: nothing existing changed')
                 : bad(`test_brick2_cap.js → exit ${code}`);
  }

  console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Brick 3 (Bite 1): ${fails === 0 ? 'ALL PROBES PASS' : fails + ' FAILURE(S)'} — two independent processes converge to one ledger over a real relay.\n`);
  process.exit(fails === 0 ? 0 : 1);
})();
