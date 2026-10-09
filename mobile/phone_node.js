// ── MONEY — phone node indicator (tester feedback Oct 8, item C) ──────────────
//
// Decides what the "⛏️ PHONE NODE" row shows. It is ON only when a REAL node,
// running inside the app, reports ALL of:
//   • running === true
//   • relayConnected === true           (it is connected to the swarm relay)
//   • ≥ 1 distinct peer that sent it a valid signed message in the last 2 minutes
//   • lastValidatedAt within 2 minutes  (THIS phone itself checked a trade)
// Anything missing, stale, malformed or dated in the future → OFF.
//
// Today no node runs inside the app (App.js passes null), so every build shows
// OFF. The live signal will be the stats of the swarm node client once the swarm
// bridge runs it on the phone (node_client.js — protected; needs an explicit unlock).
//
// There is deliberately NO setter, flag or setting here: the only input is the
// stats object, and the only output is what to show.
// PURE module (no React Native), so test_tester_feedback_oct8.js executes it.
'use strict';

const FRESH_MS = 2 * 60 * 1000;

const OFF = Object.freeze({ on: false, peers: 0 });

// stats: { running, relayConnected, peers: [{ id, lastValidAt }], lastValidatedAt }
function nodeIndicator(stats, now) {
  if (!Number.isFinite(now) || !stats || typeof stats !== 'object') return OFF;
  if (stats.running !== true || stats.relayConnected !== true) return OFF;
  const fresh = (t) => Number.isFinite(t) && t <= now && now - t <= FRESH_MS;
  if (!fresh(stats.lastValidatedAt)) return OFF;
  if (!Array.isArray(stats.peers)) return OFF;
  const ids = new Set();
  for (const p of stats.peers) {
    if (p && typeof p.id === 'string' && p.id.length > 0 && fresh(p.lastValidAt)) ids.add(p.id);
  }
  if (ids.size < 1) return OFF;
  return { on: true, peers: ids.size };
}

module.exports = { nodeIndicator, FRESH_MS };
