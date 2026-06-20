// authority.js — authority validation + apply logic, with disk persistence.
const fs = require('fs');
const path = require('path');
const {
  verify, addressOf, fromHex, toHex, sign, orderDigest,
  keypairFromSeed, genesisTip, extendChain,
} = require('./crypto');

class Authority {
  constructor(name, dataDir) {
    this.name = name;
    const kp = keypairFromSeed('authority:' + name); // stable identity across restarts
    this.publicKey = kp.publicKey;
    this.secretKey = kp.secretKey;
    this.authPubKeyHex = toHex(kp.publicKey);
    this.file = path.join(dataDir, name + '.json');
    this.accounts = {};   // addr -> {balance,nextSeq,standing,tip,pubKeyHex}
    this.locks = {};      // addr -> {seq -> digest}
    this._load();
  }

  _load() {
    if (fs.existsSync(this.file)) {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.accounts = d.accounts || {};
      this.locks = d.locks || {};
    }
  }
  _save() {
    fs.writeFileSync(this.file, JSON.stringify({ accounts: this.accounts, locks: this.locks }));
  }

  register(address, pubKeyHex, balance, standing) {
    if (this.accounts[address]) return; // idempotent
    this.accounts[address] = { balance, nextSeq: 0, standing, tip: genesisTip(), pubKeyHex };
    this.locks[address] = {};
    this._save();
  }

  handleOrder(order, sig) {
    const a = this.accounts[order.from];
    if (!a) return { ok: false, reason: 'unknown account' };
    const pub = fromHex(order.senderPubKey);
    if (addressOf(pub) !== order.from) return { ok: false, reason: 'pubkey != address' };
    const digest = orderDigest(order);
    if (!verify(digest, sig, pub)) return { ok: false, reason: 'bad signature' };
    if (order.seq !== a.nextSeq) return { ok: false, reason: `wrong seq (want ${a.nextSeq}, got ${order.seq})` };
    if (!(order.amount > 0)) return { ok: false, reason: 'amount must be > 0' };
    if (order.amount > a.standing) return { ok: false, reason: `over standing (${a.standing})` };
    if (order.amount > a.balance) return { ok: false, reason: 'insufficient balance' };

    const locked = this.locks[order.from][order.seq];
    if (locked && locked !== digest) return { ok: false, reason: 'LOCKED to a different transfer (double-spend)' };
    this.locks[order.from][order.seq] = digest;
    this._save();

    return { ok: true, vote: { authority: this.name, sig: sign(digest, this.secretKey), authPubKey: this.authPubKeyHex } };
  }

  handleCertificate(cert, quorum) {
    const a = this.accounts[cert.order.from];
    if (!a) return { ok: false, reason: 'unknown account' };
    const seen = new Set(); let valid = 0;
    for (const v of cert.votes) {
      if (seen.has(v.authority)) continue;
      if (verify(cert.digest, v.sig, fromHex(v.authPubKey))) { valid++; seen.add(v.authority); }
    }
    if (valid < quorum) return { ok: false, reason: `not enough votes (${valid}/${quorum})` };
    if (cert.order.seq < a.nextSeq) return { ok: true, already: true };
    if (cert.order.seq !== a.nextSeq) return { ok: false, reason: 'seq gap' };

    a.balance -= cert.order.amount;
    a.nextSeq += 1;
    a.tip = extendChain(a.tip, cert.order);
    const r = this.accounts[cert.order.to];
    if (r) r.balance += cert.order.amount;
    this._save();
    return { ok: true, applied: true, newBalance: a.balance, tip: a.tip };
  }
}

module.exports = { Authority };
