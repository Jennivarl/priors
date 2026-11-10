import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as receipt from '../lib/receipt.js';
import { commitment } from '../lib/settle.js';
import { parseAccount, txSummary, normalizeAddress } from '../lib/walrus-account.js';
import { fromMemories } from '../lib/store.js';
import { encode, decode } from '../lib/memory.js';
import { parseDraft } from '../lib/picks.js';

const issued = () => {
  const pick = {
    id: 'p1', subject: 'SUI above $0.85', event: 'by 15:00 UTC', category: 'Crypto', confidence: 0.7, odds: 1.9, reason: 'low volatility',
    createdAt: '2026-11-10T14:00:00.000Z', stamp: { checkpoint: '343748796', digest: 'HcfqMkHd' },
    crypto: { asset: 'SUI', direction: 'above', target: 0.85, deadline: '2026-11-10T15:00:00.000Z' },
  };
  pick.commitment = commitment(pick);
  pick.receipt = receipt.sign(pick);
  return pick;
};

test('a pick the server issued verifies', () => {
  assert.equal(receipt.verify(issued()), true);
});

test('editing a sealed pick in the browser breaks its receipt', () => {
  for (const edit of [
    (p) => (p.crypto.target = 0.5),
    (p) => (p.crypto.deadline = '2026-11-11T15:00:00.000Z'),
    (p) => (p.confidence = 0.9),
    (p) => (p.commitment = commitment({ ...p, confidence: 0.9 })),
    (p) => (p.receipt = '0'.repeat(64)),
    (p) => delete p.receipt,
  ]) {
    const p = issued();
    edit(p);
    assert.equal(receipt.verify(p), false);
  }
});

test('the market and side are part of the commitment', () => {
  const p = { ...issued(), crypto: undefined, market: { marketId: '1', side: 'Yes' } };
  const h = commitment(p);
  assert.notEqual(commitment({ ...p, market: { marketId: '1', side: 'No' } }), h);
  assert.notEqual(commitment({ ...p, market: { marketId: '2', side: 'Yes' } }), h);
});

const str = (v) => ({ kind: { oneofKind: 'stringValue', stringValue: v } });
const accountJson = {
  kind: {
    structValue: {
      fields: {
        owner: str('0xcd28de7756d65d780393f3d50fd193841941b1f92dedd5951fccf54acf303c65'),
        active: { kind: { boolValue: true } },
        admin_quarantined: { kind: { boolValue: false } },
        delegate_keys: {
          kind: {
            listValue: {
              values: [{ kind: { structValue: { fields: { public_key: str('xdb0eQ8riP2VgLZ4S60nKVvA2Dyf/a68IEP97qKhtfU='), label: str('Web App'), sui_address: str('0x8676') } } } }],
            },
          },
        },
      },
    },
  },
};

test('account parsing reads the owner and delegate keys as hex', () => {
  const a = parseAccount(accountJson);
  assert.equal(a.owner, '0xcd28de7756d65d780393f3d50fd193841941b1f92dedd5951fccf54acf303c65');
  assert.equal(a.active, true);
  assert.equal(a.quarantined, false);
  assert.deepEqual(a.delegateKeys, [{ publicKey: 'c5d6f4790f2b88fd9580b6784bad27295bc0d83c9ffdaebc2043fdeea2a1b5f5', label: 'Web App', suiAddress: '0x8676' }]);
});

test('transaction summary lists created objects in the shape the Walrus Memory SDK reads', () => {
  const s = txSummary({
    digest: 'abc',
    effects: {
      status: { success: true },
      changedObjects: [
        { objectId: '0xold', idOperation: 1, objectType: 'x::account::AccountRegistry' },
        { objectId: '0xnew', idOperation: 2, objectType: 'x::account::MemWalAccount' },
      ],
    },
  });
  assert.deepEqual(s.status, { success: true, error: undefined });
  assert.deepEqual(s.objectChanges, [{ type: 'created', objectId: '0xnew', objectType: 'x::account::MemWalAccount' }]);
  assert.equal(txSummary({ digest: 'd', effects: { status: { success: false, error: 'abort' } } }).status.success, false);
});

test('addresses are validated and lowercased', () => {
  assert.equal(normalizeAddress('0x' + 'A'.repeat(64)), '0x' + 'a'.repeat(64));
  assert.equal(normalizeAddress('0x123'), null);
  assert.equal(normalizeAddress('not an address'), null);
});

test('a record rebuilds from tagged memories alone', () => {
  const pick = { id: 'p1', subject: 'Arsenal', createdAt: '2026-11-10T10:00:00Z', status: 'open' };
  const mem = (blob, sentence, payload) => ({ blob_id: blob, text: encode(sentence, payload), payload: decode(encode(sentence, payload)) });
  const s = fromMemories([
    mem('b1', 'Priors pick logged', { kind: 'pick', pick }),
    mem('b2', 'Priors result settled', { kind: 'result', id: 'p1', status: 'lost', settledAt: '2026-11-10T12:00:00Z', verified: true, evidence: { marketId: '9' } }),
    mem('b3', 'Priors coach learned', { kind: 'lesson', insight: { id: 'subject:Arsenal', title: 'You overrate Arsenal' }, at: '2026-11-10T12:00:01Z' }),
  ]);
  assert.equal(s.picks.length, 1);
  assert.equal(s.picks[0].status, 'lost');
  assert.equal(s.picks[0].verified, true);
  assert.deepEqual(s.learned, { 'subject:Arsenal': 'You overrate Arsenal' });
  assert.equal(s.memories.length, 3);
  assert.equal(s.memories[0].sentence, 'Priors coach learned');
});

test('drafts are checked with messages a user can act on', () => {
  assert.throws(() => parseDraft({ kind: 'sports', subject: '', category: 'Football', odds: 2, confidence: 70 }), (e) => e.status === 400);
  assert.throws(() => parseDraft({ kind: 'crypto', asset: 'DOGE', direction: 'above', target: 1, minutes: 5, odds: 2, confidence: 70 }), /Asset/);
  const d = parseDraft({ kind: 'sports', subject: 'Arsenal', category: 'Football', odds: 2, confidence: 80, reason: 'form' });
  assert.equal(d.confidence, 0.8);
  assert.equal(d.marketProb, 0.5);
});
