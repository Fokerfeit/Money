# Running a public MONEY relay for friends/family (testnet only)

This extends [`NODE_RUN.md`](./NODE_RUN.md) (the SSH-tunnel, two-machine
proof) to a relay that friends/family can reach **without an SSH tunnel**.
**⛔ Testnet only.** This never touches the mainnet money server, the
founding-wallet box, or `pm2` process `"money"`. Everything below targets
the **testnet box** (`testnet.moneyforeveryone.app`, `pm2` process
`"money-testnet"`, `/opt/money-testnet/`).

No code in `relay.js` changed to make this possible — `HOST` was always a
free-standing env var, and unset always meant "all interfaces." The
SSH-tunnel model (`NODE_RUN.md`) worked by **explicitly** setting
`HOST=127.0.0.1` to *restrict* the relay to loopback. This bite is the
opposite choice, plus turning on the three guards that were built and
tested in Bite 2 specifically for this moment (see `relay.js`'s own header
comment and NODE_RUN.md's "Optional guards" section).

## Recommended model: relay stays on loopback, nginx/Cloudflare expose it

There are two ways to make the relay reachable publicly. **Use the first
one** — it reuses the exact pattern already protecting the testnet HTTP API
(`https://testnet.moneyforeveryone.app`, SSL via Cloudflare + nginx),
rather than inventing a new one:

### Option A (recommended) — WSS reverse-proxy through the existing nginx/Cloudflare front door

```
friend's phone/laptop
   │  wss://testnet.moneyforeveryone.app/relay
   ▼
Cloudflare  (same edge already in front of the testnet API — DDoS/rate-limit protection, TLS)
   ▼
nginx on the testnet box  (same reverse-proxy pattern as the HTTP API, new location block)
   │  proxy_pass to 127.0.0.1:<relay-port>, Upgrade/Connection headers for WS
   ▼
relay.js  — HOST=127.0.0.1 (UNCHANGED from NODE_RUN.md — never directly exposed)
```

- The relay itself **keeps** `HOST=127.0.0.1` — it is never directly reachable from
  the internet, exactly like today. Only nginx talks to it, over loopback.
- Friends/family get `wss://` (encrypted) instead of raw `ws://`, for free,
  via the same TLS termination the API already uses.
- Cloudflare's edge (rate limiting, bot mitigation) sits in front of the relay
  exactly like it does for the API — no new attack surface class to reason about.
- **No new firewall port to open** — everything rides in on 443, which is
  already open.

Example nginx `location` block (add alongside the existing testnet API
`location /` block, same `server {}` for `testnet.moneyforeveryone.app`):

```nginx
location /relay {
    proxy_pass http://127.0.0.1:8080;   # relay.js's PORT
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;            # long-lived WS connections
}
```

⚠️ **This nginx block is a recommendation, not a verified live config** — I
have no SSH/WinSCP access to the testnet box, so I can't confirm the exact
`server {}` block nginx currently uses for the API, or whether Cloudflare's
proxy (orange-cloud) is on for the testnet subdomain. **Before wiring this
in, check the live nginx config for `testnet.moneyforeveryone.app` yourself
and mirror its existing `proxy_pass`/header pattern** rather than pasting
the block above verbatim — it's illustrative of the shape, not guaranteed
byte-for-byte compatible with what's actually running.

### Option B (not recommended) — bind the relay directly to a public port

```
friend's phone/laptop  →  ws://<testnet-box-ip>:8080  →  relay.js (HOST=0.0.0.0 or unset)
```

Set `HOST=0.0.0.0` (or leave `HOST` unset entirely — same effect) and open
a new firewall rule for the relay's `PORT`. This works, but:
- No TLS (plain `ws://`, not `wss://`) unless you also terminate TLS in
  `relay.js` itself (not built — out of scope here).
- No Cloudflare edge protection — a new, unprotected port sitting directly
  on the box's public IP.
- A new firewall rule to open and remember, instead of reusing 443.

Only use this if Option A turns out to be impractical on the current nginx
setup. The relay-side config is identical either way — the guards below
apply regardless of which option fronts it.

## The three guards — turn them ON for a public relay

All three are OPTIONAL and DEFAULT-OFF in `relay.js` (unset = today's
unguarded behavior, unchanged since Bite 1). For a relay reachable by
strangers — even accidentally, e.g. someone finding the URL — turn all
three on:

| Var | Recommended value | Reasoning |
|---|---|---|
| `MAX_FRAME_BYTES` | `65536` (64KB) | A signed gossip message (promise/vote/accept/seal) is a few hundred bytes of JSON + a signature. 64KB is >100x that — generous headroom for legitimate traffic, while still blocking a client from sending an arbitrarily large frame to burn memory/bandwidth. |
| `MAX_CONN_PER_SEC` | `20` | ⚠️ **Naming is misleading** — despite the name, this is NOT a new-connection-accept-rate limiter. It's a **per-connection message rate cap** (checked in `relay.js`'s `ws.on('message', ...)`, keyed by socket) — it stops one already-connected client from flooding the relay with messages. 20/sec per connection is well above what an honest node's real gossip traffic looks like, and low enough to blunt one misbehaving client. |
| `MAX_CONNECTIONS` | `30` | Hard cap on simultaneous sockets. Sized for a "friends/family beta" — expect maybe 5–15 real nodes; 30 gives 2x headroom for testing/reconnect churn without leaving the relay open to an unbounded number of held-open sockets from a scanner or curious stranger. Within the 20–50 range asked for; picked the low end since this is a beta with a known, small user set, not a public launch. |

```bash
cd mobile/swarm
HOST=127.0.0.1 PORT=8080 MAX_FRAME_BYTES=65536 MAX_CONN_PER_SEC=20 MAX_CONNECTIONS=30 DATA=relay_public.jsonl node relay.js
```

(`HOST=127.0.0.1` here assumes Option A — nginx fronts it. For Option B, use
`HOST=0.0.0.0` instead and open the firewall port.)

### Known gap — no true connection-attempt rate limit

None of the three guards limit **how fast new connections can be opened**
(as opposed to messages-per-second on an *already-open* connection, or the
simultaneous-connection cap). A rapid connect/disconnect flood that never
holds more than `MAX_CONNECTIONS` sockets open at once would not be
throttled by anything in `relay.js` itself. Under Option A, this is caught
by Cloudflare's edge (rate limiting on the proxied domain) — another reason
Option A is the recommended front door. Under Option B (direct exposure,
no Cloudflare), this gap is real and unmitigated. Not fixed here — flagging
it rather than silently leaving it undocumented.

## Verifying the mainnet box is untouched

This entire bite is testnet-config-only. To confirm before/after deploy:

```bash
# on the testnet box: only money-testnet's env changed
pm2 env money-testnet | grep -E 'HOST|MAX_FRAME_BYTES|MAX_CONN_PER_SEC|MAX_CONNECTIONS'

# on the mainnet box: must show NOTHING changed — pm2 process "money" has no
# relay.js env vars at all today (it doesn't run relay.js), and must still not.
pm2 env money | grep -E 'HOST|MAX_FRAME_BYTES|MAX_CONN_PER_SEC|MAX_CONNECTIONS'   # expect: no output
```

In the repo, `mobile/server.js` (the file mainnet's `"money"` process
actually runs) is untouched by this branch — see the byte-identity check in
`test_public_relay.js` (probe 4), which diffs against the pre-branch commit
and fails if any money/consensus/committee file changed.

## What to set on the live testnet box (via WinSCP terminal)

If going with **Option A** (recommended):
1. Add the nginx `location /relay { ... }` block (verify against the live
   config first — see the warning above), reload nginz (`nginx -t && systemctl reload nginx`
   or however this box manages it).
2. Update `money-testnet`'s pm2 env (or its `.env` / start script) to include:
   ```
   HOST=127.0.0.1
   MAX_FRAME_BYTES=65536
   MAX_CONN_PER_SEC=20
   MAX_CONNECTIONS=30
   ```
3. `pm2 restart money-testnet --update-env`
4. Friends/family point `run_node.js` at `RELAY_URL=wss://testnet.moneyforeveryone.app/relay`.

If going with **Option B**:
1. Open the firewall for the relay's `PORT` (e.g. `ufw allow 8080/tcp`, or
   the equivalent for whatever firewall this box actually runs — not
   verified here, ask/check on the box).
2. Same pm2 env as above but `HOST=0.0.0.0` instead of `127.0.0.1`.
3. Friends/family point `run_node.js` at `RELAY_URL=ws://<testnet-box-ip>:8080`.

## Explicitly out of scope for this bite

- **Mainnet exposure of any kind** — not attempted, not touched.
- **TLS termination inside `relay.js` itself** — Option A gets TLS for free
  via nginx/Cloudflare; Option B has none. Not building relay-side TLS.
- **True connection-attempt rate limiting inside `relay.js`** — see "Known
  gap" above; mitigated by Cloudflare under Option A only.
- **Node-level Sybil resistance** — unchanged, still unsolved research,
  still not a blocker for this transport-only bite.
- **Anything moving real value** — testnet/play-money only, same as every
  other Brick 3 bite.
