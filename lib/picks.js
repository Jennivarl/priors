// Building and describing picks. Shared by the operator's app and by wallet users.
import crypto from 'node:crypto';
import { getStamp } from './sui.js';
import { getPrice } from './oracle.js';
import * as markets from './markets.js';
import { parseCrypto, commitment } from './settle.js';

/** An error whose message is safe to show the user, with the HTTP status to answer with. */
export const userError = (message, status = 400) => Object.assign(new Error(message), { status });

const DRAFT_ERROR = 'Fill in pick, category, confidence and decimal odds (> 1).';
const REASON_ERROR = 'Say why you like this pick in a few words. The coach learns from your reasoning.';
const pct = (x) => `${Math.round(x * 100)}%`;

/** A clean draft pick from form input, or a userError explaining what is missing. */
export function parseDraft(b) {
  const odds = Number(b.odds);
  const confidence = Number(b.confidence) / (Number(b.confidence) > 1 ? 100 : 1);
  let call = null;
  if (b.kind === 'crypto') {
    try {
      call = parseCrypto(b);
    } catch (e) {
      throw userError(e.message);
    }
  }
  const subject = call ? `${call.asset} ${call.direction} $${call.target}` : String(b.subject || '').trim().slice(0, 120);
  const category = call ? 'Crypto' : String(b.category || '').trim().slice(0, 40);
  if (!subject || !category || !(odds > 1) || !(confidence > 0 && confidence < 1)) throw userError(DRAFT_ERROR);
  return {
    subject,
    category,
    event: call ? `by ${call.deadline.slice(11, 16)} UTC` : String(b.event || '').trim().slice(0, 160),
    reason: String(b.reason || '').trim().slice(0, 400),
    odds,
    confidence,
    marketProb: 1 / odds,
    ...(call ? { crypto: call } : {}),
  };
}

/** Price source: a fresh Polymarket quote when a market was chosen (the client's number is ignored). */
async function priceDraft(draft, b) {
  draft.oddsSource = { kind: 'manual' };
  if (draft.crypto) {
    draft.oddsSource = { kind: 'manual', note: 'your own price for this crypto call' };
    return;
  }
  if (!b.marketId) return;
  const side = String(b.side || 'Yes');
  let q;
  try {
    q = await markets.quote(String(b.marketId), side);
  } catch (e) {
    throw userError(e.message);
  }
  Object.assign(draft, {
    subject: q.option.subject,
    event: q.event,
    odds: Number((1 / q.option.prob).toFixed(3)),
    marketProb: q.option.prob,
    starts: q.starts,
    market: { marketId: q.marketId, question: q.question, side },
  });
  draft.oddsSource = { kind: 'market', name: 'Polymarket', marketId: q.marketId };
}

/**
 * Seal a new pick: price it, stamp it with the live Sui checkpoint, and commit to its content.
 * coachFor(draft) returns the second opinion shown when the pick was made, as { adjusted, verdict }.
 */
export async function sealPick(body, coachFor) {
  const draft = parseDraft(body);
  if (draft.reason.length < 8) throw userError(REASON_ERROR);
  await priceDraft(draft, body);
  let stamp, startPrice, coach;
  try {
    [stamp, startPrice, coach] = await Promise.all([getStamp(), draft.crypto ? getPrice(draft.crypto.asset) : null, coachFor(draft)]);
  } catch (e) {
    throw userError(`Could not stamp the pick on Sui: ${e.message}`, 502);
  }
  if (startPrice) draft.crypto.startPrice = startPrice.usd;
  const pick = { id: crypto.randomUUID(), ...draft, createdAt: new Date().toISOString(), status: 'open', stamp, coach };
  pick.commitment = commitment(pick);
  return pick;
}

export function pickSentence(pick) {
  const price = pick.oddsSource?.kind === 'market' ? 'Polymarket' : 'My own typed odds';
  const onchain = pick.crypto ? ` ${pick.crypto.asset} was $${pick.crypto.startPrice?.toFixed(4)} onchain when I called it.` : '';
  return (
    `Priors pick logged: I backed ${pick.subject}${pick.event ? ` in ${pick.event}` : ''} (${pick.category}) at ${pct(pick.confidence)} confidence. ` +
    `${price} implied ${pct(pick.marketProb)} (odds ${pick.odds}).${onchain} Why: ${pick.reason}. ` +
    `Commitment sha256 ${pick.commitment}, Sui checkpoint digest ${pick.stamp.digest}. Coach said ${pct(pick.coach.adjusted)}. Sealed at Sui checkpoint ${pick.stamp.checkpoint}.`
  );
}

export const reasonSentence = (pick) => `My reason for backing ${pick.subject} (${pick.category}): ${pick.reason}`;

export const analyzeText = (pick) => `I am backing ${pick.subject} in ${pick.event || pick.category} because ${pick.reason}`;

export function resultSentence(pick, s) {
  const proof = !s.verified
    ? 'Self-reported, unverified.'
    : pick.crypto
      ? `Verified onchain: ${pick.crypto.asset} was $${s.evidence.usd.toFixed(4)} at Sui checkpoint ${s.evidence.checkpoint} (target ${s.evidence.direction} $${s.evidence.target}).`
      : `Verified by market resolution: Polymarket market ${s.evidence.marketId} "${s.evidence.question}" resolved ${JSON.stringify(s.evidence.outcomePrices)}.`;
  return `Priors result settled: my pick on ${pick.subject}${pick.event ? ` (${pick.event})` : ''} ${s.status}. I had said ${pct(pick.confidence)}. ${proof}`;
}

export const resultPayload = (pick, s, settledAt) => ({ kind: 'result', id: pick.id, status: s.status, settledAt, verified: s.verified, evidence: s.evidence });

export const lessonSentence = (ins) => `Priors coach learned a lesson about my bias: ${ins.title}. ${ins.detail}`;
