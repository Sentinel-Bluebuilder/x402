import type { Db } from './db/index.js';
import type { Config } from './config.js';
import type { SentinelOperator } from './sentinel-tx.js';
import { provisionAgent } from './sentinel-tx.js';

// ─── Backoff Schedule (seconds) ───

const BACKOFF = [30, 60, 120, 300, 600]; // 30s, 1m, 2m, 5m, 10m

function nextRetryTime(attempt: number): string {
  const delaySec = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
  const next = new Date(Date.now() + delaySec * 1000);
  return next.toISOString().replace('T', ' ').slice(0, 19); // SQLite datetime format
}

// ─── Queue Failed Payment for Retry ───

export function queueRetry(db: Db, paymentId: number, error: string): void {
  const retryAt = nextRetryTime(0);
  db.insertRetry(paymentId, retryAt, error);
  console.log(`[x402] Queued retry for payment #${paymentId}, next at ${retryAt}`);
}

// ─── Process Retry Queue ───

export async function processRetries(
  db: Db,
  config: Config,
  operator: SentinelOperator,
): Promise<number> {
  const pending = db.getPendingRetries();
  if (pending.length === 0) return 0;

  let processed = 0;

  for (const entry of pending) {
    // Max retries exhausted
    if (entry.attempt >= entry.max_attempts) {
      db.updateRetry(entry.id, 'exhausted', undefined, 'Max retries reached');
      console.log(`[x402] Retry exhausted for payment #${entry.payment_id} after ${entry.attempt} attempts`);
      continue;
    }

    // Get the actual payment
    const payment = db.getPaymentById(entry.payment_id);
    if (!payment) {
      db.updateRetry(entry.id, 'exhausted', undefined, 'Payment not found');
      continue;
    }

    // Only retry verified payments (not already allocated or failed-permanently)
    if (payment.status !== 'verified' && payment.status !== 'received') {
      db.updateRetry(entry.id, 'succeeded', undefined, `Payment already ${payment.status}`);
      continue;
    }

    // Need sentinel address to provision
    if (!payment.sentinel_address) {
      db.updateRetry(entry.id, 'exhausted', undefined, 'No sentinel address for payment');
      continue;
    }

    console.log(`[x402] Retrying payment #${entry.payment_id} (attempt ${entry.attempt + 1}/${entry.max_attempts})`);

    try {
      await provisionAgent(operator, db, config, payment.sentinel_address, payment.hours, payment.tx_hash);
      db.updateRetry(entry.id, 'succeeded');
      console.log(`[x402] Retry succeeded for payment #${entry.payment_id}`);
      processed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const nextAt = nextRetryTime(entry.attempt + 1);
      db.updateRetry(entry.id, 'pending', nextAt, msg);
      console.error(`[x402] Retry failed for payment #${entry.payment_id}: ${msg}. Next at ${nextAt}`);
    }
  }

  return processed;
}

// ─── Background Worker ───

export function startRetryWorker(
  db: Db,
  config: Config,
  operator: SentinelOperator | null,
  intervalMs: number = 30_000,
): { stop: () => void } {
  if (!operator) {
    console.log('[x402] No Sentinel operator — retry worker disabled');
    return { stop: () => {} };
  }

  console.log(`[x402] Retry worker started (interval: ${intervalMs / 1000}s)`);

  const timer = setInterval(async () => {
    try {
      const count = await processRetries(db, config, operator);
      if (count > 0) {
        console.log(`[x402] Retry worker processed ${count} entries`);
      }
    } catch (err) {
      console.error('[x402] Retry worker error:', err);
    }
  }, intervalMs);

  return { stop: () => clearInterval(timer) };
}
