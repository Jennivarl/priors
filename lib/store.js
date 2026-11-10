// Local working copy of state. Walrus Memory is the durable source of truth:
// /api/restore wipes this file and rebuilds everything from Walrus.
// On a serverless host (Vercel) the disk is temporary, so the app starts from a published snapshot
// (demo/state.json, exported with `npm run snapshot`) and keeps changes in /tmp.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.env.GUTCHECK_STATE || (process.env.VERCEL ? '/tmp/priors-state.json' : path.join(ROOT, 'data/state.json'));
export const SNAPSHOT = path.join(ROOT, 'demo/state.json');
const empty = () => ({ picks: [], memories: [], learned: {} });

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

export function reset() {
  const s = empty();
  save(s);
  return s;
}
