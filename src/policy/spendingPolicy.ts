import type { AppConfig } from '../config/types.js';
import type { Ledger } from '../ledger/ledger.js';
import type { PaymentQuote, PolicyDecision, PolicyReasonCode } from './types.js';

/**
 * Strictly parses and validates an amount into positive integer base units (bigint).
 * Forbids JavaScript `number` type, floating point, decimals, negatives, or malformed strings.
 */
export function parseBaseUnits(amount: unknown): { success: true; value: bigint } | { success: false; error: string } {
  // Reject typeof 'number' completely to prevent floating point imprecision
  if (typeof amount === 'number') {
    return {
      success: false,
      error: 'Monetary amounts must not use JavaScript number/floating-point; provide integer string or bigint',
    };
  }

  if (typeof amount === 'bigint') {
    if (amount <= 0n) {
      return { success: false, error: 'Amount must be greater than 0' };
    }
    return { success: true, value: amount };
  }

  if (typeof amount === 'string') {
    const trimmed = amount.trim();
    // Strictly match positive integer digits (no decimal point, no exponent, no sign, no trailing letters)
    if (!/^[1-9]\d*$/.test(trimmed)) {
      return {
        success: false,
        error: `Malformed or non-integer base unit amount: "${amount}"`,
      };
    }
    try {
      const val = BigInt(trimmed);
      return { success: true, value: val };
    } catch {
      return { success: false, error: `Failed to parse bigint from string "${amount}"` };
    }
  }

  return {
    success: false,
    error: `Invalid amount type: ${typeof amount}. Expected integer string or bigint`,
  };
}

/**
 * Pure deterministic evaluation of a payment quote against trusted spending limits.
 *
 * Enforces the exact 5-step verification order before payment signing:
 * 1. Network allowlist
 * 2. Asset allowlist
 * 3. Amount validity (bigint, no floating point, positive)
 * 4. Per-call ceiling (quotedAmount <= maxPerCallBaseUnits)
 * 5. Total budget (currentSpend + quotedAmount <= totalBudgetBaseUnits)
 */
export function evaluateSpendingPolicy(
  quote: PaymentQuote,
  currentSpendBaseUnits: bigint,
  config: AppConfig,
  reservedSpendBaseUnits: bigint = 0n
): PolicyDecision {
  // 1. Network allowlist check
  const isNetworkAllowed = config.allowlists.networkAllowlist.includes(quote.network);
  if (!isNetworkAllowed) {
    return {
      allowed: false,
      reasonCode: 'network_not_allowed',
      reasonMessage: `Network "${quote.network}" is not in the approved allowlist [${config.allowlists.networkAllowlist.join(', ')}]`,
      currentSpendBaseUnits,
    };
  }

  // 2. Asset allowlist check (case-insensitive normalized address)
  const normalizedAsset = quote.asset.toLowerCase();
  const isAssetAllowed = config.allowlists.assetAllowlist.includes(normalizedAsset);
  if (!isAssetAllowed) {
    return {
      allowed: false,
      reasonCode: 'asset_not_allowed',
      reasonMessage: `Asset "${quote.asset}" is not in the approved allowlist [${config.allowlists.assetAllowlist.join(', ')}]`,
      currentSpendBaseUnits,
    };
  }

  // 3. Amount validity check
  const parsed = parseBaseUnits(quote.amountBaseUnits);
  if (!parsed.success) {
    return {
      allowed: false,
      reasonCode: 'invalid_amount',
      reasonMessage: parsed.error,
      currentSpendBaseUnits,
    };
  }
  const amountBaseUnits = parsed.value;

  // 4. Per-call ceiling check
  if (amountBaseUnits > config.limits.maxPerCallBaseUnits) {
    return {
      allowed: false,
      reasonCode: 'per_call_limit_exceeded',
      reasonMessage: `Quoted amount (${amountBaseUnits.toString()} base units) exceeds per-call ceiling of ${config.limits.maxPerCallBaseUnits.toString()} base units`,
      parsedAmountBaseUnits: amountBaseUnits,
      currentSpendBaseUnits,
    };
  }

  // 5. Total budget check (including any active in-flight reservations)
  const effectiveCurrentSpend = currentSpendBaseUnits + reservedSpendBaseUnits;
  const projectedSpend = effectiveCurrentSpend + amountBaseUnits;
  if (projectedSpend > config.limits.totalBudgetBaseUnits) {
    return {
      allowed: false,
      reasonCode: 'total_budget_exceeded',
      reasonMessage: `Projected cumulative spend (${projectedSpend.toString()} base units) exceeds total run budget of ${config.limits.totalBudgetBaseUnits.toString()} base units (current spent: ${currentSpendBaseUnits.toString()}, in-flight reserved: ${reservedSpendBaseUnits.toString()})`,
      parsedAmountBaseUnits: amountBaseUnits,
      currentSpendBaseUnits,
      projectedSpendBaseUnits: projectedSpend,
    };
  }

  // All checks pass
  return {
    allowed: true,
    reasonCode: 'within_spending_policy',
    reasonMessage: 'Quoted payment satisfies all spending policies and allowlists',
    parsedAmountBaseUnits: amountBaseUnits,
    currentSpendBaseUnits,
    projectedSpendBaseUnits: projectedSpend,
  };
}

export interface ReservationReceipt {
  readonly decision: PolicyDecision;
  /** Commits the payment after successful settlement, writing a 'paid' record to the durable ledger */
  readonly commit: (txHash?: string) => void;
  /** Releases the in-flight reservation without writing a 'paid' record */
  readonly rollback: () => void;
}

/**
 * Coordinates spending policy decisions with the durable SQLite ledger.
 *
 * Features:
 * - Reads durable cumulative spend directly from SQLite outside process memory.
 * - Tracks in-flight reservations to prevent concurrent double-spending races.
 * - Automatically records all REFUSALS immediately into the durable ledger.
 * - Ensures ALLOW decisions do NOT increment durable cumulative spend until explicit settlement commit.
 */
export class SpendingPolicyCoordinator {
  private activeReservationsBaseUnits = 0n;

  constructor(
    private readonly ledger: Ledger,
    private readonly config: AppConfig
  ) {}

  /**
   * Evaluates a payment quote against the durable ledger and current spending limits.
   * If refused, the refusal is immediately recorded in the durable SQLite ledger.
   * If allowed, does NOT alter durable cumulative spend.
   */
  public evaluate(quote: PaymentQuote): PolicyDecision {
    const currentSpend = this.ledger.getCumulativeSpendBaseUnits();
    const decision = evaluateSpendingPolicy(
      quote,
      currentSpend,
      this.config,
      this.activeReservationsBaseUnits
    );

    if (!decision.allowed) {
      // Record refusal in durable ledger
      this.ledger.recordDecision({
        timestamp: new Date().toISOString(),
        seller: quote.seller ?? 'unknown',
        endpoint: quote.endpoint ?? 'unknown',
        decision: 'refused',
        amountBaseUnits: decision.parsedAmountBaseUnits?.toString() ?? String(quote.amountBaseUnits ?? '0'),
        network: quote.network,
        asset: quote.asset,
        reason: `${decision.reasonCode}: ${decision.reasonMessage}`,
        paymentRequirements: quote.paymentRequirements,
      });
    }

    return decision;
  }

  /**
   * Atomically evaluates and holds a budget reservation for an allowed quote.
   * Guarantees that concurrent requests cannot exceed total budget.
   */
  public reserve(quote: PaymentQuote): ReservationReceipt {
    const decision = this.evaluate(quote);

    if (!decision.allowed || !decision.parsedAmountBaseUnits) {
      return {
        decision,
        commit: () => {},
        rollback: () => {},
      };
    }

    const reservedAmount = decision.parsedAmountBaseUnits;
    this.activeReservationsBaseUnits += reservedAmount;
    let released = false;

    return {
      decision,
      commit: (txHash?: string) => {
        if (released) return;
        this.activeReservationsBaseUnits -= reservedAmount;
        released = true;

        // Record successful settled payment into durable SQLite ledger
        this.ledger.recordDecision({
          timestamp: new Date().toISOString(),
          seller: quote.seller ?? 'unknown',
          endpoint: quote.endpoint ?? 'unknown',
          decision: 'paid',
          amountBaseUnits: reservedAmount.toString(),
          network: quote.network,
          asset: quote.asset,
          reason: decision.reasonMessage,
          txHash,
          paymentRequirements: quote.paymentRequirements,
        });
      },
      rollback: () => {
        if (released) return;
        this.activeReservationsBaseUnits -= reservedAmount;
        released = true;
      },
    };
  }

  public getInFlightReservationBaseUnits(): bigint {
    return this.activeReservationsBaseUnits;
  }
}
