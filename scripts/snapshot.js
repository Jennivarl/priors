// Export the current local state as the public demo snapshot (demo/state.json).
// It contains picks, reasons, results, lessons and Walrus blob ids. It never contains keys.
import fs from 'node:fs';

const state = JSON.parse(fs.readFileSync('data/state.json', 'utf8'));
for (const m of state.memories) delete m.payload; // pending payloads are not needed publicly
const pending = state.memories.filter((m) => m.status === 'pending').length;
if (pending) console.warn(`Warning: ${pending} memories are still being written to Walrus. Wait and re-run for a complete snapshot.`);
fs.mkdirSync('demo', { recursive: true });
fs.writeFileSync('demo/state.json', JSON.stringify(state, null, 2));
console.log(`Snapshot written: ${state.picks.length} picks, ${state.memories.length} memory log entries.`);
