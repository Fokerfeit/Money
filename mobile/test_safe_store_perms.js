// mobile/test_safe_store_perms.js — regression test for Cowork's CRITICAL finding
// on commit 4b73844: safe_store.js wrote files via fs.openSync(p, 'w') with no
// explicit mode, so the file's permissions came from the process/system umask
// (typically 0o644 — world-readable). Harmless for most of safe_store's existing
// callers, but identity_store.js uses it to persist a node's PRIVATE KEY
// (identity.json) — a world-readable wallet file is a real vulnerability on any
// shared/multi-user box. Every probe must pass; exit 0.
//
//   1 MAIN FILE MODE     — saveAtomic's main file is 0o600, regardless of umask
//   2 DUAL-BAK MODE      — saveAtomicDual's .bak copy is also 0o600
//   3 ROLLBACK-BAK MODE  — saveAtomic's rollback .bak (default dualBak=false,
//                          written on a second save) is also 0o600
//   4 IDENTITY FILE MODE — end-to-end: identity_store.loadOrCreate's real
//                          identity.json (the actual file this bite protects)
//                          is 0o600
//   5 UMASK-INDEPENDENT  — same result under a permissive umask(0o000), proving
//                          the fix is an explicit mode, not an accident of this
//                          machine's default umask
//
// ⚠️ PLATFORM NOTE: NTFS (Windows) does not implement POSIX owner/group/other
// permission bits — Node's fs on Windows can only distinguish "writable" (always
// reported as 0o666, regardless of which mode was requested — 0o600, 0o644, and
// 0o777 are all indistinguishable here) from "read-only" (0o444). Verified
// empirically: opening with mode 0o600 and mode 0o777 both come back as 0o666 on
// this filesystem. So on win32, exact-mode assertions are SKIPPED (not silently
// passed, not falsely failed) with a loud note — the fix must be confirmed on the
// actual Linux deployment target (Hetzner), where these bits are real. On
// linux/darwin, every probe below is a hard assert.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { saveAtomic, saveAtomicDual } = require('./safe_store');
const identityStore = require('./swarm/identity_store');

let fails = 0;
let skipped = 0;
const ok   = (m) => console.log(`   ✅  ${m}`);
const bad  = (m) => { fails++; console.log(`   ❌  ${m}`); };
const skip = (m) => { skipped++; console.log(`   ⏭️  SKIPPED (platform limitation): ${m}`); };

const IS_WINDOWS = process.platform === 'win32';
const modeOf = (p) => fs.statSync(p).mode & 0o777;

// On win32, a mode is only checkable as "matches 0o600" if this filesystem can
// even represent 0o600 (it can't — see header). Everywhere else, assert exactly.
function assertMode(p, label) {
  const m = modeOf(p);
  if (IS_WINDOWS) {
    // best this platform can verify: the file is writable at all (not flipped
    // to Windows' read-only attribute by mistake) — NOT proof of 0o600.
    if (m === 0o666 || m === 0o600) skip(`${label} — NTFS can't distinguish 0o600 from 0o666; got 0o${m.toString(8)}, verify on Linux`);
    else bad(`${label} is 0o${m.toString(8)} — even Windows' coarse writable/read-only distinction looks wrong`);
    return;
  }
  if (m === 0o600) ok(`${label} is 0o600 (got 0o${m.toString(8)})`);
  else bad(`${label} is 0o${m.toString(8)}, expected 0o600 — WORLD-READABLE if group/other bits set`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'safe_store_perm_'));

console.log('\n  SAFE_STORE — FILE PERMISSIONS (Cowork CRITICAL finding on 4b73844)\n');
if (IS_WINDOWS) console.log(`  ⚠️  Running on win32 — exact POSIX mode bits are not checkable on NTFS.\n     This suite verifies the CODE requests 0o600; the actual OS-level\n     guarantee can only be confirmed on the Linux deployment target.\n`);

// ── PROBE 0: the CODE requests mode 0o600 — platform-independent ───────────
// The OS-level checks below (assertMode) depend on the filesystem actually
// honoring the requested mode, which NTFS doesn't (see header). This probe
// instead intercepts fs.openSync/fs.chmodSync to record what mode safe_store.js
// itself asks for — a real regression guard on ANY platform, since it doesn't
// rely on what the OS does with that request.
{
  const realOpenSync = fs.openSync;
  const realChmodSync = fs.chmodSync;
  const openModes = []; const chmodModes = [];
  fs.openSync = (p, flags, mode) => { if (flags === 'w' || flags === fs.constants.O_WRONLY) openModes.push(mode); return realOpenSync(p, flags, mode); };
  fs.chmodSync = (p, mode) => { chmodModes.push(mode); return realChmodSync(p, mode); };
  try {
    const f = path.join(TMP, 'probe0_main.json');
    saveAtomic(f, { v: 1 });                     // exercises writeFsync (openSync)
    saveAtomic(f, { v: 2 });                      // exercises the rollback-bak chmod path
    const fDual = path.join(TMP, 'probe0_dual.json');
    saveAtomicDual(fDual, { v: 1 });              // exercises the dual-bak chmod path
  } finally {
    fs.openSync = realOpenSync;
    fs.chmodSync = realChmodSync;
  }
  if (openModes.length > 0 && openModes.every((m) => m === 0o600)) ok(`fs.openSync always called with mode 0o600 (${openModes.length} call(s))`);
  else bad(`fs.openSync was called with mode(s) [${openModes.map((m) => '0o' + (m || 0).toString(8)).join(', ')}], expected all 0o600`);
  if (chmodModes.length > 0 && chmodModes.every((m) => m === 0o600)) ok(`fs.chmodSync always called with mode 0o600 (${chmodModes.length} call(s), covers both .bak paths)`);
  else bad(`fs.chmodSync was called with mode(s) [${chmodModes.map((m) => '0o' + (m || 0).toString(8)).join(', ')}], expected all 0o600`);
}

// ── PROBE 1: main file ──────────────────────────────────────────────────────
{
  const f = path.join(TMP, 'main.json');
  saveAtomic(f, { hello: 'world' });
  assertMode(f, 'saveAtomic main file');
}

// ── PROBE 2: dual-bak .bak ──────────────────────────────────────────────────
{
  const f = path.join(TMP, 'dual.json');
  saveAtomicDual(f, { a: 1 });
  assertMode(f + '.bak', 'saveAtomicDual .bak');
}

// ── PROBE 3: rollback .bak (written on a SECOND save of the same file) ─────
{
  const f = path.join(TMP, 'rollback.json');
  saveAtomic(f, { v: 1 });          // first save: no .bak yet (nothing to roll back to)
  saveAtomic(f, { v: 2 });          // second save: now a rollback .bak (old content) is written
  assertMode(f + '.bak', 'saveAtomic rollback .bak');
}

// ── PROBE 4: the actual identity.json path (end-to-end, the real fix target) ─
{
  const f = path.join(TMP, 'identity.json');
  identityStore.loadOrCreate(f, 'perm-test-node');
  assertMode(f, "identity_store.loadOrCreate's identity.json (the private key file)");
}

// ── PROBE 5: independent of the process/system umask ────────────────────────
{
  const f = path.join(TMP, 'umask_check.json');
  let prevUmask;
  try { prevUmask = process.umask(0o000); } catch { prevUmask = undefined; }   // most permissive possible umask (no-op on win32)
  try {
    saveAtomic(f, { x: 1 });
    assertMode(f, 'file saved under umask(0o000)');
  } finally {
    if (prevUmask !== undefined) process.umask(prevUmask);   // restore — don't leak a process-wide umask change
  }
}

fs.rmSync(TMP, { recursive: true, force: true });

const summary = fails === 0
  ? (skipped > 0 ? `\n✅ ALL CHECKABLE PROBES PASSED (${skipped} skipped — platform limitation, see note above)\n` : '\n✅ ALL PROBES PASSED\n')
  : `\n❌ ${fails} PROBE(S) FAILED\n`;
console.log(summary);
process.exit(fails === 0 ? 0 : 1);
