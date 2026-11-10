// Result sources: who decides whether a pick won.
//
// - onchainPrice: crypto picks ("SUI above $0.85 by 15:00 UTC") settle automatically from
//   Cetus pool state on Sui Mainnet, read via Tatum. The user cannot fake the result.
//   The settlement keeps its evidence: price, pool ids, Sui checkpoint.
// - selfReported: sports picks are settled by the user for now and are labelled UNVERIFIED in the
//   app, the memory and the coach. Upgrade path: implement the same interface with a sports results
//   feed (or a Sui prediction-market resolution) and register it in SOURCES; nothing else changes.
import { getPrice, ASSETS } from './oracle.js';
import crypto from 'node:crypto';
import { status as marketStatus } from './markets.js';

/**
 * Commitment for a pick: sha256 over its content and the Sui checkpoint digest it was sealed with.
 * The digest cannot be known before that checkpoint exists, so the pick was made after it;
 * the Walrus write that carries this hash shows it existed by the time of the write.
 * Any later edit to the pick changes the hash.
 */
export function commitment(pick) {
  const fields = ['subject', 'event', 'category', 'confidence', 'odds', 'reason', 'createdAt'];
  const body = fields.map((f) => `${f}=${pick[f] ?? ''}`).join('|') + `|checkpoint=${pick.stamp?.checkpoint}|digest=${pick.stamp?.digest}` + (pick.crypto ? `|crypto=${pick.crypto.asset}:${pick.crypto.direction}:${pick.crypto.target}:${pick.crypto.deadline}` : '');
  return crypto.createHash('sha256').update(body).digest('hex');
}

/** @typedef {{ status: 'won'|'lost', verified: boolean, evidence: object }} Settlement */

/** Build the onchain-price source. The price reader is injected so the rules can be tested offline. */
export function makeOnchainPrice(readPrice = getPrice) {
  return {
    id: 'onchain-price',
    verified: true,
    /** @returns {Promise<Settlement|null>} null while the deadline has not passed yet */
    async settle(pick, now = new Date()) {
      if (new Date(pick.crypto.deadline) > now) return null;
      const price = await readPrice(pick.crypto.asset);
      if (!(price?.usd > 0)) throw new Error(`No valid onchain price for ${pick.crypto.asset}`);
      // Strict inequality: landing exactly on the target is a loss for both "above" and "below".
      const hit = pick.crypto.direction === 'above' ? price.usd > pick.crypto.target : price.usd < pick.crypto.target;
      return { status: hit ? 'won' : 'lost', verified: true, evidence: { ...price, target: pick.crypto.target, direction: pick.crypto.direction } };
    },
  };
}
export const onchainPrice = makeOnchainPrice();

/**
 * Prediction-market resolution (Polymarket, resolved onchain through the UMA oracle).
 * The pick backs YES or NO on a market; it settles once the market is closed and resolved.
 */
export function makeMarketResolution(readMarket = marketStatus) {
  return {
    id: 'market-resolution',
    verified: true,
    async settle(pick) {
      const m = await readMarket(pick.market.marketId);
      if (!m.closed || m.resolution !== 'resolved') return null;
      const winners = m.outcomes.filter((_, i) => m.prices[i] === 1);
      if (winners.length !== 1) return null; // not cleanly resolved (e.g. disputed or 50/50): keep waiting
      const won = winners[0] === pick.market.side;
      return { status: won ? 'won' : 'lost', verified: true, evidence: { source: 'Polymarket resolution (UMA oracle)', marketId: m.marketId, question: m.question, outcomePrices: m.prices, resolution: m.resolution } };
    },
  };
}
export const marketResolution = makeMarketResolution();

export const selfReported = {
  id: 'self-reported',
  verified: false,
  /** @returns {Settlement} */
  settle(pick, result) {
    if (!['won', 'lost'].includes(result)) throw new Error('Result must be won or lost.');
    return { status: result, verified: false, evidence: { source: 'self-reported by the user (unverified)' } };
  },
};

export const sourceFor = (pick) => (pick.crypto ? onchainPrice : pick.market ? marketResolution : selfReported);

/** Validate the crypto part of a draft pick. */
export function parseCrypto(b, now = Date.now()) {
  if (!b.asset) throw new Error(`Choose an asset: ${ASSETS.join(', ')}.`);
  const asset = String(b.asset).toUpperCase();
  const target = Number(b.target);
  const minutes = Number(b.minutes);
  if (!ASSETS.includes(asset)) throw new Error(`Asset must be one of ${ASSETS.join(', ')}.`);
  if (!['above', 'below'].includes(b.direction)) throw new Error('Direction must be above or below.');
  if (!(target > 0)) throw new Error('Target price must be a positive number.');
  if (!(minutes >= 1 && minutes <= 60 * 24 * 30)) throw new Error('Deadline must be between 1 minute and 30 days.');
  return { asset, direction: b.direction, target, deadline: new Date(now + minutes * 60_000).toISOString() };
}
