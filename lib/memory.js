// Walrus Memory (Mainnet) layer.
// Every pick, reason, result and lesson the coach learns is written as a memory. Each memory ends
// with a machine-readable tag, so the whole app can be rebuilt from Walrus alone.
//
// A "space" says whose memory to use:
// - ownerSpace(): the operator's account from .env (the local app and the public demo record)
// - userSpace(creds): a connected user's own account, with the delegate key their wallet authorised
import crypto from 'node:crypto';
import { MemWal } from '@mysten-incubation/memwal';
import { NETWORK } from './sui.js';

const RELAYERS = { mainnet: 'https://relayer.memory.walrus.xyz', testnet: 'https://relayer.dev.memwal.ai' };
const RELAYER = process.env.MEMWAL_SERVER_URL || RELAYERS[NETWORK];
const TAG = '##GC ';
const OWNER_NS = process.env.MEMWAL_NAMESPACE || 'gut-check';
const USER_NS = process.env.PRIORS_USER_NS || 'priors';

export function ownerSpace() {
  return { creds: null, ns: OWNER_NS, reasons: `${OWNER_NS}-reasons` };
}

/** creds = { key: delegate private key (64 hex), accountId: 0x... } */
export function userSpace(creds) {
  return { creds, ns: USER_NS, reasons: `${USER_NS}-reasons` };
}

const clients = new Map();
function client(space) {
  const creds = space.creds || { key: process.env.MEMWAL_PRIVATE_KEY, accountId: process.env.MEMWAL_ACCOUNT_ID };
  if (!creds.key || !creds.accountId) throw new Error('Walrus Memory credentials are missing (MEMWAL_PRIVATE_KEY, MEMWAL_ACCOUNT_ID).');
  const id = `${creds.accountId}:${crypto.createHash('sha256').update(creds.key).digest('hex').slice(0, 16)}`;
  let c = clients.get(id);
  if (!c) {
    c = MemWal.create({ key: creds.key, accountId: creds.accountId, serverUrl: RELAYER, namespace: space.ns });
    clients.set(id, c);
    if (clients.size > 100) clients.delete(clients.keys().next().value);
  }
  return c;
}

/** Human-readable sentence + tagged JSON payload, stored as one memory. */
export function encode(sentence, payload) {
  return `${sentence}\n${TAG}${JSON.stringify(payload)}`;
}

export function decode(text) {
  const i = text.lastIndexOf(TAG);
  if (i < 0) return null;
  try {
    return JSON.parse(text.slice(i + TAG.length));
  } catch {
    return null;
  }
}

const nsOf = (space, reasons) => (reasons ? space.reasons : space.ns);

/** Write one memory and wait until it is stored. idempotencyKey makes retries and restarts safe. */
export async function remember(space, sentence, payload, { reasons = false, idempotencyKey } = {}) {
  const r = await client(space).rememberAndWait(encode(sentence, payload), nsOf(space, reasons), {
    timeoutMs: 120_000,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  return { blob_id: r.blob_id, id: r.id };
}

/** Submit one memory and return as soon as the relayer accepts it. Poll with jobStatus(). */
export async function rememberAsync(space, sentence, payload, { reasons = false, idempotencyKey } = {}) {
  const r = await client(space).rememberAsync(encode(sentence, payload), nsOf(space, reasons), idempotencyKey ? { idempotencyKey } : undefined);
  return r.job_id;
}

export async function jobStatus(space, jobId) {
  const s = await client(space).getRememberStatus(jobId);
  return { status: s.status, blob_id: s.blob_id || null, error: s.error || null };
}

/** Semantic recall: memories closest in meaning to the query. */
export async function recall(space, query, topK = 10, { reasons = false, maxDistance } = {}) {
  const r = await client(space).recall({ query, topK, namespace: nsOf(space, reasons), ...(maxDistance ? { maxDistance } : {}) });
  return r.results.map((m) => ({ text: m.text, blob_id: m.blob_id, distance: m.distance, payload: decode(m.text) }));
}

/** Walrus Analyze: the relayer extracts facts from free text and stores each one as its own memory. */
export async function analyze(space, text) {
  const r = await client(space).analyze(text, { namespace: space.ns });
  return r.facts.map((f) => f.text);
}

/** Count the memories in this space's namespaces (walks the full inventory). */
export async function countMemories(space) {
  let cursor;
  let more = true;
  let count = 0;
  while (more) {
    const page = await client(space).listMemories({ cursor });
    count += page.memories.filter((m) => m.namespace_id === space.ns || m.namespace_id === space.reasons).length;
    cursor = page.next_cursor ?? undefined;
    more = page.has_more;
  }
  return count;
}

/**
 * Every tagged memory in this space, from Walrus alone.
 * Recall is similarity-ranked and capped at 100 per query, so it sweeps with several queries and de-duplicates.
 */
export async function restoreAll(space) {
  await client(space).restore(space.ns).catch(() => {});
  const queries = [
    'Priors pick logged with confidence, market odds and my reason',
    'Priors result settled: the pick won or lost',
    'Priors coach learned a lesson about my bias',
  ];
  const seen = new Map();
  for (const q of queries) {
    for (const m of await recall(space, q, 100)) if (m.payload && !seen.has(m.blob_id)) seen.set(m.blob_id, m);
  }
  return [...seen.values()];
}

/** The delegate public key (hex) for these credentials. */
export async function publicKeyHex(space) {
  return (await client(space).getPublicKeyHex()).toLowerCase();
}
