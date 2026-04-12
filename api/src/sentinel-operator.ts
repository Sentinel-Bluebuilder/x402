import type { Config } from './config.js';
import type { SentinelOperator } from './sentinel-tx.js';

// ─── SDK Path ───
// blue-js-sdk is referenced via relative path (same as all other projects).

const SDK_PATH = '../../../Sentinel SDK/js-sdk';

// ─── Initialize Sentinel Operator ───

export async function initSentinelOperator(config: Config): Promise<SentinelOperator> {
  const { createWallet } = await import(`${SDK_PATH}/chain/wallet.js`);
  const { createSafeBroadcaster } = await import(`${SDK_PATH}/chain/broadcast.js`);

  const { wallet, account } = await createWallet(config.sentinelOperatorMnemonic);
  const address: string = account.address;

  console.log(`[x402] Sentinel operator wallet: ${address}`);

  const broadcaster = createSafeBroadcaster(config.sentinelRpcUrl, wallet, address);

  return {
    address,
    safeBroadcast: async (msgs: unknown[], memo?: string) => {
      const result = await broadcaster.safeBroadcast(msgs, memo);
      return {
        transactionHash: result.transactionHash,
        code: result.code,
        rawLog: result.rawLog,
      };
    },
  };
}
