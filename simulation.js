const FAUCET_START        = 1_000_000;
const DECAY_RATE          = 0.8;
const USERS_PER_MILLION   = 1_000_000;
const VALIDATOR_THRESHOLD = 500;
const BASE_PENALTY        = 100;
const DISCONNECT_RATE     = 0.04;
const TX_PER_USER_DAY     = 2.1;
const WORLD_POP           = 8_200_000_000;

function faucetReward(totalUsers) {
  const millions = Math.floor(totalUsers / USERS_PER_MILLION);
  let reward = FAUCET_START;
  for (let i = 0; i < millions; i++) reward *= DECAY_RATE;
  return Math.max(Math.floor(reward), 1);
}

function fmt(n) {
  if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9)  return (n / 1e9).toFixed(2)  + 'B';
  if (n >= 1e6)  return (n / 1e6).toFixed(2)  + 'M';
  if (n >= 1e3)  return (n / 1e3).toFixed(1)  + 'K';
  return Math.floor(n).toString();
}

function fmtMoney(n) {
  return Math.floor(n).toLocaleString() + ' MONEY';
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function dateStr(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}

function div(c = '═', w = 72) { return c.repeat(w); }

function simulatePhase(name, startUsers, endUsers, days, startDate,
                       prevSupply = 0, prevPenalties = 0, prevTxs = 0) {
  console.log('\n' + div());
  console.log(`  PHASE: ${name}`);
  console.log(`  Period : ${dateStr(startDate)} → ${dateStr(addDays(startDate, days))}`);
  console.log(`  Users  : ${fmt(startUsers)} → ${fmt(endUsers)}`);
  console.log(div());

  let totalSupply    = prevSupply;
  let totalPenalties = prevPenalties;
  let totalTxs       = prevTxs;
  let currentUsers   = startUsers;
  let millionaires   = 0;

  const growthPerDay = (endUsers - startUsers) / Math.max(days, 1);
  const keyDays = new Set([0, Math.floor(days/4), Math.floor(days/2), Math.floor(3*days/4), days-1]);
  const rows = [];

  for (let day = 0; day < days; day++) {
    const newUsers = Math.floor(growthPerDay) + (day === 0 && days === 1 ? endUsers - startUsers : 0);

    let daySupply = 0;
    // Fast path: when reward is already at floor (1 MONEY), skip per-user loop
    const rewardNow = faucetReward(currentUsers);
    if (rewardNow <= 1 && faucetReward(currentUsers + newUsers) <= 1) {
      daySupply = newUsers * 1;
      currentUsers += newUsers;
    } else {
      for (let u = 0; u < newUsers; u++) {
        const reward = faucetReward(currentUsers);
        daySupply += reward;
        if (reward >= 1_000_000) millionaires++;
        currentUsers++;
      }
    }

    const rand = () => 0.85 + Math.random() * 0.30;
    const dayTxs = Math.floor(currentUsers * TX_PER_USER_DAY * rand());
    totalTxs += dayTxs;

    // Penalty applies only to the active validator pool — not all users.
    // Pool grows with sqrt(users): at 8B users ~180K validators, not 8B.
    const validatorPool = Math.min(currentUsers, VALIDATOR_THRESHOLD + Math.floor(Math.sqrt(currentUsers) * 2));
    const disconnects = Math.floor(validatorPool * DISCONNECT_RATE * (0.5 + Math.random()));
    const dayPenalties = disconnects * BASE_PENALTY * 2;
    totalPenalties += dayPenalties;
    daySupply -= dayPenalties;
    totalSupply += daySupply;

    if (keyDays.has(day)) {
      rows.push({
        day: day + 1,
        date: addDays(startDate, day).toLocaleDateString('en-US', { month:'short', day:'2-digit' }),
        users: currentUsers,
        reward: faucetReward(currentUsers),
        supply: totalSupply,
        dayTxs,
        millionaires
      });
    }
  }

  console.log(
    `\n  ${'Day'.padEnd(6)} ${'Date'.padEnd(10)} ${'Users'.padEnd(12)} ${'New Reward'.padEnd(18)}` +
    ` ${'Circulating Supply'.padEnd(22)} ${'Daily TXs'.padEnd(12)} Millionaires`
  );
  console.log(`  ${'-'.repeat(6)} ${'-'.repeat(10)} ${'-'.repeat(12)} ${'-'.repeat(18)} ${'-'.repeat(22)} ${'-'.repeat(12)} ${'-'.repeat(12)}`);

  for (const r of rows) {
    console.log(
      `  ${String(r.day).padEnd(6)} ${r.date.padEnd(10)} ${fmt(r.users).padEnd(12)}` +
      ` ${fmtMoney(r.reward).padEnd(18)} ${fmt(r.supply).padEnd(22)}` +
      ` ${fmt(r.dayTxs).padEnd(12)} ${fmt(r.millionaires)}`
    );
  }

  const threshold = currentUsers >= VALIDATOR_THRESHOLD
    ? '✅ THRESHOLD MET'
    : `⚠️  ${currentUsers}/${VALIDATOR_THRESHOLD} nodes (below threshold)`;

  console.log(`\n  ┌─ PHASE SUMMARY ${'─'.repeat(54)}┐`);
  console.log(`  │  Total supply in circulation : ${fmt(totalSupply)} MONEY`);
  console.log(`  │  Total transactions processed: ${fmt(totalTxs)}`);
  console.log(`  │  Penalties burned (bad nodes) : ${fmt(totalPenalties)} MONEY`);
  console.log(`  │  Network millionaires created : ${fmt(millionaires)}`);
  console.log(`  │  Swarm validator status       : ${threshold}`);
  console.log(`  └${'─'.repeat(69)}┘`);

  return { users: currentUsers, supply: totalSupply, penalties: totalPenalties, txs: totalTxs, millionaires };
}

// ── RUN ────────────────────────────────────────────────────────────────────
console.log('\n' + '█'.repeat(72));
console.log('');
console.log('   ███╗   ███╗ ██████╗ ███╗   ██╗███████╗██╗   ██╗');
console.log('   ████╗ ████║██╔═══██╗████╗  ██║██╔════╝╚██╗ ██╔╝');
console.log('   ██╔████╔██║██║   ██║██╔██╗ ██║█████╗   ╚████╔╝ ');
console.log('   ██║╚██╔╝██║██║   ██║██║╚██╗██║██╔══╝    ╚██╔╝  ');
console.log('   ██║ ╚═╝ ██║╚██████╔╝██║ ╚████║███████╗   ██║   ');
console.log('   ╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═══╝╚══════╝   ╚═╝   ');
console.log('');
console.log('        PROOF OF SWARM — GLOBAL ADOPTION SIMULATION');
console.log('                 Money. For Everyone. Forever.');
console.log('█'.repeat(72));

const start = new Date('2026-05-09');
let state = { users: 0, supply: 0, penalties: 0, txs: 0, millionaires: 0 };

const phases = [
  ['WEEK 1 — First Contact',         3,               3,             7,    0],
  ['MONTH 1 — Early Adopters',       3,               19,            30,   7],
  ['MONTH 2-3 — Word of Mouth',      19,              500,           60,   37],
  ['MONTH 4-6 — Swarm Goes Live',    500,             10_000,        90,   97],
  ['YEAR 1 — City Networks',         10_000,          250_000,       183,  187],
  ['YEAR 2 — National Scale',        250_000,         5_000_000,     365,  370],
  ['YEAR 3 — Continental Wave',      5_000_000,       100_000_000,   365,  735],
  ['YEAR 4 — Global Majority',       100_000_000,     1_000_000_000, 365,  1100],
  ['YEAR 5 — FULL GLOBAL ADOPTION',  1_000_000_000,   WORLD_POP,    365,  1465],
];

for (const [name, uStart, uEnd, days, offset] of phases) {
  const result = simulatePhase(
    name, uStart, uEnd, days,
    addDays(start, offset),
    state.supply, state.penalties, state.txs
  );
  state.users      = result.users;
  state.supply     = result.supply;
  state.penalties  = result.penalties;
  state.txs        = result.txs;
  state.millionaires += result.millionaires;
}

// ── FINAL REPORT ────────────────────────────────────────────────────────
console.log('\n' + div('═'));
console.log('  🌍  FINAL STATE — FULL GLOBAL ADOPTION');
console.log(div('═'));
console.log(`  Date              : ${dateStr(addDays(start, 1830))}`);
console.log(`  Total users       : ${fmt(state.users)} / ${fmt(WORLD_POP)} world population`);
console.log(`  Adoption rate     : ${(state.users / WORLD_POP * 100).toFixed(1)}%`);
console.log(`  Circulating supply: ${fmt(state.supply)} MONEY`);
console.log(`  Total TXs ever    : ${fmt(state.txs)}`);
console.log(`  Penalties burned  : ${fmt(state.penalties)} MONEY`);
console.log(`  Millionaires made : ${fmt(state.millionaires)}`);
console.log(`  New user reward   : ${fmtMoney(faucetReward(state.users))} (decayed from 1,000,000)`);
console.log(`  Active nodes      : ${fmt(state.users)} phones worldwide`);
console.log('');
console.log(`  ┌${'─'.repeat(69)}┐`);
console.log(`  │${'PROOF OF SWARM — MISSION COMPLETE'.padStart(51).padEnd(69)}│`);
console.log(`  │${' '.repeat(69)}│`);
console.log(`  │${'  ✅ Zero banks'.padEnd(69)}│`);
console.log(`  │${'  ✅ Zero mining rigs'.padEnd(69)}│`);
console.log(`  │${'  ✅ Zero CEOs'.padEnd(69)}│`);
console.log(`  │${'  ✅ Zero pre-mine'.padEnd(69)}│`);
console.log(`  │${'  ✅ ' + fmt(state.millionaires) + ' millionaires created from nothing'.padEnd(69)}│`);
console.log(`  │${'  ✅ Every phone on Earth = a node'.padEnd(69)}│`);
console.log(`  │${' '.repeat(69)}│`);
console.log(`  │${'    M O N E Y.  F O R  E V E R Y O N E.  F O R E V E R.'.padEnd(69)}│`);
console.log(`  └${'─'.repeat(69)}┘`);
console.log('');
