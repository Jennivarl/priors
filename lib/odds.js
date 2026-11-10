// Real bookmaker odds from The Odds API (the-odds-api.com), so users cannot invent the price.
// Without ODDS_API_KEY the app still works, but odds are typed by the user and labelled "manual".
const BASE = 'https://api.the-odds-api.com/v4';
const SPORTS = {
  Football: ['soccer_epl', 'soccer_uefa_champs_league', 'soccer_spain_la_liga', 'soccer_italy_serie_a', 'soccer_germany_bundesliga'],
  NBA: ['basketball_nba'],
  Tennis: ['tennis_atp_paris_masters', 'tennis_wta_finals', 'tennis_atp_finals'],
  NFL: ['americanfootball_nfl'],
};
export const enabled = () => Boolean(process.env.ODDS_API_KEY);

const cache = new Map(); // sport -> { at, events }
const TTL_MS = 10 * 60_000; // free plan has a monthly quota, so cache for 10 minutes

async function eventsFor(sport) {
  const hit = cache.get(sport);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.events;
  const url = `${BASE}/sports/${sport}/odds?regions=uk,eu&markets=h2h&oddsFormat=decimal&apiKey=${encodeURIComponent(process.env.ODDS_API_KEY)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (res.status === 404 || res.status === 422) return []; // sport not in season / unknown key
  if (!res.ok) throw new Error(`Odds API ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const events = await res.json();
  cache.set(sport, { at: Date.now(), events });
  return events;
}

/** Upcoming events for a category, with the best available decimal price per outcome. */
export async function upcoming(category) {
  if (!enabled()) throw new Error('ODDS_API_KEY is not set, so odds are manual.');
  const out = [];
  for (const sport of SPORTS[category] || []) {
    for (const ev of await eventsFor(sport)) {
      if (new Date(ev.commence_time) < new Date()) continue; // picks must be logged before kickoff
      const best = {};
      for (const b of ev.bookmakers || []) {
        for (const m of b.markets || []) {
          if (m.key !== 'h2h') continue;
          for (const o of m.outcomes) if (!best[o.name] || o.price > best[o.name].price) best[o.name] = { price: o.price, bookmaker: b.title };
        }
      }
      if (Object.keys(best).length) out.push({ id: ev.id, sport, event: `${ev.home_team} vs ${ev.away_team}`, commence: ev.commence_time, outcomes: best, bookmakers: (ev.bookmakers || []).length });
    }
  }
  return out.sort((a, b) => a.commence.localeCompare(b.commence)).slice(0, 40);
}

/** Look up the live price for one outcome of one event, to stop users typing a price. */
export async function priceFor(category, eventId, outcome) {
  const ev = (await upcoming(category)).find((e) => e.id === eventId);
  if (!ev) throw new Error('That event is no longer open for picks (it may have started).');
  const o = ev.outcomes[outcome];
  if (!o) throw new Error(`No bookmaker price for "${outcome}" in ${ev.event}.`);
  return { odds: o.price, bookmaker: o.bookmaker, event: ev.event, commence: ev.commence, eventId };
}
