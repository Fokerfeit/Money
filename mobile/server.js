const express   = require('express');
const cors      = require('cors');
const fs        = require('fs');
const path      = require('path');
const nacl      = require('tweetnacl');
const rateLimit = require('express-rate-limit');
const ledgerChain = require('./ledger_chain');   // Brick 1: tamper-evident integrity layer (additive, read-only)
const selfGate    = require('./self_gate');      // Self personhood-ignition gate (pure; @selfxyz loaded lazily only if enabled)
const safeStore   = require('./safe_store');     // atomic, fail-closed JSON persistence (saveAtomic / loadStrict)

const app = express();
// SECURITY: default to NOT trusting X-Forwarded-For (0). A directly-exposed or
// LAN server then keys the rate-limiter / ignition throttle on the real socket
// IP, which a client CANNOT spoof. Set TRUST_PROXY=1 ONLY when behind a trusted
// proxy that overwrites/appends the real client IP — otherwise a client can forge
// X-Forwarded-For and bypass the per-IP ignition throttle (unlimited-mint vector).
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 0));
app.use(cors());
app.use(express.json({ limit: '16kb' }));

// ── File paths ─────────────────────────────────────────────────────────────
// Overridable via env so tests (and alternate deployments) can point at an
// isolated data directory instead of clobbering the production ledger.
const DATA_DIR             = process.env.MONEY_DATA_DIR || __dirname;
const LEDGER_FILE          = process.env.MONEY_LEDGER_FILE   || path.join(DATA_DIR, 'ledger.json');
const REPLAY_FENCE_FILE    = process.env.MONEY_FENCE_FILE    || path.join(DATA_DIR, 'replay_fence.json');
const USED_CODES_FILE      = process.env.MONEY_CODES_FILE    || path.join(DATA_DIR, 'ignition_codes_used.json');

// ── Persistence helpers ────────────────────────────────────────────────────
// loadJSON stays fail-OPEN — used only for the committee SHADOW state, which is
// designed to rebuild from central on a miss (a reset there is safe, not lossy).
const loadJSON = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
};
// saveJSON now writes ATOMICALLY (safe_store): tmp → rename, keeping a .bak. The main
// file is never a half-written state. We still swallow+log a write failure so a
// transient disk error can't crash the server mid-request; the on-disk file stays
// intact (old-complete or new-complete, never torn).
const saveJSON = (file, data) => {
  try { safeStore.saveAtomic(file, data); }
  catch (e) { console.error(`Save error (${path.basename(file)}):`, e.message); }
};

// ── Load state ──────────────────────────────────────────────────────────────
// FAIL-CLOSED: a ledger that EXISTS but is unreadable (and has no recoverable .bak)
// must REFUSE to boot. A silently-empty ledger would wipe every balance — the single
// most catastrophic failure. A genuine first boot (no file, no .bak) → [] as before.
let txs;
try {
  txs = safeStore.loadStrict(LEDGER_FILE, []);
} catch (e) {
  console.error(`[FATAL] ${e.message}`);
  console.error('Refusing to boot: a silently-empty ledger would erase every balance. Restore ledger.json (or its .bak) and retry.');
  process.exit(1);
}

// ── In-memory indexes for O(1) targeted lookups ──────────────────────────────
// The scalability fix: instead of every client re-downloading the ENTIRE ledger
// to find one payment (cost grows with total history), they query GET /tx with
// a from/to/since filter served from these indexes (cost bounded by recent/
// relevant activity). Rebuilt from txs on startup, kept in sync on each commit.
// Arrays stay newest-first, matching the txs array.
const idxFrom = new Map(); // address -> tx[]
const idxTo   = new Map(); // address -> tx[]
function indexTx(tx, prepend) {
  for (const [map, key] of [[idxFrom, tx.from], [idxTo, tx.to]]) {
    if (!key) continue;
    let arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    if (prepend) arr.unshift(tx); else arr.push(tx);
  }
}
// txs is newest-first; iterate oldest→newest with prepend so index arrays also
// end up newest-first.
for (let i = txs.length - 1; i >= 0; i--) indexTx(txs[i], true);

// replay_fence.json stores { messageKey: timestampMs } — a persistent replay
// fence so a signature can never be replayed, even across a server restart.
// The replay fence recovers from .bak if the main file is corrupt; if BOTH are
// unreadable it self-heals to empty (SAFE: entries are time-gated to a 2-minute
// window and pruned constantly, so a reset only briefly re-opens replay — never a
// re-mint). This is the one store where fail-open is the correct trade.
let seenSigs;
try { seenSigs = safeStore.loadStrict(REPLAY_FENCE_FILE, {}); }
catch (e) { console.error(`[replay-fence] unreadable with no backup — resetting (safe: time-gated). ${e.message}`); seenSigs = {}; }

// ── Anti-Sybil: server-issued single-use invite (ignition) codes ────────────
// IGNITION_CODES (comma-separated) are codes YOU hand out. The server controls
// them, so — unlike a client-supplied id or token — they CANNOT be forged. When
// non-empty, a faucet claim must present a valid, UNUSED code, and each code
// seals exactly one identity. This is the one-per-human gate for the sovereignty
// model: identity itself is the user's on-device keypair (no third-party login);
// Sybil resistance is layered on top via invite codes → vouching → validator
// eligibility → faucet decay.
const IGNITION_CODES = new Set(
  (process.env.IGNITION_CODES || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
);
// FAIL-CLOSED: the used-invite-code ledger is a re-mint vector — if it silently reset
// to {}, every consumed code would look unused and could mint again. Recover from
// .bak; refuse to boot if both are unreadable. First boot (no file, no .bak) → {}.
let usedCodes;
try {
  usedCodes = safeStore.loadStrict(USED_CODES_FILE, {});   // code → address (consumed)
} catch (e) {
  console.error(`[FATAL] ${e.message}`);
  console.error('Refusing to boot: a reset invite-code ledger would let already-used codes mint again.');
  process.exit(1);
}

// ── Platform recipient allowlist ────────────────────────────────────────────
// Addresses (comma-separated in MONEY_PLATFORM_ADDRESSES) that may RECEIVE
// transfers without having ignited via the faucet — e.g. the nocopycART
// marketplace wallet. They are NOT faucet users, hold no minted balance, and
// are not counted in userCount(). They can still SPEND normally (signed tx +
// balance accrued from payments received).
const PLATFORM_ADDRESSES = new Set(
  (process.env.MONEY_PLATFORM_ADDRESSES || '')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
);

// ── Prune expired replay-fence entries on startup ───────────────────────────
// We keep sigs for 10 minutes — wider than the 2-minute timestamp window
// so a sig can never be replayed even across a server restart.
const REPLAY_WINDOW_MS = 10 * 60 * 1000;
const pruneSeenSigs = () => {
  const cutoff = Date.now() - REPLAY_WINDOW_MS;
  let pruned = 0;
  for (const [sig, ts] of Object.entries(seenSigs)) {
    if (ts < cutoff) { delete seenSigs[sig]; pruned++; }
  }
  if (pruned > 0) console.log(`[replay-fence] pruned ${pruned} expired signatures`);
};
pruneSeenSigs();
saveJSON(REPLAY_FENCE_FILE, seenSigs);

// Prune automatically every 5 minutes so the file stays bounded
setInterval(() => { pruneSeenSigs(); saveJSON(REPLAY_FENCE_FILE, seenSigs); }, 5 * 60 * 1000);

console.log(`MONEY server — ${txs.length} txs loaded`);

// ── Helpers ──────────────────────────────────────────────────────────────────
const fromHex    = (hex) => new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)));
const toAddress  = (pk)  => 'M_' + pk.substring(0, 32).toUpperCase();
const userCount  = ()    => new Set(txs.filter(t => t.from === 'FAUCET').map(t => t.to)).size;

// Authoritative faucet reward — MUST mirror calcReward() in App.js.
// The reward halves-ish (×0.8) per million users. The server computes this
// itself and caps the claim so a modified client can't mint an arbitrary amount.
const calcReward = (count) => {
  const tiers = Math.floor(count / 1_000_000);
  let r = 1_000_000;
  for (let i = 0; i < tiers; i++) r *= 0.8;
  return Math.max(Math.floor(r), 1);
};

const getBalance = (addr) =>
  txs.reduce((b, t) => t.to === addr ? b + t.amount : t.from === addr ? b - t.amount : b, 0);
// -- Standing & movement cap ---------------------------------------------
// Standing = trust EARNED, not money. Your whole million is always yours;
// standing decides how much you can MOVE at once. Computed live from the ledger:
//   • ignited (passed the invite-code gate) → a baseline you can move
//   • + 1 for each DISTINCT address you've dealt with (diversity, not volume —
//     two accounts ping-ponging can never pump it)
const MOVE_PER_STANDING = 10000;  // each standing point unlocks 10k of movement
const IGNITED_BASELINE  = 5;      // a freshly-ignited human can move 50k to start

const isIgnited = (addr) => txs.some(t => t.from === 'FAUCET' && t.to === addr);

const distinctCounterparties = (addr) => {
  const seen = new Set();
  for (const t of txs) {
    if (t.from === addr && t.to !== 'FAUCET' && t.to !== addr) seen.add(t.to);
    if (t.to === addr && t.from !== 'FAUCET' && t.from !== addr) seen.add(t.from);
  }
  return seen.size;
};

const standingOf = (addr) =>
  (isIgnited(addr) ? IGNITED_BASELINE : 0) + distinctCounterparties(addr);

const movableNow = (addr) =>
  Math.min(getBalance(addr), standingOf(addr) * MOVE_PER_STANDING);

// ── Phase-0 LEDGER SEAM ──────────────────────────────────────────────────────
// All ledger access — reads, derivations, and the single commit path — is routed
// through ONE LedgerBackend object. Today there is exactly one implementation:
// `central` (the in-process append-only ledger above), selected by
// LEDGER_BACKEND=central (the default). This is PURE PLUMBING — every method
// delegates to the existing functions verbatim; no logic changes. The seam is the
// hook a future committee backend plugs into without the routes ever changing.
function createCentralLedger() {
  return {
    all:        () => txs,
    size:       () => txs.length,
    balance:    getBalance,
    standingOf,
    movableNow,
    userCount,
    isIgnited,
    // GET /tx scan — moved here verbatim from the route (index-served, capped).
    query: ({ from, to, since, reason, limit }) => {
      const sinceTs = since ? Number(since) : 0;
      const cap = Math.min(Math.max(parseInt(limit || '200', 10) || 200, 1), 1000);
      // Pick the most selective index to scan from (from is the common case).
      let base;
      if (from) base = idxFrom.get(from) || [];
      else if (to) base = idxTo.get(to) || [];
      else base = txs; // no from/to → full scan (discouraged; still capped)
      const out = [];
      for (const t of base) {
        if (from && t.from !== from) continue;
        if (to && t.to !== to) continue;
        if (sinceTs && !(t.timestamp >= sinceTs)) continue;
        if (reason && !String(t.reason || '').includes(reason)) continue;
        out.push(t);
        if (out.length >= cap) break;
      }
      return out;
    },
    // The SINGLE write path: append + index + persist the ledger file.
    commit: (tx) => {
      txs.unshift(tx);
      indexTx(tx, true);
      saveJSON(LEDGER_FILE, txs);
    },
  };
}

// ── COMMITTEE backend (READ-ONLY SHADOW, DURABLE in Phase 2) ─────────────────
// A second LedgerBackend modelled on prototypes/fastpay_net (per-account state).
// It ingests the SAME committed txs as central and computes each account's
// balance & standing INDEPENDENTLY — it NEVER serves a user response. Standing
// uses the IDENTICAL rule as central (ported standingOf: IGNITED_BASELINE once
// ignited, +1 per DISTINCT counterparty excluding FAUCET and self; movable =
// min(balance, standing × MOVE_PER_STANDING) — no static standing).
// Phase 2 — DURABLE: persists per-account state to its OWN file (never
// ledger.json), reloads it on boot, catches up via resync(), is IDEMPOTENT
// (a tx already applied is a no-op), and enforces INTEGER money end-to-end.
function createCommitteeLedger() {
  const STATE_FILE    = process.env.MONEY_COMMITTEE_FILE || path.join(DATA_DIR, 'committee_state.json');
  const STATE_VERSION = 3;
  const accounts   = new Map(); // addr -> { balance, ignited, counterparties:Set, nextSeq }
  const appliedIds = new Set(); // idempotency: stable per-tx keys already applied
  let   applied    = [];        // the committee's OWN ledger view (newest-first, like central) — serves /ledger
  let appliedCount = 0;

  const acct = (addr) => {
    let a = accounts.get(addr);
    if (!a) { a = { balance: 0, ignited: false, counterparties: new Set(), nextSeq: 0 }; accounts.set(addr, a); }
    return a;
  };
  // Stable durable identity for a committed tx: server timestamp + signature-
  // derived sigPrefix + from/to/amount — two distinct payments never collide.
  const txKey = (tx) => `${tx.from}:${tx.to}:${tx.amount}:${tx.timestamp}:${tx.sigPrefix}`;

  // Apply one finalized transfer. IDEMPOTENT (already-applied → no-op) and
  // INTEGER-ONLY (a non-integer amount is rejected; money stays whole end-to-end).
  const applyTx = (tx) => {
    const { from, to, amount } = tx;
    if (!Number.isInteger(amount)) throw new Error(`committee rejects non-integer amount: ${amount}`);
    const id = txKey(tx);
    if (appliedIds.has(id)) return false;   // idempotent no-op (replay / catch-up safe)
    appliedIds.add(id);
    applied.unshift(tx);                     // maintain the committee's ledger view (newest-first, like central)
    const f = acct(from), t = acct(to);
    t.balance += amount;
    f.balance -= amount;
    f.nextSeq += 1;
    if (from === 'FAUCET') t.ignited = true;
    if (to   !== 'FAUCET' && to   !== from) f.counterparties.add(to);   // sender gains recipient
    if (from !== 'FAUCET' && from !== to)   t.counterparties.add(from); // recipient gains sender
    appliedCount += 1;
    return true;
  };

  // ── durable persistence to the committee's OWN store (NEVER ledger.json) ──
  // Phase 3: persist THROWS on write failure so the error is SURFACED (caught by
  // the shadow → reconciler.noteError → /debug/shadow), never silently swallowed.
  const persist = () => {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        version: STATE_VERSION, appliedCount, applied,
        accounts: Object.fromEntries([...accounts].map(([addr, a]) =>
          [addr, { balance: a.balance, ignited: a.ignited, counterparties: [...a.counterparties], nextSeq: a.nextSeq }])),
      }));
    } catch (e) {
      throw new Error(`committee persist failed (${path.basename(STATE_FILE)}): ${e.message}`);
    }
  };
  const load = () => {
    const d = loadJSON(STATE_FILE, null);
    if (!d || d.version !== STATE_VERSION) return;
    appliedCount = d.appliedCount || 0;
    applied = Array.isArray(d.applied) ? d.applied : [];
    for (const tx of applied) appliedIds.add(txKey(tx));   // rebuild idempotency index from the ledger view
    for (const [addr, a] of Object.entries(d.accounts || {}))
      accounts.set(addr, { balance: a.balance, ignited: !!a.ignited, counterparties: new Set(a.counterparties || []), nextSeq: a.nextSeq || 0 });
  };
  load();   // boot: restore persisted state before catch-up

  const balance    = (addr) => (accounts.get(addr)?.balance ?? 0);
  const isIgnited  = (addr) => (accounts.get(addr)?.ignited ?? false);
  const standingOf = (addr) => (isIgnited(addr) ? IGNITED_BASELINE : 0) + (accounts.get(addr)?.counterparties.size ?? 0);
  const movableNow = (addr) => Math.min(balance(addr), standingOf(addr) * MOVE_PER_STANDING);
  const userCount  = () => { let n = 0; for (const a of accounts.values()) if (a.ignited) n++; return n; };

  return {
    // Phase 3: the committee SERVES reads (via the read-source layer). all()
    // returns the committee's own ledger view; query() stays guarded (/tx is still
    // served by central). Reads are committee-sourced with central verify+fallback.
    all:   () => applied,
    query: () => { throw new Error('committee.query() is not a committee-served read in Phase 3 (/tx stays central)'); },
    size:  () => appliedCount,
    appliedCount: () => appliedCount,
    balance, standingOf, movableNow, userCount, isIgnited,
    // live write path: apply + durably persist (idempotent, integer-only)
    commit: (tx) => { const ok = applyTx(tx); if (ok) persist(); return ok; },
    // boot catch-up / resync: replay central's ledger oldest→newest. Idempotent,
    // so it applies every MISSING tx and double-applies NONE. Persists only if it
    // actually applied something (so a no-op resync can't fail an unwritable boot).
    resync: (centralTxsNewestFirst) => {
      let n = 0;
      for (let i = centralTxsNewestFirst.length - 1; i >= 0; i--) if (applyTx(centralTxsNewestFirst[i])) n++;
      if (n > 0) persist();
      return n;
    },
    // test-only hook: perturb committee balance IN-MEMORY (never persisted) to force
    // a committee≠central divergence — used by /debug/shadow/perturb to prove the
    // read layer serves central, not the wrong value.
    __perturbBalance: (addr, delta) => { acct(addr).balance += delta; },
    debugSnapshot: () => {
      const out = {};
      for (const [addr, a] of accounts) {
        if (addr === 'FAUCET' || addr === 'SWARM_RESERVE') continue;
        out[addr] = { balance: a.balance, standing: standingOf(addr), movable: movableNow(addr),
                      ignited: a.ignited, counterparties: [...a.counterparties].sort(), nextSeq: a.nextSeq };
      }
      return out;
    },
  };
}

// ── RECONCILER ───────────────────────────────────────────────────────────────
// Two layers: a fast per-commit check on touched accounts, AND an ACTIVE full
// reconciliation (report/fullReconcile) that recomputes committee-vs-central
// across ALL accounts — valid even after a restart with no new commits. Both are
// observe-only: they record drift and NEVER throw into the commit path (central
// has already committed; the user response must stay unaffected). Test fails on drift.
function createReconciler(central, committee) {
  const liveDrifts = [], errors = [];
  const reads = { committee: 0, central: 0 };   // read-source tally — proves the source flip + fallback/divergence routing
  const SYSTEM = new Set(['FAUCET', 'SWARM_RESERVE']);
  const check = (tx) => {
    for (const addr of [tx.from, tx.to].filter((a) => a && !SYSTEM.has(a))) {
      const cb = central.balance(addr),    kb = committee.balance(addr);
      if (cb !== kb) liveDrifts.push({ when: 'live', field: 'balance',  addr, central: cb, committee: kb });
      const cs = central.standingOf(addr), ks = committee.standingOf(addr);
      if (cs !== ks) liveDrifts.push({ when: 'live', field: 'standing', addr, central: cs, committee: ks });
    }
    const csz = central.size(), ksz = committee.size();
    if (csz !== ksz) liveDrifts.push({ when: 'live', field: 'size', central: csz, committee: ksz });
  };
  const noteRead  = (source) => { if (source === 'committee') reads.committee++; else reads.central++; };
  const noteError = (e, ctx) => errors.push({
    error: String((e && e.message) || e),
    ...(ctx && ctx.read ? { read: ctx.read, kind: ctx.kind } : { from: ctx && ctx.from, to: ctx && ctx.to, amount: ctx && ctx.amount }),
  });
  // ACTIVE reconciliation across every account in central's ledger ∪ committee.
  const fullReconcile = () => {
    const addrs = new Set();
    for (const t of central.all()) for (const a of [t.from, t.to]) if (a && !SYSTEM.has(a)) addrs.add(a);
    for (const a of Object.keys(committee.debugSnapshot())) addrs.add(a);
    const drifts = [];
    for (const addr of addrs) {
      const cb = central.balance(addr), kb = committee.balance(addr);
      if (cb !== kb) drifts.push({ field: 'balance',  addr, central: cb, committee: kb });
      const cs = central.standingOf(addr), ks = committee.standingOf(addr);
      if (cs !== ks) drifts.push({ field: 'standing', addr, central: cs, committee: ks });
    }
    if (central.size() !== committee.size()) drifts.push({ field: 'size', central: central.size(), committee: committee.size() });
    return drifts;
  };
  const report = () => {
    const drifts = fullReconcile();
    return {
      backend: 'committee-shadow',
      reconciled: drifts.length === 0 && liveDrifts.length === 0 && errors.length === 0,
      driftCount: drifts.length, liveDriftCount: liveDrifts.length, errorCount: errors.length,
      reads,
      drifts: drifts.slice(0, 20), liveDrifts: liveDrifts.slice(0, 20), errors: errors.slice(0, 5),
      size: { central: central.size(), committee: committee.size() },
      appliedCount: committee.appliedCount(),
      accounts: committee.debugSnapshot(),
    };
  };
  return { check, noteError, noteRead, report, fullReconcile };
}

// ── Phase-1 SHADOWED ledger ──────────────────────────────────────────────────
// Central stays authoritative for EVERY response (all reads delegate to it,
// byte-identical). The only added behaviour is on commit: after central commits
// exactly as today, the committee ingests the same tx and the reconciler checks
// it — both wrapped so a committee fault can NEVER affect the user response.
function createShadowedLedger(central, committee, reconciler) {
  return {
    ...central, // every read/response comes from central — unchanged
    commit: (tx) => {
      central.commit(tx); // authoritative — exactly as today
      try {
        committee.commit(tx);   // shadow ingests the same tx
        reconciler.check(tx);   // observe-only equivalence check
      } catch (e) {
        reconciler.noteError(e, tx); // swallow — the shadow must never affect the response
      }
    },
  };
}

// ── Phase-3 COMMITTEE READ SOURCE ─────────────────────────────────────────────
// User-facing reads are SOURCED from the committee, with central as VERIFY +
// FALLBACK backstop. For each read: compute central's authoritative value, then
// the committee's; if the committee read throws (fault/unavailable) or DIVERGES
// from central, log it via reconciler.noteError and serve CENTRAL — never the
// wrong value, never a user-facing 500. Otherwise serve the committee value
// (committee-sourced). The WRITE path does NOT use this layer — it keeps reading
// from central via `ledger` exactly as Phase 2 (writes stay central-authoritative).
function createCommitteeReadSource(central, committee, reconciler) {
  let fault = false;            // test hook: force committee reads to throw (fallback proof)
  let lastSource = 'central';
  const eq = (a, b) => (a !== null && typeof a === 'object' ? JSON.stringify(a) === JSON.stringify(b) : a === b);
  const read = (name, kfn, cfn) => {
    const cval = cfn();                       // central = authoritative verify / fallback value
    let kval;
    try {
      if (fault) throw new Error('committee read fault (injected)');
      kval = kfn();
    } catch (e) {
      reconciler.noteError(e, { read: name, kind: 'fallback' });
      reconciler.noteRead('central'); lastSource = 'central';
      return cval;                            // FALLBACK → central; caller never sees a throw
    }
    if (!eq(kval, cval)) {
      reconciler.noteError(new Error(`read divergence on ${name}`), { read: name, kind: 'divergence' });
      reconciler.noteRead('central'); lastSource = 'central';
      return cval;                            // DIVERGENCE SAFETY → serve central (authoritative)
    }
    reconciler.noteRead('committee'); lastSource = 'committee';
    return kval;                              // committee-sourced (verified == central)
  };
  return {
    all:        ()  => read('all',        () => committee.all(),        () => central.all()),
    size:       ()  => read('size',       () => committee.size(),       () => central.size()),
    balance:    (a) => read('balance',    () => committee.balance(a),    () => central.balance(a)),
    standingOf: (a) => read('standingOf', () => committee.standingOf(a), () => central.standingOf(a)),
    movableNow: (a) => read('movableNow', () => committee.movableNow(a), () => central.movableNow(a)),
    userCount:  ()  => read('userCount',  () => committee.userCount(),   () => central.userCount()),
    isIgnited:  (a) => read('isIgnited',  () => committee.isIgnited(a),  () => central.isIgnited(a)),
    lastReadSource: () => lastSource,
    __setFault: (v) => { fault = !!v; },
    __perturb:  (addr, delta) => committee.__perturbBalance(addr, delta),
  };
}

const LEDGER_BACKEND = process.env.LEDGER_BACKEND || 'central';
let shadowReconciler = null; // set in committee-shadow mode; exposed read-only via /debug/shadow
let shadowResync = null;     // handle to re-run committee catch-up on demand (idempotent)
let shadowReads  = null;     // Phase-3 committee-sourced read layer (central verify + fallback); null in central mode
const ledger = (() => {
  if (LEDGER_BACKEND === 'central') return createCentralLedger();
  if (LEDGER_BACKEND === 'committee-shadow') {
    // Central authoritative; committee runs as a DURABLE read-only shadow.
    const central = createCentralLedger();
    try {
      const committee = createCommitteeLedger();   // loads its OWN persisted state
      committee.resync(central.all());             // boot catch-up: replay any txs it is behind on
      shadowReconciler = createReconciler(central, committee);
      shadowResync = () => committee.resync(central.all());
      shadowReads  = createCommitteeReadSource(central, committee, shadowReconciler); // flip user reads → committee
      return createShadowedLedger(central, committee, shadowReconciler);
    } catch (e) {
      // A committee/persistence fault must NEVER stop the authoritative server.
      console.error('[committee-shadow] boot failed — central-only, live unaffected:', e.message);
      return central;
    }
  }
  throw new Error(`Unknown LEDGER_BACKEND "${LEDGER_BACKEND}" (expected "central" or "committee-shadow")`);
})();
console.log(`Ledger backend: ${LEDGER_BACKEND}`);

// ── Canonical-S (anti-malleability) ─────────────────────────────────────────
// ed25519 signatures are malleable: both S and S+L verify. tweetnacl does NOT
// enforce S < L, so a re-encoded variant of a captured signature would pass.
// We reject any non-canonical signature so a captured transfer cannot be
// malleated into a "new" signature and double-applied.
const ED25519_L = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;
const leToBig = (bytes) => { let n = 0n; for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]); return n; };
const isCanonicalSig = (sigHex) => { try { const b = fromHex(sigHex); return b.length === 64 && leToBig(b.slice(32)) < ED25519_L; } catch { return false; } };

const verifyTx = (from, to, amount, timestamp, signature, publicKey) => {
  try {
    if (!isCanonicalSig(signature)) return false;   // reject malleable / non-canonical signatures
    const msg = Buffer.from(`${from}:${to}:${amount}:${timestamp}`);
    return nacl.sign.detached.verify(msg, fromHex(signature), fromHex(publicKey));
  } catch { return false; }
};

// ── Per-IP ignition throttle ──────────────────────────────────────────────
// Caps brute-force Sybil farming: 3 ignition attempts per IP per hour.
// This is separate from the general rate limiter because ignition is irreversible.
const ignitionAttempts = new Map(); // ip → { count, resetAt }
// Production: 3 valid-signature ignition attempts per IP per hour.
// The throttle is placed AFTER signature verification so only legitimate
// key-owners burn the budget — random bots cannot forge sigs to exhaust
// the throttle for a real user.
const MAX_IGNITION_PER_HOUR = process.env.NODE_ENV === 'test' ? 1000 : 3;

const checkIgnitionThrottle = (ip) => {
  const now  = Date.now();
  const slot = ignitionAttempts.get(ip) || { count: 0, resetAt: now + 60 * 60 * 1000 };
  if (now > slot.resetAt) { slot.count = 0; slot.resetAt = now + 60 * 60 * 1000; }
  if (slot.count >= MAX_IGNITION_PER_HOUR) return false;
  slot.count++;
  ignitionAttempts.set(ip, slot);
  return true;
};

// ── Failed ignition-code throttle (anti-brute-force) ─────────────────────────
// Wrong/used code guesses are capped per IP per hour. Without this, an attacker
// could brute-force the ignition codes at the general 20/min rate. With it,
// guessing is throttled to a crawl even if a code has low entropy.
const codeFails = new Map(); // ip -> { count, resetAt }
const MAX_CODE_FAILS = process.env.NODE_ENV === 'test' ? 100000 : 10;
const tooManyCodeFails = (ip) => {
  const now = Date.now();
  const slot = codeFails.get(ip) || { count: 0, resetAt: now + 60 * 60 * 1000 };
  if (now > slot.resetAt) { slot.count = 0; slot.resetAt = now + 60 * 60 * 1000; }
  codeFails.set(ip, slot);
  return slot.count >= MAX_CODE_FAILS;
};
const noteCodeFail = (ip) => { const s = codeFails.get(ip); if (s) s.count++; };

// ── Rate limiting ──────────────────────────────────────────────────────────
app.use('/transaction', rateLimit({
  windowMs: 60 * 1000, max: 20,
  message: { error: 'Too many requests — slow down.' },
}));
// Real DoS protection: the public READ endpoints were unthrottled, so a flood of
// /ledger or /balance could pin the single Node process. Cap them too.
app.use(['/ledger', '/tx', '/balance', '/usercount'], rateLimit({
  windowMs: 60 * 1000, max: 120,
  message: { error: 'Too many requests — slow down.' },
}));

// ── Routes ────────────────────────────────────────────────────────────────
app.get('/health',    (req, res) => res.json({ status: 'ok', transactions: ledger.size(), seals: ledger.userCount() }));
app.get('/usercount', (req, res) => res.json({ count: (shadowReads || ledger).userCount() }));
// ── Brick 1: tamper-evident tip ──────────────────────────────────────────────
// A single hash that fingerprints the ENTIRE ledger (hash-linked blocks, each
// with a Merkle root over its txs). Anyone can rebuild the chain from GET /ledger
// and confirm it ends at this tip — verification without trusting the operator.
// Additive + read-only: it derives from the existing ledger, changing no money rule.
app.get('/tip', (req, res) => {
  const chain = ledgerChain.buildChain([...ledger.all()].reverse());   // newest-first → chronological
  res.json({ tip: chain.tip, blocks: chain.blocks.length, txs: chain.txCount, blockSize: chain.blockSize });
});
app.get('/ledger',    (req, res) => res.json((shadowReads || ledger).all()));

// ── Targeted lookup ──────────────────────────────────────────────────────────
// GET /tx?from=&to=&since=&reason=&limit=  → only the matching txs, newest-first.
// This is what payment-verifying clients (e.g. nocopycART) should use instead of
// GET /ledger: served from the in-memory indexes so the cost is bounded by
// recent/relevant activity, NOT by the total size of the ledger.
app.get('/tx', (req, res) => {
  res.json(ledger.query(req.query));
});

app.get('/balance/:addr', (req, res) => {
  const bal = (shadowReads || ledger).balance(req.params.addr);
  res.json({ address: req.params.addr, balance: Math.max(0, parseFloat(bal.toFixed(2))) });
});

app.post('/transaction', (req, res) => {
  let { from, to, amount, reason, signature, publicKey, timestamp, ignitionCode } = req.body;
ignitionCode = (ignitionCode || '').trim().toUpperCase();

  // ── Basic field validation ─────────────────────────────────────────────
  if (!from || !to || amount == null)
    return res.status(400).json({ error: 'Missing required fields' });

  const amt = parseFloat(amount);
  if (isNaN(amt) || !isFinite(amt) || amt <= 0 || !Number.isInteger(amt))
    return res.status(400).json({ error: 'Invalid amount (whole numbers only)' });

  // ── Timestamp freshness ────────────────────────────────────────────────
  // Reject anything older than 2 minutes or from the future (±30s tolerance).
  // This is the FIRST line of replay defence — stale transactions die here
  // without touching the replay fence. Applies to EVERY transaction: there are
  // no unsigned "system" transactions over this endpoint anymore (see below).
  {
    const age = Date.now() - Number(timestamp);
    if (!timestamp || isNaN(age) || age > 2 * 60 * 1000 || age < -30_000)
      return res.status(401).json({ error: 'Transaction timestamp expired or invalid' });
  }

  // ── Signature verification ─────────────────────────────────────────────
  if (from === 'FAUCET') {
    if (!signature || !publicKey || !timestamp)
      return res.status(401).json({ error: 'Ignition must include signature, publicKey, and timestamp' });
    if (toAddress(publicKey) !== to)
      return res.status(401).json({ error: 'Public key does not match destination address' });
    if (!verifyTx('FAUCET', to, amt, timestamp, signature, publicKey))
      return res.status(401).json({ error: 'Invalid ignition signature — rejected' });

  } else {
    // Every non-faucet transaction — including disconnect_penalty — must be
    // signed by the sender. (There is deliberately no unsigned "system" path:
    // the app never sends from SWARM_RESERVE, and an unsigned bypass would let
    // anyone mint from the reserve or burn any victim's balance via a forged
    // penalty. System-originated transactions, if ever needed, must be created
    // in-process — not accepted over this public endpoint.)
    if (!signature || !publicKey || !timestamp)
      return res.status(401).json({ error: 'Transaction must include signature, publicKey, and timestamp' });
    if (toAddress(publicKey) !== from)
      return res.status(401).json({ error: 'Public key does not match sender address' });
    if (!verifyTx(from, to, amt, timestamp, signature, publicKey))
      return res.status(401).json({ error: 'Invalid signature — transaction rejected' });
  }

  // ── Replay fence — keyed on the SIGNED MESSAGE, checked AFTER verification ──
  // (1) Keying on the message (from:to:amount:timestamp) instead of the signature
  //     string makes malleability useless: a re-encoded signature of the same
  //     payment maps to the same key and is rejected.
  // (2) Checking AFTER verification means a forged/unverified request can no
  //     longer poison the fence to block a victim's legitimate transaction.
  const fenceKey = `${from}:${to}:${amt}:${timestamp}`;
  if (seenSigs[fenceKey])
    return res.status(401).json({ error: 'Duplicate transaction — already processed' });
  seenSigs[fenceKey] = Date.now();

  // ─────────────────────────────────────────────────────────────────────
  // ── IGNITION-ONLY GATES ───────────────────────────────────────────────
  // These checks run only for faucet claims (the ignition transaction).
  // ─────────────────────────────────────────────────────────────────────
  if (from === 'FAUCET') {
    const ip = req.ip || 'unknown';

    // Gate 0: server-issued single-use invite (ignition) code — the one-per-human
    // gate. Wrong/used guesses are throttled per IP so codes can't be brute-forced.
    if (IGNITION_CODES.size > 0) {
      if (tooManyCodeFails(ip))
        return res.status(429).json({ error: 'Too many invalid codes from this network — locked for 1 hour.' });
      if (!ignitionCode || !IGNITION_CODES.has(ignitionCode)) { noteCodeFail(ip); return res.status(403).json({ error: 'A valid invite code is required to seal.' }); }
      if (usedCodes[ignitionCode]) { noteCodeFail(ip); return res.status(403).json({ error: 'This invite code has already been used — one seal per code.' }); }
    } else {
      // No codes configured. Refusing is the safe default: an open faucet with no
      // gate lets anyone mint money in a loop. Set IGNITION_CODES to open it.
      console.error('[FAUCET] BLOCKED: no IGNITION_CODES set — refusing claim.');
      return res.status(503).json({ error: 'The faucet is not open yet.' });
    }

    // Gate 1: One faucet claim per wallet address
    if (ledger.isIgnited(to))
      return res.status(400).json({ error: 'This address has already been ignited' });

    // Gate 2: Reward cap — the server computes the authoritative reward and rejects
    // any claim above it (a modified client cannot sign itself a bigger faucet).
    const maxReward = calcReward(ledger.userCount());
    if (amt > maxReward)
      return res.status(400).json({ error: `Faucet reward exceeds the current allowance (max ${maxReward})` });

    // Gate 3: Per-IP ignition throttle (only valid-signature attempts burn it).
    if (!checkIgnitionThrottle(ip))
      return res.status(429).json({ error: 'Too many ignition attempts from this network — try again in 1 hour' });
  }

  // ── Recipient must be a registered Swarm node (or a known platform) ──────
  const systemAddresses = ['FAUCET', 'SWARM_RESERVE'];
  const isAllowedRecipient = systemAddresses.includes(to) || PLATFORM_ADDRESSES.has(to);
  if (!isAllowedRecipient && from !== 'FAUCET') {
    if (!ledger.isIgnited(to))
      return res.status(400).json({ error: 'Recipient is not a registered Swarm node' });
  }

  // ── Balance check ──────────────────────────────────────────────────────
  // Applies to every non-faucet sender, including disconnect_penalty — a user
  // can never send (or be penalised) more than they hold. No negative balances.
  if (from !== 'FAUCET') {
    const bal = ledger.balance(from);
    if (bal < amt)
      return res.status(400).json({ error: `Insufficient balance (have ${bal.toFixed(2)}, need ${amt})` });

    // -- Movement cap (standing-governed) ----------------------------------
    // You hold your whole million, but you can only MOVE what your standing
    // allows. A fake's million is frozen; a real user unlocks theirs by
    // building distinct, honest relationships. This is what lets the grant
    // stay a flat million safely.
    const movable = ledger.movableNow(from);
    if (amt > movable)
      return res.status(403).json({
        error: `Standing limit: you can move up to ${movable} right now. Transact honestly to unlock more.`,
        movable, standing: ledger.standingOf(from),
      });
  }
  // ── Commit ─────────────────────────────────────────────────────────────
  const tx = {
    from, to, amount: amt,
    reason:    reason || null,
    time:      new Date().toLocaleTimeString(),
    timestamp: Date.now(),
    // Store only the first 16 chars of the signature for audit trail.
    // Full sig is in the replay fence; we don't bloat the ledger file.
    sigPrefix: signature ? signature.substring(0, 16) : null,
  };

  ledger.commit(tx);            // append + index + persist via the single ledger write path
  saveJSON(REPLAY_FENCE_FILE,  seenSigs); // atomically commits the replay fence

  // On a successful ignition, consume the one-time invite code.
  if (from === 'FAUCET' && ignitionCode && IGNITION_CODES.size > 0) {
    usedCodes[ignitionCode] = to;
    saveJSON(USED_CODES_FILE, usedCodes);
    console.log(`[invite-code] consumed code → ${to}`);
  }

  console.log(`TX: ${from} → ${to} | ${amt} MONEY${reason ? ` [${reason}]` : ''}`);
  res.json({ success: true, tx });
});

// ─────────────────────────────────────────────────────────────────────────────
// ── SELF PERSONHOOD GATE — nullifier-bound ignition (additive, flag-gated) ────
// Enabled ONLY when SELF_GATE=1. A SECOND ignition path beside invite codes: prove
// you are a unique human via Self (mock mode); the proof's NULLIFIER seals one
// wallet and mints exactly 1,000,000 through the SAME FAUCET commit. One nullifier
// = one ignition, forever — no invite code is consulted here. Default-off, so every
// existing flow (and the phase/Brick regression suites) is byte-for-byte unchanged.
// ─────────────────────────────────────────────────────────────────────────────
if (process.env.SELF_GATE === '1') {
  const SELF_FILE = process.env.MONEY_SELF_FILE || path.join(DATA_DIR, 'self_nullifiers.json');
  // Atomic, fail-CLOSED storage for the nullifier ledger. A corrupt store must NEVER
  // silently reset — that would free every used nullifier to mint a SECOND time.
  const selfStorage = {
    load: () => safeStore.loadStrict(SELF_FILE, {}),
    save: (map) => safeStore.saveAtomic(SELF_FILE, map),
  };
  let selfStore;
  try {
    selfStore = selfGate.createNullifierStore(selfStorage);
  } catch (e) {
    console.error(`[FATAL] self-gate nullifier store: ${e.message}`);
    console.error('Refusing to enable the Self gate on a corrupt nullifier store — a reset would let a human mint twice.');
    process.exit(1);
  }
  // Crash recovery: claim() SEALS the nullifier before it mints, so a crash between
  // the two leaves a sealed-but-unminted wallet. Complete any such pending mint here,
  // exactly once (idempotent — an already-ignited wallet is skipped).
  const repairedPending = selfGate.repairPending(ledger, selfStore);
  if (repairedPending) console.log(`[self-gate] crash repair: completed ${repairedPending} pending mint(s)`);

  // Verifier: the real SelfBackendVerifier (mock mode) in production; a stub in
  // tests. The stub is gated behind NODE_ENV=test AND SELF_GATE_STUB=1 so it can
  // NEVER run in production — the request simply carries the desired verdict.
  let verify;
  if (process.env.NODE_ENV === 'test' && process.env.SELF_GATE_STUB === '1') {
    verify = async (payload) => ({
      valid:     !!(payload && payload.stub && payload.stub.valid),
      nullifier: payload && payload.stub ? payload.stub.nullifier : undefined,
    });
    console.log('[self-gate] TEST STUB verifier active (NODE_ENV=test, SELF_GATE_STUB=1)');
  } else {
    verify = selfGate.realSelfVerifier({
      scope:    process.env.SELF_SCOPE,
      endpoint: process.env.SELF_ENDPOINT,
    }).verify;
  }

  // The Self mint shares the WRITE-AUTHORITATIVE `ledger` (central), exactly like
  // the faucet — so isIgnited / standing / the Brick 1 tip all advance identically.
  const gate = selfGate.createSelfGate({ verify, ledger, store: selfStore });

  // Ignition is irreversible: cap proof submissions per IP (the nullifier is the
  // real one-per-human gate; this only blunts proof-spam DoS).
  const selfLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: process.env.NODE_ENV === 'test' ? 100000 : 10,
    message: { error: 'Too many ignition attempts — try again later.' },
  });

  app.post('/ignite/self', selfLimiter, async (req, res) => {
    try {
      const body   = req.body || {};
      const wallet = body.wallet || body.to;          // M_ address to ignite
      const result = await gate.claim(body, wallet);
      if (!result.ok) {
        const status = (result.code === 'nullifier-used' || result.code === 'wallet-ignited') ? 409
                     : (result.code === 'invalid-proof'  || result.code === 'verify-error')   ? 401
                     : 400;
        return res.status(status).json({ error: result.reason, code: result.code, ...(result.boundTo ? { boundTo: result.boundTo } : {}) });
      }
      console.log(`[self-gate] ignited ${result.wallet} via nullifier ${String(result.nullifier).slice(0, 10)}…`);
      res.json({ success: true, wallet: result.wallet, amount: result.amount, tx: result.tx });
    } catch (e) {
      console.error('[self-gate] error:', e.message);
      res.status(500).json({ error: 'self ignition failed' });
    }
  });
  console.log(`[self-gate] ENABLED — POST /ignite/self (mock mode${process.env.NODE_ENV === 'test' && process.env.SELF_GATE_STUB === '1' ? ', test stub' : ''})`);
}

// ── Debug endpoint (dev-only — remove or auth-gate before public launch) ──
// Returns counts only — never addresses or codes themselves.
app.get('/stats', (req, res) => {
  res.json({
    transactions:     ledger.size(),
    registeredUsers:  ledger.userCount(),
    faucetGate:       IGNITION_CODES.size > 0 ? 'ignition-code' : 'CLOSED',
    usedCodes:        Object.keys(usedCodes).length,
    replayFenceSize:  Object.keys(seenSigs).length,
  });
});

// ── Shadow reconciliation inspector (committee-shadow mode ONLY) ──────────────
// Read-only window into whether the durable committee reconciles with central.
// Never serves money; only registered when the shadow backend is active.
if (LEDGER_BACKEND === 'committee-shadow' && shadowReconciler) {
  app.get('/debug/shadow', (req, res) => res.json(shadowReconciler.report()));
  // Re-run catch-up against central's ledger on demand. Idempotent: already-
  // applied txs are skipped, so repeated calls never double-apply (replay test).
  app.post('/debug/shadow/resync', (req, res) => {
    const applied = shadowResync ? shadowResync() : 0;
    res.json({ applied, ...shadowReconciler.report() });
  });
  // ── Phase-3 read-source probes (committee-shadow ONLY; never serve money) ──
  // Direct source probe: the value the read layer WOULD serve + its source
  // ('committee' normally; 'central' on divergence/fallback). Proves the flip.
  app.get('/debug/read', (req, res) => {
    if (!shadowReads) return res.status(404).json({ error: 'no shadow' });
    const { what, addr } = req.query;
    let value;
    switch (what) {
      case 'balance':   value = shadowReads.balance(addr); break;
      case 'standing':  value = shadowReads.standingOf(addr); break;
      case 'movable':   value = shadowReads.movableNow(addr); break;
      case 'usercount': value = shadowReads.userCount(); break;
      case 'size':      value = shadowReads.size(); break;
      case 'ignited':   value = shadowReads.isIgnited(addr); break;
      case 'ledgerlen': value = shadowReads.all().length; break;
      default: return res.status(400).json({ error: 'unknown what' });
    }
    res.json({ what, addr: addr || null, value, source: shadowReads.lastReadSource() });
  });
  // Inject a committee≠central divergence (in-memory, not persisted) to prove the
  // read layer serves CENTRAL and logs it. Reversible: send the negative delta.
  app.post('/debug/shadow/perturb', (req, res) => {
    const { addr, balanceDelta } = req.body || {};
    if (!shadowReads || !addr || !Number.isInteger(balanceDelta)) return res.status(400).json({ error: 'addr + integer balanceDelta required' });
    shadowReads.__perturb(addr, balanceDelta);
    res.json({ ok: true });
  });
  // Toggle a committee-read fault to prove fallback to central (no user-facing 500).
  app.post('/debug/shadow/fault', (req, res) => {
    if (!shadowReads) return res.status(404).json({ error: 'no shadow' });
    const on = !!(req.body && req.body.on);
    shadowReads.__setFault(on);
    res.json({ ok: true, fault: on });
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`MONEY server listening on :${PORT}`);
  const gate = IGNITION_CODES.size > 0 ? `invite codes (${IGNITION_CODES.size})`
             : 'NONE — faucet CLOSED (set IGNITION_CODES to open)';
  console.log(`Faucet gate: ${gate}`);
  console.log(`Registered users: ${ledger.userCount()} | Codes used: ${Object.keys(usedCodes).length}`);
  if (PLATFORM_ADDRESSES.size > 0)
    console.log(`Platform recipients: ${[...PLATFORM_ADDRESSES].join(', ')}`);
});
