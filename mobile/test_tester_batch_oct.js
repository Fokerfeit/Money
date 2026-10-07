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
    check(!/\bSafeAreaView\b/.test(rnImport) && /import \{ SafeAreaProvider, SafeAreaView \} from 'react-native-safe-area-context';/.test(SRC),
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
    check((stripped.match(/<SafeAreaView edges=\{\['bottom'\]\} style=\{s\.contactsBackdrop\}>/g) || []).length === 2, 'both contact bottom-sheets pad for the nav bar');
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
    check(/<View style=\{s\.badgeRow\}>[\s\S]{0,900}onPress=\{requestNetworkToggle\}[\s\S]{0,600}<Text style=\{s\.versionInline\}>v\{APP_VERSION\} \(\{APP_BUILD\}\)<\/Text>\s*<\/View>/.test(stripped),
      'header: tiny "v{version} ({build})" sits beside the network badge');
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

  console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Tester batch (Oct): ${fails === 0 ? 'ALL PROBES PASS' : fails + ' FAILURE(S)'} — right network, honest ignition, intro never traps, keyboard/insets safe, PIN unlock, refresh.\n`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('   ❌  harness error:', e && e.stack || e); process.exit(1); });
