/**
 * x402 Server — Sentinel Chain Operations
 *
 * Handles all Sentinel chain interactions:
 * - Wallet creation from operator mnemonic
 * - Subscription sharing (add agent to plan)
 * - Fee grant creation (agent pays 0 gas on Sentinel)
 * - Subscription pool management (8 allocations per subscription)
 */

import { request as httpsRequest } from 'node:https';

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

const buildRevokeFeeGrantMsg = (sdk as any).buildRevokeFeeGrantMsg as (
  granter: string, grantee: string,
) => EncodedMsg;

// RPC query helpers (RPC-first per global rules) — exported from blue-js-sdk at
// runtime but missing from types/index.d.ts, same situation as buildMsg* above.
const createRpcQueryClient = (sdk as any).createRpcQueryClient as
  (rpcUrl?: string) => Promise<{ queryClient: unknown }>;
const createRpcQueryClientWithFallback = (sdk as any).createRpcQueryClientWithFallback as
  () => Promise<{ queryClient: unknown; url: string }>;
const rpcQueryNodesForPlan = (sdk as any).rpcQueryNodesForPlan as (
  client: unknown, planId: number, opts?: { status?: number; limit?: number },
) => Promise<{ address: string; remote_addrs: string[] }[]>;
const rpcQueryBalance = (sdk as any).rpcQueryBalance as (
  client: unknown, address: string, denom?: string,
) => Promise<{ denom: string; amount: string }>;
const rpcQueryPlan = (sdk as any).rpcQueryPlan as (
  client: unknown, planId: number,
) => Promise<Uint8Array | null>;

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

// ─── RPC Client ───
// One shared query client, reset on failure so the next call reconnects.

let rpcClient: { queryClient: unknown } | null = null;

async function getRpcClient(): Promise<{ queryClient: unknown }> {
  if (rpcClient) return rpcClient;
  try {
    rpcClient = await createRpcQueryClient(SENTINEL_RPC);
  } catch (err) {
    console.warn(`[sentinel] RPC connect to ${SENTINEL_RPC} failed (${(err as Error).message}), trying SDK fallback list...`);
    rpcClient = await createRpcQueryClientWithFallback();
  }
  return rpcClient;
}

function resetRpcClient(): void {
  rpcClient = null;
}

// ─── Plan Price ───
// MsgStartSubscription requires the operator to deposit the plan price in
// spendable udvpn. The SDK's rpcQueryPlan returns the raw sentinel.plan.v3.Plan
// protobuf, so we scan it for the Price message:
//   Price { 1: denom (string), 2: base_value (Dec string), 3: quote_value (udvpn Int string) }
// quote_value is the udvpn cost (the on-chain deposit is ~0.8x of it after the
// staking share, so quote_value is a safe conservative threshold).

function readVarint(buf: Uint8Array, pos: number): { value: bigint; pos: number } {
  let value = 0n;
  let shift = 0n;
  while (pos < buf.length) {
    const byte = buf[pos++];
    value |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if ((byte & 0x80) === 0) return { value, pos };
  }
  throw new Error('truncated varint');
}

function tryParsePriceMsg(bytes: Uint8Array, denom: string): bigint | null {
  const fields: Record<number, string> = {};
  let pos = 0;
  try {
    while (pos < bytes.length) {
      const tag = readVarint(bytes, pos);
      pos = tag.pos;
      const fieldNum = Number(tag.value >> 3n);
      if (Number(tag.value & 7n) !== 2) return null; // Price fields are all length-delimited
      const len = readVarint(bytes, pos);
      pos = len.pos;
      const end = pos + Number(len.value);
      if (end > bytes.length) return null;
      fields[fieldNum] = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(pos, end));
      pos = end;
    }
  } catch (err) {
    return null; // not a Price message — caller keeps scanning
  }
  if (fields[1] !== denom) return null;
  if (/^\d+$/.test(fields[3] || '')) return BigInt(fields[3]); // v3 Price.quote_value
  if (/^\d+$/.test(fields[2] || '')) return BigInt(fields[2]); // legacy Coin.amount
  return null;
}

function parsePlanPriceUdvpn(planBytes: Uint8Array): bigint | null {
  let pos = 0;
  try {
    while (pos < planBytes.length) {
      const tag = readVarint(planBytes, pos);
      pos = tag.pos;
      const wireType = Number(tag.value & 7n);
      if (wireType === 0) {
        pos = readVarint(planBytes, pos).pos;
      } else if (wireType === 1) {
        pos += 8;
      } else if (wireType === 5) {
        pos += 4;
      } else if (wireType === 2) {
        const len = readVarint(planBytes, pos);
        pos = len.pos;
        const end = pos + Number(len.value);
        if (end > planBytes.length) return null;
        const price = tryParsePriceMsg(planBytes.subarray(pos, end), 'udvpn');
        if (price !== null) return price;
        pos = end;
      } else {
        return null;
      }
    }
  } catch (err) {
    console.warn('[sentinel] Plan protobuf scan failed:', (err as Error).message);
  }
  return null;
}

let cachedPlanPriceUdvpn: bigint | null = null;
let planPriceCacheTime = 0;
const PLAN_PRICE_CACHE_TTL = 3_600_000; // 1 hour — oracle quote drifts slowly

async function getPlanPriceUdvpn(): Promise<bigint | null> {
  if (cachedPlanPriceUdvpn !== null && Date.now() - planPriceCacheTime < PLAN_PRICE_CACHE_TTL) {
    return cachedPlanPriceUdvpn;
  }
  try {
    const client = await getRpcClient();
    const raw = await rpcQueryPlan(client, PLAN_ID);
    if (!raw) throw new Error(`plan ${PLAN_ID} not found via RPC`);
    const price = parsePlanPriceUdvpn(raw);
    if (price === null) throw new Error('no udvpn price found in plan message');
    cachedPlanPriceUdvpn = price;
    planPriceCacheTime = Date.now();
    return price;
  } catch (err) {
    console.warn('[sentinel] Plan price lookup failed:', (err as Error).message);
    resetRpcClient();
    return cachedPlanPriceUdvpn; // stale value beats no value
  }
}

function formatP2p(udvpn: bigint): string {
  return `${(Number(udvpn) / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })} P2P`;
}

async function getOperatorSpendableUdvpn(): Promise<bigint | null> {
  try {
    const client = await getRpcClient();
    const balance = await rpcQueryBalance(client, operatorAddress, 'udvpn');
    return BigInt(balance.amount);
  } catch (err) {
    console.warn('[sentinel] Operator balance query failed:', (err as Error).message);
    resetRpcClient();
    return null;
  }
}

// ─── Capacity Check ───
// Used by the pre-payment middleware: if the pool is full AND the operator
// cannot fund a new subscription, reject BEFORE the agent pays.

export interface CapacityStatus {
  ok: boolean;
  reason: string;
  poolSlotAvailable: boolean;
  operatorSpendableUdvpn: string | null;
  newSubscriptionCostUdvpn: string | null;
}

let capacityCache: { result: CapacityStatus; time: number } | null = null;
const CAPACITY_CACHE_TTL = 60_000;

export async function checkProvisioningCapacity(): Promise<CapacityStatus> {
  if (capacityCache && Date.now() - capacityCache.time < CAPACITY_CACHE_TTL) {
    return capacityCache.result;
  }

  const poolSlotAvailable = subscriptionPool.some(s => s.allocations < 8);
  let result: CapacityStatus;

  if (poolSlotAvailable) {
    result = {
      ok: true,
      reason: 'subscription pool has a free slot',
      poolSlotAvailable,
      operatorSpendableUdvpn: null,
      newSubscriptionCostUdvpn: null,
    };
  } else {
    const [spendable, price] = [await getOperatorSpendableUdvpn(), await getPlanPriceUdvpn()];
    if (spendable === null || price === null) {
      // Chain query failed — fail open; the provisioning path still never
      // charges on failure (settlement only happens after a 2xx response).
      result = {
        ok: true,
        reason: 'pool full; operator balance/plan price unavailable — allowing optimistically',
        poolSlotAvailable,
        operatorSpendableUdvpn: spendable === null ? null : spendable.toString(),
        newSubscriptionCostUdvpn: price === null ? null : price.toString(),
      };
    } else {
      const ok = spendable >= price;
      result = {
        ok,
        reason: ok
          ? `pool full but operator can fund a new subscription (${formatP2p(spendable)} >= ${formatP2p(price)})`
          : `pool full and operator spendable ${formatP2p(spendable)} is below the new-subscription cost ${formatP2p(price)}`,
        poolSlotAvailable,
        operatorSpendableUdvpn: spendable.toString(),
        newSubscriptionCostUdvpn: price.toString(),
      };
    }
  }

  capacityCache = { result, time: Date.now() };
  return result;
}

// ─── Initialize ───

export async function initSentinel(): Promise<{ address: string; planId: number }> {
  const mnemonic = process.env.SENTINEL_OPERATOR_MNEMONIC;
  if (!mnemonic) {
    throw new Error('SENTINEL_OPERATOR_MNEMONIC is required — operator wallet with P2P for gas');
  }

  // Verify buildMsg functions loaded
  if (!buildMsgShareSubscription || !buildMsgStartSubscription || !buildFeeGrantMsg || !buildRevokeFeeGrantMsg) {
    throw new Error('blue-js-sdk missing required exports (buildMsgShareSubscription, buildFeeGrantMsg, buildRevokeFeeGrantMsg)');
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

  // Surface operator funding state at boot — low spendable P2P is the most
  // likely silent failure mode once the pool fills up.
  const spendable = await getOperatorSpendableUdvpn();
  const price = await getPlanPriceUdvpn();
  if (spendable !== null) {
    const priceLabel = price !== null ? ` (new subscription costs ${formatP2p(price)})` : '';
    console.log(`  Spendable:   ${formatP2p(spendable)}${priceLabel}`);
    if (price !== null && spendable < price) {
      console.warn('  WARNING: operator cannot fund a new subscription — top up before the pool fills.');
    }
  }

  return { address: operatorAddress, planId: PLAN_ID };
}

// ─── Subscription Pool ───

async function refreshSubscriptionPool(): Promise<void> {
  // TECH DEBT: querySubscriptions is LCD-only in blue-js-sdk 2.0.3 — same gap
  // as checkAgentStatus below; migrate when a decoded RPC query lands.
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
  // Pre-check spendable balance so a doomed MsgStartSubscription fails with an
  // actionable error instead of a raw chain log. This is the failure observed
  // live: spendable 9,250 P2P < ~20,779 P2P deposit for plan 41.
  const price = await getPlanPriceUdvpn();
  if (price !== null) {
    const spendable = await getOperatorSpendableUdvpn();
    if (spendable !== null && spendable < price) {
      throw new Error(
        `OPERATOR_BALANCE_LOW: operator spendable balance ${formatP2p(spendable)} is below the `
        + `plan ${PLAN_ID} subscription cost ${formatP2p(price)}. The operator wallet needs more `
        + `liquid (unstaked) P2P before new subscriptions can be created.`,
      );
    }
  }

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
  nodeCountry: string | null;
  nodes: string[];
  sentinelTxHash: string;
  expiresAt: string;
  operatorAddress: string;
  instructions: string;
}

// Builds the provision response. When the agent requested a country, pick a
// node verified (via its /status endpoint) to be in that country; otherwise —
// or if no match is online — fall back to a random plan node. The recommended
// node MUST come from the plan: the shared subscription only works with plan
// nodes, so global SDK country discovery would hand the agent a dead session.
async function buildProvisionResult(opts: {
  sentinelAddr: string;
  days: number;
  subscriptionId: number;
  txHash: string;
  expiresAt: string;
  country?: string;
}): Promise<ProvisionResult> {
  const planNodes = await getPlanNodes();
  let recommended = '';
  let nodeCountry: string | null = null;

  if (opts.country) {
    try {
      const matches = matchNodesByCountry(await getEnrichedPlanNodes(), opts.country);
      if (matches.length > 0) {
        const pick = matches[Math.floor(Math.random() * matches.length)];
        recommended = pick.address;
        nodeCountry = pick.country;
      } else {
        console.warn(`[sentinel] No online plan node matches country "${opts.country}" — falling back to random node`);
      }
    } catch (err) {
      console.warn('[sentinel] Country-aware node pick failed, falling back to random:', (err as Error).message);
    }
  }

  if (!recommended) recommended = pickRandomNode(planNodes) || '';

  return {
    provisioned: true,
    sentinelAddr: opts.sentinelAddr,
    days: opts.days,
    subscriptionId: opts.subscriptionId,
    planId: PLAN_ID,
    feeGranter: operatorAddress,
    nodeAddress: recommended,
    nodeCountry,
    nodes: planNodes.map(n => n.address),
    sentinelTxHash: opts.txHash,
    expiresAt: opts.expiresAt,
    operatorAddress,
    instructions: `import { connect } from 'blue-js-sdk/ai-path'; await connect({ mnemonic, protocol: 'v2ray', nodeAddress: '${recommended}', subscriptionId: '${opts.subscriptionId}', feeGranter: '${operatorAddress}' }); // protocol:'v2ray' = no admin; binary auto-installs. gas paid by feeGranter.`,
  };
}

// MsgGrantAllowance hard-fails when the grantee already holds a fee grant
// (a re-paying agent), and atomicity takes MsgShareSubscription down with it —
// observed live 2026-06-12 as a 500 PROVISIONING_FAILED on every repeat
// purchase. Retry once with MsgRevokeAllowance prepended so the stale grant is
// replaced (fresh spend limit + expiry) in the same atomic TX. Fresh agents
// never pay the extra round-trip.
const GRANT_EXISTS = 'fee allowance already exists';

async function broadcastProvision(
  shareMsg: EncodedMsg,
  feeGrantMsg: EncodedMsg,
  sentinelAddr: string,
  memo: string,
): Promise<BroadcastResult> {
  let result: BroadcastResult | null = null;
  let thrown: Error | null = null;
  try {
    result = await safeBroadcast!([shareMsg, feeGrantMsg], memo);
  } catch (err) {
    thrown = err as Error;
  }

  const log = thrown ? thrown.message || '' : result!.code === 0 ? '' : result!.rawLog || '';
  if (!log.includes(GRANT_EXISTS)) {
    if (thrown) throw thrown;
    return result!;
  }

  console.log(`[sentinel] ${sentinelAddr} already has a fee grant — revoking and re-granting...`);
  const revokeMsg = buildRevokeFeeGrantMsg(operatorAddress, sentinelAddr);
  return safeBroadcast!([shareMsg, revokeMsg, feeGrantMsg], memo);
}

/**
 * Provision VPN access for an agent on the Sentinel chain.
 *
 * 1. Get available subscription (or create one)
 * 2. Share subscription with agent's Sentinel address
 * 3. Grant fee allowance so agent pays 0 gas (revoking any stale grant first)
 *
 * All messages batched into a single TX for atomicity.
 */
export async function provisionAgent(
  sentinelAddr: string,
  days: number,
  country?: string,
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
      const result = await broadcastProvision(shareMsg, feeGrantMsg, sentinelAddr, `x402 provision ${days}d`);

      if (result.code === 0) {
        slot.allocations++;
        console.log(`[sentinel] Provisioned! TX: ${result.transactionHash}`);
        return buildProvisionResult({
          sentinelAddr,
          days,
          subscriptionId: slot.id,
          txHash: result.transactionHash,
          expiresAt: expirationDate.toISOString(),
          country,
        });
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

  const result = await broadcastProvision(shareMsg, feeGrantMsg, sentinelAddr, `x402 provision ${days}d`);
  if (result.code !== 0) {
    throw new Error(`Sentinel TX failed on new sub ${subscriptionId} (code ${result.code}): ${result.rawLog}`);
  }

  const slot = subscriptionPool.find(s => s.id === subscriptionId);
  if (slot) slot.allocations++;

  console.log(`[sentinel] Provisioned on new sub ${subscriptionId}! TX: ${result.transactionHash}`);
  return buildProvisionResult({
    sentinelAddr,
    days,
    subscriptionId,
    txHash: result.transactionHash,
    expiresAt: expirationDate.toISOString(),
    country,
  });
}

// ─── Node Discovery ───

let cachedNodes: { address: string; remote_addrs: string[] }[] = [];
let nodesCacheTime = 0;
const NODE_CACHE_TTL = 300_000; // 5 minutes

export async function getPlanNodes(): Promise<{ address: string; remote_addrs: string[] }[]> {
  if (cachedNodes.length > 0 && Date.now() - nodesCacheTime < NODE_CACHE_TTL) {
    return cachedNodes;
  }

  // RPC first (per global rules); explicit limit because the SDK default of
  // 500 silently truncates plans with more nodes.
  try {
    const client = await getRpcClient();
    const nodes = await rpcQueryNodesForPlan(client, PLAN_ID, { status: 1, limit: 5000 });
    cachedNodes = nodes.map(n => ({
      address: n.address,
      remote_addrs: n.remote_addrs || [],
    }));
    nodesCacheTime = Date.now();
    return cachedNodes;
  } catch (err) {
    console.warn('[sentinel] RPC plan-node query failed, falling back to LCD:', (err as Error).message);
    resetRpcClient();
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
    console.warn('[sentinel] LCD plan-node fallback failed:', (err as Error).message);
    return cachedNodes; // return stale cache if available
  }
}

function pickRandomNode(nodes: { address: string }[]): string | undefined {
  if (nodes.length === 0) return undefined;
  return nodes[Math.floor(Math.random() * nodes.length)].address;
}

// ─── Node Geo Enrichment ───
// Each dVPN node serves GET /status on its remote_addr (self-signed TLS by
// design) with location, protocol type (1 = wireguard, 2 = v2ray), moniker and
// peer counts. We probe plan nodes so agents can see WHERE each node is and
// request a country — global SDK country discovery is useless here because the
// shared subscription only works with plan nodes.

export interface EnrichedNode {
  address: string;
  remote_addrs: string[];
  online: boolean;
  country: string | null;
  city: string | null;
  protocol: 'wireguard' | 'v2ray' | null;
  moniker: string | null;
  peers: number | null;
  maxPeers: number | null;
}

const STATUS_PROBE_TIMEOUT = 7_000;

function probeNodeStatus(remoteAddr: string): Promise<Record<string, any> | null> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(remoteAddr);
    } catch (err) {
      console.warn(`[sentinel] Unparseable remote_addr "${remoteAddr}":`, (err as Error).message);
      resolve(null);
      return;
    }

    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: '/status',
        method: 'GET',
        rejectUnauthorized: false, // dVPN nodes use self-signed certs by design
        timeout: STATUS_PROBE_TIMEOUT,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            resolve(json.result || json);
          } catch (err) {
            console.warn(`[sentinel] Node ${url.hostname} returned non-JSON /status:`, (err as Error).message);
            resolve(null);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('status probe timeout')));
    req.on('error', (err) => {
      console.warn(`[sentinel] Status probe failed for ${url.hostname}:${url.port || 443}: ${err.message}`);
      resolve(null);
    });
    req.end();
  });
}

let enrichedCache: EnrichedNode[] = [];
let enrichedCacheTime = 0;
const ENRICHED_CACHE_TTL = 600_000; // 10 minutes — node geo never moves, online flag drifts slowly

export async function getEnrichedPlanNodes(): Promise<EnrichedNode[]> {
  if (enrichedCache.length > 0 && Date.now() - enrichedCacheTime < ENRICHED_CACHE_TTL) {
    return enrichedCache;
  }

  const nodes = await getPlanNodes();
  const enriched = await Promise.all(nodes.map(async (n): Promise<EnrichedNode> => {
    const status = n.remote_addrs[0] ? await probeNodeStatus(n.remote_addrs[0]) : null;
    return {
      address: n.address,
      remote_addrs: n.remote_addrs,
      online: status !== null,
      country: status?.location?.country ?? null,
      city: status?.location?.city ?? null,
      protocol: status?.type === 1 ? 'wireguard' : status?.type === 2 ? 'v2ray' : null,
      moniker: status?.moniker ?? null,
      peers: typeof status?.peers === 'number' ? status.peers : null,
      maxPeers: typeof status?.max_peers === 'number' ? status.max_peers : null,
    };
  }));

  enrichedCache = enriched;
  enrichedCacheTime = Date.now();
  const online = enriched.filter(n => n.online).length;
  console.log(`[sentinel] Enriched ${enriched.length} plan nodes (${online} online) — countries: ${[...new Set(enriched.map(n => n.country).filter(Boolean))].join(', ') || 'unknown'}`);
  return enriched;
}

// Accepts an ISO 3166-1 alpha-2 code ("DE") or a country name ("Germany"),
// case-insensitive. Codes resolve to English names via Intl.DisplayNames —
// node /status reports country as a name.
function countryInputToName(input: string): string {
  const trimmed = input.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) {
    try {
      const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(trimmed.toUpperCase());
      if (name && name !== trimmed.toUpperCase()) return name;
    } catch (err) {
      console.warn(`[sentinel] Could not resolve country code "${trimmed}":`, (err as Error).message);
    }
  }
  return trimmed;
}

export function matchNodesByCountry(nodes: EnrichedNode[], country: string): EnrichedNode[] {
  const want = countryInputToName(country).toLowerCase();
  return nodes.filter(n => {
    if (!n.online || !n.country) return false;
    const have = n.country.toLowerCase();
    return have === want || have.includes(want) || want.includes(have);
  });
}

/**
 * Check if an agent already has an active allocation.
 */
export async function checkAgentStatus(sentinelAddr: string): Promise<{
  hasSubscription: boolean;
  subscriptionId?: number;
}> {
  // TECH DEBT: hasActiveSubscription is LCD-only in blue-js-sdk 2.0.3 — the RPC
  // equivalent (rpcQuerySubscriptionsForAccount) returns raw Any bytes without a
  // decoder. Migrate when the SDK ships a decoded RPC subscription query.
  try {
    const result = await hasActiveSubscription(sentinelAddr, PLAN_ID, SENTINEL_LCD);
    return {
      hasSubscription: result.has,
      subscriptionId: result.subscription
        ? Number((result.subscription as any).id || (result.subscription as any).base_subscription?.id)
        : undefined,
    };
  } catch (err) {
    console.warn(`[sentinel] Agent status query failed for ${sentinelAddr}:`, (err as Error).message);
    return { hasSubscription: false };
  }
}
