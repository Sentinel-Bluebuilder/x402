# x402-connect — DEPRECATED

> **This package is deprecated and was never published.**
>
> The agent-facing flow it described (custom payment contract + agentId registration + polling API for allocation) has been replaced by the HTTP 402 + EIP-3009 flow.
>
> **Use these instead:**
>
> - **`@x402/fetch`** — wraps `fetch` to auto-sign EIP-3009 USDC transfers when a server returns HTTP 402
> - **`blue-agent-connect`** — establishes the actual Sentinel VPN tunnel (WireGuard / V2Ray) once the server has provisioned the subscription + fee grant
>
> See the root `README.md` for the current agent example, and `server/README.md` for the server side.
>
> The contents of this directory remain only as historical reference. Do not install, build, or publish.

---

## What replaced it

Old (this directory):

```typescript
import { connect } from 'x402-connect';

const vpn = await connect({
  payment: { chain: 'base', walletKey: process.env.EVM_KEY, hours: 720 },
});
```

New (live):

```typescript
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { createWallet, connect } from 'blue-agent-connect';

const wallet = await createWallet();
const scheme = new ExactEvmScheme({ address, signTypedData });
const client = new x402Client();
client.register('eip155:8453', scheme);
const paidFetch = wrapFetchWithPayment(fetch, client);

const res = await paidFetch('https://x402.blue/vpn/connect/30days', {
  method: 'POST',
  body: JSON.stringify({ sentinelAddr: wallet.address }),
});
const { subscriptionId, feeGranter, nodeAddress } = await res.json();
const vpn = await connect({ mnemonic: wallet.mnemonic, subscriptionId, feeGranter, nodeAddress });
```

No payment contract. No agentId. No polling. The server settles the EIP-3009 USDC transfer, provisions Sentinel atomically, and returns the credentials in the HTTP 200 response.
