# MONEY — What to do and when

---

## RIGHT NOW — Restart the server (2 min)

The server has new protections. You need to restart it for them to take effect.

- [ ] On your server machine, stop the server (Ctrl+C)
- [ ] Run: `node server.js`
- [ ] Done. Server is now protected.

---

## JUNE 1 — Build the app (10 min, you just wait)

- [ ] Open terminal in the MONEY-Test folder
- [ ] Run this one command:
  ```
  npx eas build --profile preview --platform android --non-interactive
  ```
- [ ] Wait ~10 minutes
- [ ] You get a link — open it on BOTH phones to install

---

## JUNE 1 — Test with your girlfriend's phone (30 min)

Do these in order. Each one should work.

**She sets up the app:**
- [ ] She completes the full setup (face scan, voice, thumbprint)
- [ ] She lands on the main screen with a balance ✅

**You two send money:**
- [ ] She sends you 100 MONEY
- [ ] Her phone asks for fingerprint/face before sending ✅
- [ ] Your balance updates within 1 minute ✅

**Try to cheat (these should all FAIL):**
- [ ] She tries to claim her starting money a second time → blocked ✅
- [ ] She tries to send more than she has → blocked ✅
- [ ] You try to fake a faucet claim from your laptop (see below) → blocked ✅

**Laptop cheat test** — open terminal and paste this
(replace YOUR_IP with the server IP from config.js):
```
curl -X POST http://YOUR_IP:3000/transaction -H "Content-Type: application/json" -d "{\"from\":\"FAUCET\",\"to\":\"M_FAKEADDRESS\",\"amount\":999999}"
```
You should see: `Faucet claim must include recipient signature`

---

## LATER — Nice to have (no rush)

- [ ] Add HTTPS so the connection is encrypted
- [ ] Add face embedding to detect the same person on multiple phones
- [ ] Google Sign-In as a second identity layer
