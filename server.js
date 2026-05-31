const express   = require('express');
const cors      = require('cors');
const fs        = require('fs');
const path      = require('path');
const nacl      = require('tweetnacl');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(cors());
// Raise body limit — ignition payload includes up to 5 SHA-256 face hashes
app.use(express.json({ limit: '64kb' }));

// ── File paths ─────────────────────────────────────────────────────────────
const LEDGER_FILE   = path.join(__dirname, 'ledger.json');
const REGISTRY_FILE = path.join(__dirname, 'face_registry.json');

// ── Persistence helpers ────────────────────────────────────────────────────
const loadJSON = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
};
const saveJSON = (file, data) => {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
  catch (e) { console.error(`Save error (${path.basename(file)}):`, e.message); }
};

// ── Load state ────────────────────────────────────────────────────────────
let txs = loadJSON(LEDGER_FILE, []);

// face_registry.json stores two things:
//   entries:  [{ address, hashes[], ts }] — one entry per ignited seal
//   seenSigs: { signature: timestampMs } — persistent replay fence
let registry = loadJSON(REGISTRY_FILE, { entries: [], seenSigs: {} });
if (!registry.entries)  registry.entries  = [];
if (!registry.seenSigs) registry.seenSigs = {};

// ── Prune expired replay-fence entries on startup ─────────────────────────
// We keep sigs for 10 minutes — wider than the 2-minute timestamp window
// so a sig can never be replayed even across a server restart.
const REPLAY_WINDOW_MS = 10 * 60 * 1000;
const pruneSeenSigs = () => {
  const cutoff = Date.now() - REPLAY_WINDOW_MS;
  let pruned = 0;
  for (const [sig, ts] of Object.entries(registry.seenSigs)) {
    if (ts < cutoff) { delete registry.seenSigs[sig]; pruned++; }
  }
  if (pruned > 0) console.log(`[replay-fence] pruned ${pruned} expired signatures`);
};
pruneSeenSigs();
saveJSON(REGISTRY_FILE, registry);

// Prune automatically every 5 minutes so the file stays bounded
setInterval(() => { pruneSeenSigs(); saveJSON(REGISTRY_FILE, registry); }, 5 * 60 * 1000);

console.log(`MONEY server — ${txs.length} txs | ${registry.entries.length} sealed faces`);

// ── Helpers ────────────────────────────────────────────────────────────────
const fromHex    = (hex) => new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)));
const toAddress  = (pk)  => 'M_' + pk.substring(0, 32).toUpperCase();
const userCount  = ()    => new Set(txs.filter(t => t.from === 'FAUCET').map(t => t.to)).size;
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
  const slot  = ignitionAttempts.get(ip) || { count: 0, resetAt: now + 60 * 60 * 1000 };
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
app.get('/health',    (req, res) => res.json({ status: 'ok', transactions: txs.length, seals: registry.entries.length }));
app.get('/usercount', (req, res) => res.json({ count: userCount() }));
app.get('/ledger',    (req, res) => res.json(txs));

app.get('/balance/:addr', (req, res) => {
  const bal = getBalance(req.params.addr);
  res.json({ address: req.params.addr, balance: Math.max(0, parseFloat(bal.toFixed(2))) });
});

app.post('/transaction', (req, res) => {
  const { from, to, amount, reason, signature, publicKey, timestamp, faceHashes } = req.body;

  // ── Basic field validation ─────────────────────────────────────────────
  if (!from || !to || amount == null)
    return res.status(400).json({ error: 'Missing required fields' });

  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0)
    return res.status(400).json({ error: 'Invalid amount' });

  const isSystem = from === 'SWARM_RESERVE' || reason === 'disconnect_penalty';

  // ── Timestamp freshness ────────────────────────────────────────────────
  // Reject anything older than 2 minutes or from the future (±30s tolerance).
  // This is the FIRST line of replay defence — stale transactions die here
  // without touching the replay fence.
  if (!isSystem) {
    const age = Date.now() - Number(timestamp);
    if (!timestamp || isNaN(age) || age > 2 * 60 * 1000 || age < -30_000)
      return res.status(401).json({ error: 'Transaction timestamp expired or invalid' });
  }

  // ── Replay fence (persistent) ──────────────────────────────────────────
  // Signatures that passed the timestamp check land here.
  // Stored in face_registry.json so the fence survives server restarts.
  // Without persistence: attacker restarts server, replays a 90-second-old tx.
  if (signature) {
    if (registry.seenSigs[signature])
      return res.status(401).json({ error: 'Duplicate transaction — already processed' });
    registry.seenSigs[signature] = Date.now();
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

  } else if (!isSystem) {
    if (!signature || !publicKey || !timestamp)
      return res.status(401).json({ error: 'Transaction must include signature, publicKey, and timestamp' });
    if (toAddress(publicKey) !== from)
      return res.status(401).json({ error: 'Public key does not match sender address' });
    if (!verifyTx(from, to, amt, timestamp, signature, publicKey))
      return res.status(401).json({ error: 'Invalid signature — transaction rejected' });
  }

  // ── One faucet claim per wallet address ───────────────────────────────
  if (from === 'FAUCET') {
    if (txs.some(t => t.from === 'FAUCET' && t.to === to))
      return res.status(400).json({ error: 'This address has already been ignited' });
  }

  // ─────────────────────────────────────────────────────────────────────
  // ── IGNITION-ONLY GATES ───────────────────────────────────────────────
  // These checks run only for faucet claims (the ignition transaction).
  // ─────────────────────────────────────────────────────────────────────
  if (from === 'FAUCET') {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

    // Gate 1: Per-IP ignition throttle
    // Placed AFTER signature verification — only cryptographically valid attempts
    // (i.e. real key-owners) burn the budget. Random bots can't forge sigs to
    // exhaust the throttle for legitimate users.
    if (!checkIgnitionThrottle(ip))
      return res.status(429).json({ error: 'Too many ignition attempts from this network — try again in 1 hour' });

    // Gate 2: Face hashes must be present and plausible
    // Minimum 3 hashes (client captures 5; some may fail due to camera issues).
    if (!Array.isArray(faceHashes) || faceHashes.length < 3)
      return res.status(400).json({ error: 'Face inscription incomplete — at least 3 face positions required' });

    // Gate 3: Hash format — must be valid SHA-256 hex strings
    const validHash = /^[a-f0-9]{64}$/i;
    const badHash = faceHashes.find(h => typeof h !== 'string' || !validHash.test(h));
    if (badHash)
      return res.status(400).json({ error: 'Malformed face hash — tampering detected' });

    // Gate 4: Sybil detection — reject if any hash matches a known sealed face
    // ── How this works ───────────────────────────────────────────────────
    // SHA-256 of a JPEG base64 frame is NOT perceptual — two photos of the
    // same face at different angles will produce different hashes. So this
    // does NOT catch "same face, different session".
    //
    // What it DOES catch:
    //   (a) Literal replay: attacker steals a hash list from a registered user
    //       and submits it verbatim from a new address.
    //   (b) Session copy-paste: client-side code bug or attack that submits
    //       identical hashes to multiple addresses in the same day.
    //
    // True perceptual face deduplication requires a face embedding model
    // (FaceNet, ArcFace, etc.) — that is Phase 2 server infrastructure.
    // This gate is the cryptographic floor, not the ceiling.
    const allKnownHashes = new Set(registry.entries.flatMap(e => e.hashes));
    const duplicateHash  = faceHashes.find(h => allKnownHashes.has(h));
    if (duplicateHash)
      return res.status(400).json({ error: 'Duplicate seal detected — one seal per human. Contact support if this is an error.' });

    // All gates passed — register the face hashes
    registry.entries.push({ address: to, hashes: faceHashes, ip: ip, ts: Date.now() });
    console.log(`[ignition] ${to} | ${faceHashes.length} hashes | ip=${ip}`);
  }

  // ── Recipient must be a registered Swarm node ─────────────────────────
  const systemAddresses = ['FAUCET', 'SWARM_RESERVE'];
  if (!systemAddresses.includes(to) && from !== 'FAUCET') {
    if (!txs.some(t => t.from === 'FAUCET' && t.to === to))
      return res.status(400).json({ error: 'Recipient is not a registered Swarm node' });
  }

  // ── Balance check ──────────────────────────────────────────────────────
  if (!isSystem && from !== 'FAUCET') {
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
  saveJSON(LEDGER_FILE,   txs);
  saveJSON(REGISTRY_FILE, registry); // atomically commits seenSigs + face registry

  console.log(`TX: ${from} → ${to} | ${amt} MONEY${reason ? ` [${reason}]` : ''}`);
  res.json({ success: true, tx });
});

// ── Debug endpoint (dev-only — remove or auth-gate before public launch) ──
app.get('/registry', (req, res) => {
  // Returns only addresses and hash counts — never the hashes themselves
  res.json({
    sealCount: registry.entries.length,
    seals: registry.entries.map(e => ({
      address:    e.address,
      hashCount:  e.hashes.length,
      ts:         e.ts,
    })),
  });
});

app.listen(3000, '0.0.0.0', () => {
  console.log('MONEY server listening on :3000');
  console.log(`Registered users: ${userCount()} | Sealed faces: ${registry.entries.length}`);
});
