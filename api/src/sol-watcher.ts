import { Router } from 'express';
import type { Db } from './db/index.js';
import type { Config } from './config.js';
import type { SentinelOperator } from './sentinel-tx.js';
import { provisionAgent } from './sentinel-tx.js';
import { MEMO_PREFIX } from './config.js';

// ─── Memo Parsing ───
// Format: "x402:<agentId>:hours:<N>"

interface ParsedMemo {
  agentId: string;
  hours: number;
}

export function parseMemo(memo: string): ParsedMemo | null {
  if (!memo.startsWith(MEMO_PREFIX)) return null;

  const parts = memo.slice(MEMO_PREFIX.length).split(':');
  // Expected: agentId:hours:N
  if (parts.length < 3 || parts[1] !== 'hours') return null;

  const agentId = parts[0];
  const hours = parseInt(parts[2], 10);

  if (!agentId || isNaN(hours) || hours <= 0 || hours > 8760) return null;

  return { agentId, hours };
}

// ─── Helius Webhook Handler ───
// Helius delivers Enhanced Transactions when USDC arrives at our ATA.
// Docs: https://docs.helius.dev/webhooks/webhooks-summary

interface HeliusTokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  mint: string;
  tokenAmount: number;
  tokenStandard: string;
}

interface HeliusTransaction {
  signature: string;
  type: string;
  timestamp: number;
  tokenTransfers: HeliusTokenTransfer[];
  accountData: Array<{ account: string; nativeBalanceChange: number }>;
  description: string;
  events: Record<string, unknown>;
  // Memo is in the instructions or description
}

async function processHeliusEvent(
  tx: HeliusTransaction,
  db: Db,
  config: Config,
  operator: SentinelOperator | null,
): Promise<void> {
  const signature = tx.signature;

  // 1. Dedup
  if (db.getPaymentByTxHash(signature)) {
    return;
  }

  // 2. Find USDC transfer to our ATA
  const usdcTransfer = tx.tokenTransfers?.find(
    t => t.toUserAccount === config.operatorUsdcAta && t.mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  );

  if (!usdcTransfer) {
    return; // Not a USDC transfer to us
  }

  // 3. Extract memo from description (Helius includes memo in description)
  // Look for x402: prefix in the transaction description
  const memoMatch = tx.description?.match(/x402:[^\s]+/);
  if (!memoMatch) {
    console.log(`[x402] Solana USDC transfer without x402 memo: ${signature}`);
    return;
  }

  const parsed = parseMemo(memoMatch[0]);
  if (!parsed) {
    console.error(`[x402] Invalid memo format in Solana TX: ${memoMatch[0]} (${signature})`);
    return;
  }

  // 4. Resolve agentId
  const agent = db.getAgentById(parsed.agentId);
  if (!agent) {
    console.error(`[x402] Unknown agentId in Solana payment: ${parsed.agentId} (${signature})`);
    db.insertPayment(signature, 'solana', parsed.agentId, null, parsed.hours, Math.round(usdcTransfer.tokenAmount * 1e6));
    db.updatePaymentStatus(signature, 'failed', { error: 'Agent not registered' });
    return;
  }

  // 5. Verify amount
  const usdcAtomic = Math.round(usdcTransfer.tokenAmount * 1e6);
  const expectedAmount = parsed.hours * config.pricePerHourUsdc;

  if (usdcAtomic < expectedAmount) {
    console.error(`[x402] Solana amount mismatch: got ${usdcAtomic}, expected ${expectedAmount} (${signature})`);
    db.insertPayment(signature, 'solana', parsed.agentId, agent.sentinel_address, parsed.hours, usdcAtomic);
    db.updatePaymentStatus(signature, 'failed', { error: `Amount mismatch: ${usdcAtomic} < ${expectedAmount}` });
    return;
  }

  // 6. Record payment
  db.insertPayment(signature, 'solana', parsed.agentId, agent.sentinel_address, parsed.hours, usdcAtomic);
  db.updatePaymentStatus(signature, 'verified');

  console.log(`[x402] Solana payment verified: ${parsed.agentId} → ${agent.sentinel_address}, ${parsed.hours}h, ${usdcAtomic} USDC atomic (${signature})`);

  // 7. Provision on Sentinel
  if (!operator) {
    console.log(`[x402] Sentinel operator not configured — Solana payment recorded but not provisioned`);
    return;
  }

  try {
    const result = await provisionAgent(operator, db, config, agent.sentinel_address, parsed.hours, signature);
    console.log(`[x402] Solana agent provisioned: ${agent.sentinel_address} on sub ${result.subscriptionId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[x402] Sentinel provisioning failed for Solana payment: ${msg}`);
    db.updatePaymentStatus(signature, 'failed', { error: msg });
  }
}

// ─── Express Routes for Helius Webhook ───

export function solanaWebhookRoutes(db: Db, config: Config, operator: SentinelOperator | null): Router {
  const router = Router();

  if (!config.heliusWebhookSecret) {
    console.log('[x402] No HELIUS_WEBHOOK_SECRET — Solana watcher disabled');
    return router;
  }

  console.log('[x402] Solana webhook endpoint active: POST /webhook/helius');

  router.post('/webhook/helius', async (req, res) => {
    // 1. Verify webhook auth
    const authHeader = req.headers['authorization'];
    if (authHeader !== config.heliusWebhookSecret) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // 2. Helius sends an array of transactions
    const transactions: HeliusTransaction[] = Array.isArray(req.body) ? req.body : [req.body];

    // 3. Process each (respond 200 immediately, process async)
    res.status(200).json({ received: transactions.length });

    for (const tx of transactions) {
      try {
        await processHeliusEvent(tx, db, config, operator);
      } catch (err) {
        console.error(`[x402] Error processing Solana webhook event:`, err);
      }
    }
  });

  return router;
}
