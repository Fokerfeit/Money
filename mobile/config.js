// ── MONEY Network Configuration ───────────────────────────────────────────
//
// BACKEND_IP: the local IP of the machine running server.js
//   → On Windows: open CMD and run  ipconfig
//   → On Mac/Linux: run  ifconfig
//   → Look for your Wi-Fi adapter's IPv4 address (e.g. 192.168.1.42)
//
// Both your phone AND server must be on the same Wi-Fi network.
// ─────────────────────────────────────────────────────────────────────────

export const BACKEND_URL        = 'https://api.moneyforeveryone.app';
export const FAUCET_ADDRESS     = 'FAUCET';
export const RESERVE_ADDRESS    = 'SWARM_RESERVE';
export const BASE_PENALTY       = 100;          // MONEY burned per disconnect infraction
export const DISCONNECT_GRACE_MS = 5 * 60 * 1000; // 5-minute grace period before penalty
