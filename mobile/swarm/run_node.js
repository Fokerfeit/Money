// mobile/swarm/run_node.js — CLI wrapper around NodeClient (node_client.js), so a
// committee node can run as its OWN OS process and be driven over stdio. This is
// the multi-process harness for BRICK 3: proving two (or more) committee nodes,
// each a genuinely separate process with no shared JS state, converge to the same
// ledger purely by talking to a relay over a real WebSocket.
//
// ADDITIVE: does not modify node_client.js, swarm_engine.js, relay.js, or
// committee_bridge.js — it only requires them. Identity derivation reuses
// committee_bridge.mkIdentity (same seeded-keypair scheme already adversarially
// reviewed in Brick 2), so a test can precompute a node's address from its label.
//
// Protocol (JSON Lines):
//   stdin  — one command object per line:
//     {op:'seal_founder'}                              — announce this identity as a founder
//     {op:'pay', to, amount, nonce, epoch}              — submit a signed promise
//     {op:'status'}                                     — request an immediate status line
//     {op:'close'}                                       — disconnect and exit
//   stdout — one event object per line:
//     {type:'ready', address, pub}                      — connected to the relay
//     {type:'status', address, hash, members, frauds, balances}  — emitted on every
//       ledger change (autonomous) AND in response to {op:'status'}
'use strict';

const WS = require('ws');
const fs = require('fs');
const readline = require('readline');
const { NodeClient } = require('./node_client');
const { founderSeal } = require('./swarm_engine');
const { mkIdentity } = require('./committee_bridge');

const RELAY_URL    = process.env.RELAY_URL;
const NODE_LABEL   = process.env.NODE_LABEL;
const FOUNDERS     = JSON.parse(process.env.FOUNDERS_JSON || '[]');   // array of addresses
const STORE_FILE   = process.env.STORE_FILE || null;                  // optional — persistence across restarts

if (!RELAY_URL || !NODE_LABEL) {
  process.stderr.write('run_node.js requires RELAY_URL and NODE_LABEL env vars\n');
  process.exit(1);
}

const id = mkIdentity(NODE_LABEL);

const store = STORE_FILE ? {
  load: () => { try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch { return null; } },
  save: (snap) => { try { fs.writeFileSync(STORE_FILE, JSON.stringify(snap)); } catch {} },
} : null;

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const emitStatus = () => {
  const st = client.status();
  emit({ type: 'status', address: id.address, hash: st.hash, members: st.members, frauds: st.frauds, balances: st.balances });
};

const client = new NodeClient(id, FOUNDERS, RELAY_URL, { ws: WS, store, onChange: emitStatus });

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
