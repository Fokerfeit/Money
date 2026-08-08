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

When it starts, you'll see a box like this:

```
  ==========================================================
   MONEY  --  your node is running
  ==========================================================
   your address : M_ABC123…
   balance      : 0 MONEY
   network      : 2 members  (2 founders in genesis)
   relay        : wss://testnet.moneyforeveryone.app/relay
  ==========================================================
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

Your starting balance is in the box above. After that, the window only speaks up
when something actually **changes**, like:

```
   [ok] balance +1,000,000 -> 1,000,000 MONEY
   -  network now 3 members (+1)
```

A quiet window means nothing is happening on the network — that's normal, not a
problem. To ask for your current numbers at any time, type this and press Enter:

```
{"op":"status"}
```

(New wallets start at **0** until you join — see below.)

---

## 🤝 Joining (getting your 1,000,000)

To become a spending member you need an **invite** from someone already on the
network (for the beta, that's usually Luca). Invites are deliberate and limited —
that's what keeps the network fair. Each invite is **made for one specific
address** — yours — so nobody who intercepts it can use it.

1. **First, send your inviter YOUR address** — the `M_…` shown as *your address*
   in the box above. They need it to make your invite.
2. They'll send back **one line of text** that looks like
   `{"inviterAddr":"M_…","inviteId":"…","target":"M_…","inviterSig":"…"}` —
   the `target` is your address; the invite only works for you.
3. In the running node window, **type (or paste) this one line** and press Enter —
   put your invite where it says `PASTE_INVITE_HERE`:
   ```
   {"op":"redeem","invite":PASTE_INVITE_HERE}
   ```
   For example:
   ```
   {"op":"redeem","invite":{"inviterAddr":"M_…","inviteId":"…","target":"M_…","inviterSig":"…"}}
   ```
4. Watch for these lines, in order:
   ```
   ... invite sent to the network -- waiting for confirmation...
   [ok] you are now a member of the network
   [ok] balance +1,000,000 -> 1,000,000 MONEY
   ```
   That's it — you're in. 🎉
   - While it waits you may see `waiting for the network to confirm -- 10s
     elapsed`. That's normal; it's telling you it hasn't given up. If it also says
     the connection is **unstable** or **disconnected**, the network link is the
     problem, not your invite.
   - If you get `could not join with that invite` (after ~30 seconds), the invite
     didn't work — mistyped, already spent, or your internet dropped. Ask your
     inviter for a fresh invite and try again. **Nothing is lost.**
   - If you see an error saying the invite is **"bound to"** a different address,
     the invite was made for someone else (maybe you sent the wrong address, or
     your inviter mistyped it). Send your inviter the exact `M_…` shown as *your
     address* and ask for a new invite.

> Your invite only works for **your** address — someone who steals it can't use
> it. Still, keep it between you and your inviter; it's nobody else's business.

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
| `lost connection to the relay` | Lost the network for a moment — it reconnects on its own. |
| `reconnected (after 2 drops)` | It came back by itself. Nothing for you to do. |
| `the connection to the relay keeps dropping` | A known issue we're working on — your node keeps retrying. Anything you send while it's down may not go through until it's back. |
| `could not join with that invite` | Your invite didn't work (mistyped, already used, or no connection). Ask for a fresh one — nothing is lost. |
| `this node may be on the wrong network` | Your download may be outdated — tell the person who sent you this folder; they'll send a fresh one. |
| `that is not a complete command` | The line you typed got cut off or mistyped. Paste the whole line, from `{` to `}`. |
| Nothing is happening / window is quiet | Nothing's changing on the network right now — that's normal. Type `{"op":"status"}` to check. |

Questions? Ask the person who sent you this folder. Have fun — you're running a
piece of a real decentralized network. 🌍
