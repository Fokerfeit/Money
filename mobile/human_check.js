// ── MONEY — "🛂 Prove you're human" card (About screen) ───────────────────────
//
// Decides what the human-check card shows. NO mint logic lives here or in the card:
// joining still happens ONLY through the two existing server paths —
//   • a beta (invite) code  → the existing invite-code field + POST /transaction
//   • a passport proof      → the Self app POSTs to the server's /ignite/self
// Both end in the same FAUCET → wallet entry on the ledger, so that entry is the
// one source of truth for ✅. The phone only READS it and caches it for display.
//
// Per network:
//   ✅ 'yes'     — the ledger has a FAUCET → this wallet entry (joined)
//   ⏳ 'no'      — the ledger answered, no such entry yet
//   ⏳ 'none'    — no wallet on this network on this phone yet
//   ⏳ 'unknown' — couldn't check (offline / odd reply) and nothing cached
// A failed check falls back to the last cached answer, shown with its time.
//
// "Verify with passport" is enabled ONLY when that network's server answers
// GET /ignite/self/status with { enabled: true } (exactly true). Anything else —
// 404 (today's servers don't have the route), an error page, a timeout, "true" as a
// string — means OFF: "Coming soon — use a beta code". The link it opens must be a
// Self universal link (https://redirect.self.xyz?selfApp=…), or it is not opened.
//
// PURE module (no React Native), so test_human_check.js executes it.
'use strict';

const NETWORKS = ['testnet', 'mainnet'];
const NET_LABEL = { testnet: '🧪 TESTNET', mainnet: '🌐 MAINNET' };
const CACHE_KEY = 'human_check_cache_v1';
const WALLET_RE = /^M_[0-9A-F]{32}$/;

// ── Copy (kept here so the test checks the exact words) ──────────────────────
const TEXT = {
  title: "🛂 Prove you're human",
  intro: 'One human, one share. MONEY checks once that you are a real, unique person — then your wallet is in.',
  verify: '🛂 Verify with passport',
  verifyOff: 'Coming soon — use a beta code',
  verifyAfterSetup: 'Available once your wallet is set up.',
  beta: '🎟️ I have a beta code',
  betaHint: 'Your beta code from the team.',
  betaSetup: 'You type it right after you set up your wallet.',
  mock: '⚠️ Test mode: only Self demo passports work on this server right now.',
  privacyTitle: 'What the passport check shares',
  privacy:
    'The free Self app reads your passport\'s chip on your own phone. Your name, photo, birth date, ' +
    'nationality and passport number stay on your phone. MONEY receives only: proof that a real ' +
    'passport or ID card exists, which kind of document it is, the date of the check, a code unique ' +
    'to your document inside MONEY (so the same passport can\'t join twice — it doesn\'t contain your ' +
    'name or number), and your wallet address. Self is a separate app with its own privacy policy.',
  recheck: '↻ Check again',
};

const STATE_LINE = {
  yes: '✅ Joined',
  no: '⏳ Not joined yet',
  none: '⏳ No wallet here yet',
  unknown: '⏳ Couldn\'t check',
};

// GET /ignite/self/status body → is the passport path on? Only a literal true counts.
const gateEnabled = (json) => !!(json && typeof json === 'object' && json.enabled === true);
const gateMock = (json) => !!(json && typeof json === 'object' && json.enabled === true && json.mock === true);

// GET /tx?from=FAUCET&to=… (or the full /ledger) body → 'yes' | 'no' | 'unknown'
function joinedFromTxs(txs, wallet) {
  if (!Array.isArray(txs)) return 'unknown';
  return txs.some((t) => t && t.from === 'FAUCET' && t.to === wallet) ? 'yes' : 'no';
}

// Only a Self universal link may leave the app from the Verify button.
const SELF_LINK_RE = /^https:\/\/redirect\.self\.xyz\/?\?selfApp=[^\s]+$/;
const isSelfLink = (url) => typeof url === 'string' && url.length < 8192 && SELF_LINK_RE.test(url);

// Address of a stored keypair JSON (read-only: only the public address is kept).
function walletAddress(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const a = JSON.parse(raw).address;
    return typeof a === 'string' && WALLET_RE.test(a) ? a : null;
  } catch { return null; }
}

// Fresh result + the cache → what to display. Cache is display-only and keyed by
// wallet, so a different wallet (restore, reset) never inherits an old ✅.
//   fresh: { [net]: { wallet, state } }   cache: { [net]: { wallet, state, at } }
function mergeStatus(fresh, cache, now) {
  const shown = {}, nextCache = {};
  for (const net of NETWORKS) {
    const f = (fresh && fresh[net]) || { wallet: null, state: 'none' };
    const c = cache && cache[net];
    const cOk = c && c.wallet === f.wallet && (c.state === 'yes' || c.state === 'no') && Number.isFinite(c.at);
    if (!f.wallet) {
      shown[net] = { wallet: null, state: 'none', cachedAt: null };
    } else if (f.state === 'yes' || f.state === 'no') {
      shown[net] = { wallet: f.wallet, state: f.state, cachedAt: null };
      nextCache[net] = { wallet: f.wallet, state: f.state, at: now };
    } else if (cOk) {
      shown[net] = { wallet: f.wallet, state: c.state, cachedAt: c.at };
      nextCache[net] = c;
    } else {
      shown[net] = { wallet: f.wallet, state: 'unknown', cachedAt: null };
    }
  }
  return { shown, nextCache };
}

// Everything the card renders.
//   status : mergeStatus().shown         gate : { [net]: statusJson | null }
//   network: the ACTIVE network          inWallet: the wallet screen is behind About
function humanCheckView({ status, gate, network, inWallet }) {
  const net = NETWORKS.includes(network) ? network : 'mainnet';
  const rows = NETWORKS.map((n) => {
    const st = (status && status[n]) || { state: 'unknown', cachedAt: null };
    const state = STATE_LINE[st.state] ? st.state : 'unknown';
    return { net: n, label: NET_LABEL[n], state, line: STATE_LINE[state], cachedAt: st.cachedAt || null, active: n === net };
  });
  const cur = rows.find((r) => r.active);
  const joined = cur.state === 'yes';
  const hasWallet = !!(status && status[net] && status[net].wallet);
  const on = gateEnabled(gate && gate[net]);
  return {
    rows,
    joined,
    joinedLine: joined ? `You're in on ${NET_LABEL[net]}.` : null,
    // Passport only from the wallet screen: at first launch the seal + phone lock
    // aren't set up yet, and joining must not jump ahead of them.
    verify: joined ? null : {
      enabled: on && inWallet && hasWallet && cur.state !== 'unknown',
      label: TEXT.verify,
      sub: !on ? TEXT.verifyOff : (inWallet && hasWallet ? null : TEXT.verifyAfterSetup),
    },
    mock: !joined && gateMock(gate && gate[net]),
    beta: joined ? null : {
      label: TEXT.beta,
      sub: inWallet ? TEXT.betaHint : `${TEXT.betaHint} ${TEXT.betaSetup}`,
      action: inWallet ? 'focus-wallet-code' : 'continue-setup',
    },
  };
}

module.exports = {
  NETWORKS, NET_LABEL, CACHE_KEY, TEXT, STATE_LINE,
  gateEnabled, gateMock, joinedFromTxs, isSelfLink, walletAddress, mergeStatus, humanCheckView,
};
