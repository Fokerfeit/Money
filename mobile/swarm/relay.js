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
 */
const WS = require('ws');
const fs = require('fs');
const path = require('path');
const WSServer = WS.WebSocketServer || WS.Server;   // v8+ named export, or v7 .Server

function startRelay({ port = 8080, dataFile = null, log = console.log } = {}) {
  const archive = [];            // every signed message ever seen (for sync)
  const seen = new Set();        // de-dup by message id
  const clients = new Set();

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

  const wss = new WSServer({ port });
  wss.on('connection', (ws) => {
    clients.add(ws);
    log(`[relay] phone connected (${clients.size} online)`);

    // Sync the newcomer: replay the whole signed archive. It re-validates
    // everything itself — we assert nothing.
    ws.send(JSON.stringify({ t: 'sync', msgs: archive }));

    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (!m || m.t !== 'gossip' || !m.tx || !m.tx.id) return;
      if (seen.has(m.tx.id)) return;
      seen.add(m.tx.id);
      archive.push(m.tx);
      persist(m.tx);
      const out = JSON.stringify({ t: 'gossip', tx: m.tx });
      for (const c of clients) if (c !== ws && c.readyState === 1) c.send(out);
    });

    ws.on('close', () => { clients.delete(ws); log(`[relay] phone left (${clients.size} online)`); });
    ws.on('error', () => { clients.delete(ws); });
  });

  log(`[relay] dumb post office on ws://0.0.0.0:${port} — holds no authority${dataFile ? `, archive: ${dataFile}` : ''}`);
  return {
    wss,
    stats: () => ({ clients: clients.size, archived: archive.length }),
    close: () => new Promise(res => wss.close(res)),
  };
}

module.exports = { startRelay };
if (require.main === module) startRelay({ port: Number(process.env.PORT) || 8080, dataFile: process.env.DATA || null });
