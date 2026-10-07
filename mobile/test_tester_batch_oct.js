// test_tester_batch_oct.js — tester-found bugs, October batch (Android, real phones
// incl. Samsung). Every probe must pass; exit 0.
//
//   (1) ITEMS 5+1  network badge confirm + freeze, claim shows/checks the network,
//                  invite code cleared on switch, NO local ignite on error/non-JSON,
//                  rejections name the network — and postIgnition()/ignitedOnServer()
//                  EXECUTED (extracted from App.js) against a real local HTTP server
//   (2) ITEM 3     intro on expo-video: error → skip, ~2.5 s watchdog, background →
//                  skip — the shipped effect EXECUTED against a mock player
//   (3) ITEMS 6+8  safe-area-context SafeAreaView everywhere + ONE KeyboardSafe wrapper
//                  around every screen that has a text input
//   (4) ITEM 7     re-auth accepts a device PIN (getEnrolledLevelAsync) — and the
//                  library premise (isEnrolledAsync = biometrics only) read from its source
//   (5) ITEM 9     pull-to-refresh on the main screen; refresh right after a switch
//
// App.js is React Native/JSX and cannot run under plain Node, so (as in
// test_testnetux.js) structure is source-scanned — but every piece of LOGIC that can
// be lifted out of App.js verbatim is executed, not re-implemented.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

let fails = 0;
const ok  = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };
const check = (c, m, d) => (c ? ok(m) : bad(d ? `${m} — ${d}` : m));

const SRC = fs.readFileSync(path.join(__dirname, 'App.js'), 'utf8');
const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const fnText = (re) => (stripped.match(re) || [''])[0];

(async () => {
  console.log('\n  🧪  TESTER BATCH (OCT) — App.js fixes\n');

  // ── (1) ITEMS 5 + 1 ─────────────────────────────────────────────────────
  console.log('  (1) ITEMS 5+1 — the right network, honest ignition');
  {
    // badge → confirm-before-mainnet, frozen while switching
    check(/onPress=\{requestNetworkToggle\}\s*disabled=\{switchingNet\}/.test(stripped), 'the network badge calls requestNetworkToggle and is disabled while switching');
    const req = fnText(/const requestNetworkToggle = \(\) => \{[\s\S]*?\n  \};/);
    check(/if \(switchingNet\) return;/.test(req) && /network === 'testnet'/.test(req) && /'Switch to MAINNET — real money\?'/.test(req) && /onPress: \(\) => \{ toggleNetwork\(\); \}/.test(req),
      'going TO mainnet asks "Switch to MAINNET — real money?" first; only the confirm button switches');
    check(/\{ text: 'Stay on TESTNET', style: 'cancel' \}/.test(req), '…and the safe choice ("Stay on TESTNET") is the cancel button');
    const toggle = fnText(/const toggleNetwork = async \(\) => \{[\s\S]*?\n  \};/);
    check(/if \(switchingNet\) return;/.test(toggle) && /setSwitchingNet\(true\);\s*try \{/.test(toggle) && /finally \{\s*setSwitchingNet\(false\);/.test(toggle),
      'toggleNetwork freezes (switchingNet=true) for the whole switch and always unfreezes in finally');
    check(/switchingNet \? 'Switching network…' : network === 'testnet'/.test(stripped), 'the badge reads "Switching network…" while frozen');

    // invite code cleared + old network's numbers wiped on EVERY switch, before the new data loads
    const reset = fnText(/const resetNetworkView = \(\) => \{[\s\S]*?\n  \};/);
    check(/setIgnitionCode\(''\)/.test(reset) && /setTxs\(\[\]\)/.test(reset) && /setBalance\(0\)/.test(reset) && /setClaimed\(false\)/.test(reset),
      'resetNetworkView clears the invite code AND the old network\'s ledger/balance/claim state');
    const select = fnText(/const selectNetwork = async \(net\) => \{[\s\S]*?\n  \};/);
    for (const [name, body, w] of [['toggleNetwork', toggle, 'next'], ['selectNetwork', select, 'net']]) {
      const iSet = body.indexOf('setNetworkState('), iReset = body.indexOf('resetNetworkView()'), iLoad = body.indexOf(`loadOrCreateWallet(${w})`), iSync = body.indexOf('sync()');
      check(iSet > -1 && iReset > iSet && iLoad > iReset && iSync > iLoad, `${name}: switch → resetNetworkView() → load that network's wallet → sync() (nothing from the old network is ever shown under the new label)`);
    }

    // claim(): shows AND checks the network
    const claim = fnText(/const claim = async \(\) => \{[\s\S]*?\n  \};/);
    const order = (...needles) => { let p = -1; for (const n of needles) { const i = claim.indexOf(n, p + 1); if (i < 0) return false; p = i; } return true; };
    check(/if \(switchingNet\) return Alert\.alert/.test(claim), 'claim() refuses while a network switch is in flight');
    check(/const net = getNetwork\(\);\s*if \(net !== network\) return Alert\.alert/.test(claim), 'claim() refuses when the screen and the ACTIVE network disagree');
    check(/confirmAsync\(\s*`Claim on \$\{net === 'testnet' \? '🧪 TESTNET' : '🌐 MAINNET'\}\?`/.test(claim) && /the REAL network/.test(claim),
      'claim() asks "Claim on 🧪 TESTNET?" / "Claim on 🌐 MAINNET?" (mainnet spelled out as the REAL network)');
    check(order('confirmAsync(', 'authenticateBioKey(', 'getNetwork() !== net', 'postIgnition('),
      'order: confirm network → seal prompt → RE-CHECK network + wallet unchanged → post');
    check(/ignitionCode: ignitionCode \? ignitionCode\.trim\(\)\.toUpperCase\(\) : undefined/.test(claim), 'claim() still sends the invite code (unchanged contract)');

    // honest ignition: no local ignite on error / non-JSON, network named in rejections
    const trig = fnText(/const triggerIgnition = async \(\) => \{[\s\S]*?\n  \};/);
    check(/const net = getNetwork\(\);\s*if \(switchingNet \|\| net !== network\)/.test(trig), 'IGNITE (step 4) refuses if the shown network is not the active one');
    check(!/catch\s*\(?[a-z]*\)?\s*\{[^}]*igniteLocally/.test(trig) && !/catch/.test(trig.replace(/\.catch\(\(\) => \{\}\)|\.catch\(\(\) => null\)/g, '')),
      'triggerIgnition has NO catch-all that ignites locally any more');
    const igniteCalls = (trig.match(/await igniteLocally\(\)/g) || []).length;
    check(igniteCalls === 2 && /if \(r\.kind === 'ok'\) \{\s*await igniteLocally\(\);/.test(trig) && /await ignitedOnServer\(addrRef\.current\) === true\) \{[\s\S]{0,160}await igniteLocally\(\);/.test(trig),
      'igniteLocally() runs ONLY on a server yes, or when the ledger proves the claim landed (2 call sites, both guarded)');
    const msg = "Couldn't reach the network — your code was not used.";
    check(trig.includes(msg) && claim.includes(msg), `both IGNITE and CLAIM show the honest "${msg}" when nothing landed`);
    check(/`Rejected by \$\{netName\(net\)\}: \$\{r\.error\}`/.test(trig) && /`Rejected by \$\{netName\(net\)\}: \$\{r\.error\}`/.test(claim),
      'both rejections read "Rejected by TESTNET: …" / "Rejected by MAINNET: …"');

    // EXECUTED: lift postIgnition + ignitedOnServer out of App.js verbatim and run them
    const postSrc = fnText(/const postIgnition = async \(body\) => \{[\s\S]*?\n  \};/);
    const ledgerSrc = fnText(/const ignitedOnServer = async \(addr\) => \{[\s\S]*?\n  \};/);
    check(postSrc && ledgerSrc, 'postIgnition() and ignitedOnServer() found in App.js');
    let mode = 'ok', ledger = [];
    const server = http.createServer((req, res) => {
      if (req.url === '/ledger') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(ledger)); }
      if (mode === 'hang') return;   // never answers → the 10 s abort fires
      if (mode === 'ok') { res.setHeader('Content-Type', 'application/json'); return res.end('{"success":true}'); }
      if (mode === 'reject') { res.statusCode = 403; res.setHeader('Content-Type', 'application/json'); return res.end('{"error":"A valid invite code is required to seal."}'); }
      if (mode === 'html') { res.statusCode = 502; res.setHeader('Content-Type', 'text/html'); return res.end('<html><body>502 Bad Gateway — cloudflare</body></html>'); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const BACKEND_URL = `http://127.0.0.1:${server.address().port}`;
    // eslint-disable-next-line no-new-func
    const make = new Function('BACKEND_URL', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout',
      `${postSrc}\n${ledgerSrc}\nreturn { postIgnition, ignitedOnServer };`);
    const fastTimeout = (fn, ms) => setTimeout(fn, ms >= 8000 ? 300 : ms);   // compress the 10 s / 8 s aborts for the test
    const api = make(BACKEND_URL, fetch, AbortController, fastTimeout, clearTimeout);
    const r1 = await api.postIgnition({ x: 1 });
    mode = 'reject'; const r2 = await api.postIgnition({ x: 1 });
    mode = 'html';   const r3 = await api.postIgnition({ x: 1 });
    mode = 'hang';   const r4 = await api.postIgnition({ x: 1 });
    const dead = make('http://127.0.0.1:1', fetch, AbortController, fastTimeout, clearTimeout);
    const r5 = await dead.postIgnition({ x: 1 });
    check(r1.kind === 'ok', `EXECUTED: server {"success":true} → 'ok'`);
    check(r2.kind === 'rejected' && r2.error === 'A valid invite code is required to seal.', `EXECUTED: server 403 JSON → 'rejected' with the server's own words`);
    check(r3.kind === 'unreachable', `EXECUTED: a 502 HTML error page (non-JSON) → 'unreachable' — never treated as a yes (it used to ignite locally)`);
    check(r4.kind === 'unreachable', `EXECUTED: no answer before the timeout → 'unreachable'`);
    check(r5.kind === 'unreachable', `EXECUTED: connection refused → 'unreachable'`);
    ledger = [{ from: 'FAUCET', to: 'M_LANDED' }];
    const l1 = await api.ignitedOnServer('M_LANDED'), l2 = await api.ignitedOnServer('M_OTHER'), l3 = await dead.ignitedOnServer('M_LANDED');
    check(l1 === true && l2 === false && l3 === null, `EXECUTED: ignitedOnServer → true when the ledger has the claim, false when not, null when it can't check (${l1}/${l2}/${l3})`);
    server.close();
  }

  // ── (2) ITEM 3 ──────────────────────────────────────────────────────────
  console.log('\n  (2) ITEM 3 — intro video can never trap the user');
  {
    check(!/Video as ExpoVideo|ResizeMode|<ExpoVideo/.test(stripped), 'expo-av Video is gone from the intro (Audio still from expo-av for sounds)');
    check(/import \{ useVideoPlayer, VideoView \} from 'expo-video';/.test(SRC) && /<VideoView\s+player=\{introPlayer\}/.test(stripped),
      'intro renders expo-video\'s VideoView bound to a useVideoPlayer player');
    const appJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'app.json'), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    check(appJson.expo.plugins.includes('expo-video') && !!pkg.dependencies['expo-video'], 'expo-video is a dependency AND its config plugin is in app.json (native module is in the build)');
    check(/const INTRO_WATCHDOG_MS = 2500;/.test(stripped), 'watchdog is 2.5 s');
    const end = fnText(/const handleIntroEnd = async \(\) => \{[\s\S]*?\n  \};/);
    check(/if \(introEndedRef\.current\) return;\s*introEndedRef\.current = true;/.test(end), 'handleIntroEnd acts once, whatever raised it');

    // EXECUTED: the shipped effect, against a mock player / AppState / timers
    const effSrc = (stripped.match(/useEffect\(\(\) => \{\s*(if \(!showIntroVideo \|\| IS_WEB\) return;[\s\S]*?)\}, \[showIntroVideo\]\);/) || [])[1];
    check(!!effSrc, 'intro-driving effect found');
    const runScenario = (drive) => {
      const listeners = {}; let appCb = null; let ended = 0; let played = 0; const timers = [];
      const player = { addListener: (ev, cb) => { listeners[ev] = cb; return { remove: () => { delete listeners[ev]; } }; }, play: () => { played++; } };
      const AppState = { addEventListener: (ev, cb) => { appCb = cb; return { remove: () => { appCb = null; } }; } };
      // eslint-disable-next-line no-new-func
      const eff = new Function('showIntroVideo', 'IS_WEB', 'introPlayer', 'handleIntroEnd', 'INTRO_WATCHDOG_MS', 'AppState', 'setTimeout', 'clearTimeout', effSrc);
      const cleanup = eff(true, false, player, () => { ended++; }, 2500, AppState,
        (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, () => {});
      drive({ listeners, fireTimers: () => timers.forEach((t) => t.fn()), app: (s) => appCb && appCb(s), timers });
      return { ended, played, timers, cleanup };
    };
    const a = runScenario(({ listeners, fireTimers }) => { listeners.playingChange({ isPlaying: true }); listeners.playToEnd(); fireTimers(); });
    check(a.played === 1 && a.ended === 1, 'EXECUTED: plays → reaches the end → intro ends (the started watchdog does not fire again)');
    const b = runScenario(({ listeners }) => { listeners.statusChange({ status: 'error', error: { message: 'decoder' } }); });
    check(b.ended === 1, 'EXECUTED: player error → intro skipped (no black screen)');
    const c = runScenario(({ fireTimers }) => { fireTimers(); });
    check(c.ended === 1 && c.timers[0].ms === 2500, 'EXECUTED: never started playing → the 2.5 s watchdog skips the intro');
    const d = runScenario(({ app }) => { app('background'); });
    check(d.ended === 1, 'EXECUTED: app sent to background mid-intro → intro ends (no dead surface on reopen)');
  }

  // ── (3) ITEMS 6 + 8 ─────────────────────────────────────────────────────
  console.log('\n  (3) ITEMS 6+8 — insets on Android, inputs above the keyboard');
  {
    const rnImport = (SRC.match(/import \{[^}]*\} from 'react-native';/) || [''])[0];
    check(!/\bSafeAreaView\b/.test(rnImport) && /import \{ SafeAreaProvider, SafeAreaView(, useSafeAreaInsets)? \} from 'react-native-safe-area-context';/.test(SRC),
      'SafeAreaView now comes from react-native-safe-area-context (react-native\'s pads iOS only)');
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    check(!!pkg.dependencies['react-native-safe-area-context'], `react-native-safe-area-context is a dependency (${pkg.dependencies['react-native-safe-area-context']})`);
    check(/export default function App\(\) \{[\s\S]*?<SafeAreaProvider>[\s\S]*?<AppInner \/>[\s\S]*?<\/SafeAreaProvider>/.test(stripped), 'the whole app sits inside <SafeAreaProvider>');
    const ks = fnText(/const KeyboardSafe = \([\s\S]*?\n\);/);
    check(/<KeyboardAvoidingView style=\{\{ flex: 1 \}\} behavior="padding">/.test(ks) && /keyboardShouldPersistTaps="handled"/.test(ks), 'ONE shared wrapper: KeyboardSafe = KeyboardAvoidingView + ScrollView(keyboardShouldPersistTaps)');

    // every TextInput (and every PinBoxRow, which hides one) is inside a KeyboardSafe
    const depthAt = (i) => (stripped.slice(0, i).match(/<KeyboardSafe\b/g) || []).length - (stripped.slice(0, i).match(/<\/KeyboardSafe>/g) || []).length;
    const ksDef = stripped.indexOf('const KeyboardSafe');
    const inputs = [];
    for (const re of [/<TextInput\b/g, /<PinBoxRow\b/g]) { let m; while ((m = re.exec(stripped))) inputs.push(m.index); }
    const pinDef = stripped.indexOf('const PinBoxRow');
    const outside = inputs.filter((i) => !(i > pinDef && i < pinDef + 1500) && !(i > ksDef && i < ksDef + 1200) && depthAt(i) <= 0);
    check(inputs.length >= 11 && outside.length === 0, `all ${inputs.length} text inputs / PIN rows are inside a KeyboardSafe (outside: ${outside.length})`);
    const ksUses = (stripped.match(/<KeyboardSafe\b/g) || []).length;
    check(ksUses >= 7, `KeyboardSafe used on ${ksUses} screens/sheets: step 4, both 2FA screens, restore, main screen, both contact sheets`);
    check(/<KeyboardSafe contentContainerStyle=\{\{ flexGrow: 1 \}\}>\s*<View style=\{s\.fullCenter\}>[\s\S]*?IGNITE — CLAIM/.test(stripped), 'step 4 (was a fixed, non-scrollable View) now scrolls — IGNITE can no longer hide under the nav bar');
    check((stripped.match(/<SafeAreaView edges=\{\['bottom'\]\} style=\{s\.contactsBackdrop\}>/g) || []).length === 3, 'all 3 bottom-sheets (both contact sheets + the unlock-method sheet) pad for the nav bar');
    check(!/from 'react-native';[\s\S]{0,5}SafeAreaView/.test(SRC), 'no screen still uses react-native\'s SafeAreaView');
  }

  // ── (4) ITEM 7 ──────────────────────────────────────────────────────────
  console.log('\n  (4) ITEM 7 — a phone with only a PIN can open its wallet');
  {
    const reauth = fnText(/const runBiometricReAuth = async \(\) => \{[\s\S]*?\n  \};/);
    check(!/isEnrolledAsync/.test(reauth) && /getEnrolledLevelAsync\(\)/.test(reauth) && /level === LocalAuthentication\.SecurityLevel\.NONE/.test(reauth),
      're-auth gates on getEnrolledLevelAsync() === NONE (any screen lock passes), not isEnrolledAsync()');
    check(/result\.error === 'not_enrolled' \|\| result\.error === 'passcode_not_set'/.test(reauth), 'a not_enrolled / passcode_not_set answer gets a clear "no screen lock" message instead of a dead end');
    // the premise, read from the INSTALLED library's Android source
    const kt = path.join(__dirname, 'node_modules/expo-local-authentication/android/src/main/java/expo/modules/localauthentication/LocalAuthenticationModule.kt');
    if (fs.existsSync(kt)) {
      const k = fs.readFileSync(kt, 'utf8');
      check(/AsyncFunction<Boolean>\("isEnrolledAsync"\) \{\s*canAuthenticateUsingWeakBiometrics\(\) == BiometricManager\.BIOMETRIC_SUCCESS/.test(k),
        'library premise PROVEN: Android isEnrolledAsync() is biometrics-only (BIOMETRIC_WEAK) — a PIN-only phone always got "false"');
      check(/if \(isDeviceSecure\) \{\s*level = SECURITY_LEVEL_SECRET/.test(k), 'library premise PROVEN: getEnrolledLevelAsync() reports SECRET when a PIN/pattern/password exists');
    } else bad('expo-local-authentication Android source not found (run npm ci)');
  }

  // ── (5) ITEM 9 ──────────────────────────────────────────────────────────
  console.log('\n  (5) ITEM 9 — refresh');
  {
    check(/refreshControl=\{<RefreshControl refreshing=\{refreshing\} onRefresh=\{onRefresh\}/.test(stripped), 'main screen has pull-to-refresh');
    const onR = fnText(/const onRefresh = async \(\) => \{[\s\S]*?\n  \};/);
    check(/setRefreshing\(true\)/.test(onR) && /ok = await sync\(\)/.test(onR) && /finally \{ setRefreshing\(false\); \}/.test(onR) && /Couldn\\?'t refresh/.test(onR),
      'pull → sync(), spinner always stops, and a failed pull says so');
    const sync = fnText(/const sync = async \(\) => \{[\s\S]*?\n  \};/);
    check(/return true;\s*\} catch \{ return false; \}/.test(sync), 'sync() now reports success/failure (it used to swallow errors silently)');
    check(/setInterval\(sync, 60_000\)/.test(stripped), 'the 60 s background poll is unchanged');
  }

  // ── (6) ITEM 4 ──────────────────────────────────────────────────────────
  console.log('\n  (6) ITEM 4 — About tile 4 torch redrawn (approved option A, torch only)');
  {
    const icons = fs.readFileSync(path.join(__dirname, 'Icons.js'), 'utf8');
    const torch = (icons.match(/export function ClayBuildItBetter\([\s\S]*?\n\}\r?\n/) || [''])[0];
    check(!!torch, 'ClayBuildItBetter found in Icons.js');
    check(!/cbbHand|strokeWidth="18"|rx="7"|Hand holding torch/.test(torch), 'the old art is gone: no rounded 14×50 shaft, no thick round "hand" lobes');
    // exact geometry of the approved torch_NEW_optionA.svg (cup, cone, band, tip, flame)
    const approved = [
      'M48 46 L84 46 L80 54 L52 54 Z', 'M53 54 L79 54 L70 92 L62 92 Z', 'M55.5 63 L76.5 63',
      'M66 5 Q81 17 79 33 Q77 45 66 48 Q55 45 53 33 Q51 17 66 5 Z',
      'M66 11 Q77 21 75 35 Q73 44 66 46 Q59 44 57 35 Q55 21 66 11 Z',
      'M66 19 Q72 27 71 36 Q70 42 66 43 Q62 42 61 36 Q60 27 66 19 Z',
    ];
    check(approved.every((d) => torch.includes(`d="${d}"`)) && /<G transform="translate\(-1,12\)">/.test(torch) && /<Rect x="61" y="91" width="10" height="3"/.test(torch),
      'geometry = the approved image: gold cup, short cone narrowing downward, gold band, flat gold tip, same flame, same centring');
    const usedIn = (stripped.match(/<ClayBuildItBetter size=\{130\} \/>/g) || []).length;
    check(usedIn === 1 && /What if someone builds it better\?/.test(stripped), 'About tile 4 still renders <ClayBuildItBetter size={130} /> — same size, same place');
    check(/export function ClayBuildItBetter\(\{ size = 130 \}\)/.test(torch) && /viewBox="0 0 130 130"/.test(torch), 'same component name, prop and 130×130 viewBox');
  }

  // ── (7) VERSION DISPLAY ──────────────────────────────────────────────────
  console.log('\n  (7) VERSION DISPLAY — which build is running');
  {
    check(/import \* as Application from 'expo-application';/.test(SRC) && /import Constants from 'expo-constants';/.test(SRC), 'reads from expo-application (installed binary) and expo-constants (embedded app config)');
    const lines = (stripped.match(/const APP_VERSION\s+= [^\n]*\n\s*const APP_BUILD\s+= [^\n]*\n\s*const GIT_COMMIT\s+= [^\n]*/) || [''])[0];
    check(/Application\.nativeApplicationVersion \|\| 'dev'/.test(lines) && /Application\.nativeBuildVersion \|\| 'dev'/.test(lines) && /extra\.gitCommit\) \|\| 'dev'/.test(lines),
      'version = nativeApplicationVersion, build = nativeBuildVersion, commit = expoConfig.extra.gitCommit — each falls back to "dev"');
    // EXECUTED: the three shipped lines against mock modules
    // eslint-disable-next-line no-new-func
    const run = (app, consts) => new Function('Application', 'Constants', `${lines}; return { APP_VERSION, APP_BUILD, GIT_COMMIT };`)(app, consts);
    const v1 = run({ nativeApplicationVersion: '1.0.0', nativeBuildVersion: '13' }, { expoConfig: { extra: { gitCommit: 'a1b2c3d4e5f6' } } });
    const header = `v${v1.APP_VERSION} (${v1.APP_BUILD})`, footer = `MONEY v${v1.APP_VERSION} · build ${v1.APP_BUILD} · ${v1.GIT_COMMIT}`;
    check(header === 'v1.0.0 (13)' && footer === 'MONEY v1.0.0 · build 13 · a1b2c3d', `EXECUTED: an installed build 1.0.0/13 at commit a1b2c3d… reads "${header}" and "${footer}"`);
    const v2 = run({ nativeApplicationVersion: null, nativeBuildVersion: null }, { expoConfig: { extra: {} } });
    const v3 = run({ nativeApplicationVersion: '1.0.0', nativeBuildVersion: '14' }, {});
    check(v2.APP_VERSION === 'dev' && v2.APP_BUILD === 'dev' && v2.GIT_COMMIT === 'dev' && v3.GIT_COMMIT === 'dev', 'EXECUTED: anything unavailable reads "dev" (no crash when the config or binary info is missing)');
    // (Oct 7 device test, item 4: the header label was REMOVED — the per-screen BuildTag replaces it; see section 11)
    check(!/versionInline|badgeRow/.test(stripped), 'the duplicate header label next to the network badge is gone (BuildTag shows the version on every screen)');
    check(/<Text style=\{s\.versionFooter\}>MONEY v\{APP_VERSION\} · build \{APP_BUILD\} · \{GIT_COMMIT\}<\/Text>\s*<\/KeyboardSafe>/.test(stripped), 'footer: "MONEY v… · build … · <commit>" at the bottom of the main screen');
    check(!/versionInline\}>v1\.0\.0|build 1[23]\b/.test(stripped), 'nothing hardcoded — the numbers are never typed into the UI');
    const eas = JSON.parse(fs.readFileSync(path.join(__dirname, 'eas.json'), 'utf8'));
    check(eas.cli.appVersionSource === 'remote' && eas.build.preview.autoIncrement === true, 'eas.json: cli.appVersionSource "remote" + preview.autoIncrement → the build number rises every build');
    check(eas.cli.version === '>= 16.0.0' && eas.build.development.developmentClient === true && eas.build.production.android.buildType === 'app-bundle' && eas.build.preview.android.buildType === 'apk',
      'eas.json: every existing setting unchanged');
    const appJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'app.json'), 'utf8'));
    check(appJson.expo.version === '1.0.0' && appJson.expo.android.versionCode === 12, 'app.json untouched (version 1.0.0, versionCode 12)');
    // app.config.js (approved Oct 7): EXTENDS app.json, adds only extra.gitCommit from EAS_BUILD_GIT_COMMIT_HASH
    const cfgPath = path.join(__dirname, 'app.config.js');
    check(fs.existsSync(cfgPath), 'app.config.js exists (approved)');
    if (fs.existsSync(cfgPath)) {
      delete require.cache[require.resolve(cfgPath)];
      const extend = require(cfgPath);
      const before = JSON.parse(JSON.stringify(appJson.expo));
      const saved = process.env.EAS_BUILD_GIT_COMMIT_HASH;
      delete process.env.EAS_BUILD_GIT_COMMIT_HASH;
      const local = extend({ config: JSON.parse(JSON.stringify(before)) });
      process.env.EAS_BUILD_GIT_COMMIT_HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
      const eas = extend({ config: JSON.parse(JSON.stringify(before)) });
      if (saved === undefined) delete process.env.EAS_BUILD_GIT_COMMIT_HASH; else process.env.EAS_BUILD_GIT_COMMIT_HASH = saved;
      const without = (c) => { const x = JSON.parse(JSON.stringify(c)); delete x.extra.gitCommit; return JSON.stringify(x); };
      check(without(local) === JSON.stringify(before) && without(eas) === JSON.stringify(before),
        'EXECUTED: app.config.js changes NOTHING from app.json except adding extra.gitCommit (projectId, versionCode, plugins… identical)');
      check(local.extra.gitCommit === 'dev' && eas.extra.gitCommit === 'a1b2c3d', `EXECUTED: commit = "${local.extra.gitCommit}" locally, "${eas.extra.gitCommit}" under an EAS build (first 7 of EAS_BUILD_GIT_COMMIT_HASH)`);
    }
  }

  // ══ Oct 7 device test ══════════════════════════════════════════════════
  // ── (8) ITEM 1 — whatever unlocks the phone unlocks the app ───────────────
  console.log('\n  (8) OCT-7 ITEM 1 — phone PIN / pattern always available');
  {
    const MOD = path.join(__dirname, 'modules', 'device-credential');
    const kt = path.join(MOD, 'android/src/main/java/expo/modules/devicecredential/DeviceCredentialModule.kt');
    check(['expo-module.config.json', 'index.js', 'android/build.gradle', 'android/src/main/AndroidManifest.xml'].every((f) => fs.existsSync(path.join(MOD, f))) && fs.existsSync(kt),
      'local native module modules/device-credential exists (config, JS wrapper, Gradle, manifest, Kotlin)');
    const k = fs.existsSync(kt) ? fs.readFileSync(kt, 'utf8') : '';
    check(/\.setAllowedAuthenticators\(BiometricManager\.Authenticators\.DEVICE_CREDENTIAL\)/.test(k) && !/BIOMETRIC_(WEAK|STRONG)/.test(k),
      'Kotlin: Android 11+ prompt allows DEVICE_CREDENTIAL ONLY — the phone PIN/pattern/password, never a fingerprint-only prompt');
    check(/Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.R/.test(k) && /createConfirmDeviceCredentialIntent/.test(k) && /OnActivityResult/.test(k),
      'Kotlin: Android 10 and below use the system "confirm your PIN" screen (KeyguardManager), result read back in OnActivityResult');
    check(/promise\.resolve\(result\(false, "not_enrolled"\)\)/.test(k) && !/promise\.reject/.test(k), 'Kotlin: never rejects — a phone with no screen lock answers not_enrolled');
    const cfg = JSON.parse(fs.readFileSync(path.join(MOD, 'expo-module.config.json'), 'utf8'));
    check(cfg.android.modules[0] === 'expo.modules.devicecredential.DeviceCredentialModule', 'expo-module.config.json names the Kotlin class');
    // EXECUTED: Expo autolinking really links it into the Android build
    let linked = null;
    try {
      const out = execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['expo-modules-autolinking', 'resolve', '--platform', 'android', '--json'], { cwd: __dirname, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 1 << 24 });
      linked = (JSON.parse(out).modules || []).find((m) => m.packageName === 'device-credential');
    } catch (e) { linked = null; }
    check(!!linked && linked.projects[0].modules.includes('expo.modules.devicecredential.DeviceCredentialModule'), 'EXECUTED: expo-modules-autolinking resolves device-credential for Android (it will be compiled into the APK)');
    // EXECUTED: the JS wrapper, transpiled, with and without the native module present
    const babel = require('@babel/core');
    const wrapSrc = babel.transformSync(fs.readFileSync(path.join(MOD, 'index.js'), 'utf8'), { filename: 'index.js', babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'] }).code;
    const load = (native) => { const m = { exports: {} }; new Function('require', 'module', 'exports', wrapSrc)((id) => (id === 'expo-modules-core' ? { requireOptionalNativeModule: () => native } : require(id)), m, m.exports); return m.exports; };
    const none = load(null);
    const okMod = load({ confirmAsync: async (t, d) => ({ success: true, t, d }) });
    const throwing = load({ confirmAsync: async () => { throw new Error('boom'); } });
    const r0 = await none.confirmDeviceCredential('x'), r1 = await okMod.confirmDeviceCredential('Seal', 'Use PIN'), r2 = await throwing.confirmDeviceCredential('x');
    check(none.isDeviceCredentialAvailable === false && r0.success === false && r0.error === 'not_available', 'EXECUTED: old APK / web (no native module) → button hidden, call answers not_available (no crash)');
    check(okMod.isDeviceCredentialAvailable === true && r1.success === true && r2.success === false && r2.error === 'unknown', 'EXECUTED: native present → passes through; a native error becomes { success:false } (never throws into the app)');
    // App wiring
    const links = (stripped.match(/Use phone PIN \/ pattern instead/g) || []).length;
    check(/onPress=\{\(\) => sealWithPhoneCredential\(3\)\}/.test(stripped) && /onPress=\{\(\) => sealWithPhoneCredential\(35\)\}/.test(stripped) && /onPress=\{reAuthWithPhoneCredential\}/.test(stripped) && /onPress=\{txWithPhoneCredential\}/.test(stripped),
      `"Use phone PIN / pattern instead" on seal (3), seal (35), unlock (99) and the claim/send confirm (${links} mentions)`);
    check(/usePhoneCredential\('Confirm it\\'s you to re-link your authenticator'\)/.test(stripped) && /usePhoneCredential\('Confirm it\\'s you to change how MONEY unlocks'\)/.test(stripped),
      '…and as the fallback on the 2FA re-link and the unlock-settings confirmation');
    const gateUses = (stripped.match(/isEnrolledAsync\(/g) || []).length;
    check(gateUses === 1 && /const enrolled = await LocalAuthentication\.isEnrolledAsync\(\)\.catch\(\(\) => false\);/.test(stripped) && /getEnrolledLevelAsync\(\)[\s\S]{0,800}re-link your authenticator/.test(stripped),
      'isEnrolledAsync is no longer a gate anywhere (only the launch icon hint); the 2FA re-link uses getEnrolledLevelAsync');
    check(/const authLabel = 'PHONE LOCK';/.test(stripped) && !/Tap "Use PIN" on the prompt/.test(stripped) && !/'FINGERPRINT'/.test(stripped),
      'honest wording: "SEAL/UNLOCK WITH PHONE LOCK", never a promise of a "Use PIN" button the phone may not draw');
  }

  // ── (9) ITEM 2 — app passcode (EXECUTED: the real passcode.js) ───────────
  console.log('\n  (9) OCT-7 ITEM 2 — app passcode: scrypt + salt + lockout + 24-word recovery');
  {
    const P = require('./passcode.js');
    const crypto = require('crypto');
    const mk = (opts = {}) => {
      const mem = {}; let clock = opts.clock ?? 1_000_000_000;
      const storage = { getItemAsync: async (k) => (k in mem ? mem[k] : null), setItemAsync: async (k, v) => { mem[k] = v; }, deleteItemAsync: async (k) => { delete mem[k]; } };
      const store = P.createPasscodeStore({ storage, randomBytes: (n) => new Uint8Array(crypto.randomBytes(n)), now: () => clock, ...(opts.kdf ? { kdf: opts.kdf } : {}) });
      return { store, mem, tick: (ms) => { clock += ms; }, setClock: (c) => { clock = c; } };
    };
    // fast deterministic stand-in KDF ONLY for the lockout timing probes; the real scrypt is used everywhere else
    const realKdf = require('@noble/hashes/scrypt.js').scryptAsync;

    const a = mk();
    await a.store.setPasscode('482917');
    const rec = JSON.parse(a.mem[P.KEY_HASH]);
    check(!JSON.stringify(a.mem).includes('482917') && rec.alg === 'scrypt' && /^[0-9a-f]{32}$/.test(rec.salt) && /^[0-9a-f]{64}$/.test(rec.hash) && rec.r === 8 && rec.p === 1,
      `EXECUTED: stored = scrypt hash + 16-byte salt + parameters (N=${rec.N}, r=8, p=1) — the passcode itself appears nowhere`);
    const b = mk(); await b.store.setPasscode('482917');
    check(JSON.parse(b.mem[P.KEY_HASH]).salt !== rec.salt && JSON.parse(b.mem[P.KEY_HASH]).hash !== rec.hash, 'EXECUTED: same passcode on two phones → different salt and hash');
    check(rec.N <= 2 ** 15, `EXECUTED: scrypt cost capped at N=2^15 (≤ 32 MB memory, phone-safe) — calibrated to ${rec.N}`);
    const ok1 = await a.store.verify('482917'), bad1 = await a.store.verify('482916'), bad2 = await a.store.verify('999999');
    check(ok1.ok === true && bad1.ok === false && bad2.ok === false, 'EXECUTED: right passcode opens, wrong ones do not');
    check(JSON.stringify(Object.keys(bad1).sort()) === JSON.stringify(Object.keys(bad2).sort()) && bad1.reason === 'wrong' && bad2.reason === 'wrong' && !('digit' in bad1),
      'EXECUTED: a one-digit-off code and a totally wrong code get the SAME answer shape — no hint which digit was wrong');
    for (const badCode of ['48291', '4829170000000', 'abcdef', '', '48 2917']) {
      let threw = false; try { await mk().store.setPasscode(badCode); } catch { threw = true; }
      if (!threw) bad(`passcode "${badCode}" was accepted`);
    }
    ok('EXECUTED: only 6–12 digits accepted (5 digits, 13 digits, letters, empty, spaces refused)');

    // lockout schedule — real store, fast KDF, fake clock
    const fastKdf = async (pw, salt) => new Uint8Array(crypto.createHash('sha256').update(Buffer.concat([Buffer.from(String(pw)), Buffer.from(salt)])).digest());
    const c = mk({ kdf: fastKdf });
    await c.store.setPasscode('135790');
    const waits = [], tries = [];
    for (let i = 1; i <= 4; i++) { const r = await c.store.verify('000000'); tries.push(r.triesLeft); if (r.waitMs) waits.push(r.waitMs); }
    check(JSON.stringify(tries) === '[4,3,2,1]' && waits.length === 0, `EXECUTED: first 4 wrong tries → no wait, tries left ${tries.join('→')}`);
    const seq = [];
    for (let i = 0; i < 6; i++) {
      const r = await c.store.verify('000000'); seq.push(r.waitMs);
      const locked = await c.store.verify('135790');   // even the RIGHT code is refused while locked
      if (!(locked.ok === false && locked.reason === 'locked')) bad('right code accepted during a lockout');
      c.tick(r.waitMs + 1);
    }
    check(JSON.stringify(seq) === JSON.stringify([30000, 60000, 300000, 900000, 3600000, 3600000]),
      `EXECUTED: after 5 wrong tries the waits escalate 30 s → 1 min → 5 min → 15 min → 60 min → 60 min… (${seq.map((m) => m / 1000 + 's').join(', ')})`);
    ok('EXECUTED: during every wait even the correct passcode is refused (locked), and is not counted');
    const good = await c.store.verify('135790'); const after = await c.store.lockState();
    check(good.ok === true && after.fails === 0 && after.waitMs === 0, 'EXECUTED: the correct passcode after the wait opens and resets the counter');
    const d = mk({ kdf: fastKdf }); await d.store.setPasscode('135790');
    for (let i = 0; i < 5; i++) await d.store.verify('000000');
    const reopened = P.createPasscodeStore({ storage: { getItemAsync: async (k) => d.mem[k] ?? null, setItemAsync: async (k, v) => { d.mem[k] = v; }, deleteItemAsync: async (k) => { delete d.mem[k]; } }, randomBytes: (n) => new Uint8Array(crypto.randomBytes(n)), now: () => 1_000_000_000, kdf: fastKdf });
    check((await reopened.verify('135790')).reason === 'locked', 'EXECUTED: the lockout survives an app restart (counters live in secure storage)');

    // modes
    const e = mk();
    check(await e.store.getMode() === 'device', 'EXECUTED: default unlock method = phone lock only');
    let msg = ''; try { await e.store.setMode('either'); } catch (x) { msg = x.message; }
    check(/create an app passcode first/.test(msg), 'EXECUTED: "either"/"passcode" refused until an app passcode exists');
    await e.store.setPasscode('246810');
    msg = ''; try { await e.store.setMode('passcode'); } catch (x) { msg = x.message; }
    check(/back up your 24 words first/.test(msg) && await e.store.getMode() === 'device', 'EXECUTED: "passcode only" refused until the 24-word backup is completed');
    await e.store.setMode('either');
    await e.store.markBackupConfirmed(); await e.store.setMode('passcode');
    check(await e.store.getMode() === 'passcode', 'EXECUTED: after the backup, "passcode only" can be chosen');
    // recovery = 24-word restore only
    await e.store.resetForRestore();
    check(!(await e.store.hasPasscode()) && await e.store.getMode() === 'device' && (await e.store.verify('246810')).reason === 'none',
      'EXECUTED: a completed 24-word restore clears the passcode and returns to the phone lock — the ONLY recovery path');
    const exported = Object.keys(P.createPasscodeStore({ storage: e.store, randomBytes: () => new Uint8Array(16) }));
    check(!exported.some((k) => /bypass|reset(?!ForRestore)|clear|unlock|master/i.test(k)), `no back door: the store's API is ${exported.filter((k) => typeof k === 'string').join(', ')}`);
    // calibration with the REAL scrypt on a slow (simulated phone) clock stays at the floor
    let t = 0; const slow = P.createPasscodeStore({ storage: { getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }, randomBytes: (n) => new Uint8Array(crypto.randomBytes(n)), now: () => (t += 300), kdf: realKdf });
    check((await slow.setPasscode('112233')).N === 2 ** 14, 'EXECUTED: on a phone where one check already costs ≥250 ms, scrypt stays at N=2^14 (no multi-second unlocks)');
    const ps = fs.readFileSync(path.join(__dirname, 'passcode.js'), 'utf8');
    check(/diff \|= a\[i\] \^ b\[i\]/.test(ps), 'hash comparison is constant-time (XOR-accumulate, no early exit)');
    // App wiring
    check(/const passcodeStore = createPasscodeStore\(\{\s*storage: SecureStore,/.test(stripped), 'App stores it in SecureStore (hardware-backed)');
    check(/const mode = await passcodeStore\.getMode\(\)[\s\S]{0,400}if \(biokey === '1'\)/.test(stripped) && /if \(unlockModeRef\.current !== 'passcode'\) runBiometricReAuth\(\);/.test(stripped),
      'the unlock method is loaded BEFORE the lock screen; in "passcode only" mode no phone prompt fires');
    check(/const chooseUnlockMode = async \(mode\) => \{\s*if \(!settingsAuthed\) return;/.test(stripped) && /const saveAppPasscode = async \(\) => \{\s*if \(!settingsAuthed\) return;/.test(stripped),
      'changing the method or the passcode first requires the CURRENT method (phone lock and/or passcode)');
    const restoreFn = fnText(/const applyRestore = async \(\) => \{[\s\S]*?setOnboardingStep\(0\);\s*\};/);
    check(/await passcodeStore\.resetForRestore\(\);/.test(restoreFn), 'a completed 24-word restore resets the passcode (recovery)');
    check(/onPress=\{async \(\) => \{ await passcodeStore\.markBackupConfirmed\(\)/.test(stripped), 'finishing the 24-word backup screen records the backup (gates "passcode only")');
    check(/Honest note: a 6-digit app passcode is weaker than your phone lock/.test(stripped), 'the honest trade-off is shown where the passcode is created');
  }

  // ── (10) ITEM 3 — every onboarding screen has a way out ───────────────────
  console.log('\n  (10) OCT-7 ITEM 3 — ways out: Back + Restore, Restore remembers its opener');
  {
    const rbt = fnText(/const restoreBackTarget = \([\s\S]*?\n\s*\(openedFrom[^\n]*/);
    // eslint-disable-next-line no-new-func
    const restoreBackTarget = new Function(`${rbt}; return restoreBackTarget;`)();
    const cases = [[4, false, 4], [3, false, 3], [35, false, 35], [99, true, 99], [12, false, 12], [0, true, 0], [null, true, 0], [null, false, 12], [undefined, false, 12]];
    const wrong = cases.filter(([f, ig, want]) => restoreBackTarget(f, ig) !== want);
    check(wrong.length === 0, `EXECUTED: Restore's Back returns to its opener (4→4, 3→3, 35→35, 99→99, 12→12, wallet→wallet); no opener → wallet if ignited, else the Oath`);
    const screen = (n) => { const i = stripped.lastIndexOf(`if (onboardingStep === ${n}) {`); const j = stripped.indexOf('if (onboardingStep ===', i + 30); return stripped.slice(i, j > 0 ? j : undefined); };
    check(/<NavRow onBack=\{\(\) => setOnboardingStep\(12\)\} onRestore=\{\(\) => openRestore\(3\)\} \/>/.test(screen(3)), 'step 3 (seal): Back → Oath, Restore → remembers 3');
    check(/<NavRow onBack=\{\(\) => setOnboardingStep\(12\)\} onRestore=\{\(\) => openRestore\(35\)\} \/>/.test(screen(35)), 'step 35 (seal with PIN): Back → Oath, Restore → remembers 35');
    check(/<NavRow onBack=\{\(\) => setOnboardingStep\(sealFromRef\.current \?\? \(hasFingerprint \? 3 : 35\)\)\} onRestore=\{\(\) => openRestore\(4\)\} \/>/.test(screen(4)), 'step 4 "Seal Forged": Back → the seal screen it came from, Restore → remembers 4');
    check(/onRestore=\{\(\) => openRestore\(99\)\}/.test(screen(99)) && /<NavRow onBack=\{\(\) => setReAuthPhase\('biometric'\)\}/.test(screen(99)),
      'step 99 (lock): Restore on both phases; Back only steps from the 2FA phase to the first lock step — it never skips a lock');
    check(/<NavRow onBack=\{\(\) => \{ const back = pinSetupReturnTo\.current !== null \? 99 : 12;/.test(screen(36)), 'step 36 (2FA setup): Back → the lock screen that opened it');
    check((stripped.match(/setOnboardingStep\(51\)/g) || []).length === 1 && /const openRestore = \(from\) => \{\s*restoreReturnTo\.current = from;/.test(stripped) && /onPress=\{\(\) => openRestore\(12\)\}/.test(stripped) && /onPress=\{\(\) => openRestore\(0\)\}/.test(stripped),
      'every way into Restore goes through openRestore(from) (Oath, main screen, 3, 35, 4, 99) — nothing else navigates to 51');
    check(/const sealConfirmed = \(fromStep\) => \{[\s\S]{0,200}sealFromRef\.current = fromStep;\s*setOnboardingStep\(4\);/.test(stripped) && /sealConfirmed\(3\)/.test(stripped) && /sealConfirmed\(35\)/.test(stripped),
      'nothing sealed is lost: going back from step 4 keeps the wallet; the seal screens remember which one led to step 4');
  }

  // ── (11) ITEM 4 — the build on every screen ──────────────────────────────
  console.log('\n  (11) OCT-7 ITEM 4 — version on every screen + every modal');
  {
    check(/<AppInner \/>\s*<BuildTag \/>/.test(stripped), 'BuildTag is drawn once at the app root, above every screen (intro, onboarding, seal, ignition, restore, 2FA, About, wallet)');
    const modalOpens = (stripped.match(/<Modal visible=/g) || []).length;
    const tagged = (stripped.match(/<Modal visible=[^\n]*\n\s*<BuildTag \/>/g) || []).length;
    check(modalOpens === 5 && tagged === modalOpens, `every Modal (${tagged}/${modalOpens}: seal confirm, QR scan, contacts, save contact, unlock method) carries its own BuildTag`);
    const tag = fnText(/const BuildTag = \(\) => \{[\s\S]*?\n\};/);
    check(/pointerEvents="none"/.test(tag) && /top: insets\.top \+ 6/.test(tag) && /v\{APP_VERSION\} \(\{APP_BUILD\}\)/.test(tag), 'BuildTag: "v{version} ({build})", below the status bar, ignores touches (never blocks a button)');
    check(/<Text style=\{s\.versionFooter\}>MONEY v\{APP_VERSION\} · build \{APP_BUILD\} · \{GIT_COMMIT\}<\/Text>/.test(stripped), 'the wallet footer still shows version · build · commit');
  }

  // ── (12) ITEM 5 — ledger time in the phone's time zone + language ─────────
  console.log('\n  (12) OCT-7 ITEM 5 — Clay Tablet time');
  {
    const ftSrc = fnText(/const formatTxTime = \(tx, locale, timeZone\) => \{[\s\S]*?\n\};/);
    // eslint-disable-next-line no-new-func
    const formatTxTime = new Function(`${ftSrc}; return formatTxTime;`)();
    const tx = { timestamp: Date.UTC(2026, 9, 7, 22, 40, 29), time: '10:40:29 PM' };   // the device-test send: 6:40 PM in Toronto
    const tz = 'America/Toronto';
    const us = formatTxTime(tx, 'en-US', tz), ca = formatTxTime(tx, 'en-CA', tz), fr = formatTxTime(tx, 'fr-CA', tz), gb = formatTxTime(tx, 'en-GB', tz);
    check(us === 'Oct 7, 2026 · 6:40 PM', `EXECUTED en-US: "${us}"`);
    check(/^Oct 7, 2026 · 6:40\s?p\.m\.$/.test(ca), `EXECUTED en-CA: "${ca}"`);
    check(fr === '7 oct. 2026 · 18 h 40', `EXECUTED fr-CA (French phone): "${fr}"`);
    check(gb === '7 Oct 2026 · 18:40', `EXECUTED en-GB: "${gb}"`);
    check(![us, ca, fr, gb].some((x) => /10:40|22:40|22 h 40/.test(x)), 'EXECUTED: none of them shows the server\'s UTC time (10:40 PM)');
    check(formatTxTime({ time: '10:40:29 PM' }, 'en-US', tz) === '10:40:29 PM' && formatTxTime({ timestamp: 'nope', time: 'T' }, 'en-US', tz) === 'T' && formatTxTime({}, 'en-US', tz) === '',
      'EXECUTED: no usable timestamp → falls back to tx.time (or empty), never "Invalid Date"');
    check(/<Text style=\{s\.tabletTime\}>\{formatTxTime\(tx\)\}<\/Text>/.test(stripped) && !/\{tx\.time\}/.test(stripped), 'the Clay Tablet uses formatTxTime(tx) (phone locale + time zone); raw {tx.time} is gone');
  }

  console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Tester batch (Oct): ${fails === 0 ? 'ALL PROBES PASS' : fails + ' FAILURE(S)'} — right network, honest ignition, intro never traps, keyboard/insets safe, PIN unlock, refresh.\n`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('   ❌  harness error:', e && e.stack || e); process.exit(1); });
