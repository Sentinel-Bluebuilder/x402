# x402-connect

Earlier sketch of an all-in-one agent client — a single `connect()` call that bundled payment, provisioning, and tunnel setup.

The live agent flow uses two composed packages instead:

- **`@x402/fetch`** — wraps `fetch` to auto-sign EIP-3009 USDC transfers when a server returns HTTP 402
- **`blue-agent-connect`** — establishes the Sentinel VPN tunnel (WireGuard / V2Ray) once the server has provisioned the subscription + fee grant

See the root `README.md` for the current agent example, and `server/README.md` for the server side.

## The two designs side by side

This package's API:

```typescript
import { connect } from 'x402-connect';

const vpn = await connect({
  payment: { chain: 'base', walletKey: process.env.EVM_KEY, hours: 720 },
});
```

The live design:

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
```

No payment contract. No `agentId`. No polling. The server settles the EIP-3009 USDC transfer, provisions Sentinel atomically, and returns the credentials in the HTTP 200 response.
