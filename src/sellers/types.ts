/**
 * Seller Types and x402 Payment Requirement Definitions
 *
 * Defines the standard HTTP 402 challenge response shape.
 * All amounts are strictly stringified integer base units.
 */

export interface X402PaymentRequirement {
  /** Payment scheme (e.g. 'exact') */
  readonly scheme: string;
  /** CAIP-2 network identifier (e.g. 'eip155:84532') */
  readonly network: string;
  /** ERC20 token address (Base Sepolia test USDC) */
  readonly asset: string;
  /** Price in integer base units (stringified bigint, e.g. '50000') */
  readonly amount: string;
  /** Seller recipient wallet address (deterministic test address) */
  readonly payTo: string;
  /** Optional timeout window for payment validity */
  readonly maxTimeoutSeconds?: number;
  /** Target endpoint resource URI */
  readonly resource?: string;
  /** Human-readable description of goods/services */
  readonly description?: string;
}

export interface X402ChallengeResponse {
  readonly x402Version: number;
  readonly error: string;
  readonly accepts: readonly X402PaymentRequirement[];
}

export interface SellerServer {
  readonly port: number;
  readonly host: string;
  readonly url: string;
  readonly close: () => Promise<void>;
}

export interface SellerOptions {
  readonly port?: number;
  readonly host?: string;
}
