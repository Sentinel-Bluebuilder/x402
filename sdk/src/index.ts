import { payOnBase } from './payment/base.js';
import { DEFAULT_API_URL, POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from './config.js';
import type {
  ConnectOptions,
  ConnectResult,
  RegisterResponse,
  PricingResponse,
  PaymentStatusResponse,
} from './types.js';

export type { ConnectOptions, ConnectResult, PricingResponse };

// ─── API Helpers ───

async function apiPost<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(`API error (${res.status}): ${(err as any).message || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(`API error (${res.status}): ${(err as any).message || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// ─── Poll for Allocation ───

async function pollForAllocation(
  txHash: string,
  apiUrl: string,
  timeoutMs: number = POLL_TIMEOUT_MS,
  onProgress?: (step: string, detail: string) => void,
): Promise<PaymentStatusResponse> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const status = await apiGet<PaymentStatusResponse>(`${apiUrl}/api/payment/${txHash}`);

    if (status.status === 'allocated') {
      return status;
    }

    if (status.status === 'failed') {
      throw new Error(`Payment failed: ${status.error || 'unknown'}`);
    }

    onProgress?.('waiting', `Waiting for Sentinel allocation... (${status.status})`);
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(`Allocation timeout after ${timeoutMs / 1000}s. Check payment status manually.`);
}

// ─── Connect ───

/**
 * Connect to a decentralized VPN. One function call.
 *
 * @example
 * ```ts
 * import { connect } from 'x402-connect';
 *
 * const vpn = await connect({
 *   payment: {
 *     chain: 'base',
 *     walletKey: process.env.EVM_PRIVATE_KEY,
 *     hours: 720, // 30 days
 *   },
 * });
 *
 * console.log(vpn.connected); // true
 * console.log(vpn.ip);        // '45.152.243.12'
 * console.log(vpn.country);   // 'Germany'
 * ```
 */
export async function connect(opts: ConnectOptions): Promise<ConnectResult> {
  const apiUrl = opts.apiUrl || DEFAULT_API_URL;
  const progress = opts.onProgress || (() => {});

  // ─── Step 1: Create or load Sentinel wallet ───
  progress('wallet', 'Setting up Sentinel identity...');

  // Dynamic import — blue-ai-connect provides wallet + VPN functions
  let sentinelMnemonic = opts.sentinelMnemonic;
  let sentinelAddress: string;

  const SDK_PATH = '../../Sentinel SDK/js-sdk';

  if (sentinelMnemonic) {
    const { createWallet } = await import(`${SDK_PATH}/chain/wallet.js`);
    const { account } = await createWallet(sentinelMnemonic);
    sentinelAddress = account.address;
  } else {
    const { generateWallet } = await import(`${SDK_PATH}/chain/wallet.js`);
    const result = await generateWallet();
    sentinelMnemonic = result.mnemonic;
    sentinelAddress = result.account.address;
    progress('wallet', `New wallet created: ${sentinelAddress}`);
    // IMPORTANT: Agent must save this mnemonic locally
    console.log(`[x402] SAVE THIS MNEMONIC — it controls your VPN sessions:\n${sentinelMnemonic}`);
  }

  // ─── Step 2: Register with our API ───
  progress('register', `Registering ${sentinelAddress}...`);

  const registration = await apiPost<RegisterResponse>(`${apiUrl}/api/register`, {
    sentinelAddr: sentinelAddress,
  });

  const agentId = registration.agentId;
  progress('register', `Registered as ${agentId}`);

  // ─── Step 3: Get pricing ───
  const pricing = await apiGet<PricingResponse>(`${apiUrl}/api/pricing`);

  // ─── Step 4: Pay ───
  let paymentTxHash: string;

  if (opts.payment.chain === 'base') {
    const contractAddress = process.env.X402_CONTRACT_ADDRESS || '';
    if (!contractAddress) {
      throw new Error('X402_CONTRACT_ADDRESS not set. Set it in env.');
    }

    progress('payment', `Paying for ${opts.payment.hours} hours on Base...`);

    const result = await payOnBase({
      walletKey: opts.payment.walletKey,
      agentId,
      hours: opts.payment.hours,
      contractAddress,
      onProgress: progress,
    });
    paymentTxHash = result.txHash;

  } else if (opts.payment.chain === 'solana') {
    const { payOnSolana } = await import('./payment/solana.js');
    const operatorAta = process.env.X402_OPERATOR_USDC_ATA || '';
    if (!operatorAta) {
      throw new Error('X402_OPERATOR_USDC_ATA not set. Set it in env.');
    }

    progress('payment', `Paying for ${opts.payment.hours} hours on Solana...`);

    const pricePerHour = Math.round(parseFloat(pricing.pricePerHourUsdc) * 1e6);
    const result = await payOnSolana({
      walletKey: opts.payment.walletKey,
      agentId,
      hours: opts.payment.hours,
      operatorUsdcAta: operatorAta,
      pricePerHourUsdc: pricePerHour,
      onProgress: progress,
    });
    paymentTxHash = result.txHash;

  } else {
    throw new Error(`Unsupported chain: '${opts.payment.chain}'. Use 'base' or 'solana'.`);
  }

  progress('payment', `Payment confirmed: ${paymentTxHash}`);

  // ─── Step 5: Poll until allocated ───
  progress('allocation', 'Waiting for Sentinel provisioning...');

  const allocation = await pollForAllocation(paymentTxHash, apiUrl, POLL_TIMEOUT_MS, progress);

  progress('allocation', 'Provisioned on Sentinel!');

  // ─── Step 6: Connect to VPN via blue-ai-connect ───
  progress('vpn', 'Connecting to VPN node...');

  try {
    const aiConnect = await import(`${SDK_PATH}/ai-path/connect.js`);

    const vpnResult = await aiConnect.connect({
      mnemonic: sentinelMnemonic,
      country: opts.country,
      onProgress: (stage: string, msg: string) => progress('vpn', `${stage}: ${msg}`),
    });

    progress('vpn', 'Connected!');

    return {
      connected: true,
      ip: vpnResult.vpnIp || 'unknown',
      country: vpnResult.country || opts.country || 'unknown',
      expiresAt: new Date(Date.now() + opts.payment.hours * 3600_000).toISOString(),
      protocol: vpnResult.serviceType || 'unknown',
      sessionId: String(vpnResult.sessionId || ''),
      agentId,
      sentinelAddress,
      paymentTxHash: paymentTxHash,
    };
  } catch (vpnErr) {
    // Payment succeeded, allocation succeeded, but VPN connection failed.
    // Agent can retry connection without paying again.
    const msg = vpnErr instanceof Error ? vpnErr.message : String(vpnErr);
    console.error(`[x402] VPN connection failed (payment is safe): ${msg}`);
    return {
      connected: false,
      ip: '',
      country: opts.country || '',
      expiresAt: new Date(Date.now() + opts.payment.hours * 3600_000).toISOString(),
      protocol: '',
      sessionId: '',
      agentId,
      sentinelAddress,
      paymentTxHash: paymentTxHash,
    };
  }
}

// ─── Disconnect ───

export async function disconnect(): Promise<{ disconnected: boolean }> {
  try {
    const SDK_PATH = '../../Sentinel SDK/js-sdk';
    const aiConnect = await import(`${SDK_PATH}/ai-path/connect.js`);
    await aiConnect.disconnect();
    return { disconnected: true };
  } catch {
    return { disconnected: false };
  }
}

// ─── Status ───

export async function status(): Promise<{ connected: boolean }> {
  try {
    const SDK_PATH = '../../Sentinel SDK/js-sdk';
    const aiConnect = await import(`${SDK_PATH}/ai-path/connect.js`);
    const s = await aiConnect.status();
    return { connected: !!s?.connected };
  } catch {
    return { connected: false };
  }
}

// ─── Pricing ───

export async function getPricing(apiUrl?: string): Promise<PricingResponse> {
  return apiGet<PricingResponse>(`${apiUrl || DEFAULT_API_URL}/api/pricing`);
}
