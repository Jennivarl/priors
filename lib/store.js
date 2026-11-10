// The operator's working copy of state. Walrus Memory is the durable source of truth:
// fromMemories() rebuilds the whole record from Walrus alone.
// On a serverless host (Vercel) the disk is temporary, so the app starts from the published demo
// snapshot (demo/state.json, exported with `npm run snapshot`) and keeps changes in /tmp.
// Wallet users' records live in their own browser and their own Walrus Memory, not here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.env.PRIORS_STATE || (process.env.VERCEL ? '/tmp/priors-state.json' : path.join(ROOT, 'data/state.json'));
export const SNAPSHOT = path.join(ROOT, 'demo/state.json');
export const empty = () => ({ picks: [], memories: [], learned: {} });

function read(file) {
  return { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
}

export function load() {
  for (const f of [FILE, ...(process.env.VERCEL ? [SNAPSHOT] : [])]) {
    try {
      return read(f);
    } catch {
      // try the next source
    }
  }
  return empty();
}

export function save(state) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
}

/** Rebuild a record (picks with their results, memory log, learned lessons) from tagged memories. */
export function fromMemories(mems) {
  const next = empty();
  const byId = new Map();
  for (const m of mems) if (m.payload?.kind === 'pick' && m.payload.pick?.id) byId.set(m.payload.pick.id, { ...m.payload.pick });
  for (const m of mems) {
    const p = m.payload;
    if (!p) continue;
    if (p.kind === 'result' && byId.has(p.id)) {
      Object.assign(byId.get(p.id), { status: p.status, settledAt: p.settledAt, verified: Boolean(p.verified), evidence: p.evidence });
    }
    if (p.kind === 'lesson' && p.insight) next.learned[p.insight.id] = p.insight.title;
    next.memories.push({
      id: m.blob_id,
      kind: p.kind,
      sentence: m.text.split('\n##GC')[0],
      status: 'stored',
      blob_id: m.blob_id,
      at: p.at || p.settledAt || p.pick?.createdAt || '',
    });
  }
  next.picks = [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  next.memories.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return next;
}
