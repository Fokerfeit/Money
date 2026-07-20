// mobile/swarm/run_node.js — CLI wrapper around NodeClient (node_client.js), so a
// committee node can run as its OWN OS process and be driven over stdio. This is
// the multi-process harness for BRICK 3: proving two (or more) committee nodes,
// each a genuinely separate process with no shared JS state, converge to the same
// ledger purely by talking to a relay over a real WebSocket.
//
// ADDITIVE: does not modify node_client.js, swarm_engine.js, relay.js, or
// committee_bridge.js — it only requires them (identity_store.js, added for
// persisted identity below, is likewise a pure wrapper — see its own header).
//
// Identity: two modes, selected by whether NODE_LABEL is set.
//   • NODE_LABEL set (every existing test harness) — deterministic identity via
//     committee_bridge.mkIdentity(label) (same seeded-keypair scheme already
//     adversarially reviewed in Brick 2), so a test can precompute a node's
//     address from its label. No file I/O. Unchanged from before this bite.
//   • NODE_LABEL unset (the real "download and run" path) — a REAL, persisted
//     identity loaded from (or generated once and saved to) IDENTITY_FILE, so
//     restarting the process gets back the SAME address/balance instead of a
//     fresh random one. See identity_store.js + NODE_RUN.md.
//
// SELF-SERVE JOIN (this bite): a freshly-DOWNLOADED node needs zero hand-set env
// vars to make sense of the network. Two additive pieces, no protocol change:
//   • GENESIS FILE — the founder set (genesis config) + default relay URL travel
//     WITH the download as genesis.json (beside this script), instead of every
//     node needing an identical FOUNDERS_JSON env var hand-copied in. This is the
//     genesis every node must already agree on; shipping it in the folder — NOT
//     serving it from the relay — means a compromised relay still can't inject a
//     fake founder set (the relay's no-authority threat model is preserved). The
//     founder set is a FILE the node reads and logs at boot; it is never mutated
//     by a remote message.
//   • INVITE / REDEEM ops — a newcomer becomes a spending MEMBER via the
//     seal/invite mechanism in swarm_engine.js (makeInvite + seal), reachable over
//     stdio. NOTE (honest correction to a common misreading): membership is
//     INVITE-certified, not committee-quorum-certified — quorum in swarm_engine
//     only gates spends/channels, never member admission. An existing member
//     issues a quota-limited (≤5) invite with their own key, BOUND to the
//     newcomer's address ({op:'invite', for:'M_...'}); the newcomer redeems it by
//     self-sealing with THEIR key and gossiping that seal. Since the bound-invites
//     protocol change (see swarm_engine's makeInvite comment), only the named
//     address can redeem — a leaked invite is useless to a thief, and a spent
//     invite cannot be contested by a rival seal.
//
// Protocol (JSON Lines):
//   stdin  — one command object per line:
//     {op:'seal_founder'}                              — announce this identity as a founder
//     {op:'invite', for:'M_...', inviteId?}             — (member only) issue a signed, quota-limited
//                                                          invite BOUND to the named redeemer address;
//                                                          emitted to stdout for out-of-band delivery.
//                                                          'for' is REQUIRED — ask the friend for the
//                                                          address on their node's 'ready' line first
//     {op:'redeem', invite:{inviterAddr,inviteId,inviterSig}}  — (newcomer) self-seal with the invite
//                                                          and gossip the seal → become a member
//     {op:'pay', to, amount, nonce, epoch}              — submit a signed promise
//     {op:'status'}                                     — request an immediate status line
//     {op:'close'}                                       — disconnect and exit
//   stdout — one event object per line:
//     {type:'ready', address, pub}                      — connected to the relay
//     {type:'invite', invite:{...}}                      — a freshly issued invite (deliver out of band)
//     {type:'redeem-sent', inviteId}                     — the self-seal was ANNOUNCED (not yet proof of
//                                                          membership — the invite could still be bad)
//     {type:'redeemed', inviteId}                        — CONFIRMED: our address now appears in the
//                                                          folded member set (the honest ack)
//     {type:'redeem-failed', inviteId, hint}             — membership never appeared within
//                                                          REDEEM_TIMEOUT_MS (invite invalid/used/quota,
//                                                          or network unreachable)
//     {type:'warning', code:'possible-fork', ...}        — observation only: the relay archive carries a
//                                                          founder seal NOT in this node's genesis founder
//                                                          set → likely wrong/stale genesis.json or a fork
//     {type:'error', op, reason}                         — a stdin op was malformed/rejected (no crash)
//     {type:'status', address, hash, members, frauds, balances}  — emitted on every
//       ledger change (autonomous) AND in response to {op:'status'}
//     {type:'connection', address, state}                — Bite 2: 'connected' |
//       'disconnected', emitted on every relay socket transition (including
//       automatic reconnects after a WAN drop)
//
// Bite 2 (separate machines) env vars, ALL optional — unset = unchanged
// Bite-1 behavior:
//   RECONNECT_BASE_MS, RECONNECT_MAX_MS   — reconnect backoff tuning (node_client.js)
//   VOTE_RETRY_MAX_ATTEMPTS, VOTE_RETRY_BACKOFF_MS, VOTE_RETRY_ABANDON_MS —
//     uplink-loss vote/accept retry tuning (node_client.js; the "Bite 2
//     follow-up" fix for a lost quorum vote stalling a nonce forever)
//   IDENTITY_FILE — persisted-identity path, only consulted when NODE_LABEL is
//     unset (default: identity.json next to this script). THIS FILE IS THE
//     WALLET — see NODE_RUN.md.
//   REDEEM_TIMEOUT_MS — how long a pending redeem waits for confirmed membership
//     before emitting redeem-failed (default 30000).
'use strict';

const WS = require('ws');
const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');
const path = require('path');
const { NodeClient } = require('./node_client');
const { founderSeal, makeInvite, seal } = require('./swarm_engine');
const { mkIdentity } = require('./committee_bridge');
const identityStore = require('./identity_store');
// (safe_store.js is still part of this node's dependency closure — identity_store
// requires it — but run_node itself no longer does: genesis is a plain direct
// read on purpose, see the GENESIS comment below.)

const NODE_LABEL   = process.env.NODE_LABEL;
const STORE_FILE   = process.env.STORE_FILE || null;                  // optional — persistence across restarts

// ── GENESIS (self-serve join): founder set + default relay travel WITH the download ──
// GENESIS_FILE (default: genesis.json beside this script) carries { founders:[...],
// relay:"wss://..." } so a freshly-downloaded node needs NO hand-set env var.
//
// Read as a PLAIN fail-closed direct read — deliberately NOT safe_store.loadStrict.
// loadStrict exists for stores this process WRITES (it falls back to a .bak copy on
// corruption). Genesis is READ-ONLY for run_node — this process never writes it, so
// no legitimate genesis.json.bak can exist here, and honoring one would let a
// planted .bak file silently substitute a different founder set (audit finding on
// 413d73a). Missing file = no genesis (env fallback); present-but-unreadable or
// present-but-invalid = hard exit. Absent genesis → env fallback keeps every
// existing test harness byte-for-byte unchanged.
//
// SEMANTIC validation (not just structure): a genesis that parses fine but carries
// an empty founder list, or entries that aren't real M_ addresses, would make the
// node quietly fail to validate the whole network (members forever 0) — that is a
// misconfiguration, not a network state, so it fails CLOSED at boot. Address shape
// derives from swarm_engine.addrOf: 'M_' + first 32 hex chars of the pubkey,
// uppercased → /^M_[0-9A-F]{32}$/.
const GENESIS_FILE = process.env.GENESIS_FILE || path.join(__dirname, 'genesis.json');
const ADDR_RE = /^M_[0-9A-F]{32}$/;
let genesis = null;
if (fs.existsSync(GENESIS_FILE)) {
  try {
    const g = JSON.parse(fs.readFileSync(GENESIS_FILE, 'utf8'));   // direct read: no .bak fallback (see above)
    if (!g || typeof g !== 'object' || Array.isArray(g) || !Array.isArray(g.founders)) {
      throw new Error('genesis must be a JSON object with a "founders" array (and optional "relay" string)');
    }
    if (g.founders.length === 0) {
      throw new Error('genesis "founders" array is EMPTY — a node with no founders can never validate anything; fill in the sealed testnet founder addresses');
    }
    for (const f of g.founders) {
      if (typeof f !== 'string' || !ADDR_RE.test(f)) {
        throw new Error(`genesis founder entry ${JSON.stringify(f)} is not a valid M_ address (expected M_ + 32 uppercase hex chars)`);
      }
    }
    if (g.relay !== undefined && typeof g.relay !== 'string') {
      throw new Error('genesis "relay" must be a string when present');
    }
    genesis = g;
  } catch (e) {
    process.stderr.write(`[run_node] genesis file "${GENESIS_FILE}" is present but invalid — refusing to start (fail-closed): ${e.message}\n`);
    process.exit(1);
  }
}

// Precedence: an explicit env var ALWAYS wins (keeps every existing test unchanged),
// otherwise fall back to genesis (the "download and run" path).
const FOUNDERS   = process.env.FOUNDERS_JSON !== undefined
  ? JSON.parse(process.env.FOUNDERS_JSON || '[]')
  : (genesis ? genesis.founders : []);
const RELAY_URL  = process.env.RELAY_URL || (genesis && genesis.relay) || undefined;
// Persisted node identity ("download and run"): when NODE_LABEL is unset, the node's
// keypair is loaded from — or, on first boot, generated and saved to — IDENTITY_FILE
// (default: identity.json next to this script), so restarting the process reuses the
// SAME M_ address and balance instead of minting a fresh random one every run. This is
// additive: any caller that DOES pass NODE_LABEL (every existing test harness) is
// completely unaffected — it keeps getting committee_bridge's deterministic
// mkIdentity(label), with no file I/O at all, exactly as before.
const IDENTITY_FILE = process.env.IDENTITY_FILE || path.join(__dirname, 'identity.json');
// Bite 2 (separate machines): optional reconnect-backoff tuning for a real WAN
// link. Unset by default -> NodeClient's own defaults apply (unchanged from
// what already worked on localhost).
const RECONNECT_BASE_MS = process.env.RECONNECT_BASE_MS ? Number(process.env.RECONNECT_BASE_MS) : undefined;
const RECONNECT_MAX_MS  = process.env.RECONNECT_MAX_MS  ? Number(process.env.RECONNECT_MAX_MS)  : undefined;
// Bite 2 follow-up: optional vote/accept uplink-retry tuning. Unset -> NodeClient's
// own defaults (3 attempts, 500ms backoff base, 30s abandon).
const VOTE_RETRY_MAX_ATTEMPTS = process.env.VOTE_RETRY_MAX_ATTEMPTS ? Number(process.env.VOTE_RETRY_MAX_ATTEMPTS) : undefined;
const VOTE_RETRY_BACKOFF_MS   = process.env.VOTE_RETRY_BACKOFF_MS   ? Number(process.env.VOTE_RETRY_BACKOFF_MS)   : undefined;
const VOTE_RETRY_ABANDON_MS   = process.env.VOTE_RETRY_ABANDON_MS   ? Number(process.env.VOTE_RETRY_ABANDON_MS)   : undefined;
// Honest redeem ack (audit fix on 413d73a): a redeem is only "redeemed" once our
// address actually appears in the folded member set; until then it's "redeem-sent",
// and after this window with no membership it's "redeem-failed".
const REDEEM_TIMEOUT_MS = process.env.REDEEM_TIMEOUT_MS ? Number(process.env.REDEEM_TIMEOUT_MS) : 30_000;

if (!RELAY_URL) {
  process.stderr.write('run_node.js needs a relay URL — set RELAY_URL, or ship a genesis.json with a "relay" field\n');
  process.exit(1);
}
// Explicit + logged: the founder set the node is trusting as genesis, and where it
// came from. Never silently mutated at runtime by any remote message.
process.stderr.write(`[run_node] genesis: ${FOUNDERS.length} founder(s) from ${
  process.env.FOUNDERS_JSON !== undefined ? 'FOUNDERS_JSON env' : (genesis ? GENESIS_FILE : 'no source (empty)')
}; relay ${RELAY_URL}\n`);

// NODE_LABEL set (every existing test harness): unchanged deterministic identity,
// no file I/O — a test can still precompute a node's address from its label.
// NODE_LABEL unset (the real "download and run" path): load-or-create a REAL,
// persisted identity from IDENTITY_FILE. A corrupted/invalid identity file is a
// hard error (see identity_store.js) — it never silently falls back to a fresh
// identity, which would orphan whatever balance the real one held.
let id;
if (NODE_LABEL) {
  id = mkIdentity(NODE_LABEL);
} else {
  try {
    id = identityStore.loadOrCreate(IDENTITY_FILE, 'node');
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}

const store = STORE_FILE ? {
  load: () => { try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch { return null; } },
  save: (snap) => { try { fs.writeFileSync(STORE_FILE, JSON.stringify(snap)); } catch {} },
} : null;

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

// ── FORK VISIBILITY (observation + logging ONLY — no wire messages, no consensus
// change; audit fix on 413d73a). The ledger stores every gossiped message,
// including founder seals for addresses OUTSIDE our genesis founder set (fold()
// simply ignores them). Such a seal is the loudest available signal that this
// node's genesis disagrees with what the network is actually running — a stale or
// wrong genesis.json, or a genuine fork. We warn ONCE per unknown founder address.
// The scan is incremental (each ledger entry inspected exactly once), so it adds
// O(new messages) per status emit, not O(history).
const _warnedUnknownFounders = new Set();
let _forkScanIdx = 0;
function scanForForeignFounderSeals() {
  const all = client.ledger.all();   // Map insertion order — stable, append-only
  for (; _forkScanIdx < all.length; _forkScanIdx++) {
    const tx = all[_forkScanIdx];
    if (!tx || tx.type !== 'seal' || !tx.founder) continue;
    if (client.ledger.founders.has(tx.from) || _warnedUnknownFounders.has(tx.from)) continue;
    _warnedUnknownFounders.add(tx.from);
    emit({
      type: 'warning', code: 'possible-fork', unknownFounder: tx.from,
      reason: 'the relay archive contains a founder seal that is NOT in this node\'s genesis founder set — this node may have a stale/wrong genesis.json, or the network has forked',
    });
    process.stderr.write(`[run_node] ⚠️ POSSIBLE FORK: founder seal from ${tx.from} is not in this node's genesis founder set (${[...client.ledger.founders].join(', ') || 'empty'}) — check genesis.json\n`);
  }
}

// ── HONEST REDEEM ACK: pending-redeem watcher ────────────────────────────────
// 'redeemed' is only emitted when our address actually appears in fold().members.
// Checked on every ledger change (emitStatus) AND on a small poll while pending —
// the poll matters because announce() doesn't fire onChange for our OWN messages,
// so a lone node's membership flip would otherwise go unobserved until the next
// incoming frame.
let pendingRedeem = null;   // { inviteId, deadline, poll }
function checkPendingRedeem() {
  if (!pendingRedeem) return;
  const p = pendingRedeem;
  if (client.ledger.fold().members[id.address]) {
    clearInterval(p.poll); pendingRedeem = null;
    emit({ type: 'redeemed', inviteId: p.inviteId });
    process.stderr.write(`[run_node] redeem ${p.inviteId} CONFIRMED — this node is now a member\n`);
    emitStatus();
  } else if (Date.now() >= p.deadline) {
    clearInterval(p.poll); pendingRedeem = null;
    emit({ type: 'redeem-failed', inviteId: p.inviteId, hint: 'invite may be invalid, already used, or network unreachable' });
    process.stderr.write(`[run_node] redeem ${p.inviteId} FAILED — no membership after ${REDEEM_TIMEOUT_MS}ms (invite invalid/used/quota, or network unreachable)\n`);
  }
}

const emitStatus = () => {
  const st = client.status();
  emit({ type: 'status', address: id.address, hash: st.hash, members: st.members, frauds: st.frauds, balances: st.balances });
  scanForForeignFounderSeals();
  checkPendingRedeem();
};

const client = new NodeClient(id, FOUNDERS, RELAY_URL, {
  ws: WS, store, onChange: emitStatus,
  reconnectBaseMs: RECONNECT_BASE_MS, reconnectMaxMs: RECONNECT_MAX_MS,
  voteRetryMaxAttempts: VOTE_RETRY_MAX_ATTEMPTS, voteRetryBackoffMs: VOTE_RETRY_BACKOFF_MS, voteRetryAbandonMs: VOTE_RETRY_ABANDON_MS,
  onConnectionState: (state) => emit({ type: 'connection', address: id.address, state }),
  log: (msg) => process.stderr.write(msg + '\n'),
});

client.connect().then(() => {
  emit({ type: 'ready', address: id.address, pub: id.pub });
  emitStatus();
});

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let cmd; try { cmd = JSON.parse(line); } catch { return; }
  if (!cmd || typeof cmd.op !== 'string') return;
  switch (cmd.op) {
    case 'seal_founder': client.announce(founderSeal(id)); break;
    case 'pay':          client.pay(cmd.to, cmd.amount, cmd.nonce, cmd.epoch); break;
    case 'status':       emitStatus(); break;
    case 'close':        client.close(); process.exit(0); break;

    // ── SELF-SERVE JOIN ──────────────────────────────────────────────────────
    // Issue an invite (member only), BOUND to one named redeemer address (protocol
    // change closing the contestability + interception holes — see swarm_engine's
    // makeInvite comment). The inviter's signature covers the target, so only that
    // address can ever produce a verifying seal: a stolen or leaked invite is
    // unredeemable by anyone else, and a rival seal for a spent invite is dead on
    // arrival regardless of hash order. Still deliver it out of band (it's useless
    // to others now, but it's also nobody else's business).
    //
    // ⚠️ QUOTA HONESTY (audit note on 413d73a): the ≤5 quota is per-ADDRESS rate
    // limiting, NOT per-human Sybil resistance. Each invited member gets its own
    // quota of 5, so one human can CHAIN identities (invite own sock puppet, which
    // invites the next, ...) — bounded in speed, unbounded in depth, by design on
    // this path. Per-HUMAN enforcement is the Self-gate nullifier path's job
    // (self_gate.js — one passport-proven human, one ignition), not the invite
    // quota's. Fine for a trusted friends/family beta; not an open-launch gate.
    case 'invite': {
      const target = cmd.for;
      if (typeof target !== 'string' || !ADDR_RE.test(target)) {
        emit({ type: 'error', op: 'invite', reason: "an invite must name its redeemer: {op:'invite', for:'M_...'} — ask your friend for their address first (their node prints it on the {\"type\":\"ready\"} line)" });
        break;
      }
      const inviteId = (typeof cmd.inviteId === 'string' && cmd.inviteId) || crypto.randomBytes(8).toString('hex');
      const invite = makeInvite(id, inviteId, target);   // swarm_engine — signs INVITE:<us>:<inviteId>:<target> with our key
      process.stderr.write(`[run_node] issued invite ${inviteId} bound to ${target} (deliver out of band; only that address can redeem it)\n`);
      emit({ type: 'invite', invite });
      break;
    }
    // Redeem an invite handed to us out of band → self-seal with OUR key and gossip
    // it. The seal is bound to our address (SEAL:<us>:<inviteId>), so sending it over
    // the relay is safe (a compromised relay can neither forge nor reassign it).
    // HONEST ACK (audit fix on 413d73a): announcing the seal proves nothing — the
    // invite could be forged, already spent, or over quota, and the fold would just
    // silently ignore our seal. So: 'redeem-sent' now, 'redeemed' ONLY once our
    // address actually appears in fold().members, 'redeem-failed' if it never does
    // within REDEEM_TIMEOUT_MS.
    case 'redeem': {
      const inv = cmd.invite;
      if (!inv || typeof inv !== 'object' || typeof inv.inviterAddr !== 'string'
          || typeof inv.inviteId !== 'string' || typeof inv.inviterSig !== 'string') {
        emit({ type: 'error', op: 'redeem', reason: 'invite must be {inviterAddr, inviteId, inviterSig}' });
        break;
      }
      if (pendingRedeem) {
        emit({ type: 'error', op: 'redeem', reason: `a redeem (invite ${pendingRedeem.inviteId}) is already pending — wait for redeemed/redeem-failed` });
        break;
      }
      // Fast local check (UX only — fold() enforces the same thing cryptographically):
      // a bound invite naming someone else can never work for this node, so say so
      // NOW instead of announcing and timing out into redeem-failed. An invite
      // MISSING its target (old format / hand-built) is still announced — fold will
      // reject it and the honest redeem-failed path reports that.
      if (typeof inv.target === 'string' && inv.target !== id.address) {
        emit({ type: 'error', op: 'redeem', reason: `this invite is bound to ${inv.target}, not this node (${id.address}) — ask your inviter for an invite made for YOUR address` });
        break;
      }
      client.announce(seal(id, inv));   // swarm_engine.seal → type:'seal' tx, gossiped via the existing announce path
      emit({ type: 'redeem-sent', inviteId: inv.inviteId });
      pendingRedeem = {
        inviteId: inv.inviteId,
        deadline: Date.now() + REDEEM_TIMEOUT_MS,
        poll: setInterval(checkPendingRedeem, Math.min(250, Math.max(50, Math.floor(REDEEM_TIMEOUT_MS / 6)))),
      };
      checkPendingRedeem();   // may confirm instantly (our own fold already has the seal + founders)
      break;
    }
  }
});

process.on('SIGTERM', () => { client.close(); process.exit(0); });
process.on('SIGINT',  () => { client.close(); process.exit(0); });

// Defence in depth: node_client.js's onMsg already guards against a malformed
// relay frame (a compromised relay is an explicit part of the threat model —
// worst case should be a dropped/delayed message, never a crash). This is a
// second, process-level backstop — one bad frame (or any other unexpected
// exception) is logged and the process keeps running, rather than dying
// silently with no operator visibility.
process.on('uncaughtException', (e) => {
  process.stderr.write(`[run_node] uncaught exception (continuing): ${e && e.stack || e}\n`);
});
