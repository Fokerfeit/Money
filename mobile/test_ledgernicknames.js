// test_ledgernicknames.js — ledger contact nicknames + tap-to-name.
// Every probe must pass; exit 0.
//   1 NICKNAME LOOKUP (executed)      2 CASE-INSENSITIVE MATCH (executed)
//   3 ONE-ARG BEHAVIOUR UNCHANGED     4 TAPPABILITY RULE (executed)
//   5 APP.JS WIRING — display         6 APP.JS WIRING — tap handlers
//   7 NO SECOND STORE / STILL SCROLLVIEW
//
// App.js is a React Native/JSX file and cannot run under plain Node. So probes
// 1-4 re-implement displayAddr/contactNameFor/canNameAddr line-for-line against
// the REAL contacts.js helpers, proving the logic for real; probes 5-7 then
// structurally confirm App.js actually ships those exact functions and wires
// them into both ledger address slots. Same technique as test_testnetux.js.

const fs   = require('fs');
const path = require('path');
const { normAddress, isValidAddress } = require('./contacts');

let fails = 0;
const ok  = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };

const APP_JS = path.join(__dirname, 'App.js');
const RESERVE_ADDRESS = 'SWARM_RESERVE';   // config.js

// ── faithful re-implementation of App.js's display helpers ──────────────────
const contactNameFor = (addr, contacts) => {
  if (!addr || !Array.isArray(contacts)) return null;
  const a = normAddress(addr);
  const hit = contacts.find((c) => c && normAddress(c.address) === a);
  return hit ? hit.nickname : null;
};
const displayAddr = (addr, contacts) =>
  addr === 'FAUCET'        ? 'COMMON TREASURY' :
  addr === RESERVE_ADDRESS ? 'COMMON RESERVE'  :
  contactNameFor(addr, contacts) || addr;
const canNameAddr = (addr, selfAddr) =>
  isValidAddress(addr) && normAddress(addr) !== normAddress(selfAddr);

const A_UPPER = 'M_' + 'A'.repeat(32);
const A_LOWER = A_UPPER.toLowerCase();
const B_UPPER = 'M_' + 'B'.repeat(32);
const SELF    = 'M_' + 'C'.repeat(32);
const BOOK    = [{ nickname: 'Alice', address: A_UPPER }];

console.log('\n  🏷️   LEDGER NICKNAMES\n');

// ── 1 NICKNAME LOOKUP ───────────────────────────────────────────────────────
console.log('  1 NICKNAME LOOKUP');
(displayAddr(A_UPPER, BOOK) === 'Alice')
  ? ok('a saved address renders as its nickname')
  : bad(`expected "Alice", got "${displayAddr(A_UPPER, BOOK)}"`);
(displayAddr(B_UPPER, BOOK) === B_UPPER)
  ? ok('an unsaved address renders unchanged (full M_ address, as before)')
  : bad(`unsaved address was altered: "${displayAddr(B_UPPER, BOOK)}"`);
(displayAddr('FAUCET', BOOK) === 'COMMON TREASURY' && displayAddr(RESERVE_ADDRESS, BOOK) === 'COMMON RESERVE')
  ? ok('FAUCET and SWARM_RESERVE keep their existing labels')
  : bad('FAUCET/SWARM_RESERVE labels regressed');
// a contact must never be able to shadow the treasury labels
(displayAddr('FAUCET', [{ nickname: 'Hacker', address: A_UPPER }, { nickname: 'X', address: 'FAUCET' }]) === 'COMMON TREASURY')
  ? ok('a contact cannot shadow the FAUCET label (treasury check runs first)')
  : bad('a contact overrode the FAUCET label');

// ── 2 CASE-INSENSITIVE MATCH ────────────────────────────────────────────────
console.log('\n  2 CASE-INSENSITIVE MATCH');
(displayAddr(A_LOWER, BOOK) === 'Alice')
  ? ok('a lowercase ledger address matches an uppercase-stored contact')
  : bad(`lowercase ledger address did not match: "${displayAddr(A_LOWER, BOOK)}"`);
(contactNameFor(A_UPPER, [{ nickname: 'Alice', address: A_LOWER }]) === 'Alice')
  ? ok('the match is case-insensitive on the stored side too')
  : bad('uppercase ledger address did not match a lowercase-stored contact');

// ── 3 ONE-ARG BEHAVIOUR UNCHANGED ───────────────────────────────────────────
console.log('\n  3 ONE-ARG BEHAVIOUR UNCHANGED');
(displayAddr(A_UPPER) === A_UPPER && displayAddr(B_UPPER) === B_UPPER)
  ? ok('called with one argument, displayAddr returns the address verbatim (pre-change behaviour)')
  : bad('one-arg displayAddr behaviour changed');
(displayAddr('FAUCET') === 'COMMON TREASURY' && displayAddr(RESERVE_ADDRESS) === 'COMMON RESERVE')
  ? ok('one-arg treasury labels unchanged')
  : bad('one-arg treasury labels changed');
(contactNameFor(A_UPPER, null) === null && contactNameFor(null, BOOK) === null)
  ? ok('a null contacts list or null address is tolerated (no throw)')
  : bad('null handling regressed');

// ── 4 TAPPABILITY RULE ──────────────────────────────────────────────────────
console.log('\n  4 TAPPABILITY RULE');
(canNameAddr(B_UPPER, SELF) === true)
  ? ok('a stranger address is tappable-to-name')
  : bad('a stranger address was not tappable');
(canNameAddr('FAUCET', SELF) === false && canNameAddr(RESERVE_ADDRESS, SELF) === false)
  ? ok('FAUCET and SWARM_RESERVE are NOT tappable')
  : bad('FAUCET/SWARM_RESERVE were tappable');
(canNameAddr(SELF, SELF) === false && canNameAddr(SELF.toLowerCase(), SELF) === false)
  ? ok("the user's own address is NOT tappable (case-insensitively)")
  : bad('own address was tappable');
(canNameAddr('', SELF) === false && canNameAddr('M_NOTHEX', SELF) === false)
  ? ok('empty and malformed addresses are NOT tappable')
  : bad('a malformed address was tappable');
// an already-saved contact stays tappable — that is the rename path
(canNameAddr(A_UPPER, SELF) === true)
  ? ok('an already-saved contact is still tappable (opens rename)')
  : bad('a saved contact was not tappable');

// ── 5-7 APP.JS WIRING (structural) ──────────────────────────────────────────
const src = fs.readFileSync(APP_JS, 'utf8');
const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('\n  5 APP.JS WIRING — display');
(/const\s+displayAddr\s*=\s*\(addr,\s*contacts\)/.test(stripped))
  ? ok('displayAddr takes the contacts array as an optional second parameter')
  : bad('displayAddr does not accept a contacts parameter');
(/contactNameFor\(addr,\s*contacts\)\s*\|\|\s*addr/.test(stripped))
  ? ok('displayAddr consults contacts, falling back to the raw address')
  : bad('displayAddr does not consult contacts');
(/normAddress\(c\.address\)\s*===\s*a/.test(stripped))
  ? ok('the lookup normalises both sides before comparing')
  : bad('the lookup is not case-normalised');
{
  const n = (stripped.match(/displayAddr\(tx\.(from|to),\s*contacts\)/g) || []).length;
  (n === 4)
    ? ok('both ledger slots render via displayAddr(tx.*, contacts) (4 occurrences: tappable + plain branch)')
    : bad(`expected 4 displayAddr(tx.*, contacts) call sites, found ${n}`);
}
(!/displayAddr\(tx\.(from|to)\)/.test(stripped))
  ? ok('no ledger slot still calls the one-arg form')
  : bad('a ledger slot still calls displayAddr without contacts');

console.log('\n  6 APP.JS WIRING — tap handlers');
(/nameLedgerAddr\s*=\s*\(addr\)/.test(stripped))
  ? ok('nameLedgerAddr(addr) exists')
  : bad('nameLedgerAddr is missing');
(/hit\s*\?\s*startEditContact\(hit\)\s*:\s*promptSaveContact\(addr\)/.test(stripped))
  ? ok('nameLedgerAddr reuses the EXISTING handlers: found → startEditContact, else → promptSaveContact')
  : bad('nameLedgerAddr does not reuse the existing save/rename handlers');
{
  const n = (stripped.match(/onPress=\{\(\)\s*=>\s*nameLedgerAddr\(tx\.(from|to)\)\}/g) || []).length;
  (n === 2)
    ? ok('both address slots (from and to) have their own tap handler')
    : bad(`expected 2 ledger address tap handlers, found ${n}`);
}
(/canNameAddr\(tx\.from,\s*address\)/.test(stripped) && /canNameAddr\(tx\.to,\s*address\)/.test(stripped))
  ? ok('both slots gate tappability on canNameAddr(addr, ownAddress)')
  : bad('tappability is not gated by canNameAddr');
(/const\s+canNameAddr\s*=\s*\(addr,\s*selfAddr\)\s*=>\s*\n?\s*isValidAddress\(addr\)\s*&&\s*normAddress\(addr\)\s*!==\s*normAddress\(selfAddr\)/.test(stripped))
  ? ok('canNameAddr excludes non-M_ labels (FAUCET/SWARM_RESERVE) and the own address')
  : bad('canNameAddr does not implement the exclusion rule');
// the modal that the tap opens must still be the existing one
(/visible=\{saveContactAddr\s*!==\s*null\}/.test(stripped))
  ? ok('the existing save/rename modal is still the one being opened (no new modal)')
  : bad('the existing save/rename modal is gone');

console.log('\n  7 NO SECOND STORE / STILL SCROLLVIEW');
{
  const n = (stripped.match(/createContactStore\(/g) || []).length;
  (n === 1)
    ? ok('exactly one contact store is created — the existing one')
    : bad(`expected 1 createContactStore call, found ${n}`);
}
(/contacts_v1/.test(fs.readFileSync(path.join(__dirname, 'contacts.js'), 'utf8')) && !/contacts_v1/.test(stripped))
  ? ok('App.js does not hard-code a second contacts storage key')
  : bad('App.js references a contacts storage key directly');
(/txs\.map\(\(tx,\s*i\)\s*=>/.test(stripped))
  ? ok('the ledger still renders via txs.map (ScrollView, not FlatList)')
  : bad('the ledger no longer uses txs.map');
(!/<FlatList/.test(stripped))
  ? ok('no FlatList was introduced')
  : bad('a FlatList was introduced — out of scope');
(/await refreshContacts\(\)/.test(stripped))
  ? ok('saving/renaming refreshes contacts state, so the ledger re-renders without a restart')
  : bad('refreshContacts is not called after a save');

console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Ledger nicknames: ${fails === 0 ? 'ALL PROBES PASS' : fails + ' FAILURE(S)'} — saved addresses show their nickname; tapping one opens the existing save/rename prompt.\n`);
process.exit(fails === 0 ? 0 : 1);
