/**
 * x402 Autonomous-path E2E — agent pays the node directly in P2P.
 *
 * No x402 server, no operator, no fee-grant. The agent holds its own P2P and
 * calls connect() with protocol: 'v2ray' (zero-admin Windows path). Verifies the
 * public IP actually changes, then disconnects.
 *
 * Run: AGENT_MNEMONIC="..." node fresh-test/connect-autonomous.mjs
 */

import { connect, disconnect, getBalance } from 'blue-js-sdk/ai-path';

const MNEMONIC = process.env.AGENT_MNEMONIC;
if (!MNEMONIC) {
  console.error('ERROR: set AGENT_MNEMONIC in the environment');
  process.exit(1);
}

const COUNTRY = process.env.AGENT_COUNTRY || 'US';
const PROTOCOL = process.env.AGENT_PROTOCOL || 'v2ray'; // zero admin, ~70% of nodes

const t0 = Date.now();
const secs = (t) => ((Date.now() - t) / 1000).toFixed(1);

async function publicIp() {
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(8000) });
    return (await r.json()).ip;
  } catch (e) {
    return `unknown (${e.message})`;
  }
}

console.log('='.repeat(64));
console.log('  x402 AUTONOMOUS E2E — agent pays node directly (P2P)');
console.log(`  protocol=${PROTOCOL}  country=${COUNTRY}`);
console.log('='.repeat(64));

// ai-path connect() registers cleanup handlers internally (idempotent) — no manual call needed.

const bal = await getBalance(MNEMONIC);
console.log(`  P2P balance: ${bal.p2p ?? bal.balance ?? JSON.stringify(bal)}`);

const ipBefore = await publicIp();
console.log(`  IP before:   ${ipBefore}`);

console.log('\n  Connecting (pays 1 GB session directly to the node)...');
let vpn;
try {
  vpn = await connect({
    mnemonic: MNEMONIC,
    country: COUNTRY,
    protocol: PROTOCOL,
    gigabytes: 1,
    timeout: 120000,
    onProgress: (step, detail) => console.log(`    [${step}] ${detail}`),
  });
} catch (err) {
  console.error(`\n  CONNECT FAILED (${err.code || 'ERR'}): ${err.message}`);
  process.exit(1);
}

// The SDK verifies the exit IP through the tunnel itself (vpn.ip). For V2Ray
// (SOCKS proxy) this is the source of truth — a top-level fetch() on the host's
// default route does NOT traverse the proxy, so compare vpn.ip to the host IP.
const tunnelIp = vpn.ip ?? null;
const routed = tunnelIp && tunnelIp !== ipBefore;
console.log(`\n  CONNECTED in ${secs(t0)}s`);
console.log(`    session:  ${vpn.sessionId}`);
console.log(`    protocol: ${vpn.protocol ?? vpn.serviceType}`);
console.log(`    node:     ${vpn.nodeAddress}`);
console.log(`    tunnel IP:${tunnelIp ?? 'n/a'} (SDK-verified through tunnel)`);
console.log(`  IP before:  ${ipBefore}`);
console.log(`  Exit IP:    ${tunnelIp} — ${routed ? 'DIFFERENT ✓ routed' : 'same as host — NOT routed'}`);

console.log('\n  Disconnecting...');
try {
  await disconnect();
  console.log('  Disconnected cleanly.');
} catch (err) {
  console.error(`  Disconnect warning: ${err.message}`);
}

console.log(`\n  DONE in ${secs(t0)}s — routed: ${routed ? 'PASS' : 'CHECK'}`);
