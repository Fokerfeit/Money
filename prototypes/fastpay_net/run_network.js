// run_network.js — boot a real (networked) MONEY committee and exercise it.
//   node run_network.js
const fs = require('fs');
const path = require('path');
const { startAuthority } = require('./server');
const { selectCommittee } = require('./committee');
const { Wallet, post, getState } = require('./wallet');

const DATA = path.join(__dirname, 'data');
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

const N = 6, COMMITTEE_SIZE = 4, BASE_PORT = 4101, MILLION = 1000000, STANDING = 500000;
let QUORUM = 3;
const line = () => console.log('─'.repeat(66));
const results = [];
const rec = (name, pass, detail = '') => results.push({ name, pass, detail });

async function main() {
  console.log('\n💸  MONEY — networked committee (real HTTP between separate servers)\n');

  // --- boot the online validator pool: 6 authority HTTP servers ---
  let auths = [];
  for (let i = 0; i < N; i++) auths.push(await startAuthority('auth' + (i + 1), BASE_PORT + i, DATA, () => QUORUM));
  const pool = auths.map(a => ({ name: a.name, url: a.url }));
  console.log(`Online validator pool (${N} nodes): ` + pool.map(p => `${p.name}@${p.port || p.url.split(':')[2]}`).join(', '));

  // --- rotating committee: deterministic, drawn from the online pool ---
  const c1 = selectCommittee(pool, 1, COMMITTEE_SIZE);
  const c2 = selectCommittee(pool, 2, COMMITTEE_SIZE);
  QUORUM = c1.quorum;
  console.log(`Committee epoch 1  (quorum ${c1.quorum}): ` + c1.members.map(m => m.name).join(', '));
  console.log(`Committee epoch 2  (quorum ${c2.quorum}): ` + c2.members.map(m => m.name).join(', ') + '   ← rotates by epoch');
  line();

  // --- register 3 millionaires across the whole pool ---
  const alice = new Wallet(), bob = new Wallet(), carol = new Wallet();
  for (const w of [alice, bob, carol])
    for (const a of auths) await post(`${a.url}/register`, { address: w.address, pubKeyHex: w.pubKeyHex, balance: MILLION, standing: STANDING });
  console.log('Registered Alice, Bob, Carol — each 1,000,000 MONEY, standing 500,000');
  line();

  // === 1. CLEAN TRANSFER over the network, settled by epoch-1 committee ===
  console.log('✅  CLEAN TRANSFER — Alice → Bob 250,000  (over HTTP, via committee)');
  let seq = (await getState(auths[0].url, alice.address)).nextSeq;
  let r = await alice.transfer(c1, pool, bob.address, 250000, seq);
  // read balances from a NON-committee authority to prove the whole pool synced
  const nonMember = pool.find(p => !c1.members.some(m => m.name === p.name));
  const aS = await getState(nonMember.url, alice.address);
  const bS = await getState(nonMember.url, bob.address);
  console.log(`   votes ${r.votes}/${COMMITTEE_SIZE}  finalized: ${r.finalized}`);
  console.log(`   read from ${nonMember.name} (NOT on the committee): Alice ${aS.balance.toLocaleString()}  Bob ${bS.balance.toLocaleString()}`);
  console.log(`   → whole 6-node pool is in sync, not just the committee`);
  rec('clean transfer settles over network', r.finalized && aS.balance === 750000 && bS.balance === 1250000, `A=${aS.balance} B=${bS.balance}`);
  line();

  // === 2. DOUBLE-SPEND across the network ===
  console.log('🚫  DOUBLE-SPEND — two transfers at the same seq, across the wire');
  seq = (await getState(auths[0].url, alice.address)).nextSeq;
  const A = alice.build(bob.address, 300000, seq);
  const B = alice.build(carol.address, 300000, seq);
  const voteObjsA = []; let votesB = 0, lockMsg = '';
  for (const m of c1.members) { const x = await post(`${m.url}/order`, { order: A.order, sig: A.sig }); if (x.ok) voteObjsA.push(x.vote); }
  for (const m of c1.members) { const x = await post(`${m.url}/order`, { order: B.order, sig: B.sig }); if (x.ok) votesB++; else lockMsg = x.reason; }
  const votesA = voteObjsA.length;
  console.log(`   order → Bob   : ${votesA}/${COMMITTEE_SIZE} voted ✔`);
  console.log(`   order → Carol : ${votesB}/${COMMITTEE_SIZE} voted ✗  ("${lockMsg}")`);
  // finalize A across the pool (so Alice's seq actually advances)
  const certA = { order: A.order, digest: A.digest, votes: voteObjsA.slice(0, QUORUM) };
  await Promise.all(pool.map(p => post(`${p.url}/certificate`, { cert: certA }).catch(() => {})));
  rec('double-spend blocked over network', votesA >= QUORUM && votesB === 0, `A=${votesA} B=${votesB}`);
  line();

  // === 3. PERSISTENCE — kill an authority, restart it, state survives ===
  console.log('🚫  PERSISTENCE — kill auth1, restart from disk, it still remembers');
  const before = await getState(auths[0].url, alice.address);
  await auths[0].close();                                   // crash the server
  console.log(`   auth1 stopped. balance it knew: Alice ${before.balance.toLocaleString()}, nextSeq ${before.nextSeq}`);
  auths[0] = await startAuthority('auth1', BASE_PORT, DATA, () => QUORUM); // reboot → loads data/auth1.json
  const after = await getState(auths[0].url, alice.address);
  console.log(`   auth1 rebooted. balance after reload: Alice ${after.balance.toLocaleString()}, nextSeq ${after.nextSeq}`);
  // try to replay an OLD already-applied transfer → must be refused (state persisted)
  const replay = await post(`${auths[0].url}/order`, { order: A.order, sig: A.sig });
  console.log(`   replay of an old transfer → ${replay.ok ? 'ACCEPTED (BAD!)' : 'refused: ' + replay.reason}`);
  rec('state persists across restart', after.balance === before.balance && after.nextSeq === before.nextSeq && !replay.ok, `b=${after.balance} seq=${after.nextSeq}`);
  line();

  // === 4. the rejection paths, over the network ===
  console.log('🚫  ATTACKS over the network');
  seq = (await getState(auths[0].url, alice.address)).nextSeq;
  const over = await alice.transfer(c1, pool, bob.address, 600000, seq);
  const badsig = await alice.transfer(c1, pool, bob.address, 100000, seq, { corruptSig: true });
  const wrongseq = await alice.transfer(c1, pool, bob.address, 100000, 99);
  console.log(`   over-standing : finalized ${over.finalized}  (${over.reason})`);
  console.log(`   bad signature : finalized ${badsig.finalized}  (${badsig.reason})`);
  console.log(`   wrong seq     : finalized ${wrongseq.finalized}  (${wrongseq.reason})`);
  rec('over-standing refused', over.finalized === false);
  rec('bad signature refused', badsig.finalized === false);
  rec('wrong seq refused', wrongseq.finalized === false);
  line();

  // --- summary ---
  console.log('\n📋  SUMMARY');
  let all = true;
  for (const x of results) { all = all && x.pass; console.log(`   ${x.pass ? '✅' : '❌'}  ${x.name.padEnd(34)} ${x.pass ? '' : '<<< ' + x.detail}`); }
  line();
  console.log(all
    ? '🎉  REAL NETWORKED RUN — money moves over HTTP, committee rotates, state persists, every attack bounced.\n'
    : '💥  a check failed — see above.\n');

  await Promise.all(auths.map(a => a.close().catch(() => {})));
  process.exit(all ? 0 : 1);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });
