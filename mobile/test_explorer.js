// test_explorer.js — gate for the block explorer (mobile/explorer.js). Exit non-zero on any failure.
//
//  • Search a known address → balance + correct tx history (sent and received).
//  • Search an address with no history → graceful empty state, no crash.
//  • Reject a malformed address BEFORE any network call.
//  • Tapping a tx surfaces all its fields.
//  • The existing feed still renders → explorer is non-mutating over shared tx data.

const { lookupAddress, txDetail, isValidAddress } = require('./explorer');

const BASE = 'http://test';
const FAUCET = 'FAUCET';
const A  = 'M_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B  = 'M_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const Cc = 'M_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const D  = 'M_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';   // no history

// canned ledger (newest-first, like the server). A: ignited 200000, received 1000 from C, sent 40000 to B.
const ledger = [
  { from: A,      to: B, amount: 40000,  reason: null,   time: '10:00', timestamp: 1000, sigPrefix: 'aa11' },
  { from: Cc,     to: A, amount: 1000,   reason: 'gift', time: '09:30', timestamp: 800,  sigPrefix: 'cc33' },
  { from: FAUCET, to: A, amount: 200000, reason: null,   time: '09:00', timestamp: 500,  sigPrefix: 'bb22' },
];
const balances = { [A]: 161000, [B]: 40000, [Cc]: 0 };   // A = 200000 + 1000 - 40000

// mock fetch that mirrors the real endpoints (GET /balance/:addr, GET /tx?from/&to)
function makeFetch() {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname.startsWith('/balance/')) {
      const addr = decodeURIComponent(u.pathname.slice('/balance/'.length));
      return { ok: true, json: async () => ({ address: addr, balance: balances[addr] != null ? balances[addr] : 0 }) };
    }
    if (u.pathname === '/tx') {
      const from = u.searchParams.get('from'), to = u.searchParams.get('to');
      let out = ledger;
      if (from) out = ledger.filter((t) => t.from === from);
      else if (to) out = ledger.filter((t) => t.to === to);
      return { ok: true, json: async () => out.slice() };
    }
    return { ok: true, json: async () => ({ error: 'no route' }) };
  };
  fn.calls = calls;
  return fn;
}

let fails = 0;
const ok  = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };

(async () => {
  console.log('\n  EXPLORER GATE\n');

  // 1. known address → balance + correct history (sent AND received), newest-first
  const f1 = makeFetch();
  const r = await lookupAddress(f1, BASE, A);
  (r.balance === 161000) ? ok('balance from GET /balance/:addr (161000)') : bad(`balance wrong: ${r.balance}`);
  (r.standing === 7 && r.movable === 70000 && r.ignited === true && r.counterparties === 2)
    ? ok('standing derived (5 ignited + 2 counterparties = 7; movable 70000)') : bad(`standing wrong: ${JSON.stringify({ s: r.standing, m: r.movable, i: r.ignited, c: r.counterparties })}`);
  const sentTx = r.txs.find((t) => t.from === A);
  const recvTx = r.txs.find((t) => t.to === A);
  (r.txs.length === 3 && r.txs[0].timestamp === 1000 && r.txs[2].timestamp === 500 && sentTx && recvTx)
    ? ok('history merges sent + received, newest-first (3 txs)') : bad(`history wrong: ${JSON.stringify(r.txs.map((t) => t.timestamp))}`);
  (r.found === true) ? ok('found = true for an address with history') : bad('found should be true');

  // 2. no-history address → graceful empty (no crash)
  const r2 = await lookupAddress(makeFetch(), BASE, D);
  (r2.txs.length === 0 && r2.balance === 0 && r2.standing === 0 && r2.found === false)
    ? ok('no-history address → empty + found:false (no crash)') : bad(`empty state wrong: ${JSON.stringify(r2)}`);

  // 3. reject malformed BEFORE any network call
  const f3 = makeFetch();
  let threw = false;
  try { await lookupAddress(f3, BASE, 'M_not_a_valid_address'); } catch { threw = true; }
  (threw && f3.calls.length === 0) ? ok('malformed address rejected before any network call') : bad(`malformed: threw=${threw}, calls=${f3.calls.length}`);

  // 4. tapping a tx surfaces all fields
  const d = txDetail(ledger[0]);
  (d && d.from === A && d.to === B && d.amount === 40000 && d.reason === null && d.timestamp === 1000 && d.sigPrefix === 'aa11' && 'time' in d)
    ? ok('tx detail surfaces from/to/amount/reason/timestamp/sigPrefix') : bad(`tx detail wrong: ${JSON.stringify(d)}`);

  // 5. existing feed still renders → explorer must not mutate the shared ledger/tx objects
  const before = JSON.stringify(ledger);
  await lookupAddress(makeFetch(), BASE, A);
  txDetail(ledger[0]);
  (JSON.stringify(ledger) === before) ? ok('feed data untouched (explorer is non-mutating)') : bad('explorer mutated the shared ledger');

  // address validation (used before the network call in the UI)
  (isValidAddress(A) && isValidAddress(A.toLowerCase()) && !isValidAddress('M_bad') && !isValidAddress(''))
    ? ok('address validation matches M_+32hex (case-insensitive)') : bad('isValidAddress wrong');

  console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Explorer: ${fails === 0 ? 'ALL CHECKS PASS' : fails + ' FAILURE(S)'}\n`);
  process.exit(fails === 0 ? 0 : 1);
})();
