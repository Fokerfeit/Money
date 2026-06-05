/**
 * MONEY — Proof-of-Presence incentive engine (the invention, made runnable).
 *
 * No mining reward. Everyone starts a millionaire. The ONLY force is loss:
 * abandon the network and your pile bleeds — and that bled MONEY is handed to
 * the people who stayed. No new money is minted; it just flows from the absent
 * to the present. Loss-aversion (losing hurts ~2x more than gaining) becomes
 * the thing that holds the network up.
 *
 * Everything in P is a tunable knob — this is where you set "the line" between
 * punishing ABANDONMENT and punishing the normal life of a phone (sleep, dead
 * battery, a tunnel, a weekend off-grid).
 *
 *   node incentive_sim.js
 */

// ── THE KNOBS (tune these — they define the whole feel of MONEY) ─────────────
const P = {
  START_BALANCE:  1_000_000, // every verified human starts here
  DAYS:           120,       // how long we simulate
  NODES:          60,        // simulated phones

  GRACE_DAYS:     3,         // absence under this = NEVER punished (sleep, travel, low battery)
  // ── x² penalty curve:  bite% = QUAD_K × (days past grace)²  → very mellow, then BRUTAL
  QUAD_K:         0.3,       // steeper ramp — still a whisper on day 1 late, then it squares up fast
  MAX_DAILY_PCT:  25,        // savage cap: at full bite you lose a QUARTER of your stack PER DAY
  FLOOR:          0,         // BRUTAL: you can be wiped to nothing. Neglect = total loss (the BTC reality check)
  REDISTRIBUTE:   true,      // the careless fund the careful — those who held inherit what the quitters drop
};

// ── deterministic RNG so runs are reproducible ──────────────────────────────
let _s = 0xC0FFEE; const rnd = () => (_s = (_s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

// ── population: four kinds of humans ────────────────────────────────────────
// pPresent = chance they open the app on a given day; abandonDay = they vanish forever after this
const ARCHES = [
  { name: 'Committed (online ~daily)', share: 0.25, pPresent: 0.95, abandonDay: Infinity, col: '🟢' },
  { name: 'Casual   (every few days)', share: 0.45, pPresent: 0.45, abandonDay: Infinity, col: '🟡' },
  { name: 'Drifter  (quits ~day 21)',  share: 0.20, pPresent: 0.60, abandonDay: 21,       col: '🟠' },
  { name: 'Tourist  (sporadic, flaky)',share: 0.10, pPresent: 0.18, abandonDay: Infinity, col: '🔴' },
];

const nodes = [];
ARCHES.forEach((a, ai) => {
  const n = Math.round(a.share * P.NODES);
  for (let i = 0; i < n; i++) nodes.push({ id: nodes.length, arch: ai, bal: P.START_BALANCE, streak: 0 });
});

// ── the penalty curve (this exact function is what the real server would use) ─
// x² shape: flat-ish for the first days late, then curves up hard the longer you ghost.
function bitePct(streak) {
  const over = streak - P.GRACE_DAYS;
  if (over <= 0) return 0;                                   // within grace → untouched
  return Math.min(P.QUAD_K * over * over, P.MAX_DAILY_PCT);  // QUAD_K · over², capped
}
function dailyPenalty(streak, bal) {
  const pct = bitePct(streak);
  if (pct <= 0) return 0;
  const room = Math.max(0, bal - P.FLOOR);                   // never below the floor
  return Math.min(bal * pct / 100, room);
}

// ── show the x² penalty shape so you can FEEL it (mellow → aggressive) ───────
console.log(`\n  Penalty curve   bite% = ${P.QUAD_K} × (days past grace)²   (grace ${P.GRACE_DAYS}d, cap ${P.MAX_DAILY_PCT}%)`);
console.log('  absent │  bite%  │ shape');
for (let over = 1; over <= 13; over++) {
  const pct = Math.min(P.QUAD_K * over * over, P.MAX_DAILY_PCT);
  const bar = '█'.repeat(Math.max(0, Math.round(pct * 1.6)));
  const tag = over <= 3 ? 'mellow' : over <= 6 ? '…' : 'AGGRESSIVE';
  console.log(`  ${String(P.GRACE_DAYS + over).padStart(3)}d   │ ${pct.toFixed(2).padStart(5)}% │ ${bar} ${tag}`);
}

// ── run the world ────────────────────────────────────────────────────────────
const fmt = (n) => Math.round(n).toLocaleString('en-US');
console.log('\n  MONEY — Proof-of-Presence incentive engine');
console.log(`  ${P.NODES} phones · ${P.DAYS} days · grace ${P.GRACE_DAYS}d · start ${fmt(P.START_BALANCE)} each\n`);
console.log('  day | present | bled today | →redistributed | committed avg | drifter avg');
console.log('  ----+---------+------------+----------------+---------------+------------');

for (let day = 1; day <= P.DAYS; day++) {
  // who shows up today?
  const present = [];
  for (const nd of nodes) {
    const a = ARCHES[nd.arch];
    const here = day < a.abandonDay && rnd() < a.pPresent;
    if (here) { nd.streak = 0; present.push(nd); }
    else nd.streak++;
  }
  // bleed the absent
  let pool = 0;
  for (const nd of nodes) {
    if (nd.streak > 0) { const pen = dailyPenalty(nd.streak, nd.bal); nd.bal -= pen; pool += pen; }
  }
  // hand it to the present (no new money is created)
  if (P.REDISTRIBUTE && present.length) { const cut = pool / present.length; for (const nd of present) nd.bal += cut; }

  if (day % 15 === 0 || day === 1) {
    const avg = (ai) => { const g = nodes.filter(n => n.arch === ai); return g.reduce((s, n) => s + n.bal, 0) / g.length; };
    console.log(`  ${String(day).padStart(3)} | ${String(present.length).padStart(7)} | ${fmt(pool).padStart(10)} | ${(P.REDISTRIBUTE?'yes':'burned').padStart(14)} | ${fmt(avg(0)).padStart(13)} | ${fmt(avg(3-1)).padStart(11)}`);
  }
}

// ── the verdict ──────────────────────────────────────────────────────────────
console.log('\n  ── After ' + P.DAYS + ' days ─────────────────────────────────────────────');
ARCHES.forEach((a, ai) => {
  const g = nodes.filter(n => n.arch === ai);
  const avg = g.reduce((s, n) => s + n.bal, 0) / g.length;
  const delta = avg - P.START_BALANCE;
  const bar = (delta >= 0 ? '+' : '') + fmt(delta);
  console.log(`  ${a.col} ${a.name.padEnd(26)} avg ${fmt(avg).padStart(10)}  (${bar})`);
});
const committed = nodes.filter(n => n.arch === 0).reduce((s, n) => s + n.bal, 0) / nodes.filter(n => n.arch === 0).length;
const abandoned = nodes.filter(n => n.arch === 2).reduce((s, n) => s + n.bal, 0) / nodes.filter(n => n.arch === 2).length;
console.log('\n  THESIS: the people who held the network up ended RICHER than they started,');
console.log(`  funded entirely by the people who walked away. No money was minted.`);
const gap = abandoned >= 1 ? `${(committed / abandoned).toFixed(0)}× gap` : `abandoners WIPED TO ZERO — total reality check`;
console.log(`  Committed ${fmt(committed)}  vs  Abandoner ${fmt(abandoned)}  →  ${gap}.\n`);
