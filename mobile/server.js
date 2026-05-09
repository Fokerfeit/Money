const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const LEDGER_FILE = path.join(__dirname, 'ledger.json');

const loadLedger = () => {
  try {
    if (fs.existsSync(LEDGER_FILE)) {
      return JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
    }
  } catch {}
  return [];
};

const saveLedger = (txs) => {
  try {
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(txs, null, 2));
  } catch (e) {
    console.error('Failed to save ledger:', e.message);
  }
};

let transactions = loadLedger();
console.log(`Ledger loaded: ${transactions.length} transactions`);

app.get('/ledger', (req, res) => res.json(transactions));

app.post('/transaction', (req, res) => {
  const { from, to, amount, reason } = req.body;

  if (!from || !to || amount == null) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  // Penalty transactions bypass balance check (they come from the system)
  if (reason !== 'disconnect_penalty') {
    const senderBalance = transactions.reduce((bal, tx) => {
      if (tx.to === from) return bal + tx.amount;
      if (tx.from === from) return bal - tx.amount;
      return bal;
    }, 0);

    if (from !== 'FAUCET' && from !== 'SWARM_RESERVE' && senderBalance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
  }

  const tx = {
    from,
    to,
    amount: parseFloat(amount),
    reason: reason || null,
    time: new Date().toLocaleTimeString(),
    timestamp: Date.now()
  };

  transactions.unshift(tx);
  saveLedger(transactions);
  console.log(`TX: ${from} → ${to} | ${amount} MONEY${reason ? ` [${reason}]` : ''}`);
  res.json({ success: true, tx });
});

app.get('/balance/:address', (req, res) => {
  const addr = req.params.address;
  const balance = transactions.reduce((bal, tx) => {
    if (tx.to === addr) return bal + tx.amount;
    if (tx.from === addr) return bal - tx.amount;
    return bal;
  }, 0);
  res.json({ address: addr, balance: Math.max(0, parseFloat(balance.toFixed(2))) });
});

app.get('/health', (req, res) => res.json({ status: 'ok', transactions: transactions.length }));

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`MONEY backend running on port ${PORT}`);
  console.log(`Ledger: ${LEDGER_FILE}`);
});
