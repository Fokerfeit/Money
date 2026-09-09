// mobile/contacts.js — the address book (saved recipient contacts).
//
// Pure and storage-INJECTED: it imports nothing from React Native, so the exact
// same module runs inside the app (App.js passes AsyncStorage) AND in a plain
// Node test (which passes an in-memory fake). Persisted under `contacts_v1` via a
// getItem/setItem storage — the same mechanism the app already uses for
// keypair_v3 / biokey_v1 (AsyncStorage).
'use strict';

const CONTACTS_KEY = 'contacts_v1';

// A real seal mark is `M_` + 32 hex — see createKeypair() in App.js:
//   'M_' + toHex(pubkey).substring(0, 32).toUpperCase()
// We validate that exact shape (case-insensitive on input; stored canonical UPPER).
const ADDRESS_RE = /^M_[0-9A-Fa-f]{32}$/i;   // case-insensitive like the app's isValidSealMark; stored canonical UPPER

const normAddress = (a) => String(a == null ? '' : a).trim().toUpperCase();
const normNick    = (n) => String(n == null ? '' : n).trim();
const isValidAddress = (a) => ADDRESS_RE.test(String(a == null ? '' : a).trim());

function createContactStore(storage) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function')
    throw new Error('createContactStore(storage): storage must provide getItem/setItem');

  async function load() {
    try {
      const raw = await storage.getItem(CONTACTS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];
      // tolerate a corrupt store: keep only well-formed { nickname, address } rows
      return arr
        .filter((c) => c && isValidAddress(c.address) && typeof c.nickname === 'string' && c.nickname.trim())
        .map((c) => ({ nickname: c.nickname, address: normAddress(c.address) }));
    } catch { return []; }
  }
  const persist = (list) => storage.setItem(CONTACTS_KEY, JSON.stringify(list));

  // Add a new contact. Rejects a malformed address and a duplicate address
  // (case-insensitive). To change a saved address's name, use rename().
  async function add(nickname, address) {
    const addr = normAddress(address);
    const nick = normNick(nickname);
    if (!isValidAddress(addr)) throw new Error('Invalid seal mark — must be M_ followed by 32 hex characters.');
    if (!nick) throw new Error('A nickname is required.');
    const list = await load();
    if (list.some((c) => c.address === addr)) throw new Error('That address is already in your contacts.');
    const next = [...list, { nickname: nick, address: addr }];
    await persist(next);
    return next;
  }
  async function rename(address, newNickname) {
    const addr = normAddress(address);
    const nick = normNick(newNickname);
    if (!nick) throw new Error('A nickname is required.');
    const list = await load();
    if (!list.some((c) => c.address === addr)) throw new Error('Contact not found.');
    const next = list.map((c) => (c.address === addr ? { nickname: nick, address: addr } : c));
    await persist(next);
    return next;
  }
  async function remove(address) {
    const addr = normAddress(address);
    const next = (await load()).filter((c) => c.address !== addr);
    await persist(next);
    return next;
  }
  async function has(address) {
    const addr = normAddress(address);
    return (await load()).some((c) => c.address === addr);
  }
  async function nameFor(address) {
    const addr = normAddress(address);
    const c = (await load()).find((x) => x.address === addr);
    return c ? c.nickname : null;
  }
  // type-ahead: contacts whose nickname or address contains the query (case-insensitive)
  async function suggest(query) {
    const q = String(query == null ? '' : query).trim().toUpperCase();
    const list = await load();
    if (!q) return list;
    return list.filter((c) => c.nickname.toUpperCase().includes(q) || c.address.includes(q));
  }
  return { load, list: load, add, rename, remove, has, nameFor, suggest };
}

module.exports = { CONTACTS_KEY, ADDRESS_RE, isValidAddress, normAddress, createContactStore };
