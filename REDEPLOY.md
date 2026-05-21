# Redeploy x402.sentinel.co

The latest image is built and pushed. The host needs to pull and restart.

## What changed (commits since the running build)

| SHA | Title |
|---|---|
| `3175833` | server: structured JSON errors + pre-payment validation |
| `7099f15` | server: fix manifest URLs (x402.blue → x402.sentinel.co, repo links) |
| `3d14045` | docs: fix dead x402.blue URL, add USDC bootstrap section *(docs-only, no code)* |
| `1b1fdb9` | treewide: rename `blue-agent-connect` → `blue-js-sdk/ai-path` |
| `4f04835` | server: add `GET /manifest` + `/nodes` for AI-agent discovery |
| `a10db35` | dashboard: restructure on EventEmitter-based SSE pattern *(dashboard-only)* |

The running build is **47+ hours old** and predates all of these.

## Why this matters

Currently the server's 200 response from `POST /vpn/connect/<tier>` ships:
```json
"instructions": "import { connect } from 'blue-agent-connect'; ..."
```

That package name is dead — it was renamed to `blue-js-sdk/ai-path`. The corrected source is in `7099f15`. The full flow works because the docs (HTML + llms.txt) teach the correct import, but agents that read the response's `instructions` field get bad copy-paste.

Also the manifest at `GET /manifest` currently 404s (route added in `4f04835`) — the discovery surface AI agents are supposed to hit first.

## Image

GHCR built and pushed by `.github/workflows/build.yml` on push to master.

- **Latest tag:** `ghcr.io/sentinel-bluebuilder/x402:latest`
- **Pinned by SHA:** `ghcr.io/sentinel-bluebuilder/x402:7099f1532faaaf0e0c40c81f63b842c9d3787c69`
- CI run: https://github.com/Sentinel-Bluebuilder/x402/actions/runs/26253289974 (✅ success, 55s)

If `ghcr.io/sentinel-bluebuilder/x402` is private, the host may need a `docker login ghcr.io` with a token that has `read:packages`.

## Redeploy

Whatever orchestrator is running it (compose / systemd / k8s / bare docker), the recipe is:

```bash
docker pull ghcr.io/sentinel-bluebuilder/x402:latest
docker stop x402 && docker rm x402         # adjust container name
docker run -d \
  --name x402 \
  --restart unless-stopped \
  -p 4020:4020 \
  -p 4021:4021 \
  --env-file /path/to/server/.env \
  ghcr.io/sentinel-bluebuilder/x402:latest
```

If they use `docker compose`:

```bash
docker compose pull
docker compose up -d
```

## Verify after restart

```bash
# Uptime should reset to seconds, not hours
curl -s https://x402.sentinel.co/health
# {"status":"ok","uptime":12.345}

# Manifest must respond (currently 404 on the old build)
curl -s https://x402.sentinel.co/manifest | head -c 200

# Nodes route must respond (currently 404 on the old build)
curl -s https://x402.sentinel.co/nodes

# Error surface must be structured JSON (currently empty/HTML on the old build)
curl -s -X POST https://x402.sentinel.co/vpn/connect/forever -H 'Content-Type: application/json' -d '{}'
# Expect: {"code":"UNKNOWN_TIER","message":"Tier 'forever' does not exist...",...}

curl -s -X POST https://x402.sentinel.co/vpn/connect/1day -H 'Content-Type: application/json' -d '{"sentinelAddr":"hello"}'
# Expect: {"code":"INVALID_SENTINEL_ADDR","message":"...","expectedPattern":"^sent1[0-9a-z]{38}$",...}

# A real provisioning call's instructions string must reference blue-js-sdk/ai-path
# (no easy curl — running the end-to-end test from fresh-test/connect-docs-driven.mjs
#  is the cleanest check; verifies instructions field has the correct package name)
```

## Env vars (no changes from current `.env`)

Nothing new is required. The image reads the same variables it always has:

| Required | |
|---|---|
| `OPERATOR_ADDRESS` | EVM wallet receiving USDC on Base |
| `FACILITATOR_PRIVATE_KEY` | EVM key with ETH on Base for facilitator gas |
| `SENTINEL_OPERATOR_MNEMONIC` | 12-word Sentinel mnemonic with P2P |
| `SENTINEL_PLAN_ID` | Sentinel plan ID with leased nodes (currently 243) |

| Optional (defaults shown) | |
|---|---|
| `PORT=4020` | Server port |
| `FACILITATOR_PORT=4021` | Self-hosted facilitator port |
| `BASE_NETWORK=eip155:8453` | Base mainnet |
| `SENTINEL_RPC_URL=https://rpc.sentinel.co:443` | |
| `SENTINEL_LCD_URL=https://lcd.sentinel.co` | LCD fallback |

## Rollback

If anything misbehaves, pin to the previous good SHA:

```bash
docker pull ghcr.io/sentinel-bluebuilder/x402:1b1fdb9...   # last known-good SHA
# or any earlier tag from https://github.com/Sentinel-Bluebuilder/x402/pkgs/container/x402
```

The currently running build corresponds to a SHA from ~2026-05-19 — we don't know exactly which, but `:1b1fdb9...` is a safe rollback (it's behind by only 2 commits, both narrow scope).

## Risk

- **Low.** The server's TS build is clean. Routes added (`/manifest`, `/nodes`) are additive. The `instructions` string change is a pure string. No schema changes, no DB migrations, no env-var changes.
- **Tested:** end-to-end test against the *current* server passes today (Romania node, 24.9s, zero friction). The new image only differs in: (1) `instructions` field content, (2) two new GET endpoints, (3) manifest URLs in the manifest body.

## Contact for questions

The end-to-end test that validates everything is:

```bash
cd fresh-test
node connect-docs-driven.mjs
```

It costs ~$0.033 USDC (1-day tier) on Base, connects through a real Sentinel node, and disconnects cleanly. Run it before and after the redeploy to compare.
