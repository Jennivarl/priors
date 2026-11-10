// Result sources: who decides whether a pick won.
//
// - onchainPrice: crypto picks ("SUI above $0.85 by 15:00 UTC") settle automatically from
//   Cetus pool state on Sui Mainnet, read via Tatum. The user cannot fake the result.
//   The settlement keeps its evidence: price, pool ids, Sui checkpoint.
// - selfReported: sports picks are settled by the user for now and are labelled UNVERIFIED in the
//   app, the memory and the coach. Upgrade path: implement the same interface with a sports results
//   feed (or a Sui prediction-market resolution) and register it in SOURCES; nothing else changes.
import { getPrice, ASSETS } from './oracle.js';

/** @typedef {{ status: 'won'|'lost', verified: boolean, evidence: object }} Settlement */

export const onchainPrice = {
  id: 'onchain-price',
  verified: true,
  /** @returns {Promise<Settlement|null>} null while the deadline has not passed yet */
  async settle(pick, now = new Date()) {
    if (new Date(pick.crypto.deadline) > now) return null;
    const price = await getPrice(pick.crypto.asset);
    const hit = pick.crypto.direction === 'above' ? price.usd > pick.crypto.target : price.usd < pick.crypto.target;
    return { status: hit ? 'won' : 'lost', verified: true, evidence: { ...price, target: pick.crypto.target, direction: pick.crypto.direction } };
  },
};

export const selfReported = {
  id: 'self-reported',
  verified: false,
  /** @returns {Settlement} */
  settle(pick, result) {
    if (!['won', 'lost'].includes(result)) throw new Error('Result must be won or lost.');
    return { status: result, verified: false, evidence: { source: 'self-reported by the user (unverified)' } };
  },
};

export const sourceFor = (pick) => (pick.crypto ? onchainPrice : selfReported);

/** Validate the crypto part of a draft pick. */
export function parseCrypto(b) {
  if (!b.asset) return null;
  const asset = String(b.asset).toUpperCase();
  const target = Number(b.target);
  const minutes = Number(b.minutes);
  if (!ASSETS.includes(asset)) throw new Error(`Asset must be one of ${ASSETS.join(', ')}.`);
  if (!['above', 'below'].includes(b.direction)) throw new Error('Direction must be above or below.');
  if (!(target > 0)) throw new Error('Target price must be a positive number.');
  if (!(minutes >= 1 && minutes <= 60 * 24 * 30)) throw new Error('Deadline must be between 1 minute and 30 days.');
  return { asset, direction: b.direction, target, deadline: new Date(Date.now() + minutes * 60_000).toISOString() };
}
