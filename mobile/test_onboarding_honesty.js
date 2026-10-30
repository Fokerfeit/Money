// test_onboarding_honesty.js — onboarding says only what the app really does
// (feature/human-check-screen). Every probe must pass; exit 0.
//
//   Oath tablet 1  : the phone lock confirms it's you; nothing biometric leaves the phone
//   Oath tablet 2  : "device check" (not built) is gone
//   Oath tablet 3  : MONEY logo no longer splits the sentence
//   Seal Forged    : "Phone lock ✅" only (no face scan exists)
//   Forging ritual : "beta code", never "invite code", in anything the user reads
//
// App.js is JSX and can't run under plain Node, so structure is source-scanned and the
// oath wording is EXECUTED (the TERMS array literal is evaluated).
'use strict';
const fs = require('fs');
const path = require('path');

let fails = 0;
const ok  = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };
const check = (c, m, d) => (c ? ok(m) : bad(d ? `${m} — ${d}` : m));

const SRC = fs.readFileSync(path.join(__dirname, 'App.js'), 'utf8').replace(/\r\n/g, '\n');
const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/[ \t]\/\/ .*$/gm, '');   // block, whole-line and trailing comments

const OATH = (() => { const i = SRC.indexOf('// ── Step 12: The Oath'); const j = SRC.indexOf('// ── Step', i + 10); return i >= 0 && j > i ? SRC.slice(i, j) : ''; })();
check(OATH.length > 1000, 'Oath screen (step 12) found');

console.log('\n── Oath tablets (executed) ──');
const m = OATH.match(/const TERMS = (\[[\s\S]*?\n    \]);/);
const TERMS = m ? Function('"use strict"; return ' + m[1])() : [];
check(Array.isArray(TERMS) && TERMS.length === 2, 'the oath has exactly 2 tablets (the unbuilt "device check" is removed)', `found ${TERMS.length}`);
check(/phone lock/i.test(TERMS[0]) && /fingerprint, face or PIN/.test(TERMS[0]) && /confirm it is you/i.test(TERMS[0]), 'tablet 1: the phone lock (fingerprint, face or PIN) confirms it is you');
check(/nothing biometric leaves your phone/.test(TERMS[0]), 'tablet 1: "nothing biometric leaves your phone"');
check(!/face capture|image deleted|hash only|device check|personal data stored/i.test(TERMS.join(' | ')), 'no tablet mentions face capture, image deletion, hashing a face or a device check');
check(/^Swear: one seal per human — any forgery voids your MONEY$/.test(TERMS[TERMS.length - 1]), 'last tablet: the swear sentence is unchanged');
const init = SRC.match(/const \[termChecks, setTermChecks\] = useState\((\[[^\]]*\])\)/);
check(init && JSON.parse(init[1]).length === TERMS.length && JSON.parse(init[1]).every((v) => v === false), 'checkbox state has one unchecked box per tablet (so "SWEAR ALL" still gates correctly)');
check(/const allChecked = termChecks\.every\(Boolean\)/.test(OATH), 'the continue button still needs every tablet ticked');

console.log('\n── Oath tablet 3: logo no longer breaks the sentence ──');
const last = OATH.slice(OATH.indexOf('i === TERMS.length - 1'), OATH.indexOf(') : (', OATH.indexOf('i === TERMS.length - 1')));
check(/flexWrap: 'wrap'/.test(last), 'the line holding the logo wraps as a whole instead of stretching');
check(/<Text style=\{\[s\.termText, s\.termInline\]\}>\{'any forgery voids your '\}<\/Text>/.test(last), '"any forgery voids your" is sized to its own words (termInline) — it no longer swallows the row and pushes the logo away');
check(/<MoneySymbol[^>]*\/>\s*\n\s*<Text style=\{\[s\.termText, s\.termInline, \{ color: '#D4AF37', fontWeight: 'bold' \}\]\}>\{'MONEY'\}/.test(last), 'logo + "MONEY" sit together straight after "your"');
const inl = (SRC.match(/termInline:\s*\{([^}]*)\}/) || [])[1] || '';
check(/flexGrow: 0/.test(inl) && /flexShrink: 1/.test(inl) && /flexBasis: 'auto'/.test(inl) && !/\bflex:/.test(inl), 'termInline = flexGrow 0 / shrink 1 / basis auto — NOT the `flex: 0` shorthand (that collapses the text to zero width on web; caught in the render)');
check(/'Swear: one seal per human —'/.test(last), 'first half of the sentence is on its own line above');

console.log('\n── Seal Forged ──');
check(/<Text style=\{s\.onboardSub\}>Phone lock ✅<\/Text>/.test(SRC), 'Seal Forged shows "Phone lock ✅"');
check(!/Face ✅/.test(SRC), 'no "Face ✅" anywhere (there is no face scan)');

console.log('\n── Forging ritual / beta code ──');
check(/② Enter your beta code/.test(SRC), 'forging ritual step 2 says "Enter your beta code"');
check(!/invite code/i.test(stripped), 'no "invite code" in anything the user can read');
check(!/Allow face capture|Allow device check/.test(SRC), 'old oath strings are gone from the file');

console.log('\n── Rulings: Oath card, step-3 screen, no face-capture claims ──');
check(/Your keys never leave your phone\. Press each tablet to swear:/.test(SRC), 'Oath card says "Your keys never leave your phone."');
check(!/stored raw|Only hashes/i.test(stripped), 'the "Nothing is stored raw. Only hashes." claim is gone');
const STEP35 = (() => { const i = SRC.indexOf('if (onboardingStep === 35) {'); const j = SRC.indexOf('onPress={testPin}', i); return i >= 0 && j > i ? SRC.slice(i, j) : ''; })();
check(STEP35.length > 200, 'step 35 screen found');
check(/<Text style=\{s\.onboardTitle\}>Seal Set<\/Text>/.test(STEP35), 'step 35 title is "Seal Set"');
check(/Your phone lock now guards your wallet\./.test(STEP35), 'step 35 body: "Your phone lock now guards your wallet."');
check(!/Face Inscribed|binds your face|body seal — /.test(stripped), 'no "Face Inscribed" / "binds your face" anywhere');
// every user-visible string: no claim that the app captures, scans or stores a face
const BANNED = /face capture|binds your face|Face Inscribed|Face ✅|image deleted|face scan|scan your face|your face is|face data|[^_A-Za-z]facial[^_A-Za-z]|(we|will) (scan|capture|store|keep) (your )?face/i;
const visible = stripped.split(String.fromCharCode(10));   // every code line: a claim can sit in any string or JSX text
const hit = visible.filter((l) => BANNED.test(l));
check(hit.length === 0, 'sweep: no visible line claims face capture / scan / storage', hit.map((l) => l.trim().slice(0, 80)).join(' | '));
// dead pose-ritual code can never be reached: nothing sends the user to step 2
check(!/setOnboardingStep\(2\)/.test(stripped) && !/onboardingStep === 2\) \{\s*\n\s*return \(/.test(stripped), 'the old face-pose step (2) is unreachable: nothing navigates to it and no screen renders for it');

console.log('\n── Server invite-code wording → beta code (executed) ──');
const fe = require('./friendly_errors');
check(fe.friendlyServerError('A valid invite code is required to seal.') === 'Beta code not valid.', 'server "A valid invite code is required to seal." → "Beta code not valid."');
check(fe.friendlyServerError('This invite code has already been used — one seal per code.') === 'Beta code already used.', 'server "This invite code has already been used…" → "Beta code already used."');
check(fe.friendlyServerError('Too many attempts, slow down') === 'Too many attempts, slow down', 'other server messages pass through unchanged');
check(fe.friendlyServerError('Invalid invite code') === 'Invalid beta code' && fe.friendlyServerError('bad Invite Code!') === 'bad Beta code!', 'any other message that says "invite code" still gets "beta code"');
check(fe.friendlyServerError(undefined) === '' && fe.friendlyServerError(null) === '' && fe.friendlyServerError({}) === '', 'non-string error → empty string (never "undefined")');
const sites = [...stripped.matchAll(/Rejected by \$\{netName\(net\)\}: \$\{([^}]+)\}/g)].map((x) => x[1]);
check(sites.length === 2 && sites.every((x) => x === 'friendlyServerError(r.error)'), 'both rejection alerts (ignition + claim) show the translated message', sites.join(', '));
check(!/\$\{r\.error\}/.test(stripped), 'no alert still prints the raw server error');
check(/import \{ friendlyServerError \} from '\.\/friendly_errors'/.test(SRC), 'App.js imports friendly_errors');

console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Onboarding honesty: ${fails === 0 ? 'ALL PROBES PASS' : fails + ' FAILURE(S)'}\n`);
process.exit(fails === 0 ? 0 : 1);
