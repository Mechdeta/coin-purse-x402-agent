/**
 * Application Configuration Types
 *
 * Enforces integer base units (bigint) for all currency comparisons.
 * 1 USDC = 1,000,000 base units (6 decimals).
 */

export interface SpendingLimits {
  /** Maximum allowable spend for a single endpoint call, in integer base units (bigint) */
  readonly maxPerCallBaseUnits: bigint;
  /** Total allowable cumulative spend for the entire run, in integer base units (bigint) */
  readonly totalBudgetBaseUnits: bigint;
}

export interface SecurityAllowlists {
  /** Explicitly allowed CAIP-2 network identifiers (e.g., ["eip155:84532"]) */
  readonly networkAllowlist: readonly string[];
  /** Explicitly allowed token asset identifiers/addresses (normalized lowercase) */
  readonly assetAllowlist: readonly string[];
}

export interface AppConfig {
  readonly limits: SpendingLimits;
  readonly allowlists: SecurityAllowlists;
  readonly ledgerDbPath: string;
  readonly rpcUrl: string;
  readonly buyerPrivateKey?: string;
  readonly llmApiKey?: string;
  readonly llmModel?: string;
}
