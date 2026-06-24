// test_contacts.js — gate for the address book (mobile/contacts.js). Exit non-zero on any failure.
//
//  • Save a valid contact → persists → reloads after a simulated restart.
//  • Reject a malformed address; reject a duplicate address.
//  • Edit a nickname; delete a contact → gone after reload.
//  • Existing send flow (manual paste + QR) still works with zero contacts saved.

const { createContactStore, isValidAddress, CONTACTS_KEY } = require('./contacts');

// in-memory stand-in for AsyncStorage (getItem/setItem) — a NEW store instance
// reading the SAME backing map == an app restart.
function memStorage() {
  const m = new Map();
  return { getItem: async (k) => (m.has(k) ? m.get(k) : null), setItem: async (k, v) => { m.set(k, v); }, _raw: () => m.get(CONTACTS_KEY) };
}

const VALID       = 'M_A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';     // M_ + 32 hex
const VALID2      = 'M_0123456789ABCDEF0123456789ABCDEF';
const VALID_LOWER = 'm_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';     // lowercase variant → canonicalizes to VALID
const BAD = ['M_123', 'X_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'M_' + 'A'.repeat(31), 'M_' + 'A'.repeat(33), 'M_' + 'G'.repeat(32), '', 'hello', 'M_', null, undefined];

let fails = 0;
const ok  = (m) => console.log(`   ✅  ${m}`);
const bad = (m) => { fails++; console.log(`   ❌  ${m}`); };
async function rejects(fn, label) { try { await fn(); bad(`${label} — should have rejected`); } catch { ok(label); } }

(async () => {
  console.log('\n  ADDRESS BOOK GATE\n');

  // 1. save valid → persists → survives a simulated restart
  const storage = memStorage();
  await createContactStore(storage).add('Alice', VALID);
  const reloaded = await createContactStore(storage).load();   // new instance, same backing store = restart
  (reloaded.length === 1 && reloaded[0].nickname === 'Alice' && reloaded[0].address === VALID)
    ? ok('save valid → persisted → survived restart') : bad(`persist/reload wrong: ${JSON.stringify(reloaded)}`);

  // address canonicalization: a lowercase paste normalizes to the real uppercase address
  const stN = memStorage();
  await createContactStore(stN).add('Lower', VALID_LOWER);
  ((await createContactStore(stN).load())[0].address === VALID) ? ok('address normalized to canonical uppercase') : bad('normalize failed');

  const s = createContactStore(storage);

  // 2. reject malformed
  for (const b of BAD) await rejects(() => s.add('Nick', b), `reject malformed ${JSON.stringify(b)}`);
  await rejects(() => createContactStore(memStorage()).add('   ', VALID), 'reject empty nickname');

  // 2b. reject duplicate (same address, even via different case / different nickname)
  await rejects(() => s.add('Alice again', VALID), 'reject duplicate address');
  await rejects(() => s.add('Alice lower', VALID_LOWER), 'reject duplicate (case-insensitive)');

  // 3. edit a nickname → persists across reload
  await s.rename(VALID, 'Alice Smith');
  ((await createContactStore(storage).load()).find((c) => c.address === VALID).nickname === 'Alice Smith')
    ? ok('rename persisted across reload') : bad('rename failed');

  // 4. delete a contact → gone after reload (others intact)
  await s.add('Bob', VALID2);
  await s.remove(VALID);
  const r4 = await createContactStore(storage).load();
  (!r4.some((c) => c.address === VALID) && r4.some((c) => c.address === VALID2))
    ? ok('delete removed contact (survived reload); others intact') : bad(`delete wrong: ${JSON.stringify(r4)}`);

  // 5. existing send flow with ZERO contacts still works
  const empty = createContactStore(memStorage());
  (((await empty.load()).length === 0) && ((await empty.suggest('')).length === 0) && ((await empty.suggest('xyz')).length === 0))
    ? ok('zero contacts: empty list + empty suggestions (send flow unaffected)') : bad('empty store not clean');
  (isValidAddress(VALID) && isValidAddress(VALID_LOWER) && !isValidAddress('M_bad') && !isValidAddress(''))
    ? ok('isValidAddress matches M_+32hex (manual paste / QR validation intact)') : bad('isValidAddress wrong');

  // type-ahead: suggest matches by nickname AND by address fragment
  const sg = createContactStore(memStorage());
  await sg.add('Charlie', VALID); await sg.add('Dave', VALID2);
  const byNick = await sg.suggest('char');
  const byAddr = await sg.suggest(VALID2.slice(2, 8));
  (byNick.length === 1 && byNick[0].nickname === 'Charlie' && byAddr.length === 1 && byAddr[0].address === VALID2)
    ? ok('type-ahead suggest matches by nickname and by address') : bad(`suggest wrong: ${JSON.stringify({ byNick, byAddr })}`);

  console.log(`\n  ${fails === 0 ? '🎉' : '💥'}  Address book: ${fails === 0 ? 'ALL CHECKS PASS' : fails + ' FAILURE(S)'}\n`);
  process.exit(fails === 0 ? 0 : 1);
})();
