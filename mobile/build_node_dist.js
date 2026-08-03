// mobile/build_node_dist.js — assemble the "download and run" node folder.
//
// Produces dist/money-node/ (gitignored) containing ONLY what a committee node
// needs to run + join: the swarm engine + client + relay + run_node CLI, the
// identity/persistence layer, the genesis config, the friendly launch scripts,
// and a minimal package.json (two deps: ws + tweetnacl). Luca zips this folder
// and sends it to a friend.
//
// DELIBERATELY EXCLUDED (a node needs none of these, and some are sensitive):
//   • server.js            — the central money server (not a node)
//   • self_gate.js, ledger_chain.js — server-side ignition / integrity layers
//   • App.js, assets, expo — the phone app
//   • test_*.js            — test harnesses
//   • gencodes / admin     — operator tooling
//   • .env / secrets       — never packaged
//   • node_modules         — the friend's `npm install` builds it locally
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = __dirname;                                   // mobile/
const OUT = path.join(SRC, 'dist', 'money-node');        // gitignored (mobile/.gitignore: dist/)

// The exact dependency closure of run_node.js (verified by tracing every require):
//   run_node → node_client, swarm_engine, committee_bridge, identity_store, ws
//   node_client → swarm_engine
//   swarm_engine → crypto_fast, tweetnacl
//   crypto_fast → tweetnacl, (built-in crypto)
//   committee_bridge → swarm_engine
//   identity_store → ../safe_store, swarm_engine, tweetnacl
//   safe_store → (built-ins only)
// So: 7 swarm files + genesis + safe_store (one level up, because identity_store
// requires '../safe_store'), and npm deps ws + tweetnacl only.
const SWARM_FILES = [
  'swarm_engine.js', 'crypto_fast.js', 'node_client.js',
  'relay.js', 'run_node.js', 'committee_bridge.js', 'identity_store.js',
  'genesis.json',
];
const ROOT_FILES  = ['safe_store.js'];                   // must sit one level ABOVE swarm/ (../safe_store)
const PKG_FILES   = ['start-node.sh', 'start-node.bat', 'README_FRIEND.md'];

const PKG_JSON = {
  name: 'money-node',
  version: '1.0.0',
  private: true,
  description: 'A MONEY testnet committee node — download and run.',
  scripts: { start: 'node swarm/run_node.js' },
  dependencies: { ws: '^7.5.11', tweetnacl: '^1.0.3' },
};

function copy(fromAbs, toAbs) {
  fs.mkdirSync(path.dirname(toAbs), { recursive: true });
  fs.copyFileSync(fromAbs, toAbs);
}

(function main() {
  // Clean, then rebuild from scratch so a stale file can never linger.
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'swarm'), { recursive: true });

  const produced = [];
  for (const f of SWARM_FILES) {
    const from = path.join(SRC, 'swarm', f);
    if (!fs.existsSync(from)) throw new Error(`missing required swarm file: ${from}`);
    copy(from, path.join(OUT, 'swarm', f));
    produced.push(`swarm/${f}`);
  }
  for (const f of ROOT_FILES) {
    const from = path.join(SRC, f);
    if (!fs.existsSync(from)) throw new Error(`missing required root file: ${from}`);
    copy(from, path.join(OUT, f));
    produced.push(f);
  }
  for (const f of PKG_FILES) {
    const from = path.join(SRC, 'node_pkg', f);
    if (!fs.existsSync(from)) throw new Error(`missing packaging file: ${from}`);
    copy(from, path.join(OUT, f));
    produced.push(f);
  }
  // make the shell launcher executable (best-effort; harmless on Windows)
  try { fs.chmodSync(path.join(OUT, 'start-node.sh'), 0o755); } catch {}

  fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify(PKG_JSON, null, 2) + '\n');
  produced.push('package.json');

  // Safety net: fail loudly if anything sensitive/unnecessary slipped in.
  const FORBIDDEN = ['server.js', 'self_gate.js', 'ledger_chain.js', 'App.js', '.env'];
  const walk = (dir, base = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(path.join(dir, d.name), base + d.name + '/') : [base + d.name]);
  const all = walk(OUT);
  const leaked = all.filter((f) => FORBIDDEN.includes(path.basename(f)) || /\.test\.js$|^test_/.test(path.basename(f)));
  if (leaked.length) throw new Error(`dist leak check FAILED — forbidden files present: ${leaked.join(', ')}`);

  console.log(`\n✅ Built ${OUT}\n`);
  console.log('   Contents (this is exactly what Luca zips and sends):');
  for (const f of all.sort()) console.log(`     money-node/${f}`);
  console.log('\n   Leak check: PASS (no server.js / self_gate.js / ledger_chain.js / App.js / tests / .env).');
  console.log('   npm deps: ws + tweetnacl only.\n');

  // Founder-set gate: actually inspects genesis.json instead of always warning.
  // Fails loudly (non-zero exit) so a bad founder list can't be zipped by accident.
  const OLD_PLACEHOLDER = 'M_1DE960B21C9893637868A97DFC97F11F';
  const ADDR_RE = /^M_[0-9A-F]{32}$/;
  const genesis = JSON.parse(fs.readFileSync(path.join(OUT, 'swarm', 'genesis.json'), 'utf8'));
  const founders = Array.isArray(genesis.founders) ? genesis.founders : [];
  const problems = [];
  if (founders.length === 0) problems.push('founders array is empty');
  if (founders.includes(OLD_PLACEHOLDER)) problems.push(`still contains the old placeholder founding wallet (${OLD_PLACEHOLDER})`);
  const malformed = founders.filter((a) => !ADDR_RE.test(a));
  if (malformed.length) problems.push(`malformed address(es) (need M_ + 32 uppercase hex): ${malformed.join(', ')}`);

  if (problems.length) {
    console.log('   🛑 GENESIS FOUNDER-SET GATE FAILED — do NOT zip this dist:');
    for (const p of problems) console.log(`       - ${p}`);
    console.log('       Fix mobile/swarm/genesis.json and rebuild.\n');
    process.exitCode = 1;
    return;
  }
  console.log(`   ✅ Genesis founder-set gate: PASS (${founders.length} founder${founders.length === 1 ? '' : 's'} configured, no placeholder, all addresses well-formed).\n`);
})();
