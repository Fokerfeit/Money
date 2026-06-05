/**
 * MONEY — SWARM prototype. Phones ARE the network. No central server.
 *
 * Each node holds the full set of SIGNED transactions, validates every one
 * itself, and computes the ledger with the SAME deterministic fold — so all
 * honest nodes converge on identical balances with nobody in charge.
 *
 * Proves, from first principles (real ed25519 sigs):
 *   1) genesis — everyone mints their 1,000,000, all nodes agree
 *   2) transfers — gossiped peer-to-peer, all nodes converge
 *   3) DOUBLE-SPEND attack — defeated network-wide, no referee
 *   4) a brand-new phone reconstructs the exact truth from signatures alone
 *
 *   node swarm.js
 */
const nacl = require('tweetnacl'); const crypto = require('crypto');
const toHex = a => Buffer.from(a).toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const MINT = 1_000_000;

const newId = name => { const k = nacl.sign.keyPair.fromSeed(nacl.randomBytes(32)); return { name, address:'M_'+toHex(k.publicKey).slice(0,32).toUpperCase(), pub:toHex(k.publicKey), sk:k.secretKey }; };
const canon = tx => { tx.id = sha(`${tx.type}:${tx.from}:${tx.to}:${tx.amount}:${tx.nonce}:${tx.sig}`).slice(0,16); return tx; };
const genesisTx  = id            => { const sig = toHex(nacl.sign.detached(Buffer.from(`GENESIS:${id.address}`), id.sk)); return canon({type:'genesis',from:id.address,to:id.address,amount:MINT,nonce:0,pub:id.pub,sig}); };
const transferTx = (id,to,amt,n) => { const sig = toHex(nacl.sign.detached(Buffer.from(`${id.address}:${to}:${amt}:${n}`), id.sk)); return canon({type:'transfer',from:id.address,to,amount:amt,nonce:n,pub:id.pub,sig}); };

// EVERY node runs this exact verification — no trusted authority needed.
const verify = tx => { try {
  if ('M_'+toHex(Buffer.from(tx.pub,'hex')).slice(0,32).toUpperCase() !== tx.from) return false;
  const msg = tx.type==='genesis' ? `GENESIS:${tx.from}` : `${tx.from}:${tx.to}:${tx.amount}:${tx.nonce}`;
  return nacl.sign.detached.verify(Buffer.from(msg), Buffer.from(tx.sig,'hex'), Buffer.from(tx.pub,'hex'));
} catch { return false; } };

class Node {
  constructor(name){ this.name = name; this.txs = new Map(); }
  hear(tx){ if (verify(tx)) this.txs.set(tx.id, tx); }                 // accept only valid, dedup by id
  gossipTo(peer){ for (const tx of this.txs.values()) peer.hear(tx); }  // epidemic spread
  // Deterministic fold: same tx set -> same ledger on every node. This IS the consensus.
  ledger(){
    const bal = {}, next = {}, rejected = [];
    const all = [...this.txs.values()];
    const minted = new Set();
    for (const tx of all.filter(t=>t.type==='genesis').sort((a,b)=>a.id<b.id?-1:1)) {
      if (minted.has(tx.from)) continue; minted.add(tx.from);
      bal[tx.from] = MINT; next[tx.from] = 1;
    }
    const transfers = all.filter(t=>t.type==='transfer').sort((a,b)=>
      a.from!==b.from ? (a.from<b.from?-1:1) : a.nonce!==b.nonce ? a.nonce-b.nonce : (a.id<b.id?-1:1));
    for (const tx of transfers) {
      if (next[tx.from]===tx.nonce && (bal[tx.from]||0)>=tx.amount) {
        bal[tx.from]-=tx.amount; bal[tx.to]=(bal[tx.to]||0)+tx.amount; next[tx.from]++;
      } else rejected.push({ tx, why: next[tx.from]!==tx.nonce ? 'DOUBLE-SPEND (nonce reused)' : 'insufficient' });
    }
    return { bal, rejected };
  }
  hash(){ const { bal } = this.ledger(); return sha(Object.keys(bal).sort().map(a=>`${a}:${bal[a]}`).join('|')).slice(0,10); }
}
const gossip = (nodes, rounds=4) => { for (let r=0;r<rounds;r++) for (const a of nodes) for (const b of nodes) if (a!==b) a.gossipTo(b); };
const allAgree = nodes => new Set(nodes.map(n=>n.hash())).size === 1;
const sname = (people, addr) => (people.find(p=>p.id.address===addr)||{id:{name:'?'}}).id.name;

// ── DEMO ─────────────────────────────────────────────────────────────────────
const names = ['Luca','Amir','Sara','Theo','Eve'];
const people = names.map(n => ({ id:newId(n), node:new Node(n) }));
const P = Object.fromEntries(people.map(p=>[p.id.name,p]));
const nodes = people.map(p=>p.node);
const show = (label) => { const L = nodes[0].ledger(); console.log('  '+label); for (const p of people) console.log(`     ${p.id.name.padEnd(6)} ${ (L.bal[p.id.address]||0).toLocaleString().padStart(11) }`); console.log(`     nodes agree: ${allAgree(nodes)?'YES ✅  (hash '+nodes[0].hash()+')':'NO ❌'}`); };

console.log('\n  ╔══════════════════════════════════════════════════════════╗');
console.log('  ║   MONEY SWARM — phones ARE the network · NO server       ║');
console.log('  ╚══════════════════════════════════════════════════════════╝');
console.log(`\n  ${people.length} independent phone-nodes. Nobody is in charge. Each validates everything itself.`);

console.log('\n  ── 1) GENESIS — everyone mints their 1,000,000 ──');
for (const p of people) p.node.hear(genesisTx(p.id));   // each announces its own mint
gossip(nodes);
show('after gossip:');

console.log('\n  ── 2) HONEST TRANSFERS (peer-to-peer, no server) ──');
P.Luca.node.hear(transferTx(P.Luca.id, P.Amir.id.address, 250_000, 1));   // Luca → Amir
P.Sara.node.hear(transferTx(P.Sara.id, P.Theo.id.address, 100_000, 1));   // Sara → Theo
gossip(nodes);
show('after gossip:');

console.log('\n  ── 3) DOUBLE-SPEND ATTACK — Eve spends the SAME money twice ──');
console.log('     Eve signs TWO transfers, both nonce #1, each spending 900,000 of her 1,000,000:');
const evil1 = transferTx(P.Eve.id, P.Luca.id.address, 900_000, 1);   // Eve → Luca
const evil2 = transferTx(P.Eve.id, P.Amir.id.address, 900_000, 1);   // Eve → Amir (conflict!)
console.log(`        → Eve→Luca 900,000   (tx ${evil1.id})`);
console.log(`        → Eve→Amir 900,000   (tx ${evil2.id})`);
console.log('     She injects each into a DIFFERENT corner of the network to try to fool it...');
P.Luca.node.hear(evil1);   // one half of the swarm sees this
P.Amir.node.hear(evil2);   // the other half sees that
gossip(nodes);             // gossip spreads BOTH everywhere
const L = nodes[0].ledger();
const winner = L.rejected.find(r=>r.tx.id===evil1.id||r.tx.id===evil2.id) ? (L.rejected.some(r=>r.tx.id===evil1.id)?evil2:evil1) : null;
console.log('     Result (every node folds the same way):');
for (const r of L.rejected.filter(r=>r.tx.from===P.Eve.id.address)) console.log(`        ✋ REJECTED  Eve→${sname(people,r.tx.to)}  ${r.tx.amount.toLocaleString()}  [${r.why}]`);
show('final balances:');

console.log('\n  ── 4) A BRAND-NEW PHONE JOINS — reconstructs truth from signatures alone ──');
const fresh = new Node('NewPhone');
nodes[2].gossipTo(fresh);   // sync from any one peer
console.log(`     New phone synced. Its ledger hash: ${fresh.hash()}`);
console.log(`     Matches the swarm: ${fresh.hash()===nodes[0].hash() ? 'YES ✅  — it needed NO server, just the signed transactions' : 'NO ❌'}`);

console.log('\n  ══════════════════════════════════════════════════════════');
console.log(`  ${allAgree([...nodes,fresh]) ? '✅ CONSENSUS: '+(people.length+1)+' phones agree on every balance — 0 central authorities.' : '❌ diverged'}`);
console.log('  The double-spend was defeated by math + agreement, not by a referee.');
console.log('  ══════════════════════════════════════════════════════════\n');
