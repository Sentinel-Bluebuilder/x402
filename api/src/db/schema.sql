CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT UNIQUE NOT NULL,
  sentinel_address TEXT UNIQUE NOT NULL,
  chain TEXT NOT NULL DEFAULT 'base',
  chain_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_hash TEXT UNIQUE NOT NULL,
  chain TEXT NOT NULL DEFAULT 'base',
  agent_id TEXT NOT NULL,
  sentinel_address TEXT,
  hours INTEGER NOT NULL,
  usdc_amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  sentinel_tx_hash TEXT,
  subscription_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subscription_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id TEXT UNIQUE NOT NULL,
  plan_id INTEGER NOT NULL,
  allocation_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS retry_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_retry_at TEXT NOT NULL,
  error TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  FOREIGN KEY (payment_id) REFERENCES payments(id)
);

CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_agent ON payments(agent_id);
CREATE INDEX IF NOT EXISTS idx_payments_sentinel ON payments(sentinel_address);
CREATE INDEX IF NOT EXISTS idx_agents_sentinel ON agents(sentinel_address);
CREATE INDEX IF NOT EXISTS idx_pool_status ON subscription_pool(status, allocation_count);
CREATE INDEX IF NOT EXISTS idx_retry_status ON retry_queue(status, next_retry_at);
