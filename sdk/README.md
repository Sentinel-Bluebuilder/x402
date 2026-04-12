# x402-connect

AI agents pay USDC on Base or Solana for private VPN access through Sentinel's 900+ decentralized nodes.

## Install

```bash
npm install x402-connect
```

## Usage

### Connect (Base)

```typescript
import { connect } from 'x402-connect';

const vpn = await connect({
  payment: {
    chain: 'base',
    walletKey: process.env.EVM_PRIVATE_KEY,
    hours: 720, // 30 days
  },
  country: 'US', // optional
});

console.log(vpn.connected);  // true
console.log(vpn.ip);         // '45.152.243.12'
console.log(vpn.country);    // 'United States'
console.log(vpn.expiresAt);  // '2026-05-12T...'
```

### Connect (Solana)

```typescript
const vpn = await connect({
  payment: {
    chain: 'solana',
    walletKey: process.env.SOLANA_SECRET_KEY, // JSON array format
    hours: 720,
  },
});
```

### Disconnect

```typescript
import { disconnect } from 'x402-connect';

await disconnect();
```

### Check Status

```typescript
import { status } from 'x402-connect';

const s = await status();
console.log(s.connected); // true or false
```

### Get Pricing

```typescript
import { getPricing } from 'x402-connect';

const pricing = await getPricing();
// { pricePerHourUsdc: '0.010000', minHours: 1, maxHours: 8760, chains: ['base', 'solana'] }
```

## What Happens Behind the Scenes

1. **Wallet** — Creates a Sentinel wallet (or loads your existing one)
2. **Register** — Registers your Sentinel address with our API, gets an agentId
3. **Pay** — Calls the payment contract on Base (or SPL transfer on Solana)
4. **Wait** — Polls our API until Sentinel allocation is confirmed
5. **Connect** — Establishes VPN tunnel directly with a decentralized node

Your Sentinel private key never leaves your machine. The tunnel is end-to-end encrypted between you and the node. We never see your traffic.

## Environment Variables

```
# Required for Base
X402_CONTRACT_ADDRESS=          # Payment contract on Base

# Required for Solana
X402_OPERATOR_USDC_ATA=         # Our USDC ATA on Solana

# Optional
X402_API_URL=http://localhost:3402  # Override API URL
```

## API

### `connect(opts): Promise<ConnectResult>`

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `payment.chain` | `'base' \| 'solana'` | Yes | Which chain to pay on |
| `payment.walletKey` | `string` | Yes | Private key (hex for Base, JSON array for Solana) |
| `payment.hours` | `number` | Yes | Hours of VPN access (1-8760) |
| `country` | `string` | No | Preferred country code |
| `sentinelMnemonic` | `string` | No | Reuse existing Sentinel wallet |
| `apiUrl` | `string` | No | Override API URL |
| `onProgress` | `function` | No | Progress callback: `(step, detail) => void` |

### `ConnectResult`

| Field | Type | Description |
|-------|------|-------------|
| `connected` | `boolean` | Whether VPN is active |
| `ip` | `string` | Your VPN IP address |
| `country` | `string` | Node country |
| `expiresAt` | `string` | ISO timestamp when access expires |
| `protocol` | `string` | `'wireguard'` or `'v2ray'` |
| `sessionId` | `string` | Sentinel session ID |
| `agentId` | `string` | Your agent registration ID |
| `sentinelAddress` | `string` | Your Sentinel address |
| `paymentTxHash` | `string` | Payment transaction hash |

## License

MIT
