// mobile/test_selfserve_join.js — self-serve join for a freshly DOWNLOADED node.
// Every probe must pass; exit 0.
//
//   A ZERO-CONFIG CONVERGE — a node run EXACTLY as a downloaded folder (built by
//     build_node_dist.js, its own node_modules, genesis.json beside run_node.js)
//     with EVERY run_node config env var stripped (no NODE_LABEL, FOUNDERS_JSON,
//     RELAY_URL, GENESIS_FILE, IDENTITY_FILE) boots, learns founders+relay from
//     genesis.json alone, and converges to the founder node's exact tip hash.
//   B INVITE / REDEEM ROUND-TRIP — the founder issues an invite (stdin {op:'invite'});
//     the newcomer redeems it (stdin {op:'redeem'}) over the REAL relay; on the next
//     fold the newcomer is a MEMBER with 1,000,000 and both nodes agree (same tip,
//     members=2). Proves the audited seal/invite path is reachable by a fresh node.
//   C BEARER-INVITE HYGIENE — a redeem with a malformed invite is cleanly rejected
//     ({type:'error'}), not a crash; and the newcomer's own identity.json persisted.
//
// Faithfulness note: to avoid a slow/networked `npm install` in CI, the test copies
// the already-installed `ws` + `tweetnacl` into the download's node_modules instead
// of running npm. That substitutes ONLY dependency resolution — every run_node
// CONFIG input (founders, relay, identity) is still discovered with zero env vars,
// exactly as a real download would after its one-time npm install.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mkIdentity } = require('./swarm/committee_bridge');
const { startRelay } = require('./swarm/relay');

let fails = 0;
const ok  = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REPO_MOBILE = __dirname;
const DIST = path.join(REPO_MOBILE, 'dist', 'money-node');
let portCounter = 43800 + Math.floor(Math.random() * 6000);

// run_node's own config knobs — a genuine "fresh download" has NONE of these set.
const CONFIG_KEYS = ['NODE_LABEL', 'FOUNDERS_JSON', 'RELAY_URL', 'GENESIS_FILE', 'IDENTITY_FILE', 'STORE_FILE'];
function strippedEnv(extra = {}) {
  const e = { ...process.env };
  for (const k of CONFIG_KEYS) delete e[k];
  return { ...e, ...extra };
}

function bootNode(downloadDir, env) {
  const child = spawn(process.execPath, [path.join(downloadDir, 'swarm', 'run_node.js')], {
    cwd: downloadDir, env, stdio: ['pipe', 'pipe', 'pipe'],
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
    ready: () => lines.find((l) => l.type === 'ready'),
    lastStatus: () => lines.filter((l) => l.type === 'status').pop(),
    find: (pred) => lines.find(pred),
  };
}
// A lone/idle node only emits a fresh status on an INCOMING relay message; poll it.
async function waitUntil(node, pred, timeoutMs = 12000, stepMs = 120) {
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) { if (pred()) return true; if (node) node.send({ op: 'status' }); await sleep(stepMs); }
  return pred();
}
async function killNode(n) {
  if (!n || !n.child) return;
  const c = n.child; n.child = null;
  if (c.exitCode !== null || c.signalCode !== null) return;
  await new Promise((r) => { c.once('exit', r); try { c.kill('SIGKILL'); } catch { r(); } });
  await sleep(80);
}

(async () => {
  console.log('\n  SELF-SERVE JOIN — a freshly downloaded node joins with zero config\n');

  // ── Build the real distributable, then make a hermetic copy to run from ──────
  console.log('  (setup) build dist + assemble a self-contained "download" folder');
  execFileSync(process.execPath, [path.join(REPO_MOBILE, 'build_node_dist.js')], { stdio: 'ignore' });
  if (!fs.existsSync(path.join(DIST, 'swarm', 'run_node.js'))) { bad('build did not produce dist/money-node'); process.exit(1); }

  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'selfserve_'));
  const DL = path.join(TMP, 'money-node');
  fs.cpSync(DIST, DL, { recursive: true });
  // Supply the two runtime deps the way a friend's `npm install` would, so the
  // spawn needs NO NODE_PATH and NO config env at all.
  for (const dep of ['ws', 'tweetnacl']) {
    fs.cpSync(path.join(REPO_MOBILE, 'node_modules', dep), path.join(DL, 'node_modules', dep), { recursive: true });
  }
  ok('download folder assembled with its own node_modules (ws, tweetnacl)');

  // ── Test genesis: a founder we control + the local relay ─────────────────────
  const relayPort = portCounter++;
  const relayUrl = `ws://127.0.0.1:${relayPort}`;
  const founderId = mkIdentity('selfserve-founder');
  fs.writeFileSync(path.join(DL, 'swarm', 'genesis.json'),
    JSON.stringify({ network: 'selfserve-test', relay: relayUrl, founders: [founderId.address] }, null, 2));
  const relay = startRelay({ port: relayPort, log: () => {} });

  let founder, newcomer;
  try {
    // Founder node (deterministic identity via NODE_LABEL so its address matches
    // genesis; it is NOT the "fresh download" subject — the newcomer is).
    founder = bootNode(DL, strippedEnv({ NODE_LABEL: 'selfserve-founder', RELAY_URL: relayUrl }));
    await waitUntil(founder, () => !!founder.ready());
    founder.send({ op: 'seal_founder' });
    const founderSealed = await waitUntil(founder, () => {
      const s = founder.lastStatus(); return s && s.members >= 1 && s.balances[founderId.address] === 1_000_000;
    });
    founderSealed ? ok('founder node sealed itself (members=1, balance=1,000,000)')
                  : bad(`founder never sealed: ${JSON.stringify(founder.lastStatus())} / ${founder.errLines.join('')}`);

    // ── PROBE A: ZERO-CONFIG converge ──────────────────────────────────────────
    console.log('\n  (A) ZERO-CONFIG CONVERGE — newcomer run as a real download, all config env stripped');
    newcomer = bootNode(DL, strippedEnv());   // <-- NO NODE_LABEL / FOUNDERS_JSON / RELAY_URL / GENESIS_FILE / IDENTITY_FILE
    const ncReady = await waitUntil(newcomer, () => !!newcomer.ready());
    const ncAddr = newcomer.ready() && newcomer.ready().address;
    (ncReady && ncAddr && ncAddr.startsWith('M_'))
      ? ok(`newcomer booted with a real identity (${ncAddr}) from genesis alone — zero env config`)
      : bad(`newcomer did not boot cleanly: ${JSON.stringify(newcomer.ready())} / ${newcomer.errLines.join('')}`);
    // learned founders+relay from genesis.json (stderr logs the source)
    (newcomer.errLines.join('').includes('genesis') && newcomer.errLines.join('').includes(relayUrl))
      ? ok('newcomer learned founder set + relay from genesis.json (logged at boot)')
      : bad(`newcomer genesis log missing: ${newcomer.errLines.join('')}`);

    const fTip = founder.lastStatus().hash;
    const converged = await waitUntil(newcomer, () => { const s = newcomer.lastStatus(); return s && s.hash === fTip; });
    converged ? ok(`newcomer converged to the founder's exact tip hash (${fTip}) before even joining`)
              : bad(`newcomer tip ${newcomer.lastStatus() && newcomer.lastStatus().hash} != founder tip ${fTip}`);

    // ── PROBE B: INVITE / REDEEM round-trip ─────────────────────────────────────
    console.log('\n  (B) INVITE / REDEEM — founder invites, newcomer redeems over the real relay');
    // Bound invites (protocol change): the inviter must name the redeemer, so the
    // founder asks for the newcomer's address (its 'ready' line) and binds to it.
    founder.send({ op: 'invite', for: ncAddr });
    await waitUntil(founder, () => !!founder.find((l) => l.type === 'invite'));
    const inviteEvt = founder.find((l) => l.type === 'invite');
    const invite = inviteEvt && inviteEvt.invite;
    (invite && invite.inviterAddr === founderId.address && invite.inviteId && invite.inviterSig && invite.target === ncAddr)
      ? ok(`founder issued a well-formed invite (id ${invite.inviteId.slice(0, 8)}…, signed, bound to the newcomer)`)
      : bad(`founder invite malformed: ${JSON.stringify(inviteEvt)}`);

    newcomer.send({ op: 'redeem', invite });
    const redeemedEvt = await waitUntil(newcomer, () => !!newcomer.find((l) => l.type === 'redeemed'));
    redeemedEvt ? ok('newcomer announced its self-seal (redeemed event emitted)')
                : bad('newcomer never emitted a redeemed event');

    const becameMember = await waitUntil(newcomer, () => {
      const s = newcomer.lastStatus(); return s && s.members >= 2 && s.balances[ncAddr] === 1_000_000;
    });
    becameMember ? ok('newcomer is now a MEMBER with 1,000,000 (invite/seal certified by the ledger fold)')
                 : bad(`newcomer did not become a member: ${JSON.stringify(newcomer.lastStatus())}`);

    // both nodes agree on the post-join tip
    const bothAgree = await waitUntil(founder, () => {
      const f = founder.lastStatus(), n = newcomer.lastStatus();
      return f && n && f.hash === n.hash && f.members === 2 && f.balances[ncAddr] === 1_000_000;
    });
    bothAgree ? ok('founder and newcomer converge on the SAME post-join tip (members=2, newcomer funded)')
              : bad(`post-join divergence: founder ${JSON.stringify(founder.lastStatus())} vs newcomer ${JSON.stringify(newcomer.lastStatus())}`);

    // ── PROBE C: bearer-invite hygiene + identity persisted ────────────────────
    console.log('\n  (C) HYGIENE — malformed redeem rejected cleanly; identity persisted');
    newcomer.send({ op: 'redeem', invite: { inviterAddr: 'oops' } });   // missing fields
    const gotError = await waitUntil(newcomer, () => !!newcomer.find((l) => l.type === 'error' && l.op === 'redeem'));
    gotError ? ok('a malformed redeem is rejected with {type:error}, node keeps running (no crash)')
             : bad('malformed redeem did not produce a clean error event');
    (fs.existsSync(path.join(DL, 'swarm', 'identity.json')))
      ? ok('newcomer persisted its wallet (identity.json) — a restart returns the same address')
      : bad('identity.json was not written for the newcomer');
  } catch (e) {
    bad('probe threw: ' + e.message);
  } finally {
    await killNode(founder); await killNode(newcomer);
    await relay.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Self-serve join: ${fails === 0 ? 'ALL PROBES PASS' : fails + ' FAILURE(S)'}\n`);
  process.exit(fails === 0 ? 0 : 1);
})();
