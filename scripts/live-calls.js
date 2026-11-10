// Real, verified history: places short crypto calls whose results come from onchain pool prices
// (Cetus on Sui Mainnet via Tatum). Nobody, including the user, decides these outcomes.
// Two reasoning styles are mixed on purpose (data-driven vs hype), so the coach can learn which one works.
// Run with the server running:  npm run live-calls
const BASE = process.env.GUTCHECK_URL || 'http://localhost:3000';

const calls = [
  ['SUI', 'above', 1.0005, 3, 72, 1.9, 'SUI always pumps when my timeline is bullish, it is due a move'],
  ['SUI', 'below', 1.0015, 3, 64, 1.8, 'Spot is flat and liquidity is deep, a 0.15% jump in 3 minutes is unlikely'],
  ['WAL', 'above', 1.0005, 4, 75, 1.9, 'WAL is going to rip, everyone is talking about Walrus today'],
  ['WAL', 'below', 1.003, 4, 62, 1.7, 'WAL rarely moves 0.3% in a few minutes, mean reversion favours under'],
  ['SUI', 'above', 1.001, 5, 78, 2.0, 'Feels like breakout time, momentum is building, it owes us'],
  ['SUI', 'below', 1.002, 5, 63, 1.75, 'Short window and low volatility, price should stay under a 0.2% move'],
  ['WAL', 'above', 1.001, 6, 74, 2.0, 'Big week for Walrus, it has to go up'],
  ['WAL', 'below', 1.004, 6, 61, 1.7, 'A 0.4% move in 6 minutes is outside normal range for this pool'],
];

async function post(path, body) {
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${json.error}`);
  return json;
}

for (const [asset, direction, mult, minutes, confidence, odds, reason] of calls) {
  const price = await (await fetch(`${BASE}/api/price/${asset}`)).json();
  const target = Number((price.usd * mult).toPrecision(5));
  const { pick } = await post('/api/picks', { kind: 'crypto', asset, direction, target, minutes, confidence, odds, reason });
  console.log(`${asset} ${direction} $${target} (now $${price.usd.toFixed(5)}) settles ${pick.crypto.deadline.slice(11, 19)} UTC, sealed #${pick.stamp.checkpoint}`);
}
console.log('\nAll calls placed. They settle themselves from onchain prices over the next few minutes.');
