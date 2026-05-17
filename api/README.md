# x402 API — DEPRECATED

> **This directory is deprecated and no longer used.**
>
> Earlier iterations of x402 used a custom Solidity payment contract (`contracts/base/BlueVpnPayment.sol`) plus this event-watcher relayer to bridge on-chain payments to Sentinel allocations. That design has been replaced by the HTTP 402 + EIP-3009 flow in `server/`, which uses native USDC `transferWithAuthorization` (no custom contract, no event watcher, no SQLite database).
>
> **Live implementation:** `server/` — see `server/README.md`.
>
> The contents below are kept only as historical reference. Do not run, deploy, or build against this code.

---

## Historical Reference

What this service used to do:

1. Registered agents — mapped agentId to Sentinel address
2. Watched Base for `VpnPayment` events from `BlueVpnPayment.sol`
3. Watched Solana for USDC transfers with x402 memo (via Helius webhooks)
4. Provisioned on Sentinel — MsgShareSubscription + MsgGrantAllowance in one atomic TX
5. Managed subscription pool — handled the 8-allocation-per-subscription limit
6. Retried failed provisioning — exponential backoff

The current `server/` implementation does steps 4–6 directly from the HTTP 402 payment handler, with no event watching, no agentId registration, no SQLite, and no payment contract.
