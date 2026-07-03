// mobile/safe_store.js — atomic, fail-CLOSED JSON persistence.
//
// Replaces the fail-OPEN pattern (write-in-place; on any read error silently return
// {} / []). Two failure classes that pattern caused:
//   • a torn/interrupted write left a half-written file → next boot read garbage or,
//     worse, reset the store to empty (a silently-empty ledger wipes every balance);
//   • a corrupt store looked identical to a first boot → silent reset (which, for the
//     nullifier store, freed a used nullifier to mint a SECOND time).
//
// saveAtomic writes a sidecar then atomically renames it over the target, keeping the
// previous good copy as .bak. loadStrict returns the fallback ONLY for a genuine first
// boot; a corrupt store with no recoverable backup THROWS rather than silently reset.
'use strict';

const fs = require('fs');

const isParseable = (text) => {
  if (text == null) return false;
  try { JSON.parse(text); return true; } catch { return false; }
};

// saveAtomic(file, data): stage `.tmp` → preserve current-good as `.bak` → atomic
// rename `.tmp`→file. THROWS on I/O failure so callers can surface it (the server's
// saveJSON wrapper swallows+logs to stay up; the committee persist re-throws with
// context). The rename is the guarantee: the main file is NEVER a half-written state
// — a reader always sees either the old complete file or the new complete file.
function saveAtomic(file, data) {
  const json = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const tmp = file + '.tmp';
  const bak = file + '.bak';
  fs.writeFileSync(tmp, json);                       // 1) stage the new bytes in a sidecar
  try {                                              // 2) preserve the current file as .bak — ONLY if it is
    if (fs.existsSync(file)) {                       //    currently valid, so a torn/corrupt main file can never
      const cur = fs.readFileSync(file, 'utf8');     //    overwrite a known-good backup
      if (isParseable(cur)) fs.copyFileSync(file, bak);
    }
  } catch { /* backup is best-effort; the atomic rename below is the real guarantee */ }
  fs.renameSync(tmp, file);                          // 3) atomic replace (POSIX rename / NTFS MoveFileEx-replace)
}

// loadStrict(file, fallback): fail-CLOSED.
//   • no file AND no .bak            → fallback   (genuine first boot — nothing was ever written)
//   • main parses                    → main
//   • main missing/unparseable, .bak parses → .bak   (recover from the last good copy)
//   • BOTH unparseable               → THROW      (refuse to silently reset a store that held data)
// A leftover garbage `.tmp` is ignored entirely (an interrupted write that never
// completed the rename), so a torn write can never surface as data.
function loadStrict(file, fallback) {
  const bak = file + '.bak';
  const hasFile = fs.existsSync(file);
  const hasBak  = fs.existsSync(bak);
  if (!hasFile && !hasBak) return fallback;          // pristine first boot
  // A valid store is a JSON object or array. Content that parses to a top-level
  // null/number/string/bool is treated as CORRUPTION (not returned), so a file of
  // literal `null` can never slip past as a silent reset. readOne returns undefined
  // for missing/unreadable/wrong-shape, so the caller falls through to .bak / throw.
  const readOne = (p) => {
    try { const v = JSON.parse(fs.readFileSync(p, 'utf8')); return (v !== null && typeof v === 'object') ? v : undefined; }
    catch { return undefined; }
  };
  if (hasFile) { const v = readOne(file); if (v !== undefined) return v; }
  if (hasBak)  { const v = readOne(bak);  if (v !== undefined) return v; }
  throw new Error(`safe_store: "${file}" is unreadable/malformed and no valid backup exists — refusing to silently reset (fail-closed).`);
}

module.exports = { saveAtomic, loadStrict, isParseable };
