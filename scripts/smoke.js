// Connection check: Tatum Sui gRPC and a Walrus Memory write on Mainnet, with the keys in .env.
// Run: npm run check
import 'dotenv/config';
import { getStamp } from '../lib/sui.js';
import * as memory from '../lib/memory.js';

const space = memory.ownerSpace();
const stamp = await getStamp();
console.log(`Tatum Sui OK: checkpoint #${stamp.checkpoint} at ${stamp.timestamp}`);

const r = await memory.remember(space, `Priors connection check at Sui checkpoint ${stamp.checkpoint}.`, { kind: 'check', at: new Date().toISOString() });
console.log(`Walrus Memory write OK: blob ${r.blob_id}`);
console.log(`Memories stored in namespace "${space.ns}": ${await memory.countMemories(space)}`);
process.exit(0);
