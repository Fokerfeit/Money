# Running a MONEY committee node across two real machines (Brick 3, Bite 2)

This is a **manual deployment guide**, not something Code automates. It
documents exactly how Bite 1's `relay.js` + `run_node.js` — unchanged in their
actual money/consensus behavior — run across two real machines, on
**testnet / play-money only**, without exposing anything to the public
internet.

**⛔ This never touches the mainnet money server or the founding-wallet box.**
The relay here is its own standalone process, on its own port, run only for
this experiment.

## The model: relay stays private, reached only through an SSH tunnel

```
┌─────────────────────────────┐         SSH tunnel          ┌──────────────────────────────┐
│  YOUR LAPTOP                │  ssh -L 8080:localhost:8080 │  TESTNET BOX (e.g. Hetzner)   │
│                              │ ───────────────────────────>│                               │
│  Node A (run_node.js)        │                              │  relay.js  (bound 127.0.0.1) │
│  dials ws://localhost:8080 ──┼──────(via the tunnel)───────┼─>  ws://127.0.0.1:8080        │
│                              │                              │                               │
│                              │                              │  Node B (run_node.js)         │
│                              │                              │  dials ws://localhost:8080 ──┼─┐
└─────────────────────────────┘                              └───────────────────────────────┘ │
                                                                    (same box, loopback) ────────┘
```

- The relay binds `127.0.0.1` on the testnet box — **not** a public interface.
  No firewall rule changes, no new open port to the internet.
- Your laptop reaches it **only** through an SSH tunnel: `ssh -L
  8080:localhost:8080 <testnet-box>` forwards your laptop's local port 8080 to
  the box's `127.0.0.1:8080`.
- **Both** Node A (laptop) and Node B (testnet box) connect to
  `ws://localhost:8080` — from Node B's perspective that's the real relay
  directly; from Node A's perspective that's the tunnel, which SSH makes
  behave identically to a direct local connection.
- The relay and both nodes are exactly the same `relay.js`/`run_node.js` as
  Bite 1 — nothing about the money/consensus logic changed. The only new
  things are: config instead of hardcoded localhost, and reconnect-with-backoff
  for when the real network (or the SSH tunnel) hiccups.

## Step by step

**1. On the testnet box** — start the relay, bound to loopback only:

```bash
cd mobile/swarm
HOST=127.0.0.1 PORT=8080 node relay.js
```

Optional hardening (all default OFF — see "Optional guards" below):

```bash
HOST=127.0.0.1 PORT=8080 MAX_FRAME_BYTES=65536 MAX_CONN_PER_SEC=20 MAX_CONNECTIONS=10 node relay.js
```

**2. On the testnet box**, in a second terminal — run Node B directly against
the relay (no tunnel needed locally):

```bash
cd mobile/swarm
RELAY_URL=ws://localhost:8080 NODE_LABEL=nodeB FOUNDERS_JSON='["<addrA>","<addrB>"]' node run_node.js
```

**3. On your laptop** — open the SSH tunnel (leave this running):

```bash
ssh -L 8080:localhost:8080 <testnet-box>
```

**4. On your laptop**, in another terminal — run Node A against the tunnel:

```bash
cd mobile/swarm
RELAY_URL=ws://localhost:8080 NODE_LABEL=nodeA FOUNDERS_JSON='["<addrA>","<addrB>"]' node run_node.js
```

**5. Watch them converge.** Each node prints `{"type":"status",...}` lines to
stdout on every ledger change. Seal both as founders (pipe `{"op":"seal_founder"}`
to each node's stdin), then send a payment from one (`{"op":"pay","to":"<addr>",
"amount":1000,"nonce":1,"epoch":0}`) and watch both nodes' `hash` and `balances`
converge — over the real internet, through the tunnel, not localhost.

**6. Prove reconnect works.** Kill the SSH tunnel (Ctrl-C it) mid-run, wait a
few seconds, restart it (`ssh -L 8080:localhost:8080 <testnet-box>` again).
Node A's stdout will show `{"type":"connection","state":"disconnected"}` then,
once the tunnel is back, `{"type":"connection","state":"connected"}` followed
by a `status` line showing it caught back up to the same tip as Node B.

## Config reference (all optional — unset = Bite-1 behavior, unchanged)

**Relay (`relay.js`) env vars:**

| Var | Default | Effect |
|---|---|---|
| `PORT` | `8080` | listen port |
| `HOST` | unset (all interfaces) | bind address — set `127.0.0.1` for this deployment model |
| `DATA` | unset (no persistence) | JSONL archive file path |
| `MAX_FRAME_BYTES` | unset (ws's own default) | reject frames larger than this |
| `MAX_CONN_PER_SEC` | unset (unlimited) | per-connection message rate cap; excess messages are silently dropped |
| `MAX_CONNECTIONS` | unset (unlimited) | reject new connections once this many are already online |

**Node (`run_node.js`) env vars:**

| Var | Default | Effect |
|---|---|---|
| `RELAY_URL` | *(required)* | e.g. `ws://localhost:8080` |
| `NODE_LABEL` | unset | if SET: deterministic identity seed (`committee_bridge.mkIdentity`), no file I/O — this is what every test harness uses, so a test can precompute a node's address from its label. If UNSET: real persisted identity, see below. |
| `IDENTITY_FILE` | `identity.json` next to `run_node.js` | only consulted when `NODE_LABEL` is unset. **⚠️ THIS FILE IS THE WALLET** — see "Persisted node identity" below. |
| `FOUNDERS_JSON` | `[]` | JSON array of founder addresses |
| `STORE_FILE` | unset (no persistence) | local snapshot file (ledger/locks/accepted-state — NOT the identity/keypair; see `IDENTITY_FILE`) |
| `RECONNECT_BASE_MS` | `200` | initial reconnect delay after a drop |
| `RECONNECT_MAX_MS` | `10000` | reconnect delay cap (doubles each attempt up to this) |

## Persisted node identity — ⚠️ `identity.json` IS THE WALLET

Before this bite, every `run_node.js` launch with no `NODE_LABEL` would mint a
**genuinely random** identity (`swarm_engine.newId()`) — fine for throwaway
test nodes, but it meant a friend restarting their node lost their address
(and therefore their balance, from their perspective) on every restart. That's
now fixed for the real "download and run" path:

- **`NODE_LABEL` set** (all existing tests): unchanged. Deterministic identity,
  no file touched.
- **`NODE_LABEL` unset** (a real friend/family node): on first boot, a real
  random identity is generated and **written to `IDENTITY_FILE`** (via
  `mobile/safe_store.js`'s atomic write — stage `.tmp`, fsync, rename — so a
  crash mid-save can never leave a used-but-unsaved identity around) before
  the node ever announces or connects. On every later boot, that same file is
  loaded and the SAME address/keypair is reused.
- **⚠️ `identity.json` (or wherever `IDENTITY_FILE` points) contains the
  node's actual private key. It IS the wallet.**
  - **Back it up.** Losing it is the same as losing the wallet — there is no
    recovery path today (that's a separate, tracked priority: see
    `START_HERE_MONEY.md`'s "Key recovery priority").
  - **Never share it, never commit it.** It's in `.gitignore` (`identity.json`,
    `identity.json.bak`, `identity.json.tmp`) — don't override that.
  - **If it gets corrupted** (disk error, partial copy, hand-edited and now
    invalid), the node **refuses to start** rather than silently generating a
    replacement — see `identity_store.js`. Restore it from a backup; if you
    are certain it was never funded, delete it (and its `.bak`) to start
    fresh. There is deliberately no "just make a new one" auto-recovery here,
    because that would silently orphan whatever balance the real identity held.

## Optional guards — why they're off by default

The three relay guards (`MAX_FRAME_BYTES`, `MAX_CONN_PER_SEC`, `MAX_CONNECTIONS`)
exist for a **future** bite that puts the relay on a public port, where an
arbitrary internet client could otherwise send oversized frames, spam
messages, or open unbounded connections. In THIS bite the relay is never
public (loopback-only + SSH tunnel), so they're not load-bearing yet — they're
here, tested, and ready, not yet needed.

## Explicitly out of scope for this bite

- **Public/open relay** accepting arbitrary internet joiners — a separate,
  later bite (still testnet-only, but it adds real exposure this one avoids).
  → That bite now exists: see [`NODE_RUN_PUBLIC.md`](./NODE_RUN_PUBLIC.md).
- **Node-level Sybil resistance** — unsolved research problem, not a blocker
  for proving two-machine convergence.
- **Anything moving real value** — this is testnet/play-money only. Moving
  real money across machines is a legal/compliance project (AMF/FINTRAC), not
  a code change, and is explicitly not attempted here.
