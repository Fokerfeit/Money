#!/usr/bin/env bash
# MONEY node launcher (Linux / macOS). Double-click or run: ./start-node.sh
# Non-technical friendly: checks Node.js, installs deps once, then runs your node.
set -e
cd "$(dirname "$0")"

echo ""
echo "  ================================"
echo "   MONEY  —  starting your node"
echo "  ================================"
echo ""

# 1) Node.js present?
if ! command -v node >/dev/null 2>&1; then
  echo "  ❌  Node.js is not installed."
  echo ""
  echo "     MONEY needs Node.js to run. It's free and takes 2 minutes:"
  echo "       → https://nodejs.org  (download the 'LTS' version, install, then"
  echo "         run this file again)."
  echo ""
  read -r -p "  Press Enter to close." _ || true
  exit 1
fi
echo "  ✓ Node.js found ($(node --version))"

# 2) Dependencies installed? (node_modules appears after the first run)
if [ ! -d node_modules ]; then
  echo "  … first run — installing the two small libraries MONEY needs (ws, tweetnacl)…"
  npm install --omit=dev --no-audit --no-fund
  echo "  ✓ libraries installed"
else
  echo "  ✓ libraries already installed"
fi

# 3) Optional overrides from a .env file (e.g. a different relay). Optional —
#    the default relay is already baked into swarm/genesis.json.
if [ -f .env ]; then
  echo "  ✓ loading overrides from .env"
  set -a; . ./.env; set +a
fi

# 4) Your wallet lives in identity.json in THIS folder (created on first run).
#    NODE_LABEL is deliberately left unset so the node uses that persisted wallet.
export IDENTITY_FILE="${IDENTITY_FILE:-$(pwd)/identity.json}"
unset NODE_LABEL

echo ""
echo "  Starting… your address will appear below on the {\"type\":\"ready\"…} line."
echo "  Your balance appears on {\"type\":\"status\"…} lines. Press Ctrl-C to stop."
echo "  ---------------------------------------------------------------------------"
echo ""

exec node swarm/run_node.js
