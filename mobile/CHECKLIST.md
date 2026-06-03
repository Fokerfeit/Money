# MONEY — Test & Run Checklist

Status: **private test only.** Nothing is public. Do not deploy / go live without
Luca's explicit approval (see the standing rule in memory).

---

## 🔑 Your ignition codes (single-use — one seal each)
| Code | For |
|---|---|
| `LUCA-1` | You |
| `GUEST-1` | Your friend |

Each code makes exactly **one** wallet. Reused, missing, or fake codes are rejected.
To issue more codes, restart the server with more in `IGNITION_CODES` (see below).

---

## ▶️ Get your 1,000,000 (on your phone)
The server runs on this PC; your phone talks to it over Wi-Fi.

1. Make sure **phone + PC are on the same Wi-Fi.**
2. **Reload the app** — Metro terminal press `r`, or shake → Reload.
   - If it's stuck at 0.00 on the main screen, clear it first: phone **Settings → Apps → Expo Go → Storage → Clear data**, reopen, re-scan the QR.
3. Go through onboarding to the **Ignite** screen.
4. In the **"Founder's ignition code"** box, type **`LUCA-1`**.
5. Tap **Ignite** → balance becomes **1,000,000** 🎉

Your friend does the same with **`GUEST-1`**. Then send money between phones to test transfers.

---

## 🖥️ Running the server

It's already running in this session. To run it yourself (so it survives), open a
terminal in `MONEY-Test` and run **one** line:

```
# Windows PowerShell
$env:MONEY_PLATFORM_ADDRESSES="M_F66DCDBCD2FA68D8FCEE50A503CFBA20"; $env:IGNITION_CODES="LUCA-1,GUEST-1"; node server.js
```

- It listens on `http://192.168.4.41:3000` (your PC, Wi-Fi only — not the internet).
- `config.js` already points the app here (local testing). The production URL is
  commented out below it; swap back only when you deploy (with approval).
- If your phone can't connect: allow port 3000 through Windows Firewall —
  in an **Admin** PowerShell:
  `New-NetFirewallRule -DisplayName "MONEY 3000" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow`

---

## ✅ What's protected (verified by tests)
- `node attack_sim.js` → 14/14 standard attacks blocked
- `node flow_test.js` → full ignite→send→balance journey (10/10)
- `node adversary_demo.js` → unlimited-mint blocked (0 minted without a code)

Run any of them anytime. (Use `PORT=3100 node attack_sim.js` if the main server is up.)

---

## 📦 Build a shareable APK (optional — when you want it on phones without Metro)
Needs your Expo login; takes ~10 min. From `MONEY-Test`:
```
npx eas build --profile preview --platform android
```
Open the resulting link on each phone to install. (A preview build for a friend is
fine; publishing to an app store is a "go-live" step → needs approval.)

---

## 🚦 Before an OPEN launch (strangers, real value) — NOT yet
1. **Real identity** instead of codes: verified Google sign-in (server validates the
   ID token) or phone-number OTP. Codes are great for a closed test, not the public.
2. **Tamper-proof ledger**: today it's one server + one JSON file. A real launch needs
   a distributed/append-only ledger so no single machine controls the money.
3. **Deploy** server + set `TRUST_PROXY=1` behind a real proxy, HTTPS, backups.

All gated on your approval.
