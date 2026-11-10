import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, secondOpinion, calibration } from '../lib/coach.js';

let t = 0;
const at = () => new Date(Date.UTC(2026, 9, 1) + (t += 60_000)).toISOString();
function pick(subject, category, confidence, odds, status) {
  const createdAt = at();
  return { id: `${subject}-${t}`, subject, category, confidence, odds, marketProb: 1 / odds, status, createdAt, settledAt: at() };
}

const history = [
  pick('Arsenal', 'Football', 0.8, 1.7, 'won'),
  pick('Arsenal', 'Football', 0.82, 1.9, 'lost'),
  pick('Arsenal', 'Football', 0.85, 1.8, 'lost'),
  pick('Arsenal', 'Football', 0.8, 1.95, 'lost'),
  pick('Sinner', 'Tennis', 0.62, 1.6, 'won'),
  pick('Alcaraz', 'Tennis', 0.66, 1.5, 'won'),
  pick('Swiatek', 'Tennis', 0.6, 1.65, 'won'),
];

test('no history: coach passes your gut through and says so', () => {
  const o = secondOpinion([], { subject: 'Arsenal', category: 'Football', confidence: 0.8, marketProb: 0.55 });
  assert.equal(o.adjusted, 0.8);
  assert.match(o.verdict, /No history/);
});

test('learns that you overrate a team you keep backing', () => {
  const fp = fingerprint(history);
  const arsenal = fp.insights.find((i) => i.id === 'subject:Arsenal');
  assert.ok(arsenal, 'expected an Arsenal insight');
  assert.match(arsenal.title, /overrate Arsenal/);
});

test('second opinion pulls an Arsenal pick down toward reality', () => {
  const o = secondOpinion(history, { subject: 'Arsenal', category: 'Football', confidence: 0.8, marketProb: 0.55 });
  assert.ok(o.adjusted < 0.6, `adjusted ${o.adjusted} should be well below 0.8`);
  assert.ok(o.reasons.some((r) => r.includes('Arsenal')));
});

test('does not punish categories where you are sharp or underconfident', () => {
  const o = secondOpinion(history, { subject: 'Gauff', category: 'Tennis', confidence: 0.6, marketProb: 0.55 });
  assert.ok(o.adjusted >= 0.6, `tennis pick should not be marked down, got ${o.adjusted}`);
});

test('calibration buckets compare what you said to what happened', () => {
  const b = calibration(history);
  const top = b.find((x) => x.from >= 0.8 - 1e-9 && x.from < 0.9);
  assert.equal(top.n, 4);
  assert.equal(top.hit, 0.25);
});
