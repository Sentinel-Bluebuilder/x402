# Changelog

## 2026-05-21 — Agent-Friendliness: Structured Errors + SDK Event Contract Fix

Closing the last gaps on agent-friendliness. Two ship lanes: the x402 server, and the underlying SDK consumers depend on.

### x402 server — structured error contract

`POST /vpn/connect/*` and any 404 now return a stable JSON shape:

```json
{
  "code": "STABLE_IDENTIFIER",
  "message": "human-readable",
  "nextAction": "what to do next",
  "docs": "/manifest"
}
```

Error codes published in `/manifest.response.errors.codes` and `docs/llms.txt`:

| `code` | HTTP | Pre-payment | Meaning |
|---|---|---|---|
| `MISSING_SENTINEL_ADDR` | 400 | yes | Body did not include `sentinelAddr` |
| `INVALID_SENTINEL_ADDR` | 400 | yes | `sentinelAddr` does not match `^sent1[0-9a-z]{38}$` |
| `UNKNOWN_TIER` | 404 | yes | Path tier is not `1day` \| `7days` \| `30days` |
| `PAYMENT_REQUIRED` | 402 | — | Sign EIP-3009 and resend (handled automatically by `@x402/fetch`) |
| `PROVISIONING_FAILED` | 500 | — | Payment settled but Sentinel TX failed. Safe to retry once |
| `NOT_FOUND` | 404 | — | No route matches. See `/manifest` |
| `INTERNAL_ERROR` | 500 | — | Unexpected server error |

**Pre-payment guarantee:** the three `pre-payment: yes` codes are returned *before* `paymentMiddleware` runs. Agents are never charged USDC for guaranteed-failure requests.

**Express HTML 404 is gone.** A JSON catch-all replaces it. Uncaught exceptions now render as `INTERNAL_ERROR` JSON instead of HTML stack traces.

**Verified locally:** all four error modes return structured JSON. Valid requests still flow through `paymentMiddleware` to HTTP 402.

Commits: [`3175833`](https://github.com/Sentinel-Bluebuilder/x402/commit/3175833), [`ceb59b9`](https://github.com/Sentinel-Bluebuilder/x402/commit/ceb59b9). GHCR image building now; `REDEPLOY.md` updated with the new commit and two verification probes the host operator can run after pulling.

### blue-js-sdk — `connect()` event contract fix

**PR:** [Sentinel-Bluebuilder/blue-js-sdk#32](https://github.com/Sentinel-Bluebuilder/blue-js-sdk/pull/32) — `fix(ai-path): connect() onProgress no longer fires 'log' duplicates`

**Problem.** `connect({ onProgress })` was firing both the structured stage event AND a sibling `'log'` event for the same line. Every progress line printed twice (or three times in consumer harnesses that also wired the raw SDK logger). Consumers had to filter `stage === 'log'` to avoid duplicates — undocumented and easy to miss.

**Fix.** The SDK's internal raw-log forwarder now routes lines to a new `opts.onLog(message)` callback only. `opts.onProgress(stage, detail)` fires exactly once per documented stage transition: `wallet`, `node-check`, `validate`, `session`, `handshake`, `tunnel`, `verify`, `dry-run`.

**New consumer surface:**

| Option | Behavior |
|---|---|
| `onProgress` | `(stage, detail) => void` — structured stages only |
| `onLog` | `(message) => void` — raw SDK log lines |
| `silent` | `true` suppresses the SDK's built-in `[STEP X/Y]` console output |

**Migration.** Consumers that filtered `stage === 'log'` can drop the check — that branch never fires anymore. Consumers that relied on the raw log spam through `onProgress` should switch to `onLog`. Non-breaking otherwise: no public-API rename, no signature change to `connect()` beyond the new optional `onLog` field.

Files changed: `ai-path/connect.js` (logic + JSDoc), `ai-path/README.md` (options table), `ai-path/FAILURES.md` (API-CONTRACT entry under "Pending Integration").

### Status by agent-friendliness dimension

| # | Dimension | Status |
|---|---|---|
| 1 | SDK output cleanliness (double-log) | Fixed at source. Lands for consumers when SDK PR #32 merges + publishes. |
| 2 | `instructions` field references `blue-js-sdk/ai-path` | Fixed in source. Lands publicly when host pulls latest image. |
| 3 | `/manifest` + `/nodes` reachable | Routes exist. Land publicly when host pulls latest image. |
| 4 | Error surface (machine-readable codes) | **Shipped — server + docs updated this session.** |
| 5 | Pre-payment guarantee (no USDC charged for guaranteed-failure requests) | **Shipped — enforced before `paymentMiddleware`.** |

Two are live in code and docs now. Three become 10/10 the moment the host on `x402.sentinel.co` runs `docker pull ghcr.io/sentinel-bluebuilder/x402:latest && restart`.

### Artifacts

- `x402` server: [`3175833`](https://github.com/Sentinel-Bluebuilder/x402/commit/3175833), [`ceb59b9`](https://github.com/Sentinel-Bluebuilder/x402/commit/ceb59b9)
- `blue-js-sdk` PR: [#32](https://github.com/Sentinel-Bluebuilder/blue-js-sdk/pull/32)
- Image: `ghcr.io/sentinel-bluebuilder/x402:latest` (publishes when GHCR build completes)
- Operator recipe: `REDEPLOY.md` in the x402 repo

---

## 2026-04-14 — E2E Test Suite + Dashboard

### Added
- **E2E Test Suite** (`server/test/test-fresh-agent.mjs`) — Full end-to-end test that creates fresh EVM + Sentinel wallets, funds on Base, pays via x402 HTTP 402 protocol, provisions on Sentinel (MsgShareSubscription + MsgGrantAllowance), connects VPN via WireGuard, disconnects, and captures every on-chain TX with explorer links
- **Dashboard** (`dashboard/`) — Visual E2E flow dashboard showing the complete 17-step x402 flow with:
  - Live test runner (SSE streaming) — click "Run New E2E Test" to execute a real test with real-time step updates
  - All 5 on-chain transactions with Basescan/Mintscan explorer links
  - Wallet cards (agent EVM, agent Sentinel, operator)
  - Protocol flow diagram (Agent → x402 Server → Base → Sentinel → dVPN Node)
  - Fee grant details (balance, allowed messages, expiration)
  - Timeline visualization
  - Pricing cards
  - 12 clickable explorer/API links
- **E2E Test Results** (`E2E-FRESH-AGENT.txt`) — Cleaned output from live mainnet test run (2026-04-14), 17 steps, 5 TXs, all private info redacted
- **x402 Flow ELI5** (`X402-FLOW-ELI5.txt`) — Plain-language explanation of the x402 payment flow
- **Server README** (`server/README.md`) — Setup, env vars, API endpoints, architecture docs

### Changed
- **Server** (`server/src/index.ts`) — Fixed facilitator setup, added self-hosted facilitator support
- **Sentinel provisioning** (`server/src/sentinel.ts`) — Added subscription pool management, MsgShareSubscription field fix (camelCase/snake_case mismatch), retry on depleted subscriptions
- **Landing page** (`docs/index.html`) — Updated for Base mainnet, real contract address, improved styling
- **README** — Updated project description
- **MANIFESTO** — Minor updates
- **.gitignore** — Added `memory/` directory

### Technical Details
- x402 payment: HTTP 402 → EIP-3009 transferWithAuthorization → zero gas for agent
- Sentinel provisioning: atomic TX with MsgShareSubscription + MsgGrantAllowance
- Fee grant: 5M udvpn, 4 allowed message types, agent pays 0 gas on Sentinel
- VPN tunnel: direct agent↔node via WireGuard, x402 server never sees traffic
- All Sentinel chain queries via RPC (not LCD)
- Dashboard SSE endpoint streams steps in real-time at `/api/test/run`

### Test Results (Mainnet)
- Agent: 0x8FA1D47589841902d39e308d65799B36A27Df075 (Base) / sent1xn5cq84jt9pa82k3hadnr54xxvguj3f7jqkevw (Sentinel)
- Session: 39227850, WireGuard, Columbus US
- Cost: $0.033 USDC for 1 day
- Connect time: 25.9s
- Total E2E time: 70s
- 5 on-chain TXs (2 Base, 3 Sentinel)
