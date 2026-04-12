export class X402Error extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'X402Error';
  }
}

export const ErrorCodes = {
  // Registration
  INVALID_SENTINEL_ADDRESS: 'INVALID_SENTINEL_ADDRESS',
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',

  // Payment
  INVALID_MEMO: 'INVALID_MEMO',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  DUPLICATE_PAYMENT: 'DUPLICATE_PAYMENT',
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  PAYMENT_NOT_FINALIZED: 'PAYMENT_NOT_FINALIZED',
  INVALID_HOURS: 'INVALID_HOURS',

  // Sentinel
  SENTINEL_TX_FAILED: 'SENTINEL_TX_FAILED',
  FEE_GRANT_FAILED: 'FEE_GRANT_FAILED',
  INSUFFICIENT_P2P: 'INSUFFICIENT_P2P',

  // Pool
  NO_AVAILABLE_SUBSCRIPTION: 'NO_AVAILABLE_SUBSCRIPTION',
  SUBSCRIPTION_FULL: 'SUBSCRIPTION_FULL',
  POOL_EXHAUSTED: 'POOL_EXHAUSTED',

  // General
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];
