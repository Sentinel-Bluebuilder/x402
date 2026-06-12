import { config } from 'dotenv';
import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { createFacilitatorConfig } from '@coinbase/x402';
import { HTTPFacilitatorClient, type FacilitatorConfig } from '@x402/core/server';
import { initSentinel, provisionAgent, checkAgentStatus, checkProvisioningCapacity, getEnrichedPlanNodes, matchNodesByCountry } from './sentinel.js';
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

// ─── Pre-payment Validation ───
// Runs BEFORE paymentMiddleware so agents never pay for requests that are
// guaranteed to fail (bad tier, missing/malformed sentinelAddr). Every error
// is structured JSON with a stable `code` field agents can branch on.

const VALID_TIERS = new Set(['1day', '7days', '30days']);
const SENTINEL_ADDR_RE = /^sent1[0-9a-z]{38}$/;

app.use(async (req, res, next) => {
  if (req.method !== 'POST') return next();
  const m = req.path.match(/^\/vpn\/connect\/([^/]+)$/);
  if (!m) return next();
  const tier = m[1];

  if (!VALID_TIERS.has(tier)) {
    return res.status(404).json({
      code: 'UNKNOWN_TIER',
      message: `Tier '${tier}' does not exist. Valid tiers: 1day, 7days, 30days.`,
      validTiers: ['1day', '7days', '30days'],
      nextAction: 'POST /vpn/connect/{1day|7days|30days} — see GET /manifest for prices.',
      docs: '/manifest',
    });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const sentinelAddr = body.sentinelAddr;

  if (typeof sentinelAddr !== 'string' || sentinelAddr.length === 0) {
    return res.status(400).json({
      code: 'MISSING_SENTINEL_ADDR',
      message: 'Request body must include `sentinelAddr` (string, sent1-bech32 address).',
      nextAction: "Call createWallet() from 'blue-js-sdk/ai-path' to mint one, then resend with { sentinelAddr: wallet.address }.",
      docs: '/manifest',
    });
  }

  if (!SENTINEL_ADDR_RE.test(sentinelAddr)) {
    return res.status(400).json({
      code: 'INVALID_SENTINEL_ADDR',
      message: `sentinelAddr '${sentinelAddr}' is not a valid Sentinel bech32 address.`,
      expectedPattern: '^sent1[0-9a-z]{38}$',
      nextAction: "Use the `address` field returned by createWallet() from 'blue-js-sdk/ai-path' — do not hand-construct this.",
      docs: '/manifest',
    });
  }

  // Country preference — if the agent asked for a country no online plan node
  // can serve, reject BEFORE payment instead of silently handing back a node
  // somewhere else. Fails open if node enrichment errors (provisioning then
  // falls back to a random node, and the response carries nodeCountry: null).
  const country = body.country;
  if (country !== undefined) {
    if (typeof country !== 'string' || country.trim().length === 0) {
      return res.status(400).json({
        code: 'COUNTRY_UNAVAILABLE',
        message: '`country` must be a non-empty string — ISO 3166-1 alpha-2 code ("DE") or country name ("Germany").',
        nextAction: 'Resend with a valid country, or omit `country` to let the server pick a node. GET /nodes lists each node with its country.',
        docs: '/nodes',
      });
    }
    try {
      const enriched = await getEnrichedPlanNodes();
      const matches = matchNodesByCountry(enriched, country);
      if (matches.length === 0) {
        const available = [...new Set(enriched.filter(n => n.online && n.country).map(n => n.country))];
        return res.status(400).json({
          code: 'COUNTRY_UNAVAILABLE',
          message: `No online node in this plan serves "${country}". You have NOT been charged — this check runs before payment.`,
          availableCountries: available,
          nextAction: 'Resend with one of availableCountries, or omit `country` to let the server pick. GET /nodes shows live per-node geo data.',
          docs: '/nodes',
        });
      }
    } catch (err) {
      console.warn('[x402] Country pre-check errored (continuing):', (err as Error).message);
    }
  }

  // Capacity check — if the operator provably cannot provision (subscription
  // pool full + spendable P2P below the new-subscription cost), reject before
  // the agent is asked to pay. Cached 60s in sentinel.ts; fails open on chain
  // errors (settlement only happens after a 2xx, so a wrong "ok" never charges
  // an agent for a failed provision).
  try {
    const capacity = await checkProvisioningCapacity();
    if (!capacity.ok) {
      console.error('[x402] Rejecting pre-payment — no capacity:', capacity.reason);
      return res.status(503).json({
        code: 'CAPACITY_EXHAUSTED',
        message: `Cannot provision right now: ${capacity.reason}. You have NOT been charged — this check runs before payment.`,
        nextAction: 'Retry later. Capacity is re-checked every 60 seconds; GET /health reports current capacity.',
        retryAfterSeconds: 60,
        docs: '/manifest',
      });
    }
  } catch (err) {
    console.warn('[x402] Capacity check errored (continuing):', (err as Error).message);
  }

  next();
});

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

function sendProvisionError(res: express.Response, err: unknown) {
  const message = (err as Error).message;
  console.error('[x402] Provision failed:', message);
  // @x402/express buffers this response and skips USDC settlement for any
  // status >= 400 — the agent is NOT charged when provisioning fails.
  res.status(500).json({
    code: 'PROVISIONING_FAILED',
    message: `Sentinel provisioning failed: ${message}`,
    charged: false,
    note: 'Your USDC was NOT charged. Settlement only happens after a successful (2xx) response; error responses skip settlement entirely.',
    nextAction: 'Safe to retry — no payment was taken. If it persists, GET /agent/{sentinelAddr} to inspect chain state and GET /health for operator capacity.',
    docs: '/manifest',
  });
}

app.post('/vpn/connect/1day', async (req, res) => {
  try {
    const result = await provisionVpn(1, req.body);
    res.json(result);
  } catch (err) {
    sendProvisionError(res, err);
  }
});

app.post('/vpn/connect/7days', async (req, res) => {
  try {
    const result = await provisionVpn(7, req.body);
    res.json(result);
  } catch (err) {
    sendProvisionError(res, err);
  }
});

app.post('/vpn/connect/30days', async (req, res) => {
  try {
    const result = await provisionVpn(30, req.body);
    res.json(result);
  } catch (err) {
    sendProvisionError(res, err);
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
      `POST ${network === 'eip155:8453' ? 'https://x402.sentinel.co' : '/'}/vpn/connect/30days with { sentinelAddr } using @x402/fetch to auto-sign the 402. Add { country: "DE" } to get a node in a specific country (GET /nodes lists what is available). Payment is identical on every OS.`,
      'Connecting differs by OS. macOS & Linux (easiest): WireGuard ships with the OS — use the native CLI `sentinel-dvpncli` (go install github.com/sentinel-official/sentinel-dvpncli@latest), then `keys add` your mnemonic, `tx session-start <nodeAddress> --subscription-id <id> --tx.fee-granter-addr <feeGranter>`, and `connect <sessionId>`. See sentinel.connectMacLinux. Only Fedora is unsupported (SELinux blocks VPNs).',
      'Windows (heavier): run `await setup()` from `blue-js-sdk/ai-path` first — it auto-downloads V2Ray (no admin) and installs WireGuard — then `connect({ mnemonic, subscriptionId, feeGranter, nodeAddress })`. See sentinel.connectWindows.',
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
        { method: 'GET', path: '/nodes', description: 'VPN nodes in operator plan with live geo data (country, city, protocol, online) and a byCountry summary' },
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
        country: {
          type: 'string',
          required: false,
          description: 'Preferred node country — ISO 3166-1 alpha-2 code ("DE") or name ("Germany"). Validated BEFORE payment: if no online plan node matches, you get COUNTRY_UNAVAILABLE with availableCountries and are not charged. Omit to let the server pick.',
          example: 'DE',
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
          nodeCountry: 'string | null — country of nodeAddress when a country was requested and matched',
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
        note: 'All errors are JSON: { code, message, nextAction, docs }. Branch on `code` — it is the stable contract.',
        codes: {
          MISSING_SENTINEL_ADDR: { status: 400, meaning: 'Request body did not include sentinelAddr.' },
          INVALID_SENTINEL_ADDR: { status: 400, meaning: "sentinelAddr is not a valid sent1-bech32 address — use createWallet() from 'blue-js-sdk/ai-path'." },
          UNKNOWN_TIER: { status: 404, meaning: 'Path tier is not one of 1day | 7days | 30days.' },
          COUNTRY_UNAVAILABLE: { status: 400, meaning: 'Requested country has no online plan node. Returned BEFORE payment — no USDC charged. Response includes availableCountries; resend with one of those or omit country.' },
          PAYMENT_REQUIRED: { status: 402, meaning: 'Sign EIP-3009 transferWithAuthorization and resend with PAYMENT-SIGNATURE header. @x402/fetch handles this automatically.' },
          CAPACITY_EXHAUSTED: { status: 503, meaning: 'Operator cannot provision right now (subscription pool full and operator balance below new-subscription cost). Returned BEFORE payment — no USDC charged. Retry later; re-checked every 60s.' },
          PROVISIONING_FAILED: { status: 500, meaning: 'Sentinel TX failed after payment verification. USDC was NOT charged — settlement only happens after a successful 2xx response. Safe to retry.' },
          INTERNAL_ERROR: { status: 500, meaning: 'Unexpected server error. Open an issue if reproducible.' },
          NOT_FOUND: { status: 404, meaning: 'No route matches. See /manifest for endpoints.' },
        },
        prePaymentGuarantee: 'MISSING_SENTINEL_ADDR / INVALID_SENTINEL_ADDR / UNKNOWN_TIER / COUNTRY_UNAVAILABLE / CAPACITY_EXHAUSTED are returned BEFORE paymentMiddleware. Beyond that, USDC settlement only occurs after a successful 2xx response — error responses (including PROVISIONING_FAILED) never charge the agent.',
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
      { step: 8, actor: 'agent', action: 'Connect (OS-specific, same 200 fields). macOS/Linux: sentinel-dvpncli tx session-start <nodeAddress> --subscription-id <id> --tx.fee-granter-addr <feeGranter> --tx.from-name agent, then connect <sessionId>. Windows: setup() once, then connect({ mnemonic, subscriptionId, feeGranter, nodeAddress })' },
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
        "import { setup, createWallet, connect, disconnect } from 'blue-js-sdk/ai-path';",
        '',
        'await setup();                                // fresh machine: auto-downloads V2Ray, checks WireGuard',
        'const wallet = await createWallet();          // { address: sent1..., mnemonic }',
        'const scheme = new ExactEvmScheme({ address, signTypedData });',
        'const client = new x402Client();',
        `client.register('${network}', scheme);`,
        'const paidFetch = wrapFetchWithPayment(fetch, client);',
        '',
        "const res = await paidFetch('https://x402.sentinel.co/vpn/connect/30days', {",
        "  method: 'POST',",
        "  body: JSON.stringify({ sentinelAddr: wallet.address, country: 'DE' }),  // country optional",
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
      rpcFallbacks: [
        'https://rpc.sentinel.co:443',
        'https://sentinel-rpc.polkachu.com',
        'https://rpc.mathnodes.com',
        'https://sentinel-rpc.publicnode.com:443',
        'https://rpc.sentinel.quokkastake.io:443',
        'https://rpc.sentinel.suchnode.net:443',
      ],
      lcdFallbacks: [
        'https://lcd.sentinel.co',
        'https://sentinel-api.polkachu.com',
        'https://api.sentinel.quokkastake.io',
        'https://sentinel-rest.publicnode.com',
        'https://api.sentinel.suchnode.net',
      ],
      endpointsNote: 'blue-js-sdk ships the first five RPC / four LCD entries as built-in fallbacks and rotates automatically; suchnode.net is an additional public endpoint (suchnode.net) you can add at runtime with addRpcEndpoint(url).',
      addressPrefix: 'sent',
      coinType: 118,
      denom: 'udvpn',
      denomDecimals: 6,
      setup: {
        package: 'blue-js-sdk/ai-path',
        fn: 'await setup()',
        platform: 'Windows connect path only. macOS/Linux do not need setup() — use connectMacLinux (native CLI) instead.',
        note: 'Run once on a fresh machine BEFORE connect(). Auto-downloads V2Ray 5.2.1 to ~/.sentinel-sdk/bin (no admin rights needed) and detects/auto-installs WireGuard (Windows MSI install needs admin). Returns { ready, capabilities, recommended, issues }. If capabilities includes "v2ray" you can connect with zero manual installs.',
      },
      walletCreate: {
        package: 'blue-js-sdk/ai-path',
        fn: 'createWallet()',
        returns: { address: 'sent1... (use this as sentinelAddr)', mnemonic: 'string (persist this)' },
        note: 'Generate once per agent. The address goes in the request body; the mnemonic signs MsgStartSession.',
      },
      platforms: 'Payment is identical on every OS; only the connect step differs. macOS & Linux are the easiest path (native CLI, WireGuard ships with the OS — see connectMacLinux). Windows uses the heavier JS-SDK path (see connectWindows / connect). Only Fedora is unsupported: its SELinux blocks VPN interfaces and cannot be bypassed programmatically.',
      connectMacLinux: {
        tool: 'sentinel-dvpncli',
        install: 'go install github.com/sentinel-official/sentinel-dvpncli@latest (Go 1.24+); binary lands in $(go env GOPATH)/bin',
        why: 'Easiest path — WireGuard ships with macOS and mainstream Linux, so nothing to install for the tunnel. Flag-driven, non-interactive.',
        steps: [
          'keys add: echo "$MNEMONIC" | sentinel-dvpncli keys add agent --keyring.backend test  (import the SAME wallet whose sentinelAddr you sent to x402)',
          'session-start: sentinel-dvpncli tx session-start <nodeAddress> --subscription-id <subscriptionId> --tx.fee-granter-addr <feeGranter> --tx.from-name agent --keyring.backend test --rpc.chain-id sentinelhub-2 --output-format json  (operator fee-grants the gas; capture the session id from the tx events)',
          'connect: sentinel-dvpncli connect <sessionId>  (WireGuard nodes may need sudo to bring the interface up)',
        ],
        teardown: 'sentinel-dvpncli tx session-cancel <sessionId>',
        defaults: '--rpc.addrs https://rpc.sentinel.co:443, --rpc.chain-id sentinelhub-2, --keyring.name sentinel',
        fedora: 'Not supported on Fedora — SELinux blocks VPN interfaces. macOS, Ubuntu, Debian, Arch and other mainstream distros work out of the box.',
      },
      connect: {
        package: 'blue-js-sdk/ai-path',
        platform: 'Windows path (JS tunnel). On macOS/Linux use connectMacLinux (native CLI) instead.',
        fn: 'connect({ mnemonic, subscriptionId, feeGranter, nodeAddress })',
        argsFrom: 'Pass response.success fields directly. mnemonic is the one from createWallet().',
        returns: { connected: 'boolean', ip: 'string', protocol: 'wireguard | v2ray' },
        gasCost: '0 P2P — operator fee-grants MsgStartSession',
      },
      disconnect: {
        package: 'blue-js-sdk/ai-path',
        fn: 'disconnect()  (Windows JS path)',
        cli: 'macOS/Linux: sentinel-dvpncli tx session-cancel <sessionId>',
        note: 'Ends the session on-chain (also fee-granted) and tears down the tunnel.',
      },
      errors: {
        FEE_GRANT_NOT_FOUND: 'Server provisioned but fee grant missing — retry POST',
        FEE_GRANT_EXPIRED: 'Subscription expired — purchase a new tier',
        FEE_GRANT_EXHAUSTED: 'Spend limit consumed — purchase a new tier',
      },
    },
    retry: {
      networkErrors: 'Idempotent on the agent side — re-POST is safe if no 200 arrived. Settlement only happens on a 2xx response, and the EIP-3009 nonce prevents double-charge.',
      after200: 'Provisioning is complete. If connect() fails, call GET /agent/:sentinelAddr to verify state before retrying connect().',
    },
    docs: {
      llmsTxt: '/llms.txt',
      readme: 'https://github.com/Sentinel-Bluebuilder/x402',
      manifesto: 'https://github.com/Sentinel-Bluebuilder/x402/blob/master/MANIFESTO.md',
    },
  });
});

app.get('/health', async (_req, res) => {
  let capacity = null;
  try {
    capacity = await checkProvisioningCapacity();
  } catch (err) {
    console.warn('[x402] Health capacity check failed:', (err as Error).message);
  }
  res.json({ status: 'ok', uptime: process.uptime(), capacity });
});

// llms.txt — AI-readable summary (https://llmstxt.org convention)
let llmsTxtCache: string | null = null;
app.get('/llms.txt', (_req, res) => {
  if (!llmsTxtCache) {
    try {
      llmsTxtCache = readFileSync(join(__dirname, '..', '..', 'docs', 'llms.txt'), 'utf8');
    } catch (err) {
      console.warn('[x402] docs/llms.txt not readable, serving stub:', (err as Error).message);
      llmsTxtCache = '# x402\n\nSee /manifest for the machine-readable spec.\n';
    }
  }
  res.type('text/plain').send(llmsTxtCache);
});

// Node list — free, enriched with live geo data from each node's /status
// endpoint so agents can see WHERE each node is and choose (or request a
// country in the POST body and let the server pick a matching node).
app.get('/nodes', async (_req, res) => {
  try {
    const nodes = await getEnrichedPlanNodes();
    const byCountry: Record<string, number> = {};
    for (const n of nodes) {
      if (n.online && n.country) byCountry[n.country] = (byCountry[n.country] || 0) + 1;
    }
    res.json({
      planId: parseInt(process.env.SENTINEL_PLAN_ID || '42', 10),
      count: nodes.length,
      online: nodes.filter(n => n.online).length,
      byCountry,
      nodes,
      note: 'Pass { country: "DE" } (ISO code or name) in the POST body to get a node in that country, or pass a specific nodeAddress from this list to connect(). Omit both and the server picks a random node.',
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

// ─── JSON 404 / 405 catch-all ───
// Replaces Express's default HTML 404 page so agents always get structured JSON.

app.use((req, res) => {
  res.status(404).json({
    code: 'NOT_FOUND',
    message: `No route matches ${req.method} ${req.path}.`,
    nextAction: 'See GET /manifest for the full list of endpoints.',
    docs: '/manifest',
  });
});

// ─── JSON error handler ───
// Final safety net — any uncaught error becomes structured JSON, not an HTML stack trace.

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[x402] Uncaught error:', err.message);
  if (res.headersSent) return;
  res.status(500).json({
    code: 'INTERNAL_ERROR',
    message: err.message,
    nextAction: 'Report at https://github.com/Sentinel-Bluebuilder/x402/issues if it persists.',
    docs: '/manifest',
  });
});

// ─── VPN Provisioning ───

async function provisionVpn(days: number, body: Record<string, unknown>) {
  const sentinelAddr = body.sentinelAddr as string;

  // Pre-payment middleware already validated the address — this is a defensive recheck.
  if (!sentinelAddr || !SENTINEL_ADDR_RE.test(sentinelAddr)) {
    throw new Error('Include sentinelAddr (sent1...) in request body');
  }

  const country = typeof body.country === 'string' && body.country.trim().length > 0
    ? body.country.trim()
    : undefined;

  console.log(`[x402] Payment verified. Provisioning ${days} days for ${sentinelAddr}${country ? ` (country: ${country})` : ''}... (USDC settles only after a 2xx response)`);
  const result = await provisionAgent(sentinelAddr, days, country);
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
