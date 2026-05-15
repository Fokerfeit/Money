const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const nacl    = require('tweetnacl');

const app = express();
app.use(cors());
app.use(express.json());

const LEDGER_FILE = path.join(__dirname, 'ledger.json');

const load = () => {
  try { return JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')); } catch { return []; }
};
const save = (txs) => {
  try { fs.writeFileSync(LEDGER_FILE, JSON.stringify(txs, null, 2)); }
  catch (e) { console.error('Save error:', e.message); }
};

let txs = load();
console.log(`MONEY server — ${txs.length} transactions in ledger`);

const userCount  = () => new Set(txs.filter(t => t.from === 'FAUCET').map(t => t.to)).size;
const getBalance = (addr) =>
  txs.reduce((b, t) => t.to === addr ? b + t.amount : t.from === addr ? b - t.amount : b, 0);

// ── Signature helpers ─────────────────────────────────────────────────────
const fromHex  = (hex) => new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)));
const toAddress = (pubKeyHex) => 'M_' + pubKeyHex.substring(0, 32).toUpperCase();

const verifyTx = (from, to, amount, timestamp, signature, publicKey) => {
  try {
    const msg = Buffer.from(`${from}:${to}:${amount}:${timestamp}`);
    return nacl.sign.detached.verify(msg, fromHex(signature), fromHex(publicKey));
  } catch { return false; }
};

// ── Routes ────────────────────────────────────────────────────────────────
app.get('/health',    (req, res) => res.json({ status: 'ok', transactions: txs.length }));
app.get('/usercount', (req, res) => res.json({ count: userCount() }));
app.get('/ledger',    (req, res) => res.json(txs));

app.get('/balance/:addr', (req, res) => {
  const bal = getBalance(req.params.addr);
  res.json({ address: req.params.addr, balance: Math.max(0, parseFloat(bal.toFixed(2))) });
});

app.post('/transaction', (req, res) => {
  const { from, to, amount, reason, signature, publicKey, timestamp } = req.body;

  if (!from || !to || amount == null)
    return res.status(400).json({ error: 'Missing fields' });

  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0)
    return res.status(400).json({ error: 'Invalid amount' });

  // ── Signature check ────────────────────────────────────────────────────
  // NOTE: Expo Go cannot run nacl — signatures are enforced in the dev build.
  // The verification code is ready; flip VERIFY_SIGNATURES to true when shipping.
  const VERIFY_SIGNATURES = true;
  const isSystem = from === 'FAUCET' || from === 'SWARM_RESERVE' || reason === 'disconnect_penalty';
  if (VERIFY_SIGNATURES && !isSystem) {
    if (!signature || !publicKey || !timestamp)
      return res.status(401).json({ error: 'Transaction must be signed' });
    if (toAddress(publicKey) !== from)
      return res.status(401).json({ error: 'Public key does not match sender address' });
    if (!verifyTx(from, to, amt, timestamp, signature, publicKey))
      return res.status(401).json({ error: 'Invalid signature — transaction rejected' });
  }

  // ── One faucet claim per wallet ────────────────────────────────────────
  if (from === 'FAUCET') {
    if (txs.some(t => t.from === 'FAUCET' && t.to === to))
      return res.status(400).json({ error: 'Faucet already claimed for this wallet' });
  }

  // ── Balance check ──────────────────────────────────────────────────────
  if (!isSystem) {
    const bal = getBalance(from);
    if (bal < amt)
      return res.status(400).json({ error: `Insufficient balance (have ${bal.toFixed(2)}, need ${amt})` });
  }

  const tx = {
    from, to, amount: amt,
    reason:    reason || null,
    time:      new Date().toLocaleTimeString(),
    timestamp: Date.now(),
  };

  txs.unshift(tx);
  save(txs);
  console.log(`TX: ${from} → ${to} | ${amt} MONEY${reason ? ` [${reason}]` : ''}`);
  res.json({ success: true, tx });
});

app.listen(3000, '0.0.0.0', () => {
  console.log('Listening on :3000');
  console.log(`Registered users: ${userCount()}`);
});
