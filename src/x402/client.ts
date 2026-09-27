import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { AppConfig } from '../config/types.js';
import type { Ledger } from '../ledger/ledger.js';
import { SpendingPolicyCoordinator } from '../policy/spendingPolicy.js';
import type { PaymentQuote } from '../policy/types.js';
import type { X402PaymentRequirement } from '../sellers/types.js';
import type { PaidFetchOptions, PaidFetchResult, X402ClientOptions, X402Signer } from './types.js';

/**
 * Disallowed options that model/tool callers must NEVER be able to inject
 */
const FORBIDDEN_TOOL_OPTIONS = [
  'maxPerCall',
  'maxPerCallBaseUnits',
  'budget',
  'totalBudget',
  'totalBudgetBaseUnits',
  'spendingLimit',
  'network',
  'asset',
  'privateKey',
  'signer',
];

/**
 * The Coin Purse x402 Paid Client.
 *
 * Enforces the strict, non-negotiable security boundary:
 * HTTP 402 Challenge
 *   -> Extract payment requirement
 *   -> Convert to PaymentQuote
 *   -> Evaluate Spending Policy (network, asset, amount, per-call ceiling, total budget)
 *   -> IF REFUSED: Durably log refusal, NEVER SIGN, NEVER PAY
 *   -> IF ALLOWED: Atomically hold reservation -> Wallet signs -> Submit payment -> Commit on success / Rollback on failure.
 */
export class X402PaidClient {
  private readonly config: AppConfig;
  private readonly ledger: Ledger;
  private readonly coordinator: SpendingPolicyCoordinator;
  private readonly signer?: X402Signer;
  private readonly x402HttpClient: x402HTTPClient;

  constructor(options: X402ClientOptions) {
    this.config = options.config;
    this.ledger = options.ledger;
    this.coordinator = new SpendingPolicyCoordinator(this.ledger, this.config);
    this.signer = options.signer;
    this.x402HttpClient = new x402HTTPClient(new x402Client());
  }

  /**
   * Fetches an HTTP resource, handling x402 payment requirements under strict spending policy rules.
   */
  public async fetch<T = unknown>(
    url: string | URL,
    options: PaidFetchOptions = {}
  ): Promise<PaidFetchResult<T>> {
    // 1. Tool argument independence: Reject any attempt to inject spending limits via options
    for (const key of Object.keys(options)) {
      if (FORBIDDEN_TOOL_OPTIONS.includes(key)) {
        throw new Error(
          `Security violation: "${key}" is not settable through tool arguments. Spending limits are immutable.`
        );
      }
    }

    const targetUrl = typeof url === 'string' ? new URL(url) : url;

    // 2. Initial request to endpoint
    const initialRes = await fetch(targetUrl, options);

    // If resource is free or doesn't require payment, return response directly
    if (initialRes.status !== 402) {
      const data = await this.parseResponseBody<T>(initialRes);
      return {
        success: initialRes.ok,
        status: initialRes.status,
        data,
      };
    }

    // 3. Status is 402 Payment Required: Parse the challenge
    const challengeBody = await initialRes.json().catch(() => null);
    const paymentRequired = this.x402HttpClient.getPaymentRequiredResponse(
      (h) => initialRes.headers.get(h),
      challengeBody
    );

    if (!paymentRequired?.accepts || paymentRequired.accepts.length === 0) {
      return {
        success: false,
        status: 402,
        error: 'Malformed 402 response: No payment requirements found in challenge',
      };
    }

    const requirement = paymentRequired.accepts[0] as unknown as X402PaymentRequirement;

    // Construct untrusted payment quote from seller challenge
    const quote: PaymentQuote = {
      amountBaseUnits: requirement.amount ?? (requirement as any).maxAmountRequired,
      network: requirement.network,
      asset: requirement.asset,
      seller: options.sellerName ?? targetUrl.hostname,
      endpoint: targetUrl.pathname,
      paymentRequirements: JSON.stringify(paymentRequired),
    };

    // 4. ATOMIC POLICY EVALUATION & BUDGET RESERVATION
    // Evaluates network allowlist, asset allowlist, integer base units, per-call ceiling, and cumulative budget.
    const reservation = this.coordinator.reserve(quote);

    // =========================================================================
    // CRITICAL SECURITY ASSERTION:
    // IF POLICY REFUSES, WE IMMEDIATELY EXIT.
    // THE SIGNER IS NEVER CALLED. PAYMENT IS NEVER SIGNED OR SENT.
    // =========================================================================
    if (!reservation.decision.allowed) {
      return {
        success: false,
        status: 402,
        decision: reservation.decision,
        error: `Payment refused by policy: [${reservation.decision.reasonCode}] ${reservation.decision.reasonMessage}`,
      };
    }

    // 5. Policy ALLOWED: Check signer availability
    if (!this.signer) {
      reservation.rollback();
      return {
        success: false,
        status: 402,
        decision: reservation.decision,
        error: 'Signer is not configured; cannot sign payment payload',
      };
    }

    // 6. SIGN PAYMENT (Occurs ONLY after policy ALLOW has been verified)
    let signedPayload: Record<string, unknown>;
    try {
      signedPayload = await this.signer.signPayment(requirement);
    } catch (signErr: any) {
      // Rollback reservation and record signing failure
      reservation.rollback();
      this.ledger.recordDecision({
        timestamp: new Date().toISOString(),
        seller: quote.seller ?? 'unknown',
        endpoint: quote.endpoint ?? 'unknown',
        decision: 'refused',
        amountBaseUnits: String(reservation.decision.parsedAmountBaseUnits ?? '0'),
        network: quote.network,
        asset: quote.asset,
        reason: `signing_failed: ${signErr.message}`,
        paymentRequirements: quote.paymentRequirements,
      });

      return {
        success: false,
        status: 402,
        decision: reservation.decision,
        error: `Payment signing failed: ${signErr.message}`,
      };
    }

    // 7. Format x402 payment header
    const paymentPayload = {
      x402Version: 1,
      scheme: requirement.scheme,
      network: requirement.network,
      payload: signedPayload,
    };
    const paymentHeaders = this.x402HttpClient.encodePaymentSignatureHeader(paymentPayload as any);

    // 8. Submit paid request to seller
    try {
      const paidRes = await fetch(targetUrl, {
        ...options,
        headers: {
          ...(options.headers || {}),
          ...paymentHeaders,
        },
      });

      if (paidRes.ok) {
        // Payment accepted and goods/research returned
        const data = await this.parseResponseBody<T>(paidRes);
        const txHash =
          paidRes.headers.get('x-payment-response') ||
          (typeof signedPayload.signature === 'string' ? signedPayload.signature : undefined);

        // COMMIT RESERVATION -> Durably records 'paid' in SQLite ledger
        reservation.commit(txHash);

        return {
          success: true,
          status: paidRes.status,
          data,
          decision: reservation.decision,
          txHash,
        };
      } else {
        // Seller rejected payment or returned an error
        reservation.rollback();
        const errBody = await paidRes.text().catch(() => '');

        this.ledger.recordDecision({
          timestamp: new Date().toISOString(),
          seller: quote.seller ?? 'unknown',
          endpoint: quote.endpoint ?? 'unknown',
          decision: 'refused',
          amountBaseUnits: String(reservation.decision.parsedAmountBaseUnits ?? '0'),
          network: quote.network,
          asset: quote.asset,
          reason: `seller_rejected_payment: status ${paidRes.status} - ${errBody}`,
          paymentRequirements: quote.paymentRequirements,
        });

        return {
          success: false,
          status: paidRes.status,
          decision: reservation.decision,
          error: `Seller rejected payment with HTTP status ${paidRes.status}`,
        };
      }
    } catch (networkErr: any) {
      // Network or connection failure: rollback reservation
      reservation.rollback();
      this.ledger.recordDecision({
        timestamp: new Date().toISOString(),
        seller: quote.seller ?? 'unknown',
        endpoint: quote.endpoint ?? 'unknown',
        decision: 'refused',
        amountBaseUnits: String(reservation.decision.parsedAmountBaseUnits ?? '0'),
        network: quote.network,
        asset: quote.asset,
        reason: `payment_submission_network_error: ${networkErr.message}`,
        paymentRequirements: quote.paymentRequirements,
      });

      return {
        success: false,
        status: 500,
        decision: reservation.decision,
        error: `Network error during payment submission: ${networkErr.message}`,
      };
    }
  }

  private async parseResponseBody<T>(res: Response): Promise<T | undefined> {
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return (await res.json().catch(() => undefined)) as T;
    }
    const text = await res.text().catch(() => undefined);
    return text as unknown as T;
  }
}

/**
 * Factory helper to create a paidFetch function from options.
 */
export function createPaidFetch(options: X402ClientOptions) {
  const client = new X402PaidClient(options);
  return <T = unknown>(url: string | URL, init?: PaidFetchOptions) => client.fetch<T>(url, init);
}
