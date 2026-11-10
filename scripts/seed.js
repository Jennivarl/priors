// Loads a demo forecaster's history through the real app API
// (each pick is stamped on Sui via Tatum and written to Walrus Memory).
// The demo forecaster is an Arsenal fan who is sharp on tennis and chases after losses.
// Run with the server already running:  npm run seed
const BASE = process.env.GUTCHECK_URL || 'http://localhost:3000';

const history = [
  ['Arsenal vs Brighton (demo)', 'Arsenal', 'Football', 80, 1.7, 'won'],
  ['Djokovic vs Fritz (demo)', 'Djokovic', 'Tennis', 65, 1.55, 'won'],
  ['Arsenal vs Villa (demo)', 'Arsenal', 'Football', 82, 1.9, 'lost'],
  ['Lakers vs Suns (demo)', 'Lakers', 'NBA', 75, 2.4, 'lost'],
  ['Celtics vs Bucks (demo)', 'Celtics', 'NBA', 78, 2.6, 'lost'],
  ['Sinner vs Rune (demo)', 'Sinner', 'Tennis', 62, 1.6, 'won'],
  ['Arsenal vs Newcastle (demo)', 'Arsenal', 'Football', 85, 1.8, 'lost'],
  ['Liverpool vs City (demo)', 'Liverpool', 'Football', 72, 2.8, 'lost'],
  ['Alcaraz vs Zverev (demo)', 'Alcaraz', 'Tennis', 66, 1.5, 'won'],
  ['Arsenal vs Fulham (demo)', 'Arsenal', 'Football', 78, 1.75, 'won'],
  ['Swiatek vs Sabalenka (demo)', 'Swiatek', 'Tennis', 60, 1.65, 'won'],
  ['Arsenal vs Spurs (demo)', 'Arsenal', 'Football', 80, 1.95, 'lost'],
  ['Nuggets vs Warriors (demo)', 'Nuggets', 'NBA', 74, 2.5, 'lost'],
  ['Gauff vs Pegula (demo)', 'Gauff', 'Tennis', 58, 1.9, 'lost'],
];

async function post(path, body) {
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${json.error}`);
  return json;
}

for (const [event, subject, category, confidence, odds, result] of history) {
  const { pick } = await post('/api/picks', { event, subject, category, confidence, odds });
  await post(`/api/picks/${pick.id}/settle`, { result });
  console.log(`${result.padEnd(4)} ${subject.padEnd(10)} ${confidence}% @ ${odds}  sealed at Sui checkpoint #${pick.stamp.checkpoint}`);
}
console.log('\nDone. Walrus writes keep finishing in the background; watch the Memory timeline in the app.');
