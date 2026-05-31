/**
 * MONEY Security — Attack Simulation
 * Spawns its own server instance with NODE_ENV=test, runs every attack,
 * then shuts it down. No external server needed.
 *
 * Usage: node attack_sim.js
 */

const nacl   = require('tweetnacl');
const crypto = require('crypto');
const http   = require('http');
const { spawn } = require('child_process');
const path   = require('path');
const fs     = require('fs');

// ── Helpers ────────────────────────────────────────────────────────────────
const toHex   = (a)   => Buffer.from(a).toString('hex');
const fromHex = (hex) => Buffer.from(hex, 'hex');

const makeKeypair = () => {
  const seed = nacl.randomBytes(32);
  const kp   = nacl.sign.keyPair.fromSeed(seed);
  return {
    address:   'M_' + toHex(kp.publicKey).substring(0, 32).toUpperCase(),
    publicKey: toHex(kp.publicKey),
    secretKey: toHex(kp.secretKey),
  };
};

const signTx = (from, to, amount, timestamp, secretKeyHex) => {
  const msg = Buffer.from(`${from}:${to}:${amount}:${timestamp}`);
  return toHex(nacl.sign.detached(msg, fromHex(secretKeyHex)));
};

const fakeHash = () => crypto.randomBytes(32).toString('hex');

const post = (body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const req  = http.request({
    hostname: 'localhost', port: 3000, path: '/transaction',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  }, (res) => {
    let raw = '';
    res.on('data', c => raw += c);
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
  });
  req.on('error', reject);
  req.write(data);
  req.end();
});

// ── Colours ───────────────────────────────────────────────────────────────
const G = s => `\x1b[32m${s}\x1b[0m`; // green
const R = s => `\x1b[31m${s}\x1b[0m`; // red
const Y = s => `\x1b[33m${s}\x1b[0m`; // yellow
const B = s => `\x1b[1m${s}\x1b[0m`;  // bold

// ── Test runner ───────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const expect = (label, res, expectedStatus, expectedErrorSnippet) => {
  const statusOk = res.status === expectedStatus;
  const bodyOk   = expectedErrorSnippet
    ? (res.body.error || '').toLowerCase().includes(expectedErrorSnippet.toLowerCase())
    : res.body.success === true;
  const ok = statusOk && bodyOk;
  if (ok) { passed++; console.log(G(`  ✅ PASS`) + ` — ${label}`); }
  else     { failed++; console.log(R(`  ❌ FAIL`) + ` — ${label}`);
             console.log(`       status=${res.status} body=${JSON.stringify(res.body)}`); }
};

// ── Spawn server + wait for it to be ready ───────────────────────────────
const spawnServer = () => new Promise((resolve, reject) => {
  const registryPath = path.join(__dirname, 'face_registry.json');
  // Wipe registry so each run starts from a clean slate
  try { fs.unlinkSync(registryPath); } catch {}

  const srv = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, NODE_ENV: 'test' }, // 1000 ignition attempts per hour in test
    stdio: 'pipe',
  });

  let ready = false;
  const onData = (chunk) => {
    if (!ready && chunk.toString().toLowerCase().includes('listening on')) {
      ready = true;
      resolve(srv);
    }
  };
  srv.stdout.on('data', onData);
  srv.stderr.on('data', onData);
  srv.on('error', reject);
  setTimeout(() => reject(new Error('Server did not start within 5s')), 5000);
});

// ── Run ───────────────────────────────────────────────────────────────────
(async () => {
  const srv = await spawnServer().catch(e => { console.error('Server start failed:', e.message); process.exit(1); });
  console.log(B('\n══════════════════════════════════════════════'));
  console.log(B('  MONEY — Security Attack Simulation'));
  console.log(B('══════════════════════════════════════════════\n'));

  const kp = makeKeypair();
  const ts = () => Date.now();

  // ── Block 1: Timestamp attacks ─────────────────────────────────────────
  console.log(Y('[ 1 ] Timestamp attacks'));

  let r = await post({ from: kp.address, to: 'M_ANYRECIPIENT', amount: 1,
    signature: 'deadbeef', publicKey: kp.publicKey, timestamp: Date.now() - 3 * 60 * 1000 });
  expect('Stale timestamp (3min old) is rejected', r, 401, 'timestamp expired');

  r = await post({ from: kp.address, to: 'M_ANYRECIPIENT', amount: 1,
    signature: 'deadbeef', publicKey: kp.publicKey, timestamp: Date.now() + 120_000 });
  expect('Future timestamp (+2min) is rejected', r, 401, 'timestamp expired');

  // ── Block 2: Replay attacks ────────────────────────────────────────────
  console.log(Y('\n[ 2 ] Replay attacks'));

  // To hit the replay gate we need a tx that passes timestamp but fails later.
  // We craft one with a valid timestamp but wrong signature — it'll pass timestamp,
  // get added to seenSigs, then fail on sig verify. Second attempt with same sig = replay catch.
  const ts2 = Date.now();
  const fakeSig = fakeHash(); // not a valid sig — will fail verifyTx, but that comes after seenSig insert
  r = await post({ from: 'FAUCET', to: kp.address, amount: 1_000_000,
    signature: fakeSig, publicKey: kp.publicKey, timestamp: ts2,
    faceHashes: Array.from({ length: 5 }, fakeHash) });
  // This will fail on sig verify or face sybil (hashes are new so no sybil) or sig verify
  // The important thing is the sig is now in seenSigs

  // Second attempt with the SAME signature (replay)
  r = await post({ from: 'FAUCET', to: kp.address, amount: 1_000_000,
    signature: fakeSig, publicKey: kp.publicKey, timestamp: ts2,
    faceHashes: Array.from({ length: 5 }, fakeHash) });
  expect('Exact replay of same signature is rejected', r, 401, 'duplicate transaction');

  // ── Block 3: Signature forgery ─────────────────────────────────────────
  console.log(Y('\n[ 3 ] Signature forgery'));

  const victim = makeKeypair();
  const attacker = makeKeypair();
  const forgedTs = Date.now();
  // Attacker tries to sign a transaction FROM victim's address using attacker's key
  const forgedSig = signTx('FAUCET', victim.address, 1_000_000, forgedTs, attacker.secretKey);
  r = await post({ from: 'FAUCET', to: victim.address, amount: 1_000_000,
    signature: forgedSig, publicKey: attacker.publicKey, timestamp: forgedTs,
    faceHashes: Array.from({ length: 5 }, fakeHash) });
  expect('Mismatched publicKey → address is rejected', r, 401, 'public key does not match');

  const validSig = signTx('FAUCET', victim.address, 1_000_000, forgedTs, victim.secretKey);
  // Tamper with signature — flip one nibble
  const tamperedSig = validSig.slice(0, -1) + (validSig.slice(-1) === 'a' ? 'b' : 'a');
  r = await post({ from: 'FAUCET', to: victim.address, amount: 1_000_000,
    signature: tamperedSig, publicKey: victim.publicKey, timestamp: forgedTs,
    faceHashes: Array.from({ length: 5 }, fakeHash) });
  expect('Tampered signature is rejected', r, 401, 'invalid');

  // ── Block 4: Face hash / Sybil attacks ────────────────────────────────
  console.log(Y('\n[ 4 ] Face hash / Sybil attacks'));

  const sybil1 = makeKeypair();
  const ts4    = Date.now();
  const sig4   = signTx('FAUCET', sybil1.address, 1_000_000, ts4, sybil1.secretKey);

  r = await post({ from: 'FAUCET', to: sybil1.address, amount: 1_000_000,
    signature: sig4, publicKey: sybil1.publicKey, timestamp: ts4,
    faceHashes: [] });
  expect('Missing face hashes rejected (Sybil with no camera)', r, 400, 'face inscription incomplete');

  // Each subtest needs a fresh keypair + timestamp + signature — same sig would hit replay fence
  const sybil1b = makeKeypair();
  const ts4b    = Date.now();
  const sig4b   = signTx('FAUCET', sybil1b.address, 1_000_000, ts4b, sybil1b.secretKey);
  r = await post({ from: 'FAUCET', to: sybil1b.address, amount: 1_000_000,
    signature: sig4b, publicKey: sybil1b.publicKey, timestamp: ts4b,
    faceHashes: ['notahex', 'alsowrong', 'badhash'] });
  expect('Malformed face hashes (not SHA-256 hex) rejected', r, 400, 'malformed');

  const sybil1c = makeKeypair();
  const ts4c    = Date.now();
  const sig4c   = signTx('FAUCET', sybil1c.address, 1_000_000, ts4c, sybil1c.secretKey);
  r = await post({ from: 'FAUCET', to: sybil1c.address, amount: 1_000_000,
    signature: sig4c, publicKey: sybil1c.publicKey, timestamp: ts4c,
    faceHashes: Array.from({ length: 2 }, fakeHash) });
  expect('Only 2 face hashes (< 3 minimum) rejected', r, 400, 'face inscription incomplete');

  // ── Block 5: Successful ignition ──────────────────────────────────────
  console.log(Y('\n[ 5 ] Legitimate ignition'));

  const honest = makeKeypair();
  const tsH    = Date.now();
  const sigH   = signTx('FAUCET', honest.address, 1_000_000, tsH, honest.secretKey);
  const hashes = Array.from({ length: 5 }, fakeHash);

  r = await post({ from: 'FAUCET', to: honest.address, amount: 1_000_000,
    signature: sigH, publicKey: honest.publicKey, timestamp: tsH,
    faceHashes: hashes });
  expect('Valid ignition with 5 hashes is accepted', r, 200);

  // ── Block 6: Double-ignition (same address) ───────────────────────────
  console.log(Y('\n[ 6 ] Double-ignition attacks'));

  const tsH2  = Date.now();
  const sigH2 = signTx('FAUCET', honest.address, 1_000_000, tsH2, honest.secretKey);
  r = await post({ from: 'FAUCET', to: honest.address, amount: 1_000_000,
    signature: sigH2, publicKey: honest.publicKey, timestamp: tsH2,
    faceHashes: Array.from({ length: 5 }, fakeHash) });
  expect('Second ignition for same address is rejected', r, 400, 'already been ignited');

  // ── Block 7: Sybil with stolen face hashes ────────────────────────────
  console.log(Y('\n[ 7 ] Sybil with stolen/reused face hashes'));

  const sybil2 = makeKeypair();
  const tsS2   = Date.now();
  const sigS2  = signTx('FAUCET', sybil2.address, 1_000_000, tsS2, sybil2.secretKey);
  // Reuse the SAME hashes that were used for honest.address (the registered seal)
  r = await post({ from: 'FAUCET', to: sybil2.address, amount: 1_000_000,
    signature: sigS2, publicKey: sybil2.publicKey, timestamp: tsS2,
    faceHashes: hashes /* same hashes as honest */ });
  expect('Sybil using stolen hashes from another address is rejected', r, 400, 'duplicate seal');

  // ── Block 8: Send from unregistered address ───────────────────────────
  console.log(Y('\n[ 8 ] Sending from unregistered wallet'));

  const ghost = makeKeypair();
  const tsG   = Date.now();
  const sigG  = signTx(ghost.address, honest.address, 100, tsG, ghost.secretKey);
  r = await post({ from: ghost.address, to: honest.address, amount: 100,
    signature: sigG, publicKey: ghost.publicKey, timestamp: tsG });
  // Ghost has 0 balance — server rejects with insufficient balance (unregistered = always 0 balance)
  expect('Unregistered sender can\'t send funds', r, 400, 'insufficient balance');

  // ── Block 9: Send to unregistered address ────────────────────────────
  console.log(Y('\n[ 9 ] Sending to unregistered wallet'));

  const unknown = makeKeypair();
  const tsU     = Date.now();
  const sigU    = signTx(honest.address, unknown.address, 100, tsU, honest.secretKey);
  r = await post({ from: honest.address, to: unknown.address, amount: 100,
    signature: sigU, publicKey: honest.publicKey, timestamp: tsU });
  expect('Sending to unregistered wallet is rejected', r, 400, 'not a registered swarm node');
  // Note: ghost also has no balance, but "not registered" fires first since recipient check precedes balance check

  // ── Summary ───────────────────────────────────────────────────────────
  console.log(B('\n══════════════════════════════════════════════'));
  const total = passed + failed;
  if (failed === 0) {
    console.log(G(`  ALL ${total} ATTACKS BLOCKED ✅`));
  } else {
    console.log(R(`  ${failed}/${total} ATTACKS NOT PROPERLY BLOCKED ❌`));
    process.exitCode = 1;
  }
  console.log(B('══════════════════════════════════════════════\n'));
  srv.kill();
  process.exit(failed === 0 ? 0 : 1);
})();
