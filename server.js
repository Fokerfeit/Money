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
const GOOGLE_ACCOUNTS_FILE = process.env.MONEY_GOOGLE_FILE   || path.join(DATA_DIR, 'google_accounts.json');
const REPLAY_FENCE_FILE    = process.env.MONEY_FENCE_FILE    || path.join(DATA_DIR, 'replay_fence.json');
const DEVICES_FILE         = process.env.MONEY_DEVICES_FILE  || path.join(DATA_DIR, 'devices.json');
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

// google_accounts.json maps google_sub → MONEY address (one seal per human).
// This is the anti-Sybil signal: the app sends google_sub on ignition, and a
// Google identity may only ever ignite one address.
//
// NOTE: Google Sign-In is currently commented out in the app (it needs a native
// build), so google_sub arrives undefined for now and this gate stays dormant.
// When undefined, ignition falls back to "one claim per wallet address" only.
let googleAccounts = loadJSON(GOOGLE_ACCOUNTS_FILE, {});

// replay_fence.json stores { signature: timestampMs } — a persistent replay
// fence so a signature can never be replayed, even across a server restart.
let seenSigs = loadJSON(REPLAY_FENCE_FILE, {});

// ── Anti-Sybil: server-issued single-use ignition codes ─────────────────────
// IGNITION_CODES (comma-separated) are codes YOU hand out. The server controls
// them, so — unlike a client-supplied google_sub or deviceId — they CANNOT be
// forged. When non-empty, a faucet claim must present a valid, UNUSED code, and
// each code seals exactly one identity. This is the real interim "one per human"
// control (replace with verified Google/phone identity for open launch).
const IGNITION_CODES = new Set(
  (process.env.IGNITION_CODES || '').split(',').map(s => s.trim()).filter(Boolean)
);
let usedCodes = loadJSON(USED_CODES_FILE, {});   // code → address (consumed)

// devices.json maps a per-install deviceId → address. Secondary signal: stops a
// normal user on the official app from minting many wallets on one phone.
// (Forgeable by a scripted attacker, so it's defence-in-depth, not the gate.)
let devices = loadJSON(DEVICES_FILE, {});

// ── Platform recipient allowlist ────────────────────────────────────────────
// Addresses (comma-separated in MONEY_PLATFORM_ADDRESSES) that may RECEIVE
// transfers without having ignited via the faucet — e.g. the nocopycART
// marketplace wallet. They are NOT faucet users, hold no minted balance, and
// are not counted in userCount(). They can still SPEND normally (signed tx +
// balance accrued from payments received).
const PLATFORM_ADDRESSES = new Set(
  (process.env.MONEY_PLATFORM_ADDRESSES || '')
    .split(',').map(s => s.trim()).filter(Boolean)
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

console.log(`MONEY server — ${txs.length} txs | ${Object.keys(googleAccounts).length} Google seals`);

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

const verifyTx = (from, to, amount, timestamp, signature, publicKey) => {
  try {
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

// ── Rate limiting — 20 req/min per IP ────────────────────────────────────
app.use('/transaction', rateLimit({
  windowMs: 60 * 1000, max: 20,
  message: { error: 'Too many requests — slow down.' },
}));

// ── Routes ────────────────────────────────────────────────────────────────
app.get('/health',    (req, res) => res.json({ status: 'ok', transactions: txs.length, seals: Object.keys(googleAccounts).length }));
app.get('/usercount', (req, res) => res.json({ count: userCount() }));
app.get('/ledger',    (req, res) => res.json(txs));

app.get('/balance/:addr', (req, res) => {
  const bal = getBalance(req.params.addr);
  res.json({ address: req.params.addr, balance: Math.max(0, parseFloat(bal.toFixed(2))) });
});

// ── Google account lookup — called by the app before registration ───────────
// Returns { exists: true, address } if this Google account already has a seal,
// or { exists: false } if it is a new user. Lets the app restore an existing
// wallet instead of trying to ignite a duplicate.
app.post('/google-lookup', (req, res) => {
  const { google_sub } = req.body;
  if (!google_sub) return res.status(400).json({ error: 'Missing google_sub' });
  const address = googleAccounts[google_sub];
  return address ? res.json({ exists: true, address }) : res.json({ exists: false });
});

app.post('/transaction', (req, res) => {
  const { from, to, amount, reason, signature, publicKey, timestamp, google_sub, ignitionCode, deviceId } = req.body;

  // ── Basic field validation ─────────────────────────────────────────────
  if (!from || !to || amount == null)
    return res.status(400).json({ error: 'Missing required fields' });

  const amt = parseFloat(amount);
  if (isNaN(amt) || !isFinite(amt) || amt <= 0)
    return res.status(400).json({ error: 'Invalid amount' });

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

  // ── Replay fence (persistent) ──────────────────────────────────────────
  // Signatures that passed the timestamp check land here.
  // Stored in replay_fence.json so the fence survives server restarts.
  // Without persistence: attacker restarts server, replays a 90-second-old tx.
  if (signature) {
    if (seenSigs[signature])
      return res.status(401).json({ error: 'Duplicate transaction — already processed' });
    seenSigs[signature] = Date.now();
    // (saveJSON happens at commit time to keep writes atomic)
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

  // ─────────────────────────────────────────────────────────────────────
  // ── IGNITION-ONLY GATES ───────────────────────────────────────────────
  // These checks run only for faucet claims (the ignition transaction).
  // ─────────────────────────────────────────────────────────────────────
  if (from === 'FAUCET') {
    // Gate 0: Server-issued ignition code (the UNFORGEABLE one-per-human control).
    // Only enforced when IGNITION_CODES is configured. A scripted attacker can
    // forge keypairs, IPs and deviceIds — but NOT a code the server never issued.
    if (IGNITION_CODES.size > 0) {
      if (!ignitionCode || !IGNITION_CODES.has(ignitionCode))
        return res.status(403).json({ error: 'A valid ignition code is required to seal. Ask the founder for yours.' });
      if (usedCodes[ignitionCode])
        return res.status(403).json({ error: 'This ignition code has already been used — one seal per code.' });
    }

    // Gate 0b: One seal per device (defence-in-depth — stops casual multi-wallet
    // farming from the real app; forgeable by scripts, so it is NOT the main gate).
    if (deviceId && devices[deviceId])
      return res.status(400).json({ error: 'This device has already sealed an identity.' });

    // Gate 1: One faucet claim per wallet address
    if (txs.some(t => t.from === 'FAUCET' && t.to === to))
      return res.status(400).json({ error: 'This address has already been ignited' });

    // Gate 2: Reward cap — the server computes the authoritative reward itself
    // and rejects any claim above it. Without this, a modified client could sign
    // a FAUCET→self transaction for any amount and mint it (the signature only
    // proves key-ownership, not that the amount is legitimate).
    const maxReward = calcReward(userCount());
    if (amt > maxReward)
      return res.status(400).json({ error: `Faucet reward exceeds the current allowance (max ${maxReward})` });

    // Gate 3: Per-IP ignition throttle
    // Placed AFTER signature verification — only cryptographically valid attempts
    // (i.e. real key-owners) burn the budget. Random bots can't forge sigs to
    // exhaust the throttle for legitimate users. req.ip honours trust-proxy.
    const ip = req.ip || 'unknown';
    if (!checkIgnitionThrottle(ip))
      return res.status(429).json({ error: 'Too many ignition attempts from this network — try again in 1 hour' });

    // Gate 4: Anti-Sybil — one MONEY account per Google identity.
    // ── How this works ────────────────────────────────────────────────────
    // The signed public key proves key-ownership, but a fresh keypair is free,
    // so the public key alone is NOT a per-human signal. google_sub (the stable
    // subject ID from a verified Google account) is. A Google identity may only
    // ever seal one address.
    //
    // DORMANT FOR NOW: Google Sign-In is commented out in the app, so google_sub
    // arrives undefined and this gate is a no-op until OAuth is wired up. When it
    // is, this becomes the real Sybil firewall. (Replaced the old face-hash gate,
    // which was dropped because SHA-256 of a photo can never match two captures
    // of the same face — illusion of dedup without the substance.)
    if (google_sub && googleAccounts[google_sub])
      return res.status(400).json({
        error: 'A MONEY account is already linked to this Google account. One seal per human.',
      });
  }

  // ── Recipient must be a registered Swarm node (or a known platform) ──────
  const systemAddresses = ['FAUCET', 'SWARM_RESERVE'];
  const isAllowedRecipient = systemAddresses.includes(to) || PLATFORM_ADDRESSES.has(to);
  if (!isAllowedRecipient && from !== 'FAUCET') {
    if (!txs.some(t => t.from === 'FAUCET' && t.to === to))
      return res.status(400).json({ error: 'Recipient is not a registered Swarm node' });
  }

  // ── Balance check ──────────────────────────────────────────────────────
  // Applies to every non-faucet sender, including disconnect_penalty — a user
  // can never send (or be penalised) more than they hold. No negative balances.
  if (from !== 'FAUCET') {
    const bal = getBalance(from);
    if (bal < amt)
      return res.status(400).json({ error: `Insufficient balance (have ${bal.toFixed(2)}, need ${amt})` });
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

  txs.unshift(tx);
  saveJSON(LEDGER_FILE,        txs);
  saveJSON(REPLAY_FENCE_FILE,  seenSigs); // atomically commits the replay fence

  // On a successful ignition, consume the one-time code and seal the device.
  if (from === 'FAUCET') {
    if (ignitionCode && IGNITION_CODES.size > 0) {
      usedCodes[ignitionCode] = to;
      saveJSON(USED_CODES_FILE, usedCodes);
      console.log(`[ignition-code] consumed code → ${to}`);
    }
    if (deviceId) {
      devices[deviceId] = to;
      saveJSON(DEVICES_FILE, devices);
    }
    if (google_sub) {
      googleAccounts[google_sub] = to;
      saveJSON(GOOGLE_ACCOUNTS_FILE, googleAccounts);
      console.log(`Google account linked: ${google_sub.substring(0, 8)}... → ${to}`);
    }
  }

  console.log(`TX: ${from} → ${to} | ${amt} MONEY${reason ? ` [${reason}]` : ''}`);
  res.json({ success: true, tx });
});

// ── Debug endpoint (dev-only — remove or auth-gate before public launch) ──
// Returns counts only — never the google_sub values or addresses themselves.
app.get('/stats', (req, res) => {
  res.json({
    transactions:   txs.length,
    registeredUsers: userCount(),
    googleSeals:    Object.keys(googleAccounts).length,
    replayFenceSize: Object.keys(seenSigs).length,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`MONEY server listening on :${PORT}`);
  console.log(`Registered users: ${userCount()} | Google seals: ${Object.keys(googleAccounts).length}`);
  if (PLATFORM_ADDRESSES.size > 0)
    console.log(`Platform recipients: ${[...PLATFORM_ADDRESSES].join(', ')}`);
});
