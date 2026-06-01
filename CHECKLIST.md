# MONEY — Ship & test checklist

Goal: test the app end-to-end with a second person against the live backend,
and watch real transactions land.

---

## STEP 1 — Deploy the hardened backend FIRST (critical)

The app was rewritten to rely on the signed key + Google identity — it no longer
sends face hashes. The current `server.js` matches that; an older deployed server
that still requires face hashes will **reject every ignition**. So redeploy before testing.

On the server host (api.moneyforeveryone.app):
- [ ] Get the latest `server.js` onto the host (git pull / scp).
- [ ] Set the platform-wallet env var so nocopycART payments are accepted:
  ```
  MONEY_PLATFORM_ADDRESSES=M_F66DCDBCD2FA68D8FCEE50A503CFBA20
  TRUST_PROXY=1
  ```
  (see `.env.example`; set these however the host loads env — systemd unit, PM2 ecosystem, Docker, etc.)
- [ ] Restart the server (`node server.js`, or `pm2 restart money`, etc.).
- [ ] Confirm it's live:
  ```
  curl https://api.moneyforeveryone.app/health
  curl https://api.moneyforeveryone.app/stats
  ```
  `/health` should return `{ "status": "ok", ... }`.

---

## STEP 2 — Build the Android APK (~10 min, you just wait)

- [ ] Terminal in the MONEY-Test folder:
  ```
  npx eas build --profile preview --platform android
  ```
- [ ] Wait for the build; you get a link.
- [ ] Open the link on BOTH phones to install.

---

## STEP 3 — Two-person test (do these in order)

**She sets up the app:**
- [ ] Completes setup (face scan, voice, thumbprint, PIN).
- [ ] Lands on the main screen with a balance ✅
  - (Watch the server log: you should see a `TX: FAUCET → M_... ` line and `/stats` users count go up.)

**You two send money:**
- [ ] She sends you some MONEY.
- [ ] Her phone asks for fingerprint/face before sending ✅
- [ ] Your balance updates within ~1 minute ✅
- [ ] `curl https://api.moneyforeveryone.app/ledger` shows the transfer.

**Try to cheat (these should all FAIL):**
- [ ] She tries to claim her starting money a second time → blocked ("already been ignited") ✅
- [ ] She tries to send more than she has → blocked ("Insufficient balance") ✅
- [ ] Forged faucet claim from a laptop (below) → blocked ✅

**Laptop cheat test** — paste in a terminal:
```
curl -X POST https://api.moneyforeveryone.app/transaction -H "Content-Type: application/json" -d "{\"from\":\"FAUCET\",\"to\":\"M_FAKEADDRESS\",\"amount\":999999}"
```
Expected: a **401 rejection** — `"Transaction timestamp expired or invalid"` (no timestamp) or,
if you add a fresh timestamp, `"Ignition must include signature, publicKey, and timestamp"`.
The point: a faucet claim with no valid signature is **rejected**, never `success`.

---

## STEP 4 — Sanity-check the backend state

- [ ] `GET /stats` — transactions, registeredUsers, googleSeals, replayFenceSize.
- [ ] `GET /ledger` — every test transfer is present, amounts correct.
- [ ] Run the local attack simulation any time: `node attack_sim.js` (should print ALL ... BLOCKED).

---

## LATER — Nice to have (no rush)

- [ ] Turn on Google Sign-In in the app to activate the Sybil gate. It's currently
      commented out (needs a native build), so `google_sub` is undefined and the
      "one seal per human" gate is dormant — identity falls back to the signed key,
      which a fresh keypair defeats. This is the main thing standing between "demo"
      and "real Sybil resistance".
- [ ] Auth-gate or remove the `/stats` debug endpoint before a public launch.
- [ ] Add rate limiting to `/google-lookup` and `/ledger`.
