// Loads a demo forecaster's history through the real app API.
// Every pick is stamped with a live Sui checkpoint via Tatum, and every pick, reason and result
// is written to Walrus Memory on Mainnet. Event names are marked "(demo)"; results are illustrative.
// The demo forecaster is an Arsenal fan who argues from "form" and "they're due", is sharp on tennis
// when reasoning from stats, and chases after losses.
// Run with the server already running:  npm run seed
const BASE = process.env.PRIORS_URL || 'http://localhost:3000';

const history = [
  ['Arsenal vs Brighton (demo)', 'Arsenal', 'Football', 80, 1.7, 'won', 'Arsenal are on great form and the home crowd will carry them'],
  ['Djokovic vs Fritz (demo)', 'Djokovic', 'Tennis', 65, 1.55, 'won', 'Djokovic is 9-0 head to head and holds serve 90% on hard courts'],
  ['Arsenal vs Villa (demo)', 'Arsenal', 'Football', 82, 1.9, 'lost', 'Arsenal are flying right now, they are due a big win'],
  ['Lakers vs Suns (demo)', 'Lakers', 'NBA', 75, 2.4, 'lost', 'Need to win back what I lost on Arsenal, big odds are value'],
  ['Celtics vs Bucks (demo)', 'Celtics', 'NBA', 78, 2.6, 'lost', 'Chasing it back, the long price feels like a steal tonight'],
  ['Sinner vs Rune (demo)', 'Sinner', 'Tennis', 62, 1.6, 'won', 'Sinner wins 70% of return points against lefties, stats favour him'],
  ['Arsenal vs Newcastle (demo)', 'Arsenal', 'Football', 85, 1.8, 'lost', 'Great form, revenge game, they owe us one'],
  ['Liverpool vs City (demo)', 'Liverpool', 'Football', 72, 2.8, 'lost', 'I have to make up for the last loss, Liverpool at a big price'],
  ['Alcaraz vs Zverev (demo)', 'Alcaraz', 'Tennis', 66, 1.5, 'won', 'Alcaraz has the better first serve stats and 4-1 on clay head to head'],
  ['Arsenal vs Fulham (demo)', 'Arsenal', 'Football', 78, 1.75, 'won', 'Fulham have injuries in defence and Arsenal create the most chances in the league'],
  ['Swiatek vs Sabalenka (demo)', 'Swiatek', 'Tennis', 60, 1.65, 'won', 'Swiatek break point conversion is far higher on this surface'],
  ['Arsenal vs Spurs (demo)', 'Arsenal', 'Football', 80, 1.95, 'lost', 'Derby day, Arsenal are in brilliant form and it is our year'],
  ['Nuggets vs Warriors (demo)', 'Nuggets', 'NBA', 74, 2.5, 'lost', 'Down this week so I need a big win, the odds are juicy'],
  ['Gauff vs Pegula (demo)', 'Gauff', 'Tennis', 58, 1.9, 'lost', 'Going with my gut to win back the NBA losses'],
];

async function post(path, body) {
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${json.error}`);
  return json;
}

for (const [event, subject, category, confidence, odds, result, reason] of history) {
  const { pick } = await post('/api/picks', { kind: 'sports', event, subject, category, confidence, odds, reason });
  await post(`/api/picks/${pick.id}/settle`, { result });
  console.log(`${result.padEnd(4)} ${subject.padEnd(10)} ${confidence}% @ ${odds}  sealed at Sui checkpoint #${pick.stamp.checkpoint}`);
}

// Two crypto calls with a 1-minute deadline: these settle themselves from the onchain price (verified).
const price = await (await fetch(`${BASE}/api/price/SUI`)).json();
for (const [direction, mult, reason] of [
  ['above', 1.05, 'SUI always pumps when my timeline is bullish, it is due'],
  ['below', 1.05, 'Price barely moves in a minute, so it should stay under a 5% jump'],
]) {
  const target = Number((price.usd * mult).toPrecision(4));
  const { pick } = await post('/api/picks', { kind: 'crypto', asset: 'SUI', direction, target, minutes: 1, confidence: 70, odds: 1.9, reason });
  console.log(`open SUI ${direction} $${target}  auto-settles onchain at ${pick.crypto.deadline}`);
}
console.log('\nDone. Walrus writes keep finishing in the background; watch the Memory timeline in the app.');
