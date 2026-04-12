import express from 'express';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { registerRoutes } from './routes/register.js';
import { statusRoutes } from './routes/status.js';
import { pricingRoutes } from './routes/pricing.js';
import { startBaseWatcher } from './base-watcher.js';
import { solanaWebhookRoutes } from './sol-watcher.js';
import { startRetryWorker } from './retry.js';
import { X402Error } from './errors.js';
import type { SentinelOperator } from './sentinel-tx.js';
import { initSentinelOperator } from './sentinel-operator.js';

async function main() {
  const config = loadConfig();
  const db = await createDb(config.databasePath);

  const app = express();
  app.use(express.json());

  // ─── Routes ───

  app.use('/api', registerRoutes(db));
  app.use('/api', statusRoutes(db));
  app.use('/api', pricingRoutes(config));

  // ─── Error Handler ───

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof X402Error) {
      res.status(err.statusCode).json({
        error: err.code,
        message: err.message,
        ...(err.details && { details: err.details }),
      });
      return;
    }
    console.error('[x402] Unhandled error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Internal server error' });
  });

  // ─── Sentinel Operator ───

  let operator: SentinelOperator | null = null;

  if (config.sentinelOperatorMnemonic && config.sentinelPlanId > 0) {
    try {
      operator = await initSentinelOperator(config);
      console.log(`[x402] Sentinel operator: active (${operator.address})`);
    } catch (err) {
      console.error('[x402] Failed to init Sentinel operator:', err);
      console.log('[x402] Continuing without operator — payments recorded but not provisioned');
    }
  } else {
    console.log('[x402] Sentinel operator: not configured — set SENTINEL_OPERATOR_MNEMONIC + SENTINEL_PLAN_ID');
  }

  // ─── Base Watcher ───

  const watcher = startBaseWatcher(db, config, operator);

  // ─── Solana Webhook ───

  app.use(solanaWebhookRoutes(db, config, operator));

  // ─── Retry Worker ───

  const retryWorker = startRetryWorker(db, config, operator);

  // ─── Start ───

  app.listen(config.port, () => {
    console.log('');
    console.log('══════════════════════════════════════');
    console.log('  x402 — Payment Bridge for AI VPN');
    console.log('══════════════════════════════════════');
    console.log(`  Port:     ${config.port}`);
    console.log(`  Database: ${config.databasePath}`);
    console.log(`  Plan ID:  ${config.sentinelPlanId || 'not set'}`);
    console.log(`  Contract: ${config.paymentContractAddress || 'not deployed'}`);
    console.log(`  Operator: ${operator ? 'active' : 'not configured'}`);
    console.log('');
    console.log('  Endpoints:');
    console.log('    POST /api/register      — Register agent');
    console.log('    GET  /api/agent/:id     — Agent details');
    console.log('    GET  /api/payment/:tx   — Payment status');
    console.log('    GET  /api/pricing       — Current pricing');
    console.log('    GET  /api/health        — Health check');
    console.log('══════════════════════════════════════');
  });

  // ─── Graceful Shutdown ───

  const shutdown = () => {
    console.log('[x402] Shutting down...');
    watcher.stop();
    retryWorker.stop();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { app, db, config };
}

main().catch(err => {
  console.error('[x402] Failed to start:', err);
  process.exit(1);
});
