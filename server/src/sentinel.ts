/**
 * x402 Server — Sentinel Chain Operations
 *
 * Handles all Sentinel chain interactions:
 * - Wallet creation from operator mnemonic
 * - Subscription sharing (add agent to plan)
 * - Fee grant creation (agent pays 0 gas on Sentinel)
 * - Subscription pool management (8 allocations per subscription)
 */

import {
  createWallet,
  createSafeBroadcaster,
  querySubscriptions,
  hasActiveSubscription,
  queryPlanNodes,
} from 'blue-js-sdk';

// buildMsg* functions are exported from blue-js-sdk at runtime but lack type declarations.
// Import the full module and extract them with type assertions.
import * as sdk from 'blue-js-sdk';

// ─── Types ───

type EncodedMsg = { typeUrl: string; value: unknown };
type BroadcastResult = { code: number; transactionHash: string; rawLog?: string };

// Build MsgShareSubscription manually — the SDK exports buildMsgShareSubscription
// with an acc_address (snake_case) shape while its internal encoder reads accAddress
// (camelCase). Including both keys keeps the encoder happy regardless of which form
// it consumes.
function buildMsgShareSubscription(opts: {
  from: string; id: number; accAddress: string; bytes: number;
}): EncodedMsg {
  return {
    typeUrl: '/sentinel.subscription.v3.MsgShareSubscriptionRequest',
    value: {
      from: opts.from,
      id: opts.id,
      accAddress: opts.accAddress,
      acc_address: opts.accAddress,
      bytes: opts.bytes,
    },
  };
}

const buildMsgStartSubscription = (sdk as any).buildMsgStartSubscription as (opts: {
  from: string; id: number; denom?: string; renewalPricePolicy?: number;
}) => EncodedMsg;

const buildFeeGrantMsg = (sdk as any).buildFeeGrantMsg as (
  granter: string, grantee: string, opts?: {
    spendLimit?: number; expiration?: Date; allowedMessages?: string[];
  },
) => EncodedMsg;

// ─── Config ───

const SENTINEL_RPC = process.env.SENTINEL_RPC_URL || 'https://rpc.sentinel.co:443';
const SENTINEL_LCD = process.env.SENTINEL_LCD_URL || 'https://lcd.sentinel.co';
const PLAN_ID = parseInt(process.env.SENTINEL_PLAN_ID || '42', 10);

// Bytes to allocate per share — Plan 42 has 10 GB total quota
// 1 GB per agent, supports ~10 agents per subscription
const SHARE_BYTES = 1_000_000_000; // 1 GB

// Fee grant budget per agent — covers ~25 session starts
const FEE_GRANT_SPEND_LIMIT = 5_000_000; // 5 P2P (udvpn)

// Allowed messages for fee grant — session operations + subscription session start
// MsgCancelSessionRequest is the v3 name for end/cancel session
const FEE_GRANT_ALLOWED_MESSAGES = [
  '/sentinel.subscription.v3.MsgStartSessionRequest',
  '/sentinel.session.v3.MsgCancelSessionRequest',
  '/sentinel.session.v3.MsgUpdateSessionRequest',
  '/sentinel.node.v3.MsgStartSessionRequest',
];

// ─── State ───

let operatorAddress = '';
let safeBroadcast: ((msgs: EncodedMsg[], memo?: string) => Promise<BroadcastResult>) | null = null;

interface SubscriptionSlot {
  id: number;
  allocations: number;
}

const subscriptionPool: SubscriptionSlot[] = [];

// ─── Initialize ───

export async function initSentinel(): Promise<{ address: string; planId: number }> {
  const mnemonic = process.env.SENTINEL_OPERATOR_MNEMONIC;
  if (!mnemonic) {
    throw new Error('SENTINEL_OPERATOR_MNEMONIC is required — operator wallet with P2P for gas');
  }

  // Verify buildMsg functions loaded
  if (!buildMsgShareSubscription || !buildMsgStartSubscription || !buildFeeGrantMsg) {
    throw new Error('blue-js-sdk missing required exports (buildMsgShareSubscription, buildFeeGrantMsg)');
  }

  const { wallet, account } = await createWallet(mnemonic);
  operatorAddress = account.address;

  const broadcaster = createSafeBroadcaster(SENTINEL_RPC, wallet, operatorAddress);
  safeBroadcast = broadcaster.safeBroadcast as unknown as typeof safeBroadcast;

  // Load existing subscriptions for pool management
  await refreshSubscriptionPool();

  console.log(`  Sentinel:    ${operatorAddress}`);
  console.log(`  Plan:        ${PLAN_ID}`);
  console.log(`  Subs pool:   ${subscriptionPool.length} active`);

  return { address: operatorAddress, planId: PLAN_ID };
}

// ─── Subscription Pool ───

async function refreshSubscriptionPool(): Promise<void> {
  try {
    const result = await querySubscriptions(SENTINEL_LCD, operatorAddress, { status: 'active' });
    const subs = (result as any).items || (result as any).subscriptions || [];

    subscriptionPool.length = 0;
    for (const sub of subs) {
      const id = Number(sub.id || sub.base_subscription?.id);
      const planId = Number(sub.plan_id || sub.base_subscription?.plan_id);
      // Only include subscriptions for OUR plan
      if (id > 0 && planId === PLAN_ID) {
        subscriptionPool.push({ id, allocations: 0 });
      }
    }
  } catch (err) {
    console.warn('[sentinel] Failed to refresh subscription pool:', (err as Error).message);
  }
}

/**
 * Create a new subscription to the plan on-chain.
 */
async function createNewSubscription(): Promise<number> {
  console.log(`[sentinel] Creating new subscription for plan ${PLAN_ID}...`);
  const msg = buildMsgStartSubscription({
    from: operatorAddress,
    id: PLAN_ID,
    denom: 'udvpn',
    renewalPricePolicy: 0,
  });

  const result = await safeBroadcast!([msg], 'x402 new subscription');
  if (result.code !== 0) {
    throw new Error(`Failed to create subscription: ${result.rawLog}`);
  }

  const subId = parseSubscriptionIdFromLog(result.rawLog || '');
  if (!subId) {
    await refreshSubscriptionPool();
    const newest = subscriptionPool[subscriptionPool.length - 1];
    if (newest) return newest.id;
    throw new Error('Created subscription but could not determine ID');
  }

  subscriptionPool.push({ id: subId, allocations: 0 });
  console.log(`[sentinel] Created subscription ${subId}`);
  return subId;
}

function parseSubscriptionIdFromLog(rawLog: string): number | null {
  const match = rawLog.match(/subscription[_-]id[":\s]+(\d+)/i)
    || rawLog.match(/"id":"(\d+)"/);
  return match ? parseInt(match[1], 10) : null;
}

// ─── Provisioning ───

export interface ProvisionResult {
  provisioned: boolean;
  sentinelAddr: string;
  days: number;
  subscriptionId: number;
  planId: number;
  feeGranter: string;
  nodeAddress: string;
  nodes: string[];
  sentinelTxHash: string;
  expiresAt: string;
  operatorAddress: string;
  instructions: string;
}

/**
 * Provision VPN access for an agent on the Sentinel chain.
 *
 * 1. Get available subscription (or create one)
 * 2. Share subscription with agent's Sentinel address
 * 3. Grant fee allowance so agent pays 0 gas
 *
 * Both messages batched into a single TX for atomicity.
 */
export async function provisionAgent(
  sentinelAddr: string,
  days: number,
): Promise<ProvisionResult> {
  if (!safeBroadcast) {
    throw new Error('Sentinel not initialized — call initSentinel() first');
  }

  if (!sentinelAddr || !sentinelAddr.startsWith('sent1')) {
    throw new Error('Invalid Sentinel address — must start with sent1');
  }

  const expirationDate = new Date(Date.now() + days * 86_400_000 + 86_400_000);
  const feeGrantMsg = buildFeeGrantMsg(operatorAddress, sentinelAddr, {
    spendLimit: FEE_GRANT_SPEND_LIMIT,
    expiration: expirationDate,
    allowedMessages: FEE_GRANT_ALLOWED_MESSAGES,
  });

  // Try each subscription in the pool; skip depleted ones
  const triedSubs: number[] = [];

  for (const slot of subscriptionPool) {
    if (slot.allocations >= 8) continue;

    const shareMsg = buildMsgShareSubscription({
      from: operatorAddress,
      id: slot.id,
      accAddress: sentinelAddr,
      bytes: SHARE_BYTES,
    });

    console.log(`[sentinel] Provisioning ${days}d for ${sentinelAddr} (sub ${slot.id})...`);

    try {
      const result = await safeBroadcast([shareMsg, feeGrantMsg], `x402 provision ${days}d`);

      if (result.code === 0) {
        slot.allocations++;
        console.log(`[sentinel] Provisioned! TX: ${result.transactionHash}`);
        const planNodes = await getPlanNodes();
        const recommended = pickRandomNode(planNodes) || '';
        return {
          provisioned: true,
          sentinelAddr,
          days,
          subscriptionId: slot.id,
          planId: PLAN_ID,
          feeGranter: operatorAddress,
          nodeAddress: recommended,
          nodes: planNodes.map(n => n.address),
          sentinelTxHash: result.transactionHash,
          expiresAt: expirationDate.toISOString(),
          operatorAddress,
          instructions: `import { connect } from 'blue-agent-connect'; await connect({ mnemonic, nodeAddress: '${recommended}', subscriptionId: '${slot.id}', feeGranter: '${operatorAddress}' })`,
        };
      }

      // Non-zero code returned (rare — safeBroadcast usually throws)
      const rawLog = result.rawLog || '';
      if (rawLog.includes('insufficient bytes')) {
        console.warn(`[sentinel] Sub ${slot.id} depleted (code ${result.code}), trying next...`);
        slot.allocations = 99;
        triedSubs.push(slot.id);
        continue;
      }
      throw new Error(`Sentinel TX failed (code ${result.code}): ${rawLog}`);
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('insufficient bytes')) {
        console.warn(`[sentinel] Sub ${slot.id} depleted, trying next...`);
        slot.allocations = 99;
        triedSubs.push(slot.id);
        continue;
      }
      throw err; // non-recoverable error
    }
  }

  // All existing subs exhausted — create a new one
  console.log(`[sentinel] All subs depleted (tried: ${triedSubs.join(', ')}), creating new sub for plan ${PLAN_ID}...`);
  const subscriptionId = await createNewSubscription();

  const shareMsg = buildMsgShareSubscription({
    from: operatorAddress,
    id: subscriptionId,
    accAddress: sentinelAddr,
    bytes: SHARE_BYTES,
  });

  const result = await safeBroadcast([shareMsg, feeGrantMsg], `x402 provision ${days}d`);
  if (result.code !== 0) {
    throw new Error(`Sentinel TX failed on new sub ${subscriptionId} (code ${result.code}): ${result.rawLog}`);
  }

  const slot = subscriptionPool.find(s => s.id === subscriptionId);
  if (slot) slot.allocations++;

  console.log(`[sentinel] Provisioned on new sub ${subscriptionId}! TX: ${result.transactionHash}`);
  const planNodes = await getPlanNodes();
  const recommended = pickRandomNode(planNodes) || '';
  return {
    provisioned: true,
    sentinelAddr,
    days,
    subscriptionId,
    planId: PLAN_ID,
    feeGranter: operatorAddress,
    nodeAddress: recommended,
    nodes: planNodes.map(n => n.address),
    sentinelTxHash: result.transactionHash,
    expiresAt: expirationDate.toISOString(),
    operatorAddress,
    instructions: `import { connect } from 'blue-agent-connect'; await connect({ mnemonic, nodeAddress: '${recommended}', subscriptionId: '${subscriptionId}', feeGranter: '${operatorAddress}' })`,
  };
}

// ─── Node Discovery ───

let cachedNodes: { address: string; remote_addrs: string[] }[] = [];
let nodesCacheTime = 0;
const NODE_CACHE_TTL = 300_000; // 5 minutes

export async function getPlanNodes(): Promise<{ address: string; remote_addrs: string[] }[]> {
  if (cachedNodes.length > 0 && Date.now() - nodesCacheTime < NODE_CACHE_TTL) {
    return cachedNodes;
  }

  try {
    const result = await queryPlanNodes(PLAN_ID, SENTINEL_LCD);
    const items = (result as any).items || [];
    cachedNodes = items.map((n: any) => ({
      address: n.address,
      remote_addrs: n.remote_addrs || [],
    }));
    nodesCacheTime = Date.now();
    return cachedNodes;
  } catch (err) {
    console.warn('[sentinel] Failed to query plan nodes:', (err as Error).message);
    return cachedNodes; // return stale cache if available
  }
}

function pickRandomNode(nodes: { address: string }[]): string | undefined {
  if (nodes.length === 0) return undefined;
  return nodes[Math.floor(Math.random() * nodes.length)].address;
}

/**
 * Check if an agent already has an active allocation.
 */
export async function checkAgentStatus(sentinelAddr: string): Promise<{
  hasSubscription: boolean;
  subscriptionId?: number;
}> {
  try {
    const result = await hasActiveSubscription(sentinelAddr, PLAN_ID, SENTINEL_LCD);
    return {
      hasSubscription: result.has,
      subscriptionId: result.subscription
        ? Number((result.subscription as any).id || (result.subscription as any).base_subscription?.id)
        : undefined,
    };
  } catch {
    return { hasSubscription: false };
  }
}
