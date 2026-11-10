import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeOnchainPrice, selfReported, sourceFor, parseCrypto, commitment } from '../lib/settle.js';
import { bPerAFromSqrt } from '../lib/oracle.js';
import { reasoningEcho, secondOpinion } from '../lib/coach.js';

test('Cetus sqrt price math matches the real USDC/SUI pool reading', () => {
  // current_sqrt_price read from the Cetus USDC/SUI pool on Sui Mainnet (10 Nov 2026)
  const suiPerUsdc = bPerAFromSqrt('640968097843584565248', 6, 9);
  const usdPerSui = 1 / suiPerUsdc;
  assert.ok(Math.abs(usdPerSui - 0.828) < 0.001, `expected ~$0.828, got ${usdPerSui}`);
});

test('WAL priced through its SUI pool', () => {
  const suiPerWal = bPerAFromSqrt('3383446173452264482', 9, 9);
  assert.ok(Math.abs(suiPerWal - 0.03364) < 0.0001, `got ${suiPerWal}`);
});

const call = (direction, target, deadline) => ({ crypto: { asset: 'SUI', direction, target, deadline } });
const past = new Date(Date.now() - 1000).toISOString();
const future = new Date(Date.now() + 60_000).toISOString();
const at = (usd) => makeOnchainPrice(async () => ({ usd, checkpoint: '1', pools: [] }));

test('crypto pick does not settle before its deadline', async () => {
  assert.equal(await at(1).settle(call('above', 0.5, future)), null);
});

test('above / below settle from the onchain price, with evidence', async () => {
  const won = await at(0.9).settle(call('above', 0.85, past));
  assert.equal(won.status, 'won');
  assert.equal(won.verified, true);
  assert.equal(won.evidence.usd, 0.9);
  assert.equal((await at(0.8).settle(call('above', 0.85, past))).status, 'lost');
  assert.equal((await at(0.8).settle(call('below', 0.85, past))).status, 'won');
});

test('landing exactly on the target loses both ways', async () => {
  assert.equal((await at(0.85).settle(call('above', 0.85, past))).status, 'lost');
  assert.equal((await at(0.85).settle(call('below', 0.85, past))).status, 'lost');
});

test('a missing or broken price never settles a pick', async () => {
  await assert.rejects(at(0).settle(call('above', 0.85, past)));
  await assert.rejects(makeOnchainPrice(async () => null).settle(call('above', 0.85, past)));
});

test('sports picks are self-reported and unverified; crypto picks use the onchain source', () => {
  const s = selfReported.settle({}, 'won');
  assert.equal(s.verified, false);
  assert.throws(() => selfReported.settle({}, 'maybe'));
  assert.equal(sourceFor({}), selfReported);
  assert.notEqual(sourceFor(call('above', 1, future)), selfReported);
});

test('crypto input is validated with clear errors', () => {
  assert.throws(() => parseCrypto({ asset: 'DOGE', direction: 'above', target: 1, minutes: 5 }), /Asset/);
  assert.throws(() => parseCrypto({ asset: 'SUI', direction: 'sideways', target: 1, minutes: 5 }), /Direction/);
  assert.throws(() => parseCrypto({ asset: 'SUI', direction: 'above', target: -1, minutes: 5 }), /Target/);
  assert.throws(() => parseCrypto({ asset: 'SUI', direction: 'above', target: 1, minutes: 0 }), /Deadline/);
  const ok = parseCrypto({ asset: 'sui', direction: 'below', target: '0.9', minutes: '2' }, 0);
  assert.deepEqual(ok, { asset: 'SUI', direction: 'below', target: 0.9, deadline: new Date(120_000).toISOString() });
});

test('commitment changes if any part of the pick is edited', () => {
  const p = { subject: 'Arsenal', event: 'A vs B', category: 'Football', confidence: 0.8, odds: 1.9, reason: 'form', createdAt: '2026-11-10T00:00:00Z', stamp: { checkpoint: '1', digest: 'abc' } };
  const h = commitment(p);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(commitment({ ...p }), h);
  assert.notEqual(commitment({ ...p, confidence: 0.7 }), h);
  assert.notEqual(commitment({ ...p, stamp: { checkpoint: '1', digest: 'abd' } }), h);
});

test('reasoning echo: past reasoning that lost pulls the second opinion down', () => {
  const lost = (r) => ({ pick: { subject: 'X', status: 'lost', confidence: 0.8 }, distance: 0.3, reason: r });
  const echo = reasoningEcho([lost('they are due'), lost('great form'), lost('owe us one')]);
  assert.equal(echo.n, 3);
  assert.equal(echo.won, 0);
  const o = secondOpinion([], { subject: 'Y', category: 'Football', confidence: 0.8, marketProb: 0.5 }, echo);
  assert.ok(o.adjusted < 0.8);
  assert.ok(o.reasons.some((r) => r.includes('argued like this 3 times')));
  assert.equal(reasoningEcho([]), null);
});
