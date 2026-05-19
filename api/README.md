# x402 API

Event-watcher relayer that bridges on-chain Base payments to Sentinel allocations. Agents register off-chain to get an `agentId`, then call `BlueVpnPayment.pay(agentId, numDays)` on a custom contract; this service watches for the resulting `VpnPayment` event and provisions Sentinel access.

The canonical x402 implementation is `server/` — it uses HTTP 402 + EIP-3009 `transferWithAuthorization` instead, which needs no custom contract, no event watcher, no SQLite, and auto-creates Sentinel subscriptions on demand. The live deployment at [x402.sentinel.co](https://x402.sentinel.co) runs `server/`. This directory is an alternative implementation kept for the on-chain-event design.

## What it does

1. **Registers agents** — maps `agentId` to a Sentinel address
2. **Watches Base** — listens for `VpnPayment` events from `contracts/base/BlueVpnPayment.sol`
3. **Watches Solana** — listens for USDC transfers with x402 memo via Helius webhooks
4. **Provisions on Sentinel** — `MsgShareSubscription` + `MsgGrantAllowance` in one atomic TX
5. **Manages a subscription pool** — 8 allocations per subscription; operator pre-creates pool entries (no auto-create)
6. **Retries failed provisioning** — exponential backoff

## Requirements

- Deployed `BlueVpnPayment` on Base (see `contracts/base/`)
- `PAYMENT_CONTRACT_ADDRESS`, `OPERATOR_EVM_ADDRESS`, `SENTINEL_OPERATOR_MNEMONIC`, `SENTINEL_PLAN_ID` in env
- Pre-populated subscription pool (call `db.insertSubscription(subId, planId)` after creating subs on-chain)

## Why `server/` instead

The on-chain-event design has more moving parts: a contract to deploy + maintain, an event watcher that must stay connected to a Base WS endpoint, an operator-managed subscription pool, and a SQLite store for payment state. The EIP-3009 design in `server/` collapses all of that into a single HTTP handler — the payment, settlement, and provisioning happen in one request/response cycle, with subscription auto-creation when the pool runs dry.
