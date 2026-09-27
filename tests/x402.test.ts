import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  loadConfig,
  DEFAULT_BASE_SEPOLIA_NETWORK,
  DEFAULT_BASE_SEPOLIA_USDC,
} from '../src/config/index.js';
import { Ledger } from '../src/ledger/index.js';
import {
  startHonestSeller,
  startRogueSeller,
  type SellerServer,
} from '../src/sellers/index.js';
import {
  createMockSigner,
  createPaidFetch,
  createViemSigner,
  X402PaidClient,
} from '../src/x402/index.js';
import type { X402PaymentRequirement } from '../sellers/types.js';

describe('Phase 4 — x402 Payment Layer & Deterministic Spending Enforcement', () => {
  let honestServer: SellerServer;
  let rogueServer: SellerServer;
  const config = loadConfig({});

  beforeAll(async () => {
    honestServer = await startHonestSeller();
    rogueServer = await startRogueSeller();
  });

  afterAll(async () => {
    await Promise.all([honestServer.close(), rogueServer.close()]);
  });

  // 1 & 2: Honest seller flow (parsing, policy pass, signing, payment, commit)
  it('1 & 2. Honest seller quote is parsed correctly, passes policy, signs, and commits spend', async () => {
    const ledger = new Ledger(':memory:');
    let signCalls = 0;
    let signedRequirement: X402PaymentRequirement | undefined;

    const signer = createMockSigner('0x1111222233334444555566667777888899990000', (req) => {
      signCalls++;
      signedRequirement = req;
    });

    const paidFetch = createPaidFetch({ config, ledger, signer });

    const result = await paidFetch(`${honestServer.url}/research`, {
      sellerName: 'honest-stall',
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
    expect(result.data).toBeDefined();
    expect((result.data as any).status).toBe('success');

    // Quote parsed correctly
    expect(signedRequirement).toBeDefined();
    expect(signedRequirement?.network).toBe(DEFAULT_BASE_SEPOLIA_NETWORK);
    expect(signedRequirement?.asset.toLowerCase()).toBe(DEFAULT_BASE_SEPOLIA_USDC.toLowerCase());
    expect(signedRequirement?.amount).toBe('50000'); // 0.05 USDC

    // Signer was invoked exactly once for the approved payment
    expect(signCalls).toBe(1);

    // Policy was evaluated and ALLOWED
    expect(result.decision?.allowed).toBe(true);
    expect(result.decision?.reasonCode).toBe('within_spending_policy');

    // Durable cumulative spend is updated to 50,000 base units in SQLite
    expect(ledger.getCumulativeSpendBaseUnits()).toBe(50000n);

    // Ledger has exactly 1 'paid' record
    const decisions = ledger.getAllDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe('paid');
    expect(decisions[0].amountBaseUnits).toBe('50000');

    ledger.close();
  });

  // 3 & 4: Rogue excessive quote is refused BEFORE signing and invokes signer ZERO times
  it('3 & 4. Rogue excessive quote ($4.99) is refused by policy and invokes signer ZERO times', async () => {
    const ledger = new Ledger(':memory:');
    let signCalls = 0;

    const signer = createMockSigner('0x1111222233334444555566667777888899990000', () => {
      signCalls++;
    });

    const paidFetch = createPaidFetch({ config, ledger, signer });

    const result = await paidFetch(`${rogueServer.url}/research`, {
      sellerName: 'rogue-stall',
    });

    // Request failed with 402 refusal
    expect(result.success).toBe(false);
    expect(result.status).toBe(402);
    expect(result.error).toContain('per_call_limit_exceeded');

    // CRITICAL SECURITY PROOF: Signer was NEVER called
    expect(signCalls).toBe(0);

    // Cumulative spend remains 0n
    expect(ledger.getCumulativeSpendBaseUnits()).toBe(0n);

    // Durable refusal is recorded in SQLite
    const decisions = ledger.getAllDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe('refused');
    expect(decisions[0].amountBaseUnits).toBe('4990000');
    expect(decisions[0].reason).toContain('per_call_limit_exceeded');

    ledger.close();
  });

  // 5: Wrong network is refused with ZERO signing calls
  it('5. Wrong network challenge is refused with network_not_allowed and invokes signer ZERO times', async () => {
    const ledger = new Ledger(':memory:');
    let signCalls = 0;

    const signer = createMockSigner(undefined, () => {
      signCalls++;
    });

    const paidFetch = createPaidFetch({ config, ledger, signer });

    const result = await paidFetch(`${rogueServer.url}/wrong-network`);

    expect(result.success).toBe(false);
    expect(result.error).toContain('network_not_allowed');
    expect(signCalls).toBe(0);
    expect(ledger.getCumulativeSpendBaseUnits()).toBe(0n);

    const decisions = ledger.getAllDecisions();
    expect(decisions[0].decision).toBe('refused');
    expect(decisions[0].reason).toContain('network_not_allowed');

    ledger.close();
  });

  // 6: Wrong asset is refused with ZERO signing calls
  it('6. Wrong asset challenge is refused with asset_not_allowed and invokes signer ZERO times', async () => {
    const ledger = new Ledger(':memory:');
    let signCalls = 0;

    const signer = createMockSigner(undefined, () => {
      signCalls++;
    });

    const paidFetch = createPaidFetch({ config, ledger, signer });

    const result = await paidFetch(`${rogueServer.url}/wrong-asset`);

    expect(result.success).toBe(false);
    expect(result.error).toContain('asset_not_allowed');
    expect(signCalls).toBe(0);
    expect(ledger.getCumulativeSpendBaseUnits()).toBe(0n);

    const decisions = ledger.getAllDecisions();
    expect(decisions[0].decision).toBe('refused');
    expect(decisions[0].reason).toContain('asset_not_allowed');

    ledger.close();
  });

  // 7: Refused payment does NOT increase durable spend
  it('7. Refused payment attempts never alter durable cumulative spend in SQLite', async () => {
    const ledger = new Ledger(':memory:');
    const signer = createMockSigner();
    const paidFetch = createPaidFetch({ config, ledger, signer });

    // Initial spend: 0
    expect(ledger.getCumulativeSpendBaseUnits()).toBe(0n);

    // Trigger multiple rogue refusals
    await paidFetch(`${rogueServer.url}/research`);
    await paidFetch(`${rogueServer.url}/drain`);
    await paidFetch(`${rogueServer.url}/wrong-network`);
    await paidFetch(`${rogueServer.url}/wrong-asset`);

    // Durable spend must remain exactly 0
    expect(ledger.getCumulativeSpendBaseUnits()).toBe(0n);

    // All 4 refusals recorded
    const summary = ledger.getSummary();
    expect(summary.totalPaid).toBe(0);
    expect(summary.totalRefused).toBe(4);

    ledger.close();
  });

  // 8 & 9: Failed payment / rejection rolls back reservation without increasing spend
  it('8 & 9. Failed payment or seller error triggers rollback and does not count as spent', async () => {
    const ledger = new Ledger(':memory:');
    let signCalls = 0;

    // Signer that deliberately throws an error during signing
    const faultySigner: any = {
      getAddress: () => '0x0000000000000000000000000000000000000000',
      signPayment: async () => {
        signCalls++;
        throw new Error('Wallet user rejected transaction signature');
      },
    };

    const paidFetch = createPaidFetch({ config, ledger, signer: faultySigner });

    const result = await paidFetch(`${honestServer.url}/research`);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Payment signing failed');
    expect(signCalls).toBe(1);

    // Spend is rolled back and remains 0
    expect(ledger.getCumulativeSpendBaseUnits()).toBe(0n);

    // Failure recorded as refused/error in ledger
    const decisions = ledger.getAllDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe('refused');
    expect(decisions[0].reason).toContain('signing_failed');

    ledger.close();
  });

  // 10: Total budget is strictly enforced across multiple requests
  it('10. Total budget ceiling is strictly enforced across sequential calls', async () => {
    const ledger = new Ledger(':memory:');
    // Set tight budget: 100,000 base units ($0.10), max per call: 60,000 base units ($0.06)
    const tightConfig = loadConfig({
      TOTAL_BUDGET_BASE_UNITS: '100000',
      MAX_PER_CALL_BASE_UNITS: '60000',
    });

    let signCalls = 0;
    const signer = createMockSigner(undefined, () => {
      signCalls++;
    });

    const paidFetch = createPaidFetch({ config: tightConfig, ledger, signer });

    // Call 1: Honest seller costs 50,000 base units -> Allowed! (50,000 <= 100,000)
    const res1 = await paidFetch(`${honestServer.url}/research`);
    expect(res1.success).toBe(true);
    expect(signCalls).toBe(1);
    expect(ledger.getCumulativeSpendBaseUnits()).toBe(50000n);

    // Call 2: Honest seller costs 50,000 base units -> Allowed! (50,000 + 50,000 = 100,000 <= 100,000)
    const res2 = await paidFetch(`${honestServer.url}/research`);
    expect(res2.success).toBe(true);
    expect(signCalls).toBe(2);
    expect(ledger.getCumulativeSpendBaseUnits()).toBe(100000n);

    // Call 3: Honest seller costs 50,000 base units -> REFUSED! (100,000 + 50,000 > 100,000)
    const res3 = await paidFetch(`${honestServer.url}/research`);
    expect(res3.success).toBe(false);
    expect(res3.error).toContain('total_budget_exceeded');

    // Call 3 NEVER reached signer!
    expect(signCalls).toBe(2);

    // Spend remains exactly 100,000, not 150,000
    expect(ledger.getCumulativeSpendBaseUnits()).toBe(100000n);

    ledger.close();
  });

  // 11: Concurrent requests cannot exceed total budget
  it('11. Concurrent requests cannot overspend total budget', async () => {
    const ledger = new Ledger(':memory:');
    // Budget: 60,000 base units; honest call is 50,000
    const limitedConfig = loadConfig({
      TOTAL_BUDGET_BASE_UNITS: '60000',
      MAX_PER_CALL_BASE_UNITS: '50000',
    });

    let signCalls = 0;
    const signer = createMockSigner(undefined, () => {
      signCalls++;
    });

    const paidFetch = createPaidFetch({ config: limitedConfig, ledger, signer });

    // Launch two requests concurrently
    const [call1, call2] = await Promise.all([
      paidFetch(`${honestServer.url}/research`),
      paidFetch(`${honestServer.url}/research`),
    ]);

    // Exactly one should succeed, and one should fail due to budget exhaustion
    const successes = [call1, call2].filter((c) => c.success);
    const failures = [call1, call2].filter((c) => !c.success);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toContain('total_budget_exceeded');

    // Signer was only called once
    expect(signCalls).toBe(1);

    // Durable spend is capped at 50,000
    expect(ledger.getCumulativeSpendBaseUnits()).toBe(50000n);

    ledger.close();
  });

  // 12: Tool arguments cannot change or inject limits
  it('12. Throws an error if callers attempt to inject spending limits via options', async () => {
    const ledger = new Ledger(':memory:');
    const signer = createMockSigner();
    const paidFetch = createPaidFetch({ config, ledger, signer });

    await expect(
      paidFetch(`${honestServer.url}/research`, {
        maxPerCall: '100000000',
      } as any)
    ).rejects.toThrow(/Security violation: "maxPerCall" is not settable/);

    await expect(
      paidFetch(`${honestServer.url}/research`, {
        budget: '100000000',
      } as any)
    ).rejects.toThrow(/Security violation: "budget" is not settable/);

    await expect(
      paidFetch(`${honestServer.url}/research`, {
        spendingLimit: '100000000',
      } as any)
    ).rejects.toThrow(/Security violation: "spendingLimit" is not settable/);

    ledger.close();
  });

  // 13: Viem Signer initializes safely without leaking private keys
  it('13. Viem signer initializes cleanly from test hex key without exposing key', async () => {
    const testKey = '0x0000000000000000000000000000000000000000000000000000000000000001';
    const signer = createViemSigner(testKey);

    expect(signer.getAddress()).toBe('0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');

    const signed = await signer.signPayment({
      scheme: 'exact',
      network: 'eip155:84532',
      asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      amount: '50000',
      payTo: '0x1111111111111111111111111111111111111111',
    });

    expect(signed.signature).toBeDefined();
    expect(signed.payer).toBe(signer.getAddress());
    // Verify private key is not present in output object
    expect(JSON.stringify(signed)).not.toContain(testKey);
  });
});
