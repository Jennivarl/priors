// Live connection check: Tatum Sui gRPC + Walrus Memory write/read on Mainnet.
// Run: npm run check
import 'dotenv/config';
import { getStamp } from '../lib/sui.js';
import * as memory from '../lib/memory.js';

const stamp = await getStamp();
console.log(`Tatum Sui OK: checkpoint #${stamp.checkpoint} at ${stamp.timestamp}`);

const r = await memory.remember(`Priors connection check at Sui checkpoint ${stamp.checkpoint}.`, { kind: 'check', at: new Date().toISOString() });
console.log(`Walrus Memory write OK: blob ${r.blob_id}`);
console.log(`Memories stored in namespace "${memory.NAMESPACE}": ${await memory.countMemories()}`);
process.exit(0);
