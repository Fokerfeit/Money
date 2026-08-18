// mobile/swarm/test_retry_announce_pay.js — finding (c): announce()/pay() were
// never tracked for uplink-loss retry.
//
// _myEmitted + _reconcile() + _drainRetryQueue() (node_client.js) recover a
// frame the relay never received: on every sync the node compares what it
// originated against the relay's archive and re-drives whatever is missing.
// Before this bite ONLY votes/accepts from _react() were tracked, so a seal
// (a REDEEM!) or a payment sent while the socket was down/half-open was lost
// permanently — announce() will not re-send a tx already in the local ledger,
// and pay()'s reflex never re-fires.
//
//   P1  a dropped SEAL is re-driven on reconnect (and a fresh node sees the member)
//   P2  a dropped PAY promise is re-driven, certifies, and supply is conserved
//   P3  NO-DROP regression: nothing is queued and the frame is sent exactly once
//
// Harness note: the deterministic single-frame drop is adapted from
// test_bite2_chaos.js probe 8, with one change — probe 8's `_dropped` flag is
// PER-SOCKET, so a reconnect arms it again (fine there: the retry has 3
// attempts). Here the flag is shared across every socket instance the class
// makes, so EXACTLY ONE frame is dropped for the whole test. That makes "the
// archive is missing it" unambiguous rather than probabilistic.
'use strict';
const RealWS = require('ws');
const { startRelay } = require('./relay');
const { NodeClient } = require('./node_client');
const { mkIdentity } = require('./committee_bridge');
const E = require('./swarm_engine');

let failures = 0;
const ok = (m) => console.log('   [PASS]  ' + m);
const bad = (m) => { failures++; console.log('   [FAIL]  ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred, timeoutMs = 12000, stepMs = 40) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (pred()) return true; await sleep(stepMs); }
  return pred();
}

// Reads the relay's archive with a RAW socket — no NodeClient, so observing
// can never itself gossip, vote or otherwise perturb what it is measuring.
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
const archiveIds = (msgs) => msgs.map((t) => t && t.id).filter(Boolean);
const countIn = (msgs, id) => archiveIds(msgs).filter((x) => x === id).length;

// Drops the FIRST outbound frame matching `pred` — once for the whole test,
// across reconnects (see harness note above).
function makeDropOnceWS(pred) {
  let dropped = false;
  const cls = class DropOnceSocket {
    constructor(url) {
      this._real = new RealWS(url);
      this._h = { open: [], message: [], close: [], error: [] };
      this._real.on('open', (...a) => this._emit('open', a));
      this._real.on('message', (raw) => this._emit('message', [raw]));
      this._real.on('close', (...a) => this._emit('close', a));
      this._real.on('error', (...a) => this._emit('error', a));
    }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); }
    get readyState() { return this._real.readyState; }
    send(data) {
      if (!dropped) {
        let parsed; try { parsed = JSON.parse(data); } catch {}
        if (parsed && pred(parsed)) { dropped = true; cls.dropCount++; return; }
      }
      try { this._real.send(data); } catch {}
    }
    close(...a) { try { this._real.close(...a); } catch {} }
    _emit(ev, args) { for (const fn of this._h[ev] || []) fn(...args); }
  };
  cls.dropCount = 0;
  return cls;
}

// Passes everything through, but counts outbound frames matching `pred` — used
// by P3 to prove the fix does not re-send a frame that already landed.
function makeCountingWS(pred) {
  const cls = class CountingSocket {
    constructor(url) {
      this._real = new RealWS(url);
      this._h = { open: [], message: [], close: [], error: [] };
      this._real.on('open', (...a) => this._emit('open', a));
      this._real.on('message', (raw) => this._emit('message', [raw]));
      this._real.on('close', (...a) => this._emit('close', a));
      this._real.on('error', (...a) => this._emit('error', a));
    }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); }
    get readyState() { return this._real.readyState; }
    send(data) {
      let parsed; try { parsed = JSON.parse(data); } catch {}
      if (parsed && pred(parsed)) cls.sendCount++;
      try { this._real.send(data); } catch {}
    }
    close(...a) { try { this._real.close(...a); } catch {} }
    _emit(ev, args) { for (const fn of this._h[ev] || []) fn(...args); }
  };
  cls.sendCount = 0;
  return cls;
}

const mkNode = (id, founders, url, wsClass) =>
  new NodeClient(id, founders.map((f) => f.address), url, { ws: wsClass || RealWS });

// Snappy but still REAL exponential backoff / reconnect — no constant in
// node_client.js is changed, these are per-instance test overrides exactly as
// probe 8 does it.
function makeSnappy(n) { n._reconnectBaseMs = 100; n._reconnectMaxMs = 400; n._reconnectDelay = 100; n._voteRetryBackoffMs = 150; }

let portCounter = 8631;

(async () => {
  console.log('\n  FINDING (c) — announce()/pay() UPLINK-LOSS RETRY\n');

  // ── P1: a dropped SEAL is re-driven on reconnect ────────────────────────
  console.log('  (P1) DROPPED SEAL RECOVERS ON RECONNECT');
  let r1;
  try {
    const port = portCounter++; const url = 'ws://127.0.0.1:' + port;
    r1 = startRelay({ port, log: () => {} });
    const F = mkIdentity('rap1_F'), A = mkIdentity('rap1_A');
    const founders = [F, A];
    const dropA = makeDropOnceWS((m) => m.t === 'gossip' && m.tx && m.tx.type === 'seal' && m.tx.from === A.address);

    const nF = mkNode(F, founders, url);
    const nA = mkNode(A, founders, url, dropA);
    makeSnappy(nA);
    await Promise.all([nF.connect(), nA.connect()]);

    nF.announce(E.founderSeal(F));                 // lands normally
    const sealA = E.founderSeal(A);
    nA.announce(sealA);                            // THIS frame is dropped on the uplink
    await sleep(600);

    (dropA.dropCount === 1) ? ok('exactly one frame was dropped (deterministic, not chance)')
                            : bad('expected 1 dropped frame, got ' + dropA.dropCount);
    let arch = await readArchive(url);
    (countIn(arch, sealA.id) === 0) ? ok('relay archive does NOT contain A seal — the uplink loss is real')
                                    : bad('A seal reached the archive; the drop did not work');
    nA.ledger.has(sealA.id) ? ok('A believes locally it is sealed (the split-brain the retry must resolve)')
                            : bad('A did not even add its own seal locally');

    nA.ws.close();                                  // a real WAN drop; _closing is false, so it reconnects
    await waitUntil(() => nA.ws && nA.ws.readyState === 1, 8000);
    await sleep(1500);                              // reconcile -> queue -> 50ms drain -> retry, plus slack

    arch = await readArchive(url);
    (countIn(arch, sealA.id) >= 1)
      ? ok('after reconnect the archive CONTAINS A seal — _reconcile() found the gap and re-drove it')
      : bad('after reconnect A seal is STILL missing — the seal was lost permanently (finding (c))');

    const B = mkIdentity('rap1_B');                 // fresh node, syncs only from the relay
    const nB = mkNode(B, founders, url);
    await nB.connect();
    const sawMember = await waitUntil(() => !!nB.ledger.fold().members[A.address], 6000);
    sawMember ? ok('a FRESH node syncing from the relay sees A as a member')
              : bad('a fresh node does not see A as a member — the seal never propagated');

    nA.close(); nF.close(); nB.close();
  } catch (e) { bad('P1 threw: ' + e.message); }
  finally { if (r1) await r1.close(); }

  // ── P2: a dropped PAY promise is re-driven and certifies ────────────────
  console.log('\n  (P2) DROPPED PAY PROMISE RECOVERS ON RECONNECT');
  let r2;
  try {
    const port = portCounter++; const url = 'ws://127.0.0.1:' + port;
    r2 = startRelay({ port, log: () => {} });
    // 4 members: payer A, recipient B, plus V1/V2. committeeFor excludes the
    // sender -> 3 candidates, quorumOf(3) = 3, so every other member must vote.
    const A = mkIdentity('rap2_A'), B = mkIdentity('rap2_B');
    const V = [mkIdentity('rap2_V1'), mkIdentity('rap2_V2')];
    const founders = [A, B, ...V];
    const dropPay = makeDropOnceWS((m) => m.t === 'gossip' && m.tx && m.tx.type === 'promise' && m.tx.from === A.address);

    const nA = mkNode(A, founders, url, dropPay); makeSnappy(nA);
    const nB = mkNode(B, founders, url);
    const nV = V.map((v) => mkNode(v, founders, url));
    const all = [nA, nB, ...nV];
    await Promise.all(all.map((c) => c.connect()));

    all.forEach((c, i) => c.announce(E.founderSeal(founders[i])));
    const sealed = await waitUntil(() => all.every((c) => Object.keys(c.ledger.fold().members).length === 4), 12000);
    sealed ? ok('all 4 founders sealed and converged (clean starting point)')
           : bad('founder seals never converged — P2 setup invalid');

    const supplyBefore = Object.values(nB.ledger.fold().bal).reduce((a, b) => a + b, 0);
    const p = nA.pay(B.address, 60000, 1, 0);       // this promise frame is dropped
    await sleep(800);

    (dropPay.dropCount === 1) ? ok('exactly one promise frame was dropped')
                              : bad('expected 1 dropped frame, got ' + dropPay.dropCount);
    let arch = await readArchive(url);
    (countIn(arch, p.id) === 0) ? ok('relay archive does NOT contain the promise')
                                : bad('the promise reached the archive; the drop did not work');
    const stalled = nB.ledger.fold().bal[B.address] === 1000000;
    stalled ? ok('recipient balance unmoved — the payment is genuinely stuck')
            : bad('balance moved even though the promise was dropped');

    nA.ws.close();
    await waitUntil(() => nA.ws && nA.ws.readyState === 1, 8000);

    const certified = await waitUntil(() => nB.ledger.fold().bal[B.address] === 1060000, 15000);
    certified ? ok('after reconnect the promise was re-driven, voted, and CERTIFIED (B = 1,060,000)')
              : bad('the payment never certified — the promise was lost permanently (finding (c))');
    const fB = nB.ledger.fold();
    (fB.bal[A.address] === 940000) ? ok('payer debited correctly (A = 940,000)')
                                   : bad('payer balance wrong: ' + fB.bal[A.address]);
    const supplyAfter = Object.values(fB.bal).reduce((a, b) => a + b, 0);
    (supplyAfter === supplyBefore) ? ok('supply conserved (' + supplyAfter + ' before and after)')
                                   : bad('SUPPLY CHANGED: ' + supplyBefore + ' -> ' + supplyAfter);

    all.forEach((c) => c.close());
  } catch (e) { bad('P2 threw: ' + e.message); }
  finally { if (r2) await r2.close(); }

  // ── P3: no drop -> nothing queued, no duplicate re-send ─────────────────
  console.log('\n  (P3) NO-DROP REGRESSION: nothing queued, sent exactly once');
  let r3;
  try {
    const port = portCounter++; const url = 'ws://127.0.0.1:' + port;
    r3 = startRelay({ port, log: () => {} });
    const F = mkIdentity('rap3_F'), A = mkIdentity('rap3_A');
    const founders = [F, A];
    const sealA = E.founderSeal(A);
    const counting = makeCountingWS((m) => m.t === 'gossip' && m.tx && m.tx.id === sealA.id);

    const nF = mkNode(F, founders, url);
    const nA = mkNode(A, founders, url, counting); makeSnappy(nA);
    await Promise.all([nF.connect(), nA.connect()]);

    nF.announce(E.founderSeal(F));
    nA.announce(sealA);                              // lands normally this time
    await sleep(600);
    (counting.sendCount === 1) ? ok('the seal was sent exactly once before the reconnect')
                               : bad('expected 1 send, got ' + counting.sendCount);

    nA.ws.close();                                   // same reconnect as P1
    await waitUntil(() => nA.ws && nA.ws.readyState === 1, 8000);
    await sleep(1500);                               // give any (wrong) retry every chance to fire

    (nA._retryQueue.size === 0) ? ok('_reconcile() queued NOTHING — the frame was confirmed in the archive')
                                : bad('_reconcile() wrongly queued ' + nA._retryQueue.size + ' frame(s)');
    (!nA._myEmitted.has(sealA.id)) ? ok('the confirmed seal was pruned from _myEmitted')
                                   : bad('the confirmed seal is still tracked in _myEmitted (leak)');
    (counting.sendCount === 1) ? ok('still exactly ONE send after the reconnect — no duplicate re-send')
                               : bad('duplicate re-send: ' + counting.sendCount + ' sends');
    const arch = await readArchive(url);
    (countIn(arch, sealA.id) === 1) ? ok('archive contains exactly one copy of the seal')
                                    : bad('archive has ' + countIn(arch, sealA.id) + ' copies');

    nA.close(); nF.close();
  } catch (e) { bad('P3 threw: ' + e.message); }
  finally { if (r3) await r3.close(); }

  console.log(failures === 0
    ? '\n  ALL PROBES PASS — announce()/pay() are covered by the retry queue\n'
    : '\n  ' + failures + ' check(s) FAILED\n');
  process.exit(failures === 0 ? 0 : 1);
})();
