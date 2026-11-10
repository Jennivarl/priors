// Walrus Memory accounts on Sui Mainnet, read through Tatum gRPC.
// A wallet owns at most one Walrus Memory account. The AccountRegistry keeps a table
// wallet address -> account ID, so a returning user is found without scanning anything.
import { deriveDynamicFieldID } from '@mysten/sui/utils';
import { bcs } from '@mysten/sui/bcs';
import { sui, limited } from './sui.js';

export const WALRUS_MEMORY = {
  network: 'mainnet',
  packageId: '0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5',
  registryId: '0x8bf82c9e09e36b8d1c38298f68b7cb68e7b8762887e7592add9986d5e9cf199f',
  accountsTable: '0xcfe04623a8c72ede45fc02babcb9711625df8549e53d3107d507efa696d5efde',
};

const CREATED = 2; // sui.rpc.v2 ChangedObject.IdOperation.CREATED
const isAddress = (s) => /^0x[0-9a-fA-F]{64}$/.test(String(s));
export const normalizeAddress = (s) => (isAddress(s) ? String(s).toLowerCase() : null);

const field = (json, name) => json?.kind?.structValue?.fields?.[name]?.kind;

/** Delegate keys on an account object, as lowercase hex public keys. */
export function parseDelegateKeys(accountJson) {
  const list = field(accountJson, 'delegate_keys')?.listValue?.values || [];
  return list.map((v) => {
    const f = v.kind?.structValue?.fields || {};
    const b64 = f.public_key?.kind?.stringValue || '';
    return {
      publicKey: Buffer.from(b64, 'base64').toString('hex'),
      label: f.label?.kind?.stringValue || '',
      suiAddress: f.sui_address?.kind?.stringValue || '',
    };
  });
}

/** Account summary: owner, whether it is usable, and its delegate keys. */
export function parseAccount(accountJson) {
  return {
    owner: field(accountJson, 'owner')?.stringValue || null,
    active: field(accountJson, 'active')?.boolValue !== false,
    quarantined: field(accountJson, 'admin_quarantined')?.boolValue === true,
    delegateKeys: parseDelegateKeys(accountJson),
  };
}

/** The Walrus Memory account ID owned by a wallet, or null if it has none. */
export async function accountIdFor(address) {
  const owner = normalizeAddress(address);
  if (!owner) throw new Error('Not a Sui address.');
  const fieldId = deriveDynamicFieldID(WALRUS_MEMORY.accountsTable, 'address', bcs.Address.serialize(owner).toBytes());
  try {
    const { response } = await limited(() => sui().ledgerService.getObject({ objectId: fieldId, readMask: { paths: ['json'] } }));
    return field(response.object.json, 'value')?.stringValue || null;
  } catch (e) {
    if (e.code === 'NOT_FOUND') return null;
    throw e;
  }
}

export async function getAccount(accountId) {
  const id = normalizeAddress(accountId);
  if (!id) throw new Error('Not a Walrus Memory account ID.');
  const { response } = await limited(() => sui().ledgerService.getObject({ objectId: id, readMask: { paths: ['object_type', 'json'] } }));
  if (!String(response.object.objectType).endsWith('::account::MemWalAccount')) throw new Error('That object is not a Walrus Memory account.');
  return { accountId: id, ...parseAccount(response.object.json) };
}

/** Normalised result of a finished transaction, in the shape the Walrus Memory SDK reads. */
export function txSummary(executed) {
  const status = executed.effects?.status || {};
  const created = (executed.effects?.changedObjects || [])
    .filter((c) => c.idOperation === CREATED)
    .map((c) => ({ type: 'created', objectId: c.objectId, objectType: c.objectType || '' }));
  return {
    digest: executed.digest,
    status: { success: status.success === true, error: status.success ? undefined : JSON.stringify(status.error || 'failed') },
    objectChanges: created,
  };
}

/** Wait until a transaction is visible on Tatum's node, then summarise it. */
export async function waitForTransaction(digest, { attempts = 15, gapMs = 1000 } = {}) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(digest))) throw new Error('Not a transaction digest.');
  for (let i = 0; i < attempts; i++) {
    try {
      const { response } = await limited(() =>
        sui().ledgerService.getTransaction({ digest, readMask: { paths: ['digest', 'effects.status', 'effects.changed_objects'] } }),
      );
      return txSummary(response.transaction);
    } catch (e) {
      if (e.code !== 'NOT_FOUND' || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, gapMs));
    }
  }
  throw new Error('Transaction not found.');
}
