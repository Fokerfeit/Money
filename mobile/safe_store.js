// mobile/safe_store.js — atomic, durable, fail-CLOSED JSON persistence.
//
// Replaces the fail-OPEN pattern (write-in-place; on any read error silently return
// {} / []). Failure classes that pattern caused: a torn write left garbage or an
// empty store (a silently-empty ledger wipes every balance); a corrupt store looked
// like a first boot → silent reset (which, for the nullifier store, freed a used
// nullifier to mint a SECOND time).
//
// GUARANTEES
//   • ATOMIC   : the main file is never a half-written state — write .tmp, fsync it,
//                rename over the target, fsync the directory. A reader always sees the
//                old-complete or new-complete file; a leftover .tmp is ignored.
//   • DURABLE  : fsync of the file AND the containing directory before returning, so a
//                rename that returned survives power-loss (best-effort on platforms
//                where directory fsync is unsupported).
//   • FAIL-CLOSED: loadStrict/loadUnion return the fallback ONLY on a genuine first
//                boot; a corrupt store with no recoverable backup THROWS. A file that
//                parses to a non-object, or an EMPTY main while a non-empty .bak
//                exists, is treated as corruption — never a silent reset.
//   • APPEND-ONLY SETS: saveAtomicDual + loadUnion keep the nullifier/codes sets safe
//                even against the classic ".bak lags by one" re-mint window — .bak
//                carries the NEW content (never lags), and load UNIONS both copies, so
//                a used key present in EITHER copy is never dropped.
'use strict';

const fs = require('fs');
const path = require('path');

const isParseable = (text) => {
  if (text == null) return false;
  try { JSON.parse(text); return true; } catch { return false; }
};

// write `data` to `p` and fsync the file descriptor before returning (durability).
function writeFsync(p, data) {
  const fd = fs.openSync(p, 'w');
  try { fs.writeSync(fd, data); try { fs.fsyncSync(fd); } catch { /* fsync unsupported → best effort */ } }
  finally { fs.closeSync(fd); }
}
// fsync a path best-effort (a rename is only durable once the DIRECTORY entry is flushed).
function fsyncPath(p) {
  let fd;
  try { fd = fs.openSync(p, fs.existsSync(p) && fs.statSync(p).isDirectory() ? 'r' : 'r+'); fs.fsyncSync(fd); }
  catch { /* directory fsync unsupported on some platforms (e.g. Windows) → best effort */ }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}

// saveAtomic(file, data, {dualBak}): stage .tmp (fsync'd) → preserve a .bak → atomic
// rename → fsync the directory. dualBak=false (default): .bak is the PREVIOUS good main
// (rollback semantics). dualBak=true (append-only sets): .bak is the NEW content, so it
// never lags the main — a single-copy corruption always leaves the full set in the other.
function saveAtomic(file, data, { dualBak = false } = {}) {
  const json = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const tmp = file + '.tmp';
  const bak = file + '.bak';
  writeFsync(tmp, json);                              // 1) stage the new bytes + flush
  if (dualBak) {
    // append-only set: .bak MUST carry the NEW content BEFORE main flips, or the
    // "never lags" invariant breaks. A copy/fsync failure PROPAGATES (no rename) — the
    // caller's seal() then throws and claim() returns seal-failed, refusing the mint,
    // rather than minting against a lagging backup (a re-mint window).
    fs.copyFileSync(tmp, bak); fsyncPath(bak);        // 2a) .bak := NEW content (fail-closed)
  } else {
    try {                                             // 2b) rollback .bak := current good main, best-effort
      if (fs.existsSync(file)) {
        const cur = fs.readFileSync(file, 'utf8');
        if (isParseable(cur)) { fs.copyFileSync(file, bak); fsyncPath(bak); }
      }
    } catch { /* a stale rollback .bak is the intended fallback; the atomic rename is the real guarantee */ }
  }
  fs.renameSync(tmp, file);                           // 3) atomic replace
  fsyncPath(path.dirname(file));                      // 4) make the rename durable
}
const saveAtomicDual = (file, data) => saveAtomic(file, data, { dualBak: true });

// parse a file to a non-null object/array, or undefined (missing/unreadable/wrong-shape).
// A top-level null/number/string/bool is treated as corruption (not a valid store).
function readObjOrArr(p) {
  try { const v = JSON.parse(fs.readFileSync(p, 'utf8')); return (v !== null && typeof v === 'object') ? v : undefined; }
  catch { return undefined; }
}
const isEmpty = (v) => v !== undefined && (Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0);

// loadStrict(file, fallback): fail-CLOSED.
//   • no file AND no .bak                     → fallback (genuine first boot)
//   • main parses (object/array) & not a wipe → main
//   • main missing/unparseable/wipe, .bak ok  → .bak
//   • BOTH unreadable                         → THROW
// "wipe" = main is EMPTY while .bak is NON-empty (main was reset externally) → prefer .bak.
function loadStrict(file, fallback) {
  const bak = file + '.bak';
  const hasFile = fs.existsSync(file);
  const hasBak  = fs.existsSync(bak);
  if (!hasFile && !hasBak) return fallback;          // pristine first boot
  const mv = hasFile ? readObjOrArr(file) : undefined;
  const bv = hasBak  ? readObjOrArr(bak)  : undefined;
  // prefer a valid main UNLESS it is empty while .bak holds data (a suspicious wipe).
  if (mv !== undefined && !(isEmpty(mv) && bv !== undefined && !isEmpty(bv))) return mv;
  if (bv !== undefined) return bv;
  throw new Error(`safe_store: "${file}" is unreadable/malformed and no valid backup exists — refusing to silently reset (fail-closed).`);
}

// loadUnion(file, fallback): for APPEND-ONLY OBJECT stores (nullifier, codes). UNIONS
// main + .bak so a key present in EITHER copy survives — closing the ".bak lags by one"
// re-mint window. First boot → fallback; both unreadable → THROW (fail-closed).
function loadUnion(file, fallback) {
  const bak = file + '.bak';
  const hasFile = fs.existsSync(file);
  const hasBak  = fs.existsSync(bak);
  if (!hasFile && !hasBak) return fallback;
  const readObj = (p) => { const v = readObjOrArr(p); return (v !== undefined && !Array.isArray(v)) ? v : undefined; };
  const a = hasFile ? readObj(file) : undefined;
  const b = hasBak  ? readObj(bak)  : undefined;
  if (a === undefined && b === undefined)
    throw new Error(`safe_store: "${file}" and its .bak are both unreadable — refusing to silently reset (fail-closed).`);
  return { ...(b || {}), ...(a || {}) };             // union; main overrides .bak on conflict (identical value for append-only)
}

module.exports = { saveAtomic, saveAtomicDual, loadStrict, loadUnion, isParseable };
