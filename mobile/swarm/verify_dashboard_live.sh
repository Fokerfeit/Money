#!/bin/bash
# verify_dashboard_live.sh — READ-ONLY checks for the founder node + its 127.0.0.1 dashboard.
# Run ON the testnet box:   bash verify_dashboard_live.sh [systemd-unit-name]
# Changes nothing. Exit 0 = all PASS, 1 = something FAILED.
#
# Config (override with env vars if your paths differ):
NODE_DIR="${NODE_DIR:-/opt/money-testnet-swarm}"      # run_node.js + genesis.json live here
FIFO="${FIFO:-$NODE_DIR/run/money.fifo}"
PORT="${DASH_PORT:-7070}"
UNIT="${1:-${UNIT:-}}"

pass=0; fail=0; warn=0
PASS(){ printf '  PASS  %s\n' "$1"; pass=$((pass+1)); }
FAIL(){ printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }
WARN(){ printf '  WARN  %s\n' "$1"; warn=$((warn+1)); }
INFO(){ printf '  info  %s\n' "$1"; }
json(){ node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const v=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],o);console.log(v===undefined?"":(typeof v==="object"?JSON.stringify(v):String(v)))}catch(e){console.log("")}})' "$1"; }

echo "== founder node dashboard check  $(date '+%Y-%m-%d %H:%M:%S')  node_dir=$NODE_DIR port=$PORT"

# ── 1. systemd ────────────────────────────────────────────────────────────────
if ! command -v systemctl >/dev/null 2>&1; then
  INFO "no systemctl on this machine — skipping service checks"
else
  if [ -z "$UNIT" ]; then
    cands=$(systemctl list-units --type=service --all --no-legend 2>/dev/null | awk '{print $1}' | grep -iE 'money|swarm|founder' | grep -vE 'relay|testnet\.service' || true)
    n=$(echo "$cands" | grep -c . || true)
    if [ "$n" = "1" ]; then UNIT=$cands; INFO "auto-detected unit: $UNIT"; else WARN "could not auto-detect the node's unit (candidates: $(echo $cands)) — pass it as arg 1"; fi
  fi
  if [ -n "$UNIT" ]; then
    if [ "$(systemctl is-active "$UNIT" 2>/dev/null)" = "active" ]; then PASS "systemd: $UNIT is active"; else FAIL "systemd: $UNIT is NOT active ($(systemctl is-active "$UNIT" 2>/dev/null))"; fi
    MAINPID=$(systemctl show -p MainPID --value "$UNIT" 2>/dev/null)
    if [ -n "$MAINPID" ] && [ "$MAINPID" != "0" ] && [ -d /proc/$MAINPID ]; then
      comm=$(cat /proc/$MAINPID/comm 2>/dev/null); wchan=$(cat /proc/$MAINPID/wchan 2>/dev/null)
      if [ "$comm" = "node" ]; then PASS "MainPID $MAINPID is node (the node has actually started)";
      else FAIL "MainPID $MAINPID is '$comm' (wchan=$wchan) — node has NOT started: the service is parked in the FIFO open (dormant-launch bug); fix ExecStart to open the FIFO read-write (0<>)"; fi
      fd0=$(readlink /proc/$MAINPID/fd/0 2>/dev/null); INFO "MainPID stdin -> ${fd0:-<closed>}"
    else FAIL "systemd: no live MainPID for $UNIT"; fi
    es=$(systemctl show -p ExecStart --value "$UNIT" 2>/dev/null)
    case "$es" in
      *"0<>"*|*"<>"*) PASS "ExecStart opens the FIFO read-write (no dormant start, no EOF after a writer closes)";;
      *"<"*)          WARN "ExecStart uses plain '< fifo': node stays DORMANT until the first write, and goes DEAF after the first writer closes (every later echo > fifo is silently dropped)";;
      *)              INFO "ExecStart: $es";;
    esac
  fi
fi

# ── 2. FIFO ───────────────────────────────────────────────────────────────────
if [ -p "$FIFO" ]; then PASS "FIFO exists: $FIFO"; else WARN "FIFO not found at $FIFO (set FIFO=... if it lives elsewhere)"; fi

# ── 3. dashboard /state ───────────────────────────────────────────────────────
body=$(curl -s -m 5 "http://127.0.0.1:$PORT/state" 2>/dev/null); rc=$?
if [ $rc -ne 0 ] || [ -z "$body" ]; then
  FAIL "GET http://127.0.0.1:$PORT/state unreachable (curl exit $rc) — dashboard not listening (node not started, or port taken: check stderr/journal for 'dashboard NOT started')"
else
  PASS "GET /state answered"
  ready=$(echo "$body" | json ready); addr=$(echo "$body" | json address); members=$(echo "$body" | json members)
  conn=$(echo "$body" | json connection); hash=$(echo "$body" | json hash); up=$(echo "$body" | json uptimeSec)
  INFO "address=$addr members=$members hash=$hash connection=$conn uptimeSec=$up"
  [ "$ready" = "true" ] && PASS "ready:true" || FAIL "ready is '$ready' — no ledger status yet (node never reached the relay?)"
  if [ "$ready" != "true" ] && echo "$body" | grep -q '"balances"'; then FAIL "not-ready response contains a balances key (fabricated zeros)"; fi
  if [ -f "$NODE_DIR/genesis.json" ]; then
    if node -e 'const g=JSON.parse(require("fs").readFileSync(process.argv[1]));process.exit(g.founders.includes(process.argv[2])?0:1)' "$NODE_DIR/genesis.json" "$addr"; then
      PASS "address $addr is a genesis founder"; else FAIL "address $addr is NOT in $NODE_DIR/genesis.json founders"; fi
  else WARN "no $NODE_DIR/genesis.json — cannot check founder membership"; fi
  if [ -n "$members" ] && [ "$members" -ge 1 ] 2>/dev/null; then PASS "members=$members (>=1)"; else FAIL "members='$members' (<1 or missing)"; fi
  [ "$conn" = "connected" ] && PASS "connection:connected" || FAIL "connection is '$conn' (expected connected)"
fi

# ── 4. bind: 127.0.0.1 only ───────────────────────────────────────────────────
if command -v ss >/dev/null 2>&1; then
  l=$(ss -ltnH "sport = :$PORT" 2>/dev/null | awk '{print $4}')
else
  hex=$(printf '%04X' "$PORT")
  l=$(awk -v p="$hex" '$4=="0A"{split($2,a,":");if(a[2]==p)print a[1]}' /proc/net/tcp /proc/net/tcp6 2>/dev/null | sed 's/^0100007F$/127.0.0.1/;s/^00000000$/0.0.0.0/')
fi
if [ -z "$l" ]; then FAIL "nothing is listening on :$PORT"
elif echo "$l" | grep -qvE '^127\.0\.0\.1'; then FAIL "port $PORT is bound on a non-loopback address: $(echo $l)"
else PASS "port $PORT bound to 127.0.0.1 only ($(echo $l))"; fi
pub=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -n "$pub" ]; then
  if curl -s -m 3 -o /dev/null "http://$pub:$PORT/state" 2>/dev/null; then FAIL "dashboard REACHABLE via $pub:$PORT (should be loopback-only)"; else PASS "not reachable via $pub:$PORT"; fi
fi

# ── 5. read-only + traversal sanity ──────────────────────────────────────────
code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -d '{"op":"status"}' "http://127.0.0.1:$PORT/state" 2>/dev/null)
[ "$code" = "405" ] && PASS "POST /state -> 405" || FAIL "POST /state -> '$code' (expected 405)"
code=$(curl -s -m 5 --path-as-is -o /tmp/_vd_body -w '%{http_code}' "http://127.0.0.1:$PORT/../identity.json" 2>/dev/null)
if [ "$code" = "404" ] && ! grep -q '"sk"' /tmp/_vd_body 2>/dev/null; then PASS "GET /../identity.json -> 404, no key material"; else FAIL "traversal probe returned $code"; fi
rm -f /tmp/_vd_body

echo "== result: $pass PASS, $fail FAIL, $warn WARN"
[ $fail -eq 0 ]
