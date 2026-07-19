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
//   • INVITE / REDEEM ops — a newcomer becomes a spending MEMBER via the existing,
//     already-audited seal/invite mechanism in swarm_engine.js (makeInvite + seal),
//     reachable over stdio. NOTE (honest correction to a common misreading):
//     membership is INVITE-certified, not committee-quorum-certified — quorum in
//     swarm_engine only gates spends/channels, never member admission. An existing
//     member issues a quota-limited (≤5) invite with their own key; the newcomer
//     redeems it by self-sealing with THEIR key and gossiping that seal. No new
//     consensus rule is introduced — this only plumbs the existing seal path.
//
// Protocol (JSON Lines):
//   stdin  — one command object per line:
//     {op:'seal_founder'}                              — announce this identity as a founder
//     {op:'invite', inviteId?}                          — (member only) issue a signed, quota-limited
//                                                          invite; emitted to stdout for OUT-OF-BAND
//                                                          delivery to a newcomer (an invite is a bearer
//                                                          credential — hand it to ONE person, do NOT
//                                                          broadcast it)
//     {op:'redeem', invite:{inviterAddr,inviteId,inviterSig}}  — (newcomer) self-seal with the invite
//                                                          and gossip the seal → become a member
//     {op:'pay', to, amount, nonce, epoch}              — submit a signed promise
//     {op:'status'}                                     — request an immediate status line
//     {op:'close'}                                       — disconnect and exit
//   stdout — one event object per line:
//     {type:'ready', address, pub}                      — connected to the relay
//     {type:'invite', invite:{...}}                      — a freshly issued invite (deliver out of band)
//     {type:'redeemed', inviteId}                        — the newcomer's self-seal was announced
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
const safeStore = require('../safe_store');

const NODE_LABEL   = process.env.NODE_LABEL;
const STORE_FILE   = process.env.STORE_FILE || null;                  // optional — persistence across restarts

// ── GENESIS (self-serve join): founder set + default relay travel WITH the download ──
// GENESIS_FILE (default: genesis.json beside this script) carries { founders:[...],
// relay:"wss://..." } so a freshly-downloaded node needs NO hand-set env var. Read
// FAIL-CLOSED via safe_store.loadStrict — a present-but-corrupt genesis is a hard
// error (never a silent "empty founder set", which would make the node quietly fail
// to validate the whole network). Absent genesis → falls back to env, so every
// existing test harness (which sets FOUNDERS_JSON/RELAY_URL and ships no genesis
// file) is byte-for-byte unchanged.
const GENESIS_FILE = process.env.GENESIS_FILE || path.join(__dirname, 'genesis.json');
const GENESIS_MISSING = Symbol('no-genesis-file');
let genesis = null;
try {
  const g = safeStore.loadStrict(GENESIS_FILE, GENESIS_MISSING);
  if (g !== GENESIS_MISSING) {
    if (!g || typeof g !== 'object' || Array.isArray(g) || !Array.isArray(g.founders)) {
      throw new Error('genesis must be a JSON object with a "founders" array (and optional "relay" string)');
    }
    genesis = g;
  }
} catch (e) {
  process.stderr.write(`[run_node] genesis file "${GENESIS_FILE}" is present but invalid — refusing to start (fail-closed): ${e.message}\n`);
  process.exit(1);
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
const emitStatus = () => {
  const st = client.status();
  emit({ type: 'status', address: id.address, hash: st.hash, members: st.members, frauds: st.frauds, balances: st.balances });
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
    // Issue an invite (member only). An invite is a bearer credential signed with
    // OUR key: whoever holds it can seal THEMSELVES as a member (bound to their own
    // key, quota ≤5 enforced by the ledger fold). So it is emitted to stdout for
    // OUT-OF-BAND, point-to-point delivery to ONE newcomer — deliberately NOT
    // broadcast over the relay (broadcasting a bearer invite = an open Sybil door).
    case 'invite': {
      const inviteId = (typeof cmd.inviteId === 'string' && cmd.inviteId) || crypto.randomBytes(8).toString('hex');
      const invite = makeInvite(id, inviteId);   // swarm_engine — signs INVITE:<us>:<inviteId> with our key
      process.stderr.write(`[run_node] issued invite ${inviteId} (deliver OUT OF BAND to one person; do not broadcast)\n`);
      emit({ type: 'invite', invite });
      break;
    }
    // Redeem an invite handed to us out of band → self-seal with OUR key and gossip
    // it. The seal is bound to our address (SEAL:<us>:<inviteId>), so sending it over
    // the relay is safe (a compromised relay can neither forge nor reassign it). On
    // the next fold across the network we become a member with our 1,000,000.
    case 'redeem': {
      const inv = cmd.invite;
      if (!inv || typeof inv !== 'object' || typeof inv.inviterAddr !== 'string'
          || typeof inv.inviteId !== 'string' || typeof inv.inviterSig !== 'string') {
        emit({ type: 'error', op: 'redeem', reason: 'invite must be {inviterAddr, inviteId, inviterSig}' });
        break;
      }
      client.announce(seal(id, inv));   // swarm_engine.seal → type:'seal' tx, gossiped via the existing announce path
      emit({ type: 'redeemed', inviteId: inv.inviteId });
      emitStatus();
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
