// test_node_dashboard.js — the read-only node dashboard (127.0.0.1 HTTP window).
// Every probe must pass; exit 0.
//
// This is an EXECUTED test, not a structural one: it spawns real run_node.js child
// processes and drives the actual HTTP server.
//   • Node A is pointed at a live in-process WebSocket relay stub, so it connects,
//     folds, and emits a real status — we prove GET /state serves the node's OWN
//     computed values (identical to the JSON stream), that POST/PUT are refused,
//     and that an unknown path 404s.
//   • Node B is pointed at a DEAD relay port, so connect() never resolves and the
//     node never folds — we prove GET /state returns an honest not-ready shape
//     (no fabricated balances) rather than crashing.
//   • Both prove the server answers on 127.0.0.1; a source scan proves the bind
//     address is 127.0.0.1 and not 0.0.0.0.
//
// Nothing here pushes, deploys, or writes to the real network.

'use strict';
const http  = require('http');
const net   = require('net');
const path  = require('path');
const fs    = require('fs');
const { spawn } = require('child_process');
let WebSocketServer;
try { WebSocketServer = require('ws').Server; }
catch { console.error('   ❌  the "ws" package is required to run this test'); process.exit(1); }
const { mkIdentity } = require('./committee_bridge');

let fails = 0;
const ok  = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };

const RUN_NODE = path.join(__dirname, 'run_node.js');
const children = [];
const cleanup = () => { for (const c of children) { try { c.kill('SIGTERM'); } catch {} } };
process.on('exit', cleanup);

// ── helpers ──────────────────────────────────────────────────────────────────
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function req(port, urlPath, method) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: urlPath, method: method || 'GET' }, (res) => {
      let data = ''; res.on('data', (d) => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    r.on('error', reject);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(80); }
  throw new Error('timeout waiting for ' + (label || 'condition'));
}

// Spawn a run_node child in JSON mode. Returns { proc, lines(), stderr(), dashPort }.
async function spawnNode(label, relayUrl) {
  const dashPort = await freePort();
  const id = mkIdentity(label);
  const env = Object.assign({}, process.env, {
    MONEY_JSON: '1',
    NODE_LABEL: label,
    FOUNDERS_JSON: JSON.stringify([id.address]),
    RELAY_URL: relayUrl,
    DASH_PORT: String(dashPort),
  });
  const proc = spawn(process.execPath, [RUN_NODE], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(proc);
  const out = []; let outbuf = '';
  proc.stdout.on('data', (d) => {
    outbuf += d.toString();
    let i; while ((i = outbuf.indexOf('\n')) >= 0) { const l = outbuf.slice(0, i).trim(); outbuf = outbuf.slice(i + 1); if (l) out.push(l); }
  });
  let err = '';
  proc.stderr.on('data', (d) => { err += d.toString(); });
  return {
    proc, dashPort, address: id.address,
    lines: () => out.slice(),
    lastStatus: () => { for (let i = out.length - 1; i >= 0; i--) { try { const o = JSON.parse(out[i]); if (o.type === 'status') return o; } catch {} } return null; },
    stderr: () => err,
  };
}

(async () => {
  console.log('\n  🖥️   NODE DASHBOARD — read-only 127.0.0.1 window\n');

  // ── SOURCE SCAN: bind address + no write route ──────────────────────────────
  console.log('  0 SOURCE GUARANTEES');
  const src = fs.readFileSync(RUN_NODE, 'utf8');
  (/\.listen\(\s*DASH_PORT\s*,\s*['"]127\.0\.0\.1['"]/.test(src))
    ? ok("server binds 127.0.0.1 explicitly (never 0.0.0.0)")
    : bad('server does not bind 127.0.0.1 explicitly');
  (/req\.method\s*!==\s*['"]GET['"]/.test(src))
    ? ok('non-GET methods are rejected (no write route exists)')
    : bad('no GET-only guard found');
  (!/app\.(post|put|delete)\(|case\s+['"](seal_founder|pay|redeem|invite)['"][\s\S]{0,400}res\./.test(src))
    ? ok('no HTTP route touches seal/pay/redeem/invite')
    : bad('an HTTP route appears to reach an action');

  // ── NODE A: live relay stub → connected + real folded status ────────────────
  console.log('\n  1 CONNECTED NODE — /state serves the node’s own values');
  const relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  relay.on('connection', () => { /* accept; the node folds its own state on open */ });
  await new Promise((res, rej) => { relay.on('listening', res); relay.on('error', rej); });
  const relayPort = relay.address().port;
  const relayUrl = `ws://127.0.0.1:${relayPort}`;

  const A = await spawnNode('dash-A', relayUrl);
  await waitFor(() => /dashboard: http:\/\/127\.0\.0\.1:/.test(A.stderr()), 8000, 'dashboard A to start');
  ok('dashboard logged its 127.0.0.1 URL on startup');
  await waitFor(() => A.lastStatus() !== null, 8000, 'node A to emit a status');

  const stateRes = await req(A.dashPort, '/state', 'GET');
  (stateRes.status === 200) ? ok('GET /state → 200') : bad(`GET /state → ${stateRes.status}`);
  let state = {}; try { state = JSON.parse(stateRes.body); } catch {}
  const s = A.lastStatus();
  (state.ready === true) ? ok('/state reports ready:true once folded') : bad('/state not ready after fold');
  (state.address === s.address && state.address === A.address)
    ? ok('/state address == the node’s own status line (not hardcoded)')
    : bad(`/state address mismatch: ${state.address} vs ${s.address}`);
  (state.hash === s.hash)
    ? ok('/state ledger fingerprint == the node’s last emitted status hash')
    : bad(`/state hash mismatch: ${state.hash} vs ${s.hash}`);
  (state.members === s.members)
    ? ok(`/state members == the node’s status members (${state.members})`)
    : bad(`/state members mismatch: ${state.members} vs ${s.members}`);
  (JSON.stringify(state.balances) === JSON.stringify(s.balances))
    ? ok('/state balances == the node’s status balances (live, not invented)')
    : bad('/state balances differ from the status stream');
  (state.connection === 'connected')
    ? ok("/state connection reads 'connected' while the relay is up")
    : bad(`/state connection = ${state.connection}, expected connected`);
  (state.relay === relayUrl) ? ok('/state reports the real relay URL') : bad(`/state relay = ${state.relay}`);
  (typeof state.uptimeSec === 'number' && state.uptimeSec >= 0) ? ok('/state reports a numeric uptime') : bad('/state uptime missing');

  // ── refuse anything that could act ──────────────────────────────────────────
  console.log('\n  2 NO WRITE PATH — POST/PUT/DELETE refused');
  for (const m of ['POST', 'PUT', 'DELETE']) {
    const r = await req(A.dashPort, '/state', m);
    (r.status === 405 || r.status === 404)
      ? ok(`${m} /state → ${r.status} (cannot act)`)
      : bad(`${m} /state → ${r.status} (expected 405/404)`);
  }
  {
    const r = await req(A.dashPort, '/ignite', 'POST');
    (r.status === 405 || r.status === 404) ? ok('POST /ignite → refused (no such action)') : bad(`POST /ignite → ${r.status}`);
  }

  // ── unknown path 404 ────────────────────────────────────────────────────────
  console.log('\n  3 UNKNOWN PATHS 404');
  {
    const r = await req(A.dashPort, '/nope-not-a-route', 'GET');
    (r.status === 404) ? ok('GET /nope-not-a-route → 404') : bad(`unknown path → ${r.status}`);
  }
  {
    const r = await req(A.dashPort, '/', 'GET');
    (r.status === 200 && /MONEY/.test(r.body)) ? ok('GET / serves the dashboard HTML') : bad(`GET / → ${r.status}`);
  }
  {
    const r = await req(A.dashPort, '/logo.png', 'GET');
    (r.status === 200) ? ok('GET /logo.png serves the real logo') : bad(`GET /logo.png → ${r.status}`);
  }

  // ── NODE B: dead relay → honest not-ready shape ─────────────────────────────
  console.log('\n  4 NOT-READY SHAPE — before the first fold');
  const deadPort = await freePort();            // nothing will listen here
  const B = await spawnNode('dash-B', `ws://127.0.0.1:${deadPort}`);
  await waitFor(() => /dashboard: http:\/\/127\.0\.0\.1:/.test(B.stderr()), 8000, 'dashboard B to start');
  const rb = await req(B.dashPort, '/state', 'GET');
  let sb = {}; try { sb = JSON.parse(rb.body); } catch {}
  (rb.status === 200) ? ok('GET /state → 200 even before any fold') : bad(`/state → ${rb.status}`);
  (sb.ready === false) ? ok('/state reports ready:false when no status has folded yet') : bad(`/state ready = ${sb.ready}`);
  (!('balances' in sb)) ? ok('not-ready /state omits balances (no fabricated zeros)') : bad('not-ready /state fabricated a balances field');
  (typeof sb.address === 'string' && sb.address) ? ok('not-ready /state still reports the node’s own address') : bad('not-ready /state missing address');
  (sb.connection !== 'connected') ? ok(`not-ready /state connection is honest (${sb.connection})`) : bad('not-ready /state claims connected with a dead relay');

  // ── node survives without the dashboard when the port is taken ──────────────
  console.log('\n  5 DASHBOARD IS NEVER A DEPENDENCY');
  const taken = http.createServer((_q, s2) => s2.end('x'));
  const takenPort = await freePort();
  await new Promise((res) => taken.listen(takenPort, '127.0.0.1', res));
  {
    const id = mkIdentity('dash-C');
    const env = Object.assign({}, process.env, {
      MONEY_JSON: '1', NODE_LABEL: 'dash-C',
      FOUNDERS_JSON: JSON.stringify([id.address]),
      RELAY_URL: relayUrl, DASH_PORT: String(takenPort),
    });
    const proc = spawn(process.execPath, [RUN_NODE], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(proc);
    let err = '', sawStatus = false; let outbuf = '';
    proc.stderr.on('data', (d) => err += d.toString());
    proc.stdout.on('data', (d) => { outbuf += d.toString(); if (/"type":"status"/.test(outbuf)) sawStatus = true; });
    await waitFor(() => sawStatus, 8000, 'node C to run despite a taken dashboard port');
    (/dashboard NOT started/.test(err))
      ? ok('port taken → clear log, and the node keeps running normally')
      : bad('no clear "dashboard NOT started" log when the port was taken');
    (sawStatus) ? ok('node folded and emitted status with no dashboard bound') : bad('node did not run without the dashboard');
  }
  taken.close();

  relay.close();
  cleanup();

  console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Node dashboard: ${fails === 0 ? 'ALL PROBES PASS' : fails + ' FAILURE(S)'} — read-only 127.0.0.1 window; serves the node’s real state; cannot act.\n`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('   ❌  test harness error:', e && e.stack || e); cleanup(); process.exit(1); });
