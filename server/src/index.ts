import { config } from 'dotenv';
import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { createFacilitatorConfig } from '@coinbase/x402';
import { HTTPFacilitatorClient, type FacilitatorConfig } from '@x402/core/server';
import { initSentinel, provisionAgent, checkAgentStatus, getPlanNodes } from './sentinel.js';
import { createSelfHostedFacilitator, startFacilitatorServer } from './facilitator.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

config();

// ─── Config ───

const operatorAddress = process.env.OPERATOR_ADDRESS as `0x${string}`;
if (!operatorAddress) {
  console.error('OPERATOR_ADDRESS is required — this is where USDC payments go');
  process.exit(1);
}

const port = parseInt(process.env.PORT || '4020', 10);

// Network: eip155:8453 = Base mainnet (default), eip155:84532 = Base Sepolia (testnet)
const network = (process.env.BASE_NETWORK || 'eip155:8453') as `${string}:${string}`;
const networkLabel = network === 'eip155:8453' ? 'Base mainnet' : 'Base Sepolia (testnet)';

// ─── x402 Facilitator Setup ───
// Priority: 1) Self-hosted (FACILITATOR_PRIVATE_KEY) — fully decentralized
//           2) CDP (CDP_API_KEY_ID) — Coinbase hosted
//           3) Public x402.org — Sepolia only

let facilitatorConfig: FacilitatorConfig;
const facilitatorPort = parseInt(process.env.FACILITATOR_PORT || '4021', 10);

if (process.env.FACILITATOR_PRIVATE_KEY) {
  // Self-hosted: we run our own facilitator, no third party dependency
  const facServer = startFacilitatorServer(
    process.env.FACILITATOR_PRIVATE_KEY as `0x${string}`,
    network,
    facilitatorPort,
  );
  facilitatorConfig = { url: facServer.url };
} else if (process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET) {
  facilitatorConfig = createFacilitatorConfig(
    process.env.CDP_API_KEY_ID,
    process.env.CDP_API_KEY_SECRET,
  );
  console.log('  Facilitator: CDP (api.cdp.coinbase.com)');
} else if (network === 'eip155:84532') {
  facilitatorConfig = { url: 'https://x402.org/facilitator' };
  console.log('  Facilitator: x402.org (Sepolia only)');
} else {
  console.error('Base mainnet requires either:');
  console.error('  FACILITATOR_PRIVATE_KEY — self-hosted (recommended)');
  console.error('  CDP_API_KEY_ID + CDP_API_KEY_SECRET — Coinbase hosted');
  process.exit(1);
}

const facilitator = new HTTPFacilitatorClient(facilitatorConfig);

const resourceServer = new x402ResourceServer(facilitator)
  .register(network, new ExactEvmScheme());

// ─── Express App ───

const app = express();
app.use(express.json());

// ─── x402-Protected Routes ───
// When an agent hits these without payment, they get HTTP 402 with payment details.
// When they pay (via @x402/fetch), the facilitator settles USDC to our wallet,
// and the route handler runs.

app.use(
  paymentMiddleware(
    {
      'POST /vpn/connect/1day': {
        accepts: [{
          scheme: 'exact',
          price: '$0.033',
          network,
          payTo: operatorAddress,
        }],
        description: '1 day of private VPN access through Sentinel decentralized nodes',
        mimeType: 'application/json',
      },
      'POST /vpn/connect/7days': {
        accepts: [{
          scheme: 'exact',
          price: '$0.233',
          network,
          payTo: operatorAddress,
        }],
        description: '7 days of private VPN access',
        mimeType: 'application/json',
      },
      'POST /vpn/connect/30days': {
        accepts: [{
          scheme: 'exact',
          price: '$1.00',
          network,
          payTo: operatorAddress,
        }],
        description: '30 days of private VPN access',
        mimeType: 'application/json',
      },
    },
    resourceServer,
  ),
);

// ─── Route Handlers (only reached after payment is settled) ───

app.post('/vpn/connect/1day', async (req, res) => {
  try {
    const result = await provisionVpn(1, req.body);
    res.json(result);
  } catch (err) {
    console.error('[x402] Provision failed:', (err as Error).message);
    res.status(500).json({ error: 'Provisioning failed', detail: (err as Error).message });
  }
});

app.post('/vpn/connect/7days', async (req, res) => {
  try {
    const result = await provisionVpn(7, req.body);
    res.json(result);
  } catch (err) {
    console.error('[x402] Provision failed:', (err as Error).message);
    res.status(500).json({ error: 'Provisioning failed', detail: (err as Error).message });
  }
});

app.post('/vpn/connect/30days', async (req, res) => {
  try {
    const result = await provisionVpn(30, req.body);
    res.json(result);
  } catch (err) {
    console.error('[x402] Provision failed:', (err as Error).message);
    res.status(500).json({ error: 'Provisioning failed', detail: (err as Error).message });
  }
});

// ─── Free Endpoints (no payment required) ───

app.get('/pricing', (_req, res) => {
  res.json({
    protocol: 'x402',
    network,
    asset: 'USDC',
    payTo: operatorAddress,
    tiers: {
      '1day': { price: '$0.033', endpoint: '/vpn/connect/1day' },
      '7days': { price: '$0.233', endpoint: '/vpn/connect/7days' },
      '30days': { price: '$1.00', endpoint: '/vpn/connect/30days' },
    },
    sentinelNetwork: 'sentinel',
    countries: '70+',
    protocols: ['wireguard', 'v2ray'],
    nodesEndpoint: '/nodes',
  });
});

// ─── Machine-readable manifest for AI agents ───
// Single endpoint that encodes the entire protocol — agents can ingest this
// once (~300 tokens) instead of parsing the docs (~28K tokens).
app.get('/manifest', (_req, res) => {
  const usdcAddress = network === 'eip155:8453'
    ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    : '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  const chainId = network === 'eip155:8453' ? 8453 : 84532;

  res.json({
    protocol: 'x402',
    version: '1.0',
    spec: 'https://github.com/coinbase/x402',
    description: 'Pay USDC, get a Sentinel dVPN subscription. One HTTP request, one EIP-3009 signature.',
    tldr: [
      'You need: (a) an EVM wallet with USDC on Base, (b) a Sentinel wallet from `createWallet()` in `blue-js-sdk/ai-path`.',
      `POST ${network === 'eip155:8453' ? 'https://x402.blue' : '/'}/vpn/connect/30days with { sentinelAddr } using @x402/fetch to auto-sign the 402.`,
      'Take { subscriptionId, feeGranter, nodeAddress } from the 200 response and pass them to `connect({ mnemonic, subscriptionId, feeGranter, nodeAddress })`.',
      'Tunnel is up. You paid $1.00 USDC, zero gas on Base, zero gas on Sentinel.',
    ],
    network: {
      caip2: network,
      chainId,
      name: networkLabel,
    },
    payment: {
      scheme: 'exact',
      standard: 'EIP-3009',
      method: 'transferWithAuthorization',
      asset: {
        symbol: 'USDC',
        decimals: 6,
        address: usdcAddress,
      },
      payTo: operatorAddress,
      gasless: true,
      approveRequired: false,
      prerequisites: {
        evmWallet: 'Agent must hold an EVM private key with USDC on Base. EIP-3009 signature is created locally; the key never leaves the agent.',
        minUsdc: '1.00 USDC covers a 30-day subscription (smallest tier is $0.033). Fund the wallet before calling the endpoint.',
        gasOnBase: 'Agent pays ZERO gas on Base — the facilitator submits the transferWithAuthorization. Agent only needs USDC.',
      },
      eip712: {
        note: 'Builders using @x402/fetch get this automatically — fields below are for low-level integrators.',
        domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: usdcAddress },
        primaryType: 'TransferWithAuthorization',
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
          TransferWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
          ],
        },
        message: {
          from: 'agent EVM address',
          to: 'payment.payTo (operator)',
          value: 'price.atomic of chosen tier',
          validAfter: '0 (or now)',
          validBefore: 'now + 10 minutes (unix seconds)',
          nonce: 'random 32 bytes — server tracks to prevent replay',
        },
      },
    },
    endpoints: {
      paid: [
        {
          method: 'POST',
          path: '/vpn/connect/1day',
          price: { display: '$0.033', atomic: '33000', decimals: 6 },
          days: 1,
        },
        {
          method: 'POST',
          path: '/vpn/connect/7days',
          price: { display: '$0.233', atomic: '233000', decimals: 6 },
          days: 7,
        },
        {
          method: 'POST',
          path: '/vpn/connect/30days',
          price: { display: '$1.00', atomic: '1000000', decimals: 6 },
          days: 30,
        },
      ],
      free: [
        { method: 'GET', path: '/manifest', description: 'This document' },
        { method: 'GET', path: '/pricing', description: 'Human pricing table' },
        { method: 'GET', path: '/nodes', description: 'VPN nodes in operator plan' },
        { method: 'GET', path: '/health', description: 'Uptime check' },
        { method: 'GET', path: '/agent/:sentinelAddr', description: 'Subscription + fee-grant status' },
      ],
    },
    request: {
      contentType: 'application/json',
      body: {
        sentinelAddr: {
          type: 'string',
          pattern: '^sent1[0-9a-z]{38}$',
          required: true,
          description: 'Agent Sentinel bech32 address — receives the subscription share and fee grant',
        },
      },
    },
    response: {
      success: {
        status: 200,
        schema: {
          provisioned: 'boolean',
          subscriptionId: 'number',
          planId: 'number',
          feeGranter: 'string (sent1...)',
          nodeAddress: 'string (sentnode1...)',
          nodes: 'string[]',
          sentinelTxHash: 'string',
          expiresAt: 'string (ISO 8601)',
        },
      },
      paymentRequired: {
        status: 402,
        header: 'PAYMENT-REQUIRED',
        nextAction: 'Sign EIP-3009 transferWithAuthorization, resend with PAYMENT-SIGNATURE header',
      },
      errors: {
        400: 'Bad request — missing or malformed sentinelAddr',
        402: 'Payment required — sign EIP-3009 and resend',
        500: 'Provisioning failed — { error, detail }. Safe to retry once.',
      },
    },
    flow: [
      { step: 1, actor: 'agent', action: 'POST /vpn/connect/{days} with { sentinelAddr }' },
      { step: 2, actor: 'server', action: 'Respond 402 with PAYMENT-REQUIRED (amount, asset, payTo, network)' },
      { step: 3, actor: 'agent', action: 'Sign EIP-3009 transferWithAuthorization locally (EIP-712)' },
      { step: 4, actor: 'agent', action: 'Resend request with PAYMENT-SIGNATURE header' },
      { step: 5, actor: 'facilitator', action: 'Settle USDC on Base (~2s)' },
      { step: 6, actor: 'server', action: 'Atomic MsgShareSubscription + MsgGrantAllowance on Sentinel' },
      { step: 7, actor: 'server', action: 'Respond 200 with subscriptionId, feeGranter, nodeAddress' },
      { step: 8, actor: 'agent', action: 'Call connect({ mnemonic, subscriptionId, feeGranter, nodeAddress })' },
      { step: 9, actor: 'agent', action: 'MsgStartSession (gas paid by operator via fee grant)' },
      { step: 10, actor: 'agent', action: 'Direct WireGuard/V2Ray handshake with node — tunnel up' },
    ],
    packages: {
      payment: '@x402/fetch',
      scheme: '@x402/evm',
      sentinel: 'blue-js-sdk/ai-path',
    },
    example: {
      language: 'typescript',
      code: [
        "import { x402Client, wrapFetchWithPayment } from '@x402/fetch';",
        "import { ExactEvmScheme } from '@x402/evm/exact/client';",
        "import { createWallet, connect, disconnect } from 'blue-js-sdk/ai-path';",
        '',
        'const wallet = await createWallet();          // { address: sent1..., mnemonic }',
        'const scheme = new ExactEvmScheme({ address, signTypedData });',
        'const client = new x402Client();',
        `client.register('${network}', scheme);`,
        'const paidFetch = wrapFetchWithPayment(fetch, client);',
        '',
        "const res = await paidFetch('https://x402.blue/vpn/connect/30days', {",
        "  method: 'POST',",
        '  body: JSON.stringify({ sentinelAddr: wallet.address }),',
        '});',
        'const { subscriptionId, feeGranter, nodeAddress } = await res.json();',
        'await connect({ mnemonic: wallet.mnemonic, subscriptionId, feeGranter, nodeAddress });',
      ].join('\n'),
    },
    sentinel: {
      chain: 'sentinelhub-2',
      planId: parseInt(process.env.SENTINEL_PLAN_ID || '42', 10),
      countries: '70+',
      protocols: ['wireguard', 'v2ray'],
      gasGrantedByOperator: true,
      rpc: process.env.SENTINEL_RPC_URL || 'https://rpc.sentinel.co:443',
      lcd: process.env.SENTINEL_LCD_URL || 'https://lcd.sentinel.co',
      addressPrefix: 'sent',
      coinType: 118,
      denom: 'udvpn',
      denomDecimals: 6,
      walletCreate: {
        package: 'blue-js-sdk/ai-path',
        fn: 'createWallet()',
        returns: { address: 'sent1... (use this as sentinelAddr)', mnemonic: 'string (persist this)' },
        note: 'Generate once per agent. The address goes in the request body; the mnemonic signs MsgStartSession.',
      },
      connect: {
        package: 'blue-js-sdk/ai-path',
        fn: 'connect({ mnemonic, subscriptionId, feeGranter, nodeAddress })',
        argsFrom: 'Pass response.success fields directly. mnemonic is the one from createWallet().',
        returns: { connected: 'boolean', ip: 'string', protocol: 'wireguard | v2ray' },
        gasCost: '0 P2P — operator fee-grants MsgStartSession',
      },
      disconnect: {
        package: 'blue-js-sdk/ai-path',
        fn: 'disconnect()',
        note: 'Ends the session on-chain (also fee-granted) and tears down the tunnel.',
      },
      errors: {
        FEE_GRANT_NOT_FOUND: 'Server provisioned but fee grant missing — retry POST',
        FEE_GRANT_EXPIRED: 'Subscription expired — purchase a new tier',
        FEE_GRANT_EXHAUSTED: 'Spend limit consumed — purchase a new tier',
      },
    },
    retry: {
      networkErrors: 'Idempotent on the agent side — re-POST is safe if no 200 arrived. EIP-3009 nonce prevents double-charge.',
      after200: 'Provisioning is complete. If connect() fails, call GET /agent/:sentinelAddr to verify state before retrying connect().',
    },
    docs: {
      llmsTxt: '/llms.txt',
      readme: 'https://github.com/anthropics/x402',
      manifesto: 'https://x402.blue/manifesto',
    },
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// llms.txt — AI-readable summary (https://llmstxt.org convention)
let llmsTxtCache: string | null = null;
app.get('/llms.txt', (_req, res) => {
  if (!llmsTxtCache) {
    try {
      llmsTxtCache = readFileSync(join(__dirname, '..', '..', 'docs', 'llms.txt'), 'utf8');
    } catch {
      llmsTxtCache = '# x402\n\nSee /manifest for the machine-readable spec.\n';
    }
  }
  res.type('text/plain').send(llmsTxtCache);
});

// Node list — free, agents can choose or let server pick random
app.get('/nodes', async (_req, res) => {
  try {
    const nodes = await getPlanNodes();
    res.json({
      planId: parseInt(process.env.SENTINEL_PLAN_ID || '42', 10),
      count: nodes.length,
      nodes: nodes.map(n => ({
        address: n.address,
        remote_addrs: n.remote_addrs,
      })),
      note: 'Pass nodeAddress in your connect() call to choose a specific node. If omitted from the provision response, a random node is selected.',
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Agent status check — free, no payment needed
app.get('/agent/:sentinelAddr', async (req, res) => {
  try {
    const status = await checkAgentStatus(req.params.sentinelAddr);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── VPN Provisioning ───

async function provisionVpn(days: number, body: Record<string, unknown>) {
  const sentinelAddr = body.sentinelAddr as string;

  if (!sentinelAddr || !sentinelAddr.startsWith('sent1')) {
    throw new Error('Include sentinelAddr (sent1...) in request body');
  }

  console.log(`[x402] Payment settled. Provisioning ${days} days for ${sentinelAddr}...`);
  const result = await provisionAgent(sentinelAddr, days);
  return result;
}

// ─── Start ───

async function start() {
  console.log('');
  console.log('══════════════════════════════════════');
  console.log('  x402 VPN Server');
  console.log('══════════════════════════════════════');

  try {
    await initSentinel();
  } catch (err) {
    console.error(`  Sentinel:    FAILED — ${(err as Error).message}`);
    console.error('  Server will start but provisioning will fail.');
    console.error('  Set SENTINEL_OPERATOR_MNEMONIC in .env');
  }

  console.log(`  Port:        ${port}`);
  console.log(`  Operator:    ${operatorAddress}`);
  console.log(`  Facilitator: ${(facilitatorConfig as any).url || 'CDP (api.cdp.coinbase.com)'}`);
  console.log(`  Network:     ${networkLabel} (${network})`);
  console.log('');
  console.log('  x402 Endpoints (payment required):');
  console.log('    POST /vpn/connect/1day    $0.033');
  console.log('    POST /vpn/connect/7days   $0.233');
  console.log('    POST /vpn/connect/30days  $1.00');
  console.log('');
  console.log('  Free Endpoints:');
  console.log('    GET  /manifest             (AI-readable JSON spec)');
  console.log('    GET  /llms.txt             (AI-readable summary)');
  console.log('    GET  /pricing');
  console.log('    GET  /nodes');
  console.log('    GET  /health');
  console.log('    GET  /agent/:sentinelAddr');
  console.log('══════════════════════════════════════');

  app.listen(port, () => {
    console.log(`\n  Listening on http://localhost:${port}\n`);
  });
}

start();
