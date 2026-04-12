import { Router } from 'express';
import type { Config } from '../config.js';
import { USDC_DECIMALS } from '../config.js';
import type { PricingResponse } from '../types.js';

export function pricingRoutes(config: Config): Router {
  const router = Router();

  // GET /pricing — Current pricing info
  router.get('/pricing', (_req, res) => {
    const priceHuman = (config.pricePerHourUsdc / Math.pow(10, USDC_DECIMALS)).toFixed(USDC_DECIMALS);

    const response: PricingResponse = {
      pricePerHourUsdc: priceHuman,
      minHours: config.minHours,
      maxHours: config.maxHours,
      chains: ['base', 'solana'],
    };

    res.json(response);
  });

  return router;
}
