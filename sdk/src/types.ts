// ─── Connect Options ───

export interface PaymentOptions {
  chain: 'base' | 'solana';
  walletKey: string;
  hours: number;
}

export interface ConnectOptions {
  payment: PaymentOptions;
  country?: string;
  sentinelMnemonic?: string;
  apiUrl?: string;
  onProgress?: (step: string, detail: string) => void;
}

// ─── Connect Result ───

export interface ConnectResult {
  connected: boolean;
  ip: string;
  country: string;
  expiresAt: string;
  protocol: string;
  sessionId: string;
  agentId: string;
  sentinelAddress: string;
  sentinelMnemonic: string;  // SAVE THIS — controls your VPN sessions
  paymentTxHash: string;
}

// ─── API Responses ───

export interface RegisterResponse {
  agentId: string;
  sentinelAddr: string;
}

export interface PricingResponse {
  pricePerHourUsdc: string;
  minHours: number;
  maxHours: number;
  chains: string[];
}

export interface PaymentStatusResponse {
  txHash: string;
  chain: string;
  agentId: string;
  hours: number;
  usdcAmount: number;
  status: 'received' | 'verified' | 'allocated' | 'failed';
  sentinelTxHash: string | null;
  error: string | null;
  createdAt: string;
}
