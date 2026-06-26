// mobile/ledger_chain.js — tamper-evident integrity layer over the ledger.
//
// ADDITIVE and PURE: imports nothing from the app and never touches balances,
// standing, or transaction rules. It treats the existing ledger (the txs array)
// as immutable input and derives a hash-linked, Merkle-rooted block chain whose
// single TIP HASH fingerprints the entire history. Anyone can rebuild the chain
// from the public txs and verify it WITHOUT trusting the operator.
'use strict';

const crypto = require('crypto');
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

const ZERO = '0'.repeat(64);
const DEFAULT_BLOCK_SIZE = 8;

// ── Canonical tx hash ────────────────────────────────────────────────────────
// Sorted keys → identical hash regardless of field insertion order. Money is
// integer (no float drift). ANY change to ANY field changes this hash.
function hashTx(tx) {
  const o = {};
  for (const k of Object.keys(tx).sort()) o[k] = tx[k];
  return sha256hex('TX:' + JSON.stringify(o));
}

// ── Merkle root (RFC 6962 / Certificate Transparency) ────────────────────────
// Domain-separated leaves vs internal nodes, split at the largest power of two
// strictly below n. This is CVE-2012-2459-SAFE: duplicating the final leaf yields
// a DIFFERENT root (different leaf count + structure), so a forged tree can never
// be passed off as the original; and a leaf hash can never be read as an internal
// node. (Unlike the naive "duplicate the last leaf when odd" Bitcoin tree.)
const LEAF = '\x00', NODE = '\x01';
function mth(leaves) {
  const n = leaves.length;
  if (n === 0) return sha256hex(LEAF + 'empty');
  if (n === 1) return sha256hex(LEAF + leaves[0]);
  let k = 1; while (k * 2 < n) k *= 2;            // largest power of two strictly < n
  return sha256hex(NODE + mth(leaves.slice(0, k)) + mth(leaves.slice(k)));
}
function merkleRoot(txs) {
  return mth(txs.map(hashTx));
}

// ── Block header hash ────────────────────────────────────────────────────────
// Pure function of (index, prevHash, merkleRoot, txCount). DETERMINISTIC — no
// wall-clock, no Map iteration — so the same ledger always yields the same hash,
// across process restarts. prevHash links the header to the entire prior history.
function blockHash(index, prevHash, root, txCount) {
  return sha256hex('BLK:' + JSON.stringify({ index, prevHash, merkleRoot: root, txCount }));
}

// ── Build the chain from the ledger (chronological: oldest → newest) ─────────
function buildChain(txsChrono, blockSize = DEFAULT_BLOCK_SIZE) {
  const blocks = [];
  let prevHash = ZERO;                              // genesis links to all-zero
  for (let i = 0; i < txsChrono.length; i += blockSize) {
    const txs = txsChrono.slice(i, i + blockSize);
    const index = blocks.length;
    const root = merkleRoot(txs);
    const h = blockHash(index, prevHash, root, txs.length);
    blocks.push({ index, prevHash, merkleRoot: root, txCount: txs.length, txs, blockHash: h });
    prevHash = h;
  }
  return { blocks, tip: blocks.length ? blocks[blocks.length - 1].blockHash : ZERO, blockSize, txCount: txsChrono.length };
}

function tipHash(chain) {
  const blocks = (chain && chain.blocks) || [];
  return blocks.length ? blocks[blocks.length - 1].blockHash : ZERO;
}

// ── Independent verification ─────────────────────────────────────────────────
// Validates the ENTIRE chain from genesis using ONLY the chain data (+ an
// optional externally-trusted expectedTip), with no access to operator state.
// Returns { valid, firstBadIndex, tip, reason }. firstBadIndex points at the
// first block that fails (−1 when valid). expectedTip catches truncation /
// full-rewrite (an internally-consistent chain that ends at the wrong head).
function verifyChain(chain, expectedTip) {
  const blocks = (chain && chain.blocks) || [];
  let prevHash = ZERO;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.index !== i)
      return { valid: false, firstBadIndex: i, tip: null, reason: `block ${i}: index mismatch` };
    if (b.prevHash !== prevHash)
      return { valid: false, firstBadIndex: i, tip: null, reason: `block ${i}: prevHash does not link to block ${i - 1}` };
    if (!Array.isArray(b.txs) || b.txs.length !== b.txCount)
      return { valid: false, firstBadIndex: i, tip: null, reason: `block ${i}: txCount mismatch (truncated/padded txs)` };
    if (merkleRoot(b.txs) !== b.merkleRoot)
      return { valid: false, firstBadIndex: i, tip: null, reason: `block ${i}: merkleRoot mismatch (a transaction was altered)` };
    if (blockHash(b.index, b.prevHash, b.merkleRoot, b.txCount) !== b.blockHash)
      return { valid: false, firstBadIndex: i, tip: null, reason: `block ${i}: blockHash mismatch (header was altered)` };
    prevHash = b.blockHash;
  }
  const tip = blocks.length ? blocks[blocks.length - 1].blockHash : ZERO;
  if (chain && chain.tip !== undefined && chain.tip !== tip)
    return { valid: false, firstBadIndex: blocks.length ? blocks.length - 1 : -1, tip, reason: 'stored tip != recomputed tip (rewrite)' };
  if (expectedTip !== undefined && tip !== expectedTip)
    return { valid: false, firstBadIndex: blocks.length ? blocks.length - 1 : -1, tip, reason: 'tip != expected (truncation or full rewrite)' };
  return { valid: true, firstBadIndex: -1, tip, reason: null };
}

module.exports = { sha256hex, hashTx, merkleRoot, blockHash, buildChain, verifyChain, tipHash, ZERO, DEFAULT_BLOCK_SIZE };
