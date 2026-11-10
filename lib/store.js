// Local working copy of state. Walrus Memory is the durable source of truth:
// /api/restore wipes this file and rebuilds everything from Walrus.
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve(process.env.GUTCHECK_STATE || 'data/state.json');
const empty = () => ({ picks: [], memories: [], learned: {} });

export function load() {
  try {
    return { ...empty(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    return empty();
  }
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
