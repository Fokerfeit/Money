// test_tab_nav.js — bottom tab bar (Wallet · Ledger · Contacts · Human · About),
// the lock-over-About fix, and the Back buttons on Back up / Restore.
// Every probe must pass; exit 0.
//
//   (1) routeOf()/tabBarModel() EXECUTED over every screen step and flag
//   (2) rule: the LOCK screen always wins — over About and over every tab
//   (3) rule: tabs never bypass the passcode gate or the PIN-to-send confirmation
//   (4) rule: hidden during onboarding / lock / backup / restore / intro; keyboard
//   (5) rule: safe-area, one tab highlighted
//   (6) Back up (50) / Restore (51) are never a dead end
//   (7) the five tabs show what they should
//
// App.js is React Native/JSX and cannot run under plain Node, so (as in the other App
// tests) structure is source-scanned — but every piece of LOGIC is executed.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const nav = require('./tab_nav');

let fails = 0;
const ok  = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };
const check = (c, m, d) => (c ? ok(m) : bad(d ? `${m} — ${d}` : m));

const SRC = fs.readFileSync(path.join(__dirname, 'App.js'), 'utf8').replace(/\r\n/g, '\n');
const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const between = (text, a, b) => { const i = text.indexOf(a); const j = text.indexOf(b, i + 1); return i >= 0 && j > i ? text.slice(i, j) : ''; };
const fnText = (text, re) => (text.match(re) || [''])[0];

const STEPS = [null, undefined, 0, 2, 3, 4, 5, 6, 12, 25, 35, 36, 50, 51, 99];
const TABS = ['wallet', 'ledger', 'contacts', 'human', 'about'];

console.log('\n  🧪  TAB BAR — routing, lock, hidden screens, safe-area, Back buttons\n');

// ── (1) EXECUTED: routeOf / tabBarModel ────────────────────────────────────
console.log('  (1) tab_nav.js — executed');
{
  const r = (o) => nav.routeOf({ introActive: false, showAboutScreen: false, ...o });
  check(r({ onboardingStep: 0 }) === 'wallet' && r({ onboardingStep: 50 }) === 'backup' && r({ onboardingStep: 51 }) === 'restore' && r({ onboardingStep: 99 }) === 'lock', 'steps map: 0 wallet · 50 backup · 51 restore · 99 lock');
  check([2, 3, 4, 5, 6, 12, 25, 35, 36].every((n) => r({ onboardingStep: n }) === 'onboarding'), 'Oath / thumbs / PIN / MONEY PIN / seal / network picker / ignition (12,3,35,36,4,6…) = onboarding');
  check(r({ onboardingStep: null }) === 'loading' && r({ onboardingStep: undefined }) === 'loading', 'step not known yet = loading');
  check(nav.routeOf({ introActive: true, onboardingStep: 0, showAboutScreen: false }) === 'intro', 'intro video wins while it plays');
  check(r({ onboardingStep: 12, showAboutScreen: true }) === 'about-first' && r({ onboardingStep: 0, showAboutScreen: true }) === 'about-first', 'first-launch About (flag set, not locked) = about-first');
  check(nav.routeOf() === 'loading' && nav.routeOf({}) === 'loading', 'no input = loading (never the wallet)');
}

// ── (2) RULE: lock always wins ─────────────────────────────────────────────
console.log('\n  (2) the lock screen ALWAYS wins');
{
  // before the fix: About was checked first, so About stayed up over a re-lock
  const OLD = (o) => (o.introActive ? 'intro' : (o.onboardingStep == null ? 'loading' : (o.showAboutScreen ? 'about-first' : (o.onboardingStep === 99 ? 'lock' : 'other'))));
  check(OLD({ onboardingStep: 99, showAboutScreen: true }) === 'about-first', 'sanity: the OLD order let About cover the lock screen (this is the bug)');
  let all = true; const wrong = [];
  for (const about of [false, true]) for (const tab of TABS) {
    const route = nav.routeOf({ introActive: false, onboardingStep: 99, showAboutScreen: about });
    const bar = nav.tabBarModel({ route, mainTab: tab, keyboardOpen: false });
    if (route !== 'lock' || bar.visible) { all = false; wrong.push(`${tab}/about=${about}`); }
  }
  check(all, `re-lock while on each tab (wallet, ledger, contacts, human, about) × About flag on/off → lock screen, no tab bar (${wrong.join(',') || 'all 10 ok'})`);
  // full relock walk: on tab X (unlocked) → AppState relock sets step 99 → lock → unlock → wallet tab
  for (const tab of TABS) {
    const before = nav.routeOf({ introActive: false, onboardingStep: 0, showAboutScreen: false });
    const during = nav.routeOf({ introActive: false, onboardingStep: 99, showAboutScreen: false });
    if (before !== 'wallet' || during !== 'lock') all = false;
  }
  check(all, 'walk: wallet (any tab) → step 99 → lock');

  // App.js really uses it
  check(!/if \(showAboutScreen\)/.test(stripped), 'App.js: no raw `if (showAboutScreen)` screen check is left');
  check(/const route = routeOf\(\{ introActive: showIntroVideo && !IS_WEB, onboardingStep, showAboutScreen \}\);/.test(stripped) && /if \(route === 'about-first'\) \{/.test(stripped), 'App.js: the first-launch About is chosen by routeOf() (lock-aware)');
  check(stripped.indexOf("if (route === 'about-first')") < stripped.search(/\n  if \(onboardingStep === 99\) \{/), 'App.js order: About check sits above the lock block — safe only because routeOf() excludes step 99 from it');
  const relock = between(stripped, "AppState.addEventListener('change', async (next) => {", 'appStateRef.current = next;');
  check(/setOnboardingStep\(99\)/.test(relock) && /away > REAUTH_AWAY_MS && bioKeyActive/.test(relock), 're-lock path: after a real absence the app sets step 99');
  check(/useEffect\(\(\) => \{ if \(onboardingStep === 99\) setMainTab\('wallet'\); \}, \[onboardingStep\]\);/.test(stripped), 'whatever sets step 99, you come back to the Wallet tab after unlocking');
  check(/'wallet', 'ledger'|key: 'wallet'/.test(fs.readFileSync(path.join(__dirname, 'tab_nav.js'), 'utf8')) && stripped.indexOf('const [mainTab, setMainTab]') > 0, 'one `mainTab` value drives every tab (no second source of truth)');
}

// ── (3) RULE: no bypass of passcode / PIN-to-send ──────────────────────────
console.log('\n  (3) tabs never bypass the passcode gate or PIN-to-send');
{
  const TABBAR = fnText(stripped, /const TabBar = \(\{ model, onSelect \}\) => \{[\s\S]*?\n\};/);
  check(TABBAR.length > 200, 'TabBar component found');
  check(!/authenticateBioKey|setTxModalVisible|signTx|send\b|passcode|reAuth|setOnboardingStep|setBioKey|fetch\(|SecureStore|AsyncStorage|setClaimed/i.test(TABBAR), 'TabBar: no auth / send / signing / lock / storage / network code reachable');
  check(/onSelect\(t\.key\)/.test(TABBAR) && (stripped.match(/<TabBar /g) || []).length === 1 && /<TabBar model=\{tabBarModel\(\{ route, mainTab, keyboardOpen \}\)\} onSelect=\{setMainTab\} \/>/.test(stripped), 'a tab press only calls setMainTab(key) — the one TabBar in the app');
  check(/key === 'human' && !aboutInline\) \{ setMainTab\('human'\); return; \}/.test(stripped), 'the About 🛂 chip only switches tab');

  // PIN-to-send path is byte-for-byte what it was before the tab bar
  let base = null;
  try { base = execFileSync('git', ['show', 'b667903:mobile/App.js'], { cwd: __dirname, maxBuffer: 1 << 27 }).toString().replace(/\r\n/g, '\n'); } catch {}
  if (!base) { console.log('   ⏭️   base commit b667903 not available here — unchanged-send probes skipped'); }
  else {
    const grab = (t, re) => fnText(t, re);
    const defs = {
      send: /const send = async \(\) => \{[\s\S]*?\n  \};/,
      authenticateBioKey: /const authenticateBioKey = \(reason\) => \{[\s\S]*?\n  \};/,
      cancelTxModal: /const cancelTxModal = \(\) => \{[\s\S]*?\n  \};/,
      claim: /const claim = async \(\) => \{[\s\S]*?\n  \};/,
      applyPenalty: /const applyPenalty = async \(\) => \{[\s\S]*?\n  \};/,
    };
    for (const [name, re] of Object.entries(defs)) {
      // the ONE deliberate change since then: the rejection alert shows friendlyServerError(r.error) (invite code -> beta code); undo it to compare the rest byte-for-byte
      const a = grab(base, re), b = grab(SRC, re).split('friendlyServerError(r.error)').join('r.error');
      check(a.length > 100 && a === b, `${name}() is byte-for-byte unchanged since the commit before the tab bar`);
    }
    const txModalOf = (t) => between(t, '<Modal visible={txModalVisible}', '</Modal>');
    check(txModalOf(base).length > 200 && txModalOf(base) === txModalOf(SRC), 'the PIN-to-send confirmation modal is unchanged');
  }
  const MAIN = SRC.slice(SRC.indexOf('  // ── MAIN APP'), SRC.indexOf('// ── Root shell'));
  const iModal = MAIN.indexOf('<Modal visible={txModalVisible}'), iPane = MAIN.indexOf('s.pane');
  check(iModal > 0 && iPane > iModal && !/<View style=\{\[s\.pane[\s\S]{0,4000}<Modal visible=\{txModalVisible\}/.test(MAIN.slice(iPane)), 'the PIN-to-send modal is drawn OUTSIDE every pane, so it covers the whole wallet incl. the tab bar');
  const iSheets = MAIN.indexOf('<Modal visible={contactsVisible}'), iDomain = MAIN.indexOf('<DomainStrip />');
  check(iSheets > 0 && iSheets < iDomain && MAIN.indexOf('<Modal visible={unlockSettingsVisible}') < iDomain && MAIN.indexOf('<Modal visible={saveContactAddr !== null}') < iDomain, 'the contacts / unlock-method / rename sheets stay mounted whatever tab shows (a rename can start on the Ledger tab)');
}

// ── (4) RULE: hidden on onboarding / lock / backup / restore ───────────────
console.log('\n  (4) hidden where it must be');
{
  const vis = (o) => nav.tabBarModel({ route: nav.routeOf({ introActive: false, showAboutScreen: false, ...o }), mainTab: 'wallet', keyboardOpen: false }).visible;
  const visibleSteps = STEPS.filter((n) => vis({ onboardingStep: n }));
  check(visibleSteps.length === 1 && visibleSteps[0] === 0, `of ${STEPS.length} step values only step 0 (the unlocked wallet) shows the bar (shown on: ${JSON.stringify(visibleSteps)})`);
  check([3, 4, 6, 12, 35, 36].every((n) => !vis({ onboardingStep: n })), 'hidden on the Oath (12), thumbs (3), PIN (35), MONEY PIN (36), seal + beta code + network picker (4), ignition (6)');
  check(!vis({ onboardingStep: 99 }), 'hidden on the lock screen (99)');
  check(!vis({ onboardingStep: 50 }) && !vis({ onboardingStep: 51 }), 'hidden on Back up (50) and Restore (51)');
  check(!nav.tabBarModel({ route: nav.routeOf({ introActive: true, onboardingStep: 0, showAboutScreen: false }), mainTab: 'wallet' }).visible, 'hidden during the intro video');
  check(!nav.tabBarModel({ route: nav.routeOf({ introActive: false, onboardingStep: 0, showAboutScreen: true }), mainTab: 'wallet' }).visible && !nav.tabBarModel({ route: nav.routeOf({ introActive: false, onboardingStep: 12, showAboutScreen: true }), mainTab: 'wallet' }).visible, 'hidden on the first-launch About');
  check(nav.tabBarModel({ route: 'wallet', mainTab: 'wallet', keyboardOpen: true }).visible === false && nav.tabBarModel({ route: 'wallet', mainTab: 'wallet', keyboardOpen: false }).visible === true, 'steps aside while the keyboard is open, back when it closes');
  check(nav.tabBarModel({ route: 'wallet', mainTab: 'wallet', keyboardOpen: undefined }).visible === true && nav.tabBarModel({ route: 'wallet', mainTab: 'wallet', keyboardOpen: 'yes' }).visible === true, 'only a literal keyboardOpen === true hides it');
  const kb = fnText(stripped, /function useKeyboardOpen\(\) \{[\s\S]*?\n\}/);
  check(/keyboardWillShow/.test(kb) && /keyboardDidShow/.test(kb) && /keyboardDidHide/.test(kb) && /\.remove\(\)/.test(kb), 'useKeyboardOpen listens for show + hide (iOS will / Android did) and cleans up');
  // wiring: TabBar only in the main return, after every onboarding return
  const iBar = stripped.indexOf('<TabBar model');
  check(iBar > stripped.indexOf('if (onboardingStep === 51)') && iBar > stripped.indexOf('if (onboardingStep === 99)') && iBar > stripped.indexOf('if (onboardingStep === 6)') && iBar > stripped.indexOf("if (route === 'about-first')"), 'the one <TabBar> is in the main return, below every onboarding / lock / backup / restore / first-About screen');
  const iHook = stripped.indexOf('const keyboardOpen = useKeyboardOpen();');
  check(iHook > 0 && iHook < stripped.indexOf('if (showIntroVideo && !IS_WEB) {') && /tabBarModel\(\{ route, mainTab, keyboardOpen \}\)/.test(stripped), 'hook order: useKeyboardOpen() exists, runs before the first conditional screen, and feeds the bar');
}

// ── (5) RULE: safe-area + one highlighted tab ──────────────────────────────
console.log('\n  (5) safe-area and the highlighted tab');
{
  const MAIN = SRC.slice(SRC.indexOf('  // ── MAIN APP'), SRC.indexOf('// ── Root shell'));
  check(/<ScreenWrapper domainBar=\{false\}>\n {4}<SafeAreaView style=\{s\.root\}>\n {6}<GlowOrbs \/>/.test(MAIN) && MAIN.indexOf('<TabBar model') > MAIN.indexOf('<SafeAreaView style={s.root}>') && MAIN.indexOf('<TabBar model') < MAIN.lastIndexOf('</SafeAreaView>'), 'TabBar sits INSIDE the screen\'s safe-area view, as its last child');
  check(!/<SafeAreaView[^>]*edges/.test(MAIN.slice(0, MAIN.indexOf('<TabBar model') + 40).split('{/* Sheets')[0] + MAIN.slice(MAIN.indexOf('{/* Pinned domain bar'))), 'that safe-area view does not drop the bottom edge (no `edges` prop on it) → the bar rides above the Android nav buttons');
  check(/import \{[^}]*SafeAreaView[^}]*\} from 'react-native-safe-area-context'/.test(SRC), 'SafeAreaView comes from react-native-safe-area-context (real system-bar insets, incl. Android)');
  check(/tabBar:\s*\{[^}]*flexDirection: 'row'/.test(SRC) && !/tabBar:\s*\{[^}]*position: 'absolute'/.test(SRC), 'the bar is in the layout (not floating over content), so nothing hides behind it');
  for (const t of TABS) {
    const m = nav.tabBarModel({ route: 'wallet', mainTab: t, keyboardOpen: false });
    const act = m.tabs.filter((x) => x.active).map((x) => x.key);
    if (act.length !== 1 || act[0] !== t) { bad(`current=${t}: highlighted ${JSON.stringify(act)}`); }
  }
  ok('for each of the 5 tabs exactly ONE tab is highlighted — the current one');
  const junk = ['', null, undefined, 'settings', 7, {}];
  check(junk.every((j) => { const m = nav.tabBarModel({ route: 'wallet', mainTab: j }); return m.tabs.filter((x) => x.active).length === 1 && m.current === 'wallet'; }), 'an unknown / missing tab value falls back to Wallet — still exactly one highlighted');
  const TB = fnText(stripped, /const TabBar = \(\{ model, onSelect \}\) => \{[\s\S]*?\n\};/);
  check(/accessibilityState=\{\{ selected: t\.active \}\}/.test(TB) && /t\.active && s\.tabItemActive/.test(TB), 'highlight + screen-reader "selected" both come from t.active');
}

// ── (6) Back up / Restore are never a dead end ─────────────────────────────
console.log('\n  (6) Back up (50) and Restore (51) — always a way back');
{
  const backup = between(SRC, '  if (onboardingStep === 50) {', '  // ── Screen 51');
  const restore = between(SRC, '  if (onboardingStep === 51) {', '  const reward    = calcReward(userCount);');
  check(backup.length > 500 && /<BackButton label="Back to wallet" onPress=\{\(\) => setOnboardingStep\(0\)\} \/>/.test(backup), 'Back up: a "← Back to wallet" button (→ step 0)');
  check(backup.indexOf('<BackButton') < backup.indexOf('Back Up Your Wallet') && backup.indexOf('<BackButton') > 0, 'Back up: the button is at the TOP, above the title (visible without scrolling)');
  check(/markBackupConfirmed/.test(backup) && /setOnboardingStep\(0\)/.test(backup), 'Back up: the existing "I have written down my 24 words — done" is still there');
  check(restore.length > 500 && /<BackButton label=\{restoreBackLabel\(restoreBackTarget\(restoreReturnTo\.current, isIgnitedRef\.current\)\)\} onPress=\{leaveRestore\} \/>/.test(restore) && restore.indexOf('<BackButton') < restore.indexOf('Restore Your Wallet'), 'Restore: a Back button at the TOP, labelled by where it goes');
  check(/onPress=\{leaveRestore\}>\s*\n\s*<Text[^>]*>← \{restoreBackLabel\(restoreBackTarget\(restoreReturnTo\.current, isIgnitedRef\.current\)\)\}<\/Text>/.test(restore), 'Restore: the bottom button is the same labelled Back (no more bare "Cancel" from the wallet)');
  const leave = fnText(stripped, /const leaveRestore = \(\) => \{[\s\S]*?\n  \};/);
  check(/restoreBackTarget\(restoreReturnTo\.current, isIgnitedRef\.current\)/.test(leave) && /restoreReturnTo\.current = null;/.test(leave) && /setOnboardingStep\(back\)/.test(leave) && /setSeedInput\(''\)/.test(leave), 'leaveRestore: clears the typed words, returns to where Restore was opened from');
  // execute the real target helper lifted from App.js
  const rbt = fnText(SRC, /const restoreBackTarget = \(openedFrom, isIgnited\) =>\n[^\n]*\n/);
  // eslint-disable-next-line no-new-func
  const restoreBackTarget = new Function(`${rbt}; return restoreBackTarget;`)();
  const L = (from, ign) => nav.restoreBackLabel(restoreBackTarget(from, ign));
  check(L(0, true) === 'Back to wallet' && L(null, true) === 'Back to wallet' && L(undefined, true) === 'Back to wallet', 'opened from the wallet (or with no opener, ignited) → "Back to wallet"');
  check([12, 3, 35, 4, 99].every((n) => L(n, false) === 'Cancel') && L(null, false) === 'Cancel', 'opened from onboarding / the lock screen → "Cancel" (there is no wallet to go back to yet)');
  check(restoreBackTarget(0, true) === 0 && nav.routeOf({ introActive: false, onboardingStep: restoreBackTarget(0, true), showAboutScreen: false }) === 'wallet' && nav.tabBarModel({ route: 'wallet', mainTab: 'wallet' }).visible, 'going back from Restore / Back up lands on the wallet — tab bar back');
  check(/openRestore\(0\)/.test(stripped) && /setOnboardingStep\(50\)/.test(stripped), 'the wallet still links to both screens (🔑 BACK UP WALLET, ♻️ RESTORE WALLET)');
}

// ── (7) the five tabs ──────────────────────────────────────────────────────
console.log('\n  (7) the five tabs');
{
  check(nav.TABS.map((t) => `${t.icon} ${t.label}`).join(' · ') === '💰 Wallet · 📜 Ledger · 📇 Contacts · 🛂 Human · ℹ️ About' && nav.TABS.length <= 5, 'exactly the approved five, in order, max 5');
  const MAIN = SRC.slice(SRC.indexOf('  // ── MAIN APP'), SRC.indexOf('// ── Root shell'));
  const wallet = between(MAIN, '{/* Wallet tab */}', '{/* Ledger tab');
  const ledger = between(MAIN, '{/* Ledger tab', '{/* Contacts tab');
  const contacts = between(MAIN, '{/* Contacts tab', '{/* Human tab');
  check(wallet.length > 1000 && !/THE CLAY TABLETS/.test(wallet) && /Invite to the Swarm/.test(wallet) && /INSCRIBE TRADE/.test(wallet) && /BACK UP WALLET/.test(wallet) && /RESTORE WALLET/.test(wallet) && /UNLOCK:/.test(wallet), 'Wallet tab: seal, balance, invite, claim, trade, backup / restore / unlock links — ledger moved out');
  check(/THE CLAY TABLETS — PUBLIC RECORD/.test(ledger) && /refreshControl=/.test(ledger) && /txs\.map/.test(ledger) && /nameLedgerAddr/.test(ledger), 'Ledger tab: the clay tablets, pull-to-refresh, tap-to-name still wired');
  check(/📇 CONTACTS/.test(contacts) && /startEditContact/.test(contacts) && /deleteContact/.test(contacts) && /addManualContact/.test(contacts) && /<KeyboardSafe/.test(contacts), 'Contacts tab: list / rename / delete / add, inside a KeyboardSafe');
  check(/setRecipient\(c\.address\); setMainTab\('wallet'\)/.test(contacts), 'Contacts tab: tapping a contact fills the recipient and returns to Wallet');
  check(/mainTab === 'human' && \(/.test(MAIN) && /mainTab === 'about' && <View style=\{s\.pane\}>\{aboutScroll\}<\/View>/.test(MAIN), 'Human and About panes mount only while showing');
  check(/onPress=\{\(\) => setMainTab\('about'\)\}[\s\S]{0,200}WHAT IS MONEY\?/.test(wallet) && !/setShowAboutScreen\(true\)/.test(stripped.replace(/const handleIntroEnd[\s\S]*?\n  \};/, '')), '"WHAT IS MONEY? →" opens the About TAB (the full-screen About is first-launch only)');
  check(/\{aboutInline && \(\s*\n\s*<View onLayout=\{markY\('human'\)\}/.test(SRC) && /ABOUT_CHIPS/.test(SRC), 'About: the human card is inline only on the first-launch About; the wallet About keeps the chips (🛂 chip → Human tab)');
  check(/if \(aboutInline\) await closeAboutScreen\(\); else setMainTab\('wallet'\);/.test(stripped) && /mainTab !== 'wallet'/.test(fnText(stripped, /\/\/ "I have a beta code" from the wallet[\s\S]*?\[showAboutScreen, mainTab\]\);/) || stripped), 'beta code: wallet → Wallet tab, focus the code box; first launch → continue setup');
  check(/if \(!showAboutScreen && !\(onboardingStep === 0 && mainTab === 'human'\)\) return undefined;/.test(stripped), 'the human check re-reads status on the Human tab (and on the first-launch About)');
  const nonAbout = [...SRC.matchAll(/<ScreenWrapper domainBar=\{false\}>/g)].length;
  check(nonAbout === 2, 'domainBar={false} stays on exactly two screens: the wallet shell and the first-launch About');
}

// ── Decorative layers (HoloFX / GlowOrbs) never cover the tab bar ──
{
  const bar = (SRC.match(/tabBar:\s*\{([^}]*)\}/) || [])[1] || '';
  const bg = (bar.match(/backgroundColor:\s*'([^']+)'/) || [])[1] || '';
  const opaque = /^#[0-9a-fA-F]{6}$/.test(bg) || /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*1(\.0+)?)?\s*\)$/.test(bg);
  check(opaque, 'tab bar background is fully opaque, so orbs / starfield / frame brackets behind it cannot show through', `backgroundColor: ${bg || '(none)'}`);
  const z = Number((bar.match(/zIndex:\s*(\d+)/) || [])[1] || 0);
  check(z >= 1, 'tab bar has a zIndex above the background layers');
  const orbs = SRC.slice(SRC.indexOf('const GlowOrbs ='), SRC.indexOf('// ── Expanding pulse ring'));
  check(/pointerEvents="none"/.test(orbs) && !/zIndex/.test(orbs), 'GlowOrbs (phone build) is decorative: pointerEvents none, no zIndex that could lift it over the bar');
  const MAINR = SRC.slice(SRC.indexOf('  const reward    = calcReward(userCount);'));
  const iOrbs = MAINR.indexOf('<GlowOrbs />'), iBar = MAINR.indexOf('<TabBar model=');
  check(iOrbs > 0 && iBar > iOrbs, 'in the main screen GlowOrbs is drawn first and the TabBar last, so the bar is on top');
  check(/<AppInner \/>/.test(SRC) && SRC.indexOf('<DepthFrame />') < SRC.indexOf('<AppInner />') && SRC.indexOf('<HoloBackground') < SRC.indexOf('<AppInner />'), 'HoloBackground + DepthFrame are mounted BEFORE the app, i.e. underneath it');
}

console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Tab bar: ${fails === 0 ? 'ALL PROBES PASS' : fails + ' FAILURE(S)'}\n`);
process.exit(fails === 0 ? 0 : 1);
