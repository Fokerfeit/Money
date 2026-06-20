// committee.js — pick THIS epoch's committee from whoever is online.
// Deterministic: every honest party computes the same committee for an epoch,
// drawn only from validators currently announced as online.
const { sha256 } = require('./crypto');

// onlinePool: [{ name, url }]  → returns { members:[{name,url}], quorum, epoch }
function selectCommittee(onlinePool, epoch, size) {
  if (onlinePool.length < size) throw new Error(`only ${onlinePool.length} validators online, need ${size}`);
  const ranked = [...onlinePool]
    .map(v => ({ v, score: sha256(`${epoch}:${v.name}`) }))
    .sort((a, b) => (a.score < b.score ? -1 : 1))
    .slice(0, size)
    .map(x => x.v);
  return { members: ranked, quorum: Math.floor(size / 2) + 1, epoch };
}

module.exports = { selectCommittee };
