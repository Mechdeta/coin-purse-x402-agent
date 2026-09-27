/**
 * Durable Ledger Types
 *
 * All amounts are recorded as strings representing exact integer base units,
 * preventing any JSON serialization loss or floating-point rounding errors.
 */

export type DecisionType = 'paid' | 'refused';

export interface PaymentDecisionRecord {
  readonly id?: number;
  readonly timestamp: string;
  readonly seller: string;
  readonly endpoint: string;
  readonly decision: DecisionType;
  /** Amount in integer base units, serialized as string (e.g., "50000") */
  readonly amountBaseUnits: string;
  readonly network?: string;
  readonly asset?: string;
  readonly reason: string;
  readonly txHash?: string;
  /** Serialized raw payment requirements / quote for complete auditability */
  readonly paymentRequirements?: string;
}

export interface LedgerSummary {
  /** Cumulative spend of all 'paid' records in integer base units (bigint) */
  readonly cumulativeSpendBaseUnits: bigint;
  readonly totalDecisions: number;
  readonly totalPaid: number;
  readonly totalRefused: number;
}
