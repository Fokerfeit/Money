# 🪙 Run a MONEY node — the friendly guide

Welcome! You've been given a folder called **money-node**. Running it makes your
computer part of the MONEY testnet — a small, friends-and-family test network
using **play money** (not real money yet). This guide has no jargon. Promise.

---

## ▶️ Start it (one time setup, then just double-click)

1. **Install Node.js** if you don't have it — it's free, from **https://nodejs.org**
   (get the button that says **LTS**). This is the only thing MONEY needs.
2. Open the **money-node** folder.
3. **Double-click:**
   - **Windows:** `start-node.bat`
   - **Mac / Linux:** `start-node.sh`
4. The first time, it spends a few seconds downloading two small libraries. After
   that it starts right up.

That's it. A black window (a "terminal") opens and your node runs.

---

## 🔑 Your address and your wallet

When it starts, look for a line like:

```
{"type":"ready","address":"M_ABC123…","pub":"…"}
```

That **`M_…` address is you** — your identity on the network.

The very first time you run it, the folder creates a file called **`identity.json`**.

> ### ⚠️ `identity.json` **IS your wallet.** Read this twice.
> - **Back it up.** Copy `identity.json` somewhere safe (a USB stick, your cloud
>   drive). If your computer dies and you lose this file, you lose your wallet —
>   there is no "forgot password" for it.
> - **Never share it. Never send it to anyone.** Anyone who has this file *is* you
>   and can move your money. No admin, no support person, will ever need it.
> - It's a plain file in the money-node folder. Guard it like a house key.

---

## 💰 Checking your balance

Your balance shows up automatically in the window on lines like:

```
{"type":"status","address":"M_ABC123…","balances":{"M_ABC123…":1000000}, …}
```

The number next to your address is your balance. New status lines appear whenever
anything changes on the network. (New wallets start at **0** until you join — see
below.)

---

## 🤝 Joining (getting your 1,000,000)

To become a spending member you need an **invite** from someone already on the
network (for the beta, that's usually Luca). Invites are deliberate and limited —
that's what keeps the network fair.

1. Ask your inviter for an invite. They'll send you **one line of text** that looks
   like `{"inviterAddr":"M_…","inviteId":"…","inviterSig":"…"}`.
2. In the running node window, **type (or paste) this one line** and press Enter —
   put your invite where it says `PASTE_INVITE_HERE`:
   ```
   {"op":"redeem","invite":PASTE_INVITE_HERE}
   ```
   For example:
   ```
   {"op":"redeem","invite":{"inviterAddr":"M_…","inviteId":"…","inviterSig":"…"}}
   ```
3. You'll see `{"type":"redeemed",…}` and, moments later, a status line showing
   your **1,000,000**. You're in.

> An invite is like a gift card — whoever holds it can use it. Only accept one sent
> **directly to you** by someone you trust, and don't post it anywhere public.

---

## ⏹️ Stopping and restarting safely

- **To stop:** click the window and press **Ctrl-C** (hold Ctrl, press C), or just
  close the window. Nothing breaks.
- **To restart:** double-click `start-node.bat` / `start-node.sh` again. Because
  your wallet is saved in `identity.json`, you come back as the **same** address
  with the **same** balance. Restarting as often as you like is totally safe.

---

## ❓ Quick help

| Thing you see | What it means |
|---|---|
| `Node.js is not installed` | Install it from https://nodejs.org (the **LTS** button), then try again. |
| `{"type":"connection","state":"disconnected"}` | Lost the network for a moment — it reconnects on its own. |
| `{"type":"connection","state":"connected"}` | You're connected to the network. |
| The number by your address isn't changing | Nothing's happening on the network right now — that's normal. |

Questions? Ask the person who sent you this folder. Have fun — you're running a
piece of a real decentralized network. 🌍
