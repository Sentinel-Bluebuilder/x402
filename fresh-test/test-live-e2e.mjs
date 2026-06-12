/**
 * x402 AI Agent Ease-of-Use Test v2
 *
 * Follows the CURRENT docs/index.html instructions exactly.
 * Every friction point is logged dynamically (not hardcoded).
 * At the end, a 0-100 score is produced.
 *
 * The page says (Managed Plan flow):
 *   1. npm install @x402/fetch @x402/evm blue-js-sdk viem
 *   2. Create Sentinel wallet via createWallet() from blue-js-sdk/ai-path
 *   3. Set up x402Client + ExactEvmScheme + wrapFetchWithPayment
 *   4. POST /vpn/connect/1day with { sentinelAddr }
 *   5. connect({ mnemonic, nodeAddress: provision.nodeAddress, subscriptionId, feeGranter })
 *   6. disconnect()
 */

import { ethers } from 'ethers';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { writeFileSync } from 'fs';

// ─── Friction Log ───

const friction = [];
let totalDeductions = 0;
let totalScore = 0;
let maxScore = 100;
let categories = [];

function note(category, issue, deduction = 0) {
  friction.push({ category, issue, deduction });
  totalDeductions += deduction;
  const icon = deduction > 0 ? 'FRICTION' : 'OK';
  console.log(`  [${icon}] ${category}: ${issue}${deduction > 0 ? ` (-${deduction})` : ''}`);
}

function ts() { return new Date().toISOString(); }
function ms(t0) { return ((Date.now() - t0) / 1000).toFixed(1); }

// ─── Config ───

const SERVER_URL = 'https://x402.sentinel.co';
const BASE_RPC = 'https://mainnet.base.org';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];

// ─── Start ───

console.log(`\n${'='.repeat(70)}`);
console.log('  x402 AI AGENT EASE-OF-USE TEST v2');
console.log(`  Following docs/index.html instructions exactly`);
console.log(`  Started: ${ts()}`);
console.log(`${'='.repeat(70)}\n`);

const testStart = Date.now();

// ════════════════════════════════════════════════════════════════
// PHASE 1: DISCOVERY — Can the agent find what it needs?
// ════════════════════════════════════════════════════════════════

console.log('\n--- PHASE 1: DISCOVERY ---\n');

try {
  const pricingRes = await fetch(`${SERVER_URL}/pricing`);
  const pricing = await pricingRes.json();

  if (pricing.tiers && pricing.tiers['1day']) {
    note('Discovery', '/pricing endpoint works, returns tiers with prices');
  } else {
    note('Discovery', '/pricing missing tier info — agent cannot discover pricing', 5);
  }

  if (pricing.protocol) note('Discovery', `/pricing includes protocol: ${pricing.protocol}`);
  else note('Discovery', '/pricing missing protocol field', 2);

  if (pricing.network) note('Discovery', `/pricing includes network: ${pricing.network}`);
  else note('Discovery', '/pricing missing network field', 2);

  if (pricing.nodesEndpoint) note('Discovery', `/pricing includes nodesEndpoint: ${pricing.nodesEndpoint}`);
  else note('Discovery', '/pricing missing nodesEndpoint — agent has no way to find nodes', 3);
} catch (err) {
  note('Discovery', `FATAL: /pricing endpoint unreachable: ${err.message}`, 15);
}

try {
  const healthRes = await fetch(`${SERVER_URL}/health`);
  const health = await healthRes.json();
  if (health.status === 'ok') note('Discovery', '/health returns ok');
  else note('Discovery', `/health unexpected: ${JSON.stringify(health)}`, 3);
} catch (err) {
  note('Discovery', `FATAL: /health unreachable: ${err.message}`, 10);
}

// Check /nodes endpoint
try {
  const nodesRes = await fetch(`${SERVER_URL}/nodes`);
  const nodesData = await nodesRes.json();
  if (nodesData.nodes && nodesData.nodes.length > 0) {
    note('Discovery', `/nodes returns ${nodesData.nodes.length} plan nodes — agent can choose`);
  } else {
    note('Discovery', '/nodes returns empty list — no nodes available', 5);
  }
} catch (err) {
  note('Discovery', `/nodes endpoint failed: ${err.message}`, 5);
}

// ════════════════════════════════════════════════════════════════
// PHASE 2: PACKAGE INSTALL — Did the page instructions work?
// ════════════════════════════════════════════════════════════════

console.log('\n--- PHASE 2: PACKAGE INSTALL ---\n');

// Page says: npm install @x402/fetch @x402/evm blue-js-sdk viem
// Verify all packages are importable
let installOk = true;
const requiredPackages = ['@x402/fetch', '@x402/evm/exact/client', 'blue-js-sdk/ai-path', 'viem'];

for (const pkg of requiredPackages) {
  try {
    await import(pkg);
    note('Install', `${pkg} imports correctly`);
  } catch (err) {
    note('Install', `FATAL: ${pkg} cannot be imported: ${err.message}`, 5);
    installOk = false;
  }
}

if (installOk) {
  note('Install', 'All 4 packages from page install command work');
}

// ════════════════════════════════════════════════════════════════
// PHASE 3: WALLET CREATION — Following the docs
// ════════════════════════════════════════════════════════════════

console.log('\n--- PHASE 3: WALLET CREATION ---\n');

let sentWallet;
let evmWallet;

// Page says: import { createWallet } from 'blue-js-sdk/ai-path'
try {
  const { createWallet } = await import('blue-js-sdk/ai-path');
  sentWallet = await createWallet();
  note('Wallet', `Sentinel wallet created: ${sentWallet.address}`);
  if (sentWallet.mnemonic) note('Wallet', 'Mnemonic returned — agent can persist it');
  else note('Wallet', 'No mnemonic returned — agent cannot reconnect later', 5);
} catch (err) {
  note('Wallet', `FATAL: Cannot create Sentinel wallet: ${err.message}`, 20);
  process.exit(1);
}

// EVM wallet for Base
evmWallet = ethers.Wallet.createRandom();
note('Wallet', `EVM wallet created: ${evmWallet.address}`);

// Persist keys immediately — a crash after funding must not strand USDC
writeFileSync('live-e2e-agent-keys.txt', [
  `Created: ${ts()}`,
  `EVM address: ${evmWallet.address}`,
  `EVM private key: ${evmWallet.privateKey}`,
  `Sentinel address: ${sentWallet.address}`,
  `Sentinel mnemonic: ${sentWallet.mnemonic}`,
].join('\n'));

// ════════════════════════════════════════════════════════════════
// PHASE 4: FUNDING — Agent needs USDC on Base
// ════════════════════════════════════════════════════════════════

console.log('\n--- PHASE 4: FUNDING ---\n');

const OPERATOR_KEY = process.env.FACILITATOR_PRIVATE_KEY;
if (!OPERATOR_KEY) {
  console.error('ERROR: Set FACILITATOR_PRIVATE_KEY in environment');
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(BASE_RPC);
const opWallet = new ethers.Wallet(OPERATOR_KEY, provider);
const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, opWallet);

const fundT0 = Date.now();
console.log(`  Funding agent ${evmWallet.address} with 0.034 USDC...`);

try {
  const tx = await usdc.transfer(evmWallet.address, 34000n);
  await tx.wait(1);
  console.log(`  Funding TX: ${tx.hash}`);
  // Poll until the balance is actually visible — load-balanced RPCs lag behind
  // the node that confirmed the TX, and the facilitator verifies balanceOf.
  let bal = 0n;
  const pollT0 = Date.now();
  while (bal < 34000n && Date.now() - pollT0 < 30000) {
    bal = await usdc.balanceOf(evmWallet.address);
    if (bal < 34000n) await new Promise(r => setTimeout(r, 2000));
  }
  if (bal < 34000n) throw new Error(`balance still ${bal} after 30s poll (TX ${tx.hash})`);
  console.log(`  Funded: ${ethers.formatUnits(bal, 6)} USDC in ${ms(fundT0)}s`);
  note('Funding', `Agent funded with ${ethers.formatUnits(bal, 6)} USDC in ${ms(fundT0)}s`);
} catch (err) {
  note('Funding', `FATAL: Cannot fund agent: ${err.message}`, 20);
  process.exit(1);
}

note('Funding', 'Agent needs 0 ETH — EIP-3009 means facilitator pays Base gas');

// ════════════════════════════════════════════════════════════════
// PHASE 5: PAYMENT — The x402 402 flow
// ════════════════════════════════════════════════════════════════

console.log('\n--- PHASE 5: x402 PAYMENT ---\n');

// Set up x402 client exactly as the page shows
const agentAccount = privateKeyToAccount(evmWallet.privateKey);
const agentViemClient = createWalletClient({
  account: agentAccount,
  chain: base,
  transport: http(BASE_RPC),
});
const evmScheme = new ExactEvmScheme({
  address: agentAccount.address,
  signTypedData: (msg) => agentViemClient.signTypedData(msg),
});
const client = new x402Client();
client.register('eip155:8453', evmScheme);
const paidFetch = wrapFetchWithPayment(fetch, client);

note('Payment', 'x402 client setup works exactly as page shows');

// Test that unpaid POST returns 402
const res402 = await fetch(`${SERVER_URL}/vpn/connect/1day`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sentinelAddr: sentWallet.address }),
});

if (res402.status === 402) {
  note('Payment', 'POST without payment returns HTTP 402 (correct)');
} else {
  note('Payment', `POST without payment returns ${res402.status} — expected 402`, 10);
}

// Pay via x402
const payT0 = Date.now();
console.log('\n  Paying via x402 (EIP-3009 → facilitator settles → server provisions)...');

let provision;
try {
  const paidRes = await paidFetch(`${SERVER_URL}/vpn/connect/1day`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sentinelAddr: sentWallet.address }),
  });

  if (!paidRes.ok) {
    const errText = await paidRes.text();
    const hdrs = {};
    paidRes.headers.forEach((v, k) => { hdrs[k] = v; });
    console.log(`  Failure response headers: ${JSON.stringify(hdrs, null, 2)}`);
    throw new Error(`${paidRes.status}: ${errText}`);
  }

  provision = await paidRes.json();
  const payTime = ms(payT0);
  console.log(`  Payment + provisioning completed in ${payTime}s`);
  console.log(`  Result: ${JSON.stringify(provision, null, 2)}`);

  if (provision.provisioned) {
    note('Payment', `Provisioned in ${payTime}s`);
  } else {
    note('Payment', 'Payment succeeded but provisioned=false', 15);
  }

  // Check ALL required fields for connect()
  if (provision.feeGranter) note('Payment', `feeGranter: ${provision.feeGranter}`);
  else note('Payment', 'MISSING feeGranter — agent cannot connect', 15);

  if (provision.subscriptionId) note('Payment', `subscriptionId: ${provision.subscriptionId}`);
  else note('Payment', 'MISSING subscriptionId — agent cannot connect', 15);

  if (provision.nodeAddress) note('Payment', `nodeAddress: ${provision.nodeAddress} — agent can connect immediately`);
  else note('Payment', 'MISSING nodeAddress — agent must discover nodes itself', 10);

  if (provision.nodes && provision.nodes.length > 0) note('Payment', `nodes[]: ${provision.nodes.length} nodes returned — agent can choose`);
  else note('Payment', 'MISSING nodes[] — agent has no node list', 5);

  if (provision.instructions) note('Payment', `Instructions present: "${provision.instructions.slice(0, 80)}..."`);
  else note('Payment', 'MISSING instructions — agent has no guidance for next step', 5);

  // Documentation accuracy: instructions must point at the canonical agent
  // entry point (blue-js-sdk/ai-path) and not at packages that don't exist.
  if (provision.instructions) {
    if (provision.instructions.includes('sentinel-ai-connect')) {
      note('Docs', 'Instructions reference sentinel-ai-connect — never published to npm, install fails', 3);
    }
    if (provision.instructions.includes('blue-js-sdk/ai-path')) {
      note('Docs', 'Instructions reference blue-js-sdk/ai-path — canonical agent entry point');
    } else {
      note('Docs', 'Instructions do not reference blue-js-sdk/ai-path — agent lacks the canonical connect path', 3);
    }
  }

} catch (err) {
  note('Payment', `FATAL: x402 payment failed: ${err.message}`, 25);
  writeResults();
  process.exit(1);
}

// ════════════════════════════════════════════════════════════════
// PHASE 6: VPN CONNECTION — Following provision response
// ════════════════════════════════════════════════════════════════

console.log('\n--- PHASE 6: VPN CONNECTION ---\n');

let connect, disconnect, status;

// Page says: import { connect, disconnect } from 'blue-js-sdk/ai-path'
try {
  const agentConnect = await import('blue-js-sdk/ai-path');
  connect = agentConnect.connect;
  disconnect = agentConnect.disconnect;
  status = agentConnect.status;
  note('Connect', 'Imported connect/disconnect from blue-js-sdk/ai-path');
} catch (err) {
  note('Connect', `Cannot import from blue-js-sdk/ai-path: ${err.message}`, 10);
  writeResults();
  process.exit(1);
}

// Page says: connect({ mnemonic, nodeAddress: provision.nodeAddress, subscriptionId, feeGranter })
const connectT0 = Date.now();
console.log('  Connecting to VPN...');

let vpnResult;

// Use the nodeAddress from provision response (exactly as page shows)
const nodeAddress = provision.nodeAddress;
const nodesToTry = provision.nodes || [];

if (!nodeAddress) {
  note('Connect', 'No nodeAddress in provision — server did not return a recommended node', 5);
}

// Try the recommended node first, then fall back to the full list
const tryOrder = nodeAddress
  ? [nodeAddress, ...nodesToTry.filter(n => n !== nodeAddress)]
  : nodesToTry;

for (const addr of tryOrder) {
  console.log(`\n    Trying node: ${addr}...`);
  try {
    vpnResult = await connect({
      mnemonic: sentWallet.mnemonic,
      nodeAddress: addr,
      subscriptionId: String(provision.subscriptionId),
      feeGranter: provision.feeGranter,
      timeout: 90000,
      onProgress: (stage, msg) => {
        console.log(`      [${stage}] ${msg}`);
      },
    });
    break;
  } catch (nodeErr) {
    console.log(`      Failed: ${nodeErr.code || nodeErr.message}`);
    // Fatal errors — don't try more nodes
    if (['FEE_GRANT_NOT_FOUND', 'FEE_GRANT_EXPIRED', 'FEE_GRANT_EXHAUSTED', 'INSUFFICIENT_BALANCE'].includes(nodeErr.code)) {
      note('Connect', `Fatal chain error: ${nodeErr.code} — cannot connect to any node`, 15);
      break;
    }
  }
}

if (vpnResult) {
  const connectTime = ms(connectT0);
  console.log(`\n  VPN CONNECTED in ${connectTime}s`);
  console.log(`    Session: ${vpnResult.sessionId}`);
  console.log(`    Protocol: ${vpnResult.protocol}`);
  console.log(`    IP: ${vpnResult.ip}`);
  console.log(`    Node: ${vpnResult.nodeAddress}`);
  console.log(`    Country: ${vpnResult.country}`);

  note('Connect', `VPN tunnel established in ${connectTime}s — IP: ${vpnResult.ip}`);

  if (parseFloat(connectTime) < 30) note('Connect', 'Connect time < 30s — excellent');
  else if (parseFloat(connectTime) < 60) note('Connect', 'Connect time 30-60s — acceptable');
  else note('Connect', 'Connect time > 60s — too slow for AI agents', 5);
} else {
  note('Connect', 'FATAL: All nodes failed — cannot establish VPN tunnel', 30);
  writeResults();
  process.exit(1);
}

// ════════════════════════════════════════════════════════════════
// PHASE 7: DISCONNECT — Clean up
// ════════════════════════════════════════════════════════════════

console.log('\n--- PHASE 7: DISCONNECT ---\n');

const dcT0 = Date.now();
try {
  await disconnect();
  const dcTime = ms(dcT0);
  console.log(`  Disconnected in ${dcTime}s`);
  note('Disconnect', `Clean disconnect in ${dcTime}s`);
} catch (err) {
  note('Disconnect', `Disconnect failed: ${err.message}`, 5);
}

// ════════════════════════════════════════════════════════════════
// PHASE 8: SCORING
// ════════════════════════════════════════════════════════════════

const totalTime = ms(testStart);

console.log(`\n${'='.repeat(70)}`);
console.log('  x402 AI AGENT EASE-OF-USE SCORECARD');
console.log(`${'='.repeat(70)}\n`);

categories = [
  { name: 'Discovery (/pricing, /health, /nodes)', max: 10, score: 0 },
  { name: 'Package Install (npm install)', max: 10, score: 0 },
  { name: 'Wallet Creation', max: 10, score: 0 },
  { name: 'Payment Flow (x402 402)', max: 20, score: 0 },
  { name: 'VPN Connection', max: 20, score: 0 },
  { name: 'Disconnect', max: 5, score: 0 },
  { name: 'Error Messages', max: 5, score: 0 },
  { name: 'Documentation Accuracy', max: 10, score: 0 },
  { name: 'Platform Support', max: 5, score: 0 },
  { name: 'Time to Connect', max: 5, score: 0 },
];

// Calculate per-category deductions
const frictionByCategory = {};
for (const f of friction) {
  if (!frictionByCategory[f.category]) frictionByCategory[f.category] = { ok: 0, issues: 0, deductions: 0 };
  if (f.deduction > 0) {
    frictionByCategory[f.category].issues++;
    frictionByCategory[f.category].deductions += f.deduction;
  } else {
    frictionByCategory[f.category].ok++;
  }
}

categories[0].score = Math.max(0, 10 - (frictionByCategory['Discovery']?.deductions || 0));
categories[1].score = Math.max(0, 10 - (frictionByCategory['Install']?.deductions || 0));
categories[2].score = Math.max(0, 10 - (frictionByCategory['Wallet']?.deductions || 0));
categories[3].score = Math.max(0, 20 - (frictionByCategory['Payment']?.deductions || 0));
categories[4].score = Math.max(0, 20 - (frictionByCategory['Connect']?.deductions || 0));
categories[5].score = Math.max(0, 5 - (frictionByCategory['Disconnect']?.deductions || 0));

// Error messages — did errors give actionable info?
const errorFriction = friction.filter(f => f.issue.includes('FATAL') || f.issue.includes('FAILS')).length;
categories[6].score = Math.max(0, 5 - errorFriction);

// Documentation accuracy — are page examples copy-paste correct?
// Only deduct friction filed under 'Docs'; missing-field issues already
// deduct in their own category (counting them here double-charges).
categories[7].score = Math.max(0, 10 - (frictionByCategory['Docs']?.deductions || 0));

// Platform support — Windows only = 3/5
categories[8].score = 3;
note('Platform', 'Windows verified. macOS/Linux built but untested.', 0);

// Time to connect
const totalSec = parseFloat(totalTime);
if (totalSec < 60) categories[9].score = 5;
else if (totalSec < 120) categories[9].score = 3;
else categories[9].score = 1;

totalScore = categories.reduce((sum, c) => sum + c.score, 0);
maxScore = categories.reduce((sum, c) => sum + c.max, 0);

// Print scorecard
console.log('  Category                               Score   Max');
console.log('  ' + '-'.repeat(55));
for (const c of categories) {
  const bar = c.score >= c.max ? 'PERFECT' :
              c.score >= c.max * 0.7 ? 'GOOD' :
              c.score >= c.max * 0.4 ? 'NEEDS WORK' : 'POOR';
  console.log(`  ${c.name.padEnd(42)} ${String(c.score).padStart(3)}/${c.max.toString().padStart(2)}  ${bar}`);
}
console.log('  ' + '-'.repeat(55));
console.log(`  TOTAL                                      ${String(totalScore).padStart(3)}/${maxScore}`);
console.log(`  PERCENTAGE                                 ${Math.round(totalScore / maxScore * 100)}%`);

console.log(`\n  Total test time: ${totalTime}s`);
console.log(`  Friction points: ${friction.filter(f => f.deduction > 0).length}`);
console.log(`  Total deductions: -${totalDeductions}`);

// ── Friction Log ──
console.log(`\n${'='.repeat(70)}`);
console.log('  ALL FRICTION POINTS');
console.log(`${'='.repeat(70)}\n`);

for (const f of friction) {
  const prefix = f.deduction > 0 ? `  [-${f.deduction}]` : '  [ OK ]';
  console.log(`${prefix} [${f.category}] ${f.issue}`);
}

// ── Top Issues ──
const issues = friction.filter(f => f.deduction > 0).sort((a, b) => b.deduction - a.deduction);
if (issues.length > 0) {
  console.log(`\n${'='.repeat(70)}`);
  console.log('  TOP ISSUES TO FIX');
  console.log(`${'='.repeat(70)}\n`);
  for (let i = 0; i < Math.min(10, issues.length); i++) {
    console.log(`  ${i + 1}. (-${issues[i].deduction}) ${issues[i].issue}`);
  }
} else {
  console.log(`\n  NO FRICTION POINTS — PERFECT SCORE!`);
}

// ── Write results ──
writeResults();

function writeResults() {
  const lines = [];
  lines.push('x402 AI AGENT EASE-OF-USE TEST RESULTS v2');
  lines.push('='.repeat(50));
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push(`Total time: ${ms(testStart)}s`);
  lines.push(`Score: ${totalScore}/${maxScore} (${Math.round(totalScore / maxScore * 100)}%)`);
  lines.push('');
  lines.push('SCORECARD');
  lines.push('-'.repeat(50));
  for (const c of categories) {
    lines.push(`${c.name.padEnd(42)} ${c.score}/${c.max}`);
  }
  lines.push(`${'TOTAL'.padEnd(42)} ${totalScore}/${maxScore}`);
  lines.push('');
  lines.push('WALLETS USED');
  lines.push('-'.repeat(50));
  lines.push(`EVM: ${evmWallet?.address || 'N/A'}`);
  lines.push(`Sentinel: ${sentWallet?.address || 'N/A'}`);
  lines.push(`Sentinel Mnemonic: ${sentWallet?.mnemonic || 'N/A'}`);
  lines.push('');
  lines.push('PROVISIONING');
  lines.push('-'.repeat(50));
  if (provision) {
    lines.push(`Subscription: ${provision.subscriptionId}`);
    lines.push(`Plan: ${provision.planId}`);
    lines.push(`Fee Granter: ${provision.feeGranter}`);
    lines.push(`Node Address: ${provision.nodeAddress}`);
    lines.push(`Nodes Available: ${provision.nodes?.length || 0}`);
    lines.push(`Expires: ${provision.expiresAt}`);
    lines.push(`Sentinel TX: ${provision.sentinelTxHash}`);
  }
  lines.push('');
  lines.push('VPN CONNECTION');
  lines.push('-'.repeat(50));
  if (vpnResult) {
    lines.push(`Session: ${vpnResult.sessionId}`);
    lines.push(`Protocol: ${vpnResult.protocol}`);
    lines.push(`Node: ${vpnResult.nodeAddress}`);
    lines.push(`IP: ${vpnResult.ip}`);
    lines.push(`Country: ${vpnResult.country}`);
  }
  lines.push('');
  lines.push('ALL FRICTION POINTS');
  lines.push('-'.repeat(50));
  for (const f of friction) {
    const prefix = f.deduction > 0 ? `[-${f.deduction}]` : '[OK]';
    lines.push(`${prefix} [${f.category}] ${f.issue}`);
  }

  writeFileSync('LIVE-E2E-RESULTS.txt', lines.join('\n'));
  console.log('\n  Results written to fresh-test/LIVE-E2E-RESULTS.txt');
}

console.log(`\n${'='.repeat(70)}`);
console.log(`  TEST COMPLETE — SCORE: ${totalScore}/${maxScore} (${Math.round(totalScore / maxScore * 100)}%)`);
console.log(`${'='.repeat(70)}\n`);
