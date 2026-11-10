// Sui Mainnet access through Tatum's gRPC gateway.
// Tatum has moved Sui from JSON-RPC to gRPC, so we use the official Sui gRPC client
// with a native gRPC transport and the Tatum API key in the request metadata.
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { GrpcTransport } from '@protobuf-ts/grpc-transport';
import { ChannelCredentials } from '@grpc/grpc-js';

const TATUM_SUI_GRPC = 'sui-mainnet-grpc.gateway.tatum.io:443';

let client;
export function sui() {
  if (!client) {
    if (!process.env.TATUM_API_KEY) throw new Error('TATUM_API_KEY is missing in .env');
    const transport = new GrpcTransport({
      host: TATUM_SUI_GRPC,
      channelCredentials: ChannelCredentials.createSsl(),
      meta: { 'x-api-key': process.env.TATUM_API_KEY },
    });
    client = new SuiGrpcClient({ network: 'mainnet', transport });
  }
  return client;
}

// Tatum's free plan allows 3 requests/second. Space calls out and retry politely on 429.
const GAP_MS = 380;
let chain = Promise.resolve();
let last = 0;
export function limited(fn) {
  const run = chain.then(async () => {
    for (let attempt = 0; ; attempt++) {
      const wait = last + GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      try {
        return await fn();
      } catch (e) {
        if (attempt < 3 && /429|UNAVAILABLE/.test(`${e.message} ${e.code}`)) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
  });
  chain = run.catch(() => {});
  return run;
}

const toIso =(ts) => new Date(Number(ts.seconds) * 1000 + Math.floor((ts.nanos || 0) / 1e6)).toISOString();

/**
 * Proof-of-time stamp: the latest Sui Mainnet checkpoint at the moment a pick is logged.
 * Anyone can look up the checkpoint on a Sui explorer and confirm the pick existed by then.
 */
export async function getStamp() {
  const { response: info } = await limited(() => sui().ledgerService.getServiceInfo({}));
  const stamp = {
    network: info.chain,
    chainId: info.chainId,
    checkpoint: info.checkpointHeight.toString(),
    timestamp: toIso(info.timestamp),
    digest: null,
  };
  try {
    const { response } = await limited(() =>
      sui().ledgerService.getCheckpoint({
        checkpointId: { oneofKind: 'sequenceNumber', sequenceNumber: info.checkpointHeight },
        readMask: { paths: ['sequence_number', 'digest'] },
      }),
    );
    stamp.digest = response.checkpoint?.digest ?? null;
  } catch {
    // Digest is a bonus; height + timestamp + chain id already pin the moment.
  }
  return stamp;
}
