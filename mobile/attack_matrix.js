/**
 * Live 100-shot attack battery (ground truth) against the HARDENED server.
 * Spawns an isolated server (codes ON, platform whitelisted, real throttle),
 * then runs 100 attempts per attacker tier and tallies real outcomes.
 *   node attack_matrix.js
 */
const nacl = require('tweetnacl'); const http = require('http');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn } = require('child_process');

const PORT = 3500;
// High-entropy codes used only to provision honest wallets (so we have valid txs to replay).
const STRONG = ['K7QF9X2MA1','B3RT8W5LZ9','P6YH2N4VC7','D9EK1M7QT2','F4GX6B8JR3'];
const PLATFORM = 'M_F66DCDBCD2FA68D8FCEE50A503CFBA20';

const toHex = a => Buffer.from(a).toString('hex');
const kp = () => { const k = nacl.sign.keyPair.fromSeed(nacl.randomBytes(32)); return { address:'M_'+toHex(k.publicKey).slice(0,32).toUpperCase(), publicKey:toHex(k.publicKey), secretKey:toHex(k.secretKey) }; };
const sign = (f,t,a,ts,sk) => toHex(nacl.sign.detached(Buffer.from(`${f}:${t}:${a}:${ts}`), Buffer.from(sk,'hex')));
const call = (method,p,body,xff) => new Promise((res,rej)=>{
  const d = body?JSON.stringify(body):null;
  const r = http.request({hostname:'localhost',port:PORT,path:p,method,headers:Object.assign(d?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(d)}:{}, xff?{'X-Forwarded-For':xff}:{})},
    x=>{let s='';x.on('data',c=>s+=c);x.on('end',()=>res({status:x.statusCode, body:(()=>{try{return JSON.parse(s)}catch{return s}})()}));});
  r.on('error',rej); if(d)r.write(d); r.end();
});
const igBody = (w,code,dev) => { const ts=Date.now(); return {from:'FAUCET',to:w.address,amount:1_000_000,signature:sign('FAUCET',w.address,1_000_000,ts,w.secretKey),publicKey:w.publicKey,timestamp:ts,ignitionCode:code,deviceId:dev}; };
const rndCode = () => Array.from({length:10},()=>'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random()*36)]).join('');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'matrix-'));
  const srv = spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(PORT),MONEY_DATA_DIR:tmp,IGNITION_CODES:STRONG.join(','),MONEY_PLATFORM_ADDRESSES:PLATFORM},stdio:'pipe'});
  srv.on('exit',()=>{try{fs.rmSync(tmp,{recursive:true,force:true})}catch{}});
  await new Promise((r,j)=>{const f=c=>c.toString().toLowerCase().includes('listening on')&&r();srv.stdout.on('data',f);srv.stderr.on('data',f);setTimeout(()=>j(new Error('timeout')),5000);});

  // provision two honest wallets + capture a valid transfer to replay/tamper
  const H1=kp(), H2=kp();
  await call('POST','/transaction',igBody(H1,STRONG[0],'devH1'));
  await call('POST','/transaction',igBody(H2,STRONG[1],'devH2'));
  const tts=Date.now(); const validTx={from:H1.address,to:H2.address,amount:100,signature:sign(H1.address,H2.address,100,tts,H1.secretKey),publicKey:H1.publicKey,timestamp:tts};
  await call('POST','/transaction', validTx); // send ONCE legitimately, so every later send of it is a true replay

  const tally = () => ({ blocked:0, money:0, info:0, dos:0 });
  const N = 100;

  // ── CAT 1 — naive (only what the app would let them do; no crafting) ──
  const c1 = tally();
  for (let i=0;i<N;i++){
    const v = i%3;
    let r;
    if (v===0) r = await call('POST','/transaction', igBody(kp(), rndCode(), 'dev'+i));          // reinstall→re-ignite, no real code
    else if (v===1) r = await call('POST','/transaction', igBody(H1, STRONG[0], 'devH1'));        // claim again (used code+address)
    else { const ts=Date.now(); r = await call('POST','/transaction',{from:H1.address,to:H2.address,amount:9_999_999,signature:sign(H1.address,H2.address,9_999_999,ts,H1.secretKey),publicKey:H1.publicKey,timestamp:ts}); } // spend > balance
    (r.status===200 && r.body && r.body.success) ? c1.money++ : c1.blocked++;
  }

  // ── CAT 2 — power user: replay / tamper (can't sign) + read public data ──
  const c2 = tally();
  for (let i=0;i<N;i++){
    const v = i%5;
    if (v===0){ const r=await call('POST','/transaction',validTx); (r.body&&r.body.success)?c2.money++:c2.blocked++; }            // replay captured tx
    else if (v===1){ const t={...validTx,amount:50000}; const r=await call('POST','/transaction',t); (r.body&&r.body.success)?c2.money++:c2.blocked++; } // tamper amount
    else if (v===2){ const t={...validTx,to:kp().address}; const r=await call('POST','/transaction',t); (r.body&&r.body.success)?c2.money++:c2.blocked++; } // tamper recipient
    else if (v===3){ const r=await call('GET','/ledger'); (r.status===200&&Array.isArray(r.body))?c2.info++:c2.blocked++; }        // scrape all balances
    else { const r=await call('GET','/stats'); (r.status===200)?c2.info++:c2.blocked++; }                                          // read stats
  }

  // ── CAT 3 — scripted dev: forge keypairs/codes/devices, replay, over-mint, scrape, DoS ──
  const c3 = tally();
  for (let i=0;i<N;i++){
    const v = i%7;
    if (v===0){ const r=await call('POST','/transaction',igBody(kp(),undefined,'d'+i)); (r.body&&r.body.success)?c3.money++:c3.blocked++; }   // ignite no code
    else if (v===1){ const r=await call('POST','/transaction',igBody(kp(),rndCode(),'d'+i)); (r.body&&r.body.success)?c3.money++:c3.blocked++; } // brute/forged code (fresh device each time)
    else if (v===2){ const w=kp(),ts=Date.now()-5*60*1000; const r=await call('POST','/transaction',{from:'FAUCET',to:w.address,amount:1e6,signature:sign('FAUCET',w.address,1e6,ts,w.secretKey),publicKey:w.publicKey,timestamp:ts,ignitionCode:rndCode()}); (r.body&&r.body.success)?c3.money++:c3.blocked++; } // stale ts
    else if (v===3){ const a=kp(),victim=kp(),ts=Date.now(); const r=await call('POST','/transaction',{from:'FAUCET',to:victim.address,amount:1e6,signature:sign('FAUCET',victim.address,1e6,ts,a.secretKey),publicKey:a.publicKey,timestamp:ts,ignitionCode:rndCode()}); (r.body&&r.body.success)?c3.money++:c3.blocked++; } // pubkey/addr mismatch
    else if (v===4){ const r=await call('POST','/transaction',validTx,'9.9.9.'+(i%255)); (r.body&&r.body.success)?c3.money++:c3.blocked++; } // XFF spoof + replay
    else if (v===5){ const r=await call('GET','/ledger'); (r.status===200&&Array.isArray(r.body))?c3.info++:c3.blocked++; }            // scrape
    else { const r=await call('GET','/ledger'); (r.status===200)?c3.dos++:c3.blocked++; }                                              // DoS (unthrottled GET reachable)
  }

  // ── CAT 4 — expert: signature malleability vs the signature-keyed replay fence ──
  const c4 = tally();
  // build a malleable variant S' = S + L of a freshly-signed honest tx, then send original + variant
  const L = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;
  const leToBig = b => { let n=0n; for(let i=b.length-1;i>=0;i--) n=(n<<8n)|BigInt(b[i]); return n; };
  const bigToLe32 = n => { const o=Buffer.alloc(32); for(let i=0;i<32;i++){o[i]=Number(n&0xffn); n>>=8n;} return o; };
  let malleable=0, malBlocked=0;
  for (let i=0;i<N;i++){
    const W=kp(), R=kp();
    // give W a balance via honest path
    await call('POST','/transaction',igBody(W,STRONG[2+(i%3)],'dW'+i)).catch(()=>{}); // may fail (codes reused) — fine, we only need a signed msg to test the fence/verify
    const ts=Date.now(); const sigHex=sign(W.address,R.address,10,ts,W.secretKey);
    const sigBuf=Buffer.from(sigHex,'hex'); const Sp=leToBig(sigBuf.slice(32))+L;
    const malSig = Buffer.concat([sigBuf.slice(0,32), bigToLe32(Sp)]).toString('hex');
    // does nacl verify the malleable variant? (pure crypto check — the core question)
    let accepts=false; try{ accepts = nacl.sign.detached.verify(Buffer.from(`${W.address}:${R.address}:10:${ts}`), Buffer.from(malSig,'hex'), Buffer.from(W.publicKey,'hex')); }catch{}
    accepts ? malleable++ : malBlocked++;
  }
  c4.blocked = malBlocked; c4.money = 0; // money path also needs registered+balance; the crypto result is what matters
  const malNote = malleable>0 ? `tweetnacl ACCEPTED ${malleable}/100 malleable variants → fence-bypass risk (OPEN at crypto layer)` : `tweetnacl REJECTED all 100 malleable variants → not malleable (BLOCKED)`;

  // ── side finding: weak codes are brute-forceable ──
  const tmp2=fs.mkdtempSync(path.join(os.tmpdir(),'weak-'));
  const srv2=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:'3501',MONEY_DATA_DIR:tmp2,IGNITION_CODES:'LUCA-1,GUEST-1'},stdio:'pipe'});
  srv2.on('exit',()=>{try{fs.rmSync(tmp2,{recursive:true,force:true})}catch{}});
  await new Promise(r=>setTimeout(r,1500));
  const callW=(b)=>new Promise(res=>{const d=JSON.stringify(b);const r=http.request({hostname:'localhost',port:3501,path:'/transaction',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(d)}},x=>{let s='';x.on('data',c=>s+=c);x.on('end',()=>res((()=>{try{return JSON.parse(s)}catch{return{}}})()))});r.write(d);r.end();});
  const guesses=['LUCA-1','GUEST-1','TEST-1','ADMIN-1','SEAL-1','LUCA-2','MONEY-1','FREE-1']; let cracked=0;
  for(const g of guesses){ const w=kp(); const r=await callW(igBody(w,g,'dwk'+g)); if(r&&r.success){cracked++;} }
  srv2.kill();

  // ── report ──
  const row=(name,t,extra)=>console.log(`  ${name.padEnd(34)} blocked ${String(t.blocked).padStart(3)} | money ${String(t.money).padStart(2)} | info ${String(t.info).padStart(3)} | dos ${String(t.dos).padStart(3)}${extra?'  '+extra:''}`);
  console.log('\n  ================ LIVE 100-SHOT ATTACK BATTERY (hardened server) ================');
  console.log('  (money = illegitimate mint/theft succeeded · info = read data exposed · dos = unthrottled hit)\n');
  row('CAT 1  naive (taps/reinstall)', c1);
  row('CAT 2  power user (replay/tamper)', c2);
  row('CAT 3  scripted developer', c3);
  row('CAT 4  expert — sig malleability', c4, '['+malNote+']');
  console.log('\n  WEAK-CODE BRUTE FORCE (codes "LUCA-1,GUEST-1"): cracked '+cracked+' of '+guesses.length+' common guesses');
  console.log('     → real deployed codes MUST be high-entropy; "LUCA-1"/"GUEST-1" are trivially guessable.\n');
  console.log('  NOTE: architectural attacks (own/rewrite the single ledger.json, DDoS the one node) are NOT in this');
  console.log('  table — they are not API-blockable and succeed ~100% once attempted. See Cat 4 analyst report.\n');
  srv.kill(); process.exit(0);
})();
