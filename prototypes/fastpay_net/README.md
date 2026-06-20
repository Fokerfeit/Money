# MONEY — networked committee (v2)

The prototype is no longer in-process. This version is a **real distributed
system**: authorities are separate HTTP servers, a committee is **selected per
epoch from the online validator pool**, and authority state **survives restarts**
(written to disk). Money moves over the wire when a quorum co-signs.

## Run it
```sh
npm install tweetnacl
node run_network.js
```
You'll watch 6 authority servers boot on ports 4101–4106, a committee get picked
for epoch 1 (and a different one for epoch 2 — proving rotation), then a clean
transfer, a blocked double-spend, a kill-and-restart persistence test, and the
attack cases — all over real HTTP, ending in exit 0.

## Files
| File | Role |
|---|---|
| `crypto.js` | ed25519, `M_` address, hashing, per-account chain, stable authority keys |
| `authority.js` | validate + lock + apply, **persisted to disk** |
| `server.js` | wraps an authority as an HTTP server (`/order`, `/certificate`, `/state`) |
| `committee.js` | **rotating** committee selection from the online pool, by epoch |
| `wallet.js` | a phone's wallet — runs the two-phase flow over HTTP |
| `run_network.js` | boots the whole network and runs the scenario |

## What is REAL now (beyond v1)
- **Networked** — authorities are separate HTTP servers; the wallet talks to them
  over the wire. Co-located on one machine for the demo; split across machines by
  changing `127.0.0.1` to real hosts.
- **Rotating committee** — `hash(epoch + validator)` picks the epoch's committee
  from whoever is online. Epoch 1 and epoch 2 visibly differ.
- **Persistent** — each authority writes state to `data/<name>.json`. Kill it,
  restart it, the balance and sequence survive; an old transfer can't be replayed.
- **Pool stays in sync** — a non-committee node reports the same balances, so the
  whole pool agrees, not just the signers.
- Double-spend, over-standing, bad signature, wrong sequence — all refused **over
  the network**.

## The honest last mile (needs YOU — not buildable from here)
1. **Deploy** the authority servers to real always-on machines / your Hetzner box.
2. **Phone integration** — wire `wallet.js` into the MONEY app; add the relay layer
   so phones behind NAT can be reached; add presence/heartbeat so the online pool
   is real.
3. **Security audit** — this is real money. An unaudited payment network is a
   liability, not a launch.
4. **Regulatory** — running a money-transmission service in Canada/Québec has legal
   obligations (e.g. FINTRAC / MSB). Check before going live.

Nothing here touches your live server. It's a real, runnable core you control.
