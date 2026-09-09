# DEPLOY — Self QR ignition on the TESTNET box

Branch: `self-gate/real-roundtrip-qr`. **Testnet only** (46.225.141.83, pm2 `money-testnet`, port 3001).
Never point this at mainnet or the founding wallet.

This is a runbook. Nothing here has been deployed or executed against the box — it
requires SSH access you hold and a real passport scan only Luca can do.

---

## What this adds

- `GET /ignite?wallet=M_…` → returns an ignition QR as SVG (read-only, mints nothing).
- `POST /ignite/self` → now **rejects a proof whose bound wallet ≠ the wallet being ignited**
  (the wallet is baked into the proof via `userDefinedData`; a swapped `wallet` field is refused).
- `SELF_MOCK` toggle: mock passports for drills, real passports in production.
- `SELF_CAPTURE_DIR` (optional): save each raw proof body for offline debugging.

## Prerequisites on the box

```bash
cd /opt/money-testnet          # the testnet checkout
git fetch && git checkout self-gate/real-roundtrip-qr
npm ci                         # installs qrcode-svg@1.1.0 + @selfxyz/common@0.0.9
```

## Environment (pm2 ecosystem or shell)

| Var | Value | Meaning |
|---|---|---|
| `SELF_GATE` | `1` | enable the Self ignition path |
| `SELF_MOCK` | `1` for T0–T2, **unset** for T3–T5 | mock passport vs real passport |
| `SELF_SCOPE` | `money-app` | must match the QR's scope |
| `SELF_ENDPOINT` | `https://<testnet-host>/ignite/self` | where the phone POSTs the proof |
| `SELF_CAPTURE_DIR` | e.g. `/opt/money-testnet/proof_capture` | optional; save raw proofs |
| `PORT` | `3001` | testnet port |

`SELF_ENDPOINT` **must be reachable from a phone on cellular** — it is the URL the Self
app calls back. Confirm the QR's endpoint resolves publicly before T1.

The boot log prints the active mode:
`[self-gate] ENABLED — POST /ignite/self, GET /ignite (mock passport | PRODUCTION (real passport))`.
Read it — it is your ground truth for which mode is live.

---

## T0–T5 protocol

Record `/tip` before and after each step. A rejected step must not move the tip.

| Step | Env | Action | Expect |
|---|---|---|---|
| **T0** | `SELF_GATE=1 SELF_MOCK=1` | boot; `GET /ignite?wallet=M_<A>` | boots; log says "mock passport"; SVG returned; note `/tip` |
| **T1** | (same) | Self app **mock passport**, scan QR for wallet **A** | A = 1,000,000; nullifier **N1** on disk; `/tip` advanced |
| **T2** | (same) | **same mock passport**, scan QR for wallet **B** | **REJECTED** (409 nullifier-used); B = 0; tip unchanged |
| **T3** | `SELF_MOCK` **unset**, restart | boot; log says "PRODUCTION"; **real passport**, wallet **C** | C = 1,000,000; nullifier **N2 ≠ N1**; tip advanced |
| **T4** | (same) | **same real passport**, wallet **D** | **REJECTED** (409); D = 0; tip unchanged |
| **T5** | test env | `NODE_ENV=test SELF_GATE_STUB=1 node probe_self_tamper.js` | all four attacks rejected, exit 0, tip unchanged |

### T0 quick checks
```bash
curl -s "http://127.0.0.1:3001/tip"
curl -s "http://127.0.0.1:3001/ignite?wallet=M_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" | head -c 60   # <?xml … <svg
```

### After T1 / T3 — confirm the mint
```bash
curl -s "http://127.0.0.1:3001/balance/<WALLET>"     # → 1000000
curl -s "http://127.0.0.1:3001/tip"                  # txs incremented
```

### T2 / T4 — confirm the rejection
The POST returns HTTP 409 `{"code":"nullifier-used"}`. Re-check `/balance/<B or D>` → 0
and `/tip` unchanged from the prior step.

> **Note on T3.** The mock/production switch also changes the Self endpoint the QR
> encodes (`staging_https` in mock, `https` in production) — a mock passport is not on
> the production identity tree, so T3 genuinely needs `SELF_MOCK` unset AND a real
> document. If T3 rejects a real scan, first confirm the boot log says PRODUCTION and
> that `SELF_SCOPE`/`SELF_ENDPOINT` match the QR.

---

## Rollback

`SELF_GATE` unset (or `git checkout` the prior branch) fully disables this path — the
invite-code faucet and every other route are untouched. The nullifier store on disk is
additive; leaving it in place is safe.
