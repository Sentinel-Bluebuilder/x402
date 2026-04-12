import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { Db } from '../db/index.js';
import { X402Error, ErrorCodes } from '../errors.js';
import type { RegisterRequest, RegisterResponse } from '../types.js';

// ─── Validation ───

const BECH32_SENT_REGEX = /^sent1[a-z0-9]{38,}$/;

function validateSentinelAddress(addr: string): boolean {
  return BECH32_SENT_REGEX.test(addr);
}

// ─── Routes ───

export function registerRoutes(db: Db): Router {
  const router = Router();

  // POST /register — Register agent, get agentId
  router.post('/register', (req, res, next) => {
    try {
      const { sentinelAddr } = req.body as RegisterRequest;

      if (!sentinelAddr || typeof sentinelAddr !== 'string') {
        throw new X402Error(
          ErrorCodes.INVALID_SENTINEL_ADDRESS,
          'sentinelAddr is required and must be a string',
        );
      }

      if (!validateSentinelAddress(sentinelAddr)) {
        throw new X402Error(
          ErrorCodes.INVALID_SENTINEL_ADDRESS,
          `Invalid Sentinel address: must match sent1... bech32 format. Got: ${sentinelAddr.slice(0, 10)}...`,
        );
      }

      // Check if already registered
      const existing = db.getAgentBySentinel(sentinelAddr);
      if (existing) {
        const response: RegisterResponse = {
          agentId: existing.agent_id,
          sentinelAddr: existing.sentinel_address,
        };
        res.json(response);
        return;
      }

      // Create new agent
      const agentId = uuidv4();
      const chain = (req.body.chain as string) || 'base';
      const chainAddress = (req.body.chainAddress as string) || undefined;

      db.insertAgent(agentId, sentinelAddr, chain, chainAddress);

      const response: RegisterResponse = { agentId, sentinelAddr };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  });

  // GET /agent/:agentId — Get agent details
  router.get('/agent/:agentId', (req, res, next) => {
    try {
      const agent = db.getAgentById(req.params.agentId);
      if (!agent) {
        throw new X402Error(ErrorCodes.AGENT_NOT_FOUND, 'Agent not found', 404);
      }

      const payments = db.getPaymentsByAgent(agent.agent_id);
      const totalHours = payments
        .filter(p => p.status === 'allocated')
        .reduce((sum, p) => sum + p.hours, 0);

      res.json({
        agentId: agent.agent_id,
        sentinelAddress: agent.sentinel_address,
        chain: agent.chain,
        chainAddress: agent.chain_address,
        totalHoursPurchased: totalHours,
        payments: payments.map(p => ({
          txHash: p.tx_hash,
          chain: p.chain,
          hours: p.hours,
          status: p.status,
          createdAt: p.created_at,
        })),
        createdAt: agent.created_at,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
