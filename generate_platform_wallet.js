/**
 * Generate a dedicated MONEY platform wallet for nocopycART.
 *
 * Produces an ed25519 keypair and the derived M_ address (same scheme the
 * server uses: 'M_' + publicKeyHex[0..32].toUpperCase()).
 *
 *   - The PUBLIC address goes in nocopycART's .env as PLATFORM_MONEY_ADDRESS.
 *   - The SECRET key is written to platform_wallet.secret.json (gitignored).
 *     Keep it safe: it is the only thing that can SPEND the platform's balance
 *     (e.g. to pay creators). Anyone with it controls the wallet.
 *
 * Usage:  node generate_platform_wallet.js
 */
const nacl = require('tweetnacl');
const fs   = require('fs');
const path = require('path');

const toHex     = (a)  => Buffer.from(a).toString('hex');
const toAddress = (pk) => 'M_' + pk.substring(0, 32).toUpperCase();

const SECRET_FILE = path.join(__dirname, 'platform_wallet.secret.json');
if (fs.existsSync(SECRET_FILE)) {
  console.error(`Refusing to overwrite existing ${path.basename(SECRET_FILE)}.`);
  console.error('Delete it first if you really want a new wallet (the old address becomes unusable).');
  process.exit(1);
}

const seed = nacl.randomBytes(32);
const kp   = nacl.sign.keyPair.fromSeed(seed);
const publicKey = toHex(kp.publicKey);
const secretKey = toHex(kp.secretKey);
const address   = toAddress(publicKey);

fs.writeFileSync(SECRET_FILE, JSON.stringify({
  label:     'nocopycART platform wallet',
  address,
  publicKey,
  secretKey,
  seed:      toHex(seed),
  createdAt: new Date().toISOString(),
}, null, 2));

console.log('\n── nocopycART platform wallet created ───────────────────────');
console.log(`  Address (public — put in .env): ${address}`);
console.log(`  Secret key saved to:            ${path.basename(SECRET_FILE)}  (gitignored)`);
console.log('─────────────────────────────────────────────────────────────');
console.log('  Next: register this address on the MONEY network so it can');
console.log('  receive buyer payments (it must be a known recipient).');
console.log('─────────────────────────────────────────────────────────────\n');
