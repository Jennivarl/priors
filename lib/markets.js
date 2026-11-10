// Prediction-market prices and resolutions from Polymarket's public API (no key needed).
// Polymarket markets are onchain and resolve through the UMA oracle, so they give us both
// a real market price when a pick is made and a result nobody in this app decides.
const BASE = 'https://gamma-api.polymarket.com';
const TAGS = { Football: 'soccer', NBA: 'nba', Tennis: 'tennis', NFL: 'nfl', Elections: 'politics' };
export const CATEGORIES = Object.keys(TAGS);

const parse = (s) => {
  try {
    return typeof s === 'string' ? JSON.parse(s) : s || [];
  } catch {
    return [];
  }
};

async function get(path) {
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`Polymarket ${res.status} on ${path.split('?')[0]}`);
  return res.json();
}

/** Kickoff for games ("2026-11-14 15:00:00+00"), otherwise the market end date; null if unknown. */
function startsAt(m) {
  const raw = m.gameStartTime ? m.gameStartTime.replace(' ', 'T').replace(/\+00$/, 'Z') : m.endDate;
  const t = raw ? new Date(raw) : null;
  return t && !Number.isNaN(t.getTime()) ? t.toISOString() : null;
}

/** Normalise a Gamma market into what the app needs. */
export function toQuote(m, eventTitle = '') {
  const outcomes = parse(m.outcomes);
  const prices = parse(m.outcomePrices).map(Number);
  const label = m.groupItemTitle || m.question;
  const yesNo = outcomes.length === 2 && outcomes.includes('Yes') && outcomes.includes('No');
  // What you can back: for Yes/No markets "Arsenal" or "Not Arsenal"; otherwise each named outcome.
  const options = yesNo
    ? [
        { side: 'Yes', subject: label, prob: prices[outcomes.indexOf('Yes')] },
        { side: 'No', subject: `Not ${label}`, prob: prices[outcomes.indexOf('No')] },
      ]
    : outcomes.map((o, i) => ({ side: o, subject: o, prob: prices[i] }));
  return {
    marketId: String(m.id),
    question: m.question,
    label,
    event: eventTitle || m.question,
    options,
    starts: startsAt(m),
    open: !m.closed && m.acceptingOrders !== false,
    closed: Boolean(m.closed),
    resolution: m.umaResolutionStatus || null,
    prices,
    outcomes,
  };
}

const cache = new Map();
/** Open yes/no markets for a category, soonest first, that have not started yet. */
export async function list(category, now = Date.now()) {
  const tag = TAGS[category];
  if (!tag) return [];
  const hit = cache.get(category);
  if (hit && now - hit.at < 5 * 60_000) return hit.items;
  const events = await get(`/events?active=true&closed=false&limit=40&tag_slug=${tag}&order=volume24hr&ascending=false`);
  const items = [];
  for (const e of events) {
    for (const m of e.markets || []) {
      if (m.sportsMarketType && m.sportsMarketType !== 'moneyline') continue;
      const q = toQuote(m, e.title);
      const priced = q.options.length >= 2 && q.options.every((o) => o.prob > 0.01 && o.prob < 0.99);
      if (!q.open || !q.starts || !priced || new Date(q.starts) <= new Date(now)) continue;
      items.push(q);
    }
  }
  items.sort((a, b) => a.starts.localeCompare(b.starts));
  const out = items.slice(0, 60);
  cache.set(category, { at: now, items: out });
  return out;
}

/** Fresh price for one side of one market, checked to be open and not started. */
export async function quote(marketId, side, now = Date.now()) {
  const q = toQuote(await get(`/markets/${encodeURIComponent(marketId)}`));
  if (!q.open) throw new Error('That market is closed for picks.');
  if (!q.starts || new Date(q.starts) <= new Date(now)) throw new Error('That event has already started. Picks must be logged before kickoff.');
  const option = q.options.find((o) => o.side === side);
  if (!option) throw new Error(`"${side}" is not an outcome of this market.`);
  if (!(option.prob > 0 && option.prob < 1)) throw new Error('That outcome has no usable price right now.');
  return { ...q, option };
}

/** Current state of a market, for settlement. */
export async function status(marketId) {
  return toQuote(await get(`/markets/${encodeURIComponent(marketId)}`));
}
