/**
 * End-to-end contract test: MONEY ledger ↔ nocopycART payment verification.
 *
 * Spawns the MONEY server (isolated temp data, platform address whitelisted),
 * ignites a buyer, sends a marketplace payment to the platform wallet, then runs
 * the EXACT matching predicate nocopycART's verifyMoneyPayment() uses against
 * GET /ledger — asserting the payment is found.
 *
 * Usage: node nocopycart_e2e.js
 */
const nacl = require('tweetnacl');
const http = require('http');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PLATFORM_ADDR = 'M_F66DCDBCD2FA68D8FCEE50A503CFBA20'; // nocopycART platform wallet
const PORT = 3000;

const toHex     = (a)  => Buffer.from(a).toString('hex');
const toAddress = (pk) => 'M_' + pk.substring(0, 32).toUpperCase();
const makeKeypair = () => {
  const kp = nacl.sign.keyPair.fromSeed(nacl.randomBytes(32));
  return { address: toAddress(toHex(kp.publicKey)), publicKey: toHex(kp.publicKey), secretKey: toHex(kp.secretKey) };
};
const signTx = (from, to, amount, ts, sk) =>
  toHex(nacl.sign.detached(Buffer.from(`${from}:${to}:${amount}:${ts}`), Buffer.from(sk, 'hex')));

const req = (method, p, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request({ hostname: 'localhost', port: PORT, path: p, method,
    headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
    (res) => { let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw || 'null') })); });
  r.on('error', reject);
  if (data) r.write(data);
  r.end();
});

// The candidate predicate copied from nocopycART server/src/index.ts
// verifyAndConsumeMoneyPayment(). The payment is bound to a specific artwork via
// the ledger `reason` field (the payer attaches the artwork id), so a single
// payment can't satisfy two different artworks. `reference` is the artwork id;
// pass null to test the legacy unbound behaviour.
const nocopycartFindsPayment = (txs, buyerAddress, requiredAmount, reference, windowMs = 15 * 60 * 1000) => {
  const cutoff = Date.now() - windowMs;
  return txs.find(t =>
    t.from === buyerAddress &&
    t.to === PLATFORM_ADDR &&
    t.amount >= requiredAmount &&
    t.timestamp >= cutoff &&
    (reference ? String(t.reason ?? '').includes(reference) : true)
  );
};

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'money-e2e-'));
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, NODE_ENV: 'test', MONEY_DATA_DIR: tmpDir, MONEY_PLATFORM_ADDRESSES: PLATFORM_ADDR },
    stdio: 'pipe',
  });
  srv.on('exit', () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });
  await new Promise((resolve, reject) => {
    const onData = (c) => { if (c.toString().toLowerCase().includes('listening on')) resolve(); };
    srv.stdout.on('data', onData); srv.stderr.on('data', onData);
    setTimeout(() => reject(new Error('server start timeout')), 5000);
  });

  let pass = 0, fail = 0;
  const check = (label, cond) => { cond ? (pass++, console.log(`  ✅ ${label}`)) : (fail++, console.log(`  ❌ ${label}`)); };

  // 1) Buyer ignites (gets faucet balance).
  const buyer = makeKeypair();
  const t1 = Date.now();
  let r = await req('POST', '/transaction', { from: 'FAUCET', to: buyer.address, amount: 1_000_000,
    signature: signTx('FAUCET', buyer.address, 1_000_000, t1, buyer.secretKey), publicKey: buyer.publicKey, timestamp: t1 });
  check('buyer ignition accepted', r.status === 200 && r.body.success);

  // 2) Buyer pays the platform: artwork price 1000 + discounted fee 50 = 1050,
  //    attaching the artwork id in `reason` so the payment is bound to it.
  const ARTWORK_ID = 'art-11111111-2222-3333-4444-555555555555';
  const OTHER_ARTWORK_ID = 'art-99999999-8888-7777-6666-555555555555';
  const TOTAL_DUE = 1050;
  const t2 = Date.now();
  r = await req('POST', '/transaction', { from: buyer.address, to: PLATFORM_ADDR, amount: TOTAL_DUE, reason: ARTWORK_ID,
    signature: signTx(buyer.address, PLATFORM_ADDR, TOTAL_DUE, t2, buyer.secretKey), publicKey: buyer.publicKey, timestamp: t2 });
  check('payment to platform accepted', r.status === 200 && r.body.success);

  // 3) nocopycART reads /ledger and verifies the payment for the referenced artwork.
  const ledger = (await req('GET', '/ledger')).body;
  check('/ledger returns an array', Array.isArray(ledger));
  check('ledger tx carries the artwork id in reason', ledger.some(t => t.reason === ARTWORK_ID));
  const found = nocopycartFindsPayment(ledger, buyer.address, TOTAL_DUE, ARTWORK_ID);
  check('nocopycART verify FINDS the payment for the referenced artwork', !!found);
  check('found tx has from/to/amount/timestamp fields', found && found.from && found.to && typeof found.amount === 'number' && typeof found.timestamp === 'number');

  // 4) Underpayment must NOT verify.
  const notFound = nocopycartFindsPayment(ledger, buyer.address, TOTAL_DUE + 1, ARTWORK_ID);
  check('underpayment (amount < required) does NOT verify', !notFound);

  // 5) The SAME payment must NOT satisfy a different artwork (binding via reason).
  const crossArtwork = nocopycartFindsPayment(ledger, buyer.address, TOTAL_DUE, OTHER_ARTWORK_ID);
  check('one payment does NOT verify a different artwork (artwork binding)', !crossArtwork);

  console.log(`\n  ${fail === 0 ? '✅ E2E CONTRACT OK' : '❌ E2E CONTRACT FAILED'} — ${pass} passed, ${fail} failed\n`);
  srv.kill();
  process.exit(fail === 0 ? 0 : 1);
})();
