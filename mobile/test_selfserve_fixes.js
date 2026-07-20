// mobile/test_selfserve_fixes.js — regression tests for the three Cowork audit
// findings on 413d73a (swarm/selfserve-join). Every probe must pass; exit 0.
//
//   (1) GENESIS SEMANTIC VALIDATION — fail-closed on CONTENTS, not just structure:
//       empty founders / non-string entry / lowercase hex / wrong length /
//       non-hex chars / structural garbage all exit 1 with a genesis-naming error;
//       and a planted VALID genesis.json.bak next to a corrupt genesis.json must
//       NOT rescue the boot (genesis is read-only → no .bak fallback, ever).
//       Control: a valid genesis still boots.
//   (2) HONEST REDEEM ACK — {redeem-sent} at announce; {redeemed} ONLY after our
//       address appears in the folded member set (ordering asserted); an invalid
//       invite ends in {redeem-failed} with NO {redeemed}; a race loser redeeming
//       an already-spent invite gets {redeem-failed}.
//   (3) FORK VISIBILITY — a node whose genesis founder set doesn't contain a
//       founder seal present in the relay archive emits {type:'warning',
//       code:'possible-fork'} (observation only); the happy path emits NO warning.
//
// Runs run_node.js straight from the repo (dist packaging is test_selfserve_join's
// job) with GENESIS_FILE pointed at per-probe temp files.
//
// CONTESTABILITY STATUS: the engine-level hole this suite originally surfaced
// (fold() resolving same-invite contests by seal-id hash order → a rival seal
// could retroactively displace an admitted member) is now CLOSED by the
// bound-invites protocol change: makeInvite signs over a target address, and
// fold() verifies the invite signature against the sealer's own address — so
// only the bound redeemer can EVER produce a verifying seal. Probe (2c-i) below
// proves rejection in the previously-winning adversarial hash order: the rival
// seal is PINNED (via deterministic ed25519 seal ids) to sort FIRST, exactly the
// order that used to steal membership, and fold must still admit only the bound
// redeemer. Old unbound invites are a clean break — simply invalid.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startRelay } = require('./swarm/relay');
const { mkIdentity } = require('./swarm/committee_bridge');
const E = require('./swarm/swarm_engine');

let fails = 0;
const ok  = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RUN_NODE = path.join(__dirname, 'swarm', 'run_node.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'selfserve_fixes_'));
let portCounter = 45200 + Math.floor(Math.random() * 6000);

const CONFIG_KEYS = ['NODE_LABEL', 'FOUNDERS_JSON', 'RELAY_URL', 'GENESIS_FILE', 'IDENTITY_FILE', 'STORE_FILE', 'REDEEM_TIMEOUT_MS'];
function env(extra = {}) {
  const e = { ...process.env };
  for (const k of CONFIG_KEYS) delete e[k];
  return { ...e, ...extra };
}

function bootNode(envObj) {
  const child = spawn(process.execPath, [RUN_NODE], { env: envObj, stdio: ['pipe', 'pipe', 'pipe'] });
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
    idxOf: (type) => lines.findIndex((l) => l.type === type),
  };
}
async function waitUntil(node, pred, timeoutMs = 10000, stepMs = 120) {
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) { if (pred()) return true; if (node) node.send({ op: 'status' }); await sleep(stepMs); }
  return pred();
}
async function killNode(n) {
  if (!n || !n.child) return;
  const c = n.child; n.child = null;
  if (c.exitCode !== null || c.signalCode !== null) return;
  await new Promise((r) => { c.once('exit', r); try { c.kill('SIGKILL'); } catch { r(); } });
  await sleep(60);
}
function waitExit(child, timeoutMs = 6000) {
  return new Promise((res) => {
    if (child.exitCode !== null) return res(child.exitCode);
    let done = false;
    child.once('exit', (code) => { if (!done) { done = true; res(code); } });
    setTimeout(() => { if (!done) { done = true; res(null); } }, timeoutMs);
  });
}

// Spawn run_node with a given genesis file body; expect exit 1 + genesis-naming stderr.
let variantN = 0;
async function expectGenesisRejected(label, body, alsoBak = null) {
  const gfile = path.join(TMP, `genesis_variant_${variantN++}.json`);
  fs.writeFileSync(gfile, typeof body === 'string' ? body : JSON.stringify(body));
  if (alsoBak !== null) fs.writeFileSync(gfile + '.bak', JSON.stringify(alsoBak));
  const n = bootNode(env({ GENESIS_FILE: gfile, NODE_LABEL: 'genesis-variant' }));
  const code = await waitExit(n.child);
  const errText = n.errLines.join('');
  (code === 1 && /genesis/i.test(errText) && !n.ready())
    ? ok(`(1) ${label} → exit 1, genesis-naming error, never booted`)
    : bad(`(1) ${label} NOT rejected: exit=${code}, ready=${!!n.ready()}, stderr=${errText.slice(0, 200)}`);
  await killNode(n);
}

(async () => {
  console.log('\n  SELF-SERVE JOIN — AUDIT FIXES ON 413d73a\n');

  const VALID_ADDR = mkIdentity('any-valid').address;   // real addrOf output shape

  // ── (1) GENESIS SEMANTIC VALIDATION ─────────────────────────────────────────
  console.log('  (1) GENESIS — content validation fails closed, no .bak fallback');
  await expectGenesisRejected('empty founders array', { relay: 'ws://x', founders: [] });
  await expectGenesisRejected('non-string founder entry', { relay: 'ws://x', founders: [123] });
  await expectGenesisRejected('lowercase-hex founder', { relay: 'ws://x', founders: [VALID_ADDR.toLowerCase()] });
  await expectGenesisRejected('wrong-length founder', { relay: 'ws://x', founders: ['M_ABC123'] });
  await expectGenesisRejected('non-hex-chars founder', { relay: 'ws://x', founders: ['M_' + 'G'.repeat(32)] });
  await expectGenesisRejected('structurally-not-an-object', ['not', 'an', 'object']);
  await expectGenesisRejected('unparseable JSON', 'GARBAGE{{{');
  // The .bak-shadow probe: main corrupt, .bak fully VALID → must still refuse.
  await expectGenesisRejected('corrupt genesis + planted VALID .bak (no fallback allowed)',
    'GARBAGE{{{', { relay: 'ws://x', founders: [VALID_ADDR] });

  // Control: a valid genesis boots and reports its founder source.
  const relayPort = portCounter++;
  const relayUrl = `ws://127.0.0.1:${relayPort}`;
  const relay = startRelay({ port: relayPort, log: () => {} });
  const founderId = mkIdentity('fix-founder');
  const goodGenesis = path.join(TMP, 'genesis_good.json');
  fs.writeFileSync(goodGenesis, JSON.stringify({ relay: relayUrl, founders: [founderId.address] }));
  {
    const n = bootNode(env({ GENESIS_FILE: goodGenesis, NODE_LABEL: 'genesis-control' }));
    const booted = await waitUntil(n, () => !!n.ready());
    (booted && n.errLines.join('').includes('1 founder(s)'))
      ? ok('(1) control: a VALID genesis boots and logs its founder set + source')
      : bad(`(1) control failed to boot: ${n.errLines.join('')}`);
    await killNode(n);
  }

  // ── (2) HONEST REDEEM ACK ───────────────────────────────────────────────────
  console.log('\n  (2) REDEEM — sent → redeemed only on real membership; failures honest');
  let founder = bootNode(env({ NODE_LABEL: 'fix-founder', RELAY_URL: relayUrl, FOUNDERS_JSON: JSON.stringify([founderId.address]) }));
  await waitUntil(founder, () => !!founder.ready());
  founder.send({ op: 'seal_founder' });
  await waitUntil(founder, () => { const s = founder.lastStatus(); return s && s.members >= 1; });

  const nc1Id = mkIdentity('fix-nc1'), nc3Id = mkIdentity('fix-nc3'), nc4Id = mkIdentity('fix-nc4');

  // (2-pre) an invite WITHOUT a target must be refused with a helpful error.
  founder.send({ op: 'invite' });
  const inviteErr = await waitUntil(founder, () => !!founder.find((l) => l.type === 'error' && l.op === 'invite'));
  (inviteErr && /for:'M_/.test(founder.find((l) => l.type === 'error' && l.op === 'invite').reason))
    ? ok("(2-pre) {op:'invite'} without 'for' → clear error telling the inviter to get the friend's address")
    : bad('(2-pre) missing-target invite not refused helpfully');

  founder.send({ op: 'invite', for: nc1Id.address });
  await waitUntil(founder, () => !!founder.find((l) => l.type === 'invite'));
  const invite = founder.find((l) => l.type === 'invite').invite;
  (invite.target === nc1Id.address)
    ? ok('(2-pre) issued invite carries its bound target address')
    : bad(`(2-pre) invite.target wrong: ${JSON.stringify(invite)}`);

  // (2a) valid invite: redeem-sent strictly precedes redeemed; member at redeemed time.
  const nc1 = bootNode(env({ NODE_LABEL: 'fix-nc1', RELAY_URL: relayUrl, FOUNDERS_JSON: JSON.stringify([founderId.address]) }));
  await waitUntil(nc1, () => !!nc1.ready());
  await waitUntil(nc1, () => { const s = nc1.lastStatus(); return s && s.members >= 1; });   // synced founder seal first
  nc1.send({ op: 'redeem', invite });
  const confirmed = await waitUntil(nc1, () => !!nc1.find((l) => l.type === 'redeemed'));
  if (!confirmed) bad(`(2a) valid redeem never confirmed: ${nc1.errLines.join('')}`);
  else {
    const iSent = nc1.idxOf('redeem-sent'), iRed = nc1.idxOf('redeemed');
    (iSent !== -1 && iRed !== -1 && iSent < iRed)
      ? ok('(2a) event order honest: redeem-sent emitted first, redeemed only after')
      : bad(`(2a) bad ordering: redeem-sent@${iSent}, redeemed@${iRed}`);
    const isMember = await waitUntil(nc1, () => { const s = nc1.lastStatus(); return s && s.members >= 2 && s.balances[nc1.ready().address] === 1_000_000; });
    isMember ? ok('(2a) redeemed was backed by REAL membership (members=2, funded 1,000,000)')
             : bad(`(2a) redeemed emitted without real membership: ${JSON.stringify(nc1.lastStatus())}`);
    (!nc1.find((l) => l.type === 'redeem-failed'))
      ? ok('(2a) no spurious redeem-failed on the success path')
      : bad('(2a) success path also emitted redeem-failed');
  }

  // (2b) invalid invite (garbage inviter sig): redeem-sent → redeem-failed, NO redeemed.
  const nc2 = bootNode(env({ NODE_LABEL: 'fix-nc2', RELAY_URL: relayUrl, FOUNDERS_JSON: JSON.stringify([founderId.address]), REDEEM_TIMEOUT_MS: '2000' }));
  await waitUntil(nc2, () => !!nc2.ready());
  await waitUntil(nc2, () => { const s = nc2.lastStatus(); return s && s.members >= 1; });
  nc2.send({ op: 'redeem', invite: { inviterAddr: founderId.address, inviteId: 'bogus-invite', inviterSig: '00'.repeat(64) } });
  const failed2 = await waitUntil(nc2, () => !!nc2.find((l) => l.type === 'redeem-failed'), 8000);
  (failed2 && nc2.find((l) => l.type === 'redeem-sent') && !nc2.find((l) => l.type === 'redeemed'))
    ? ok('(2b) INVALID invite → redeem-sent, then redeem-failed (with hint), never redeemed')
    : bad(`(2b) invalid invite mishandled: failed=${failed2}, redeemed=${!!nc2.find((l) => l.type === 'redeemed')}`);
  (failed2 && /invalid|already used|unreachable/.test((nc2.find((l) => l.type === 'redeem-failed') || {}).hint || ''))
    ? ok('(2b) redeem-failed carries the plain-language hint')
    : bad('(2b) redeem-failed hint missing');

  // (2c-i) ENGINE: rival seal for an already-redeemed BOUND invite, from a
  // different address, PINNED to the adversarial hash order (rival's seal id
  // sorts FIRST — exactly the order that used to steal membership). fold must
  // still admit only the bound redeemer.
  {
    const F = mkIdentity('engine-founder'), A = mkIdentity('engine-bound-a'), B = mkIdentity('engine-rival-b');
    let pinnedId = null, pinnedInv = null;
    for (let i = 0; i < 500 && !pinnedId; i++) {
      const inv = E.makeInvite(F, `rival-first-${i}`, A.address);   // bound to A
      if (E.seal(B, inv).id < E.seal(A, inv).id) { pinnedId = `rival-first-${i}`; pinnedInv = inv; }
    }
    if (!pinnedInv) bad('(2c-i) could not pin an adversarial hash order in 500 tries');
    else {
      const led = new E.Ledger([F.address]);
      led.add(E.founderSeal(F));
      led.add(E.seal(B, pinnedInv));   // rival FIRST in both arrival AND hash order
      led.add(E.seal(A, pinnedInv));   // the bound redeemer second
      const { members, bal } = led.fold();
      (members[A.address] && !members[B.address] && bal[A.address] === E.MINT)
        ? ok('(2c-i) ENGINE: rival seal (sorts FIRST — the old winning order) REJECTED; bound redeemer admitted with 1,000,000')
        : bad(`(2c-i) engine admitted wrong member: A=${!!members[A.address]} B=${!!members[B.address]}`);
      // and the same set folded with ONLY the rival present: nobody is admitted
      const led2 = new E.Ledger([F.address]);
      led2.add(E.founderSeal(F));
      led2.add(E.seal(B, pinnedInv));
      (!led2.fold().members[B.address])
        ? ok('(2c-i) ENGINE: a thief holding a stolen bound invite is admitted NOWHERE (interception closed)')
        : bad('(2c-i) thief admitted with a stolen bound invite');
    }
  }

  // (2c-ii) STDIO: a node redeeming an invite bound to SOMEONE ELSE gets an
  // immediate, clear error — no announce, no 30s timeout.
  const nc3 = bootNode(env({ NODE_LABEL: 'fix-nc3', RELAY_URL: relayUrl, FOUNDERS_JSON: JSON.stringify([founderId.address]), REDEEM_TIMEOUT_MS: '2500' }));
  await waitUntil(nc3, () => !!nc3.ready());
  await waitUntil(nc3, () => { const s = nc3.lastStatus(); return s && s.members >= 2; });
  nc3.send({ op: 'redeem', invite });   // nc1's invite — bound to nc1, not nc3
  const boundErr = await waitUntil(nc3, () => !!nc3.find((l) => l.type === 'error' && l.op === 'redeem' && /bound to/.test(l.reason)));
  (boundErr && !nc3.find((l) => l.type === 'redeemed') && !nc3.find((l) => l.type === 'redeem-sent'))
    ? ok('(2c-ii) redeeming someone else\'s bound invite → immediate clear error, nothing announced')
    : bad(`(2c-ii) bound-mismatch redeem mishandled: ${JSON.stringify(nc3.lines.filter((l) => l.type !== 'status').slice(-4))}`);

  // (2c-iii) the ORIGINAL race scenario, done right: two DIFFERENT bound invites,
  // two newcomers — both join, no contest possible.
  founder.send({ op: 'invite', for: nc3Id.address });
  await waitUntil(founder, () => founder.lines.filter((l) => l.type === 'invite').length >= 2);
  const invite3 = founder.lines.filter((l) => l.type === 'invite').pop().invite;
  nc3.send({ op: 'redeem', invite: invite3 });
  const nc4 = bootNode(env({ NODE_LABEL: 'fix-nc4', RELAY_URL: relayUrl, FOUNDERS_JSON: JSON.stringify([founderId.address]) }));
  await waitUntil(nc4, () => !!nc4.ready());
  founder.send({ op: 'invite', for: nc4Id.address });
  await waitUntil(founder, () => founder.lines.filter((l) => l.type === 'invite').length >= 3);
  const invite4 = founder.lines.filter((l) => l.type === 'invite').pop().invite;
  nc4.send({ op: 'redeem', invite: invite4 });
  const bothJoined = await waitUntil(nc4, () => {
    const s3 = nc3.lastStatus(), s4 = nc4.lastStatus();
    return s3 && s4 && s3.members === 4 && s4.members === 4
      && s4.balances[nc3Id.address] === 1_000_000 && s4.balances[nc4Id.address] === 1_000_000;
  }, 15000);
  (bothJoined && nc3.find((l) => l.type === 'redeemed') && nc4.find((l) => l.type === 'redeemed'))
    ? ok('(2c-iii) two DIFFERENT bound invites → both newcomers join cleanly (members=4, both funded)')
    : bad(`(2c-iii) two-invite scenario failed: nc3=${JSON.stringify(nc3.lastStatus())} nc4=${JSON.stringify(nc4.lastStatus())}`);

  // No fork warnings anywhere on the happy path (same genesis everywhere).
  ([founder, nc1, nc2, nc3, nc4].every((n) => !n.find((l) => l.type === 'warning' && l.code === 'possible-fork')))
    ? ok('(3-pre) NO possible-fork warning on the happy path (no false positives)')
    : bad('(3-pre) spurious possible-fork warning emitted on matching genesis');

  // ── (3) FORK VISIBILITY ─────────────────────────────────────────────────────
  console.log('\n  (3) FORK — foreign founder seal in the archive triggers the warning');
  {
    // The relay archive already holds fix-founder's seal. Boot a node whose
    // genesis names a DIFFERENT founder → it must warn, and stay at members 0.
    const strangerId = mkIdentity('fix-stranger-founder');
    const forkGenesis = path.join(TMP, 'genesis_fork.json');
    fs.writeFileSync(forkGenesis, JSON.stringify({ relay: relayUrl, founders: [strangerId.address] }));
    const forkNode = bootNode(env({ GENESIS_FILE: forkGenesis, NODE_LABEL: 'fix-forked' }));
    await waitUntil(forkNode, () => !!forkNode.ready());
    const warned = await waitUntil(forkNode, () => !!forkNode.find((l) => l.type === 'warning' && l.code === 'possible-fork'));
    if (warned) {
      const w = forkNode.find((l) => l.type === 'warning' && l.code === 'possible-fork');
      (w.unknownFounder === founderId.address)
        ? ok(`(3) possible-fork warning names the unrecognized founder (${w.unknownFounder.slice(0, 12)}…)`)
        : bad(`(3) warning names wrong founder: ${JSON.stringify(w)}`);
      (forkNode.errLines.join('').includes('POSSIBLE FORK'))
        ? ok('(3) warning also logged loudly to stderr')
        : bad('(3) stderr fork line missing');
      const s = forkNode.lastStatus();
      (s && s.members === 0)
        ? ok('(3) observation only: node did NOT adopt the foreign founder (members stays 0)')
        : bad(`(3) node adopted foreign state?! ${JSON.stringify(s)}`);
      const warnings = forkNode.lines.filter((l) => l.type === 'warning' && l.code === 'possible-fork');
      (warnings.length === 1)
        ? ok('(3) warned exactly ONCE for the one unknown founder (no warning spam)')
        : bad(`(3) ${warnings.length} warnings for one unknown founder`);
    } else bad(`(3) no possible-fork warning: ${forkNode.errLines.join('').slice(0, 300)}`);
    await killNode(forkNode);
  }

  await killNode(founder); await killNode(nc1); await killNode(nc2); await killNode(nc3); await killNode(nc4);
  await relay.close();
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Audit fixes: ${fails === 0 ? 'ALL PROBES PASS' : fails + ' FAILURE(S)'}\n`);
  process.exit(fails === 0 ? 0 : 1);
})();
