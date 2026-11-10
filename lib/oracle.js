// Onchain price oracle: reads live DEX pool state on Sui Mainnet through Tatum gRPC.
// Used to settle crypto picks automatically, so the user cannot fake a result.
import { sui, getStamp, limited } from './sui.js';

// Cetus CLMM pools (object ids on Sui Mainnet). coin_a / coin_b order and decimals matter for the math.
const POOLS = {
  SUI: { id: '0xb8d7d9e66a60c239e7a60110efcf8de6c705580ed924d0dde141f4a0e2c90105', pair: 'USDC/SUI', decA: 6, decB: 9 },
  WAL: { id: '0x72f5c6eef73d77de271886219a2543e7c29a33de19a6c69c5cf1899f729c3f17', pair: 'WAL/SUI', decA: 9, decB: 9 },
};
export const ASSETS = Object.keys(POOLS);

const field = (obj, name) => obj?.kind?.structValue?.fields?.[name]?.kind;

async function sqrtPrice(poolId) {
  const { response } = await limited(() => sui().ledgerService.getObject({ objectId: poolId, readMask: { paths: ['object_type', 'json'] } }));
  const v = field(response.object.json, 'current_sqrt_price');
  if (!v?.stringValue) throw new Error(`Pool ${poolId} has no current_sqrt_price`);
  return { sqrt: BigInt(v.stringValue), type: response.object.objectType };
}

/**
 * Cetus stores sqrt(price) as a Q64.64 fixed-point number.
 * Returns how many whole coin_b one whole coin_a is worth, after adjusting for decimals.
 */
export function bPerAFromSqrt(sqrt, decA, decB) {
  const s = Number(BigInt(sqrt)) / 2 ** 64;
  return s * s * 10 ** (decA - decB);
}

async function poolPrice(asset) {
  const p = POOLS[asset];
  const { sqrt, type } = await sqrtPrice(p.id);
  return { bPerA: bPerAFromSqrt(sqrt, p.decA, p.decB), type, ...p };
}

/** USD price of an asset, read from onchain pool state. */
export async function getPrice(asset) {
  if (!POOLS[asset]) throw new Error(`Unsupported asset ${asset}. Use one of ${ASSETS.join(', ')}`);
  const suiPool = await poolPrice('SUI'); // SUI per USDC
  const suiUsd = 1 / suiPool.bPerA;
  let usd = suiUsd;
  const pools = [suiPool.id];
  if (asset !== 'SUI') {
    const pool = await poolPrice(asset);
    if (!pool.type.includes('::wal::WAL')) throw new Error(`Pool for ${asset} is not a WAL pool`);
    usd = pool.bPerA * suiUsd; // SUI per WAL × USD per SUI
    pools.push(pool.id);
  }
  const stamp = await getStamp();
  return { asset, usd, pools, checkpoint: stamp.checkpoint, timestamp: stamp.timestamp, source: 'Cetus pool state on Sui Mainnet, read via Tatum gRPC' };
}
