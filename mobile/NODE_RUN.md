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
| `GENESIS_FILE` | `genesis.json` next to `run_node.js` | founder set + default relay for the "download and run" path. Explicit env vars always win. Read fail-closed, **no `.bak` fallback** (genesis is read-only for the node — a planted `.bak` must never substitute a founder set), and founder entries are validated to the exact `M_` + 32-uppercase-hex address shape at boot. |
| `REDEEM_TIMEOUT_MS` | `30000` | how long a pending `{op:'redeem'}` waits for confirmed membership before `redeem-failed` |

## Self-serve join — invites, and what the quota is (and is NOT)

A member issues an invite with `{op:'invite', for:'M_…'}` — **`for` is
required**: invites are BOUND to the named redeemer address (the inviter asks
the friend for the address printed on their node's `ready` line first). The
inviter's signature covers the target, so only that address can ever produce a
seal that verifies in `fold()`. A newcomer joins with `{op:'redeem',
invite:…}`. The redeem ack is **honest**: `redeem-sent` on announce →
`redeemed` only once the address actually appears in the folded member set →
`redeem-failed` after `REDEEM_TIMEOUT_MS` if it never does (bad/used invite,
quota exhausted, or network unreachable). Redeeming an invite bound to a
different address errors immediately instead of timing out.

> ⚠️ **QUOTA HONESTY — read before trusting the ≤5 invite limit.** The
> engine's ≤5-invites quota is **per-ADDRESS rate limiting, NOT per-human
> Sybil resistance**. Every invited member gets its own fresh quota of 5, so
> one human can *chain* identities (invite their own second wallet, which
> invites a third, …) — bounded in speed, unbounded in depth, **by design on
> this path**. Per-HUMAN enforcement ("one human, one million") is the job of
> the Self-gate nullifier path (`self_gate.js` — passport-proven uniqueness),
> not the invite quota. The invite path is acceptable for a trusted
> friends/family beta precisely because the humans are known; it is **not**
> an open-launch gate.

> ✅ **INVITE CONTESTABILITY — CLOSED (bound invites, protocol change).**
> History: `test_selfserve_fixes.js` originally surfaced that `fold()`
> resolves two seals for the SAME invite by seal-id (hash) order, not
> arrival order — so a later rival seal that hash-sorted first could
> **retroactively displace the first member** (losing membership, funds,
> and history, identically on every node). Fixed by the bound-invites
> change in `swarm_engine.js`: `makeInvite(inviter, inviteId, target)`
> signs over the target address, and `fold()` verifies the invite
> signature against the sealer's own address — a seal from anyone but the
> bound target simply never verifies, regardless of hash order. This also
> closes interception: a stolen invite is unredeemable by the thief.
> **Clean break:** old unbound invites (signed without a target) are
> invalid — acceptable on a testnet with two founders and zero invited
> members. Proven by probe (2c-i), which pins the rival seal to the
> previously-winning hash order and shows it rejected.

> 🟡 **SEAL-ID POISONING — OPEN, logged Aug 8 2026, not fixed.** A seal's id is
> `sha("S:" + from + ":" + inviteId + ":" + sealSig)` — it does **not** cover
> `inviterSig`. So two seals that differ only in their invite signature share
> one id, and `relay.js`'s de-dup (`seen.has(m.tx.id)`) keeps whichever arrived
> **first**, forever. If the first seal for an invite carries a corrupt
> `inviterSig`, that invite id is permanently unredeemable: the corrected
> re-seal is silently dropped at the relay and never reaches any node's
> `fold()`. **Observed for real** on invite `ccc2d12df65af1c0` (seal id
> `d6f30b806d90128f`), whose `inviterSig` arrived 129 hex chars long after
> being transcribed off a screenshot — the seal sits in the live archive,
> verifiably rejected by every node, and cannot be superseded. Impact is a
> per-invite DoS, not a safety hole: no forged membership, no lost funds, and
> the inviter can always mint a **fresh invite id** (which is the standing
> workaround — never retry a poisoned id). A malicious relay client could also
> pre-empt an invite it has seen. Candidate fix (own bite, `swarm_engine.js` is
> protected): include `inviterSig` in the seal id hash — note that is a
> **consensus-visible change** (ids change, so it needs the same audit
> treatment as bound invites). Mitigated in the meantime by the redeem-time
> signature shape guard in `run_node.js`, which stops a mangled invite from
> ever being gossiped.

A node also emits `{type:'warning', code:'possible-fork'}` (observation only,
no protocol behavior) if the relay archive carries a founder seal that is not
in its own genesis founder set — the loudest available sign of a stale/wrong
`genesis.json` or a forked network.

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
