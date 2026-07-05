// test_nodecrashguard.js — malformed relay frames must never crash a node.
// Every probe must pass; exit 0.
//   1 NULL FRAME               2 OTHER NON-OBJECT FRAMES (string/number/array/malformed)
//   3 CONVERGENCE STILL WORKS  4 REGRESSION (Brick 3 suite + backend byte-identical)
//
// The bug (found by an independent adversarial audit of Brick 3 Bite 1):
// JSON.parse("null") succeeds (returns null, no exception), so node_client.js's
// onMsg touched `m.t` on a null with no guard -> uncaught TypeError -> the node
// process died, with no process-level handler in run_node.js to catch it. This
// requires a MALICIOUS/COMPROMISED RELAY (relay.js's own header comment already
// says a hacked relay's worst case should be "drop or delay messages" — a crash
// is worse than that); a rogue PEER using the real relay cannot reach this,
// since the real relay always re-wraps gossip as a valid {t:'gossip',tx:{...}}
// object. This gate stands up a FAKE relay (a bare ws.Server, not relay.js) that
// deliberately sends bad frames, to prove the node survives regardless.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WS = require('ws');
const { startRelay } = require('./swarm/relay');
const { mkIdentity } = require('./swarm/committee_bridge');

let fails = 0;
const ok  = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let portCounter = 46000 + Math.floor(Math.random() * 10000);

function bootNode(label, relayUrl, founders) {
  const env = { ...process.env, RELAY_URL: relayUrl, NODE_LABEL: label, FOUNDERS_JSON: JSON.stringify(founders) };
  const child = spawn(process.execPath, [path.join(__dirname, 'swarm', 'run_node.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = []; const errLines = []; let buf = ''; let exited = false;
  child.stdout.on('data', (d) => { buf += d.toString(); const parts = buf.split('\n'); buf = parts.pop(); for (const l of parts) if (l.trim()) { try { lines.push(JSON.parse(l)); } catch {} } });
  child.stderr.on('data', (d) => errLines.push(d.toString()));
  child.on('exit', () => { exited = true; });
  return {
    child, lines, errLines,
    send: (obj) => { try { child.stdin.write(JSON.stringify(obj) + '\n'); } catch {} },
    lastStatus: () => lines.filter((l) => l.type === 'status').pop(),
    ready: () => lines.some((l) => l.type === 'ready'),
    isAlive: () => !exited,
  };
}
async function waitUntil(pred, timeoutMs = 8000, stepMs = 40) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (pred()) return true; await sleep(stepMs); }
  return pred();
}
async function killNode(n) {
  if (!n || !n.child || !n.isAlive()) return;
  const c = n.child;
  await new Promise((r) => { c.once('exit', r); try { c.kill('SIGKILL'); } catch { r(); } });
  await sleep(80);
}
function runNode(file) {
  return new Promise((res) => {
    const c = spawn(process.execPath, [path.join(__dirname, file)], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = []; c.stdout.on('data', (d) => out.push(d.toString())); c.stderr.on('data', (d) => out.push(d.toString()));
    c.on('exit', (code) => { if (code !== 0) console.log(`      [${file} output tail]\n` + out.join('').split('\n').slice(-15).join('\n')); res(code); });
  });
}

// A bare ws.Server standing in for a MALICIOUS/compromised relay — sends
// whatever raw frames the test wants directly, bypassing relay.js's own
// always-valid gossip re-wrap entirely (that re-wrap is exactly why a rogue
// PEER through the REAL relay can never reach this bug — see header note).
function bootFakeRelay(port, framesToSend) {
  const WSServer = WS.WebSocketServer || WS.Server;
  const server = new WSServer({ port });
  server.on('connection', (ws) => { for (const f of framesToSend) ws.send(f); });
  return server;
}

(async () => {
  console.log('\n  NODE CRASH GUARD — malformed relay frames never crash a node\n');

  // (1) NULL FRAME — the exact bug found by the adversarial audit
  console.log('  (1) NULL FRAME');
  {
    const port = portCounter++; const url = `ws://127.0.0.1:${port}`;
    const fake = bootFakeRelay(port, ['null']);
    const A = mkIdentity('crash1_A'), B = mkIdentity('crash1_B');
    const nA = bootNode('crash1_A', url, [A.address, B.address]);
    await waitUntil(() => nA.ready(), 4000);
    await sleep(1200);
    (nA.isAlive() && nA.ready())
      ? ok('a raw `null` frame from a malicious relay is dropped — node stays alive, still reaches ready/status')
      : bad(`node did not survive: alive=${nA.isAlive()} ready=${nA.ready()} stderr=${nA.errLines.join('').slice(0,300)}`);
    await killNode(nA);
    await new Promise((res) => fake.close(res));
  }

  // (2) OTHER NON-OBJECT / MALFORMED FRAMES — and the node keeps processing
  // VALID frames sent afterward (not just "didn't crash", but genuinely still
  // functional for legitimate traffic that follows).
  console.log('  (2) OTHER NON-OBJECT FRAMES (string/number/array/malformed + still processes valid frames after)');
  {
    const port = portCounter++; const url = `ws://127.0.0.1:${port}`;
    const A = mkIdentity('crash2_A'), B = mkIdentity('crash2_B');
    const founders = [A.address, B.address];
    const validSeal = JSON.stringify({ t: 'gossip', tx: require('./swarm/swarm_engine').founderSeal(A) });
    const badFrames = [
      'null', '"just a string"', '42', '[1,2,3]', 'true', 'false',
      '{"t":"gossip"}',                    // missing tx entirely
      '{"t":"gossip","tx":null}',          // tx explicitly null
      '{"t":"sync"}',                      // missing msgs entirely — for...of undefined would throw without the try/catch layer
      '{"t":"sync","msgs":null}',          // msgs explicitly null — for...of null also throws without the guard
      'not even json {{{',
      '',
    ];
    const fake = bootFakeRelay(port, [...badFrames, validSeal]);   // a legitimate seal LAST, after all the garbage
    const nA = bootNode('crash2_A', url, founders);
    await waitUntil(() => nA.ready(), 4000);
    const survivedAndProcessed = await waitUntil(() => nA.isAlive() && nA.lastStatus() && nA.lastStatus().members === 1, 4000);
    (survivedAndProcessed)
      ? ok(`${badFrames.length} malformed/non-object frames all dropped; node stayed alive AND correctly processed the valid seal that followed (members=1)`)
      : bad(`node did not survive or did not process the valid frame after: alive=${nA.isAlive()} status=${JSON.stringify(nA.lastStatus())} stderr=${nA.errLines.join('').slice(0,400)}`);
    await killNode(nA);
    await new Promise((res) => fake.close(res));
  }

  // (3) CONVERGENCE STILL WORKS — the fix must not change normal behavior
  console.log('  (3) CONVERGENCE STILL WORKS (through the REAL relay.js)');
  let r3;
  try {
    const port = portCounter++; const url = `ws://127.0.0.1:${port}`;
    r3 = startRelay({ port, log: () => {} });
    const A = mkIdentity('crash3_A'), B = mkIdentity('crash3_B');
    const founders = [A.address, B.address];
    const nA = bootNode('crash3_A', url, founders), nB = bootNode('crash3_B', url, founders);
    await waitUntil(() => nA.ready() && nB.ready());
    nA.send({ op: 'seal_founder' }); nB.send({ op: 'seal_founder' });
    await waitUntil(() => { const s = nA.lastStatus(); return s && s.members === 2; });
    nA.send({ op: 'pay', to: B.address, amount: 42000, nonce: 1, epoch: 0 });
    const converged = await waitUntil(() => { const sa = nA.lastStatus(), sb = nB.lastStatus(); return sa && sb && sa.hash === sb.hash && sa.balances[A.address] === 958000; });
    const sa = nA.lastStatus(), sb = nB.lastStatus();
    (converged && sb.balances[B.address] === 1042000)
      ? ok(`two real nodes still converge normally through the real relay (${sa.hash}) — the crash-guard didn't break legitimate traffic`)
      : bad(`convergence broke: A=${JSON.stringify(sa)} B=${JSON.stringify(sb)}`);
    await killNode(nA); await killNode(nB);
  } catch (e) { bad('probe 3 exception: ' + e.message); }
  finally { if (r3) await r3.close(); }

  // (4) REGRESSION — Brick 3 suite + backend byte-identical (money/consensus untouched)
  console.log('  (4) REGRESSION');
  {
    const code = await runNode('test_brick3.js');
    (code === 0) ? ok('test_brick3.js (→ Brick 2 bites 1-2 → Self gate → Brick 1 → Phase 0–3) → exit 0: nothing existing broke')
                 : bad(`test_brick3.js → exit ${code}`);
  }

  console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Node crash guard: ${fails === 0 ? 'ALL PROBES PASS' : fails + ' FAILURE(S)'} — malformed relay frames are dropped, never a crash.\n`);
  process.exit(fails === 0 ? 0 : 1);
})();
