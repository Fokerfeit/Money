// mobile/swarm/test_invite_sig_guard.js — the redeem-time signature shape guard
// added in 083cb07 ("Reject malformed invite/seal signatures at redeem time").
//
// WHY THIS GUARD EXISTS: invite ccc2d12df65af1c0 was transcribed off a
// screenshot and arrived with one duplicated character — inviterSig was 129 hex
// chars instead of 128. swarm_engine's hexBytes() silently turns an odd-length
// string into the WRONG 64 bytes, so fold() rejected the seal on every node
// while the redeemer waited out the full REDEEM_TIMEOUT_MS and then printed the
// three-way hint "invalid, already used, or unreachable", hiding the real cause.
// Worse, the bad seal reached the relay and its id (which does NOT cover
// inviterSig) permanently poisoned that invite — see the SEAL-ID POISONING note
// in NODE_RUN.md. So the guard's real job is: reject BEFORE anything is gossiped.
//
//   C1  inviterSig of 129 hex chars (the real incident) -> rejected, nothing gossiped
//   C2  inviterSig with a non-hex character            -> rejected, nothing gossiped
//   C3  a well-formed 128-char invite                  -> passes the guard, announces
//   C4  a malformed seal signature at the announce site -> caught before announce()
//
// Every case runs the REAL run_node.js as its own process against a REAL relay,
// and "nothing was gossiped" is measured from the relay's own archive with an
// independent raw socket — not inferred from the absence of a log line. Each
// negative case also asserts the node had genuinely CONNECTED first, so a pass
// can never come from the node simply being offline.
'use strict';
const RealWS = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { startRelay } = require('./relay');
const { mkIdentity } = require('./committee_bridge');
const E = require('./swarm_engine');

let failures = 0;
const ok = (m) => console.log('   [PASS]  ' + m);
const bad = (m) => { failures++; console.log('   [FAIL]  ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reads the relay archive with a RAW socket — no NodeClient, so observing can
// never itself gossip anything into the archive it is measuring.
function readArchive(url) {
  return new Promise((resolve, reject) => {
    const ws = new RealWS(url);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('archive read timed out')); }, 8000);
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m && m.t === 'sync') { clearTimeout(timer); try { ws.close(); } catch {} resolve(m.msgs); }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// C4 needs a seal whose OWN signature is malformed. seal() builds that signature
// from this node's key, so the only way to reach that branch is a local crypto
// fault — simulated here with a --require preload that wraps swarm_engine.seal
// in the module cache BEFORE run_node.js destructures it. run_node.js itself is
// untouched; this only corrupts what seal() hands back, which is exactly the
// fault the branch defends against.
function writeSealCorruptingPreload() {
  const p = path.join(os.tmpdir(), 'money_seal_corrupt_preload.js');
  const enginePath = path.join(__dirname, 'swarm_engine.js').replace(/\\/g, '\\\\');
  fs.writeFileSync(p, [
    "'use strict';",
    "const E = require('" + enginePath + "');",
    'const realSeal = E.seal;',
    '// drop one character from the seal signature -> 127 chars, still hex',
    'E.seal = (id, invite) => { const tx = realSeal(id, invite); return Object.assign({}, tx, { sig: tx.sig.slice(0, 127) }); };',
    '',
  ].join('\n'));
  return p;
}

// Runs one case: boots a relay, spawns run_node.js, feeds it one redeem op,
// and returns everything needed to judge it.
async function runCase({ port, label, inviter, invite, preload }) {
  const url = 'ws://127.0.0.1:' + port;
  const relay = startRelay({ port, log: () => {} });
  const lines = [];
  const args = preload ? ['--require', preload, 'run_node.js'] : ['run_node.js'];
  const child = spawn(process.execPath, args, {
    cwd: __dirname,
    env: Object.assign({}, process.env, {
      MONEY_JSON: '1',                              // raw JSON-Lines, not the pretty renderer
      RELAY_URL: url,                               // the REAL env var run_node reads
      NODE_LABEL: label,                            // deterministic identity, no identity.json written
      FOUNDERS_JSON: JSON.stringify([inviter.address]),
      REDEEM_TIMEOUT_MS: '1500',
    }),
  });
  const collect = (d) => String(d).split('\n').forEach((l) => { if (l.trim()) lines.push(l.trim()); });
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  await sleep(1200);                                 // let it connect and emit 'ready'
  child.stdin.write(JSON.stringify({ op: 'redeem', invite }) + '\n');
  await sleep(2500);                                 // guard fires instantly; this also covers a real announce

  const archive = await readArchive(url);
  child.kill();
  await relay.close();

  const events = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return {
    events,
    connected: events.some((e) => e.type === 'ready'),
    error: events.find((e) => e.type === 'error' && e.op === 'redeem'),
    redeemSent: events.some((e) => e.type === 'redeem-sent'),
    sealsFromNode: archive.filter((t) => t && t.type === 'seal' && t.from === mkIdentity(label).address),
  };
}

let portCounter = 8741;

(async () => {
  console.log('\n  083cb07 — REDEEM-TIME SIGNATURE SHAPE GUARD\n');

  const inviter = mkIdentity('isg_inviter');

  // ── C1: the real incident — 129 hex chars ───────────────────────────────
  console.log('  (C1) 129-CHAR inviterSig (the ccc2d12d incident) IS REJECTED');
  try {
    const label = 'isg_A1';
    const good = E.makeInvite(inviter, 'c1invite00000001', mkIdentity(label).address);
    // reproduce the exact corruption: duplicate one character -> 129 chars
    const corrupt = Object.assign({}, good, { inviterSig: good.inviterSig.slice(0, 6) + good.inviterSig[6] + good.inviterSig.slice(6) });
    (corrupt.inviterSig.length === 129) ? ok('test input really is 129 chars (one duplicated character)')
                                        : bad('test input is ' + corrupt.inviterSig.length + ' chars, expected 129');
    const r = await runCase({ port: portCounter++, label, inviter, invite: corrupt });
    r.connected ? ok('node was CONNECTED to the relay (so a silent pass cannot be from being offline)')
                : bad('node never connected — the negative result would be vacuous');
    (r.error && /expected 128 hex characters, got 129/.test(r.error.reason))
      ? ok('rejected with {type:error, op:redeem} naming the real problem: got 129')
      : bad('no accurate error event: ' + JSON.stringify(r.error && r.error.reason));
    (!r.redeemSent) ? ok('no redeem-sent emitted') : bad('redeem-sent was emitted — it announced anyway');
    (r.sealsFromNode.length === 0)
      ? ok('relay archive contains NO seal from this node — nothing was gossiped')
      : bad('a seal reached the relay archive despite the guard');
  } catch (e) { bad('C1 threw: ' + e.message); }

  // ── C2: right length, wrong alphabet ────────────────────────────────────
  console.log('\n  (C2) NON-HEX CHARACTER IN inviterSig IS REJECTED');
  try {
    const label = 'isg_A2';
    const good = E.makeInvite(inviter, 'c2invite00000002', mkIdentity(label).address);
    const corrupt = Object.assign({}, good, { inviterSig: 'g' + good.inviterSig.slice(1) });   // still 128 long
    (corrupt.inviterSig.length === 128) ? ok('test input is still exactly 128 chars (length alone would pass)')
                                        : bad('test input length is ' + corrupt.inviterSig.length);
    const r = await runCase({ port: portCounter++, label, inviter, invite: corrupt });
    r.connected ? ok('node was CONNECTED to the relay') : bad('node never connected — vacuous');
    (r.error && /contains non-hex characters/.test(r.error.reason))
      ? ok('rejected with the non-hex reason, not a length complaint')
      : bad('no accurate error event: ' + JSON.stringify(r.error && r.error.reason));
    (!r.redeemSent) ? ok('no redeem-sent emitted') : bad('redeem-sent was emitted — it announced anyway');
    (r.sealsFromNode.length === 0)
      ? ok('relay archive contains NO seal from this node — nothing was gossiped')
      : bad('a seal reached the relay archive despite the guard');
  } catch (e) { bad('C2 threw: ' + e.message); }

  // ── C3: NON-VACUITY — a good invite must still work ─────────────────────
  console.log('\n  (C3) A WELL-FORMED INVITE STILL PASSES THE GUARD AND ANNOUNCES');
  try {
    const label = 'isg_A3';
    const inviteId = 'c3invite00000003';
    const good = E.makeInvite(inviter, inviteId, mkIdentity(label).address);
    (good.inviterSig.length === 128) ? ok('invite is a pristine 128-char signature')
                                     : bad('invite sig is ' + good.inviterSig.length + ' chars');
    const r = await runCase({ port: portCounter++, label, inviter, invite: good });
    r.connected ? ok('node was CONNECTED to the relay') : bad('node never connected');
    (!r.error) ? ok('the guard raised NO error — it is not rejecting everything')
               : bad('the guard wrongly rejected a valid invite: ' + r.error.reason);
    r.redeemSent ? ok('redeem-sent emitted — the redeem proceeded normally')
                 : bad('redeem-sent was never emitted for a valid invite');
    (r.sealsFromNode.length === 1 && r.sealsFromNode[0].inviteId === inviteId)
      ? ok('the seal REACHED the relay archive (exactly one, for this invite)')
      : bad('expected exactly one seal in the archive, got ' + r.sealsFromNode.length);
  } catch (e) { bad('C3 threw: ' + e.message); }

  // ── C4: the seal-side check at the announce site ────────────────────────
  console.log('\n  (C4) A MALFORMED SEAL SIGNATURE IS CAUGHT BEFORE announce()');
  try {
    const label = 'isg_A4';
    const good = E.makeInvite(inviter, 'c4invite00000004', mkIdentity(label).address);
    const preload = writeSealCorruptingPreload();
    const r = await runCase({ port: portCounter++, label, inviter, invite: good, preload });
    r.connected ? ok('node was CONNECTED to the relay') : bad('node never connected — vacuous');
    (r.error && /malformed seal signature/.test(r.error.reason))
      ? ok('rejected with the seal-side reason, and it blames local crypto, not the invite')
      : bad('no accurate error event: ' + JSON.stringify(r.error && r.error.reason));
    (!r.redeemSent) ? ok('no redeem-sent emitted') : bad('redeem-sent was emitted — it announced a bad seal');
    (r.sealsFromNode.length === 0)
      ? ok('relay archive contains NO seal — the poisoning path is closed at the source')
      : bad('a malformed seal reached the relay archive');
    try { fs.unlinkSync(preload); } catch {}
  } catch (e) { bad('C4 threw: ' + e.message); }

  console.log(failures === 0
    ? '\n  ALL CASES PASS — malformed signatures are rejected before anything is gossiped\n'
    : '\n  ' + failures + ' check(s) FAILED\n');
  process.exit(failures === 0 ? 0 : 1);
})();
