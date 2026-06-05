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

// A platform recipient address that never ignites via the faucet — it is
// allowed to receive only because it is whitelisted in MONEY_PLATFORM_ADDRESSES.
const PLATFORM_ADDR = 'M_DEADBEEFDEADBEEFDEADBEEFDEADBEEF';
const PORT = process.env.PORT || 3000;  // override to avoid clashing with a running server
// Produce the malleable S+L variant of a valid signature (must be rejected by canonical-S).
const malleate = sigHex => { const L = 7237005577332262213973186563042994240857116359379907606001950938285454250989n; const sb = Buffer.from(sigHex, 'hex'); let Sp = (() => { let n = 0n; for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(sb[32 + i]); return n; })() + L; const o = Buffer.alloc(32); for (let j = 0; j < 32; j++) { o[j] = Number(Sp & 0xffn); Sp >>= 8n; } return Buffer.concat([sb.slice(0, 32), o]).toString('hex'); };

const post = (body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const req  = http.request({
    hostname: 'localhost', port: PORT, path: '/transaction',
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
  // Run the server against an isolated temp data dir so the simulation never
  // touches the production ledger.json / google_accounts.json / replay_fence.json.
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'money-sim-'));

  const srv = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      NODE_ENV: 'test',                          // 1000 ignition attempts/hr in test
      MONEY_DATA_DIR: tmpDir,
      MONEY_PLATFORM_ADDRESSES: PLATFORM_ADDR,   // whitelisted recipient under test
      IGNITION_CODES: '',                        // no codes in this suite — it exercises the OTHER gates
      PORT: String(PORT),                        // isolate from any running server
    },
    stdio: 'pipe',
  });
  srv.on('exit', () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

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

  // Ignite two honest wallets, send a VALID transfer, then replay it verbatim.
  // The message-keyed fence (checked AFTER signature verification) must reject it.
  const rpA = makeKeypair(), rpB = makeKeypair();
  const ta = Date.now();
  await post({ from: 'FAUCET', to: rpA.address, amount: 1_000_000, signature: signTx('FAUCET', rpA.address, 1_000_000, ta, rpA.secretKey), publicKey: rpA.publicKey, timestamp: ta });
  const tb = Date.now();
  await post({ from: 'FAUCET', to: rpB.address, amount: 1_000_000, signature: signTx('FAUCET', rpB.address, 1_000_000, tb, rpB.secretKey), publicKey: rpB.publicKey, timestamp: tb });
  const ttr = Date.now();
  const transferBody = { from: rpA.address, to: rpB.address, amount: 100, signature: signTx(rpA.address, rpB.address, 100, ttr, rpA.secretKey), publicKey: rpA.publicKey, timestamp: ttr };
  r = await post(transferBody);
  expect('Valid transfer accepted (setup)', r, 200);
  r = await post(transferBody); // replay verbatim
  expect('Exact replay of the same transfer is rejected', r, 401, 'duplicate transaction');

  // ── Block 3: Signature forgery ─────────────────────────────────────────
  console.log(Y('\n[ 3 ] Signature forgery'));

  const victim = makeKeypair();
  const attacker = makeKeypair();
  const forgedTs = Date.now();
  // Attacker tries to sign a transaction FROM victim's address using attacker's key
  const forgedSig = signTx('FAUCET', victim.address, 1_000_000, forgedTs, attacker.secretKey);
  r = await post({ from: 'FAUCET', to: victim.address, amount: 1_000_000,
    signature: forgedSig, publicKey: attacker.publicKey, timestamp: forgedTs });
  expect('Mismatched publicKey → address is rejected', r, 401, 'public key does not match');

  const validSig = signTx('FAUCET', victim.address, 1_000_000, forgedTs, victim.secretKey);
  // Tamper with signature — flip one nibble
  const tamperedSig = validSig.slice(0, -1) + (validSig.slice(-1) === 'a' ? 'b' : 'a');
  r = await post({ from: 'FAUCET', to: victim.address, amount: 1_000_000,
    signature: tamperedSig, publicKey: victim.publicKey, timestamp: forgedTs });
  expect('Tampered signature is rejected', r, 401, 'invalid');

  // ── Block 4: Signature malleability (canonical-S) ─────────────────────
  console.log(Y('\n[ 4 ] Signature malleability'));

  // A valid signature, re-encoded as the malleable S+L variant, must be rejected
  // by the canonical-S check — so a captured transfer can't be re-applied.
  const mA = makeKeypair(), mB = makeKeypair();
  const tma = Date.now();
  await post({ from: 'FAUCET', to: mA.address, amount: 1_000_000, signature: signTx('FAUCET', mA.address, 1_000_000, tma, mA.secretKey), publicKey: mA.publicKey, timestamp: tma });
  const tmb = Date.now();
  await post({ from: 'FAUCET', to: mB.address, amount: 1_000_000, signature: signTx('FAUCET', mB.address, 1_000_000, tmb, mB.secretKey), publicKey: mB.publicKey, timestamp: tmb });
  const tmt = Date.now();
  const goodSig = signTx(mA.address, mB.address, 100, tmt, mA.secretKey);
  r = await post({ from: mA.address, to: mB.address, amount: 100, signature: malleate(goodSig), publicKey: mA.publicKey, timestamp: tmt });
  expect('Malleated (S+L) signature is rejected', r, 401, 'invalid');

  // ── Block 5: Successful ignition (no Google identity — dormant gate) ───
  console.log(Y('\n[ 5 ] Legitimate ignition'));

  const honest = makeKeypair();
  const tsH    = Date.now();
  const sigH   = signTx('FAUCET', honest.address, 1_000_000, tsH, honest.secretKey);

  r = await post({ from: 'FAUCET', to: honest.address, amount: 1_000_000,
    signature: sigH, publicKey: honest.publicKey, timestamp: tsH });
  expect('Valid ignition (no google_sub) is accepted', r, 200);

  // ── Block 6: Double-ignition (same address) ───────────────────────────
  console.log(Y('\n[ 6 ] Double-ignition attacks'));

  const tsH2  = Date.now();
  const sigH2 = signTx('FAUCET', honest.address, 1_000_000, tsH2, honest.secretKey);
  r = await post({ from: 'FAUCET', to: honest.address, amount: 1_000_000,
    signature: sigH2, publicKey: honest.publicKey, timestamp: tsH2 });
  expect('Second ignition for same address is rejected', r, 400, 'already been ignited');

  // ── Block 7: Send from unregistered address ───────────────────────────
  console.log(Y('\n[ 7 ] Sending from unregistered wallet'));

  const ghost = makeKeypair();
  const tsG   = Date.now();
  const sigG  = signTx(ghost.address, honest.address, 100, tsG, ghost.secretKey);
  r = await post({ from: ghost.address, to: honest.address, amount: 100,
    signature: sigG, publicKey: ghost.publicKey, timestamp: tsG });
  // Ghost has 0 balance — server rejects with insufficient balance (unregistered = always 0 balance)
  expect('Unregistered sender can\'t send funds', r, 400, 'insufficient balance');

  // ── Block 8: Send to unregistered address ────────────────────────────
  console.log(Y('\n[ 8 ] Sending to unregistered wallet'));

  const unknown = makeKeypair();
  const tsU     = Date.now();
  const sigU    = signTx(honest.address, unknown.address, 100, tsU, honest.secretKey);
  r = await post({ from: honest.address, to: unknown.address, amount: 100,
    signature: sigU, publicKey: honest.publicKey, timestamp: tsU });
  expect('Sending to unregistered wallet is rejected', r, 400, 'not a registered swarm node');
  // Note: ghost also has no balance, but "not registered" fires first since recipient check precedes balance check

  // ── Block 9: Economic integrity ───────────────────────────────────────
  console.log(Y('\n[ 9 ] Economic integrity'));

  // Over-mint: sign a FAUCET→self claim for far more than calcReward allows.
  const greedy   = makeKeypair();
  const tsGreedy = Date.now();
  const sigGreedy = signTx('FAUCET', greedy.address, 999_999_999, tsGreedy, greedy.secretKey);
  r = await post({ from: 'FAUCET', to: greedy.address, amount: 999_999_999,
    signature: sigGreedy, publicKey: greedy.publicKey, timestamp: tsGreedy });
  expect('Faucet claim above calcReward is rejected (no unlimited mint)', r, 400, 'exceeds');

  // Forged penalty: unsigned disconnect_penalty against a registered victim.
  // honest is registered with a balance; an attacker tries to burn it with no signature.
  r = await post({ from: honest.address, to: 'SWARM_RESERVE', amount: 100,
    reason: 'disconnect_penalty', timestamp: Date.now() });
  expect('Unsigned disconnect_penalty is rejected (no unauthenticated burn)', r, 401, 'must include signature');

  // ── Block 10: Platform recipient allowlist ────────────────────────────
  console.log(Y('\n[ 10 ] Platform recipient allowlist'));

  // honest is registered with a balance; pay the whitelisted (never-ignited)
  // platform address — this is the nocopycART marketplace payment path.
  const tsP  = Date.now();
  const sigP = signTx(honest.address, PLATFORM_ADDR, 500, tsP, honest.secretKey);
  r = await post({ from: honest.address, to: PLATFORM_ADDR, amount: 500,
    signature: sigP, publicKey: honest.publicKey, timestamp: tsP });
  expect('Payment to a whitelisted platform address is accepted', r, 200);

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
