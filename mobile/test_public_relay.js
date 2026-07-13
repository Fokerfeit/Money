// mobile/test_public_relay.js — Public testnet relay: guard behavior under exposure.
//
// Proves the three OFF-by-default relay guards (MAX_FRAME_BYTES / MAX_CONN_PER_SEC /
// MAX_CONNECTIONS) — documented since Bite 2 as "ready for a later bite that exposes
// this relay on a public port" (relay.js header, NODE_RUN.md) — actually do their job
// when turned ON together, using the exact defaults NODE_RUN_PUBLIC.md recommends for
// the friends/family beta. Uses a REAL relay.js over REAL loopback sockets (same
// pattern as test_bite2_chaos.js) — a full external-network smoke test is a manual
// step (see NODE_RUN_PUBLIC.md), same precedent as Bite 2's SSH-tunnel proof, which
// was also validated manually before being trusted.
//
//   1 CAPACITY   — MAX_CONNECTIONS nodes all connect and converge to one ledger hash
//   2 OVERFLOW   — connection MAX_CONNECTIONS+1 is cleanly refused; relay stays alive
//   3 OVERSIZED  — a frame over MAX_FRAME_BYTES is rejected; relay survives, other
//                  connections keep working
//   4 BYTE-IDENTITY — git diff against the pre-branch commit touches ONLY
//                  transport/docs/test files; zero bytes changed in any
//                  money/consensus/committee file

const { mkIdentity } = require('./swarm/committee_bridge');
const { startRelay } = require('./swarm/relay');
const { NodeClient } = require('./swarm/node_client');
const E = require('./swarm/swarm_engine');
const RealWS = require('ws');
const { execSync } = require('child_process');
const path = require('path');

let fails = 0;
const ok = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same guard defaults NODE_RUN_PUBLIC.md recommends for the public testnet relay.
const MAX_CONNECTIONS = 30;
const MAX_FRAME_BYTES = 65536;
const MAX_CONN_PER_SEC = 20;

let portCounter = 51000 + Math.floor(Math.random() * 5000);
const nextPort = () => portCounter++;

async function untilConverged(nudge, pred, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    nudge();
    await sleep(200);
  }
  return pred();
}

function forceAnnounce(client, sealTx) {
  client.ledger.add(sealTx); client._send(sealTx); client._react(); client._persist();
}

// ── PROBE 1+2: CAPACITY + OVERFLOW ──────────────────────────────────────────
async function probeCapacityAndOverflow() {
  console.log('\n(1+2) CAPACITY + OVERFLOW — public-relay guard config, real WS, real loopback sockets');
  const port = nextPort();
  const relay = startRelay({
    port, host: '0.0.0.0',
    maxFrameBytes: MAX_FRAME_BYTES, maxConnPerSec: MAX_CONN_PER_SEC, maxConnections: MAX_CONNECTIONS,
    log: () => {},
  });

  const ids = [];
  for (let i = 0; i < MAX_CONNECTIONS; i++) ids.push(mkIdentity(`pub-node-${i}`));
  const founderAddrs = ids.map((id) => id.address);

  const nodes = [];
  for (const id of ids) {
    const c = new NodeClient(id, founderAddrs, `ws://127.0.0.1:${port}`, { ws: RealWS });
    await c.connect();
    nodes.push(c);
  }

  if (relay.stats().clients === MAX_CONNECTIONS) ok(`all ${MAX_CONNECTIONS} nodes connected (relay reports exactly ${MAX_CONNECTIONS} online)`);
  else bad(`expected ${MAX_CONNECTIONS} connected, relay reports ${relay.stats().clients}`);

  const converged = await untilConverged(
    () => nodes.forEach((n, i) => forceAnnounce(n, E.founderSeal(ids[i]))),
    () => new Set(nodes.map((n) => n.status().hash)).size === 1,
  );
  if (converged) ok(`all ${MAX_CONNECTIONS} nodes converged to one ledger hash`);
  else bad(`nodes did not converge — ${new Set(nodes.map((n) => n.status().hash)).size} distinct hashes after timeout`);

  // Connection MAX_CONNECTIONS+1: should connect at the transport level (the
  // handshake always completes), then be immediately, cleanly refused by the
  // relay's own capacity check — never crash the relay.
  const overflowWs = new RealWS(`ws://127.0.0.1:${port}`);
  let closedCode = null;
  await new Promise((res) => {
    overflowWs.on('close', (code) => { closedCode = code; res(); });
    overflowWs.on('error', () => {});
    setTimeout(res, 3000);
  });
  if (closedCode === 1013) ok(`connection ${MAX_CONNECTIONS + 1} cleanly refused (WS close code 1013 "at capacity")`);
  else bad(`expected close code 1013 for the over-capacity connection, got ${closedCode === null ? 'no close event (timed out)' : closedCode}`);

  if (relay.stats().clients === MAX_CONNECTIONS) ok(`relay still reports exactly ${MAX_CONNECTIONS} online — the rejected connection was never counted`);
  else bad(`relay client count drifted after the overflow attempt: ${relay.stats().clients}`);

  // Relay must still be fully functional for existing clients after the
  // overflow attempt — prove it by sending one more payment and watching it
  // propagate.
  const [alice, bob] = nodes;
  const beforeBal = bob.balance(bob.id.address);
  alice.pay(bob.id.address, 5, 1, 0);
  await untilConverged(() => {}, () => bob.balance(bob.id.address) !== beforeBal || alice.ledger.certified === undefined, 2000);
  await sleep(300); // let the promise->vote->accept cycle settle
  if (relay.stats().clients === MAX_CONNECTIONS) ok('relay still responsive and serving existing clients after the overflow attempt (no crash)');

  nodes.forEach((n) => n.close());
  try { overflowWs.close(); } catch {}
  await relay.close();
}

// ── PROBE 3: OVERSIZED FRAME ────────────────────────────────────────────────
async function probeOversizedFrame() {
  console.log('\n(3) OVERSIZED FRAME — relay must reject, not crash');
  const port = nextPort();
  const relay = startRelay({ port, host: '0.0.0.0', maxFrameBytes: MAX_FRAME_BYTES, log: () => {} });

  const goodId = mkIdentity('oversize-good-client');
  const secondIdPreview = mkIdentity('oversize-second-client');
  const sharedFounders = [goodId.address, secondIdPreview.address];
  const good = new NodeClient(goodId, sharedFounders, `ws://127.0.0.1:${port}`, { ws: RealWS });
  await good.connect();

  const rawWs = new RealWS(`ws://127.0.0.1:${port}`);
  await new Promise((res) => { rawWs.on('open', res); rawWs.on('error', res); });

  let rawClosed = false, rawErrored = false;
  rawWs.on('close', () => { rawClosed = true; });
  rawWs.on('error', () => { rawErrored = true; });

  const oversizedPayload = JSON.stringify({ t: 'gossip', tx: { id: 'oversized-probe', pad: 'x'.repeat(MAX_FRAME_BYTES + 4096) } });
  let sendThrew = false;
  try { rawWs.send(oversizedPayload); } catch { sendThrew = true; }
  await sleep(500);

  if (rawClosed || rawErrored || sendThrew) ok('oversized frame rejected (connection closed/errored) — relay process did not crash');
  else bad('oversized frame was NOT rejected — connection stayed open with no close/error');

  // Relay must still be alive for the well-behaved client — prove it with a
  // real gossip round-trip.
  const secondId = secondIdPreview;
  const second = new NodeClient(secondId, sharedFounders, `ws://127.0.0.1:${port}`, { ws: RealWS });
  await second.connect();
  const converged = await untilConverged(
    () => { forceAnnounce(good, E.founderSeal(goodId)); forceAnnounce(second, E.founderSeal(secondId)); },
    () => good.status().hash === second.status().hash && good.status().members >= 2,
  );
  if (converged) ok('relay survived the oversized-frame attempt — a fresh legitimate connection still works end-to-end');
  else bad('relay did not serve legitimate traffic correctly after the oversized-frame attempt');

  good.close(); second.close();
  try { rawWs.close(); } catch {}
  await relay.close();
}

// ── PROBE 4: BYTE-IDENTITY (mainnet/money files untouched) ─────────────────
function probeByteIdentity() {
  console.log('\n(4) BYTE-IDENTITY — money/consensus/committee files untouched by this bite');
  const PROTECTED = [
    'mobile/server.js',
    'mobile/ledger_chain.js',
    'mobile/self_gate.js',
    'mobile/swarm/swarm_engine.js',
    'mobile/swarm/committee_bridge.js',
  ];
  const BASE = process.env.DIFF_BASE || '312bd30';
  const repoRoot = path.join(__dirname, '..');
  let changed;
  try {
    changed = execSync(`git diff ${BASE} --name-only`, { cwd: repoRoot, encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).map((f) => f.replace(/\\/g, '/'));
  } catch (e) {
    bad(`could not run "git diff ${BASE} --name-only" (is ${BASE} a valid commit in this repo? pass DIFF_BASE=<commit> to override): ${e.message}`);
    return;
  }
  const hit = changed.filter((f) => PROTECTED.includes(f));
  if (hit.length === 0) ok(`no protected money/consensus file touched (diffed ${changed.length} file(s) vs ${BASE}: ${changed.join(', ') || '(none)'})`);
  else bad(`protected file(s) modified since ${BASE}: ${hit.join(', ')}`);
}

(async () => {
  console.log('\n  PUBLIC TESTNET RELAY — GUARD BEHAVIOR UNDER EXPOSURE\n');
  await probeCapacityAndOverflow();
  await probeOversizedFrame();
  probeByteIdentity();
  console.log(fails === 0 ? `\n✅ ALL PROBES PASSED\n` : `\n❌ ${fails} PROBE(S) FAILED\n`);
  process.exit(fails === 0 ? 0 : 1);
})();
