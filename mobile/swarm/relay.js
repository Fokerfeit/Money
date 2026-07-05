/**
 * MONEY — RELAY. The dumb post office. Runs on the server (e.g. your Hetzner
 * box). It holds ZERO authority over money. All it does:
 *
 *   1. accept WebSocket connections from phones
 *   2. re-broadcast every signed message it receives to all other phones
 *   3. archive the signed messages so a brand-new phone can sync
 *
 * It never validates a balance, never decides a winner, never holds a key.
 * If this server is hacked, the worst it can do is DROP or DELAY messages —
 * it can NOT forge a payment or steal a coin: it has nothing to sign with,
 * and every phone re-checks everything itself.
 *
 * PERSISTENCE: pass { dataFile } and every signed message is appended to a
 * JSONL file as it arrives; on boot the archive is reloaded, so a relay
 * restart forgets nothing. (Append-only on purpose: nothing in this file is
 * ever edited — matching the relay's no-authority design.)
 *
 *   node relay.js                       # ws://0.0.0.0:8080, no persistence
 *   DATA=swarm.jsonl node relay.js      # persistent archive
 *
 * BRICK 3 (Bite 2 — separate machines): three OPTIONAL, DEFAULT-OFF guards
 * (maxFrameBytes / maxConnPerSec / maxConnections) exist so a later bite that
 * exposes this relay on a public port has something to dial in; when unset,
 * every knob behaves EXACTLY as before — Bite 1's localhost tests, and this
 * relay's default CLI boot, are unchanged. `host` likewise defaults to unset
 * (all interfaces, today's behavior); pass '127.0.0.1' to bind loopback-only
 * for the SSH-tunnel deployment model (see NODE_RUN.md).
 */
const WS = require('ws');
const fs = require('fs');
const path = require('path');
const WSServer = WS.WebSocketServer || WS.Server;   // v8+ named export, or v7 .Server

function startRelay({
  port = 8080, host = undefined, dataFile = null, log = console.log,
  maxFrameBytes = null,     // e.g. 65536 — null/0 = no cap beyond ws's own default (unchanged)
  maxConnPerSec = null,     // e.g. 20 — per-connection message rate limit; null/0 = unlimited (unchanged)
  maxConnections = null,    // e.g. 50 — cap on simultaneous connections; null/0 = unlimited (unchanged)
} = {}) {
  const archive = [];            // every signed message ever seen (for sync)
  const seen = new Set();        // de-dup by message id
  const clients = new Set();
  const rateState = new Map();   // ws -> { count, windowStart } — only used when maxConnPerSec is set

  if (dataFile) {                // reload the archive from disk — restart-proof
    try {
      const lines = fs.readFileSync(dataFile, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try { const tx = JSON.parse(line); if (tx && tx.id && !seen.has(tx.id)) { seen.add(tx.id); archive.push(tx); } } catch {}
      }
      log(`[relay] restored ${archive.length} signed messages from ${dataFile}`);
    } catch { log(`[relay] no existing archive at ${dataFile} — starting fresh`); }
  }

  const persist = (tx) => {
    if (!dataFile) return;
    try {
      fs.mkdirSync(path.dirname(path.resolve(dataFile)), { recursive: true });
      fs.appendFileSync(dataFile, JSON.stringify(tx) + '\n');
    } catch (e) { log(`[relay] persist failed: ${e.message}`); }
  };

  // Only pass host/maxPayload if explicitly given — an omitted key means `ws`
  // gets EXACTLY the options object it always got, so default behavior
  // (bind all interfaces, ws's own built-in maxPayload) is byte-identical.
  const wssOpts = { port };
  if (host !== undefined) wssOpts.host = host;
  if (maxFrameBytes) wssOpts.maxPayload = maxFrameBytes;
  const wss = new WSServer(wssOpts);

  wss.on('connection', (ws) => {
    // Optional cap on simultaneous connections (off by default). Checked
    // BEFORE adding to `clients`, so the rejected socket never counts.
    if (maxConnections && clients.size >= maxConnections) {
      log(`[relay] connection refused — at capacity (${maxConnections})`);
      try { ws.close(1013, 'relay at capacity'); } catch {}
      return;
    }
    clients.add(ws);
    log(`[relay] phone connected (${clients.size} online)`);

    // Sync the newcomer: replay the whole signed archive. It re-validates
    // everything itself — we assert nothing.
    ws.send(JSON.stringify({ t: 'sync', msgs: archive }));

    ws.on('message', (raw) => {
      // Optional per-connection message rate limit (off by default). A
      // client over the limit just gets its excess messages silently
      // dropped — the relay has no authority to punish anyone, it only
      // ever drops or delays (see the header comment).
      if (maxConnPerSec) {
        const now = Date.now();
        let st = rateState.get(ws);
        if (!st || now - st.windowStart >= 1000) { st = { count: 0, windowStart: now }; rateState.set(ws, st); }
        st.count++;
        if (st.count > maxConnPerSec) return;
      }
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (!m || m.t !== 'gossip' || !m.tx || !m.tx.id) return;
      if (seen.has(m.tx.id)) return;
      seen.add(m.tx.id);
      archive.push(m.tx);
      persist(m.tx);
      const out = JSON.stringify({ t: 'gossip', tx: m.tx });
      for (const c of clients) if (c !== ws && c.readyState === 1) c.send(out);
    });

    ws.on('close', () => { clients.delete(ws); rateState.delete(ws); log(`[relay] phone left (${clients.size} online)`); });
    ws.on('error', () => { clients.delete(ws); rateState.delete(ws); });
  });

  log(`[relay] dumb post office on ws://${host || '0.0.0.0'}:${port} — holds no authority${dataFile ? `, archive: ${dataFile}` : ''}`);
  return {
    wss,
    stats: () => ({ clients: clients.size, archived: archive.length }),
    close: () => new Promise(res => wss.close(res)),
  };
}

module.exports = { startRelay };
if (require.main === module) startRelay({
  port: Number(process.env.PORT) || 8080,
  host: process.env.HOST || undefined,   // e.g. HOST=127.0.0.1 for the SSH-tunnel deployment model (see NODE_RUN.md)
  dataFile: process.env.DATA || null,
  maxFrameBytes:  process.env.MAX_FRAME_BYTES  ? Number(process.env.MAX_FRAME_BYTES)  : null,
  maxConnPerSec:  process.env.MAX_CONN_PER_SEC ? Number(process.env.MAX_CONN_PER_SEC) : null,
  maxConnections: process.env.MAX_CONNECTIONS  ? Number(process.env.MAX_CONNECTIONS)  : null,
});
