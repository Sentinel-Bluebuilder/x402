/**
 * x402 — Pay + Provision phase (cross-platform, headless)
 *
 * The self-funding payment half of the E2E flow, factored out of
 * e2e-selffund.mjs so the native macOS/Linux runner (e2e-maclinux.sh) can
 * drive the connect half with `sentinel-dvpncli` instead of the JS SDK.
 *
 * Does exactly steps 1-4 of e2e-selffund.mjs:
 *   1. Preflight   — operator funds + server capacity
 *   2. Wallets     — fresh Sentinel (blue-js-sdk/ai-path) + EVM (ethers) agent
 *   3. Self-fund   — transfer tier price (+buffer) USDC operator -> agent
 *   4. Pay (x402)  — POST /vpn/connect/<tier>, EIP-3009, facilitator settles
 *
 * On success it prints ONE machine-readable line to stdout for the shell to read:
 *   PROVISION_JSON={"mnemonic":...,"sentinelAddr":...,"subscriptionId":...,
 *                   "feeGranter":...,"nodeAddress":...,"nodes":[...],"expiresAt":...}
 * All human-readable progress goes to stderr so it never pollutes that line.
 *
 * Run:  TIER=1day SERVER_URL=https://x402.sentinel.co node pay-phase.mjs
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
const WALLETS_ENV = process.env.WALLETS_ENV || 'C:/Users/Connect/Desktop/x402/wallets.env';

const TIER_PRICE = { '1day': 33000n, '7days': 233000n, '30days': 1000000n };
const BUFFER = 2000n;

const USDC_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];

// ─── Helpers ───

const ts = () => new Date().toISOString();
const since = (t0) => ((Date.now() - t0) / 1000).toFixed(1);
// All progress goes to stderr; stdout is reserved for the PROVISION_JSON line.
const log = (m) => process.stderr.write(m + '\n');
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
  process.exit(1);
}

const t0 = Date.now();
log(`\n[pay-phase] server=${SERVER_URL} tier=${TIER} started=${ts()}`);

// ─── STEP 1: PREFLIGHT ───

log('--- pay-phase STEP 1: PREFLIGHT ---');
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
log(`  Operator: ${operator.address}  ETH=${ethers.formatEther(opEth)}  USDC=${ethers.formatUnits(opUsdcBal, 6)}`);
if (opUsdcBal < fundAmount) fail('Preflight', `operator USDC ${ethers.formatUnits(opUsdcBal, 6)} < needed ${ethers.formatUnits(fundAmount, 6)}`);
if (opEth < ethers.parseEther('0.00002')) fail('Preflight', `operator ETH too low for gas: ${ethers.formatEther(opEth)}`);

try {
  const h = await (await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(15000) })).json();
  log(`  /health: ${h.status}  capacity.ok=${h.capacity?.ok}  ${h.capacity?.reason || ''}`);
  if (h.status !== 'ok') fail('Preflight', `/health status ${h.status}`);
  if (h.capacity && h.capacity.ok === false) fail('Preflight', `server has no capacity: ${h.capacity.reason}`);
} catch (e) {
  fail('Preflight', `server unreachable: ${e.message}`);
}

// ─── STEP 2: WALLETS ───

log('--- pay-phase STEP 2: WALLETS ---');
let sentWallet;
try {
  const { createWallet } = await import('blue-js-sdk/ai-path');
  sentWallet = await createWallet();
} catch (e) {
  fail('Wallets', `createWallet() from blue-js-sdk/ai-path failed: ${e.message}`);
}
const evmWallet = ethers.Wallet.createRandom();
log(`  Sentinel: ${sentWallet.address}  EVM: ${evmWallet.address}`);

const keyFile = 'maclinux-agent-keys.txt';
writeFileSync(keyFile, [
  `Created: ${ts()}`,
  `EVM address: ${evmWallet.address}`,
  `EVM private key: ${evmWallet.privateKey}`,
  `Sentinel address: ${sentWallet.address}`,
  `Sentinel mnemonic: ${sentWallet.mnemonic}`,
].join('\n'));
log(`  Keys persisted -> fresh-test/${keyFile}`);

// ─── STEP 3: SELF-FUND ───

log('--- pay-phase STEP 3: SELF-FUND ---');
log(`  Sending ${ethers.formatUnits(fundAmount, 6)} USDC: operator -> agent ${evmWallet.address}`);
try {
  const tx = await opUsdc.transfer(evmWallet.address, fundAmount);
  log(`  Funding TX: ${tx.hash}`);
  await tx.wait(1);
  let bal = 0n;
  const pollT0 = Date.now();
  while (bal < price && Date.now() - pollT0 < 30000) {
    bal = await opUsdc.balanceOf(evmWallet.address);
    if (bal < price) await sleep(2000);
  }
  if (bal < price) fail('Self-fund', `agent balance ${ethers.formatUnits(bal, 6)} still < price after 30s (TX ${tx.hash})`);
  log(`  Agent funded: ${ethers.formatUnits(bal, 6)} USDC`);
} catch (e) {
  fail('Self-fund', `transfer failed: ${e.message}`);
}

// ─── STEP 4: PAY via x402 ───

log('--- pay-phase STEP 4: x402 PAYMENT ---');
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
const unpaid = await fetch(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sentinelAddr: sentWallet.address }),
});
log(`  Unpaid POST -> ${unpaid.status} ${unpaid.status === 402 ? '(correct)' : '(UNEXPECTED)'}`);

let provision;
const payT0 = Date.now();
log('  Paying (EIP-3009 -> facilitator settles -> server provisions)...');
try {
  const res = await paidFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sentinelAddr: sentWallet.address }),
  });
  if (!res.ok) {
    const body = await res.text();
    fail('Payment', `${res.status}: ${body.slice(0, 300)}`);
  }
  provision = await res.json();
  log(`  Provisioned in ${since(payT0)}s: sub=${provision.subscriptionId} node=${provision.nodeAddress} feeGranter=${provision.feeGranter}`);
  for (const f of ['subscriptionId', 'feeGranter', 'nodeAddress']) {
    if (!provision[f]) fail('Payment', `provision missing required field "${f}"`);
  }
} catch (e) {
  fail('Payment', `x402 payment failed: ${e.message}`);
}

log(`[pay-phase] done in ${since(t0)}s`);

// ─── Emit the single machine-readable line on stdout ───

const out = {
  mnemonic: sentWallet.mnemonic,
  sentinelAddr: sentWallet.address,
  subscriptionId: String(provision.subscriptionId),
  feeGranter: provision.feeGranter,
  nodeAddress: provision.nodeAddress,
  nodes: provision.nodes || [],
  expiresAt: provision.expiresAt,
};
process.stdout.write('PROVISION_JSON=' + JSON.stringify(out) + '\n');
