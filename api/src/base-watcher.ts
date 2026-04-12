import { ethers } from 'ethers';
import type { Db } from './db/index.js';
import type { Config } from './config.js';
import type { SentinelOperator } from './sentinel-tx.js';
import { provisionAgent } from './sentinel-tx.js';
import { ErrorCodes } from './errors.js';

// ─── Contract ABI (only what we need) ───

const PAYMENT_ABI = [
  'event VpnPayment(address indexed sender, string agentId, uint256 numHours, uint256 amount, uint256 timestamp)',
];

// ─── Event Processing ───

async function processPaymentEvent(
  agentId: string,
  numHours: number,
  amount: bigint,
  txHash: string,
  sender: string,
  db: Db,
  config: Config,
  operator: SentinelOperator | null,
): Promise<void> {
  // 1. Dedup — already processed?
  const existing = db.getPaymentByTxHash(txHash);
  if (existing) {
    console.log(`[x402] Skipping duplicate payment: ${txHash}`);
    return;
  }

  // 2. Resolve agentId → sentinel address
  const agent = db.getAgentById(agentId);
  if (!agent) {
    console.error(`[x402] Unknown agentId in payment event: ${agentId} (tx: ${txHash})`);
    db.insertPayment(txHash, 'base', agentId, null, numHours, Number(amount));
    db.updatePaymentStatus(txHash, 'failed', { error: 'Agent not registered' });
    return;
  }

  // 3. Verify amount matches expected
  const expectedAmount = BigInt(numHours) * BigInt(config.pricePerHourUsdc);
  if (amount < expectedAmount) {
    console.error(`[x402] Amount mismatch: got ${amount}, expected ${expectedAmount} (tx: ${txHash})`);
    db.insertPayment(txHash, 'base', agentId, agent.sentinel_address, numHours, Number(amount));
    db.updatePaymentStatus(txHash, 'failed', { error: `Amount mismatch: ${amount} < ${expectedAmount}` });
    return;
  }

  // 4. Insert payment as verified
  db.insertPayment(txHash, 'base', agentId, agent.sentinel_address, numHours, Number(amount));
  db.updatePaymentStatus(txHash, 'verified');

  console.log(`[x402] Payment verified: ${agentId} → ${agent.sentinel_address}, ${numHours}h, ${amount} USDC atomic (tx: ${txHash})`);

  // 5. Provision on Sentinel
  if (!operator) {
    console.log(`[x402] Sentinel operator not configured — payment recorded but not provisioned`);
    return;
  }

  try {
    const result = await provisionAgent(operator, db, config, agent.sentinel_address, numHours, txHash);
    console.log(`[x402] Agent provisioned: ${agent.sentinel_address} on sub ${result.subscriptionId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[x402] Sentinel provisioning failed: ${msg}`);
    db.updatePaymentStatus(txHash, 'failed', { error: msg });
    // TODO: Add to retry queue
  }
}

// ─── Watcher ───

export function startBaseWatcher(
  db: Db,
  config: Config,
  operator: SentinelOperator | null,
): { stop: () => void } {
  if (!config.paymentContractAddress) {
    console.log('[x402] No PAYMENT_CONTRACT_ADDRESS — Base watcher disabled');
    return { stop: () => {} };
  }

  console.log(`[x402] Starting Base watcher for contract ${config.paymentContractAddress}`);

  // Prefer WebSocket, fall back to polling
  const providerUrl = config.baseWsUrl || config.baseRpcUrl;
  const provider = providerUrl.startsWith('wss')
    ? new ethers.WebSocketProvider(providerUrl)
    : new ethers.JsonRpcProvider(providerUrl);

  const contract = new ethers.Contract(config.paymentContractAddress, PAYMENT_ABI, provider);

  // Listen for VpnPayment events
  const handler = async (
    sender: string,
    agentId: string,
    numHours: bigint,
    amount: bigint,
    timestamp: bigint,
    event: ethers.EventLog,
  ) => {
    const txHash = event.transactionHash;
    console.log(`[x402] VpnPayment event: agent=${agentId} hours=${numHours} amount=${amount} tx=${txHash}`);

    try {
      await processPaymentEvent(
        agentId,
        Number(numHours),
        amount,
        txHash,
        sender,
        db,
        config,
        operator,
      );
    } catch (err) {
      console.error(`[x402] Error processing payment event:`, err);
    }
  };

  contract.on('VpnPayment', handler);

  // Catch-up: scan recent blocks for missed events on startup
  catchUpMissedEvents(contract, db, config, operator).catch(err => {
    console.error('[x402] Catch-up scan failed:', err);
  });

  return {
    stop: () => {
      contract.off('VpnPayment', handler);
      if ('destroy' in provider) (provider as ethers.WebSocketProvider).destroy();
    },
  };
}

// ─── Catch-Up (Startup) ───

async function catchUpMissedEvents(
  contract: ethers.Contract,
  db: Db,
  config: Config,
  operator: SentinelOperator | null,
): Promise<void> {
  const LOOKBACK_BLOCKS = 1000; // ~33 minutes on Base (2s blocks)

  try {
    const provider = contract.runner?.provider;
    if (!provider) return;

    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - LOOKBACK_BLOCKS);

    console.log(`[x402] Scanning blocks ${fromBlock}–${currentBlock} for missed events...`);

    const filter = contract.filters.VpnPayment();
    const events = await contract.queryFilter(filter, fromBlock, currentBlock);

    let processed = 0;
    for (const event of events) {
      if (!('args' in event)) continue;
      const log = event as ethers.EventLog;
      const [sender, agentId, numHours, amount] = log.args;
      const txHash = log.transactionHash;

      // Skip already processed
      if (db.getPaymentByTxHash(txHash)) continue;

      await processPaymentEvent(agentId, Number(numHours), amount, txHash, sender, db, config, operator);
      processed++;
    }

    if (processed > 0) {
      console.log(`[x402] Catch-up: processed ${processed} missed events`);
    } else {
      console.log(`[x402] Catch-up: no missed events`);
    }
  } catch (err) {
    console.error('[x402] Catch-up error:', err);
  }
}
