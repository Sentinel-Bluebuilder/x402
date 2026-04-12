# x402 API

Backend service that bridges USDC payments on Base/Solana to Sentinel VPN allocations.

## What It Does

1. **Registers agents** — maps agentId to Sentinel address
2. **Watches Base** for `VpnPayment` events from our contract
3. **Watches Solana** for USDC transfers with x402 memo (via Helius webhooks)
4. **Provisions on Sentinel** — MsgShareSubscription + MsgGrantAllowance in one atomic TX
5. **Manages subscription pool** — handles the 8-allocation-per-subscription limit
6. **Retries failed provisioning** — exponential backoff ensures agents get what they paid for

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/register` | Register agent, get agentId |
| GET | `/api/agent/:agentId` | Agent details + payment history |
| GET | `/api/payment/:txHash` | Payment status (received/verified/allocated/failed) |
| GET | `/api/pricing` | Current pricing info |
| GET | `/api/health` | Pool stats, retry queue, uptime |
| POST | `/webhook/helius` | Solana payment webhook (Helius) |

## Setup

```bash
cp .env.example .env
# Edit .env with your keys
npm install
npm run dev
```

## Database

SQLite via sql.js (WASM — no native compilation needed). Tables:

- `agents` — agentId <-> sentinel_address mapping
- `payments` — every USDC payment with status tracking
- `subscription_pool` — operator's Sentinel subscriptions (8 alloc limit)
- `retry_queue` — exponential backoff for failed Sentinel TXs

Data stored in `./data/x402.db`, created automatically on first run.

## Registration Flow

```
POST /api/register
Body: { "sentinelAddr": "sent1..." }
Response: { "agentId": "uuid", "sentinelAddr": "sent1..." }
```

- Validates bech32 `sent1...` format
- Idempotent — same address returns same agentId
- agentId is used in payment contract calls (not the sentinel address)

## Payment Processing

### Base (EVM)
Backend watches `VpnPayment` events via ethers WebSocket. On event:
1. Dedup by tx_hash
2. Resolve agentId -> sentinel_address
3. Verify amount matches pricing
4. Provision on Sentinel (share subscription + fee grant)

### Solana
Helius webhook delivers enhanced transactions. On webhook:
1. Verify auth header
2. Parse memo: `x402:<agentId>:hours:<N>`
3. Verify USDC transfer to our ATA
4. Same provisioning flow as Base
