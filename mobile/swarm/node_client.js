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
    this.store = opts.store || null;
    this.WS = opts.ws || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    if (!this.WS) throw new Error('No WebSocket available — pass one via opts.ws');
    this.ws = null;
    this._saveTimer = null;
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
    return new Promise((resolve) => {
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
          if (m.t === 'sync') { for (const tx of m.msgs) this.ledger.add(tx); this._react(); this._persist(); this.onChange(this); }
          else if (m.t === 'gossip') { if (this.ledger.add(m.tx)) { this._react(); this._persist(); this.onChange(this); } }
        } catch { /* a malformed frame is dropped — never crash the node over one bad message */ }
      };
      if (this.ws.on) {                                   // Node 'ws' API
        this.ws.on('open', resolve);
        this.ws.on('message', (d) => onMsg(d.toString()));
        this.ws.on('error', () => {});                    // unreachable relay must never crash the host app
      } else {                                            // browser / React Native API
        this.ws.onopen = resolve;
        this.ws.onmessage = (ev) => onMsg(ev.data);
        this.ws.onerror = () => {};
      }
    });
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
        this._persist();
      }
    }
  }

  balance(addr) { return this.ledger.fold().bal[addr || this.id.address] || 0; }
  status() {
    const f = this.ledger.fold();
    return { hash: this.ledger.hash(), members: Object.keys(f.members).length, frauds: f.frauds, balances: f.bal };
  }
  close() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null;
      if (this.store) this.store.save({ txs: this.ledger.all(), locks: [...this.locks], accepted: [...this.accepted] });
    }
    if (this.ws) this.ws.close();
  }
}

module.exports = { NodeClient };
