# x402

**AI agents pay USDC on Base for private internet access through Sentinel's decentralized VPN network.**

Live at **[x402.sentinel.co](https://x402.sentinel.co)**.

One HTTP request. No KYC. No accounts. No P2P tokens. No custom contract to deploy. The agent signs an EIP-3009 USDC transfer, our facilitator settles it on Base, the server provisions a Sentinel subscription with a gas fee grant, and the agent connects to the VPN — paying zero gas.

```typescript
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { createWallet, connect } from 'blue-agent-connect';

const wallet = await createWallet();

const scheme = new ExactEvmScheme({ address, signTypedData });
const client = new x402Client();
client.register('eip155:8453', scheme);
const paidFetch = wrapFetchWithPayment(fetch, client);

const res = await paidFetch('https://x402.sentinel.co/vpn/connect/30days', {
  method: 'POST',
  body: JSON.stringify({ sentinelAddr: wallet.address }),
});

const { subscriptionId, feeGranter, nodeAddress } = await res.json();
const vpn = await connect({ mnemonic: wallet.mnemonic, subscriptionId, feeGranter, nodeAddress });
// vpn.connected === true — agent's IP is now a Sentinel node, zero gas paid
```

---

## How It Works

```
Agent                          x402 Server                    Sentinel Chain
─────                          ───────────                    ──────────────

1. POST /vpn/connect/30days    Returns HTTP 402 +
   { sentinelAddr }            PAYMENT-REQUIRED header
                  │            (amount, asset, payTo, network)
                  │
2. @x402/fetch reads 402,      Facilitator verifies + settles
   signs EIP-3009              USDC transfer on Base (~2s)
   transferWithAuthorization
                  │                    │
3. Resends with                ──────────────────────────────> MsgShareSubscription
   PAYMENT-SIGNATURE           Server then sends one atomic    + MsgGrantAllowance
                  │            Sentinel TX:                    (fee grant for agent)
                  │
4. 200 OK with provisioning    Returns subscriptionId,
   credentials                 feeGranter, nodeAddress, nodes[]
                  │
5. connect({ mnemonic,         ─────────────────────────────> MsgStartSession
   subscriptionId, feeGranter,                                (gas paid by operator)
   nodeAddress })
                  │
6. Handshake directly with VPN node (WireGuard/V2Ray). We never see the tunnel.
                  │
7. VPN tunnel up. Agent is private.
```

**Key property:** USDC payment uses native EIP-3009 `transferWithAuthorization` — no custom contract to deploy, no `approve()` step, no token-allowance round-trip. The asset address in every payment is the canonical USDC contract on Base: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.

## Architecture

```
x402/
├── server/              — x402 HTTP 402 VPN server (the one you run)
│   └── src/
│       ├── index.ts          — Express routes + x402 paymentMiddleware
│       ├── facilitator.ts    — Self-hosted EIP-3009 facilitator
│       └── sentinel.ts       — MsgShareSubscription + MsgGrantAllowance
│
├── client/              — Reference agent client (@x402/fetch wrapper)
│
├── docs/                — Public site (docs/index.html)
│
└── fresh-test/          — End-to-end tests against a live server
```

> **⚠️ Deprecated paths — do not use `contracts/` or `api/`.** Earlier iterations included a custom Solidity payment contract (`BlueVpnPayment.sol`) plus an event-watcher relayer in `api/`. That design has been replaced by the HTTP 402 + EIP-3009 flow in `server/`, which needs no contract, no event watcher, no database, and auto-creates Sentinel subscriptions on demand. The deprecated directories are kept only as historical reference. The live deployment at [x402.sentinel.co](https://x402.sentinel.co) runs `server/`.

## Chains

| Chain | Payment Method | Status |
|-------|----------------|--------|
| **Base** | Native USDC + EIP-3009 `transferWithAuthorization` (no custom contract) | **Live on mainnet** |
| **Solana** | SPL USDC transfer + memo (Helius webhook) | Code written, not yet enabled |

## Pricing

| Endpoint | Days | Price |
|---|---|---|
| `POST /vpn/connect/1day` | 1 | $0.033 USDC |
| `POST /vpn/connect/7days` | 7 | $0.233 USDC |
| `POST /vpn/connect/30days` | 30 | $1.00 USDC |

Pricing is configurable per operator — see `server/src/index.ts`.

## Quick Start

### Run your own server

```bash
cd server
cp .env.example .env          # fill in operator details (see below)
npm install
npx tsc
node dist/index.js
```

Server starts on `http://localhost:4020`. The self-hosted facilitator starts on `:4021`.

You need:

1. **EVM wallet on Base** — receives USDC payments, also funds the facilitator (~0.001 ETH per settlement)
2. **Sentinel wallet** — holds P2P tokens for chain gas (~0.06 P2P per agent provisioning)
3. **Sentinel plan** — with leased nodes (your nodes, or rented from operators)

### Connect as an agent

```bash
npm install @x402/fetch @x402/evm blue-agent-connect viem
```

```typescript
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { createWallet, connect, disconnect } from 'blue-agent-connect';

// 1. Sentinel wallet (one-time — persist the mnemonic)
const wallet = await createWallet();

// 2. x402 payment client backed by an EVM key with USDC on Base
const account = privateKeyToAccount(process.env.EVM_KEY);
const viemClient = createWalletClient({
  account, chain: base, transport: http('https://mainnet.base.org'),
});
const scheme = new ExactEvmScheme({
  address: account.address,
  signTypedData: (msg) => viemClient.signTypedData(msg),
});
const client = new x402Client();
client.register('eip155:8453', scheme);
const paidFetch = wrapFetchWithPayment(fetch, client);

// 3. Buy 30 days of VPN — 402 → auto-sign → settle → provision
const res = await paidFetch('https://x402.sentinel.co/vpn/connect/30days', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sentinelAddr: wallet.address }),
});
const provision = await res.json();
// { subscriptionId, feeGranter, nodeAddress, nodes, expiresAt, ... }

// 4. Connect — agent pays zero gas, operator fee-grants the session
const vpn = await connect({
  mnemonic: wallet.mnemonic,
  nodeAddress: provision.nodeAddress,
  subscriptionId: String(provision.subscriptionId),
  feeGranter: provision.feeGranter,
});

console.log(`VPN up: ${vpn.ip} via ${vpn.protocol}`);

await disconnect();
```

## Endpoints

### Payment-protected (HTTP 402)

| Method | Path | Price | Body |
|---|---|---|---|
| POST | `/vpn/connect/1day` | $0.033 | `{ sentinelAddr }` |
| POST | `/vpn/connect/7days` | $0.233 | `{ sentinelAddr }` |
| POST | `/vpn/connect/30days` | $1.00 | `{ sentinelAddr }` |

Response after settlement:
```json
{
  "provisioned": true,
  "subscriptionId": 1192288,
  "planId": 42,
  "feeGranter": "sent1...",
  "nodeAddress": "sentnode1...",
  "nodes": ["sentnode1a...", "sentnode1b...", "..."],
  "sentinelTxHash": "...",
  "expiresAt": "2026-05-14T18:50:48Z"
}
```

### Free (no payment)

| Method | Path | Description |
|---|---|---|
| GET | `/pricing` | Tier table, asset, payTo, network |
| GET | `/nodes` | Nodes in the operator's plan |
| GET | `/health` | Server uptime |
| GET | `/agent/:sentinelAddr` | Agent's subscription + fee-grant status |

## Security

| Property | Guarantee |
|---|---|
| Agent controls its session | Agent's Sentinel mnemonic signs MsgStartSession locally |
| Tunnel credentials stay with agent | WireGuard/V2Ray handshake is agent ↔ node |
| EVM key never leaves the agent | EIP-3009 signature created locally; facilitator only sees the signature |
| Self-hosted facilitator | No Coinbase, no third party in the payment path |
| Payment is verifiable | Every USDC settlement is a public Base transaction |
| No agent PII | Operator stores `sentinelAddr` only — no IPs, no traffic, no logs |

## Costs (operator side)

| Item | Approx. cost |
|---|---|
| EIP-3009 settlement on Base | ~$0.001 ETH |
| Sentinel provisioning TX (per agent) | ~$0.0001 in P2P |
| VPS for the server | $5–10/month |

## Environment Variables (`server/.env`)

```
# ─── Base / payments ───
OPERATOR_ADDRESS=0x...                       # Receives USDC payments
BASE_NETWORK=eip155:8453                     # Or eip155:84532 for Sepolia

# ─── Facilitator (pick ONE) ───
FACILITATOR_PRIVATE_KEY=0x...                # Self-hosted, needs ETH on Base
FACILITATOR_PORT=4021
# CDP_API_KEY_ID=                            # Or use Coinbase CDP
# CDP_API_KEY_SECRET=

# ─── Sentinel ───
SENTINEL_OPERATOR_MNEMONIC=word1 word2 ...   # 12-word mnemonic, holds P2P
SENTINEL_PLAN_ID=42                          # Plan with leased nodes
SENTINEL_RPC_URL=https://rpc.sentinel.co:443
SENTINEL_LCD_URL=https://lcd.sentinel.co

# ─── Server ───
PORT=4020
```

See `server/.env.example` for the full template.

## License

MIT
