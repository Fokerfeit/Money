/**
 * MONEY — NODE CLIENT. The phone-side brain. Connects to the dumb relay, holds
 * its OWN key, validates EVERYTHING itself. The relay is just the wire; this is
 * where the power lives.
 *
 * Runs in Node AND React Native: no Node-only imports here.
 *   • WebSocket: pass opts.ws (Node: require('ws')); in RN the global is used.
 *   • Storage:   pass opts.store { load() -> snapshot|null, save(snapshot) }.
 *     Node: use fileStore() from file_store.js. RN: an AsyncStorage adapter.
 *     PERSISTED: the message set, my committee LOCKS (security state — a lock
 *     must survive a restart or a cheater could re-ask after a reboot), and
 *     which promises I already countersigned.
 *
 * Duties (all local, all trustless):
 *   • fold the signed-message set into balances (swarm_engine)
 *   • committee duty: vote for the FIRST promise per (account, nonce); refuse
 *     conflicting seconds — this PREVENTS double-spends
 *   • receiver duty: countersign promises to me once certified (5-of-7)
 */
const E = require('./swarm_engine');

class NodeClient {
  constructor(id, founders, url, opts = {}) {
    this.id = id;                       // { name, address, pub, sk }
    this.url = url;
    this.ledger = new E.Ledger(founders);
    this.locks = new Map();             // `${from}:${nonce}` -> phash  (committee lock)
    this.accepted = new Set();          // refs I have already countersigned
    this.onChange = opts.onChange || (() => {});
    this.onConnectionState = opts.onConnectionState || (() => {});   // Bite 2: 'connected' | 'disconnected' notifications
    this.store = opts.store || null;
    this.WS = opts.ws || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    if (!this.WS) throw new Error('No WebSocket available — pass one via opts.ws');
    this.ws = null;
    this._saveTimer = null;
    // Bite 2 (separate machines): a WAN socket can drop; localhost never did.
    // Reconnect with exponential backoff, capped — defaults match what worked
    // fine on localhost (small/instant), so behavior is unchanged unless a
    // caller (e.g. run_node.js, wired to env vars) explicitly passes larger
    // values for a real flaky link.
    this._closing = false;
    this._reconnectTimer = null;
    this._reconnectBaseMs = Number.isFinite(opts.reconnectBaseMs) ? opts.reconnectBaseMs : 200;
    this._reconnectMaxMs  = Number.isFinite(opts.reconnectMaxMs)  ? opts.reconnectMaxMs  : 10_000;
    this._reconnectDelay  = this._reconnectBaseMs;

    // Bite 2 follow-up (uplink-loss / vote-retry): a vote or accept I generate
    // is sent exactly once by _react() — if THAT single frame is lost on the
    // uplink (never reaches the relay), the relay's archive never has it, and
    // _react()'s lock/accepted gates (unchanged, see below) mean I never
    // re-generate it. Left alone, this stalls the sender's nonce forever, even
    // though everyone stays in agreement (no split-brain — just stuck).
    //
    // _myEmitted tracks every vote/accept I've ever generated, keyed by id:
    // { tx, nonce, kind }. On every 'sync' (i.e. every connect/reconnect — the
    // one moment I learn the relay's authoritative view), RECONCILE: anything
    // in _myEmitted that the synced archive confirms it received is pruned
    // (done, never checked again); anything NOT found is queued for retry.
    // This is deliberately NOT tied to acks — there are none — only to what a
    // resync reveals, matching the relay's own no-authority design.
    this._myEmitted = new Map();     // id -> { tx, nonce, kind: 'vote'|'accept' }
    this._retryQueue = new Map();    // id -> { attempts, firstQueuedAt, nextAttemptAt }
    this._retryDrainTimer = null;
    this._voteRetryMaxAttempts = Number.isFinite(opts.voteRetryMaxAttempts) ? opts.voteRetryMaxAttempts : 3;
    this._voteRetryBackoffMs   = Number.isFinite(opts.voteRetryBackoffMs)   ? opts.voteRetryBackoffMs   : 500;
    this._voteRetryAbandonMs   = Number.isFinite(opts.voteRetryAbandonMs)   ? opts.voteRetryAbandonMs   : 30_000;
    this._log = opts.log || ((...a) => console.log(...a));
  }

  // restore persisted state BEFORE touching the network
  async restore() {
    if (!this.store) return;
    const snap = await Promise.resolve(this.store.load());
    if (!snap) return;
    for (const tx of snap.txs || []) this.ledger.add(tx);
    for (const [k, v] of snap.locks || []) this.locks.set(k, v);
    for (const r of snap.accepted || []) this.accepted.add(r);
  }

  _persist() {
    if (!this.store || this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.store.save({ txs: this.ledger.all(), locks: [...this.locks], accepted: [...this.accepted] });
    }, 50);   // coalesce bursts into one write
  }

  async connect() {
    await this.restore();
    return new Promise((resolve) => { this._openSocket(resolve); });
  }

  // Opens (or re-opens, after a drop) the WebSocket. The relay ALWAYS sends a
  // full { t:'sync', msgs: archive } on every new connection (relay.js), and
  // Ledger.add() dedupes by id — so simply re-establishing the socket is the
  // entire re-sync-to-tip mechanism: already-known messages are harmless
  // no-ops, anything missed while disconnected arrives via the fresh sync.
  // `onOpenOnce` (the connect()-Promise resolver) is only ever called once,
  // on the FIRST successful open — later reconnects don't re-resolve it.
  _openSocket(onOpenOnce) {
    this.ws = new this.WS(this.url);
    const onMsg = (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      // A malicious/compromised relay is an explicit part of this design's
      // threat model (see relay.js's own header comment) — the worst it
      // should ever be able to do is drop or delay messages, never crash a
      // node. JSON.parse("null") succeeds (returns null, no exception), and
      // a bare string/number/array also parses fine; without this guard,
      // touching m.t on a non-object would throw uncaught. Everything below
      // is ALSO wrapped in try/catch as defence in depth (e.g. a 'sync'
      // frame whose msgs field isn't iterable) — one bad frame is dropped,
      // never a crash.
      if (!m || typeof m !== 'object') return;
      try {
        if (m.t === 'sync') { for (const tx of m.msgs) this.ledger.add(tx); this._react(); this._reconcile(m.msgs); this._persist(); this.onChange(this); }
        else if (m.t === 'gossip') { if (this.ledger.add(m.tx)) { this._react(); this._persist(); this.onChange(this); } }
      } catch { /* a malformed frame is dropped — never crash the node over one bad message */ }
    };
    const onOpen = () => {
      this._reconnectDelay = this._reconnectBaseMs;   // reset backoff on a successful connection
      this.onConnectionState('connected');
      if (onOpenOnce) { const r = onOpenOnce; onOpenOnce = null; r(); }
    };
    const onDrop = () => {
      if (this._closing) return;                      // a deliberate close() must never trigger a reconnect
      this.onConnectionState('disconnected');
      if (this._reconnectTimer) return;                // already scheduled (close+error can both fire)
      const delay = this._reconnectDelay;
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._reconnectMaxMs);
        this._openSocket(onOpenOnce);
      }, delay);
    };
    if (this.ws.on) {                                   // Node 'ws' API
      this.ws.on('open', onOpen);
      this.ws.on('message', (d) => onMsg(d.toString()));
      this.ws.on('close', onDrop);
      this.ws.on('error', () => {});                    // unreachable relay must never crash the host app; 'close' still fires and drives reconnect
    } else {                                            // browser / React Native API
      this.ws.onopen = onOpen;
      this.ws.onmessage = (ev) => onMsg(ev.data);
      this.ws.onclose = onDrop;
      this.ws.onerror = () => {};
    }
  }

  _send(tx) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'gossip', tx })); }

  announce(sealTx) { if (this.ledger.add(sealTx)) this._send(sealTx); this._react(); this._persist(); }

  pay(toAddr, amount, nonce, epoch) {
    const p = E.makePromise(this.id, toAddr, amount, nonce, epoch);
    this.ledger.add(p); this._send(p); this._react(); this._persist(); return p;
  }

  // The reflex: every time my view changes, do my duties.
  _react() {
    const { members, pool } = this.ledger.fold();
    for (const p of this.ledger.all().filter(t => t.type === 'promise')) {
      const ph = E.phashOf(p);

      // (1) committee duty: am I one of the sender's validators this epoch?
      //
      // KNOWN LIMITATION (documented during Brick 3's adversarial review, not
      // introduced by it — this is pre-existing behavior): locking onto the
      // FIRST promise seen at a (from,nonce) happens BEFORE any check that the
      // promise can ever actually certify (e.g. a recipient who will never
      // countersign). Since nonces are strictly sequential, one such promise —
      // which can only ever be produced with the SENDER'S OWN PRIVATE KEY, so
      // this is a self-inflicted/buggy-client hazard, not a third-party
      // griefing vector — permanently blocks every later send from that
      // account, with no fraud recorded (fraud detection needs TWO certified
      // conflicting promises; here neither ever certifies). All nodes still
      // converge on the same, merely-stuck, state — this does not affect
      // cross-node agreement or enable theft. If/when this client layer is
      // hardened for real user keys, consider validating a promise BEFORE
      // locking its nonce, or a quorum-agreed way to re-key a stuck nonce.
      if (members[this.id.address] && members[p.from]) {
        const cmte = E.committeeFor(p.from, p.epoch, pool);
        if (cmte.includes(this.id.address)) {
          const k = `${p.from}:${p.nonce}`; const locked = this.locks.get(k);
          if (locked === undefined) {
            if (E.addrOf(p.pub) === p.from && p.pub === members[p.from] &&
                E.verifyMsg(`PROMISE:${p.from}:${p.to}:${p.amount}:${p.nonce}:${p.epoch}`, p.sig, p.pub)) {
              this.locks.set(k, ph);
              const v = E.makeVote(this.id, ph);
              if (this.ledger.add(v)) this._send(v);
              this._myEmitted.set(v.id, { tx: v, nonce: p.nonce, kind: 'vote' });   // tracked for uplink-loss retry
              this._persist();
            }
          }
          // locked !== ph → conflicting second promise: I refuse to vote. Silence.
        }
      }

      // (2) receiver duty: a promise to ME, now certified → countersign.
      if (p.to === this.id.address && !this.accepted.has(ph) && this.ledger.certified(p)) {
        this.accepted.add(ph);
        const a = E.acceptPromise(this.id, p);
        if (this.ledger.add(a)) this._send(a);
        this._myEmitted.set(a.id, { tx: a, nonce: p.nonce, kind: 'accept' });   // tracked for uplink-loss retry
        this._persist();
      }
    }
  }

  // ── RECONCILIATION (runs once per sync, i.e. once per connect/reconnect) ──
  // syncedMsgs is the relay's full archive, exactly as just received. For
  // every vote/accept I've ever generated (_myEmitted) that ISN'T in it, the
  // relay never got it — queue it for retry. Anything that IS in it is
  // CONFIRMED — the only real "did it work" signal there is, since the relay
  // issues no acks — so that's where "succeeded" is logged (only when it was
  // actually missing before, i.e. we were retrying it), then pruned.
  _reconcile(syncedMsgs) {
    if (this._myEmitted.size === 0) return;
    const syncedIds = new Set(syncedMsgs.map((t) => t && t.id).filter(Boolean));
    const now = this._now();
    for (const [id, entry] of this._myEmitted) {
      if (syncedIds.has(id)) {
        if (this._retryQueue.has(id)) this._log(`[retry] ${entry.kind} for nonce ${entry.nonce} succeeded`);
        this._myEmitted.delete(id); this._retryQueue.delete(id);
        continue;
      }
      if (entry.firstMissingAt == null) entry.firstMissingAt = now;   // start the abandon clock on first-ever detection
      if (!this._retryQueue.has(id)) this._retryQueue.set(id, { attempts: 0, nextAttemptAt: now });
    }
    this._scheduleRetryDrain();
  }

  _now() { return Date.now(); }

  _scheduleRetryDrain() {
    if (this._retryDrainTimer || this._retryQueue.size === 0) return;
    this._retryDrainTimer = setTimeout(() => { this._retryDrainTimer = null; this._drainRetryQueue(); }, 50);
  }

  // Re-emits every due retry via the SAME _send() path as the original
  // vote/accept emission — no new wire format, no relay acks. There is no
  // local "success" signal (a dispatched frame can still be lost on the wire,
  // same as the original) — confirmation only ever comes from _reconcile()
  // on the NEXT sync, which is also where "succeeded" is logged. This drain
  // loop's only job is: keep re-dispatching (with backoff) until either that
  // happens, or we give up. Abandons (log only, testnet scope; "Phase 4:
  // alert" is a later concern) after voteRetryMaxAttempts attempts OR
  // voteRetryAbandonMs elapsed since first detected missing, whichever first.
  _drainRetryQueue() {
    const now = this._now();
    for (const [id, q] of this._retryQueue) {
      const entry = this._myEmitted.get(id);
      if (!entry) { this._retryQueue.delete(id); continue; }   // reconciled already this tick — nothing to do
      const { tx, nonce, kind, firstMissingAt } = entry;

      if (now - firstMissingAt >= this._voteRetryAbandonMs) {
        this._log(`[retry] ${kind} for nonce ${nonce} abandoned after ${this._voteRetryAbandonMs}ms`);
        this._retryQueue.delete(id); this._myEmitted.delete(id);
        continue;
      }
      if (now < q.nextAttemptAt) continue;   // backoff window not elapsed yet
      if (q.attempts >= this._voteRetryMaxAttempts) {
        this._log(`[retry] ${kind} for nonce ${nonce} abandoned after ${q.attempts} attempts`);
        this._retryQueue.delete(id); this._myEmitted.delete(id);
        continue;
      }
      if (!this.ws || this.ws.readyState !== 1) continue;   // not connected right now — wait for the next tick or a fresh sync

      q.attempts++;
      this._log(`[retry] ${kind} for nonce ${nonce} attempt ${q.attempts}/${this._voteRetryMaxAttempts}`);
      this._send(tx);
      q.nextAttemptAt = now + this._voteRetryBackoffMs * Math.pow(2, q.attempts - 1);   // 500, 1000, 2000, ...
    }
    if (this._retryQueue.size > 0) this._scheduleRetryDrain();
  }

  balance(addr) { return this.ledger.fold().bal[addr || this.id.address] || 0; }
  status() {
    const f = this.ledger.fold();
    return { hash: this.ledger.hash(), members: Object.keys(f.members).length, frauds: f.frauds, balances: f.bal };
  }
  close() {
    this._closing = true;   // a deliberate close must never trigger a reconnect
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._retryDrainTimer) { clearTimeout(this._retryDrainTimer); this._retryDrainTimer = null; }   // a closed node must not keep retrying in the background
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null;
      if (this.store) this.store.save({ txs: this.ledger.all(), locks: [...this.locks], accepted: [...this.accepted] });
    }
    if (this.ws) this.ws.close();
  }
}

module.exports = { NodeClient };
