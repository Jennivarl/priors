// Server receipts for picks made in wallet mode.
// The browser keeps a wallet user's picks, so the server signs each pick it issues (HMAC over the
// pick's commitment). Settlement only accepts picks with a valid receipt, so a pick edited in the
// browser (new target, later deadline, different market) cannot be settled as if it were real.
import crypto from 'node:crypto';
import { commitment } from './settle.js';

let fallback;
function secret() {
  const base = process.env.RECEIPT_SECRET || process.env.OWNER_TOKEN || process.env.MEMWAL_PRIVATE_KEY;
  if (base) return crypto.createHmac('sha256', base).update('priors-receipt-v1').digest();
  // No configured secret: receipts stay valid for the life of this process only.
  fallback ??= crypto.randomBytes(32);
  return fallback;
}

export function sign(pick) {
  return crypto.createHmac('sha256', secret()).update(commitment(pick)).digest('hex');
}

/** True when the pick still matches what the server issued. */
export function verify(pick) {
  if (!pick || typeof pick.receipt !== 'string' || !/^[0-9a-f]{64}$/.test(pick.receipt)) return false;
  if (commitment(pick) !== pick.commitment) return false;
  const a = Buffer.from(sign(pick), 'hex');
  const b = Buffer.from(pick.receipt, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
