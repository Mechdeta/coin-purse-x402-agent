import type { AppConfig } from '../config/types.js';
import type { Ledger } from '../ledger/ledger.js';
import type { PolicyDecision } from '../policy/types.js';
import type { X402PaymentRequirement } from '../sellers/types.js';

/**
 * Signer interface for x402 payment signing.
 * Strictly isolated so it is never accessible to the LLM or exposed to tool arguments.
 */
export interface X402Signer {
  /** The public wallet address of the payer (safe to log) */
  readonly getAddress: () => string;
  /**
   * Signs the payment requirement payload.
   * MUST only be called AFTER policy evaluation returns ALLOW.
   */
  readonly signPayment: (requirements: X402PaymentRequirement) => Promise<Record<string, unknown>>;
}

/**
 * Request options for paidFetch.
 * Deliberately excludes any spending limits or security configuration.
 */
export interface PaidFetchOptions extends RequestInit {
  /** Optional seller identifier for ledger record auditing */
  readonly sellerName?: string;
}

/**
 * Result returned by paidFetch
 */
export interface PaidFetchResult<T = unknown> {
  readonly success: boolean;
  readonly status: number;
  readonly data?: T;
  readonly decision?: PolicyDecision;
  readonly txHash?: string;
  readonly error?: string;
}

export interface X402ClientOptions {
  readonly config: AppConfig;
  readonly ledger: Ledger;
  readonly signer?: X402Signer;
}
