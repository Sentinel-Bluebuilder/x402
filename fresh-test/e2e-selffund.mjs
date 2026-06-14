/**
 * x402 AI Agent — Self-Funding End-to-End Test
 *
 * A single self-contained run that proves an AI agent can go from nothing to a
 * live VPN tunnel, paying with real USDC on Base. Unlike test-live-e2e.mjs this
 * funds itself: it reads the operator key from wallets.env and transfers the
 * agent's USDC from our funded wallet — no manual env setup, no external faucet.
 *
 * Flow (exactly what a real agent would do, following docs/index.html):
 *   1. Preflight   — operator funds + server /health pool capacity
 *   2. Wallets     — fresh Sentinel (blue-js-sdk/ai-path) + EVM (ethers) agent
 *   3. Self-fund   — transfer the tier price (+buffer) USDC operator -> agent
 *   4. Pay (x402)  — POST /vpn/connect/<tier>, EIP-3009, facilitator settles
 *   5. Connect     — connect() establishes a real WireGuard/V2Ray tunnel
 *   6. Disconnect  — clean teardown
 *   7. Report      — timestamped result file
 *
 * Cost: one tier price (default 1day = $0.033) in USDC + a little Base gas.
 * The server's payTo is NOT our operator wallet, so the USDC is genuinely spent.
 *
 * Run:  node e2e-selffund.mjs            (1day tier, live server)
 *       TIER=7days node e2e-selffund.mjs
 *       SERVER_URL=http://localhost:4020 node e2e-selffund.mjs
 */

import { readFileSync, writeFileSync } from 'fs';
import { ethers } from 'ethers';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';

// ─── Config ───

const SERVER_URL = process.env.SERVER_URL || 'https://x402.sentinel.co';
const TIER = process.env.TIER || '1day';
const BASE_RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WALLETS_ENV = 'C:/Users/Connect/Desktop/x402/wallets.env';

// Price in USDC base units (6 decimals) per tier, plus a small buffer so the
// agent always has a touch more than the exact charge.
const TIER_PRICE = { '1day': 33000n, '7days': 233000n, '30days': 1000000n };
const BUFFER = 2000n; // 0.002 USDC headroom

const USDC_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];

// ─── Helpers ───

const ts = () => new Date().toISOString();
const since = (t0) => ((Date.now() - t0) / 1000).toFixed(1);
const log = (m) => console.log(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadEnv(path) {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l && !l.trim().startsWith('#') && l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
  );
}

function fail(stage, msg) {
  log(`\n[FAIL] ${stage}: ${msg}`);
  result.status = 'FAIL';
  result.failStage = stage;
  result.failReason = msg;
  writeReport();
  process.exit(1);
}

// ─── Result accumulator (so even a mid-run failure writes a report) ───

const result = {
  status: 'INCOMPLETE',
  startedAt: ts(),
  server: SERVER_URL,
  tier: TIER,
  steps: {},
};

const testStart = Date.now();

log(`\n${'='.repeat(70)}`);
log('  x402 AI AGENT — SELF-FUNDING END-TO-END TEST');
log(`  Server: ${SERVER_URL}   Tier: ${TIER}`);
log(`  Started: ${result.startedAt}`);
log(`${'='.repeat(70)}\n`);

// ════════════════════════════════════════════════════════════════
// STEP 1: PREFLIGHT — operator funds + server capacity
// ════════════════════════════════════════════════════════════════

log('--- STEP 1: PREFLIGHT ---');

const price = TIER_PRICE[TIER];
if (!price) fail('Preflight', `unknown TIER "${TIER}" (use 1day|7days|30days)`);
const fundAmount = price + BUFFER;

const env = loadEnv(WALLETS_ENV);
if (!env.PRIMARY_OPERATOR_KEY) fail('Preflight', 'PRIMARY_OPERATOR_KEY missing from wallets.env');

const provider = new ethers.JsonRpcProvider(BASE_RPC);
const operator = new ethers.Wallet(env.PRIMARY_OPERATOR_KEY, provider);
const opUsdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, operator);

const [opEth, opUsdcBal] = await Promise.all([
  provider.getBalance(operator.address),
  opUsdc.balanceOf(operator.address),
]);
log(`  Operator: ${operator.address}`);
log(`    ETH:  ${ethers.formatEther(opEth)}`);
log(`    USDC: ${ethers.formatUnits(opUsdcBal, 6)}`);
if (opUsdcBal < fundAmount) fail('Preflight', `operator USDC ${ethers.formatUnits(opUsdcBal, 6)} < needed ${ethers.formatUnits(fundAmount, 6)}`);
if (opEth < ethers.parseEther('0.00002')) fail('Preflight', `operator ETH too low for gas: ${ethers.formatEther(opEth)}`);

let pricing;
try {
  const h = await (await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(15000) })).json();
  log(`  /health: ${h.status}  capacity.ok=${h.capacity?.ok}  ${h.capacity?.reason || ''}`);
  if (h.status !== 'ok') fail('Preflight', `/health status ${h.status}`);
  if (h.capacity && h.capacity.ok === false) fail('Preflight', `server has no capacity: ${h.capacity.reason}`);
  pricing = await (await fetch(`${SERVER_URL}/pricing`, { signal: AbortSignal.timeout(15000) })).json();
  log(`  /pricing: protocol=${pricing.protocol} network=${pricing.network} payTo=${pricing.payTo}`);
  log(`  tier ${TIER} price: ${pricing.tiers?.[TIER]?.price}`);
} catch (e) {
  fail('Preflight', `server unreachable: ${e.message}`);
}
result.steps.preflight = { operatorUsdc: ethers.formatUnits(opUsdcBal, 6), operatorEth: ethers.formatEther(opEth), payTo: pricing.payTo };

// ════════════════════════════════════════════════════════════════
// STEP 2: WALLETS — fresh throwaway agent
// ════════════════════════════════════════════════════════════════

log('\n--- STEP 2: WALLET CREATION ---');

let sentWallet;
try {
  const { createWallet } = await import('blue-js-sdk/ai-path');
  sentWallet = await createWallet();
} catch (e) {
  fail('Wallets', `createWallet() from blue-js-sdk/ai-path failed: ${e.message}`);
}
const evmWallet = ethers.Wallet.createRandom();
log(`  Sentinel: ${sentWallet.address}`);
log(`  EVM:      ${evmWallet.address}`);

// Persist immediately — a crash after funding must not strand USDC.
const keyFile = `selffund-agent-keys.txt`;
writeFileSync(keyFile, [
  `Created: ${ts()}`,
  `EVM address: ${evmWallet.address}`,
  `EVM private key: ${evmWallet.privateKey}`,
  `Sentinel address: ${sentWallet.address}`,
  `Sentinel mnemonic: ${sentWallet.mnemonic}`,
].join('\n'));
log(`  Keys persisted -> fresh-test/${keyFile}`);
result.steps.wallets = { sentinel: sentWallet.address, evm: evmWallet.address };

// ════════════════════════════════════════════════════════════════
// STEP 3: SELF-FUND — operator -> agent USDC
// ════════════════════════════════════════════════════════════════

log('\n--- STEP 3: SELF-FUND AGENT ---');
log(`  Sending ${ethers.formatUnits(fundAmount, 6)} USDC: operator -> agent ${evmWallet.address}`);

const fundT0 = Date.now();
try {
  const tx = await opUsdc.transfer(evmWallet.address, fundAmount);
  log(`  Funding TX: ${tx.hash}`);
  await tx.wait(1);

  // Poll balance — load-balanced RPCs lag the confirming node, and the
  // facilitator will read balanceOf during settlement.
  let bal = 0n;
  const pollT0 = Date.now();
  while (bal < price && Date.now() - pollT0 < 30000) {
    bal = await opUsdc.balanceOf(evmWallet.address);
    if (bal < price) await sleep(2000);
  }
  if (bal < price) fail('Self-fund', `agent balance ${ethers.formatUnits(bal, 6)} still < price after 30s (TX ${tx.hash})`);
  log(`  Agent funded: ${ethers.formatUnits(bal, 6)} USDC in ${since(fundT0)}s`);
  result.steps.fund = { txHash: tx.hash, agentUsdc: ethers.formatUnits(bal, 6), seconds: since(fundT0) };
} catch (e) {
  fail('Self-fund', `transfer failed: ${e.message}`);
}

// ════════════════════════════════════════════════════════════════
// STEP 4: PAY via x402 (EIP-3009)
// ════════════════════════════════════════════════════════════════

log('\n--- STEP 4: x402 PAYMENT ---');

const agentAccount = privateKeyToAccount(evmWallet.privateKey);
const agentViem = createWalletClient({ account: agentAccount, chain: base, transport: http(BASE_RPC) });
const scheme = new ExactEvmScheme({
  address: agentAccount.address,
  signTypedData: (msg) => agentViem.signTypedData(msg),
});
const client = new x402Client();
client.register('eip155:8453', scheme);
const paidFetch = wrapFetchWithPayment(fetch, client);

const endpoint = `${SERVER_URL}/vpn/connect/${TIER}`;

// Unpaid POST must return 402.
const unpaid = await fetch(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sentinelAddr: sentWallet.address }),
});
log(`  Unpaid POST ${endpoint} -> ${unpaid.status} ${unpaid.status === 402 ? '(correct: payment required)' : '(UNEXPECTED)'}`);
if (unpaid.status !== 402) log(`  WARN: expected 402, got ${unpaid.status}`);

let provision;
const payT0 = Date.now();
log('  Paying (EIP-3009 -> facilitator settles on Base -> server provisions on Sentinel)...');
try {
  const res = await paidFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sentinelAddr: sentWallet.address }),
  });
  if (!res.ok) {
    const body = await res.text();
    const hdrs = {}; res.headers.forEach((v, k) => { hdrs[k] = v; });
    log(`  Response headers: ${JSON.stringify(hdrs)}`);
    fail('Payment', `${res.status}: ${body.slice(0, 300)}`);
  }
  provision = await res.json();
  log(`  Provisioned in ${since(payT0)}s`);
  log(`    subscriptionId: ${provision.subscriptionId}`);
  log(`    planId:         ${provision.planId}`);
  log(`    feeGranter:     ${provision.feeGranter}`);
  log(`    nodeAddress:    ${provision.nodeAddress}`);
  log(`    nodes[]:        ${provision.nodes?.length || 0}`);
  log(`    expiresAt:      ${provision.expiresAt}`);
  log(`    sentinelTx:     ${provision.sentinelTxHash}`);

  for (const f of ['subscriptionId', 'feeGranter', 'nodeAddress']) {
    if (!provision[f]) fail('Payment', `provision missing required field "${f}" — agent cannot connect`);
  }
  result.steps.payment = {
    seconds: since(payT0),
    subscriptionId: provision.subscriptionId,
    planId: provision.planId,
    feeGranter: provision.feeGranter,
    nodeAddress: provision.nodeAddress,
    nodes: provision.nodes?.length || 0,
    expiresAt: provision.expiresAt,
    sentinelTxHash: provision.sentinelTxHash,
  };
} catch (e) {
  fail('Payment', `x402 payment failed: ${e.message}`);
}

// ════════════════════════════════════════════════════════════════
// STEP 5: CONNECT — real VPN tunnel
// ════════════════════════════════════════════════════════════════

log('\n--- STEP 5: VPN CONNECTION ---');

let connect, disconnect;
try {
  const ai = await import('blue-js-sdk/ai-path');
  connect = ai.connect;
  disconnect = ai.disconnect;
} catch (e) {
  fail('Connect', `cannot import connect/disconnect from blue-js-sdk/ai-path: ${e.message}`);
}

const tryOrder = provision.nodeAddress
  ? [provision.nodeAddress, ...(provision.nodes || []).filter((n) => n !== provision.nodeAddress)]
  : (provision.nodes || []);

let vpn;
const connT0 = Date.now();
for (const addr of tryOrder.slice(0, 8)) {
  log(`  Trying node ${addr} ...`);
  try {
    vpn = await connect({
      mnemonic: sentWallet.mnemonic,
      nodeAddress: addr,
      subscriptionId: String(provision.subscriptionId),
      feeGranter: provision.feeGranter,
      timeout: 90000,
      onProgress: (stage, msg) => log(`      [${stage}] ${msg}`),
    });
    break;
  } catch (e) {
    log(`      failed: ${e.code || e.message}`);
    if (['FEE_GRANT_NOT_FOUND', 'FEE_GRANT_EXPIRED', 'FEE_GRANT_EXHAUSTED', 'INSUFFICIENT_BALANCE'].includes(e.code)) {
      fail('Connect', `fatal chain error ${e.code} — cannot connect to any node`);
    }
  }
}

if (!vpn) fail('Connect', 'all nodes failed — no VPN tunnel established');

log(`\n  VPN CONNECTED in ${since(connT0)}s`);
log(`    sessionId: ${vpn.sessionId}`);
log(`    protocol:  ${vpn.protocol}`);
log(`    exit IP:   ${vpn.ip}`);
log(`    country:   ${vpn.country}`);
log(`    node:      ${vpn.nodeAddress}`);
result.steps.connect = {
  seconds: since(connT0),
  sessionId: vpn.sessionId,
  protocol: vpn.protocol,
  ip: vpn.ip,
  country: vpn.country,
  node: vpn.nodeAddress,
};

// ════════════════════════════════════════════════════════════════
// STEP 6: DISCONNECT
// ════════════════════════════════════════════════════════════════

log('\n--- STEP 6: DISCONNECT ---');
const dcT0 = Date.now();
try {
  await disconnect();
  log(`  Disconnected in ${since(dcT0)}s`);
  result.steps.disconnect = { seconds: since(dcT0), ok: true };
} catch (e) {
  log(`  Disconnect warning: ${e.message}`);
  result.steps.disconnect = { ok: false, error: e.message };
}

// ════════════════════════════════════════════════════════════════
// STEP 7: REPORT
// ════════════════════════════════════════════════════════════════

result.status = 'PASS';
result.totalSeconds = since(testStart);
writeReport();

log(`\n${'='.repeat(70)}`);
log(`  RESULT: ${result.status}  (${result.totalSeconds}s total)`);
log(`  Agent paid ${pricing?.tiers?.[TIER]?.price} on Base and connected from ${vpn.country} (${vpn.ip})`);
log(`${'='.repeat(70)}\n`);

function writeReport() {
  const lines = [];
  lines.push('x402 SELF-FUNDING END-TO-END TEST RESULT');
  lines.push('='.repeat(50));
  lines.push(`Status: ${result.status}`);
  lines.push(`Date: ${ts()}`);
  lines.push(`Server: ${SERVER_URL}`);
  lines.push(`Tier: ${TIER}`);
  if (result.totalSeconds) lines.push(`Total time: ${result.totalSeconds}s`);
  if (result.failStage) lines.push(`Failed at: ${result.failStage} — ${result.failReason}`);
  lines.push('');
  lines.push('STEPS');
  lines.push('-'.repeat(50));
  for (const [k, v] of Object.entries(result.steps)) {
    lines.push(`${k}:`);
    for (const [kk, vv] of Object.entries(v)) lines.push(`  ${kk}: ${vv}`);
  }
  writeFileSync('SELFFUND-E2E-RESULTS.txt', lines.join('\n'));
  log('  Report -> fresh-test/SELFFUND-E2E-RESULTS.txt');
}
