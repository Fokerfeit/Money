// ── MONEY — App passcode (tester batch, Oct 2026, item 2) ─────────────────────
//
// An OPTIONAL app passcode the user creates themselves (6–12 digits), as an
// alternative or backup to the phone's own lock. It is a GATE ONLY: it decides
// whether the app opens / a send is confirmed. It does NOT encrypt the wallet key
// (that stays in SecureStore, protected by the phone) — to be revisited before
// mainnet.
//
//   • never stored in plaintext: scrypt(passcode, 16-byte random salt), the
//     parameters stored WITH the hash so they can be raised later; compared in
//     constant time. Tuned at creation to cost ≥ ~250 ms on THIS device.
//   • attempt limits: after 5 wrong tries, escalating waits 30 s → 1 min → 5 min →
//     15 min → 60 min (every further try). The only feedback is "wrong passcode" +
//     tries left — never which digit was wrong. Counters live in secure storage,
//     so restarting the app does not reset them.
//   • unlock mode: 'device' (phone lock only — the DEFAULT), 'passcode', 'either'.
//     'passcode' only is refused until the 24-word backup has been completed.
//   • recovery: ONLY the 24-word restore (resetForRestore) — no back door.
//
// Honest limits: a 6-digit code has 1,000,000 possibilities and its lockout is
// enforced by the app, not by secure hardware like the phone's own lock — moving
// the phone's clock forward can shorten a wait, and anyone who extracts the phone's
// storage can try codes offline (slowed, not stopped, by scrypt).
//
// PURE module: storage, randomness and clock are INJECTED (App.js passes
// SecureStore / expo-crypto / Date.now), so the exact logic is executed by
// test_tester_batch_oct.js under plain Node.
'use strict';

const { scryptAsync } = require('@noble/hashes/scrypt.js');

const KEY_HASH   = 'app_passcode_v1';
const KEY_LOCK   = 'app_passcode_lock_v1';
const KEY_MODE   = 'unlock_mode_v1';
const KEY_BACKUP = 'wallet_backup_confirmed_v1';

const MODES = ['device', 'passcode', 'either'];
const DEFAULT_MODE = 'device';
const FREE_TRIES = 5;                                          // wrong tries before the first wait
const WAITS_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const MIN_LEN = 6, MAX_LEN = 12;
// scrypt N = 2^14 … 2^15 (memory = 128·N·r: 16 MB … 32 MB — kept phone-safe)
const MIN_COST_MS = 250, START_LOG_N = 14, MAX_LOG_N = 15;

const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => new Uint8Array((h.match(/.{2}/g) || []).map((b) => parseInt(b, 16)));
const sameBytes = (a, b) => {                                  // constant-time for equal lengths
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
};

const isValidPasscode = (code) => typeof code === 'string' && /^[0-9]+$/.test(code) && code.length >= MIN_LEN && code.length <= MAX_LEN;

// wait (ms) imposed after `fails` consecutive wrong tries
const waitAfter = (fails) => (fails < FREE_TRIES ? 0 : WAITS_MS[Math.min(fails - FREE_TRIES, WAITS_MS.length - 1)]);

function createPasscodeStore({ storage, randomBytes, now = () => Date.now(), kdf = scryptAsync, minCostMs = MIN_COST_MS }) {
  const getJSON = async (k) => { try { const v = await storage.getItemAsync(k); return v ? JSON.parse(v) : null; } catch { return null; } };
  const setJSON = (k, v) => storage.setItemAsync(k, JSON.stringify(v));
  const derive = (code, salt, N, r, p) => kdf(code, salt, { N, r, p, dkLen: 32 });

  return {
    MIN_LEN, MAX_LEN, FREE_TRIES, WAITS_MS, isValidPasscode,

    async hasPasscode() { return !!(await getJSON(KEY_HASH)); },

    // Create / replace the passcode. Calibrates scrypt so one check costs ≥ minCostMs here.
    async setPasscode(code) {
      if (!isValidPasscode(code)) throw new Error(`passcode must be ${MIN_LEN}–${MAX_LEN} digits`);
      const salt = randomBytes(16);
      let logN = START_LOG_N, hash, t0;
      for (;;) {
        t0 = now();
        hash = await derive(code, salt, 2 ** logN, 8, 1);
        if (now() - t0 >= minCostMs || logN >= MAX_LOG_N) break;
        logN++;
      }
      await setJSON(KEY_HASH, { v: 1, alg: 'scrypt', N: 2 ** logN, r: 8, p: 1, salt: toHex(salt), hash: toHex(hash) });
      await setJSON(KEY_LOCK, { fails: 0, lockedUntil: 0 });
      return { N: 2 ** logN };
    },

    // → { ok: true } | { ok: false, reason: 'wrong', triesLeft, waitMs } | { ok: false, reason: 'locked', waitMs } | { ok:false, reason:'none' }
    async verify(code) {
      const rec = await getJSON(KEY_HASH);
      if (!rec) return { ok: false, reason: 'none' };
      const lock = (await getJSON(KEY_LOCK)) || { fails: 0, lockedUntil: 0 };
      const t = now();
      if (lock.lockedUntil > t) return { ok: false, reason: 'locked', waitMs: lock.lockedUntil - t };
      const got = isValidPasscode(code) ? await derive(code, fromHex(rec.salt), rec.N, rec.r, rec.p) : new Uint8Array(0);
      if (got.length && sameBytes(got, fromHex(rec.hash))) {
        await setJSON(KEY_LOCK, { fails: 0, lockedUntil: 0 });
        return { ok: true };
      }
      const fails = (lock.fails || 0) + 1;
      const waitMs = waitAfter(fails);
      await setJSON(KEY_LOCK, { fails, lockedUntil: waitMs ? now() + waitMs : 0 });
      return { ok: false, reason: 'wrong', triesLeft: Math.max(0, FREE_TRIES - fails), waitMs };
    },

    async lockState() {
      const lock = (await getJSON(KEY_LOCK)) || { fails: 0, lockedUntil: 0 };
      return { fails: lock.fails || 0, waitMs: Math.max(0, (lock.lockedUntil || 0) - now()) };
    },

    async getMode() {
      const m = await storage.getItemAsync(KEY_MODE).catch(() => null);
      return MODES.includes(m) ? m : DEFAULT_MODE;
    },

    // Changing the mode is the CALLER's job to authorise (current method first);
    // here we enforce the invariants that must hold whatever the UI does.
    async setMode(mode) {
      if (!MODES.includes(mode)) throw new Error('unknown unlock mode');
      if (mode !== 'device' && !(await getJSON(KEY_HASH))) throw new Error('create an app passcode first');
      if (mode === 'passcode' && (await storage.getItemAsync(KEY_BACKUP).catch(() => null)) !== '1')
        throw new Error('back up your 24 words first — they are the only way back in if you forget the passcode');
      await storage.setItemAsync(KEY_MODE, mode);
      return mode;
    },

    async markBackupConfirmed() { await storage.setItemAsync(KEY_BACKUP, '1'); },
    async isBackupConfirmed() { return (await storage.getItemAsync(KEY_BACKUP).catch(() => null)) === '1'; },

    // The ONLY recovery: a completed 24-word restore. Clears the passcode, its
    // counters and the mode (back to the phone lock). No other path removes it.
    async resetForRestore() {
      for (const k of [KEY_HASH, KEY_LOCK, KEY_MODE]) { try { await storage.deleteItemAsync(k); } catch {} }
      await storage.setItemAsync(KEY_BACKUP, '1');   // the user just proved they hold the 24 words
    },
  };
}

module.exports = { createPasscodeStore, isValidPasscode, waitAfter, MODES, DEFAULT_MODE, FREE_TRIES, WAITS_MS, KEY_HASH, KEY_LOCK, KEY_MODE, KEY_BACKUP };
