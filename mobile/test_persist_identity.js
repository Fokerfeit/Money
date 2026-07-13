// mobile/test_persist_identity.js — persisted node identity ("download and run").
// Every probe must pass; exit 0.
//
//   A ADDRESS + BALANCE SURVIVE A RESTART — boot a node with no NODE_LABEL (the
//     real friends/family path), seal it as a founder, note address + balance,
//     kill the PROCESS (relay keeps running), restart it, confirm the SAME
//     address is reported and the SAME balance comes back (via the relay's
//     archive replay — no local ledger-state file needed for this to work).
//   B FAIL-CLOSED ON CORRUPTION — a hand-corrupted identity.json must make the
//     node refuse to start (non-zero exit, clear stderr message) rather than
//     silently minting a fresh replacement identity and orphaning the real one.
//   C EXISTING TEST-HARNESS PATH UNTOUCHED — booting WITH NODE_LABEL (as every
//     pre-existing Brick 3 test does) must never touch IDENTITY_FILE at all —
//     no file created, even if IDENTITY_FILE points somewhere.
//
// Real child processes (run_node.js), real relay.js, real loopback WebSocket —
// same harness pattern as test_brick3.js.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { startRelay } = require('./swarm/relay');

let fails = 0;
const ok  = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = path.join(__dirname, '.persist_identity_tmp');
let portCounter = 42500 + Math.floor(Math.random() * 8000);

function bootNode(env) {
  const child = spawn(process.execPath, [path.join(__dirname, 'swarm', 'run_node.js')], {
    env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = []; const errLines = []; let buf = '';
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
    ready: () => lines.find((l) => l.type === 'ready'),
  };
}
async function waitUntil(predicate, timeoutMs = 8000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return true; await sleep(stepMs); }
  return predicate();
}
// Like waitUntil, but also re-pings {op:'status'} each tick — needed because a
// solo node's own announce()/pay() never triggers onChange for ITSELF (that only
// fires on an incoming relay message; a lone node has no peer to gossip it back),
// so nothing would ever spontaneously emit a fresh 'status' line to observe.
async function waitUntilPolling(node, predicate, timeoutMs = 8000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    node.send({ op: 'status' });
    await sleep(stepMs);
  }
  node.send({ op: 'status' });
  await sleep(stepMs);
  return predicate();
}
async function killNode(n) {
  if (!n || !n.child) return;
  const c = n.child; n.child = null;
  if (c.exitCode !== null || c.signalCode !== null) return;   // already exited (e.g. probe B's corrupted-file boot) — 'exit' already fired, waiting on it again would hang forever
  await new Promise((r) => { c.once('exit', r); try { c.kill('SIGKILL'); } catch { r(); } });
  await sleep(100);
}
async function waitExit(n, timeoutMs = 4000) {
  return new Promise((res) => {
    let done = false;
    n.child.once('exit', (code) => { if (!done) { done = true; res(code); } });
    setTimeout(() => { if (!done) { done = true; res(null); } }, timeoutMs);
  });
}

(async () => {
  console.log('\n  PERSISTED NODE IDENTITY — "download and run" survives a restart\n');
  fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true });
  const relayPort = portCounter++;
  const relay = startRelay({ port: relayPort, log: () => {} });
  const relayUrl = `ws://127.0.0.1:${relayPort}`;

  // ── PROBE A: address + balance survive a restart ──────────────────────────
  console.log('  (A) ADDRESS + BALANCE SURVIVE A RESTART');
  {
    const identityFile = path.join(TMP, 'identity.json');

    // Boot 1: no NODE_LABEL, no existing identity file → generate + persist,
    // then immediately exit. This is the "first ever run" a friend would do.
    // (FOUNDERS_JSON can't include our own address yet — we don't know it until
    // the process tells us — so this boot's only job is to create the file.)
    const boot1 = bootNode({ RELAY_URL: relayUrl, IDENTITY_FILE: identityFile, FOUNDERS_JSON: '[]' });
    const gotReady1 = await waitUntil(() => !!boot1.ready());
    if (!gotReady1) bad(`boot 1 never emitted 'ready' — stderr: ${boot1.errLines.join('')}`);
    const address = boot1.ready() && boot1.ready().address;
    if (address && address.startsWith('M_')) ok(`boot 1 generated a real identity (${address}) with no NODE_LABEL`);
    else bad(`boot 1 did not produce a valid M_ address: ${JSON.stringify(boot1.ready())}`);
    if (fs.existsSync(identityFile)) ok('identity.json was written to disk before/at boot');
    else bad('identity.json was NOT written to disk');
    await killNode(boot1);

    // Boot 2: same IDENTITY_FILE, now that we know our own address, pass it as
    // the sole founder, seal, and note the resulting balance.
    const boot2 = bootNode({ RELAY_URL: relayUrl, IDENTITY_FILE: identityFile, FOUNDERS_JSON: JSON.stringify([address]) });
    await waitUntil(() => !!boot2.ready());
    const address2 = boot2.ready() && boot2.ready().address;
    if (address2 === address) ok('boot 2 loaded the SAME address from identity.json (not a fresh one)');
    else bad(`boot 2 address changed: expected ${address}, got ${address2}`);
    boot2.send({ op: 'seal_founder' });
    const sealed = await waitUntilPolling(boot2, () => { const s = boot2.lastStatus(); return s && s.balances && s.balances[address] > 0; });
    const balanceAfterSeal = sealed ? boot2.lastStatus().balances[address] : undefined;
    if (sealed) ok(`boot 2 sealed as founder, balance = ${balanceAfterSeal}`);
    else bad('boot 2 never reached a positive balance after sealing');
    await killNode(boot2);

    // Boot 3: kill the NODE process (relay is untouched — it still has the
    // seal in its archive), restart, and confirm SAME address AND SAME
    // balance come back — the actual bug this bite fixes.
    const boot3 = bootNode({ RELAY_URL: relayUrl, IDENTITY_FILE: identityFile, FOUNDERS_JSON: JSON.stringify([address]) });
    await waitUntil(() => !!boot3.ready());
    const address3 = boot3.ready() && boot3.ready().address;
    if (address3 === address) ok('boot 3 (after kill+restart) still reports the SAME address');
    else bad(`boot 3 address changed after restart: expected ${address}, got ${address3}`);
    const resynced = await waitUntilPolling(boot3, () => { const s = boot3.lastStatus(); return s && s.balances && s.balances[address] === balanceAfterSeal; });
    if (resynced) ok(`boot 3 balance resynced to ${balanceAfterSeal} — NOT zero, NOT a fresh identity`);
    else bad(`boot 3 balance did not match: expected ${balanceAfterSeal}, got ${boot3.lastStatus() && boot3.lastStatus().balances}`);
    await killNode(boot3);
  }

  // ── PROBE B: fail-closed on a corrupted identity file ──────────────────────
  console.log('\n  (B) FAIL-CLOSED ON CORRUPTION');
  {
    const corruptFile = path.join(TMP, 'corrupt_identity.json');
    fs.writeFileSync(corruptFile, '{ this is not valid json');
    const boot = bootNode({ RELAY_URL: relayUrl, IDENTITY_FILE: corruptFile, FOUNDERS_JSON: '[]' });
    const code = await waitExit(boot, 4000);
    if (code !== null && code !== 0) ok(`corrupted identity file → process exited non-zero (code ${code}), never started`);
    else bad(`corrupted identity file did NOT cause a non-zero exit (code: ${code})`);
    if (!boot.ready()) ok('no "ready" event was ever emitted — the node never silently proceeded');
    else bad(`node emitted 'ready' despite a corrupted identity file: ${JSON.stringify(boot.ready())}`);
    if (boot.errLines.join('').toLowerCase().includes('identity file')) ok('stderr contains a clear, identity-file-specific error message');
    else bad(`stderr did not contain an identity-file error: ${boot.errLines.join('')}`);
    await killNode(boot);
  }

  // ── PROBE C: existing NODE_LABEL test-harness path is untouched ───────────
  console.log('\n  (C) EXISTING NODE_LABEL PATH NEVER TOUCHES IDENTITY_FILE');
  {
    const untouchedFile = path.join(TMP, 'should_never_exist.json');
    const boot = bootNode({ RELAY_URL: relayUrl, NODE_LABEL: 'regression-check-node', IDENTITY_FILE: untouchedFile, FOUNDERS_JSON: '[]' });
    await waitUntil(() => !!boot.ready());
    const addr = boot.ready() && boot.ready().address;
    if (addr) ok(`NODE_LABEL path still boots normally (${addr})`);
    else bad('NODE_LABEL path failed to boot');
    if (!fs.existsSync(untouchedFile)) ok('IDENTITY_FILE was never written when NODE_LABEL is set — existing test harnesses are unaffected');
    else bad('IDENTITY_FILE was created even though NODE_LABEL was set — this would break every existing Brick 3 test');
    await killNode(boot);
  }

  await relay.close();
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(fails === 0 ? '\n✅ ALL PROBES PASSED\n' : `\n❌ ${fails} PROBE(S) FAILED\n`);
  process.exit(fails === 0 ? 0 : 1);
})();
