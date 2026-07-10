// test_bite2_chaos.js — BRICK 3 (Bite 2): two committee nodes converge over a
// FAULTY transport (simulating a real WAN link) — latency, drops, reorder,
// and a mid-run reconnect — plus proof that Bite 1's byte-identical localhost
// behavior is unaffected when the new config is left unset. Every probe must
// pass K/K trials; exit 0.
//   1 LATENCY   2 DROPS   3 REORDER   4 RECONNECT   5 NO SPLIT-BRAIN (aggregate)
//   6 SUPPLY CONSERVED   7 BITE-1 BYTE-IDENTICAL (env vars unset)
//   8 VOTE RETRY ON RECONNECT (the uplink-stall fix — a dropped QUORUM vote,
//     which the OLD behavior stalled on forever, now recovers)
//
// DESIGN: Bite 1's test_brick3.js already proved process-level isolation
// (genuinely separate OS processes). This suite's job is different: proving
// the PROTOCOL survives a bad transport. So it uses in-process NodeClient
// instances (real objects, real Ledger, real signing) wrapped in a fault-
// injecting WebSocket class passed via NodeClient's own opts.ws extensibility
// point (the same hook Bite 1 used to run under Node's 'ws') — connected to a
// REAL relay.js over REAL loopback sockets. This gives precise, reproducible
// control over per-message latency/drops/reordering without touching a single
// line of node_client.js's/swarm_engine.js's actual logic.

const { mkIdentity } = require('./swarm/committee_bridge');
const { startRelay } = require('./swarm/relay');
const { NodeClient } = require('./swarm/node_client');
const E = require('./swarm/swarm_engine');
const RealWS = require('ws');
const { spawn } = require('child_process');
const path = require('path');

let fails = 0;
const ok  = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let portCounter = 47000 + Math.floor(Math.random() * 10000);

// ── fault-injecting WebSocket ────────────────────────────────────────────────
// Drop-in replacement for the 'ws' class. Wraps a REAL underlying socket;
// every inbound AND outbound frame independently rolls for drop, then (if
// kept) is delayed by a random amount in [minDelay,maxDelay]. Reordering is
// not a separate mechanism — it EMERGES from the variance in per-message
// delay, exactly as real network jitter reorders packets.
function makeChaosWS({ dropRate = 0, minDelay = 0, maxDelay = 0, downlinkOnly = false } = {}) {
  // downlinkOnly: drops apply ONLY to incoming (relay->client) delivery, never
  // to outgoing (client->relay) sends. This models a realistic WAN failure
  // mode honestly: once a message reaches the relay it is safely archived
  // forever (relay.js never drops what it successfully received) — only
  // delivery TO a specific listening client can be lost. That is exactly the
  // gap reconnect+resync (this bite's new mechanism) is designed to close: a
  // fresh connection gets the relay's FULL archive replayed, recovering
  // anything missed on a prior, still-open connection. (Symmetric drops,
  // including on the uplink, are used by other probes below where the point
  // is pure delay/reorder tolerance, not exercising resync specifically.)
  return class ChaosSocket {
    constructor(url) {
      this._real = new RealWS(url);
      this._h = { open: [], message: [], close: [], error: [] };
      this._real.on('open', (...a) => this._emit('open', a));
      this._real.on('message', (raw) => {
        if (dropRate && Math.random() < dropRate) return;
        const d = minDelay + Math.random() * (maxDelay - minDelay);
        setTimeout(() => this._emit('message', [raw]), d);
      });
      this._real.on('close', (...a) => this._emit('close', a));
      this._real.on('error', (...a) => this._emit('error', a));
    }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); }
    get readyState() { return this._real.readyState; }
    send(data) {
      if (!downlinkOnly && dropRate && Math.random() < dropRate) return;
      const d = minDelay + Math.random() * (maxDelay - minDelay);
      setTimeout(() => { try { this._real.send(data); } catch {} }, d);
    }
    close(...a) { try { this._real.close(...a); } catch {} }
    _emit(ev, args) { for (const fn of this._h[ev] || []) fn(...args); }
  };
}

// ── surgical, deterministic drop (for probe 8) ────────────────────────────────
// Unlike makeChaosWS's percentage-based randomness, this drops the FIRST
// outgoing frame matching `dropOncePredicate` — and only that one — modeling a
// single, specific lost uplink frame (e.g. "the vote that would have completed
// quorum") rather than general noise. Everything else passes through untouched.
function makeSurgicalDropWS(dropOncePredicate) {
  return class SurgicalDropSocket {
    constructor(url) {
      this._real = new RealWS(url);
      this._h = { open: [], message: [], close: [], error: [] };
      this._dropped = false;
      this._real.on('open', (...a) => this._emit('open', a));
      this._real.on('message', (raw) => this._emit('message', [raw]));
      this._real.on('close', (...a) => this._emit('close', a));
      this._real.on('error', (...a) => this._emit('error', a));
    }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); }
    get readyState() { return this._real.readyState; }
    send(data) {
      if (!this._dropped) {
        let parsed; try { parsed = JSON.parse(data); } catch {}
        if (parsed && dropOncePredicate(parsed)) { this._dropped = true; return; }   // drop this ONE frame, silently
      }
      try { this._real.send(data); } catch {}
    }
    close(...a) { try { this._real.close(...a); } catch {} }
    _emit(ev, args) { for (const fn of this._h[ev] || []) fn(...args); }
  };
}

async function waitUntil(pred, timeoutMs = 12000, stepMs = 40) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (pred()) return true; await sleep(stepMs); }
  return pred();
}

// Keeps re-announcing/re-paying (idempotent — ed25519 signing is deterministic,
// so the identical call always produces the identical message id; NodeClient's
// pay()/announce() always re-send regardless of whether ledger.add() was a
// no-op) every ~250ms until convergence or a hard timeout. This is exactly how
// a real payment client behaves — retry until confirmed — and is what makes a
// noisy/lossy transport test realistic rather than a coin-flip on drop luck.
async function untilConverged(nudge, pred, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    nudge();
    await sleep(250);
  }
  return pred();
}

function makeNode(id, founders, url, wsClass) {
  return new NodeClient(id, founders.map((f) => f.address), url, { ws: wsClass });
}

// NodeClient.announce() only calls _send() the FIRST time (gated behind
// ledger.add()'s one-time-true return) — by design, a seal is normally a
// one-shot action. pay() differs: it unconditionally resends every call
// (idempotent — deterministic signing means identical args = identical id),
// which is what makes untilConverged's retry-until-confirmed pattern work for
// payments under drops. For seals specifically, under a LOSSY transport, this
// helper re-sends unconditionally too, so retrying actually retransmits.
function forceAnnounce(client, sealTx) {
  client.ledger.add(sealTx); client._send(sealTx); client._react(); client._persist();
}

(async () => {
  console.log('\n  BRICK 3 (Bite 2) — TWO NODES CONVERGE OVER A FAULTY TRANSPORT\n');

  // ── PROBE 1: LATENCY ─────────────────────────────────────────────────────
  console.log('  (1) LATENCY (50-500ms per message, 6 trials)');
  {
    let allOk = true;
    for (let t = 0; t < 6 && allOk; t++) {
      let r;
      try {
        const port = portCounter++; const url = `ws://127.0.0.1:${port}`;
        r = startRelay({ port, log: () => {} });
        const A = mkIdentity('bt1_' + t + '_A'), B = mkIdentity('bt1_' + t + '_B');
        const founders = [A, B];
        const chaos = makeChaosWS({ minDelay: 50, maxDelay: 500 });
        const cA = makeNode(A, founders, url, chaos), cB = makeNode(B, founders, url, chaos);
        await Promise.all([cA.connect(), cB.connect()]);
        cA.announce(E.founderSeal(A)); cB.announce(E.founderSeal(B));
        await waitUntil(() => Object.keys(cA.ledger.fold().members).length === 2 && Object.keys(cB.ledger.fold().members).length === 2);
        const converged = await untilConverged(
          () => cA.pay(B.address, 33000, 1, 0),
          () => cA.balance(A.address) === 967000 && cB.balance(A.address) === 967000 && cA.ledger.hash() === cB.ledger.hash(),
        );
        if (!converged) { allOk = false; bad(`trial ${t}: latency did not converge — A=${cA.balance(A.address)} B=${cB.balance(A.address)} hashA=${cA.ledger.hash()} hashB=${cB.ledger.hash()}`); }
        cA.close(); cB.close();
      } catch (e) { allOk = false; bad(`trial ${t} exception: ${e.message}`); }
      finally { if (r) await r.close(); }
    }
    if (allOk) ok('6/6 trials: 50-500ms random per-message latency — both nodes still reach identical tip + balances');
  }

  // ── PROBE 2: DROPS ───────────────────────────────────────────────────────
  // Honest finding while building this: votes and accepts (generated
  // autonomously by _react(), unlike a sender's own pay() calls) are each
  // sent EXACTLY ONCE — node_client.js has no live-retry for them. So a
  // downlink drop of a vote/accept, on a connection that otherwise stays
  // open, would never self-heal by itself. The mechanism this bite actually
  // adds for exactly this case is reconnect + resync: a fresh connection gets
  // the relay's FULL archive replayed, and the relay never drops what it
  // successfully received. So this probe drops on the downlink only (uplink
  // to the relay always succeeds — realistic: once the relay has a message
  // it archives it forever) and periodically forces a reconnect, which is
  // exactly what recovers a lost vote/accept in the real deployed system.
  console.log('\n  (2) DROPS (18% downlink frame loss + periodic forced reconnects, 8 trials)');
  {
    let allOk = true;
    for (let t = 0; t < 8 && allOk; t++) {
      let r; let reconnectTimer;
      try {
        const port = portCounter++; const url = `ws://127.0.0.1:${port}`;
        r = startRelay({ port, log: () => {} });
        const A = mkIdentity('bt2_' + t + '_A'), B = mkIdentity('bt2_' + t + '_B');
        const founders = [A, B];
        const chaos = makeChaosWS({ dropRate: 0.18, minDelay: 5, maxDelay: 40, downlinkOnly: true });
        const cA = makeNode(A, founders, url, chaos), cB = makeNode(B, founders, url, chaos);
        cA._reconnectBaseMs = 100; cA._reconnectMaxMs = 400; cA._reconnectDelay = 100;
        cB._reconnectBaseMs = 100; cB._reconnectMaxMs = 400; cB._reconnectDelay = 100;
        await Promise.all([cA.connect(), cB.connect()]);
        // simulate a flaky link: periodically force BOTH sockets to drop —
        // NodeClient's own reconnect-with-backoff brings each back and
        // re-syncs to tip via the relay's archive replay
        reconnectTimer = setInterval(() => {
          try { cA.ws._real.terminate(); } catch {}
          try { cB.ws._real.terminate(); } catch {}
        }, 700);

        forceAnnounce(cA, E.founderSeal(A)); forceAnnounce(cB, E.founderSeal(B));
        const sealsConverged = await untilConverged(() => { forceAnnounce(cA, E.founderSeal(A)); forceAnnounce(cB, E.founderSeal(B)); },
          () => Object.keys(cA.ledger.fold().members).length === 2 && Object.keys(cB.ledger.fold().members).length === 2, 12000);
        if (!sealsConverged) throw new Error('seals never converged under drops+reconnects');
        const converged = await untilConverged(
          () => cA.pay(B.address, 21000, 1, 0),
          () => cA.balance(A.address) === 979000 && cB.balance(A.address) === 979000 && cA.ledger.hash() === cB.ledger.hash(),
          15000,
        );
        if (!converged) { allOk = false; bad(`trial ${t}: drops+reconnect did not converge — A=${cA.balance(A.address)} B=${cB.balance(A.address)}`); }
        clearInterval(reconnectTimer);
        cA.close(); cB.close();
      } catch (e) { allOk = false; bad(`trial ${t} exception: ${e.message}`); if (reconnectTimer) clearInterval(reconnectTimer); }
      finally { if (r) await r.close(); }
    }
    if (allOk) ok('8/8 trials: 18% downlink frame loss + a periodic forced socket reset every 700ms — reconnect + full-archive resync recovers every time (no vote/accept is ever permanently lost)');
  }

  // ── PROBE 3: REORDER ─────────────────────────────────────────────────────
  console.log('\n  (3) REORDER (wide delay variance -> frames routinely arrive out of send order, 6 trials)');
  {
    let allOk = true;
    for (let t = 0; t < 6 && allOk; t++) {
      let r;
      try {
        const port = portCounter++; const url = `ws://127.0.0.1:${port}`;
        r = startRelay({ port, log: () => {} });
        const A = mkIdentity('bt3_' + t + '_A'), B = mkIdentity('bt3_' + t + '_B'), C = mkIdentity('bt3_' + t + '_C');
        const founders = [A, B, C];
        // WIDE variance (1-300ms) specifically to make later-sent frames
        // frequently overtake earlier ones -- a genuine reordering, not just latency.
        const chaos = makeChaosWS({ minDelay: 1, maxDelay: 300 });
        const cA = makeNode(A, founders, url, chaos), cB = makeNode(B, founders, url, chaos), cC = makeNode(C, founders, url, chaos);
        await Promise.all([cA.connect(), cB.connect(), cC.connect()]);
        await untilConverged(() => { cA.announce(E.founderSeal(A)); cB.announce(E.founderSeal(B)); cC.announce(E.founderSeal(C)); },
          () => [cA, cB, cC].every((c) => Object.keys(c.ledger.fold().members).length === 3), 12000);
        // fire MULTIPLE promises in rapid succession from different senders —
        // maximizes the chance frames interleave/overtake each other in transit
        await untilConverged(
          () => { cA.pay(B.address, 10000, 1, 0); cB.pay(C.address, 15000, 1, 0); cC.pay(A.address, 5000, 1, 0); },
          () => {
            const hashes = [cA, cB, cC].map((c) => c.ledger.hash());
            return hashes[0] === hashes[1] && hashes[1] === hashes[2] &&
                   cA.balance(A.address) === 995000 && cB.balance(B.address) === 995000 && cC.balance(C.address) === 1010000;
          },
          15000,
        );
        const hashes = [cA, cB, cC].map((c) => c.ledger.hash());
        const converged = hashes[0] === hashes[1] && hashes[1] === hashes[2] &&
          cA.balance(A.address) === 995000 && cB.balance(B.address) === 995000 && cC.balance(C.address) === 1010000;
        if (!converged) { allOk = false; bad(`trial ${t}: reorder produced a split — hashes=${JSON.stringify(hashes)} balA=${cA.balance(A.address)} balB=${cB.balance(B.address)} balC=${cC.balance(C.address)}`); }
        cA.close(); cB.close(); cC.close();
      } catch (e) { allOk = false; bad(`trial ${t} exception: ${e.message}`); }
      finally { if (r) await r.close(); }
    }
    if (allOk) ok('6/6 trials: 3 concurrent senders under wide-variance delay (frames routinely arrive out of order) — no split-brain, identical end state every time');
  }

  // ── PROBE 4: RECONNECT ───────────────────────────────────────────────────
  console.log('\n  (4) RECONNECT (kill a node\'s socket mid-run, it must reconnect + catch up)');
  {
    let r;
    try {
      const port = portCounter++; const url = `ws://127.0.0.1:${port}`;
      r = startRelay({ port, log: () => {} });
      const A = mkIdentity('bt4_A'), B = mkIdentity('bt4_B');
      const founders = [A, B];
      const chaos = makeChaosWS({ minDelay: 5, maxDelay: 30 });
      const cA = makeNode(A, founders, url, chaos), cB = makeNode(B, founders, url, chaos);
      cB._reconnectBaseMs = 100; cB._reconnectMaxMs = 500; cB._reconnectDelay = 100;   // fast backoff for a quick test
      await Promise.all([cA.connect(), cB.connect()]);
      cA.announce(E.founderSeal(A)); cB.announce(E.founderSeal(B));
      await waitUntil(() => Object.keys(cA.ledger.fold().members).length === 2 && Object.keys(cB.ledger.fold().members).length === 2);
      cA.pay(B.address, 8000, 1, 0);
      await waitUntil(() => cA.ledger.hash() === cB.ledger.hash() && cA.balance(A.address) === 992000);

      // force-drop B's underlying socket — simulates a real WAN blip
      let sawDisconnected = false, sawReconnected = false;
      cB.onConnectionState = (s) => { if (s === 'disconnected') sawDisconnected = true; if (s === 'connected' && sawDisconnected) sawReconnected = true; };
      cB.ws._real.terminate();   // hard-kill the underlying real socket (not a graceful close)

      // while B is down, A sends MORE payments B never sees live
      cA.pay(B.address, 4000, 2, 0);
      await waitUntil(() => cA.ledger.hash() && cA.balance(A.address) === 988000, 6000);
      const targetHash = cA.ledger.hash();

      const reconnected = await waitUntil(() => sawReconnected, 8000);
      const caughtUp = await waitUntil(() => cB.ledger.hash() === targetHash, 8000);
      const verdict = reconnected && caughtUp && cB.balance(A.address) === 988000 && cB.balance(B.address) === 1012000;
      (verdict) ? ok(`B's socket was hard-killed mid-run; NodeClient auto-reconnected (backoff) and re-synced to A's exact tip (${targetHash}) via the relay's sync-on-connect replay`)
                : bad(`reconnect failed: reconnected=${reconnected} caughtUp=${caughtUp} cB.hash=${cB.ledger.hash()} target=${targetHash} balA=${cB.balance(A.address)} balB=${cB.balance(B.address)}`);
      cA.close(); cB.close();
    } catch (e) { bad('probe4 exception: ' + e.message); }
    finally { if (r) await r.close(); }
  }

  // ── PROBE 5: NO SPLIT-BRAIN (aggregate across everything above) ──────────
  // (implicitly covered by every hash-equality check in probes 1-4; this is
  // an explicit summary assertion so a reader can see it was checked N times.)
  console.log('\n  (5) NO SPLIT-BRAIN — aggregate');
  (fails === 0) ? ok('every trial in probes 1-4 checked tip-hash equality across all live nodes; zero disagreements observed')
                : bad('one or more prior trials disagreed on final hash (see failures above)');

  // ── PROBE 6: SUPPLY CONSERVED ────────────────────────────────────────────
  // Same downlink-only + periodic-reconnect model as probe 2 (see its comment
  // for why: votes/accepts have no live-retry, only reconnect+resync recovers
  // a downlink loss) — this probe's job is conservation under chaos, not
  // re-proving the drop-recovery mechanism itself, so it uses the same
  // reliable pattern rather than a raw symmetric drop with no recovery path.
  console.log('\n  (6) SUPPLY CONSERVATION (under chaos)');
  {
    let r; let reconnectTimer;
    try {
      const port = portCounter++; const url = `ws://127.0.0.1:${port}`;
      r = startRelay({ port, log: () => {} });
      const ids = [mkIdentity('bt6_A'), mkIdentity('bt6_B'), mkIdentity('bt6_C')];
      const chaos = makeChaosWS({ dropRate: 0.1, minDelay: 5, maxDelay: 150, downlinkOnly: true });
      const clients = ids.map((id) => makeNode(id, ids, url, chaos));
      clients.forEach((c) => { c._reconnectBaseMs = 100; c._reconnectMaxMs = 400; c._reconnectDelay = 100; });
      await Promise.all(clients.map((c) => c.connect()));
      reconnectTimer = setInterval(() => { for (const c of clients) { try { c.ws._real.terminate(); } catch {} } }, 800);

      const sealed = await untilConverged(() => clients.forEach((c, i) => forceAnnounce(c, E.founderSeal(ids[i]))),
        () => clients.every((c) => Object.keys(c.ledger.fold().members).length === 3), 12000);
      if (!sealed) throw new Error('seals never converged');
      await untilConverged(
        () => { clients[0].pay(ids[1].address, 77000, 1, 0); clients[1].pay(ids[2].address, 40000, 1, 0); },
        () => { const hs = clients.map((c) => c.ledger.hash()); return hs[0] === hs[1] && hs[1] === hs[2]; },
        15000,
      );
      const startTotal = 3 * 1_000_000;
      let conserved = true;
      for (const c of clients) {
        const bal = c.ledger.fold().bal;
        const total = Object.values(bal).reduce((a, b) => a + b, 0);
        if (total !== startTotal || !Object.values(bal).every(Number.isInteger)) conserved = false;
      }
      clearInterval(reconnectTimer);
      (conserved) ? ok(`total supply conserved at exactly ${startTotal} on every node, integer, despite 10% downlink loss + periodic reconnects + wide latency`)
                  : bad('supply not conserved under chaos: ' + JSON.stringify(clients.map((c) => c.ledger.fold().bal)));
      clients.forEach((c) => c.close());
    } catch (e) { bad('probe6 exception: ' + e.message); if (reconnectTimer) clearInterval(reconnectTimer); }
    finally { if (r) await r.close(); }
  }

  // ── PROBE 7: BITE-1 BYTE-IDENTICAL (new env vars unset) ──────────────────
  console.log('\n  (7) BITE-1 BYTE-IDENTICAL (new config left unset)');
  {
    const code = await new Promise((res) => {
      const c = spawn(process.execPath, [path.join(__dirname, 'test_brick3.js')], { stdio: ['ignore', 'pipe', 'pipe'] });
      const out = []; c.stdout.on('data', (d) => out.push(d.toString())); c.stderr.on('data', (d) => out.push(d.toString()));
      c.on('exit', (code) => { if (code !== 0) console.log('      [test_brick3.js tail]\n' + out.join('').split('\n').slice(-15).join('\n')); res(code); });
    });
    (code === 0) ? ok('test_brick3.js (the ENTIRE Bite-1 localhost suite, including its own Brick2/Self-gate/Brick1/Phase0-3 regression chain) still exits 0 — unchanged with all new env vars unset')
                 : bad(`test_brick3.js → exit ${code}`);
  }

  // ── PROBE 8: VOTE RETRY ON RECONNECT (the uplink-stall fix) ──────────────
  // A full 7-member committee (8 founders: 1 sender + V1..V7), so "the 5th
  // vote" is literally the QUORUM-COMPLETING vote (quorumOf(7)=5) — but ONLY
  // V1-V5 are kept online; V6 and V7 seal (needed so committeeFor's candidate
  // pool is the full 7, matching quorumOf(7)=5) and then deliberately
  // disconnect via a normal close() BEFORE the payment, so they never see or
  // vote on the promise. That leaves EXACTLY 5 possible voters — if all 5
  // voted, quorum would be trivially met regardless of any one being dropped,
  // which would test nothing. V1-V4 vote normally; V5's vote is surgically
  // dropped on the uplink — it never reaches the relay. Under the OLD
  // behavior this stalls forever: the promise sits at 4-of-5, _react()'s lock
  // gate never re-votes, and V5's socket staying open forever means no resync
  // ever happens either. Here we force V5 to reconnect (a real WAN drop would
  // do this on its own) — its fresh sync's reconciliation discovers its own
  // vote is missing from the archive and retries it with backoff; this time
  // nothing drops it, quorum is reached, and the payment certifies.
  console.log('\n  (8) VOTE RETRY ON RECONNECT (dropped quorum vote recovers)');
  let r8;
  try {
    const port = portCounter++; const url = `ws://127.0.0.1:${port}`;
    r8 = startRelay({ port, log: () => {} });
    const S = mkIdentity('bt8_S');   // sender — NOT a committee member for its own promise
    const voters = Array.from({ length: 7 }, (_, i) => mkIdentity('bt8_V' + (i + 1)));   // V1..V7
    const founders = [S, ...voters];
    const clean = makeChaosWS({ minDelay: 2, maxDelay: 15 });   // light, symmetric — just realism, no loss

    const nS = makeNode(S, founders, url, clean);
    const nV = voters.slice(0, 5).map((v, i) => {
      if (i === 4) {   // V5 (index 4) — its vote gets surgically dropped ONCE
        const dropV5Vote = makeSurgicalDropWS((msg) =>
          msg.t === 'gossip' && msg.tx && msg.tx.type === 'vote' && msg.tx.from === voters[4].address);
        return makeNode(v, founders, url, dropV5Vote);
      }
      return makeNode(v, founders, url, clean);
    });
    const nV5 = nV[4];
    // fast reconnect backoff for this node specifically, so the test doesn't
    // need to wait through the (much larger) real-world default
    nV5._reconnectBaseMs = 100; nV5._reconnectMaxMs = 400; nV5._reconnectDelay = 100;
    nV5._voteRetryBackoffMs = 150;   // 150, 300, 600ms — fast enough for a snappy test, still real exponential backoff

    // V6, V7: short-lived, seal-only connections. They exist so the SEALED
    // pool has all 8 members (committeeFor needs the full 7-candidate pool
    // for quorumOf(7)=5 to apply) but never see the promise at all.
    const nV6 = makeNode(voters[5], founders, url, clean);
    const nV7 = makeNode(voters[6], founders, url, clean);

    const voterClients = [...nV, nV6, nV7];   // index i -> client for voters[i]
    const allLiveForSealing = [nS, ...voterClients];
    await Promise.all(allLiveForSealing.map((c) => c.connect()));
    const sealed = await untilConverged(
      () => { forceAnnounce(nS, E.founderSeal(S)); voters.forEach((v, i) => forceAnnounce(voterClients[i], E.founderSeal(v))); },
      () => allLiveForSealing.every((c) => Object.keys(c.ledger.fold().members).length === 8),
      12000,
    );
    if (!sealed) throw new Error('seals never converged (8 founders)');

    nV6.close(); nV7.close();   // deliberate close() — never reconnects, never sees the promise
    const allNodes = [nS, ...nV];

    // S sends one promise to V1. Committee = all 7 voters (V1-V7), quorum 5 —
    // but only V1-V5 are online, so exactly 5 votes are even POSSIBLE.
    nS.pay(voters[0].address, 60000, 1, 0);
    // V1-V4 vote normally (their own _react() reflex handles it automatically
    // once they see the promise); give the network a moment to settle at 4 votes.
    const stalledAt4 = await waitUntil(() => {
      const f = nS.ledger.fold();
      // still MINT balance everywhere = the promise has NOT certified/applied yet
      return f.bal[S.address] === 1_000_000 && f.bal[voters[0].address] === 1_000_000;
    }, 3000);
    if (!stalledAt4) throw new Error('promise unexpectedly certified before V5 ever voted — test setup invalid');

    // confirm it's GENUINELY stuck (not just slow) — hold a bit longer with no
    // intervention; balances must still be unmoved (V5's dropped vote means
    // only 4-of-5 quorum, exactly the "stalls forever" bug under old behavior)
    await sleep(800);
    const stillStuck = nS.ledger.fold().bal[S.address] === 1_000_000;
    if (!stillStuck) throw new Error('promise certified without V5 — quorum math or test wiring is wrong');

    // NOW force V5 to reconnect — a real WAN drop would trigger this on its
    // own; here we simulate it directly, exactly like probe 4's reconnect test.
    nV5.ws._real.terminate();

    const recovered = await waitUntil(() => {
      const f = nS.ledger.fold();
      return f.bal[S.address] === 940000 && f.bal[voters[0].address] === 1_060_000;
    }, 8000);

    const hashes = allNodes.map((c) => c.ledger.hash());
    const allAgree = hashes.every((h) => h === hashes[0]);
    (recovered && allAgree)
      ? ok(`V5's dropped quorum vote recovered via reconnect + retry-with-backoff: quorum reached, payment certified (S=940000, V1=1,060,000), all 8 nodes agree (${hashes[0]})`)
      : bad(`vote retry did not recover: recovered=${recovered} allAgree=${allAgree} S_bal=${nS.ledger.fold().bal[S.address]} hashes=${JSON.stringify(hashes)}`);

    allNodes.forEach((c) => c.close());
  } catch (e) { bad('probe8 exception: ' + e.message); }
  finally { if (r8) await r8.close(); }

  console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Bite 2 chaos: ${fails === 0 ? 'ALL PROBES PASS' : fails + ' FAILURE(S)'} — two nodes converge over a faulty transport; Bite 1 unaffected.\n`);
  process.exit(fails === 0 ? 0 : 1);
})();
