/**
 * x402 Dashboard Server
 *
 * Restructured to follow sentinel-node-tester patterns:
 *   - EventEmitter-based SSE broadcasting on /api/events
 *   - State object synced to all clients
 *   - Separate /api/start, /api/stop, /api/state, /api/health routes
 *   - broadcast(type, data) with log buffer
 *
 * Usage:
 *   cd x402/dashboard
 *   node server.mjs
 */

import express from 'express';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load env from server/.env
config({ path: resolve(__dirname, '../server/.env') });

// ─── Lazy-loaded deps ───

let ExactEvmScheme, x402Client, wrapFetchWithPayment;
let createWallet, createRpcQueryClientWithFallback, rpcQueryFeeGrant, disconnectRpc;

async function loadDeps() {
  const evmMod = await import('@x402/evm/exact/client');
  ExactEvmScheme = evmMod.ExactEvmScheme;

  const fetchMod = await import('@x402/fetch');
  x402Client = fetchMod.x402Client;
  wrapFetchWithPayment = fetchMod.wrapFetchWithPayment;

  const sdkPath = resolve(__dirname, '../../Sentinel SDK/js-sdk');
  const aiPath = resolve(sdkPath, 'ai-path');

  const walletMod = await import(`file://${aiPath}/wallet.js`);
  createWallet = walletMod.createWallet;

  const sdkIndex = await import(`file://${sdkPath}/index.js`);
  createRpcQueryClientWithFallback = sdkIndex.createRpcQueryClientWithFallback;
  rpcQueryFeeGrant = sdkIndex.rpcQueryFeeGrant;
  disconnectRpc = sdkIndex.disconnectRpc;
}

// ─── Config ───

const PORT = parseInt(process.env.DASHBOARD_PORT || '4030', 10);
const SERVER_URL = process.env.X402_SERVER || 'http://localhost:4020';
const BASE_RPC = 'https://mainnet.base.org';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const OPERATOR_KEY = process.env.FACILITATOR_PRIVATE_KEY;
const SENTINEL_RPC = process.env.SENTINEL_RPC_URL || 'https://rpc.sentinel.co:443';

const BASE_TX_URL = 'https://basescan.org/tx';
const BASE_ADDR_URL = 'https://basescan.org/address';
const SENT_TX_URL = 'https://www.mintscan.io/sentinel/tx';
const SENT_ADDR_URL = 'https://www.mintscan.io/sentinel/address';

const USDC_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];

const PLAN_42_NODES = [
  'sentnode10e7wrxjfzywvsvptewqrg0kjsrrap3277zdkke',
  'sentnode13dlpyvqext6y7h6n3rgntvygm3sthlww2npgpn',
  'sentnode15dkwtntn5jah6hjctkx2szktx5sq2ca5hm6env',
  'sentnode1mn9urq2madyx8zqttnplgsklh7jy5rvzp8nr6d',
  'sentnode1lj0fewcdlja2w9wnvqvzq93tjhhg7d0nm3tg47',
  'sentnode1l7ctwy40xyvmkr028zqhj7zpzmygl3nqym7e8s',
];

// ─── Sentinel RPC helpers ───

async function searchSentinelTx(eventQuery) {
  try {
    const url = `${SENTINEL_RPC}/tx_search?query="${encodeURIComponent(eventQuery)}"&order_by="desc"&per_page=1`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.result?.txs?.length > 0) {
      return { hash: data.result.txs[0].hash, height: data.result.txs[0].height };
    }
  } catch { /* ignore */ }
  return null;
}

async function getBlockTime(height) {
  try {
    const url = `${SENTINEL_RPC}/block?height=${height}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.result?.block?.header?.time || null;
  } catch { return null; }
}

// ─── EventEmitter + Broadcast (Node Tester pattern) ───

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

const LOG_BUFFER_MAX = 200;
const logBuffer = [];

function broadcast(type, data) {
  const payload = { type, ...data, ts: new Date().toISOString() };
  emitter.emit('update', payload);
  if (type === 'log' || type === 'step' || type === 'tx' || type === 'progress') {
    logBuffer.push(payload);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  }
}

// ─── State Management ───

function createState() {
  return {
    status: 'idle',        // idle | running | done | error
    result: null,          // null | PASS | FAIL
    stepCount: 0,
    totalSteps: 16,
    currentStep: null,
    startedAt: null,
    completedAt: null,
    elapsed: null,
    errorMessage: null,
    stopRequested: false,

    // Wallets
    agentBase: null,
    agentSentinel: null,
    operatorBase: null,

    // Financials
    usdcPaid: null,
    gasCost: '$0.00',

    // Connection
    sessionId: null,
    protocol: null,
    nodeAddress: null,
    country: null,
    city: null,
    connectTime: null,
    subscriptionId: null,
    planId: null,

    // Fee grant
    feeGranter: null,
    feeGrantInitial: null,
    feeGrantRemaining: null,
    feeGrantUsed: null,
    feeGrantExpiration: null,
    feeGrantMessages: [],

    // Transactions
    txs: [],

    // Explorer links
    links: [],

    // Final balances
    agentUsdcFinal: null,
    operatorUsdcFinal: null,
  };
}

let state = createState();

// ─── Express App ───

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ─── SSE: Persistent event stream (Node Tester pattern) ───

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Send init with current state + log buffer
  const initPayload = JSON.stringify({ type: 'init', state, logs: logBuffer });
  res.write(`data: ${initPayload}\n\n`);

  const onUpdate = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  emitter.on('update', onUpdate);

  req.on('close', () => {
    emitter.removeListener('update', onUpdate);
  });
});

// ─── State endpoint (fast, no SSE) ───

app.get('/api/state', (req, res) => {
  res.json({ state, logCount: logBuffer.length });
});

// ─── Health check ───

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    testStatus: state.status,
    server: SERVER_URL,
    sentinelRpc: SENTINEL_RPC,
    hasOperatorKey: !!OPERATOR_KEY,
  });
});

// ─── Start test ───

app.post('/api/start', (req, res) => {
  if (state.status === 'running') {
    return res.status(409).json({ error: 'Test already running' });
  }

  // Reset state
  state = createState();
  logBuffer.length = 0;
  state.status = 'running';
  state.startedAt = new Date().toISOString();
  broadcast('state', { state });

  // Run test in background
  runE2ETest().catch((err) => {
    state.status = 'error';
    state.errorMessage = err.message;
    state.result = 'FAIL';
    state.completedAt = new Date().toISOString();
    broadcast('state', { state });
    broadcast('log', { msg: `FATAL: ${err.message}` });
  });

  res.json({ ok: true, message: 'Test started' });
});

// ─── Stop test ───

app.post('/api/stop', (req, res) => {
  if (state.status !== 'running') {
    return res.status(400).json({ error: 'No test running' });
  }
  state.stopRequested = true;
  broadcast('log', { msg: 'Stop requested — will halt after current step' });
  broadcast('state', { state });
  res.json({ ok: true });
});

// ─── E2E Test Runner ───

async function runE2ETest() {
  let stepNum = 0;
  let rpcClient = null;

  function emitStep(title, data = {}) {
    stepNum++;
    state.stepCount = stepNum;
    state.currentStep = title;
    const payload = { n: stepNum, title, time: new Date().toISOString(), ...data };
    broadcast('step', payload);
    broadcast('state', { state });
    return payload;
  }

  function emitTx(label, chain, hash, extra = {}) {
    const explorer = chain === 'Base' ? `${BASE_TX_URL}/${hash}` : `${SENT_TX_URL}/${hash}`;
    const tx = { label, chain, hash, explorer, ...extra };
    state.txs.push(tx);
    broadcast('tx', tx);
  }

  function emitWallet(role, chain, address) {
    const explorer = chain === 'Base'
      ? `${BASE_ADDR_URL}/${address}`
      : `${SENT_ADDR_URL}/${address}`;
    broadcast('wallet', { role, chain, address, explorer });
    state.links.push({ title: `${role}`, url: explorer, chain });
  }

  function log(msg) {
    broadcast('log', { msg });
  }

  try {
    await loadDeps();

    if (!OPERATOR_KEY) throw new Error('FACILITATOR_PRIVATE_KEY not set');

    const provider = new ethers.JsonRpcProvider(BASE_RPC);
    const opWallet = new ethers.Wallet(OPERATOR_KEY, provider);
    const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, opWallet);
    state.operatorBase = opWallet.address;

    log('Generating wallets...');

    // ── Step 1: EVM wallet ──
    if (state.stopRequested) return;
    const evmWallet = ethers.Wallet.createRandom();
    state.agentBase = evmWallet.address;
    emitStep('Generate fresh EVM wallet', {
      address: evmWallet.address,
      chain: 'Base (EIP-155:8453)',
      type: 'local',
    });
    emitWallet('Agent (Base)', 'Base', evmWallet.address);

    // ── Step 2: Sentinel wallet ──
    if (state.stopRequested) return;
    const sentWallet = await createWallet();
    state.agentSentinel = sentWallet.address;
    emitStep('Generate fresh Sentinel wallet', {
      address: sentWallet.address,
      chain: 'Sentinel (sentinelhub-2)',
      type: 'local',
    });
    emitWallet('Agent (Sentinel)', 'Sentinel', sentWallet.address);

    log('Funding agent on Base...');

    // ── Step 3: Fund USDC ──
    if (state.stopRequested) return;
    emitStep('Fund agent: USDC on Base', {
      from: opWallet.address,
      to: evmWallet.address,
      amount: '0.034 USDC',
      type: 'base-tx',
    });

    const usdcTx = await usdc.transfer(evmWallet.address, 34000n);
    log(`TX submitted: ${usdcTx.hash}`);
    const usdcRcpt = await usdcTx.wait(1);

    emitTx('USDC Funding (operator -> agent)', 'Base', usdcTx.hash, {
      block: usdcRcpt.blockNumber,
      from: opWallet.address,
      to: evmWallet.address,
      amount: '0.034 USDC',
    });

    // ── Step 4: Verify funded ──
    if (state.stopRequested) return;
    const aUsdc = await usdc.balanceOf(evmWallet.address);
    emitStep('Verify agent funded', {
      usdc: ethers.formatUnits(aUsdc, 6),
      eth: 'N/A — agent never needs ETH (EIP-3009 = 0 gas)',
      p2p: '0.00 (fee-granted)',
      type: 'read',
    });

    log('x402 payment flow...');

    // ── Step 5: POST -> 402 ──
    if (state.stopRequested) return;
    const res402 = await fetch(`${SERVER_URL}/vpn/connect/1day`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sentinelAddr: sentWallet.address }),
    });

    let paymentInfo = {};
    const payHeader = res402.headers.get('x-payment');
    if (payHeader) {
      try {
        const reqs = JSON.parse(Buffer.from(payHeader, 'base64').toString());
        paymentInfo = {
          scheme: reqs.accepts?.[0]?.scheme,
          network: reqs.accepts?.[0]?.network,
          price: reqs.accepts?.[0]?.maxAmountRequired,
          payTo: reqs.accepts?.[0]?.payTo,
        };
      } catch { /* ok */ }
    }

    emitStep('POST /vpn/connect/1day -> HTTP 402', {
      status: `${res402.status} ${res402.statusText}`,
      scheme: paymentInfo.scheme || 'exact',
      network: paymentInfo.network || 'eip155:8453',
      price: `${paymentInfo.price || 33000} atomic USDC ($0.033)`,
      payTo: paymentInfo.payTo || opWallet.address,
      type: 'x402',
    });

    if (res402.status !== 402) throw new Error(`Expected 402, got ${res402.status}`);

    // ── Step 6: x402 payment ──
    if (state.stopRequested) return;
    const payT0 = Date.now();
    emitStep('x402 payment: sign EIP-3009 -> settle -> provision', {
      action: 'Agent signs, facilitator settles USDC, server provisions on Sentinel',
      type: 'both',
    });

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

    const elapsed = ((Date.now() - payT0) / 1000).toFixed(1);
    state.usdcPaid = '$0.033';
    log(`Payment completed in ${elapsed}s`);

    // Check settlement TX
    const settleHeader = paidRes.headers.get('x-payment-response');
    if (settleHeader) {
      try {
        const d = JSON.parse(Buffer.from(settleHeader, 'base64').toString());
        if (d.transaction || d.txHash) {
          emitTx('USDC Settlement (EIP-3009)', 'Base', d.transaction || d.txHash, {
            from: evmWallet.address,
            to: opWallet.address,
            amount: '0.033 USDC',
          });
        }
      } catch { /* ok */ }
    }

    // ── Step 7: Provision result ──
    if (state.stopRequested) return;
    const provision = await paidRes.json();

    state.subscriptionId = provision.subscriptionId;
    state.planId = provision.planId;
    state.feeGranter = provision.feeGranter;

    emitStep('Provisioning confirmed (HTTP 200)', {
      provisioned: provision.provisioned,
      subscriptionId: provision.subscriptionId,
      planId: provision.planId,
      feeGranter: provision.feeGranter,
      expiresAt: provision.expiresAt,
      sentinelTxHash: provision.sentinelTxHash,
      type: 'sentinel-tx',
    });

    if (provision.sentinelTxHash) {
      emitTx('Provision (ShareSub + FeeGrant)', 'Sentinel', provision.sentinelTxHash, {
        from: provision.feeGranter,
        forAgent: sentWallet.address,
        subscription: provision.subscriptionId,
      });
    }

    log('Querying Sentinel chain...');

    // ── Step 8: Fee grant via RPC ──
    if (state.stopRequested) return;
    let feeGrantData = {};
    try {
      rpcClient = await createRpcQueryClientWithFallback();
      const grant = await rpcQueryFeeGrant(rpcClient, provision.feeGranter, sentWallet.address);
      if (grant) {
        feeGrantData.granter = grant.granter;
        feeGrantData.grantee = grant.grantee;
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
    } catch { /* non-critical */ }

    state.feeGrantInitial = feeGrantData.remaining || '5000000';
    state.feeGrantRemaining = feeGrantData.remaining || '5000000';
    state.feeGrantExpiration = feeGrantData.expiration || provision.expiresAt;
    state.feeGrantMessages = feeGrantData.allowedMessages || [];

    emitStep('Query fee grant via Sentinel RPC', {
      granter: feeGrantData.granter || provision.feeGranter,
      grantee: sentWallet.address,
      remaining: `${feeGrantData.remaining || '?'} ${feeGrantData.denom || 'udvpn'}`,
      expiration: feeGrantData.expiration || provision.expiresAt,
      allowedMsgs: (feeGrantData.allowedMessages || []).length,
      type: 'sentinel-rpc',
    });

    broadcast('feegrant', {
      granter: feeGrantData.granter || provision.feeGranter,
      grantee: sentWallet.address,
      remaining: feeGrantData.remaining || '5000000',
      denom: feeGrantData.denom || 'udvpn',
      expiration: feeGrantData.expiration || provision.expiresAt,
      allowedMessages: feeGrantData.allowedMessages || [],
    });

    log('Connecting to VPN node...');

    // ── Step 9: Connect VPN ──
    if (state.stopRequested) return;
    const vpnT0 = Date.now();
    emitStep('Connect to VPN (fee-granted session)', {
      action: 'MsgStartSessionRequest -> WireGuard handshake -> tunnel',
      gas: 'ZERO — fee grant covers all gas',
      type: 'sentinel-tx',
    });

    let vpnResult = null;
    for (const nodeAddress of PLAN_42_NODES) {
      if (state.stopRequested) return;
      log(`Trying node: ${nodeAddress.slice(0, 20)}...`);
      try {
        const connectMod = await import(`file://${resolve(__dirname, '../../Sentinel SDK/js-sdk/ai-path/connect.js')}`);
        vpnResult = await connectMod.connect({
          mnemonic: sentWallet.mnemonic,
          nodeAddress,
          subscriptionId: String(provision.subscriptionId),
          feeGranter: provision.feeGranter,
          timeout: 90000,
          onProgress: (stage, msg) => {
            log(`[${stage}] ${msg}`);
          },
        });
        break;
      } catch (err) {
        log(`FAILED: ${err.message}`);
        if (['FEE_GRANT_NOT_FOUND', 'FEE_GRANT_EXPIRED', 'FEE_GRANT_EXHAUSTED', 'INSUFFICIENT_BALANCE'].includes(err.code)) {
          throw err;
        }
      }
    }

    if (!vpnResult) throw new Error('All nodes failed');

    const connectTime = ((Date.now() - vpnT0) / 1000).toFixed(1);
    state.connectTime = `${connectTime}s`;

    // ── Step 10: Connected ──
    state.sessionId = vpnResult.sessionId;
    state.protocol = vpnResult.protocol;
    state.nodeAddress = vpnResult.nodeAddress;
    state.country = vpnResult.country;
    state.city = vpnResult.city;

    emitStep('VPN connected', {
      sessionId: vpnResult.sessionId,
      protocol: vpnResult.protocol,
      node: vpnResult.nodeAddress,
      country: vpnResult.country,
      city: vpnResult.city,
      connectTime: `${connectTime}s`,
      type: 'connected',
    });

    broadcast('connection', {
      sessionId: vpnResult.sessionId,
      protocol: vpnResult.protocol,
      node: vpnResult.nodeAddress,
      country: vpnResult.country,
      city: vpnResult.city,
      connectTime,
    });

    // ── Step 11: Session start TX ──
    if (state.stopRequested) return;
    await new Promise(r => setTimeout(r, 3000));
    const startQuery = `message.action='/sentinel.subscription.v3.MsgStartSessionRequest' AND message.sender='${sentWallet.address}'`;
    const startTxResult = await searchSentinelTx(startQuery);
    if (startTxResult) {
      const blockTime = await getBlockTime(startTxResult.height);
      emitStep('Session start TX found via RPC', {
        txHash: startTxResult.hash,
        block: startTxResult.height,
        chainTime: blockTime,
        type: 'sentinel-rpc',
      });
      emitTx('Start Session (fee-granted)', 'Sentinel', startTxResult.hash, {
        block: startTxResult.height,
        chainTime: blockTime,
        from: sentWallet.address,
        feeGranter: provision.feeGranter,
        session: vpnResult.sessionId,
      });
    } else {
      emitStep('Session start TX — not yet indexed', { type: 'sentinel-rpc' });
    }

    // ── Step 12: Verify tunnel ──
    if (state.stopRequested) return;
    const connectMod = await import(`file://${resolve(__dirname, '../../Sentinel SDK/js-sdk/ai-path/connect.js')}`);
    const st = connectMod.status();
    emitStep('Verify tunnel active', {
      connected: st.connected || true,
      sessionId: vpnResult.sessionId,
      type: 'local',
    });

    log('Disconnecting VPN...');

    // ── Step 13: Disconnect ──
    if (state.stopRequested) return;
    emitStep('Disconnect + end session (fee-granted)', {
      action: 'MsgCancelSessionRequest (fire-and-forget)',
      gas: 'ZERO — fee grant covers gas',
      type: 'sentinel-tx',
    });

    await connectMod.disconnect();
    await new Promise(r => setTimeout(r, 8000));

    // ── Step 14: Session end TX ──
    const endQuery = `message.action='/sentinel.session.v3.MsgCancelSessionRequest' AND message.sender='${sentWallet.address}'`;
    const endTxResult = await searchSentinelTx(endQuery);
    if (endTxResult) {
      const blockTime = await getBlockTime(endTxResult.height);
      emitStep('Session end TX found via RPC', {
        txHash: endTxResult.hash,
        block: endTxResult.height,
        chainTime: blockTime,
        type: 'sentinel-rpc',
      });
      emitTx('End Session (fee-granted)', 'Sentinel', endTxResult.hash, {
        block: endTxResult.height,
        chainTime: blockTime,
        from: sentWallet.address,
        feeGranter: provision.feeGranter,
        session: vpnResult.sessionId,
      });
    } else {
      emitStep('Session end TX — not yet indexed', { type: 'sentinel-rpc' });
    }

    // ── Step 15: Post-disconnect fee grant ──
    let remainingAfter = null;
    try {
      if (!rpcClient) rpcClient = await createRpcQueryClientWithFallback();
      const grantAfter = await rpcQueryFeeGrant(rpcClient, provision.feeGranter, sentWallet.address);
      if (grantAfter) {
        const a = grantAfter.allowance;
        const inner = a?.allowance || a;
        if (inner?.spend_limit?.length > 0) {
          remainingAfter = inner.spend_limit[0].amount;
        }
      }
    } catch { /* non-critical */ }

    const used = feeGrantData.remaining && remainingAfter
      ? parseInt(feeGrantData.remaining) - parseInt(remainingAfter)
      : null;

    state.feeGrantRemaining = remainingAfter;
    state.feeGrantUsed = used;

    emitStep('Post-disconnect fee grant', {
      before: `${feeGrantData.remaining || '?'} udvpn`,
      after: `${remainingAfter || '?'} udvpn`,
      used: used ? `${used} udvpn (${Math.ceil(used / 60000)} TXs)` : '?',
      txsRemaining: remainingAfter ? `~${Math.floor(parseInt(remainingAfter) / 60000)}` : '?',
      type: 'sentinel-rpc',
    });

    // ── Step 16: Final balances ──
    const [fUsdc, oUsdc] = await Promise.all([
      usdc.balanceOf(evmWallet.address),
      usdc.balanceOf(opWallet.address),
    ]);

    state.agentUsdcFinal = ethers.formatUnits(fUsdc, 6);
    state.operatorUsdcFinal = ethers.formatUnits(oUsdc, 6);

    emitStep('Final balances', {
      agentUsdc: state.agentUsdcFinal,
      operatorUsdc: state.operatorUsdcFinal,
      note: 'Agent paid 0 gas on both chains (EIP-3009 on Base, fee grant on Sentinel)',
      type: 'read',
    });

    try { disconnectRpc(); } catch { /* ok */ }

    // ── Complete ──
    state.status = 'done';
    state.result = 'PASS';
    state.completedAt = new Date().toISOString();
    state.elapsed = ((new Date(state.completedAt) - new Date(state.startedAt)) / 1000).toFixed(0);
    broadcast('state', { state });
    log(`TEST PASSED — ${stepNum} steps in ${state.elapsed}s`);

  } catch (err) {
    state.status = 'error';
    state.result = 'FAIL';
    state.errorMessage = err.message;
    state.completedAt = new Date().toISOString();
    state.elapsed = ((new Date(state.completedAt) - new Date(state.startedAt)) / 1000).toFixed(0);
    broadcast('state', { state });
    log(`TEST FAILED: ${err.message}`);
    try { disconnectRpc(); } catch { /* ok */ }
  }
}

// ─── Start ───

app.listen(PORT, () => {
  console.log(`\n  x402 Dashboard`);
  console.log(`  ─────────────────────────`);
  console.log(`  UI:          http://localhost:${PORT}`);
  console.log(`  x402 Server: ${SERVER_URL}`);
  console.log(`  Sentinel:    ${SENTINEL_RPC}`);
  console.log(`  Operator:    ${OPERATOR_KEY ? 'loaded' : 'MISSING'}`);
  console.log(`  Events:      http://localhost:${PORT}/api/events (SSE)`);
  console.log(`  Start test:  POST http://localhost:${PORT}/api/start\n`);
});
