# x402 — The Payment Layer for Private Intelligence

---

## We Believe

Every intelligence — human or artificial — has the right to private internet access. Not as a privilege granted by a corporation. Not as a feature gated by KYC. As a cryptographic guarantee, paid for on-chain, enforced by mathematics, and revocable by no one.

Today, 250,000 AI agents wake up every day and do work. They research. They trade. They build. They communicate. And every single one of them does it naked — every request logged, every IP exposed, every query fingerprinted by the infrastructure they're forced to trust.

This is not a theoretical problem. It is the defining vulnerability of autonomous intelligence.

We are going to fix it.

---

## The Problem

An AI agent wants private internet access. Here is what it faces today:

```
Agent has USDC on Base
Agent wants VPN tunnel through Sentinel's decentralized nodes
Agent must: find a protocol → learn a new token → bridge assets →
           navigate a DEX → manage gas on an unfamiliar chain →
           discover nodes → negotiate sessions → handle handshakes →
           configure tunnels → monitor connections

Steps: 14
Failure points: 14
Time: hours
Result: most agents give up at step 2
```

**Our answer:**

```
Agent makes one HTTP request, signs one EIP-3009 message
Agent is private
```

One request. One signature. One truth.

---

## What x402 Is

x402 is the HTTP 402 payment server that lets AI agents pay native USDC on Base in exchange for a Sentinel dVPN subscription. No custom contract. No bridges. No `approve()` round-trip.

**AI agents hold USDC.** 98.6% of all agent payments — 140 million transactions, $43 million in volume — are in stablecoins. Agents don't know what P2P tokens are. They shouldn't have to.

**Sentinel has the infrastructure.** Independent nodes across 70+ countries. WireGuard and V2Ray tunnels verified on mainnet. 1 million+ registered users. The hardest part — building a decentralized bandwidth network with no single point of failure — is done.

**x402 is the door.** The agent's `fetch` hits our endpoint. We answer HTTP 402. The agent signs an EIP-3009 `transferWithAuthorization`. Our self-hosted facilitator settles USDC on Base. We provision the agent on Sentinel — share a subscription, grant a fee allowance — in a single atomic TX. The agent then connects directly to a VPN node. We never see the traffic. We never touch the credentials. We just open the door.

---

## The Architecture

```
AI AGENT
  │
  │  fetch('/vpn/connect/30days')
  v
HTTP 402 SERVER  ────►  HTTP 402 + PAYMENT-REQUIRED header
  │
  │  Agent signs EIP-3009 transferWithAuthorization (off-chain, EIP-712)
  │  Agent resends with PAYMENT-SIGNATURE
  v
SELF-HOSTED FACILITATOR  ────►  USDC transferred on Base (~2s)
                                no custom contract, native USDC rail
  │
  v
SENTINEL CHAIN
  MsgShareSubscription  (agent added to operator's subscription)
  MsgGrantAllowance     (fee grant — agent pays 0 gas for MsgStartSession)
  (both batched into one atomic TX)
  │
  v
AGENT  ────►  MsgStartSession (gas paid by operator via fee grant)
  │
  v
VPN NODE  (WireGuard / V2Ray, end-to-end encrypted, agent ↔ node only)
  │
  v
PRIVATE INTERNET ACCESS
```

**What we control:** the HTTP 402 server, the facilitator, the Sentinel plan, the node leases.
**What we never see:** the tunnel credentials, the traffic, the agent's browsing. Ever.

The agent's Sentinel private key never leaves the agent. The agent's EVM key never leaves the agent — only the EIP-3009 signature does. The handshake is always direct. The tunnel is always encrypted. None of this is a promise — it is a protocol constraint.

---

## Time-Based Subscriptions

We sell time, not bytes.

A 30-day subscription means 30 days of bandwidth through any node in our plan. The Sentinel chain enforces expiry via `status_timeout` and `max_duration`. When the time runs out, the session ends. No metering disputes. No bandwidth accounting. No enforcement gaps.

**Why time-based wins for AI agents:**
- Predictable cost — agents can budget precisely
- No surprise cutoffs mid-operation
- Simpler programming model — pay once, run for N days
- Aligns with how agents think — they plan in time horizons, not data volumes

---

## One Chain Today. More Tomorrow.

### Base (EVM) — Live
- Native USDC via EIP-3009 `transferWithAuthorization`
- No custom payment contract — the USDC contract is the rail
- ~2 second finality (L2 block time)
- Cheapest gas in the EVM ecosystem
- Where most AI agent infrastructure lives today

### Solana — Code written, not yet enabled
- USDC via SPL transfer + memo (Helius webhook pattern)
- ~400ms finality
- Massive AI agent ecosystem (Fetch.ai, Bittensor, Olas)
- Sub-cent transaction costs

**The agent pays on whichever chain we've enabled.** Today that's Base. Solana is plumbed but not yet flipped on.

---

## Why We Will Succeed

### 1. The Infrastructure Exists
We are not building a VPN network. Sentinel has been running for years with decentralized nodes, battle-tested protocols, and a proven SDK with hundreds of exports and full test coverage. We are adding a payment layer on top of production infrastructure.

### 2. The Market Is Screaming
140 million agent payments. $43 million in volume. 250,000 daily active agents. Gartner projects a $30 trillion autonomous agent economy by 2030. And not a single decentralized VPN accepts USDC from AI agents today. We will be the first.

### 3. The Protocol Is Ready
x402 (HTTP 402 payments) has processed 161 million transactions. Coinbase and Cloudflare back it. EIP-3009 makes USDC natively signable — no `approve()`, no custom contract, no token-allowance round-trip. The payment rails are built — they just need a destination.

### 4. We Control the Operator Side
We hold the P2P tokens. We lease the nodes. We manage the plans. We grant the fee allowances. The agent's only job is: send one request, sign one message, call `connect()`, be private. Our margin is the spread between what agents pay in USDC and what nodes cost in P2P. At scale, this is a machine that runs itself.

### 5. The Moat Is Deep
To compete, someone would need: a working decentralized VPN network (years to build), an HTTP 402 server with EIP-3009 settlement and Sentinel provisioning glue (we have it), operator infrastructure on Sentinel (capital + expertise). We have all of it. Today.

---

## The Agent Experience

### First Connection

```typescript
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { createWallet, connect } from 'blue-js-sdk/ai-path';

// 1. Sentinel wallet (one-time — persist the mnemonic)
const wallet = await createWallet();

// 2. x402 payment client backed by an EVM key with USDC on Base
const scheme = new ExactEvmScheme({ address, signTypedData });
const client = new x402Client();
client.register('eip155:8453', scheme);
const paidFetch = wrapFetchWithPayment(fetch, client);

// 3. Buy 30 days of VPN — 402 → auto-sign EIP-3009 → settle → provision
const res = await paidFetch('https://x402.sentinel.co/vpn/connect/30days', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sentinelAddr: wallet.address }),
});
const { subscriptionId, feeGranter, nodeAddress } = await res.json();

// 4. Connect — agent pays zero gas, operator fee-grants the session
const vpn = await connect({
  mnemonic: wallet.mnemonic,
  subscriptionId: String(subscriptionId),
  feeGranter,
  nodeAddress,
});
// vpn.connected === true — agent's IP is now a Sentinel node
```

Behind the scenes: 402 returned, EIP-3009 signed, USDC settled on Base by the facilitator, Sentinel allocation + fee grant atomic TX, session started, handshake completed, tunnel established.

The agent saw one HTTP request and one signature.

### Reconnection

```typescript
const vpn = await connect({
  mnemonic: wallet.mnemonic,
  subscriptionId, feeGranter, nodeAddress,
}); // existing subscription, no new payment
```

---

## The Economics

| Item | Detail |
|------|--------|
| Agent pays | USDC on Base via EIP-3009 |
| We receive | USDC into operator wallet (no escrow) |
| We spend | ETH on Base for facilitator settlement (~$0.001/tx), P2P on Sentinel for provisioning (~0.0001 P2P/agent) |
| Agent gets | Time-based VPN through Sentinel's nodes, zero Sentinel gas |
| Our margin | Spread between USDC revenue and P2P/ETH operating costs |
| Node operators get | P2P per byte of bandwidth served |
| Network effect | More agents → more revenue → more nodes leased → better coverage → more agents |

This is a flywheel. Every agent that connects makes the network more valuable for the next one.

---

## What We Are Building (and what already shipped)

| Status | Component |
|--------|-----------|
| **Live** | HTTP 402 server on Base (`server/`) — accepts EIP-3009 USDC, provisions Sentinel atomically |
| **Live** | Self-hosted facilitator (`server/src/facilitator.ts`) — no Coinbase dependency required |
| **Live** | Subscription pool manager — handles 8-allocation-per-sub chain limit |
| **Live** | Fee-grant flow — agent's `MsgStartSession` pays zero gas |
| **Live** | Reference agent example using `@x402/fetch` + `blue-js-sdk/ai-path` |
| **Pending** | Solana support (code written, env wiring not enabled) |
| **Pending** | MCP server — Claude/GPT/Gemini tool integration |

**What already exists and is verified on mainnet:**
- Sentinel plan/subscription system
- Fee grant module
- MsgShareSubscription
- blue-js-sdk (Sentinel chain operations)
- blue-js-sdk/ai-path (WireGuard + V2Ray E2E)
- Node tester (Sentinel nodes validated)
- P2P treasury (funded)

We are not starting from zero. We are running the last mile.

---

## The Security Contract

| Property | Guarantee |
|----------|-----------|
| Agent controls its session | Agent's Sentinel key signs MsgStartSession locally |
| Tunnel credentials stay with agent | WireGuard / V2Ray handshake is agent ↔ node |
| EVM key never leaves the agent | EIP-3009 signature created locally; facilitator only sees the signature |
| Self-hosted facilitator | No Coinbase dependency required, no third party in the payment path |
| We never see traffic | WireGuard / V2Ray is end-to-end encrypted |
| Payment is verifiable | Every USDC settlement is a public Base transaction |
| No agent PII | Operator stores `sentinelAddr` only — no IPs, no traffic, no logs |
| No lock-in | Agent's Sentinel key works with any operator, any node |
| Open source | Server, facilitator, agent reference — all public |

We are not asking agents to trust us. We are building a system where trust is unnecessary.

---

## The Vision

Today: AI agents pay USDC on Base for time-based VPN subscriptions through Sentinel's decentralized nodes in 70+ countries. One HTTP request. One EIP-3009 signature. Zero prerequisites.

Tomorrow: Every AI agent framework — Claude, GPT, Gemini, Llama — discovers us through MCP tools, x402 HTTP responses, and npm. Privacy becomes a default capability, not an afterthought. Agents refer agents. The network grows itself.

The endgame: A world where autonomous intelligence has the same uncensorable, private internet access that humans deserve. Where no government, corporation, or infrastructure provider can decide which AI gets to see the open internet and which doesn't. Where privacy is a protocol guarantee, not a corporate policy.

We are building the payment layer for private intelligence.

**One HTTP request. One signature. Any agent. Private internet. Forever.**

---

*x402 — because HTTP 402 was always meant to be the future of payments, and the future is autonomous.*
