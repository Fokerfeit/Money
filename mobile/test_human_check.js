// test_human_check.js — "🛂 Prove you're human" card + About jump-chips + honest
// tile wording (feature/human-check-screen). Every probe must pass; exit 0.
//
//   (1) human_check.js EXECUTED: ✅/⏳ per network from the ledger, cache is
//       display-only + wallet-keyed, passport button ON only for {enabled:true},
//       only a Self universal link may be opened, beta code → existing field
//   (2) App.js wiring: card near the top of About, sticky chips → every card,
//       beta code reuses the EXISTING invite-code box, NO new mint path
//   (3) About wording: tiles 1–3 match the founder statement; code link correct
//   (4) protected files untouched; the server endpoint is only a proposal patch
//
// App.js is React Native/JSX and cannot run under plain Node, so (as in the other
// App tests) its structure is source-scanned — every piece of LOGIC is executed.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const hc = require('./human_check');

let fails = 0;
const ok  = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };
const check = (c, m, d) => (c ? ok(m) : bad(d ? `${m} — ${d}` : m));

const SRC = fs.readFileSync(path.join(__dirname, 'App.js'), 'utf8').replace(/\r\n/g, '\n');
const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const between = (a, b) => { const i = SRC.indexOf(a); const j = SRC.indexOf(b, i + 1); return i >= 0 && j > i ? SRC.slice(i, j) : ''; };

const A = 'M_' + 'A'.repeat(32), B = 'M_' + 'B'.repeat(32);
const faucet = (to) => ({ from: 'FAUCET', to, amount: 1000000 });

console.log('\n  🧪  HUMAN CHECK — card, chips, honest About\n');

// ── (1) LOGIC ──────────────────────────────────────────────────────────────
console.log('  (1) human_check.js — executed');
{
  // ✅ comes ONLY from a FAUCET → this wallet entry
  check(hc.joinedFromTxs([faucet(A)], A) === 'yes', 'FAUCET → this wallet on the ledger = ✅ yes');
  check(hc.joinedFromTxs([], A) === 'no' && hc.joinedFromTxs([faucet(B)], A) === 'no', 'no entry, or someone else\'s = ⏳ no');
  check(hc.joinedFromTxs([{ from: B, to: A, amount: 1000000 }], A) === 'no', 'a big transfer FROM a person is not joining (only FAUCET counts)');
  check(['x', null, undefined, {}, { error: 'x' }].every((v) => hc.joinedFromTxs(v, A) === 'unknown'), 'error page / null / object = unknown (never ✅)');

  // passport button: only a literal enabled:true
  check(hc.gateEnabled({ enabled: true }) === true, 'gate {enabled:true} → ON');
  const offs = [null, undefined, {}, { enabled: false }, { enabled: 'true' }, { enabled: 1 }, [true], 'enabled', { error: 'Cannot GET' }];
  check(offs.every((v) => hc.gateEnabled(v) === false), `gate OFF for ${offs.length} non-true answers (404 / error / "true" string / 1 / …)`);
  check(hc.gateMock({ enabled: true, mock: true }) && !hc.gateMock({ enabled: false, mock: true }) && !hc.gateMock({ enabled: 1, mock: true }) && !hc.gateMock({ enabled: true, mock: 'true' }),
    'mock warning only when the gate is ON (literal true) and in mock mode');

  // only a Self universal link leaves the app
  const good = 'https://redirect.self.xyz?selfApp=%7B%22a%22%3A1%7D';
  check(hc.isSelfLink(good) && hc.isSelfLink('https://redirect.self.xyz/?selfApp=%7B%7D'), 'Self universal link accepted');
  const evil = ['http://redirect.self.xyz?selfApp=x', 'https://redirect.self.xyz.evil.com?selfApp=x', 'https://evil.com/?u=https://redirect.self.xyz?selfApp=x',
    'https://redirect.self.xyz?other=x', 'javascript:alert(1)', 'https://redirect.self.xyz?selfApp=a b', null, 42, 'https://redirect.self.xyz?selfApp=' + 'x'.repeat(9000)];
  check(evil.every((u) => !hc.isSelfLink(u)), `${evil.length} non-Self / look-alike / malformed links refused`);

  // wallet peek: public address only, strict shape
  check(hc.walletAddress(JSON.stringify({ address: A, secretKey: 'sk' })) === A, 'stored keypair → its public address');
  check([null, '', 'not json', JSON.stringify({ address: 'M_123' }), JSON.stringify({ address: A.toLowerCase() }), JSON.stringify({})].every((r) => hc.walletAddress(r) === null), 'missing / corrupt / malformed keypair → no wallet');

  // cache: display-only, keyed by wallet
  const T0 = 1_700_000_000_000;
  let m = hc.mergeStatus({ testnet: { wallet: A, state: 'yes' }, mainnet: { wallet: B, state: 'no' } }, null, T0);
  check(m.shown.testnet.state === 'yes' && m.shown.mainnet.state === 'no' && m.nextCache.testnet.at === T0, 'fresh answers shown + cached');
  const m2 = hc.mergeStatus({ testnet: { wallet: A, state: 'unknown' }, mainnet: { wallet: B, state: 'unknown' } }, m.nextCache, T0 + 5000);
  check(m2.shown.testnet.state === 'yes' && m2.shown.testnet.cachedAt === T0 && m2.shown.mainnet.state === 'no', 'offline → last cached answer, marked with its time');
  const m3 = hc.mergeStatus({ testnet: { wallet: B, state: 'unknown' }, mainnet: { wallet: null, state: 'none' } }, m.nextCache, T0 + 5000);
  check(m3.shown.testnet.state === 'unknown' && m3.shown.mainnet.state === 'none', 'a DIFFERENT wallet never inherits an old ✅ (restore / reset)');
  const forged = { testnet: { wallet: A, state: 'yes' } };   // cache without a time
  check(hc.mergeStatus({ testnet: { wallet: A, state: 'unknown' } }, forged, T0).shown.testnet.state === 'unknown', 'a cache entry without a timestamp is ignored');
  check(hc.mergeStatus({ testnet: { wallet: A, state: 'no' } }, m.nextCache, T0).shown.testnet.state === 'no', 'a fresh ⏳ beats a cached ✅ (testnet reset is shown)');

  // the view
  const st = (t, mn) => hc.mergeStatus({ testnet: t, mainnet: mn }, null, T0).shown;
  const ON = { enabled: true }, OFF = { enabled: false };
  let v = hc.humanCheckView({ status: st({ wallet: A, state: 'no' }, { wallet: B, state: 'no' }), gate: { testnet: OFF }, network: 'testnet', inWallet: true });
  check(v.rows.length === 2 && v.rows[0].label === '🧪 TESTNET' && v.rows[1].label === '🌐 MAINNET' && v.rows.every((r) => r.line === '⏳ Not joined yet'), 'two rows, ⏳ per network');
  check(v.verify && v.verify.enabled === false && v.verify.sub === 'Coming soon — use a beta code', 'gate OFF → Verify disabled: "Coming soon — use a beta code"');
  check(v.beta && v.beta.action === 'focus-wallet-code', 'beta code from the wallet → the existing invite-code box');
  v = hc.humanCheckView({ status: st({ wallet: A, state: 'no' }, { wallet: B, state: 'no' }), gate: {}, network: 'testnet', inWallet: true });
  check(v.verify.enabled === false && v.verify.sub === 'Coming soon — use a beta code', 'no status answer at all (today\'s servers: 404) → OFF');
  v = hc.humanCheckView({ status: st({ wallet: A, state: 'no' }, { wallet: B, state: 'no' }), gate: { testnet: ON }, network: 'testnet', inWallet: true });
  check(v.verify.enabled === true && v.verify.sub === null && v.mock === false, 'gate ON + wallet + not joined → Verify enabled');
  v = hc.humanCheckView({ status: st({ wallet: A, state: 'no' }, { wallet: B, state: 'no' }), gate: { mainnet: ON, testnet: OFF }, network: 'testnet', inWallet: true });
  check(v.verify.enabled === false, 'the gate of the OTHER network never enables this one');
  v = hc.humanCheckView({ status: st({ wallet: A, state: 'no' }, { wallet: B, state: 'no' }), gate: { testnet: ON }, network: 'testnet', inWallet: false });
  check(v.verify.enabled === false && v.verify.sub === 'Available once your wallet is set up.' && v.beta.action === 'continue-setup', 'first launch (before seal) → no passport yet; beta code continues setup');
  v = hc.humanCheckView({ status: st({ wallet: A, state: 'unknown' }, { wallet: B, state: 'no' }), gate: { testnet: ON }, network: 'testnet', inWallet: true });
  check(v.verify.enabled === false, 'couldn\'t check this wallet → Verify stays off (no blind second attempt)');
  v = hc.humanCheckView({ status: st({ wallet: A, state: 'yes' }, { wallet: B, state: 'no' }), gate: { testnet: ON }, network: 'testnet', inWallet: true });
  check(v.joined && v.verify === null && v.beta === null && v.joinedLine === "You're in on 🧪 TESTNET." && v.rows[0].line === '✅ Joined', 'joined → ✅, no buttons');
  v = hc.humanCheckView({ status: st({ wallet: A, state: 'yes' }, { wallet: null, state: 'none' }), gate: {}, network: 'mainnet', inWallet: true });
  check(!v.joined && v.rows[1].line === '⏳ No wallet here yet' && v.verify.enabled === false, 'joined on testnet does NOT mean joined on mainnet');
  v = hc.humanCheckView({ status: null, gate: null, network: 'testnet', inWallet: false });
  check(v.rows.every((r) => r.state === 'unknown') && !v.joined && v.verify.enabled === false, 'nothing loaded yet → ⏳ everywhere, nothing enabled');
}

// ── (2) APP WIRING ─────────────────────────────────────────────────────────
console.log('\n  (2) App.js wiring');
const ABOUT = between('  if (showAboutScreen) {', '  // ── Step 99: Seal Lock');
{
  check(ABOUT.length > 1000, 'About screen found');
  const iCard = ABOUT.indexOf('<HumanCheckCard'), iT1 = ABOUT.indexOf('Tile 1: What is this?'), iChips = ABOUT.indexOf('s.chipBar');
  check(iChips > 0 && iCard > iChips && iCard < iT1, 'order: header → sticky chips → 🛂 card → tile 1 (card near the top)');
  check(/stickyHeaderIndices=\{\[1\]\}/.test(ABOUT) && /\{\/\* Sticky jump-chips/.test(ABOUT), 'chips are child 1 of the About ScrollView = sticky');
  // child index 1 really is the chip bar: count direct children before it
  const body = ABOUT.slice(ABOUT.indexOf('contentContainerStyle'), iChips);
  check((body.match(/\n          <View/g) || []).length === 2, 'exactly one child (the header) precedes the chip bar');
  const keys = [...ABOUT.matchAll(/\['(\w+)', '[^']+'\]/g)].map((x) => x[1]);
  const marks = [...ABOUT.matchAll(/markY\('(\w+)'\)/g)].map((x) => x[1]);
  check(keys.length === 6 && keys.every((k) => marks.includes(k)) && marks.length === keys.length, `every chip jumps to a card that exists (${keys.join(', ')})`);
  check(/scrollTo\(\{ y: Math\.max\(0, y - aboutChipsH\.current - 6\)/.test(ABOUT), 'jump lands the card just under the sticky bar');
  check(/<ScreenWrapper domainBar=\{false\}>\s*\n\s*<SafeAreaView style=\{s\.root\}>\s*\n\s*<DomainStrip \/>\s*\n\s*<ScrollView ref=\{aboutScrollRef\}/.test(ABOUT.replace(/\r\n/g, '\n')),
    'About: floating domain label off, pinned DomainStrip above the scroll (chips never park under its text)');
  check(/aboutScrollRef = useRef/.test(SRC) && SRC.indexOf('const aboutY = useRef') < SRC.indexOf('  if (showIntroVideo && !IS_WEB) {'), 'all new hooks sit before the first conditional screen (hook order safe)');

  // beta code → EXISTING field / flow
  check(/ref=\{walletCodeInputRef\}\s*\n\s*value=\{ignitionCode\}/.test(SRC), 'wallet\'s existing invite-code box gets the focus ref');
  check((SRC.match(/value=\{ignitionCode\}/g) || []).length === 2, 'still exactly the two existing invite-code boxes — no new code field');
  check(/focusWalletCodeRef\.current = true;\s*\n\s*await closeAboutScreen\(\)/.test(ABOUT), 'beta code: close About, then focus the wallet box (first launch: setup continues to step 4)');

  // NO new mint logic
  const HC = between('// ── 🛂 Human check (About card)', '// (claim() reuses the restore guard');
  check(HC.length > 500, 'human-check block found');
  check(!/method:\s*'POST'|signTx|postIgnition|\/transaction|\/ignite\/self'|setClaimed|formation_ignited|secKeyRef/.test(HC),
    'human-check block: no POST, no signing, no claim, no ignition flag — read + route only');
  check(/\/tx\?from=FAUCET&to=\$\{wallet\}&limit=1/.test(HC) && /\/ignite\/self\/status/.test(HC) && /\/ignite\/self\/link\?wallet=/.test(HC), 'reads: /tx (FAUCET → wallet), /ignite/self/status, /ignite/self/link');
  check(/humanCheck\.walletAddress\(await SecureStore\.getItemAsync\(walletKey\(net\)\)/.test(HC) && !/loadOrCreateWallet|saveWallet|createKeypair/.test(HC), 'reads stored PUBLIC address only — never forges or saves a wallet');
  check(/if \(!humanCheck\.isSelfLink\(j && j\.link\)\)[\s\S]*?return Alert[\s\S]*?Linking\.openURL\(j\.link\)/.test(HC), 'Verify opens the link ONLY after isSelfLink() passes');
  check(/confirmAsync\([\s\S]*?humanCheck\.TEXT\.privacy[\s\S]*?'Open Self'/.test(HC), 'Verify asks first, showing the privacy text + wallet');
  check(/getNetwork\(\) !== net \|\| addrRef\.current !== wallet/.test(HC), 'network/wallet change during the prompt → nothing opened');
  check(/if \(!showAboutScreen\) return undefined;\s*\n\s*checkHumanStatus\(\);[\s\S]*?next === 'active'\) checkHumanStatus\(\)/.test(HC), 'status re-checked when About opens and when the user returns from Self');
  const CARD = between('const HumanCheckCard =', '// ── PhoneNodeStatus');
  check(CARD.length > 200 && !/fetch\(|AsyncStorage|SecureStore/.test(CARD), 'card component is display-only (no fetch / storage)');
  check(/disabled=\{!view\.verify\.enabled\}/.test(CARD), 'Verify button is truly disabled when OFF (not just dimmed)');
}

// ── (3) WORDING ────────────────────────────────────────────────────────────
console.log('\n  (3) About wording');
{
  const t1 = between('Tile 1: What is this?', 'Tile 2: Who made this?');
  const t2 = between('Tile 2: Who made this?', 'Tile 3: Is it safe?');
  const t3 = between('Tile 3: Is it safe?', 'Tile 4:');
  check(t1.includes("'Every verified human will get 1,000,000 '") && t1.includes("' MONEY. During testing, joining needs a beta code; the passport check is coming.'"), 'tile 1: "will get" + beta code during testing + passport coming');
  check(!/You prove you\\'re a real person, it\\'s yours/.test(SRC), 'tile 1: old "you prove you\'re a real person, it\'s yours" is gone');
  check(t2.includes('During testing the founder runs several test wallets — every one is listed in the founder statement. Before public launch he holds one share, like everyone else.'), 'tile 2: founder test wallets + one share before mainnet (approved draft)');
  check(!/the same as you\. No secret stash/.test(SRC) && !/No hidden advantage/.test(SRC), 'tile 2: "the same as you / no secret stash / no hidden advantage" is gone');
  check(t2.includes("openLink('https://github.com/Fokerfeit/Money#founder-statement')"), 'tile 2: "Founder statement →" link');
  check(t3.includes('You can run the node yourself — the code is open source — but joining the network needs an invite during testing.'), 'tile 3: invite clause added');
  check(t3.includes("openLink('https://github.com/Fokerfeit/Money')") && t3.includes('See the code →'), 'tile 3: "See the code →" → github.com/Fokerfeit/Money (public repo)');
  const gh = [...SRC.matchAll(/https:\/\/github\.com\/[^'"\s)#]+/g)].map((x) => x[0]);
  check(gh.length >= 1 && gh.every((u) => u === 'https://github.com/Fokerfeit/Money') && !/moneyforeveryone\.app\.git|Fokerfeit\/moneyforeveryone/.test(SRC), 'every GitHub link → Fokerfeit/Money; none to the frozen moneyforeveryone.app snapshot');
  const T = hc.TEXT;
  check(T.title === "🛂 Prove you're human" && T.verifyOff === 'Coming soon — use a beta code' && T.beta === '🎟️ I have a beta code', 'card title / OFF line / beta button wording');
  check(/name, photo, birth date,\s*'?\s*\+?\s*'?nationality and passport number stay on your phone/.test(fs.readFileSync(path.join(__dirname, 'human_check.js'), 'utf8')) && /your wallet address/.test(T.privacy) && /Self is a separate app/.test(T.privacy),
    'privacy text: what stays on the phone, what MONEY receives, Self is separate');
  // beta-code wording (approved): box label = BETA CODE everywhere, no TN- hint
  check((SRC.match(/✦ BETA CODE/g) || []).length === 2 && !/INVITE CODE/.test(SRC), 'both code boxes are labelled "✦ BETA CODE"; no "INVITE CODE" label is left');
  check((SRC.match(/placeholder="enter your beta code"/g) || []).length === 2 && !/enter your invite code/i.test(SRC), 'both placeholders say "enter your beta code"');
  check(SRC.includes('② Enter your beta code') && SRC.includes('Enter your beta code, then press IGNITE') && !/Enter your invite code/i.test(SRC), 'setup text says beta code ("② Enter your beta code", "Enter your beta code, then press IGNITE")');
  check(!/TN-/.test(SRC) && !/TN-/.test(JSON.stringify(T)) && T.betaHint === 'Your beta code from the team.', 'no "TN-" hint anywhere (app text or card)');
  check(!/Before mainnet he holds/.test(SRC) && !/Before mainnet/.test(t2), 'tile 2 says "Before public launch", not "Before mainnet"');
  check(!/anonymous|zero[- ]knowledge|nobody can ever|100%/i.test(T.privacy), 'privacy text makes no absolute claims ("anonymous", "nobody can ever", …)');
  check(!/[àâçéèêëîïôûùüÿœ]/i.test(JSON.stringify(T)), 'English only for this job (no French strings)');
}

// ── (4) PROTECTED + PROPOSAL ───────────────────────────────────────────────
console.log('\n  (4) protected files + server proposal');
{
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: __dirname }).toString().trim();
  const PROTECTED = ['mobile/server.js', 'mobile/ledger_chain.js', 'mobile/swarm/swarm_engine.js', 'mobile/swarm/node_client.js', 'mobile/swarm/relay.js', 'mobile/swarm/committee_bridge.js', 'mobile/self_gate.js'];
  const changed = execFileSync('git', ['diff', '--name-only', '21e6d19', '--', ...PROTECTED], { cwd: root }).toString().trim();
  check(changed === '', 'protected List A files unchanged vs 21e6d19', changed);
  const patchFile = path.join(__dirname, 'proposals', 'ignite_self_status.patch');
  // The proposal patch is deliberately NOT committed with the app change; its probes run only where it exists.
  if (!fs.existsSync(patchFile)) { console.log('   ⏭️   server proposal patch not in this checkout — its 3 probes skipped'); }
  else {
  const P = fs.readFileSync(patchFile, 'utf8');
  const added = P.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
  check(/app\.get\('\/ignite\/self\/status'/.test(added) && /app\.get\('\/ignite\/self\/link'/.test(added), 'proposal patch adds GET /ignite/self/status + GET /ignite/self/link');
  check(!/app\.post|commit\(|\.seal\(|writeFile|saveJSON/.test(added), 'proposal patch adds nothing that writes (no POST, commit, seal or file write)');
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hc-patch-'));
  try {
    fs.mkdirSync(path.join(tmp, 'mobile'));
    fs.writeFileSync(path.join(tmp, 'mobile', 'server.js'), execFileSync('git', ['show', '8340569:mobile/server.js'], { cwd: root, maxBuffer: 1 << 26 }));
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    execFileSync('git', ['apply', '--check', path.join(__dirname, 'proposals', 'ignite_self_status.patch')], { cwd: tmp });
    ok('proposal patch applies cleanly to self-gate/real-roundtrip-qr (8340569) server.js');
  } catch (e) { bad(`proposal patch does not apply to 8340569 — ${e.message.split('\n')[0]}`); }
  finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  }
}

console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Human check: ${fails === 0 ? 'ALL PROBES PASS' : fails + ' FAILURE(S)'}\n`);
process.exit(fails === 0 ? 0 : 1);
