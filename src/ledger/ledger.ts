import { DatabaseSync } from 'node:sqlite';
import { initDatabase } from './db.js';
import type { PaymentDecisionRecord, LedgerSummary } from './types.js';

interface DbRow {
  id: number;
  timestamp: string;
  seller: string;
  endpoint: string;
  decision: 'paid' | 'refused';
  amount_base_units: string;
  network: string | null;
  asset: string | null;
  reason: string;
  tx_hash: string | null;
  payment_requirements: string | null;
}

/**
 * Durable Ledger for tracking all payment decisions and cumulative spend outside process memory.
 */
export class Ledger {
  private db: DatabaseSync;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = initDatabase(dbPath);
  }

  /**
   * Record a payment decision (paid or refused).
   * Persists immediately to SQLite.
   */
  public recordDecision(record: PaymentDecisionRecord): number {
    const stmt = this.db.prepare(`
      INSERT INTO payment_decisions (
        timestamp, seller, endpoint, decision, amount_base_units,
        network, asset, reason, tx_hash, payment_requirements
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      record.timestamp,
      record.seller,
      record.endpoint,
      record.decision,
      record.amountBaseUnits,
      record.network ?? null,
      record.asset ?? null,
      record.reason,
      record.txHash ?? null,
      record.paymentRequirements ?? null
    );

    return Number(result.lastInsertRowid);
  }

  /**
   * Calculates the cumulative spend of all settled/paid transactions in integer base units (bigint).
   * Reads directly from the durable database on demand so it never relies on transient memory.
   */
  public getCumulativeSpendBaseUnits(): bigint {
    const stmt = this.db.prepare(`
      SELECT amount_base_units FROM payment_decisions WHERE decision = 'paid'
    `);
    const rows = stmt.all() as unknown as { amount_base_units: string }[];

    let total = 0n;
    for (const row of rows) {
      total += BigInt(row.amount_base_units);
    }
    return total;
  }

  /**
   * Retrieve all recorded payment decisions in chronological order.
   */
  public getAllDecisions(): PaymentDecisionRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM payment_decisions ORDER BY id ASC
    `);
    const rows = stmt.all() as unknown as DbRow[];

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      seller: row.seller,
      endpoint: row.endpoint,
      decision: row.decision,
      amountBaseUnits: row.amount_base_units,
      network: row.network ?? undefined,
      asset: row.asset ?? undefined,
      reason: row.reason,
      txHash: row.tx_hash ?? undefined,
      paymentRequirements: row.payment_requirements ?? undefined,
    }));
  }

  /**
   * Get an aggregate summary of the ledger.
   */
  public getSummary(): LedgerSummary {
    const stmt = this.db.prepare(`
      SELECT 
        decision,
        amount_base_units
      FROM payment_decisions
    `);
    const rows = stmt.all() as unknown as { decision: string; amount_base_units: string }[];

    let cumulativeSpend = 0n;
    let totalPaid = 0;
    let totalRefused = 0;

    for (const row of rows) {
      if (row.decision === 'paid') {
        cumulativeSpend += BigInt(row.amount_base_units);
        totalPaid++;
      } else {
        totalRefused++;
      }
    }

    return {
      cumulativeSpendBaseUnits: cumulativeSpend,
      totalDecisions: rows.length,
      totalPaid,
      totalRefused,
    };
  }

  /**
   * Close the underlying SQLite database connection.
   */
  public close(): void {
    this.db.close();
  }
}
