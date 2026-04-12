import type { Db } from './db/index.js';
import type { Config } from './config.js';
import { X402Error, ErrorCodes } from './errors.js';

// ─── SDK Path ───

const SDK_PATH = '../../../Sentinel SDK/js-sdk';

// ─── Constants ───

const FEE_GRANT_BUDGET = 5_000_000;         // 5 P2P gas (~25 session starts)
const ALLOCATION_BYTES = 1_000_000_000_000;  // 1 TB (unlimited for time-based)
const EXPIRY_BUFFER_MS = 86_400_000;         // 24h buffer beyond paid hours

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

export async function provisionAgent(
  operator: SentinelOperator,
  db: Db,
  config: Config,
  agentSentinelAddr: string,
  hours: number,
  paymentTxHash: string,
): Promise<ProvisionResult> {
  // 1. Atomic: grab a subscription slot (prevents race conditions)
  const sub = db.allocateSubscriptionSlot(config.sentinelPlanId);

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

  const expirationDate = new Date(Date.now() + hours * 3600_000 + EXPIRY_BUFFER_MS);

  const shareMsg = buildMsgShareSubscription({
    from: operator.address,
    id: Number(sub.subscription_id),
    accAddress: agentSentinelAddr,
    bytes: ALLOCATION_BYTES,
  });

  const grantMsg = buildFeeGrantMsg(operator.address, agentSentinelAddr, {
    spendLimit: FEE_GRANT_BUDGET,
    expiration: expirationDate,
  });

  // 3. Broadcast both in one atomic TX
  const result = await operator.safeBroadcast(
    [shareMsg, grantMsg],
    `x402: provision ${agentSentinelAddr} for ${hours}h`,
  );

  if (result.code !== 0) {
    // Sentinel TX failed — subscription slot was already allocated in DB.
    // The retry queue will handle re-attempting. The slot is consumed but
    // that's acceptable (pool has spare capacity).
    throw new X402Error(
      ErrorCodes.SENTINEL_TX_FAILED,
      `Sentinel TX failed (code ${result.code}): ${result.rawLog || 'unknown'}`,
      500,
      { code: result.code, rawLog: result.rawLog },
    );
  }

  // 4. Update payment status
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
