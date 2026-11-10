// The coach: learns how YOUR gut is wrong, from your own settled picks.
// Pure functions, no I/O, so it is easy to test and reason about.

const pct = (x) => `${Math.round(x * 100)}%`;
const pts = (x) => `${Math.round(Math.abs(x) * 100)} pts`;
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const won = (p) => (p.status === 'won' ? 1 : 0);
// Shrink small samples toward zero so 2 lucky picks don't become "a bias".
const shrink = (bias, n, k = 3) => bias * (n / (n + k));

export const settled = (picks) => picks.filter((p) => p.status === 'won' || p.status === 'lost');

function group(picks, keyFn) {
  const m = new Map();
  for (const p of picks) {
    const k = keyFn(p);
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(p);
  }
  return m;
}

function stat(ps) {
  const conf = mean(ps.map((p) => p.confidence));
  const hit = mean(ps.map(won));
  return { n: ps.length, conf, hit, bias: conf - hit };
}

/** For each pick, was the most recent settled pick before it a loss? (tilt detection) */
function afterLossFlags(picks) {
  const done = settled(picks).slice().sort((a, b) => a.settledAt.localeCompare(b.settledAt));
  return (p) => {
    const prev = done.filter((d) => d.id !== p.id && d.settledAt < p.createdAt).at(-1);
    return prev ? prev.status === 'lost' : false;
  };
}

/** Build the bias fingerprint: everything the coach has learned about you. */
export function fingerprint(picks) {
  const done = settled(picks);
  const overall = stat(done);
  const insights = [];

  if (done.length >= 3) {
    insights.push({
      id: 'overall',
      kind: 'calibration',
      title: overall.bias > 0.04 ? 'You are overconfident' : overall.bias < -0.04 ? 'You are underconfident' : 'You are well calibrated overall',
      detail: `Average confidence ${pct(overall.conf)}, actual hit rate ${pct(overall.hit)} across ${overall.n} picks.`,
      bias: overall.bias,
      n: overall.n,
    });
  }

  for (const [subject, ps] of group(done, (p) => p.subject)) {
    const s = stat(ps);
    if (s.n < 3 || Math.abs(s.bias) < 0.1) continue;
    insights.push({
      id: `subject:${subject}`,
      kind: 'subject',
      key: subject,
      title: s.bias > 0 ? `You overrate ${subject}` : `You underrate ${subject}`,
      detail: `You give ${subject} ${pct(s.conf)} on average. They came through ${pct(s.hit)} of the time (${s.n} picks).`,
      bias: s.bias,
      n: s.n,
    });
  }

  for (const [category, ps] of group(done, (p) => p.category)) {
    const s = stat(ps);
    if (s.n < 3) continue;
    const sharp = Math.abs(s.bias) < 0.08;
    insights.push({
      id: `category:${category}`,
      kind: 'category',
      key: category,
      title: sharp ? `You are sharp on ${category}` : s.bias > 0 ? `You are overconfident on ${category}` : `You undersell yourself on ${category}`,
      detail: `${category}: confidence ${pct(s.conf)} vs hit rate ${pct(s.hit)} (${s.n} picks).`,
      bias: s.bias,
      n: s.n,
    });
  }

  const isAfterLoss = afterLossFlags(picks);
  const tilt = done.filter(isAfterLoss);
  const calm = done.filter((p) => !isAfterLoss(p));
  if (tilt.length >= 2 && calm.length >= 2) {
    const t = stat(tilt);
    const c = stat(calm);
    const longer = mean(tilt.map((p) => p.odds)) - mean(calm.map((p) => p.odds));
    if (t.bias - c.bias > 0.1) {
      insights.push({
        id: 'tilt',
        kind: 'tilt',
        title: 'You chase after a loss',
        detail: `Right after a loss you hit ${pct(t.hit)} (vs ${pct(c.hit)} normally)${longer > 0.2 ? ` and take longer odds (+${longer.toFixed(2)})` : ''}. ${t.n} picks.`,
        bias: t.bias - c.bias,
        n: t.n,
      });
    }
  }

  // When you disagree with the bookmaker by 10+ points, who was right?
  const disagree = done.filter((p) => Math.abs(p.confidence - p.marketProb) >= 0.1);
  if (disagree.length >= 3) {
    const youRight = disagree.filter((p) => (p.confidence > p.marketProb) === (p.status === 'won')).length;
    insights.push({
      id: 'vs-market',
      kind: 'market',
      title: youRight / disagree.length >= 0.5 ? 'When you fight the market, you often win' : 'When you fight the market, the market wins',
      detail: `You disagreed with the market by 10+ points ${disagree.length} times and were right ${youRight} times.`,
      bias: 0.5 - youRight / disagree.length,
      n: disagree.length,
    });
  }

  insights.sort((a, b) => Math.abs(b.bias) * Math.sqrt(b.n) - Math.abs(a.bias) * Math.sqrt(a.n));
  return { overall, insights, settledCount: done.length };
}

/** Calibration curve: stated confidence vs actual hit rate, per 10-point bucket. */
export function calibration(picks) {
  const buckets = [];
  for (let lo = 0.5; lo < 1; lo += 0.1) {
    const ps = settled(picks).filter((p) => p.confidence >= lo && p.confidence < lo + 0.1 + (lo >= 0.9 ? 0.01 : 0));
    if (ps.length) buckets.push({ from: lo, to: lo + 0.1, ...stat(ps) });
  }
  return buckets;
}

/**
 * Reasoning echo: past settled picks whose REASON means the same thing as the new one
 * (found by Walrus Memory semantic recall). How did that line of thinking work out?
 * @param matches [{ pick, distance, reason }] settled picks only, closest first
 */
export function reasoningEcho(matches) {
  if (!matches.length) return null;
  const s = stat(matches.map((m) => m.pick));
  return {
    n: s.n,
    won: matches.filter((m) => m.pick.status === 'won').length,
    conf: s.conf,
    hit: s.hit,
    bias: s.bias,
    examples: matches.slice(0, 3).map((m) => ({ reason: m.reason, subject: m.pick.subject, status: m.pick.status, similarity: Math.max(0, 1 - m.distance) })),
  };
}

/**
 * The second opinion for a NEW pick, before you commit.
 * Starts from your gut, then subtracts what your history says you get wrong.
 * @param echo optional result of reasoningEcho() for the draft's reason
 */
export function secondOpinion(picks, draft, echo = null) {
  const done = settled(picks);
  const reasons = [];
  let adjusted = draft.confidence;

  const bySubject = done.filter((p) => p.subject === draft.subject);
  const byCategory = done.filter((p) => p.category === draft.category);
  let specific = false;

  if (bySubject.length >= 2) {
    const s = stat(bySubject);
    const adj = shrink(s.bias, s.n);
    if (Math.abs(adj) >= 0.02) {
      adjusted -= adj;
      specific = true;
      reasons.push(`${adj > 0 ? 'You overrate' : 'You underrate'} ${draft.subject} by ${pts(s.bias)} (${s.n} past picks): ${adj > 0 ? '−' : '+'}${pts(adj)}`);
    }
  }
  if (byCategory.length >= 3) {
    const s = stat(byCategory);
    const adj = shrink(s.bias, s.n) * (specific ? 0.5 : 1);
    if (Math.abs(adj) >= 0.02) {
      adjusted -= adj;
      specific = true;
      reasons.push(`On ${draft.category} you run ${s.bias > 0 ? 'hot' : 'cold'} by ${pts(s.bias)}: ${adj > 0 ? '−' : '+'}${pts(adj)}`);
    }
  }
  if (!specific && done.length >= 3) {
    const s = stat(done);
    const adj = shrink(s.bias, s.n);
    if (Math.abs(adj) >= 0.02) {
      adjusted -= adj;
      reasons.push(`Overall you are ${s.bias > 0 ? 'over' : 'under'}confident by ${pts(s.bias)}: ${adj > 0 ? '−' : '+'}${pts(adj)}`);
    }
  }

  if (echo && echo.n >= 2) {
    const adj = shrink(echo.bias, echo.n) * 0.6;
    if (Math.abs(adj) >= 0.02) {
      adjusted -= adj;
      reasons.push(`You argued like this ${echo.n} times before and won ${echo.won}: ${adj > 0 ? '−' : '+'}${pts(adj)}`);
    }
  }

  const last = done.slice().sort((a, b) => a.settledAt.localeCompare(b.settledAt)).at(-1);
  const tiltInsight = fingerprint(picks).insights.find((i) => i.id === 'tilt');
  if (last?.status === 'lost' && tiltInsight) {
    const adj = Math.min(0.1, shrink(tiltInsight.bias, tiltInsight.n) * 0.6);
    adjusted -= adj;
    reasons.push(`Tilt alarm: your last pick lost, and you pick worse right after losses: −${pts(adj)}`);
  }

  adjusted = Math.min(0.99, Math.max(0.01, adjusted));
  const market = draft.marketProb;
  const edge = adjusted - market;
  let verdict;
  if (!done.length) verdict = 'No history yet. Log and settle a few picks so I can learn your blind spots.';
  else if (edge > 0.03) verdict = `Your edge survives the correction: ${pct(adjusted)} vs market ${pct(market)}.`;
  else if (edge < -0.03) verdict = `Corrected for your bias, the market is more right than you. Pass or size down.`;
  else verdict = `After correcting for your bias there is no real edge here.`;

  return { gut: draft.confidence, adjusted, market, edge, reasons, verdict, basedOn: done.length, echo };
}
