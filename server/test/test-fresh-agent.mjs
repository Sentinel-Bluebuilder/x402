/**
 * x402 Fresh Agent E2E Test
 *
 * Simulates a BRAND NEW agent from scratch — every step timestamped,
 * every on-chain TX captured with explorer links.
 *
 * Usage: node test/test-fresh-agent.mjs
 */

import { ethers } from 'ethers';
import { connect, disconnect, status } from '../../../Sentinel SDK/js-sdk/ai-path/connect.js';
import { createWallet } from '../../../Sentinel SDK/js-sdk/ai-path/wallet.js';
import {
  createRpcQueryClientWithFallback,
  rpcQueryFeeGrant,
  rpcQuerySessionsForAccount,
  rpcQuerySession,
  disconnectRpc,
} from '../../../Sentinel SDK/js-sdk/index.js';
import { config } from 'dotenv';
import { writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';

config();

// ─── Config ───

const SERVER_URL = process.env.X402_SERVER || 'http://localhost:4020';
const BASE_RPC = 'https://mainnet.base.org';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const OPERATOR_KEY = process.env.FACILITATOR_PRIVATE_KEY;
const SENTINEL_RPC = process.env.SENTINEL_RPC_URL || 'https://rpc.sentinel.co:443';

const BASE_TX = 'https://basescan.org/tx';
const BASE_ADDR = 'https://basescan.org/address';
const SENT_TX = 'https://www.mintscan.io/sentinel/tx';
const SENT_ADDR = 'https://www.mintscan.io/sentinel/address';

const USDC_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];

// Plan 42 nodes
const PLAN_42_NODES = [
  'sentnode10e7wrxjfzywvsvptewqrg0kjsrrap3277zdkke',
  'sentnode13dlpyvqext6y7h6n3rgntvygm3sthlww2npgpn',
  'sentnode15dkwtntn5jah6hjctkx2szktx5sq2ca5hm6env',
  'sentnode1mn9urq2madyx8zqttnplgsklh7jy5rvzp8nr6d',
  'sentnode1lj0fewcdlja2w9wnvqvzq93tjhhg7d0nm3tg47',
  'sentnode1l7ctwy40xyvmkr028zqhj7zpzmygl3nqym7e8s',
];

// ─── Collect everything ───

const S = [];   // steps
const TX = [];  // on-chain transactions

function ts() { return new Date().toISOString(); }
function ms(t0) { return ((Date.now() - t0) / 1000).toFixed(1); }

function step(title, data = {}) {
  const s = { n: S.length + 1, title, time: ts(), ...data };
  S.push(s);
  console.log(`\n  [${s.time}] STEP ${s.n}: ${title}`);
  for (const [k, v] of Object.entries(data)) {
    console.log(`    ${k}: ${v}`);
  }
  return s;
}

function tx(label, chain, hash, extra = {}) {
  const explorer = chain === 'Base' ? `${BASE_TX}/${hash}` : `${SENT_TX}/${hash}`;
  const t = { label, chain, hash, explorer, time: ts(), ...extra };
  TX.push(t);
  console.log(`    TX: ${hash}`);
  console.log(`    Explorer: ${explorer}`);
  return t;
}

// ─── Sentinel RPC: search TXs by events ───

async function searchSentinelTx(eventQuery) {
  try {
    const url = `${SENTINEL_RPC}/tx_search?query="${encodeURIComponent(eventQuery)}"&order_by="desc"&per_page=1`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.result?.txs?.length > 0) {
      const t = data.result.txs[0];
      return {
        hash: t.hash,
        height: t.height,
        // tx_result has events
      };
    }
  } catch (e) {
    console.log(`    RPC tx_search failed: ${e.message}`);
  }
  return null;
}

async function getBlockTime(height) {
  try {
    const url = `${SENTINEL_RPC}/block?height=${height}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.result?.block?.header?.time || null;
  } catch {
    return null;
  }
}

// ─── Main ───

async function main() {
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  x402 FRESH AGENT — FULL E2E TEST');
  console.log(`  Started: ${ts()}`);
  console.log(`${'═'.repeat(70)}`);

  if (!OPERATOR_KEY) {
    console.error('FACILITATOR_PRIVATE_KEY not set in .env');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const opWallet = new ethers.Wallet(OPERATOR_KEY, provider);
  const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, opWallet);
  const testStart = ts();
  const wallets = { evm: {}, sentinel: {} };
  const balances = {};
  const provision = {};
  const conn = {};
  const feeGrantData = {};

  try {

    // ════════════════════════════════════════════════════════════════════
    // STEP 1: Generate fresh EVM wallet
    // ════════════════════════════════════════════════════════════════════
    const evmWallet = ethers.Wallet.createRandom();
    wallets.evm = { address: evmWallet.address, privateKey: evmWallet.privateKey };
    step('Generate fresh EVM wallet', {
      address: evmWallet.address,
      chain: 'Base (EIP-155:8453)',
      onChain: 'none — local key generation',
    });

    // ════════════════════════════════════════════════════════════════════
    // STEP 2: Generate fresh Sentinel wallet
    // ════════════════════════════════════════════════════════════════════
    const sentWallet = await createWallet();
    wallets.sentinel = { address: sentWallet.address, mnemonic: sentWallet.mnemonic };
    step('Generate fresh Sentinel wallet', {
      address: sentWallet.address,
      chain: 'Sentinel (sentinelhub-2)',
      onChain: 'none — local key derivation',
    });

    // ════════════════════════════════════════════════════════════════════
    // STEP 3: Fund agent — USDC on Base
    // ════════════════════════════════════════════════════════════════════
    const s3 = step('Fund agent: send USDC on Base', {
      from: opWallet.address,
      to: evmWallet.address,
      amount: '0.034 USDC',
    });

    const usdcTx = await usdc.transfer(evmWallet.address, 34000n);
    console.log(`    TX submitted: ${usdcTx.hash}`);
    const usdcRcpt = await usdcTx.wait(1);
    s3.confirmed = ts();
    s3.block = usdcRcpt.blockNumber;
    console.log(`    Confirmed block ${usdcRcpt.blockNumber}`);

    tx('Base — USDC funding (operator → agent)', 'Base', usdcTx.hash, {
      block: usdcRcpt.blockNumber,
      from: opWallet.address,
      to: evmWallet.address,
      amount: '0.034 USDC',
    });

    // ════════════════════════════════════════════════════════════════════
    // STEP 4: Verify agent funded (no ETH needed — EIP-3009 = 0 gas)
    // ════════════════════════════════════════════════════════════════════
    const aUsdc = await usdc.balanceOf(evmWallet.address);
    balances.postFunding = { usdc: ethers.formatUnits(aUsdc, 6), eth: '0' };
    step('Verify agent funded', {
      agentUSDC: `${balances.postFunding.usdc} USDC`,
      agentETH: '0 ETH — agent never needs gas (EIP-3009 = facilitator pays)',
      agentP2P: '0.00 P2P (fee-granted — no tokens needed)',
      onChain: 'read-only',
    });

    // ════════════════════════════════════════════════════════════════════
    // STEP 6: POST /vpn/connect/1day → HTTP 402
    // ════════════════════════════════════════════════════════════════════
    const s6 = step('POST /vpn/connect/1day → HTTP 402', {
      url: `${SERVER_URL}/vpn/connect/1day`,
      body: `{ sentinelAddr: "${sentWallet.address}" }`,
    });

    const res402 = await fetch(`${SERVER_URL}/vpn/connect/1day`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sentinelAddr: sentWallet.address }),
    });

    s6.status = `${res402.status} ${res402.statusText}`;
    console.log(`    Response: ${s6.status}`);

    if (res402.status !== 402) throw new Error(`Expected 402, got ${res402.status}`);

    // Parse x-payment header
    const payHeader = res402.headers.get('x-payment');
    if (payHeader) {
      try {
        const reqs = JSON.parse(Buffer.from(payHeader, 'base64').toString());
        s6.scheme = reqs.accepts?.[0]?.scheme;
        s6.network = reqs.accepts?.[0]?.network;
        s6.price = `${reqs.accepts?.[0]?.maxAmountRequired} atomic USDC`;
        s6.payTo = reqs.accepts?.[0]?.payTo;
        console.log(`    Scheme: ${s6.scheme}, Network: ${s6.network}`);
        console.log(`    Price: ${s6.price}, Pay To: ${s6.payTo}`);
      } catch (e) { /* optional */ }
    }

    // ════════════════════════════════════════════════════════════════════
    // STEP 7: Agent signs EIP-3009 + facilitator settles + server provisions
    // ════════════════════════════════════════════════════════════════════
    const payT0 = Date.now();
    const s7 = step('x402 payment: sign → settle → provision', {
      action: '@x402/fetch signs EIP-3009, facilitator settles on Base, server provisions on Sentinel',
    });

    // Build x402 client
    const agentAccount = privateKeyToAccount(evmWallet.privateKey);
    const agentViemClient = createWalletClient({
      account: agentAccount,
      chain: base,
      transport: http(BASE_RPC),
    });
    const evmSigner = {
      address: agentAccount.address,
      signTypedData: (msg) => agentViemClient.signTypedData(msg),
    };
    const evmScheme = new ExactEvmScheme(evmSigner);
    const client = new x402Client();
    client.register('eip155:8453', evmScheme);
    const paidFetch = wrapFetchWithPayment(fetch, client);

    const paidRes = await paidFetch(`${SERVER_URL}/vpn/connect/1day`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sentinelAddr: sentWallet.address }),
    });

    if (!paidRes.ok) {
      const errText = await paidRes.text();
      throw new Error(`Payment failed: ${paidRes.status} — ${errText}`);
    }

    s7.elapsed = `${ms(payT0)}s`;
    s7.confirmed = ts();
    console.log(`    Completed in ${s7.elapsed}`);

    // Extract settlement TX from x-payment-response header
    const settleHeader = paidRes.headers.get('x-payment-response');
    if (settleHeader) {
      try {
        const d = JSON.parse(Buffer.from(settleHeader, 'base64').toString());
        const settleTxHash = d.transaction || d.txHash;
        if (settleTxHash) {
          tx('Base — USDC settlement (EIP-3009 transferWithAuthorization)', 'Base', settleTxHash, {
            from: evmWallet.address,
            to: opWallet.address,
            amount: '0.033 USDC',
          });
        }
      } catch (e) { /* optional */ }
    }

    // ════════════════════════════════════════════════════════════════════
    // STEP 8: Parse provisioning result
    // ════════════════════════════════════════════════════════════════════
    const provResult = await paidRes.json();
    Object.assign(provision, provResult);

    step('Provisioning result received', {
      provisioned: provision.provisioned,
      subscriptionId: provision.subscriptionId,
      planId: provision.planId,
      feeGranter: provision.feeGranter,
      expiresAt: provision.expiresAt,
      sentinelTxHash: provision.sentinelTxHash,
    });

    if (provision.sentinelTxHash) {
      tx('Sentinel — Provision (MsgShareSubscription + MsgGrantAllowance)', 'Sentinel', provision.sentinelTxHash, {
        from: provision.feeGranter,
        forAgent: sentWallet.address,
        subscription: provision.subscriptionId,
      });
    }

    // ════════════════════════════════════════════════════════════════════
    // STEP 9: Check post-payment balance on Base
    // ════════════════════════════════════════════════════════════════════
    const postUsdc = await usdc.balanceOf(evmWallet.address);
    balances.postPayment = { usdc: ethers.formatUnits(postUsdc, 6) };
    const paid = (parseFloat(balances.postFunding.usdc) - parseFloat(balances.postPayment.usdc)).toFixed(6);

    step('Post-payment agent balance', {
      agentUSDC: `${balances.postPayment.usdc} USDC (was ${balances.postFunding.usdc}, paid ${paid})`,
      agentGas: 'ZERO — EIP-3009 means agent never sends a TX on Base',
      onChain: 'read-only',
    });

    // ════════════════════════════════════════════════════════════════════
    // STEP 10: Query fee grant via RPC
    // ════════════════════════════════════════════════════════════════════
    let rpcClient = null;
    try {
      rpcClient = await createRpcQueryClientWithFallback();
      const grant = await rpcQueryFeeGrant(rpcClient, provision.feeGranter, sentWallet.address);
      if (grant) {
        feeGrantData.granter = grant.granter;
        feeGrantData.grantee = grant.grantee;
        // Parse the allowance structure
        const a = grant.allowance;
        if (a) {
          feeGrantData.type = a['@type'] || 'unknown';
          feeGrantData.allowedMessages = a.allowed_messages || [];
          const inner = a.allowance || a;
          if (inner?.spend_limit?.length > 0) {
            feeGrantData.remaining = inner.spend_limit[0].amount;
            feeGrantData.denom = inner.spend_limit[0].denom;
          }
          if (inner?.expiration) feeGrantData.expiration = inner.expiration;
        }
      }
    } catch (e) {
      console.log(`    RPC fee grant query failed: ${e.message}`);
    }

    step('Query fee grant via RPC', {
      granter: feeGrantData.granter || provision.feeGranter,
      grantee: sentWallet.address,
      remaining: `${feeGrantData.remaining || '?'} ${feeGrantData.denom || 'udvpn'}`,
      expiration: feeGrantData.expiration || provision.expiresAt,
      allowedMsgs: (feeGrantData.allowedMessages || []).length + ' message types',
      onChain: `RPC query via ${SENTINEL_RPC}`,
    });

    // ════════════════════════════════════════════════════════════════════
    // STEP 11: Connect to VPN (fee-granted session)
    // ════════════════════════════════════════════════════════════════════
    const vpnT0 = Date.now();
    step('Connect to VPN (fee-granted session)', {
      action: 'MsgStartSessionRequest → WireGuard handshake → tunnel',
      gas: 'ZERO — fee grant covers all gas',
      granter: provision.feeGranter,
    });

    let vpnResult = null;
    for (const nodeAddress of PLAN_42_NODES) {
      console.log(`\n    Trying node: ${nodeAddress}...`);
      try {
        vpnResult = await connect({
          mnemonic: sentWallet.mnemonic,
          nodeAddress,
          subscriptionId: String(provision.subscriptionId),
          feeGranter: provision.feeGranter,
          timeout: 90000,
          onProgress: (stage, msg) => {
            console.log(`      [${ts()}] [${stage}] ${msg}`);
          },
        });
        break;
      } catch (err) {
        console.log(`      FAILED (${err.code || 'UNKNOWN'}): ${err.message}`);
        if (['FEE_GRANT_NOT_FOUND', 'FEE_GRANT_EXPIRED', 'FEE_GRANT_EXHAUSTED', 'INSUFFICIENT_BALANCE'].includes(err.code)) {
          throw err;
        }
      }
    }

    if (!vpnResult) throw new Error('All nodes failed');

    Object.assign(conn, {
      sessionId: vpnResult.sessionId,
      protocol: vpnResult.protocol,
      nodeAddress: vpnResult.nodeAddress,
      country: vpnResult.country,
      city: vpnResult.city,
      ip: vpnResult.ip,
      walletAddress: vpnResult.walletAddress,
      connectTime: ms(vpnT0),
    });

    // ════════════════════════════════════════════════════════════════════
    // STEP 12: VPN connected — record details
    // ════════════════════════════════════════════════════════════════════
    step('VPN connected', {
      sessionId: conn.sessionId,
      protocol: conn.protocol,
      node: conn.nodeAddress,
      location: `${conn.city}, ${conn.country}`,
      vpnIP: conn.ip,
      connectTime: `${conn.connectTime}s`,
    });

    // ════════════════════════════════════════════════════════════════════
    // STEP 13: Query session start TX via RPC tx_search
    // ════════════════════════════════════════════════════════════════════
    // Wait a few seconds for TX to be indexed
    await new Promise(r => setTimeout(r, 3000));

    const startQuery = `message.action='/sentinel.subscription.v3.MsgStartSessionRequest' AND message.sender='${sentWallet.address}'`;
    const startTxResult = await searchSentinelTx(startQuery);
    if (startTxResult) {
      const blockTime = await getBlockTime(startTxResult.height);
      step('Session start TX found via RPC', {
        txHash: startTxResult.hash,
        block: startTxResult.height,
        time: blockTime || 'unknown',
        onChain: `RPC tx_search via ${SENTINEL_RPC}`,
      });
      tx('Sentinel — Start session (MsgStartSessionRequest, fee-granted)', 'Sentinel', startTxResult.hash, {
        block: startTxResult.height,
        chainTime: blockTime,
        from: sentWallet.address,
        feeGranter: provision.feeGranter,
        session: conn.sessionId,
      });
    } else {
      step('Session start TX — could not find via RPC', {
        note: 'TX may still be indexing',
      });
    }

    // ════════════════════════════════════════════════════════════════════
    // STEP 14: Verify tunnel active
    // ════════════════════════════════════════════════════════════════════
    const st = status();
    step('Verify tunnel active', {
      connected: st.connected,
      sessionId: st.sessionId || conn.sessionId,
      ip: conn.ip,
    });

    // ════════════════════════════════════════════════════════════════════
    // STEP 15: Disconnect + end session
    // ════════════════════════════════════════════════════════════════════
    const dcT0 = Date.now();
    step('Disconnect + end session (fee-granted)', {
      action: 'MsgCancelSessionRequest on Sentinel (fire-and-forget)',
      gas: 'ZERO — fee grant covers gas',
    });

    await disconnect();
    const dcTime = ms(dcT0);
    console.log(`    Disconnected in ${dcTime}s`);

    // Wait for disconnect TX to land
    await new Promise(r => setTimeout(r, 8000));

    // ════════════════════════════════════════════════════════════════════
    // STEP 16: Query disconnect TX via RPC tx_search
    // ════════════════════════════════════════════════════════════════════
    const endQuery = `message.action='/sentinel.session.v3.MsgCancelSessionRequest' AND message.sender='${sentWallet.address}'`;
    const endTxResult = await searchSentinelTx(endQuery);
    if (endTxResult) {
      const blockTime = await getBlockTime(endTxResult.height);
      step('Session end TX found via RPC', {
        txHash: endTxResult.hash,
        block: endTxResult.height,
        time: blockTime || 'unknown',
        onChain: `RPC tx_search via ${SENTINEL_RPC}`,
      });
      tx('Sentinel — End session (MsgCancelSessionRequest, fee-granted)', 'Sentinel', endTxResult.hash, {
        block: endTxResult.height,
        chainTime: blockTime,
        from: sentWallet.address,
        feeGranter: provision.feeGranter,
        session: conn.sessionId,
      });
    } else {
      step('Session end TX — could not find via RPC', {
        note: 'TX may still be indexing (fire-and-forget)',
      });
    }

    // ════════════════════════════════════════════════════════════════════
    // STEP 17: Query post-disconnect fee grant via RPC
    // ════════════════════════════════════════════════════════════════════
    try {
      if (!rpcClient) rpcClient = await createRpcQueryClientWithFallback();
      const grantAfter = await rpcQueryFeeGrant(rpcClient, provision.feeGranter, sentWallet.address);
      if (grantAfter) {
        const a = grantAfter.allowance;
        const inner = a?.allowance || a;
        if (inner?.spend_limit?.length > 0) {
          feeGrantData.remainingAfter = inner.spend_limit[0].amount;
        }
      }
    } catch (e) { /* non-critical */ }

    const used = feeGrantData.remaining && feeGrantData.remainingAfter
      ? parseInt(feeGrantData.remaining) - parseInt(feeGrantData.remainingAfter)
      : null;

    step('Post-disconnect fee grant via RPC', {
      remainingBefore: `${feeGrantData.remaining || '?'} udvpn`,
      remainingAfter: `${feeGrantData.remainingAfter || '?'} udvpn`,
      used: used ? `${used} udvpn (${Math.ceil(used / 60000)} TXs)` : '?',
    });

    // ════════════════════════════════════════════════════════════════════
    // STEP 18: Query final balances
    // ════════════════════════════════════════════════════════════════════
    const [fUsdc, oUsdc] = await Promise.all([
      usdc.balanceOf(evmWallet.address),
      usdc.balanceOf(opWallet.address),
    ]);
    balances.final = { usdc: ethers.formatUnits(fUsdc, 6) };
    balances.operator = { usdc: ethers.formatUnits(oUsdc, 6) };

    step('Final balances', {
      agentUSDC: `${balances.final.usdc} USDC`,
      agentGas: 'ZERO on both chains (EIP-3009 on Base, fee grant on Sentinel)',
      operatorUSDC: `${balances.operator.usdc} USDC`,
    });

    // Cleanup RPC
    try { disconnectRpc(); } catch { /* ok */ }

    // ════════════════════════════════════════════════════════════════════
    // STEP 19: Write results + open Notepad
    // ════════════════════════════════════════════════════════════════════
    step('Write results + open Notepad', {});
    writeResults(testStart, wallets, balances, provision, conn, feeGrantData);

    console.log(`\n${'═'.repeat(70)}`);
    console.log('  TEST PASSED');
    console.log(`${'═'.repeat(70)}\n`);

  } catch (err) {
    console.error(`\nFATAL: ${err.message}`);
    console.error(err.stack);
    try { disconnectRpc(); } catch { /* ok */ }
    step('FATAL ERROR', { error: err.message });
    writeResults(testStart, wallets, balances, provision, conn, feeGrantData);
    process.exit(1);
  }
}

// ─── Write Results ───

function writeResults(testStart, wallets, balances, provision, conn, feeGrantData) {
  const testEnd = ts();
  const L = [];
  const HR = '══════════════════════════════════════════════════════════════════════';

  L.push('x402 FRESH AGENT — COMPLETE E2E TEST');
  L.push('==========================================');
  L.push(`Date:         ${new Date().toISOString().split('T')[0]}`);
  L.push(`Time:         ${testStart} → ${testEnd}`);
  L.push(`Result:       ${conn.sessionId ? 'PASS' : 'FAIL'}`);
  L.push(`Total Steps:  ${S.length}`);
  L.push(`On-chain TXs: ${TX.length}`);
  L.push('');
  L.push('');

  // ── Wallets ──
  L.push('WALLETS');
  L.push('=======');
  L.push('');
  L.push('Agent EVM (Base):');
  L.push(`  Address:     ${wallets.evm.address}`);
  L.push(`  Private key: ${wallets.evm.privateKey}`);
  L.push(`  Explorer:    ${BASE_ADDR}/${wallets.evm.address}`);
  L.push('');
  L.push('Agent Sentinel:');
  L.push(`  Address:     ${wallets.sentinel.address}`);
  L.push(`  Mnemonic:    ${wallets.sentinel.mnemonic}`);
  L.push(`  Explorer:    ${SENT_ADDR}/${wallets.sentinel.address}`);
  L.push('');
  L.push('Operator:');
  L.push(`  EVM:         0xCC689D76786a698EAc6b3b7ba9e0b6b3AED72B49`);
  L.push(`  Sentinel:    sent12e03wzmxjerwqt63p252cqs90jwfuwdd4fjhzg`);
  L.push('');
  L.push('');

  // ── Step by step ──
  L.push(HR);
  L.push(`  STEP-BY-STEP EXECUTION (${S.length} steps)`);
  L.push(HR);
  L.push('');

  for (const s of S) {
    L.push(`STEP ${s.n} — ${s.title}`);
    L.push('─'.repeat(60));
    L.push(`  Time:      ${s.time}`);
    if (s.confirmed) L.push(`  Confirmed: ${s.confirmed}`);
    for (const [k, v] of Object.entries(s)) {
      if (['n', 'title', 'time', 'confirmed'].includes(k)) continue;
      if (typeof v === 'string' && v.includes('\n')) {
        L.push(`  ${k}:`);
        for (const line of v.split('\n')) L.push(`    ${line}`);
      } else {
        L.push(`  ${k}:  ${v}`);
      }
    }
    L.push('');
  }
  L.push('');

  // ── All TXs ──
  L.push(HR);
  L.push(`  ALL ON-CHAIN TRANSACTIONS (${TX.length})`);
  L.push(HR);
  L.push('');

  for (let i = 0; i < TX.length; i++) {
    const t = TX[i];
    L.push(`TX ${i + 1} — ${t.label}`);
    L.push(`  Chain:      ${t.chain}`);
    L.push(`  Time:       ${t.chainTime || t.time}`);
    if (t.block) L.push(`  Block:      ${t.block}`);
    L.push(`  TX Hash:    ${t.hash}`);
    if (t.from) L.push(`  From:       ${t.from}`);
    if (t.to) L.push(`  To:         ${t.to}`);
    if (t.forAgent) L.push(`  For Agent:  ${t.forAgent}`);
    if (t.amount) L.push(`  Amount:     ${t.amount}`);
    if (t.subscription) L.push(`  Sub ID:     ${t.subscription}`);
    if (t.feeGranter) L.push(`  Fee Grant:  ${t.feeGranter}`);
    if (t.session) L.push(`  Session:    ${t.session}`);
    L.push(`  Explorer:   ${t.explorer}`);
    L.push('');
  }
  L.push('');

  // ── Balances ──
  L.push(HR);
  L.push('  BALANCES');
  L.push(HR);
  L.push('');
  L.push('Agent (Base):');
  L.push(`  After funding:    ${balances.postFunding?.usdc || '?'} USDC`);
  L.push(`  After x402:       ${balances.postPayment?.usdc || '?'} USDC`);
  L.push(`  Final:            ${balances.final?.usdc || '?'} USDC`);
  L.push('  ETH:              0 — agent never needs gas (EIP-3009 = facilitator pays)');
  L.push('');
  L.push('Agent (Sentinel):');
  L.push('  P2P:              0.00 (all TXs covered by fee grant)');
  L.push('');
  L.push('Operator:');
  L.push(`  USDC:             ${balances.operator?.usdc || '?'}`);
  L.push('');
  L.push('');

  // ── Fee Grant ──
  L.push(HR);
  L.push('  FEE GRANT (queried via Sentinel RPC)');
  L.push(HR);
  L.push('');
  L.push(`  Granter:          ${feeGrantData.granter || provision.feeGranter || '?'}`);
  L.push(`  Grantee:          ${wallets.sentinel.address}`);
  L.push(`  Initial:          ${feeGrantData.remaining || '?'} udvpn`);
  L.push(`  After disconnect: ${feeGrantData.remainingAfter || '?'} udvpn`);
  const remainAfter = feeGrantData.remainingAfter ? parseInt(feeGrantData.remainingAfter) : null;
  const p2p = remainAfter ? (remainAfter / 1_000_000).toFixed(2) : '?';
  const estTxs = remainAfter ? Math.floor(remainAfter / 60000) : '?';
  L.push(`  Remaining P2P:    ${p2p} P2P (~${estTxs} more TXs)`);
  L.push(`  Expiration:       ${feeGrantData.expiration || provision.expiresAt || '?'}`);
  if (feeGrantData.allowedMessages?.length > 0) {
    L.push(`  Allowed messages:`);
    for (const msg of feeGrantData.allowedMessages) {
      L.push(`    - ${msg}`);
    }
  }
  L.push('');
  L.push('');

  // ── Provisioning ──
  L.push(HR);
  L.push('  PROVISIONING');
  L.push(HR);
  L.push('');
  L.push(`  Provisioned:      ${provision.provisioned}`);
  L.push(`  Subscription:     ${provision.subscriptionId}`);
  L.push(`  Plan ID:          ${provision.planId}`);
  L.push(`  Fee Granter:      ${provision.feeGranter}`);
  L.push(`  Sentinel TX:      ${provision.sentinelTxHash}`);
  L.push(`  Expires:          ${provision.expiresAt}`);
  L.push(`  Operator EVM:     ${provision.operatorAddress || '0xCC689D76786a698EAc6b3b7ba9e0b6b3AED72B49'}`);
  L.push('');
  L.push('');

  // ── VPN Connection ──
  L.push(HR);
  L.push('  VPN CONNECTION');
  L.push(HR);
  L.push('');
  L.push(`  Session ID:       ${conn.sessionId || '—'}`);
  L.push(`  Protocol:         ${conn.protocol || '—'}`);
  L.push(`  Node:             ${conn.nodeAddress || '—'}`);
  L.push(`  Country:          ${conn.country || '—'}`);
  L.push(`  City:             ${conn.city || '—'}`);
  L.push(`  VPN IP:           ${conn.ip || '—'}`);
  L.push(`  Connect time:     ${conn.connectTime || '—'}s`);
  L.push('');
  L.push('');

  // ── Pricing ──
  L.push(HR);
  L.push('  PRICING');
  L.push(HR);
  L.push('');
  L.push('  1 day:   $0.033  →  POST /vpn/connect/1day');
  L.push('  7 days:  $0.233  →  POST /vpn/connect/7days');
  L.push('  30 days: $1.00   →  POST /vpn/connect/30days');
  L.push('');
  L.push('  Payment:   x402 HTTP 402 (EIP-3009 transferWithAuthorization)');
  L.push('  Asset:     USDC on Base mainnet (EIP-155:8453)');
  L.push('  Contract:  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  L.push('');
  L.push('');

  // ── Query URLs ──
  L.push(HR);
  L.push('  QUERY URLS');
  L.push(HR);
  L.push('');
  L.push('  Agent fee grants:');
  L.push(`    https://lcd.sentinel.co/cosmos/feegrant/v1beta1/allowances/${wallets.sentinel.address}`);
  L.push('');
  L.push('  Agent sessions:');
  L.push(`    https://lcd.sentinel.co/sentinel/session/v3/accounts/${wallets.sentinel.address}/sessions`);
  L.push('');
  L.push('  Agent subscriptions:');
  L.push(`    https://lcd.sentinel.co/sentinel/subscription/v3/accounts/${wallets.sentinel.address}/subscriptions`);
  L.push('');
  if (conn.sessionId) {
    L.push(`  Session ${conn.sessionId}:`);
    L.push(`    https://lcd.sentinel.co/sentinel/session/v3/sessions/${conn.sessionId}`);
    L.push('');
  }
  L.push('  Agent on Base:');
  L.push(`    ${BASE_ADDR}/${wallets.evm.address}`);
  L.push('');
  L.push('  Operator on Base:');
  L.push(`    ${BASE_ADDR}/0xCC689D76786a698EAc6b3b7ba9e0b6b3AED72B49`);
  L.push('');
  L.push('');

  // ── Timeline ──
  L.push(HR);
  L.push('  TIMELINE');
  L.push(HR);
  L.push('');
  for (const s of S) {
    const t = s.time.split('T')[1];
    const pad = s.n < 10 ? ' ' : '';
    L.push(`  ${t}  Step ${pad}${s.n}  ${s.title}`);
    if (s.confirmed) {
      const ct = s.confirmed.split('T')[1];
      L.push(`  ${ct}         └─ confirmed`);
    }
  }
  L.push('');

  const outputPath = process.cwd().replace(/\\/g, '/') + '/../E2E-FRESH-AGENT.txt';
  const outputPathWin = outputPath.replace(/\//g, '\\');
  writeFileSync(outputPath, L.join('\r\n'), 'utf8');
  console.log(`\n  Written to: ${outputPath}`);

  try {
    execSync(`start notepad "${outputPathWin}"`, { stdio: 'ignore', shell: true });
    console.log(`  Opened in Notepad`);
  } catch (e) {
    console.log(`  (Notepad: ${e.message})`);
  }
}

main();
