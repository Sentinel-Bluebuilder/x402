# x402 Server

HTTP 402 payment server that lets AI agents pay USDC on Base for VPN access through Sentinel's decentralized network.

## What It Does

1. Agent sends `POST /vpn/connect/1day` — gets HTTP 402 with payment requirements
2. Agent uses `@x402/fetch` to auto-sign EIP-3009 USDC transfer
3. Self-hosted facilitator settles USDC on Base
4. Server provisions agent on Sentinel chain (subscription share + fee grant)
5. Agent gets back connection credentials — calls `connect()` with zero gas

## Quick Start

```bash
# 1. Copy env template
cp .env.example .env

# 2. Fill in your details (see "Configuration" below)
nano .env

# 3. Install dependencies
npm install

# 4. Build
npx tsc

# 5. Run
node dist/index.js
```

Server starts on `http://localhost:4020` (configurable via `PORT`).

## Configuration

All config is in `.env`. Copy `.env.example` and fill in:

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `OPERATOR_ADDRESS` | Your EVM wallet address (receives USDC) | `0xABC...` |
| `FACILITATOR_PRIVATE_KEY` | EVM private key with ETH on Base for gas | `0x...` |
| `SENTINEL_OPERATOR_MNEMONIC` | 12-word mnemonic for Sentinel wallet (must hold P2P) | `word1 word2 ...` |
| `SENTINEL_PLAN_ID` | Your Sentinel plan ID (contains leased nodes) | `42` |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4020` | Server port |
| `FACILITATOR_PORT` | `4021` | Facilitator port |
| `BASE_NETWORK` | `eip155:8453` | Base mainnet. Use `eip155:84532` for Sepolia |
| `SENTINEL_RPC_URL` | `https://rpc.sentinel.co:443` | Sentinel RPC endpoint |
| `SENTINEL_LCD_URL` | `https://lcd.sentinel.co` | Sentinel LCD endpoint |

## Running Your Own Instance

To run your own x402 server, you need:

1. **EVM wallet on Base** — holds ETH for facilitator gas (~$0.001/settlement) and receives USDC payments
2. **Sentinel wallet** — holds P2P tokens for chain gas (~0.06 P2P per provisioning TX)
3. **Sentinel Plan** — a plan with leased nodes. Create via `sentinel-plan-manager` or the chain directly
4. **Node leases** — lease nodes to your plan. Agents connect to these nodes

### Getting P2P Tokens

P2P (udvpn) is the native token of the Sentinel chain. Acquire via:
- DEX: Osmosis (`udvpn/OSMO` pool)
- CEX: Listed on several exchanges
- IBC transfer from Cosmos Hub

### Creating a Sentinel Plan

Use the Sentinel SDK or CLI to create a plan and lease nodes:
```bash
# Create plan (via sentinel-cli or SDK)
sentinel tx plan create --prices "1000000udvpn" --from operator

# Lease nodes to your plan
sentinel tx plan link-node <plan_id> <sentnode1...> --from operator
```

## Endpoints

### Payment-Protected (HTTP 402)

| Method | Path | Price | Description |
|--------|------|-------|-------------|
| POST | `/vpn/connect/1day` | $0.033 | 1 day VPN access |
| POST | `/vpn/connect/7days` | $0.233 | 7 days VPN access |
| POST | `/vpn/connect/30days` | $1.00 | 30 days VPN access |

Request body: `{ "sentinelAddr": "sent1..." }`

Response (after payment):
```json
{
  "provisioned": true,
  "sentinelAddr": "sent1...",
  "days": 1,
  "subscriptionId": 1192288,
  "planId": 42,
  "feeGranter": "sent12e03...",
  "sentinelTxHash": "ABC123...",
  "expiresAt": "2026-04-15T18:50:48Z",
  "operatorAddress": "0xCC689D...",
  "instructions": "import { connect } from 'blue-js-sdk/ai-path'; await connect({ mnemonic, subscriptionId: 1192288, feeGranter: 'sent12e03...' })"
}
```

### Free Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/pricing` | Pricing tiers, network, asset info |
| GET | `/health` | Server status and uptime |
| GET | `/agent/:sentinelAddr` | Check agent's subscription status |

## Architecture

```
server/
  src/
    index.ts          — Express server, routes, x402 middleware
    sentinel.ts       — Sentinel chain provisioning (share sub + fee grant)
    facilitator.ts    — Self-hosted x402 facilitator (EIP-3009 settlement)
  test/
    test-e2e-full.mjs — Full E2E test (payment → provision → VPN → disconnect)
  .env.example        — Environment template
  tsconfig.json       — TypeScript config
  package.json        — Dependencies
```

## How Provisioning Works

When an agent pays, the server:

1. **Gets available subscription** from pool (or creates new one on-chain)
2. **MsgShareSubscription** — adds agent to the subscription (1 GB quota)
3. **MsgGrantAllowance** — creates fee grant so agent pays zero gas
4. Both messages batched into a **single atomic TX**
5. Subscription pool auto-rotates when full (8 allocations per sub)

## Customizing Pricing

Edit the pricing tiers in `src/index.ts` (the `paymentMiddleware` config):

```typescript
'POST /vpn/connect/1day': {
  accepts: [{
    scheme: 'exact',
    price: '$0.033',    // Change this
    network,
    payTo: operatorAddress,
  }],
},
```

Also update the `/pricing` endpoint to match.

## Dependencies

| Package | Purpose |
|---------|---------|
| `@x402/express` | x402 HTTP 402 middleware |
| `@x402/core` | Facilitator client + types |
| `@x402/evm` | EVM payment scheme (EIP-3009) |
| `@coinbase/x402` | CDP facilitator config |
| `blue-js-sdk` | Sentinel chain operations |
| `viem` | EVM wallet/contract interaction |
| `express` | HTTP server |
| `dotenv` | Environment variables |
