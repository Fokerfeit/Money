// wallet.js — a phone's wallet. Talks to authority servers over HTTP.
const { sign, orderDigest, newKeypair, addressOf, toHex } = require('./crypto');

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
async function getState(url, address) {
  const r = await fetch(`${url}/state/${encodeURIComponent(address)}`);
  return r.ok ? r.json() : null;
}

class Wallet {
  constructor() {
    const kp = newKeypair();
    this.address = addressOf(kp.publicKey);
    this.pubKeyHex = toHex(kp.publicKey);
    this.secretKey = kp.secretKey;
  }

  build(to, amount, seq) {
    const order = { from: this.address, to, amount, seq, senderPubKey: this.pubKeyHex };
    const digest = orderDigest(order);
    return { order, digest, sig: sign(digest, this.secretKey) };
  }

  // committee = { members:[{name,url}], quorum }
  async transfer(committee, allAuthorities, to, amount, seq, opts = {}) {
    let { order, digest, sig } = this.build(to, amount, seq);
    if (opts.corruptSig) sig = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0');

    // phase 1 — broadcast order to the committee, gather votes (over the wire)
    const votes = [];
    const reasons = [];
    for (const m of committee.members) {
      const r = await post(`${m.url}/order`, { order, sig });
      if (r.ok) votes.push(r.vote); else reasons.push(r.reason);
    }
    if (votes.length < committee.quorum)
      return { finalized: false, votes: votes.length, reason: [...new Set(reasons)].join('; ') || 'no quorum' };

    // phase 2 — certify + apply across ALL authorities so the pool stays in sync
    const cert = { order, digest, votes: votes.slice(0, committee.quorum) };
    for (const a of allAuthorities) await post(`${a.url}/certificate`, { cert });
    return { finalized: true, votes: votes.length };
  }
}

module.exports = { Wallet, post, getState };
