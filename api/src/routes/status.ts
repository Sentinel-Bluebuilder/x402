import { Router } from 'express';
import type { Db } from '../db/index.js';
import { X402Error, ErrorCodes } from '../errors.js';
import type { PaymentStatusResponse, HealthResponse } from '../types.js';

export function statusRoutes(db: Db): Router {
  const router = Router();

  // GET /payment/:txHash — Check payment status
  router.get('/payment/:txHash', (req, res, next) => {
    try {
      const payment = db.getPaymentByTxHash(req.params.txHash);
      if (!payment) {
        throw new X402Error(ErrorCodes.PAYMENT_NOT_FOUND, 'Payment not found', 404);
      }

      const response: PaymentStatusResponse = {
        txHash: payment.tx_hash,
        chain: payment.chain,
        agentId: payment.agent_id,
        hours: payment.hours,
        usdcAmount: payment.usdc_amount,
        status: payment.status,
        sentinelTxHash: payment.sentinel_tx_hash,
        error: payment.error,
        createdAt: payment.created_at,
      };

      res.json(response);
    } catch (err) {
      next(err);
    }
  });

  // GET /health — Backend health check
  router.get('/health', (_req, res) => {
    const pool = db.getPoolStats();
    const pendingPayments = db.countPaymentsByStatus('verified');
    const retryQueueSize = db.countRetries('pending');

    const response: HealthResponse = {
      status: retryQueueSize > 10 ? 'degraded' : 'ok',
      uptime: process.uptime(),
      pool,
      pendingPayments,
      retryQueueSize,
    };

    res.json(response);
  });

  return router;
}
