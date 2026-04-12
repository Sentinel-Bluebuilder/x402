// ─── Agent ───

export interface Agent {
  id: number;
  agent_id: string;
  sentinel_address: string;
  chain: string;
  chain_address: string | null;
  created_at: string;
}

// ─── Payment ───

export type PaymentStatus = 'received' | 'verified' | 'allocated' | 'failed';

export interface Payment {
  id: number;
  tx_hash: string;
  chain: string;
  agent_id: string;
  sentinel_address: string | null;
  hours: number;
  usdc_amount: number;
  status: PaymentStatus;
  sentinel_tx_hash: string | null;
  subscription_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Subscription Pool ───

export type PoolStatus = 'active' | 'full' | 'expired';

export interface PoolSubscription {
  id: number;
  subscription_id: string;
  plan_id: number;
  allocation_count: number;
  status: PoolStatus;
  created_at: string;
}

// ─── Retry Queue ───

export type RetryStatus = 'pending' | 'processing' | 'succeeded' | 'exhausted';

export interface RetryEntry {
  id: number;
  payment_id: number;
  attempt: number;
  max_attempts: number;
  next_retry_at: string;
  error: string | null;
  status: RetryStatus;
}

// ─── API Request/Response ───

export interface RegisterRequest {
  sentinelAddr: string;
}

export interface RegisterResponse {
  agentId: string;
  sentinelAddr: string;
}

export interface PaymentStatusResponse {
  txHash: string;
  chain: string;
  agentId: string;
  hours: number;
  usdcAmount: number;
  status: PaymentStatus;
  sentinelTxHash: string | null;
  error: string | null;
  createdAt: string;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  uptime: number;
  pool: {
    totalSubscriptions: number;
    activeSubscriptions: number;
    fullSubscriptions: number;
    availableSlots: number;
  };
  pendingPayments: number;
  retryQueueSize: number;
}

export interface PricingResponse {
  pricePerHourUsdc: string;
  minHours: number;
  maxHours: number;
  chains: string[];
}
