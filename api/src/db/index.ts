import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { Agent, Payment, PoolSubscription, RetryEntry } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function createDb(dbPath: string): Promise<Db> {
  const SQL = await initSqlJs();

  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let sqlite: SqlJsDatabase;
  if (existsSync(dbPath)) {
    const buffer = readFileSync(dbPath);
    sqlite = new SQL.Database(buffer);
  } else {
    sqlite = new SQL.Database();
  }

  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  sqlite.run(schema);

  const db = new Db(sqlite, dbPath);
  db.save();
  return db;
}

export class Db {
  constructor(
    private sqlite: SqlJsDatabase,
    private dbPath: string,
  ) {}

  // ─── Persistence ───

  save(): void {
    try {
      const data = this.sqlite.export();
      writeFileSync(this.dbPath, Buffer.from(data));
    } catch (err) {
      console.error('[x402] CRITICAL: Database save failed:', err);
      // Don't throw — in-memory state is still valid, next save may succeed
    }
  }

  private run(sql: string, params: unknown[] = []): void {
    this.sqlite.run(sql, params as any[]);
    this.save();
  }

  private get<T>(sql: string, params: unknown[] = []): T | undefined {
    const stmt = this.sqlite.prepare(sql);
    stmt.bind(params as any[]);
    if (!stmt.step()) { stmt.free(); return undefined; }
    const cols = stmt.getColumnNames();
    const vals = stmt.get();
    stmt.free();
    const row: Record<string, unknown> = {};
    cols.forEach((c: string, i: number) => { row[c] = vals[i]; });
    return row as T;
  }

  private all<T>(sql: string, params: unknown[] = []): T[] {
    const results: T[] = [];
    const stmt = this.sqlite.prepare(sql);
    stmt.bind(params as any[]);
    while (stmt.step()) {
      const cols = stmt.getColumnNames();
      const vals = stmt.get();
      const row: Record<string, unknown> = {};
      cols.forEach((c: string, i: number) => { row[c] = vals[i]; });
      results.push(row as T);
    }
    stmt.free();
    return results;
  }

  private scalar(sql: string, params: unknown[] = []): number {
    const stmt = this.sqlite.prepare(sql);
    stmt.bind(params as any[]);
    stmt.step();
    const val = stmt.get()[0] as number;
    stmt.free();
    return val;
  }

  // ─── Agents ───

  insertAgent(agentId: string, sentinelAddress: string, chain: string, chainAddress?: string): void {
    this.run(
      'INSERT INTO agents (agent_id, sentinel_address, chain, chain_address) VALUES (?, ?, ?, ?)',
      [agentId, sentinelAddress, chain, chainAddress ?? null],
    );
  }

  getAgentById(agentId: string): Agent | undefined {
    return this.get<Agent>('SELECT * FROM agents WHERE agent_id = ?', [agentId]);
  }

  getAgentBySentinel(sentinelAddress: string): Agent | undefined {
    return this.get<Agent>('SELECT * FROM agents WHERE sentinel_address = ?', [sentinelAddress]);
  }

  // ─── Payments ───

  insertPayment(txHash: string, chain: string, agentId: string, sentinelAddress: string | null, hours: number, usdcAmount: number): number {
    try {
      this.run(
        'INSERT INTO payments (tx_hash, chain, agent_id, sentinel_address, hours, usdc_amount) VALUES (?, ?, ?, ?, ?, ?)',
        [txHash, chain, agentId, sentinelAddress, hours, usdcAmount],
      );
      // Get the ID of the inserted row
      return this.scalar('SELECT id FROM payments WHERE tx_hash = ?', [txHash]);
    } catch (err) {
      // UNIQUE constraint violation = already exists (dedup race)
      const existing = this.getPaymentByTxHash(txHash);
      if (existing) return existing.id;
      throw err;
    }
  }

  getPaymentById(id: number): Payment | undefined {
    return this.get<Payment>('SELECT * FROM payments WHERE id = ?', [id]);
  }

  getPaymentByTxHash(txHash: string): Payment | undefined {
    return this.get<Payment>('SELECT * FROM payments WHERE tx_hash = ?', [txHash]);
  }

  getPaymentsByAgent(agentId: string, limit: number = 100): Payment[] {
    return this.all<Payment>('SELECT * FROM payments WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?', [agentId, limit]);
  }

  updatePaymentStatus(txHash: string, status: string, extra?: { sentinelTxHash?: string; subscriptionId?: string; error?: string }): void {
    const sets = ['status = ?', "updated_at = datetime('now')"];
    const params: unknown[] = [status];

    if (extra?.sentinelTxHash) { sets.push('sentinel_tx_hash = ?'); params.push(extra.sentinelTxHash); }
    if (extra?.subscriptionId) { sets.push('subscription_id = ?'); params.push(extra.subscriptionId); }
    if (extra?.error) { sets.push('error = ?'); params.push(extra.error); }

    params.push(txHash);
    this.run(`UPDATE payments SET ${sets.join(', ')} WHERE tx_hash = ?`, params);
  }

  countPaymentsByStatus(status: string): number {
    return this.scalar('SELECT COUNT(*) FROM payments WHERE status = ?', [status]);
  }

  // ─── Subscription Pool ───

  // Atomic: find available subscription AND increment count in one operation.
  // Prevents race condition where two payments grab the same slot.
  allocateSubscriptionSlot(planId: number): PoolSubscription | undefined {
    // Find the subscription with available slots
    const sub = this.get<PoolSubscription>(
      "SELECT * FROM subscription_pool WHERE plan_id = ? AND status = 'active' AND allocation_count < 8 ORDER BY allocation_count ASC LIMIT 1",
      [planId],
    );

    if (!sub) return undefined;

    // Immediately increment — sql.js is synchronous so no race between get and update
    this.run(
      "UPDATE subscription_pool SET allocation_count = allocation_count + 1, status = CASE WHEN allocation_count + 1 >= 8 THEN 'full' ELSE 'active' END WHERE subscription_id = ? AND allocation_count < 8",
      [sub.subscription_id],
    );

    return sub;
  }

  insertSubscription(subscriptionId: string, planId: number): void {
    this.run('INSERT INTO subscription_pool (subscription_id, plan_id) VALUES (?, ?)', [subscriptionId, planId]);
  }

  getPoolStats() {
    const total = this.scalar('SELECT COUNT(*) FROM subscription_pool');
    const active = this.scalar("SELECT COUNT(*) FROM subscription_pool WHERE status = 'active'");
    const full = this.scalar("SELECT COUNT(*) FROM subscription_pool WHERE status = 'full'");
    const slots = this.scalar("SELECT COALESCE(SUM(8 - allocation_count), 0) FROM subscription_pool WHERE status = 'active'");

    return { totalSubscriptions: total, activeSubscriptions: active, fullSubscriptions: full, availableSlots: slots };
  }

  // ─── Retry Queue ───

  insertRetry(paymentId: number, nextRetryAt: string, error?: string): void {
    this.run('INSERT INTO retry_queue (payment_id, next_retry_at, error) VALUES (?, ?, ?)', [paymentId, nextRetryAt, error ?? null]);
  }

  getPendingRetries(): RetryEntry[] {
    return this.all<RetryEntry>("SELECT * FROM retry_queue WHERE status = 'pending' AND next_retry_at <= datetime('now') ORDER BY next_retry_at ASC LIMIT 10");
  }

  updateRetry(id: number, status: string, nextRetryAt?: string, error?: string): void {
    if (nextRetryAt) {
      this.run('UPDATE retry_queue SET status = ?, attempt = attempt + 1, next_retry_at = ?, error = ? WHERE id = ?', [status, nextRetryAt, error ?? null, id]);
    } else {
      this.run('UPDATE retry_queue SET status = ?, attempt = attempt + 1, error = ? WHERE id = ?', [status, error ?? null, id]);
    }
  }

  countRetries(status: string): number {
    return this.scalar('SELECT COUNT(*) FROM retry_queue WHERE status = ?', [status]);
  }

  // ─── Lifecycle ───

  close(): void {
    this.save();
    this.sqlite.close();
  }
}
