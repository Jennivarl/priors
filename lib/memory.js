// Walrus Memory (Mainnet) layer.
// Every pick, every result and every lesson the coach learns is written as a memory.
// Each memory ends with a machine-readable tag so the whole app can be rebuilt from Walrus alone.
import { MemWal } from '@mysten-incubation/memwal';

export const NAMESPACE = process.env.MEMWAL_NAMESPACE || 'gut-check';
// Reasons live in their own namespace so "how did I argue last time?" searches only reasoning.
export const REASONS = `${NAMESPACE}-reasons`;
const TAG = '##GC ';

let client;
function memwal() {
  if (!client) {
    for (const k of ['MEMWAL_PRIVATE_KEY', 'MEMWAL_ACCOUNT_ID']) {
      if (!process.env[k]) throw new Error(`${k} is missing in .env`);
    }
    client = MemWal.create({
      key: process.env.MEMWAL_PRIVATE_KEY,
      accountId: process.env.MEMWAL_ACCOUNT_ID,
      serverUrl: process.env.MEMWAL_SERVER_URL || 'https://relayer.memory.walrus.xyz',
      namespace: NAMESPACE,
    });
  }
  return client;
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

/** Write one memory and wait until it is stored on Walrus. Returns { blob_id, id }. */
export async function remember(sentence, payload, namespace = NAMESPACE, idempotencyKey) {
  // idempotencyKey makes retries and restarts safe: the relayer dedupes the same key in a namespace.
  const r = await memwal().rememberAndWait(encode(sentence, payload), namespace, { timeoutMs: 120_000, ...(idempotencyKey ? { idempotencyKey } : {}) });
  return { blob_id: r.blob_id, id: r.id };
}

/** Semantic recall: memories closest in meaning to the query. */
export async function recall(query, topK = 10, namespace = NAMESPACE, maxDistance) {
  const r = await memwal().recall({ query, topK, namespace, ...(maxDistance ? { maxDistance } : {}) });
  return r.results.map((m) => ({ text: m.text, blob_id: m.blob_id, distance: m.distance, payload: decode(m.text) }));
}

/**
 * Walrus Analyze: the relayer extracts structured facts from free text and stores each one
 * as its own memory. We use it on the user's reasoning ("they're on form, revenge game").
 */
export async function analyze(text) {
  const r = await memwal().analyze(text, { namespace: NAMESPACE });
  return r.facts.map((f) => f.text);
}

/** Count every memory this app has stored in its namespace (walks the full inventory). */
export async function countMemories() {
  let cursor;
  let more = true;
  let count = 0;
  while (more) {
    const page = await memwal().listMemories({ cursor });
    count += page.memories.filter((m) => m.namespace_id === NAMESPACE || m.namespace_id === REASONS).length;
    cursor = page.next_cursor ?? undefined;
    more = page.has_more;
  }
  return count;
}

/**
 * Rebuild app state from Walrus Memory only.
 * Recall is similarity-ranked and capped at 100 per query, so we sweep with several queries and de-duplicate.
 */
export async function restoreAll() {
  await memwal().restore(NAMESPACE).catch(() => {});
  const queries = [
    'Gut Check pick logged with confidence and bookmaker odds',
    'Gut Check result settled: the pick won or lost',
    'Gut Check coach learned a lesson about my bias',
  ];
  const seen = new Map();
  for (const q of queries) {
    for (const m of await recall(q, 100)) if (m.payload && !seen.has(m.blob_id)) seen.set(m.blob_id, m);
  }
  return [...seen.values()];
}

export async function health() {
  return (await memwal().health()).status;
}
