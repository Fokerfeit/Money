// test_tester_feedback_oct8.js — tester feedback, Oct 8 (device: build 13).
// Every probe must pass; exit 0.
//
//   (A)  seal address: copy + share — copySealAddress() EXECUTED (lifted from App.js)
//        against a mock clipboard; card / QR wiring
//   (B1) header = glass card; "moneyforeveryone.app" pinned with its own backing
//   (B2) cards more opaque, readable hint
//   (B3) background: no straight layer edge can reach the screen — holo_geometry.js
//        EXECUTED (old build-13 sizing reproduced, new sizing proven over a grid of
//        phones/tilts); rings fade to nothing at their ends
//   (C)  PHONE NODE indicator — nodeIndicator() EXECUTED; proof that nothing but a
//        real in-app node can turn it ON
//
// App.js is React Native/JSX and cannot run under plain Node, so (as in the other
// App tests) structure is source-scanned — but every piece of LOGIC is executed.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let fails = 0;
const ok  = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };
const check = (c, m, d) => (c ? ok(m) : bad(d ? `${m} — ${d}` : m));

const SRC = fs.readFileSync(path.join(__dirname, 'App.js'), 'utf8').replace(/\r\n/g, '\n');
const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const fnText = (re) => (stripped.match(re) || [''])[0];
const HOLO = fs.readFileSync(path.join(__dirname, 'HoloFX.js'), 'utf8').replace(/\r\n/g, '\n');

(async () => {
  console.log('\n  🧪  TESTER FEEDBACK (OCT 8) — copy/share, look & feel, background seam, phone node\n');

  // ── (A) COPY + SHARE ──────────────────────────────────────────────────────
  console.log('  (A) seal address: copy + share');
  {
    const src = fnText(/const copySealAddress = async \(address, clipboard\) => \{[\s\S]*?\n\};/);
    // eslint-disable-next-line no-new-func
    const copySealAddress = new Function(`${src}; return copySealAddress;`)();
    const mk = (fail = false) => { const c = { got: [], async setStringAsync(v) { if (fail) throw new Error('no clipboard'); c.got.push(v); return true; } }; return c; };
    const ADDR = 'M_EDB46A052DDDC4C07E6C9A9DA0278380';
    const c1 = mk();
    check(await copySealAddress(ADDR, c1) === true && c1.got.length === 1 && c1.got[0] === ADDR, 'EXECUTED: a seal address is copied exactly, once');
    const junk = ['', null, undefined, 42, 'hello', 'M_', 'M_XYZ', 'abandon ability able about above absent absorb abstract absurd abuse access accident',
      'a'.repeat(64), `${ADDR}\nextra`, ` ${ADDR}`];
    const c2 = mk(); let anyTrue = false;
    for (const j of junk) if (await copySealAddress(j, c2)) anyTrue = true;
    check(!anyTrue && c2.got.length === 0, `EXECUTED: anything that is not a seal address (${junk.length} cases incl. a 24-word phrase and a 64-hex key) is NEVER put on the clipboard`);
    check(await copySealAddress(ADDR, mk(true)) === false, 'EXECUTED: a clipboard failure returns false (the app says "Copy failed — use SHARE"), never throws');
    // wiring
    const card = fnText(/\{\/\* CLAY SEAL \(wallet\)[\s\S]*?\{\/\* BALANCE \*\/\}/) || SRC.slice(SRC.indexOf('{/* CLAY SEAL (wallet)'), SRC.indexOf('{/* BALANCE */}'));
    check(/<Pressable style=\{s\.addrRow\} onPress=\{copySeal\} disabled=\{!address\}/.test(card), 'main card: the address itself is a tap-to-copy target (the rest of the card still opens the QR)');
    check(/<TouchableOpacity style=\{s\.qrBtn\} onPress=\{copySeal\}/.test(card) && /<TouchableOpacity style=\{s\.qrBtn\} onPress=\{shareSeal\}/.test(card) && /↗ SHARE/.test(card), 'QR view: COPY and SHARE buttons');
    check(/sealCopied \? '✓ COPIED' : '📋 COPY'/.test(card) && /sealCopied \? '✓ Copied' : '📋 copy'/.test(card), 'after a copy, both the button and the address row say "Copied"');
    check(/setTimeout\(\(\) => setSealCopied\(false\), 2000\)/.test(stripped) && /useEffect\(\(\) => \(\) => clearTimeout\(sealCopiedTimer\.current\), \[\]\)/.test(stripped), '"Copied" clears after 2 s (timer cleaned up on unmount)');
    check(/const shareSeal = \(\) => \{ if \(address\) Share\.share\(\{ message: address \}\)/.test(stripped), 'SHARE opens the Android share sheet with the address ONLY');
    check(/const ok = await copySealAddress\(address, Clipboard\);/.test(stripped) && /import \* as Clipboard from 'expo-clipboard';/.test(stripped), 'copy goes through the guarded helper with expo-clipboard');
    const pkg = require('./package.json');
    check(pkg.dependencies['expo-clipboard'] === '~8.0.8' && fs.existsSync(path.join(__dirname, 'node_modules/expo-clipboard/package.json')), 'expo-clipboard ~8.0.8 (the Expo SDK 54 version) installed');
    let linked = false;
    try {
      const out = execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['expo-modules-autolinking', 'resolve', '--platform', 'android', '--json'], { cwd: __dirname, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 1 << 24 });
      linked = (JSON.parse(out).modules || []).some((m) => m.packageName === 'expo-clipboard');
    } catch { linked = false; }
    check(linked, 'EXECUTED: Expo autolinking includes expo-clipboard in the Android build (new native code → needs build 15)');
  }

  // ── (B1 + B2) LOOK & FEEL ─────────────────────────────────────────────────
  console.log('\n  (B1+B2) header, pinned domain bar, card contrast');
  {
    check(/<View nativeID="app-header" style=\{\[glassCard, s\.header\]\}>/.test(stripped), 'the header is drawn with the cards\' own glassCard style');
    const hdr = fnText(/ {2}header: \{[\s\S]*?\n {2}\},/);
    check(!/#130A00/.test(hdr) && /marginHorizontal: 16/.test(hdr) && /borderBottomWidth: 4/.test(hdr), 'the solid edge-to-edge #130A00 block is gone — inset 16 dp, same bevel as the cards');
    check((stripped.match(/<ScreenWrapper domainBar=\{false\}>/g) || []).length === 1 && /<ScreenWrapper domainBar=\{false\}>\n {4}<SafeAreaView style=\{s\.root\}>\n {6}<GlowOrbs \/>/.test(SRC),
      'only the wallet screen swaps the floating domain text for its own strip (every other screen unchanged)');
    const iStrip = SRC.indexOf('<DomainStrip />'), iKS = SRC.indexOf('<KeyboardSafe', iStrip);
    check(iStrip > 0 && iKS > iStrip && SRC.slice(iStrip, iKS).split('\n').length < 6, 'DomainStrip sits in the layout ABOVE the scroll view → pinned while the wallet scrolls, content never under its text');
    check(/domainStrip: +\{[^}]*backgroundColor: 'rgba\(14,8,2,0\.78\)'/.test(stripped) && /<Text style=\{s\.domainStripText\}>moneyforeveryone\.app<\/Text>/.test(stripped), 'the strip has its own glass backing');
    check(/\{Platform\.OS !== 'web' && domainBar && \(/.test(stripped), 'ScreenWrapper keeps the floating domain text for all other screens (domainBar defaults to true)');
    check(/backgroundColor: 'rgba\(20,12,3,0\.86\)', borderWidth: 1, borderColor: 'rgba\(212,175,55,0\.36\)'/.test(HOLO), 'cards: 86% opaque (was 64%) with a brighter gold rim (0.36, was 0.24)');
    check(/ {2}hint: +\{ color: '#9A7B4A'/.test(stripped), 'the card hint is readable (#9A7B4A, was #4A2E10 dark-on-dark)');
  }

  // ── (B3) BACKGROUND SEAM ──────────────────────────────────────────────────
  console.log('\n  (B3) background: no straight layer edge can reach the screen');
  {
    const G = require('./holo_geometry.js');
    check(G.SCALE === 1.28 && G.PARALLAX === 40, 'same zoom (1.28) and tilt range (±40 dp) as build 13 — the look is unchanged');
    // OLD (build 13): every layer = window W×H at (0,0), whatever the background really fills
    const oldLayout = (w, h) => ({ style: { left: 0, top: 0, width: w, height: h } });
    const S = { w: 412, h: 915 };
    const shortWins = [];
    for (let f = 0.70; f <= 1.0001; f += 0.05) if (!G.edgesAlwaysOffScreen(oldLayout(S.w, Math.round(S.h * f)), S.w, S.h)) shortWins.push(Math.round(f * 100));
    const midSeam = G.layerEdgesOnScreen(oldLayout(S.w, Math.round(S.h * 0.70)), S.w, S.h, 0, 0).bottom;
    check(shortWins.length > 0 && !shortWins.includes(100), `EXECUTED (build 13 reproduced): when the size read at start-up is short (${shortWins.join('%, ')}% of the screen) a layer edge is ON screen — at 70% a hard line sits at y≈${Math.round(midSeam)} of ${S.h} dp, i.e. mid-screen`);
    // NEW: sized from the measured area, overdrawn
    const phones = [];
    for (const w of [320, 360, 393, 412, 430, 480, 600, 800]) for (const h of [568, 640, 740, 800, 851, 915, 960, 1000, 1280]) phones.push([w, h]);
    phones.push([915, 412], [1280, 800]);   // landscape / tablet, in case
    const leaks = phones.filter(([w, h]) => !G.edgesAlwaysOffScreen(G.bgLayout(w, h), w, h));
    check(leaks.length === 0, `EXECUTED: sized from its own measured area, no layer edge reaches the screen on ANY of ${phones.length} screen sizes at ANY of 9 tilt extremes`);
    const firstFrame = [];
    for (const [w, h] of phones) for (const f of [0.7, 0.8, 0.9, 1]) if (!G.edgesAlwaysOffScreen(G.bgLayout(w, h), Math.round(w * f), Math.round(h * f))) firstFrame.push([w, h, f]);
    check(firstFrame.length === 0, 'EXECUTED: first frame (sized from the full screen before measuring) is also edge-free for any real area 70–100% of it');
    const L = G.bgLayout(412, 915);
    check(L.M > 0 && L.style.left === -L.M && L.style.top === -L.M && L.style.width === 412 + 2 * L.M && L.viewBox === `${-L.M} ${-L.M} ${412 + 2 * L.M} ${915 + 2 * L.M}`, `EXECUTED: every layer is overdrawn by ${L.M} dp on every side with unchanged drawing coordinates`);
    // HoloFX wiring
    check(!/Dimensions\.get\('window'\)/.test(HOLO) && /Dimensions\.get\('screen'\)/.test(HOLO) && /onLayout=\{onLayout\}/.test(HOLO) && /const L = bgLayout\(size\.w, size\.h\);/.test(HOLO),
      'HoloFX: no more size read once from the window — first frame = full screen, then the measured size (onLayout)');
    const bg = HOLO.slice(HOLO.indexOf('export const HoloBackground'), HOLO.indexOf('// ── MID layer'));
    check((bg.match(/<Svg /g) || []).length === 0 && (bg.match(/<Layer L=\{L\}>/g) || []).length === 7 && /const Layer = \(\{ L, children \}\) => <Svg width=\{L\.style\.width\} height=\{L\.style\.height\} viewBox=\{L\.viewBox\}>/.test(HOLO),
      'all 7 background SVG layers go through the one overdrawn Layer (none sized by hand)');
    check((bg.match(/<Rect \{\.\.\.L\.full\}/g) || []).length === 3 && !/<Rect x="0" y=\{H \* 0\.62\}/.test(bg), 'base, aurora and vignette fill the WHOLE overdrawn area — the aurora no longer starts at a hard 62% line');
    check(/<LinearGradient id="aurora" x1=\{0\} y1=\{H\} x2=\{0\} y2=\{H \* 0\.62\} gradientUnits="userSpaceOnUse">/.test(bg), 'aurora fades to fully transparent from 62% upward, in absolute coordinates (no reliance on shape-relative units)');
    check(/<RadialGradient id="space" cx=\{W \* 0\.5\} cy=\{H \* 0\.3\} rx=\{W \* 0\.9\} ry=\{H \* 0\.9\}/.test(bg) && /<RadialGradient id="vign" cx=\{W \* 0\.5\} cy=\{H \* 0\.42\} rx=\{W \* 0\.75\} ry=\{H \* 0\.75\}/.test(bg),
      'space + vignette gradients keep build 13\'s exact shape (same centre and radii) over the larger fill');
    // rings fade toward their ends
    const W = 412;
    const rings = [['inner', G.ringFade(W * 1.02, W * 0.82, W)], ['outer', G.ringFade(W * 1.02, W * 1.05, W)]];
    const [visL, visR] = G.visibleSpan(W);
    for (const [name, f] of rings) {
      const peak = Math.max(...Array.from({ length: 201 }, (_, i) => G.ringAlphaAt(f, f.x1 + ((f.x2 - f.x1) * i) / 200)));
      check(f.stops[0][1] === 0 && f.stops[f.stops.length - 1][1] === 0 && G.ringAlphaAt(f, visL) === 0 && G.ringAlphaAt(f, visR) === 0 && G.ringAlphaAt(f, -1e6) === 0 && G.ringAlphaAt(f, 1e6) === 0 && peak > 0.95,
        `EXECUTED: ${name} ring is fully transparent at both screen edges and beyond, brightest mid-arc — it fades away instead of being cut`);
    }
    check(/stroke="url\(#ringA\)"/.test(bg) && /stroke="url\(#ringB\)"/.test(bg) && /<LinearGradient id="ringA" x1=\{ringA\.x1\}/.test(bg), 'both ring strokes use their fade gradients');
  }

  // ── (C) PHONE NODE ────────────────────────────────────────────────────────
  console.log('\n  (C) PHONE NODE — honest today, ON only from a real node');
  {
    const { nodeIndicator, FRESH_MS } = require('./phone_node.js');
    const now = 1_760_000_000_000;
    const good = { running: true, relayConnected: true, lastValidatedAt: now - 1000, peers: [{ id: 'M_A', lastValidAt: now - 5000 }, { id: 'M_B', lastValidAt: now - 9000 }, { id: 'M_A', lastValidAt: now - 2000 }] };
    const r = nodeIndicator(good, now);
    check(r.on === true && r.peers === 2, `EXECUTED: a node that is running + connected + checked a trade + has fresh peers → ON with ${r.peers} DISTINCT peers (a peer counted once)`);
    const offCases = {
      'null (today: no node in the app)': null, undefined, 'empty object': {}, 'true': true, '"on"': 'on',
      'running only': { running: true },
      'running:"true" (string)': { ...good, running: 'true' },
      'not connected to relay': { ...good, relayConnected: false },
      'never checked a trade itself': { ...good, lastValidatedAt: undefined },
      'last own check 2 min + 1 ms ago': { ...good, lastValidatedAt: now - FRESH_MS - 1 },
      'own check dated in the future': { ...good, lastValidatedAt: now + 60_000 },
      'no peers': { ...good, peers: [] },
      'peers not a list': { ...good, peers: 'M_A,M_B' },
      'only stale peers': { ...good, peers: [{ id: 'M_A', lastValidAt: now - FRESH_MS - 1 }] },
      'only future-dated peers': { ...good, peers: [{ id: 'M_A', lastValidAt: now + 1 }] },
      'peers without ids': { ...good, peers: [{ lastValidAt: now }, { id: '', lastValidAt: now }, { id: 7, lastValidAt: now }] },
      'a forced on:true field': { on: true, peers: 9 },
    };
    const leaked = Object.entries(offCases).filter(([, v]) => nodeIndicator(v, now).on !== false);
    check(leaked.length === 0, `EXECUTED: OFF for every incomplete / stale / malformed / faked input (${Object.keys(offCases).length} cases)`, leaked.map(([k]) => k).join(', '));
    check(nodeIndicator(good, NaN).on === false && nodeIndicator(good, undefined).on === false, 'EXECUTED: OFF without a valid clock');
    // nothing else can turn it ON
    const PN = fs.readFileSync(path.join(__dirname, 'phone_node.js'), 'utf8');
    check(/module\.exports = \{ nodeIndicator, FRESH_MS \};/.test(PN) && !/AsyncStorage|SecureStore|setItem|process\.env|global\.|let /.test(PN), 'phone_node.js: no setter, no flag, no storage, no env, no mutable state — input in, verdict out');
    check((stripped.match(/\bPHONE_NODE\b/g) || []).length === 2 && /const PHONE_NODE = null;/.test(stripped) && /<PhoneNodeStatus node=\{PHONE_NODE\} \/>/.test(stripped),
      'App.js: the only node passed in is the module constant PHONE_NODE = null (defined once, used once) — no state, setting or toggle can change it');
    check((stripped.match(/<PhoneNodeStatus /g) || []).length === 1, 'the indicator is rendered in exactly one place');
    const comp = fnText(/const PhoneNodeStatus = \(\{ node \}\) => \{[\s\S]*?\n\};/);
    check(/const view = nodeIndicator\(stats, now\);/.test(comp) && /if \(view\.on !== true\) \{/.test(comp) && comp.indexOf('PHONE NODE · ON') > comp.indexOf('if (view.on !== true) {'),
      'the ON look is only reachable after nodeIndicator() said on === true');
    check((stripped.match(/PHONE NODE · ON/g) || []).length === 1 && (stripped.match(/flat share, no extra reward/g) || []).length === 1, 'the ON text exists in exactly one place (inside that branch)');
    check(!/nodeOn|setNodeOn|nodeEnabled|demoNode|fakeNode|NODE_DEMO|nodeToggle/i.test(stripped), 'no demo / toggle / enable switch for the node anywhere in App.js');
    check(/PHONE NODE · OFF/.test(comp) && /Your phone isn't validating yet — coming with the swarm bridge\./.test(comp) && /if \(!node\) return undefined;/.test(comp),
      'OFF: the exact approved text, dim, no animation and no timer when there is no node');
  }

  console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Tester feedback (Oct 8): ${fails === 0 ? 'ALL PROBES PASS' : fails + ' FAILURE(S)'}\n`);
  process.exit(fails === 0 ? 0 : 1);
})();
