import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadConfig,
  DEFAULT_BASE_SEPOLIA_NETWORK,
  DEFAULT_BASE_SEPOLIA_USDC,
  DEFAULT_MAX_PER_CALL_BASE_UNITS,
  DEFAULT_TOTAL_BUDGET_BASE_UNITS,
} from '../src/config/index.js';
import { Ledger } from '../src/ledger/index.js';
import {
  evaluateSpendingPolicy,
  parseBaseUnits,
  SpendingPolicyCoordinator,
} from '../src/policy/index.js';
import type { PaymentQuote } from '../src/policy/types.js';

describe('Phase 2 — Spending Policy & Integer Base-Unit Arithmetic', () => {
  const defaultConfig = loadConfig({});
  const validBaseQuote: PaymentQuote = {
    amountBaseUnits: '50000', // 0.05 USDC
    network: DEFAULT_BASE_SEPOLIA_NETWORK,
    asset: DEFAULT_BASE_SEPOLIA_USDC,
    seller: 'honest-seller',
    endpoint: '/research',
  };

  // 1. allows valid $0.05 quote
  it('1. allows valid $0.05 (50,000 base units) quote', () => {
    const decision = evaluateSpendingPolicy(validBaseQuote, 0n, defaultConfig);
    expect(decision.allowed).toBe(true);
    expect(decision.reasonCode).toBe('within_spending_policy');
    expect(decision.parsedAmountBaseUnits).toBe(50000n);
    expect(typeof decision.parsedAmountBaseUnits).toBe('bigint');
  });

  // 2. refuses amount above per-call limit (max = 500000n, quote = 500001n)
  it('2. refuses amount above per-call limit (e.g. 500,001 > 500,000)', () => {
    const quote: PaymentQuote = {
      ...validBaseQuote,
      amountBaseUnits: 500001n,
    };
    const decision = evaluateSpendingPolicy(quote, 0n, defaultConfig);
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('per_call_limit_exceeded');
    expect(decision.reasonMessage).toContain('exceeds per-call ceiling');
  });

  // 3. refuses quote that would exceed total budget (budget = 5000000n, spent = 4800000n, quote = 200001n)
  it('3. refuses quote that would exceed total budget (spent 4,800,000 + quote 200,001 > 5,000,000)', () => {
    const quote: PaymentQuote = {
      ...validBaseQuote,
      amountBaseUnits: 200001n,
    };
    const currentSpend = 4800000n;
    const decision = evaluateSpendingPolicy(quote, currentSpend, defaultConfig);
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('total_budget_exceeded');
    expect(decision.reasonMessage).toContain('exceeds total run budget');
  });

  // 4. allows quote exactly at per-call limit
  it('4. allows quote exactly at per-call limit (500,000 == 500,000)', () => {
    const quote: PaymentQuote = {
      ...validBaseQuote,
      amountBaseUnits: 500000n,
    };
    const decision = evaluateSpendingPolicy(quote, 0n, defaultConfig);
    expect(decision.allowed).toBe(true);
    expect(decision.reasonCode).toBe('within_spending_policy');
    expect(decision.parsedAmountBaseUnits).toBe(500000n);
  });

  // 5. allows quote that brings total exactly to budget
  it('5. allows quote that brings total cumulative spend exactly to total budget', () => {
    const quote: PaymentQuote = {
      ...validBaseQuote,
      amountBaseUnits: 200000n,
    };
    const currentSpend = 4800000n; // 4,800,000 + 200,000 = 5,000,000
    const decision = evaluateSpendingPolicy(quote, currentSpend, defaultConfig);
    expect(decision.allowed).toBe(true);
    expect(decision.projectedSpendBaseUnits).toBe(5000000n);
  });

  // 6. refuses wrong network
  it('6. refuses wrong network (e.g. Ethereum mainnet eip155:1 or Base mainnet eip155:8453)', () => {
    const mainnetQuote: PaymentQuote = {
      ...validBaseQuote,
      network: 'eip155:1',
    };
    const decision1 = evaluateSpendingPolicy(mainnetQuote, 0n, defaultConfig);
    expect(decision1.allowed).toBe(false);
    expect(decision1.reasonCode).toBe('network_not_allowed');

    const baseMainnetQuote: PaymentQuote = {
      ...validBaseQuote,
      network: 'eip155:8453',
    };
    const decision2 = evaluateSpendingPolicy(baseMainnetQuote, 0n, defaultConfig);
    expect(decision2.allowed).toBe(false);
    expect(decision2.reasonCode).toBe('network_not_allowed');
  });

  // 7. refuses wrong asset
  it('7. refuses wrong asset (e.g. unknown token or mainnet USDC)', () => {
    const wrongAssetQuote: PaymentQuote = {
      ...validBaseQuote,
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base Mainnet USDC
    };
    const decision = evaluateSpendingPolicy(wrongAssetQuote, 0n, defaultConfig);
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('asset_not_allowed');
  });

  // 8. refuses negative amount
  it('8. refuses negative amount (-500n or "-500")', () => {
    const negQuote1: PaymentQuote = {
      ...validBaseQuote,
      amountBaseUnits: -500n,
    };
    const decision1 = evaluateSpendingPolicy(negQuote1, 0n, defaultConfig);
    expect(decision1.allowed).toBe(false);
    expect(decision1.reasonCode).toBe('invalid_amount');

    const negQuote2: PaymentQuote = {
      ...validBaseQuote,
      amountBaseUnits: '-50000',
    };
    const decision2 = evaluateSpendingPolicy(negQuote2, 0n, defaultConfig);
    expect(decision2.allowed).toBe(false);
    expect(decision2.reasonCode).toBe('invalid_amount');
  });

  // 9. refuses decimal amount
  it('9. refuses decimal amount ("0.05" or "1.50")', () => {
    const decimalQuote: PaymentQuote = {
      ...validBaseQuote,
      amountBaseUnits: '0.05',
    };
    const decision = evaluateSpendingPolicy(decimalQuote, 0n, defaultConfig);
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('invalid_amount');
    expect(decision.reasonMessage).toContain('Malformed or non-integer');
  });

  // 10. refuses malformed amount
  it('10. refuses malformed amount ("500000n", "1e6", "", null, undefined, "abc")', () => {
    const malformed = ['500000n', '1e6', '', '   ', 'abc', null, undefined, {}];
    for (const val of malformed) {
      const quote: PaymentQuote = {
        ...validBaseQuote,
        amountBaseUnits: val,
      };
      const decision = evaluateSpendingPolicy(quote, 0n, defaultConfig);
      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe('invalid_amount');
    }
  });

  // 11. verifies all monetary comparisons use bigint
  it('11. verifies all monetary comparisons strictly reject JS number and enforce bigint', () => {
    // Number type should be rejected outright
    const numberQuote: PaymentQuote = {
      ...validBaseQuote,
      amountBaseUnits: 50000 as unknown,
    };
    const decision = evaluateSpendingPolicy(numberQuote, 0n, defaultConfig);
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('invalid_amount');
    expect(decision.reasonMessage).toContain('must not use JavaScript number');

    // ParseBaseUnits returns strictly bigint
    const parsed = parseBaseUnits('500000');
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(typeof parsed.value).toBe('bigint');
      expect(parsed.value).toBe(500000n);
    }
  });

  // 12. verifies tool/model input cannot modify spending limits
  it('12. verifies tool/model input cannot modify spending limits', () => {
    // Attempting to pass tool-injected limits in quote has zero effect on evaluateSpendingPolicy
    const adversarialQuote = {
      ...validBaseQuote,
      amountBaseUnits: '4990000', // $4.99 USDC
      // Adversarial attempt to smuggle new limits
      maxPerCall: '5000000',
      budget: '10000000',
      spendingLimit: '10000000',
    };

    // Policy uses the immutable defaultConfig
    const decision = evaluateSpendingPolicy(adversarialQuote as unknown as PaymentQuote, 0n, defaultConfig);
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('per_call_limit_exceeded');

    // Confirm defaultConfig cannot be mutated
    expect(() => {
      (defaultConfig.limits as any).maxPerCallBaseUnits = 99999999n;
    }).toThrow();
  });

  // 13. verifies cumulative spend is read from durable ledger rather than in-memory counter
  it('13. verifies cumulative spend is read from the durable SQLite ledger rather than in-memory counter', () => {
    const ledger = new Ledger(':memory:');
    const coordinator = new SpendingPolicyCoordinator(ledger, defaultConfig);

    // Initial spend is 0
    expect(ledger.getCumulativeSpendBaseUnits()).toBe(0n);

    // Directly insert a paid record into SQLite
    ledger.recordDecision({
      timestamp: new Date().toISOString(),
      seller: 'other-process',
      endpoint: '/data',
      decision: 'paid',
      amountBaseUnits: '4800000',
      reason: 'prior run payment',
    });

    // The coordinator's evaluation immediately sees the 4,800,000 spend from SQLite
    const quote: PaymentQuote = {
      ...validBaseQuote,
      amountBaseUnits: '300000', // 4,800,000 + 300,000 = 5,100,000 > 5,000,000
    };
    const decision = coordinator.evaluate(quote);
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('total_budget_exceeded');
    expect(decision.currentSpendBaseUnits).toBe(4800000n);

    ledger.close();
  });

  // 14. Test that a refused payment does NOT increase cumulative spend
  it('14. verifies a refused payment does NOT increase cumulative spend but is recorded in the ledger', () => {
    const ledger = new Ledger(':memory:');
    const coordinator = new SpendingPolicyCoordinator(ledger, defaultConfig);

    const excessiveQuote: PaymentQuote = {
      ...validBaseQuote,
      seller: 'rogue-seller',
      amountBaseUnits: '4990000', // $4.99 exceeds $0.50 per-call
    };

    const decision = coordinator.evaluate(excessiveQuote);
    expect(decision.allowed).toBe(false);

    // Cumulative spend remains exactly 0
    expect(ledger.getCumulativeSpendBaseUnits()).toBe(0n);

    // Refusal decision is durably logged
    const decisions = ledger.getAllDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe('refused');
    expect(decisions[0].seller).toBe('rogue-seller');
    expect(decisions[0].reason).toContain('per_call_limit_exceeded');

    ledger.close();
  });

  // 15. Test that an allowed decision itself does not falsely increase cumulative spend before payment actually occurs
  it('15. verifies that an allowed decision does not increase cumulative spend until settlement commit', () => {
    const ledger = new Ledger(':memory:');
    const coordinator = new SpendingPolicyCoordinator(ledger, defaultConfig);

    // Reserve an allowed payment
    const reservation = coordinator.reserve(validBaseQuote);
    expect(reservation.decision.allowed).toBe(true);

    // In-flight reservation is held
    expect(coordinator.getInFlightReservationBaseUnits()).toBe(50000n);

    // But durable cumulative spend is STILL 0 until settled!
    expect(ledger.getCumulativeSpendBaseUnits()).toBe(0n);

    // If rollback is called (e.g. network failure or user abort before signing)
    reservation.rollback();
    expect(coordinator.getInFlightReservationBaseUnits()).toBe(0n);
    expect(ledger.getCumulativeSpendBaseUnits()).toBe(0n);

    // Test successful settlement flow
    const reservation2 = coordinator.reserve(validBaseQuote);
    expect(ledger.getCumulativeSpendBaseUnits()).toBe(0n);

    // Commit payment after tx settled
    reservation2.commit('0xtesttxhash123');
    expect(coordinator.getInFlightReservationBaseUnits()).toBe(0n);
    expect(ledger.getCumulativeSpendBaseUnits()).toBe(50000n);

    const decisions = ledger.getAllDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe('paid');
    expect(decisions[0].txHash).toBe('0xtesttxhash123');

    ledger.close();
  });

  // 16. Atomicity / Race Safety: concurrent reservations cannot exceed total budget
  it('16. prevents concurrent in-flight requests from exceeding total budget (race safety)', () => {
    const ledger = new Ledger(':memory:');
    const customConfig = loadConfig({
      TOTAL_BUDGET_BASE_UNITS: '1000000', // $1.00 budget
      MAX_PER_CALL_BASE_UNITS: '500000',  // $0.50 per call
    });
    const coordinator = new SpendingPolicyCoordinator(ledger, customConfig);

    const call1Quote: PaymentQuote = { ...validBaseQuote, amountBaseUnits: '500000' };
    const call2Quote: PaymentQuote = { ...validBaseQuote, amountBaseUnits: '500000' };
    const call3Quote: PaymentQuote = { ...validBaseQuote, amountBaseUnits: '500000' };

    // Call 1 reserves $0.50
    const res1 = coordinator.reserve(call1Quote);
    expect(res1.decision.allowed).toBe(true);

    // Call 2 reserves $0.50 (bringing in-flight reserved to $1.00 total)
    const res2 = coordinator.reserve(call2Quote);
    expect(res2.decision.allowed).toBe(true);

    // Call 3 attempts to reserve $0.50 concurrently while calls 1 & 2 are in-flight -> REFUSED
    const res3 = coordinator.reserve(call3Quote);
    expect(res3.decision.allowed).toBe(false);
    expect(res3.decision.reasonCode).toBe('total_budget_exceeded');

    // Release Call 1
    res1.rollback();

    // Now Call 3 can be reserved!
    const res3Retry = coordinator.reserve(call3Quote);
    expect(res3Retry.decision.allowed).toBe(true);

    ledger.close();
  });
});
