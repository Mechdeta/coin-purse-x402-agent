/**
 * Spending Policy Types
 *
 * Enforces pure deterministic validation rules before any payment signing can occur.
 */

export interface PaymentQuote {
  /** Quoted payment amount in integer base units (string or bigint; numbers are strictly forbidden) */
  readonly amountBaseUnits: unknown;
  /** CAIP-2 network identifier (e.g., 'eip155:84532') */
  readonly network: string;
  /** Asset address or identifier (e.g., Base Sepolia USDC contract address) */
  readonly asset: string;
  /** Optional seller identifier for ledger auditing */
  readonly seller?: string;
  /** Optional endpoint for ledger auditing */
  readonly endpoint?: string;
  /** Optional raw payment requirements object or string for ledger auditing */
  readonly paymentRequirements?: string;
}

export type PolicyReasonCode =
  | 'network_not_allowed'
  | 'asset_not_allowed'
  | 'invalid_amount'
  | 'per_call_limit_exceeded'
  | 'total_budget_exceeded'
  | 'within_spending_policy';

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly reasonCode: PolicyReasonCode;
  readonly reasonMessage: string;
  /** The parsed amount in bigint if valid */
  readonly parsedAmountBaseUnits?: bigint;
  /** The durable cumulative spend at the moment of evaluation */
  readonly currentSpendBaseUnits: bigint;
  /** The projected spend (currentSpend + parsedAmount) if allowed */
  readonly projectedSpendBaseUnits?: bigint;
}
