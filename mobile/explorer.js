// mobile/explorer.js — block-explorer logic over the EXISTING public endpoints.
//
// Pure and fetch-INJECTED: imports nothing from React Native, so the same module
// runs inside the app (App.js passes global fetch + BACKEND_URL) AND in a Node
// test (which passes a mock fetch). It only READS — it never adds or changes a
// backend route. Endpoints used (already live in server.js):
//   GET /balance/:addr                     — any address's balance
//   GET /tx?from=&to=&limit=               — per-address history, index-served
'use strict';

const ADDRESS_RE = /^M_[0-9A-Fa-f]{32}$/i;      // M_ + 32 hex (matches the app's seal marks)
const isValidAddress = (a) => ADDRESS_RE.test(String(a == null ? '' : a).trim());
const normAddress    = (a) => String(a == null ? '' : a).trim().toUpperCase();

// Standing rule — mirrors standingOf() in server.js so the explorer can show it
// from public data (the server has no /standing route).
const IGNITED_BASELINE = 5;
const MOVE_PER_STANDING = 10000;
const FAUCET = 'FAUCET';

const txKey = (t) => `${t.from}:${t.to}:${t.amount}:${t.timestamp}:${t.sigPrefix}`;
const jsonOf = async (res) => { try { return res && typeof res.json === 'function' ? await res.json() : null; } catch { return null; } };

// Look up ANY address (the ledger is intentionally public): balance + full history
// (sent via /tx?from, received via /tx?to), merged newest-first, with standing
// derived by the same rule the server uses. NOTE: /tx is capped (limit), so for an
// extremely active address the derived standing is a floor, not exact.
async function lookupAddress(fetchFn, base, addrRaw) {
  const addr = normAddress(addrRaw);
  if (!isValidAddress(addr)) throw new Error('Invalid seal mark — must be M_ followed by 32 hex characters.');
  const enc = encodeURIComponent(addr);
  const [balRes, sentRes, recvRes] = await Promise.all([
    fetchFn(`${base}/balance/${enc}`),
    fetchFn(`${base}/tx?from=${enc}&limit=1000`),
    fetchFn(`${base}/tx?to=${enc}&limit=1000`),
  ]);
  const balBody = await jsonOf(balRes);
  const sent = await jsonOf(sentRes);
  const recv = await jsonOf(recvRes);

  const seen = new Set();
  const txs = [];
  for (const t of [...(Array.isArray(sent) ? sent : []), ...(Array.isArray(recv) ? recv : [])]) {
    if (!t || seen.has(txKey(t))) continue;
    seen.add(txKey(t));
    txs.push(t);
  }
  txs.sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0)); // newest first

  const ignited = txs.some((t) => t.from === FAUCET && t.to === addr);
  const cps = new Set();
  for (const t of txs) {
    if (t.from === addr && t.to !== FAUCET && t.to !== addr) cps.add(t.to);   // sender's counterparty
    if (t.to === addr && t.from !== FAUCET && t.from !== addr) cps.add(t.from); // recipient's counterparty
  }
  const standing = (ignited ? IGNITED_BASELINE : 0) + cps.size;
  const balance  = balBody && Number.isFinite(balBody.balance) ? balBody.balance : 0;
  return {
    address: addr,
    balance,
    standing,
    movable: Math.min(balance, standing * MOVE_PER_STANDING),
    ignited,
    counterparties: cps.size,
    txs,                                   // newest-first, sent + received
    found: txs.length > 0 || balance > 0,  // false → graceful "no history" empty state
  };
}

// Per-tx detail — surfaces every field a tap should show. Non-mutating.
function txDetail(t) {
  if (!t) return null;
  return {
    from: t.from,
    to: t.to,
    amount: t.amount,
    reason:    t.reason    == null ? null : t.reason,
    time:      t.time      == null ? null : t.time,
    timestamp: t.timestamp == null ? null : t.timestamp,
    sigPrefix: t.sigPrefix == null ? null : t.sigPrefix,
  };
}

module.exports = { ADDRESS_RE, isValidAddress, normAddress, lookupAddress, txDetail, IGNITED_BASELINE, MOVE_PER_STANDING };
