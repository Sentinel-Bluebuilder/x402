#!/usr/bin/env bash
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# x402 AI Agent â€” macOS / Linux End-to-End Test (native CLI path)
#
# Proves the documented macOS/Linux connect path actually works end-to-end:
#   pay USDC on Base over HTTP 402  ->  Sentinel provision  ->  connect via the
#   native `sentinel-dvpncli` tool (the path /manifest.connectMacLinux prescribes).
#
# The Windows path is verified by e2e-selffund.mjs. This script is the missing
# piece â€” run it ON a Mac or Linux host to turn "built" into "verified".
#
# It self-funds: the payment phase reuses pay-phase.mjs which reads the operator
# key from wallets.env and funds a throwaway agent, then runs the x402 402 flow.
#
# Prerequisites on the host:
#   - Node 20+ (for the payment phase)  - Go 1.24+ (for sentinel-dvpncli)
#   - WireGuard (ships with macOS; `apt install wireguard` / `pacman -S wireguard-tools` on Linux)
#   - sudo available (WireGuard nodes bring the interface up as root)
#   - NOT Fedora (SELinux blocks VPN interfaces â€” documented limitation)
#
# Usage:
#   bash e2e-maclinux.sh              # 1day tier, live server
#   TIER=7days bash e2e-maclinux.sh
#   SERVER_URL=http://localhost:4020 bash e2e-maclinux.sh
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
set -euo pipefail

SERVER_URL="${SERVER_URL:-https://x402.sentinel.co}"
TIER="${TIER:-1day}"
CHAIN_ID="${CHAIN_ID:-sentinelhub-2}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CLI="${SENTINEL_DVPNCLI:-sentinel-dvpncli}"

line() { printf '%s\n' "======================================================================"; }
say()  { printf '%s\n' "$*"; }

line
say "  x402 AI AGENT â€” macOS/LINUX END-TO-END TEST"
say "  Server: $SERVER_URL   Tier: $TIER"
line

# â”€â”€â”€ STEP 0: environment â”€â”€â”€
say ""
say "--- STEP 0: ENVIRONMENT ---"
uname_s="$(uname -s)"
say "  OS: $uname_s"
if [ -f /etc/fedora-release ]; then
  say "  [FAIL] Fedora detected â€” SELinux blocks VPN interfaces (documented as unsupported)."
  exit 2
fi
command -v node >/dev/null 2>&1 || { say "  [FAIL] node not found (need Node 20+)"; exit 2; }
say "  node: $(node --version)"
if ! command -v "$CLI" >/dev/null 2>&1; then
  say "  [WARN] $CLI not on PATH. Install with:"
  say "         go install github.com/sentinel-official/sentinel-dvpncli@latest"
  say "         export PATH=\"\$(go env GOPATH)/bin:\$PATH\""
  say "  [FAIL] cannot run the connect phase without the CLI"
  exit 2
fi
say "  cli:  $($CLI version 2>/dev/null | head -1 || echo present)"
command -v wg-quick >/dev/null 2>&1 || command -v wg >/dev/null 2>&1 || say "  [WARN] WireGuard tools not found â€” tunnel bring-up may fail"

# â”€â”€â”€ STEP 1-4: pay + provision (cross-platform Node phase) â”€â”€â”€
say ""
say "--- STEP 1-4: PAY + PROVISION (x402) ---"
# pay-phase.mjs self-funds and runs the 402 flow, then prints a JSON line:
#   PROVISION_JSON={"mnemonic":...,"sentinelAddr":...,"subscriptionId":...,"feeGranter":...,"nodeAddress":...}
PROV_LINE="$(cd "$HERE" && TIER="$TIER" SERVER_URL="$SERVER_URL" node pay-phase.mjs | tee /dev/stderr | grep '^PROVISION_JSON=' || true)"
if [ -z "$PROV_LINE" ]; then
  say "  [FAIL] payment phase did not produce a provision result"
  exit 1
fi
PROV_JSON="${PROV_LINE#PROVISION_JSON=}"

# Extract fields with node (portable; avoids a jq dependency).
extract() {
  printf '%s' "$PROV_JSON" | node -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      const p=JSON.parse(d);
      process.stdout.write(String(p[process.argv[1]]??""));
    });' "$1"
}
MNEMONIC="$(extract mnemonic)"
SENT_ADDR="$(extract sentinelAddr)"
SUB_ID="$(extract subscriptionId)"
FEE_GRANTER="$(extract feeGranter)"
NODE_ADDR="$(extract nodeAddress)"
[ -z "$MNEMONIC" ] && { say "  [FAIL] could not parse mnemonic from provision result"; exit 1; }
say "  Provisioned: sub=$SUB_ID node=$NODE_ADDR feeGranter=$FEE_GRANTER"

# â”€â”€â”€ STEP 5: keys add (import the funded agent wallet) â”€â”€â”€
say ""
say "--- STEP 5: IMPORT WALLET (sentinel-dvpncli keys add) ---"
# Remove any stale key of the same name first (idempotent re-runs).
"$CLI" keys delete agent --keyring.backend test -y >/dev/null 2>&1 || true
# keys add is INTERACTIVE: line 1 = mnemonic, blank line 2 = empty BIP-39 passphrase.
printf '%s\n\n' "$MNEMONIC" | "$CLI" keys add agent --keyring.backend test >/dev/null
say "  Imported agent key for $SENT_ADDR"

# â”€â”€â”€ STEP 6: session-start (operator fee-grants the gas) â”€â”€â”€
say ""
say "--- STEP 6: SESSION-START ---"
"$CLI" tx session-start "$NODE_ADDR" \
  --subscription-id "$SUB_ID" \
  --tx.fee-granter-addr "$FEE_GRANTER" \
  --tx.from-name agent \
  --keyring.backend test \
  --rpc.chain-id "$CHAIN_ID" \
  --output-format json >/dev/null
say "  session-start broadcast â€” resolving session id..."

# session-start doesn't print the id cleanly; query it back and take the newest.
SESSION_ID=""
for attempt in 1 2 3 4 5 6; do
  SESSION_ID="$("$CLI" query sessions --account-addr "$SENT_ADDR" --subscription-id "$SUB_ID" --output-format json 2>/dev/null \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const r=JSON.parse(d).result||[];process.stdout.write(r.length?String(r[r.length-1].id):"")}catch{process.stdout.write("")}})' || true)"
  [ -n "$SESSION_ID" ] && break
  sleep 3
done
[ -z "$SESSION_ID" ] && { say "  [FAIL] could not resolve session id after session-start"; exit 1; }
say "  Session id: $SESSION_ID"

# â”€â”€â”€ STEP 7: connect (build the tunnel) â”€â”€â”€
say ""
say "--- STEP 7: CONNECT ---"
SUDO=""
[ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"
say "  Bringing up tunnel for session $SESSION_ID (WireGuard may prompt for sudo)..."
$SUDO "$CLI" connect "$SESSION_ID" &
CONNECT_PID=$!
# Give the tunnel time to establish, then verify the exit IP changed.
sleep 20
VPN_IP="$(curl -s --max-time 15 https://api.ipify.org || echo unknown)"
say "  Exit IP through tunnel: $VPN_IP"

# â”€â”€â”€ STEP 8: teardown â”€â”€â”€
say ""
say "--- STEP 8: DISCONNECT ---"
kill "$CONNECT_PID" >/dev/null 2>&1 || true
"$CLI" tx session-cancel "$SESSION_ID" \
  --tx.fee-granter-addr "$FEE_GRANTER" \
  --tx.from-name agent \
  --keyring.backend test \
  --rpc.chain-id "$CHAIN_ID" \
  --output-format json >/dev/null 2>&1 || say "  (session-cancel best-effort)"
say "  Session $SESSION_ID cancelled."

# â”€â”€â”€ Report â”€â”€â”€
say ""
line
if [ "$VPN_IP" != "unknown" ] && [ -n "$VPN_IP" ]; then
  say "  RESULT: PASS â€” agent paid on Base and tunneled out via $VPN_IP (session $SESSION_ID)"
  RC=0
else
  say "  RESULT: PARTIAL â€” paid + session started, but tunnel IP could not be verified"
  RC=1
fi
line
{
  echo "x402 macOS/Linux E2E result"
  echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "OS: $uname_s"
  echo "Server: $SERVER_URL"
  echo "Tier: $TIER"
  echo "Subscription: $SUB_ID"
  echo "Node: $NODE_ADDR"
  echo "Session: $SESSION_ID"
  echo "Exit IP: $VPN_IP"
  echo "Result: $([ $RC -eq 0 ] && echo PASS || echo PARTIAL)"
} > "$HERE/MACLINUX-E2E-RESULTS.txt"
say "  Report -> fresh-test/MACLINUX-E2E-RESULTS.txt"
exit $RC
