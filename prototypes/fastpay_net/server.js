// server.js — wrap an Authority in a real HTTP server (talks over the wire).
const http = require('http');
const { Authority } = require('./authority');

function readJson(req) {
  return new Promise((res) => {
    let b = '';
    req.on('data', c => (b += c));
    req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch { res({}); } });
  });
}

// Returns { authority, server, port, url, close() }
function startAuthority(name, port, dataDir, quorumRef) {
  const authority = new Authority(name, dataDir);
  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const body = ['POST', 'PUT'].includes(req.method) ? await readJson(req) : {};
    try {
      if (req.method === 'POST' && req.url === '/register') {
        authority.register(body.address, body.pubKeyHex, body.balance, body.standing);
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && req.url === '/order') return send(200, authority.handleOrder(body.order, body.sig));
      if (req.method === 'POST' && req.url === '/certificate') return send(200, authority.handleCertificate(body.cert, quorumRef()));
      if (req.method === 'GET' && req.url.startsWith('/state/')) {
        const addr = decodeURIComponent(req.url.slice('/state/'.length));
        const a = authority.accounts[addr];
        return a ? send(200, { balance: a.balance, nextSeq: a.nextSeq, tip: a.tip }) : send(404, { ok: false });
      }
      send(404, { ok: false, reason: 'no route' });
    } catch (e) { send(500, { ok: false, reason: String(e) }); }
  });
  return new Promise((resolve) => {
    server.listen(port, () => resolve({
      authority, server, port, name,
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise(r => server.close(r)),
    }));
  });
}

module.exports = { startAuthority };
