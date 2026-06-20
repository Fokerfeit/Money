// crypto.js — ed25519 + MONEY address scheme + hashing.
const nacl = require('tweetnacl');
const crypto = require('crypto');

const toHex = u8 => Buffer.from(u8).toString('hex');
const fromHex = h => Uint8Array.from(Buffer.from(h, 'hex'));
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const sha256bytes = s => Uint8Array.from(crypto.createHash('sha256').update(s).digest());

const newKeypair = () => nacl.sign.keyPair();
// Deterministic key from a name → same identity survives a restart.
const keypairFromSeed = name => nacl.sign.keyPair.fromSeed(sha256bytes(name));

const addressOf = pub => 'M_' + toHex(pub).slice(0, 32).toUpperCase();

const sign = (msg, sk) => toHex(nacl.sign.detached(Buffer.from(msg, 'utf8'), sk));
const verify = (msg, sigHex, pub) => {
  try { return nacl.sign.detached.verify(Buffer.from(msg, 'utf8'), fromHex(sigHex), pub); }
  catch { return false; }
};

const canonicalOrder = o => JSON.stringify({
  amount: o.amount, from: o.from, senderPubKey: o.senderPubKey, seq: o.seq, to: o.to,
});
const orderDigest = o => sha256(canonicalOrder(o));

// per-account hash chain (Brick 1, per account)
const genesisTip = () => '0'.repeat(64);
const extendChain = (prevTip, t) =>
  sha256(JSON.stringify({ prevTip, from: t.from, to: t.to, amount: t.amount, seq: t.seq }));

module.exports = {
  toHex, fromHex, sha256, newKeypair, keypairFromSeed, addressOf,
  sign, verify, canonicalOrder, orderDigest, genesisTip, extendChain,
};
