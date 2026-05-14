const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

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

// Registered users = unique wallets that ever received a FAUCET grant
const userCount = () =>
  new Set(txs.filter(t => t.from === 'FAUCET').map(t => t.to)).size;

const getBalance = (addr) =>
  txs.reduce((b, t) => t.to === addr ? b + t.amount : t.from === addr ? b - t.amount : b, 0);

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health',    (req, res) => res.json({ status: 'ok', transactions: txs.length }));
app.get('/usercount', (req, res) => res.json({ count: userCount() }));
app.get('/ledger',    (req, res) => res.json(txs));

app.get('/balance/:addr', (req, res) => {
  const bal = getBalance(req.params.addr);
  res.json({ address: req.params.addr, balance: Math.max(0, parseFloat(bal.toFixed(2))) });
});

app.post('/transaction', (req, res) => {
  const { from, to, amount, reason } = req.body;

  if (!from || !to || amount == null)
    return res.status(400).json({ error: 'Missing fields: from, to, amount required' });

  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0)
    return res.status(400).json({ error: 'Invalid amount' });

  // One faucet claim per wallet — enforced server-side
  if (from === 'FAUCET') {
    const already = txs.some(t => t.from === 'FAUCET' && t.to === to);
    if (already)
      return res.status(400).json({ error: 'Faucet already claimed for this wallet' });
  }

  // Balance check — skip for faucet and penalty transactions
  if (from !== 'FAUCET' && from !== 'SWARM_RESERVE' && reason !== 'disconnect_penalty') {
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
