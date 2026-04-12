import type { Db } from './db/index.js';
import type { Config } from './config.js';
import { X402Error, ErrorCodes } from './errors.js';

// ─── SDK Path ───

const SDK_PATH = '../../../Sentinel SDK/js-sdk';

// ─── Types ───

export interface SentinelOperator {
  address: string;
  safeBroadcast: (msgs: unknown[], memo?: string) => Promise<{ transactionHash: string; code: number; rawLog?: string }>;
}

interface ProvisionResult {
  txHash: string;
  subscriptionId: string;
}

// ─── Provision Agent ───
// Adds agent to our subscription + grants fee allowance in ONE atomic TX.

export async function provisionAgent(
  operator: SentinelOperator,
  db: Db,
  config: Config,
  agentSentinelAddr: string,
  hours: number,
  paymentTxHash: string,
): Promise<ProvisionResult> {
  // 1. Get available subscription from pool
  const sub = db.getAvailableSubscription(config.sentinelPlanId);

  if (!sub) {
    throw new X402Error(
      ErrorCodes.POOL_EXHAUSTED,
      'No available subscriptions in pool. Operator must create new subscriptions.',
      503,
    );
  }

  // 2. Build messages using blue-js-sdk
  const { buildMsgShareSubscription } = await import(`${SDK_PATH}/protocol/messages.js`);
  const { buildFeeGrantMsg } = await import(`${SDK_PATH}/chain/fee-grants.js`);

  const expirationDate = new Date(Date.now() + hours * 3600_000 + 86400_000); // paid hours + 24h buffer

  const shareMsg = buildMsgShareSubscription({
    from: operator.address,
    id: Number(sub.subscription_id),
    accAddress: agentSentinelAddr,
    bytes: 1_000_000_000_000, // 1 TB — effectively unlimited for time-based
  });

  const grantMsg = buildFeeGrantMsg(operator.address, agentSentinelAddr, {
    spendLimit: 5_000_000, // 5 P2P gas budget (~25 session starts)
    expiration: expirationDate,
  });

  // 3. Broadcast both in one atomic TX
  const result = await operator.safeBroadcast(
    [shareMsg, grantMsg],
    `x402: provision ${agentSentinelAddr} for ${hours}h`,
  );

  if (result.code !== 0) {
    throw new X402Error(
      ErrorCodes.SENTINEL_TX_FAILED,
      `Sentinel TX failed: ${result.rawLog || 'unknown error'}`,
      500,
      { code: result.code, rawLog: result.rawLog },
    );
  }

  // 4. Record allocation in pool
  db.recordAllocation(sub.subscription_id);

  // 5. Update payment status
  db.updatePaymentStatus(paymentTxHash, 'allocated', {
    sentinelTxHash: result.transactionHash,
    subscriptionId: sub.subscription_id,
  });

  console.log(`[x402] Provisioned ${agentSentinelAddr} on sub ${sub.subscription_id} — TX: ${result.transactionHash}`);

  return {
    txHash: result.transactionHash,
    subscriptionId: sub.subscription_id,
  };
}
