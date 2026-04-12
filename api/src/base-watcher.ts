import { ethers } from 'ethers';
import type { Db } from './db/index.js';
import type { Config } from './config.js';
import type { SentinelOperator } from './sentinel-tx.js';
import { provisionAgent } from './sentinel-tx.js';
import { queueRetry } from './retry.js';

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
  db: Db,
  config: Config,
  operator: SentinelOperator | null,
): Promise<void> {
  // 1. Dedup — already processed?
  const existing = db.getPaymentByTxHash(txHash);
  if (existing) return;

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
  const paymentId = db.insertPayment(txHash, 'base', agentId, agent.sentinel_address, numHours, Number(amount));
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
    queueRetry(db, paymentId, msg);
  }
}

// ─── Watcher with Reconnection ───

export function startBaseWatcher(
  db: Db,
  config: Config,
  operator: SentinelOperator | null,
): { stop: () => void } {
  if (!config.paymentContractAddress) {
    console.log('[x402] No PAYMENT_CONTRACT_ADDRESS — Base watcher disabled');
    return { stop: () => {} };
  }

  let stopped = false;
  let provider: ethers.Provider | null = null;
  let contract: ethers.Contract | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  async function connectAndWatch() {
    if (stopped) return;

    try {
      // Clean up previous connection
      if (provider && 'destroy' in provider) {
        (provider as ethers.WebSocketProvider).destroy();
      }

      // Connect
      const providerUrl = config.baseWsUrl || config.baseRpcUrl;
      provider = providerUrl.startsWith('wss')
        ? new ethers.WebSocketProvider(providerUrl)
        : new ethers.JsonRpcProvider(providerUrl);

      contract = new ethers.Contract(config.paymentContractAddress, PAYMENT_ABI, provider);

      console.log(`[x402] Base watcher connected to ${providerUrl}`);

      // Listen for events
      contract.on('VpnPayment', async (
        _sender: string,
        agentId: string,
        numHours: bigint,
        amount: bigint,
        _timestamp: bigint,
        event: ethers.EventLog,
      ) => {
        try {
          await processPaymentEvent(agentId, Number(numHours), amount, event.transactionHash, db, config, operator);
        } catch (err) {
          console.error('[x402] Error processing payment event:', err);
        }
      });

      // WebSocket disconnect handler — auto-reconnect
      if (provider instanceof ethers.WebSocketProvider) {
        const ws = provider.websocket as any;
        if (ws && typeof ws.on === 'function') {
          ws.on('close', () => {
            if (stopped) return;
            console.log('[x402] Base WebSocket disconnected — reconnecting in 5s...');
            reconnectTimer = setTimeout(connectAndWatch, 5000);
          });
          ws.on('error', (err: Error) => {
            console.error('[x402] Base WebSocket error:', err.message);
          });
        }
      }

      // Catch-up scan for missed events
      await catchUpMissedEvents(contract, db, config, operator);

    } catch (err) {
      console.error('[x402] Base watcher connection failed:', err);
      if (!stopped) {
        console.log('[x402] Retrying in 10s...');
        reconnectTimer = setTimeout(connectAndWatch, 10_000);
      }
    }
  }

  connectAndWatch();

  return {
    stop: () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (contract) contract.removeAllListeners();
      if (provider && 'destroy' in provider) {
        (provider as ethers.WebSocketProvider).destroy();
      }
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
  const LOOKBACK_BLOCKS = 1000;

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
      const [_sender, agentId, numHours, amount] = log.args;

      if (db.getPaymentByTxHash(log.transactionHash)) continue;

      await processPaymentEvent(agentId, Number(numHours), amount, log.transactionHash, db, config, operator);
      processed++;
    }

    console.log(`[x402] Catch-up: ${processed > 0 ? `processed ${processed} missed events` : 'no missed events'}`);
  } catch (err) {
    console.error('[x402] Catch-up error:', err);
  }
}
