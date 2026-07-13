// mobile/swarm/identity_store.js — load-or-create a node's REAL identity, persisted
// to disk, fail-CLOSED. Built for run_node.js's "download and run" path: a friend
// restarting their node must get the SAME address and balance back, not a fresh
// random one (swarm_engine.newId() mints a genuinely random keypair every call —
// by design, for the test suites that want many disposable throwaway identities per
// run — so something has to persist the ONE real identity across restarts).
//
// Reuses safe_store.js's existing atomic/fail-closed pattern (mobile/safe_store.js —
// already reviewed and live for the nullifier store and committee state) rather than
// inventing a new persistence mechanism:
//   • saveAtomic — stage .tmp (fsync'd) → atomic rename → fsync dir. The identity
//     file is written ONCE, before the caller ever announces/connects, so a crash
//     between "generated" and "saved" simply means next boot finds no file and
//     generates again — it can never leave a used-but-unsaved identity behind.
//   • loadStrict — fail-CLOSED: no file at all = genuine first boot (generate one).
//     A file that exists but is unreadable/unparseable THROWS rather than silently
//     falling back to "no file" — silently generating a replacement here would
//     orphan whatever balance was tied to the real identity. See loadOrCreate below.
//
// ADDITIVE ONLY: does not touch swarm_engine.js's newId() or its signature — this
// module is a thin, optional wrapper around it. Callers that don't want persistence
// (every existing test suite, which passes NODE_LABEL and gets committee_bridge's
// deterministic mkIdentity(label) instead — see run_node.js) never touch this file.
'use strict';

const nacl = require('tweetnacl');
const { saveAtomic, loadStrict } = require('../safe_store');
const { toHex, hexBytes, addrOf, newId } = require('./swarm_engine');

// A real ed25519 keypair's secret key is 64 bytes (seed || public key), tweetnacl's
// native representation. JSON has no byte-array type, so store it as hex.
function serialize(id) {
  return { name: id.name, address: id.address, pub: id.pub, sk: toHex(id.sk) };
}

// Deserialize + VALIDATE. A file can be syntactically valid JSON yet still be
// corrupted (truncated sk, a stray edit, a copy-paste mismatch) — re-derive the
// public key and address from sk and require they match what's on disk, so a
// half-corrupted file is caught here rather than silently producing a keypair that
// can't actually sign for the address it claims to be.
function deserialize(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('not a JSON object');
  const { name, address, pub, sk } = obj;
  if (typeof address !== 'string' || typeof pub !== 'string' || typeof sk !== 'string') {
    throw new Error('missing or non-string "address", "pub", or "sk" field');
  }
  let skBytes;
  try { skBytes = hexBytes(sk); } catch { throw new Error('"sk" is not valid hex'); }
  if (skBytes.length !== 64) throw new Error(`"sk" is ${skBytes.length} bytes, expected 64 (ed25519 secret key)`);
  const derivedPub = toHex(nacl.sign.keyPair.fromSecretKey(skBytes).publicKey);
  if (derivedPub !== pub) throw new Error('"pub" does not match the public key derived from "sk" — file is corrupted or was hand-edited');
  if (addrOf(pub) !== address) throw new Error('"address" does not match "pub" — file is corrupted or was hand-edited');
  return { name: name || address, address, pub, sk: skBytes };
}

// loadOrCreate(file, name): the one function run_node.js calls.
//   • file doesn't exist (and no .bak)  → generate via newId(name), persist, return it.
//   • file exists and is valid          → return the identity it encodes.
//   • file exists but is corrupted/     → THROW with a clear, actionable message.
//     invalid/tampered, no valid .bak     Never silently generates a replacement —
//                                          that would silently orphan the real balance.
function loadOrCreate(file, name) {
  const FRESH = Symbol('no-identity-file-yet');
  let raw;
  try {
    raw = loadStrict(file, FRESH);
  } catch (e) {
    throw new Error(
      `Identity file "${file}" exists but is unreadable and no valid backup ("${file}.bak") was found.\n` +
      `Refusing to generate a new identity — that would silently abandon any balance tied to the existing one.\n` +
      `Restore "${file}" (or "${file}.bak") from a backup and restart. Underlying error: ${e.message}`
    );
  }
  if (raw === FRESH) {
    const id = newId(name);
    saveAtomic(file, serialize(id));
    return id;
  }
  try {
    return deserialize(raw);
  } catch (e) {
    throw new Error(
      `Identity file "${file}" was found but is invalid: ${e.message}.\n` +
      `Refusing to generate a new identity — that would silently abandon any balance tied to the existing one.\n` +
      `Restore "${file}" from a backup, or if you are certain this identity was never funded, delete "${file}" ` +
      `(and "${file}.bak" if present) and restart to generate a fresh one.`
    );
  }
}

module.exports = { loadOrCreate, serialize, deserialize };
