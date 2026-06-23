const express   = require('express');
const cors      = require('cors');
const fs        = require('fs');
const path      = require('path');
const nacl      = require('tweetnacl');
const rateLimit = require('express-rate-limit');

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
const loadJSON = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
};
const saveJSON = (file, data) => {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
  catch (e) { console.error(`Save error (${path.basename(file)}):`, e.message); }
};

// ── Load state ──────────────────────────────────────────────────────────────
let txs = loadJSON(LEDGER_FILE, []);

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
let seenSigs = loadJSON(REPLAY_FENCE_FILE, {});

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
let usedCodes = loadJSON(USED_CODES_FILE, {});   // code → address (consumed)

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

// ── Phase-1 COMMITTEE backend (READ-ONLY SHADOW) ─────────────────────────────
// A second LedgerBackend modelled on prototypes/fastpay_net (per-account state).
// In Phase 1 it runs as a read-only SHADOW: it ingests the SAME committed txs as
// central and computes each account's balance & standing INDEPENDENTLY from
// per-account state — it NEVER serves a user response. Standing uses the IDENTICAL
// rule as central (ported standingOf): IGNITED_BASELINE once ignited, +1 per
// DISTINCT counterparty (excluding FAUCET and self); movable = min(balance,
// standing × MOVE_PER_STANDING). No static standing.
function createCommitteeLedger() {
  const accounts = new Map(); // addr -> { balance, ignited, counterparties:Set, nextSeq }
  let appliedCount = 0;
  const acct = (addr) => {
    let a = accounts.get(addr);
    if (!a) { a = { balance: 0, ignited: false, counterparties: new Set(), nextSeq: 0 }; accounts.set(addr, a); }
    return a;
  };
  // Apply a finalized transfer (fastpay-authority style), deriving standing from
  // history rather than storing it. Mirrors central's getBalance + distinct-
  // counterparty rule EXACTLY so the two can be reconciled byte-for-byte.
  const applyTx = (tx) => {
    const { from, to, amount } = tx;
    const f = acct(from), t = acct(to);
    t.balance += amount;
    f.balance -= amount;
    f.nextSeq += 1;
    if (from === 'FAUCET') t.ignited = true;
    if (to   !== 'FAUCET' && to   !== from) f.counterparties.add(to);   // sender gains recipient
    if (from !== 'FAUCET' && from !== to)   t.counterparties.add(from); // recipient gains sender
    appliedCount += 1;
  };
  const balance    = (addr) => (accounts.get(addr)?.balance ?? 0);
  const isIgnited  = (addr) => (accounts.get(addr)?.ignited ?? false);
  const standingOf = (addr) =>
    (isIgnited(addr) ? IGNITED_BASELINE : 0) + (accounts.get(addr)?.counterparties.size ?? 0);
  const movableNow = (addr) => Math.min(balance(addr), standingOf(addr) * MOVE_PER_STANDING);
  const userCount  = () => { let n = 0; for (const a of accounts.values()) if (a.ignited) n++; return n; };
  return {
    // Same interface as createCentralLedger(). In Phase 1 the shadow wrapper
    // routes EVERY response to central; the two response-serving reads are guarded
    // to fail loudly if anything ever tries to serve a user from the committee.
    all:   () => { throw new Error('committee.all() must never serve a response in shadow mode'); },
    query: () => { throw new Error('committee.query() must never serve a response in shadow mode'); },
    size:  () => appliedCount,
    balance, standingOf, movableNow, userCount, isIgnited,
    commit: applyTx,
    // Read-only snapshot for the reconciliation inspector (never money).
    debugSnapshot: () => {
      const out = {};
      for (const [addr, a] of accounts) {
        if (addr === 'FAUCET' || addr === 'SWARM_RESERVE') continue;
        out[addr] = {
          balance: a.balance, standing: standingOf(addr), movable: movableNow(addr),
          ignited: a.ignited, counterparties: [...a.counterparties].sort(), nextSeq: a.nextSeq,
        };
      }
      return out;
    },
  };
}

// ── Phase-1 RECONCILER ───────────────────────────────────────────────────────
// After every shadowed commit, assert the committee agrees with central EXACTLY
// on {balance, standing, size} for each account the tx touched. Observe-only: it
// records drift and NEVER throws into the commit path (central has already
// committed; the user response must stay unaffected). The test fails on any drift.
function createReconciler(central, committee) {
  const drifts = [], errors = [];
  const SYSTEM = new Set(['FAUCET', 'SWARM_RESERVE']);
  const check = (tx) => {
    for (const addr of [tx.from, tx.to].filter((a) => a && !SYSTEM.has(a))) {
      const cb = central.balance(addr),    kb = committee.balance(addr);
      if (cb !== kb) drifts.push({ field: 'balance',  addr, central: cb, committee: kb });
      const cs = central.standingOf(addr), ks = committee.standingOf(addr);
      if (cs !== ks) drifts.push({ field: 'standing', addr, central: cs, committee: ks });
    }
    const csz = central.size(), ksz = committee.size();
    if (csz !== ksz) drifts.push({ field: 'size', central: csz, committee: ksz });
  };
  const noteError = (e, tx) => errors.push({ error: String((e && e.message) || e), from: tx.from, to: tx.to, amount: tx.amount });
  const report = () => ({
    backend: 'committee-shadow',
    reconciled: drifts.length === 0 && errors.length === 0,
    driftCount: drifts.length,
    errorCount: errors.length,
    drifts: drifts.slice(0, 20),
    errors: errors.slice(0, 5),
    size: { central: central.size(), committee: committee.size() },
    accounts: committee.debugSnapshot(),
  });
  return { check, noteError, report };
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

const LEDGER_BACKEND = process.env.LEDGER_BACKEND || 'central';
let shadowReconciler = null; // set in committee-shadow mode; exposed read-only via /debug/shadow
const ledger = (() => {
  if (LEDGER_BACKEND === 'central') return createCentralLedger();
  if (LEDGER_BACKEND === 'committee-shadow') {
    // Central authoritative; committee runs as a read-only shadow that reconciles.
    const central = createCentralLedger();
    const committee = createCommitteeLedger();
    shadowReconciler = createReconciler(central, committee);
    return createShadowedLedger(central, committee, shadowReconciler);
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
app.get('/usercount', (req, res) => res.json({ count: ledger.userCount() }));
app.get('/ledger',    (req, res) => res.json(ledger.all()));

// ── Targeted lookup ──────────────────────────────────────────────────────────
// GET /tx?from=&to=&since=&reason=&limit=  → only the matching txs, newest-first.
// This is what payment-verifying clients (e.g. nocopycART) should use instead of
// GET /ledger: served from the in-memory indexes so the cost is bounded by
// recent/relevant activity, NOT by the total size of the ledger.
app.get('/tx', (req, res) => {
  res.json(ledger.query(req.query));
});

app.get('/balance/:addr', (req, res) => {
  const bal = ledger.balance(req.params.addr);
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

// ── Phase-1 shadow reconciliation inspector (committee-shadow mode ONLY) ──────
// Read-only window into whether the committee reconciles with central. Never
// serves money; only registered when the shadow backend is active.
if (LEDGER_BACKEND === 'committee-shadow' && shadowReconciler) {
  app.get('/debug/shadow', (req, res) => res.json(shadowReconciler.report()));
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
