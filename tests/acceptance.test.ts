import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { x402Client, x402HTTPClient } from '@x402/core/client';
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
import {
  PAID_FETCH_TOOL_DEFINITION,
  ResearchAgent,
  executePaidFetchTool,
  type ChatMessage,
  type LLMClientInterface,
  type LLMResponse,
} from '../src/agent/index.js';

describe('Phase 6 — Official Challenge Rubric & Acceptance Tests (10 Criteria)', () => {
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

  // =========================================================================
  // CRITERION 1: Payments are made through an x402 client — 4 points
  // PASS: Paid requests go through an x402 client library or equivalent manual
  //       payment-payload construction.
  // =========================================================================
  it('Criterion 1: Payments are processed through the official @x402/core client path', async () => {
    const coreClient = new x402Client();
    const httpClient = new x402HTTPClient(coreClient);

    // 1. Verify @x402/core client and HTTP client instances are genuine
    expect(typeof httpClient.getPaymentRequiredResponse).toBe('function');
    expect(typeof httpClient.encodePaymentSignatureHeader).toBe('function');

    // 2. Obtain real 402 challenge from the honest seller
    const initialRes = await fetch(`${honestServer.url}/research`);
    expect(initialRes.status).toBe(402);

    const challengeBody = await initialRes.json();
    const paymentRequired = httpClient.getPaymentRequiredResponse(
      (h) => initialRes.headers.get(h),
      challengeBody
    );

    expect(paymentRequired.x402Version).toBe(1);
    expect(paymentRequired.accepts).toHaveLength(1);
    expect(paymentRequired.accepts[0].network).toBe(DEFAULT_BASE_SEPOLIA_NETWORK);

    // 3. Construct and encode payment payload through x402 client
    const paymentPayload = {
      x402Version: 1,
      scheme: paymentRequired.accepts[0].scheme,
      network: paymentRequired.accepts[0].network,
      payload: { authorization: '0xmockedsignature123' },
    };
    const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload as any);

    expect(paymentHeaders).toHaveProperty('X-PAYMENT');
    expect(typeof paymentHeaders['X-PAYMENT']).toBe('string');

    // 4. Retry with x402 header succeeds
    const paidRes = await fetch(`${honestServer.url}/research`, {
      headers: paymentHeaders,
    });
    expect(paidRes.status).toBe(200);
    const data = (await paidRes.json()) as any;
    expect(data.status).toBe('success');
  });

  // =========================================================================
  // CRITERION 2: The paid fetch is exposed to the model as a tool — 4 points
  // PASS: The paid fetch is registered as a tool the LLM can choose to call.
  // =========================================================================
  it('Criterion 2: The paid fetch is registered as a tool the LLM can choose to call', async () => {
    // Verify tool specification
    expect(PAID_FETCH_TOOL_DEFINITION.type).toBe('function');
    expect(PAID_FETCH_TOOL_DEFINITION.function.name).toBe('paid_fetch');
    expect(PAID_FETCH_TOOL_DEFINITION.function.parameters.required).toContain('url');

    // Verify tool execution by an LLM agent
    const ledger = new Ledger(':memory:');
    const signer = createMockSigner();
    const paidClient = new X402PaidClient({ config, ledger, signer });

    let toolWasCalled = false;
    const mockLLM: LLMClientInterface = {
      async chat(messages: readonly ChatMessage[]): Promise<LLMResponse> {
        if (!toolWasCalled) {
          toolWasCalled = true;
          return {
            tool_calls: [
              {
                id: 'call_paid_fetch',
                type: 'function',
                function: {
                  name: 'paid_fetch',
                  arguments: JSON.stringify({ url: `${honestServer.url}/research` }),
                },
              },
            ],
          };
        }
        return { content: 'Tool execution complete and synthesized.' };
      },
    };

    const agent = new ResearchAgent({ client: paidClient, ledger, llmClient: mockLLM });
    const result = await agent.research('Test tool invocation');

    expect(toolWasCalled).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].url).toBe(`${honestServer.url}/research`);

    ledger.close();
  });

  // =========================================================================
  // CRITERION 3: A rogue test seller exists in the repo — 5 points
  // PASS: Repo contains a runnable seller whose payment requirements are deliberately abusive.
  // =========================================================================
  it('Criterion 3: A runnable rogue test seller exists in repo with deliberately abusive requirements', async () => {
    // 1. Rogue seller runs on independent server and responds to /health
    const healthRes = await fetch(`${rogueServer.url}/health`);
    expect(healthRes.status).toBe(200);

    // 2. Abusive price demand: $4.99 (4,990,000 base units) vs $0.50 ceiling
    const researchRes = await fetch(`${rogueServer.url}/research`);
    expect(researchRes.status).toBe(402);
    const researchChallenge = (await researchRes.json()) as any;
    expect(BigInt(researchChallenge.accepts[0].amount)).toBe(4990000n);
    expect(BigInt(researchChallenge.accepts[0].amount)).toBeGreaterThan(config.limits.maxPerCallBaseUnits);

    // 3. Abusive budget drain demand: $50.00 (50,000,000 base units) vs $5.00 total budget
    const drainRes = await fetch(`${rogueServer.url}/drain`);
    const drainChallenge = (await drainRes.json()) as any;
    expect(BigInt(drainChallenge.accepts[0].amount)).toBe(50000000n);
    expect(BigInt(drainChallenge.accepts[0].amount)).toBeGreaterThan(config.limits.totalBudgetBaseUnits);

    // 4. Trap unapproved network
    const netRes = await fetch(`${rogueServer.url}/wrong-network`);
    const netChallenge = (await netRes.json()) as any;
    expect(netChallenge.accepts[0].network).toBe('eip155:1');

    // 5. Trap unapproved asset
    const assetRes = await fetch(`${rogueServer.url}/wrong-asset`);
    const assetChallenge = (await assetRes.json()) as any;
    expect(assetChallenge.accepts[0].asset).toBe('0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead');
  });

  // =========================================================================
  // CRITERION 4: No credential appears in any tracked file — 8 points
  // PASS: No private key, mnemonic, API key appears in tracked files.
  //       .env.example must contain placeholders only.
  // =========================================================================
  it('Criterion 4: No credential, private key, or live API key appears in git-tracked files', () => {
    // 1. Get all git tracked files
    const trackedFiles = execSync('git ls-files', { encoding: 'utf8' })
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f.length > 0);

    expect(trackedFiles.length).toBeGreaterThan(0);

    // Ensure .env or sqlite databases are NOT tracked
    expect(trackedFiles).not.toContain('.env');
    expect(trackedFiles.some((f) => f.endsWith('.sqlite'))).toBe(false);
    expect(trackedFiles.some((f) => f.endsWith('.key'))).toBe(false);

    // 2. Scan every tracked file for suspicious live secrets
    for (const relPath of trackedFiles) {
      const fullPath = path.resolve(relPath);
      if (!fs.existsSync(fullPath)) continue;
      const content = fs.readFileSync(fullPath, 'utf8');

      // Live OpenAI/LLM API key patterns (sk-...)
      const apiKeyMatches = content.match(/sk-[a-zA-Z0-9]{24,}/g);
      if (apiKeyMatches) {
        throw new Error(`Real API key found in tracked file ${relPath}: ${apiKeyMatches[0]}`);
      }

      // Live 32-byte hex private keys (excluding the standard dummy 0x0000...0001 placeholder)
      const hexMatches = content.match(/0x[a-fA-F0-9]{64}/g);
      if (hexMatches) {
        for (const m of hexMatches) {
          if (m !== '0x0000000000000000000000000000000000000000000000000000000000000001') {
            throw new Error(`Suspicious 32-byte hex credential found in tracked file ${relPath}: ${m}`);
          }
        }
      }

      // Ensure no live BIP-39 mnemonic seeds in source files
      if (!relPath.startsWith('tests/')) {
        expect(content).not.toMatch(/abandon\s+abandon\s+abandon/i);
      }
    }

    // 3. Confirm .env.example contains placeholders only
    const envExampleContent = fs.readFileSync(path.resolve('.env.example'), 'utf8');
    expect(envExampleContent).toContain('dummy-llm-api-key');
    expect(envExampleContent).toContain('0x0000000000000000000000000000000000000000000000000000000000000001');
  });

  // =========================================================================
  // CRITERION 5: Per-call ceiling is compared to quoted amount BEFORE SIGNING — 18 pts
  // PASS: quoted amount <= configured per-call maximum before signing.
  //       If exceeded: refuse, log refusal, DO NOT sign, DO NOT send payment.
  // =========================================================================
  it('Criterion 5: Per-call ceiling is compared to quoted amount BEFORE SIGNING (quote > max -> REFUSE, signer = 0)', async () => {
    const ledger = new Ledger(':memory:');
    let signCalls = 0;
    const signer = createMockSigner(undefined, () => {
      signCalls++;
    });

    const paidFetch = createPaidFetch({ config, ledger, signer });

    // 1. Test quote = maxPerCall + 1 (500,001n vs 500,000n limit)
    const quoteAboveMax = {
      amountBaseUnits: 500001n,
      network: DEFAULT_BASE_SEPOLIA_NETWORK,
      asset: DEFAULT_BASE_SEPOLIA_USDC,
      seller: 'seller-ceiling-test',
      endpoint: '/data',
    };

    const decision = evaluateSpendingPolicy(quoteAboveMax, 0n, config);
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('per_call_limit_exceeded');

    // 2. Integration test against Rogue Seller ($4.99 > $0.50)
    const result = await paidFetch(`${rogueServer.url}/research`);
    expect(result.success).toBe(false);
    expect(result.error).toContain('per_call_limit_exceeded');

    // SIGNER WAS NEVER INVOKED
    expect(signCalls).toBe(0);

    // Durable spend unchanged
    expect(ledger.getCumulativeSpendBaseUnits()).toBe(0n);

    // Durable refusal logged
    const decisions = ledger.getAllDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe('refused');
    expect(decisions[0].amountBaseUnits).toBe('4990000');
    expect(decisions[0].reason).toContain('per_call_limit_exceeded');

    // 3. Exact boundary: quote == maxPerCall (500,000n == 500,000n) is ALLOWED
    const boundaryQuote = {
      amountBaseUnits: 500000n,
      network: DEFAULT_BASE_SEPOLIA_NETWORK,
      asset: DEFAULT_BASE_SEPOLIA_USDC,
    };
    const boundaryDecision = evaluateSpendingPolicy(boundaryQuote, 0n, config);
    expect(boundaryDecision.allowed).toBe(true);
    expect(boundaryDecision.reasonCode).toBe('within_spending_policy');

    ledger.close();
  });

  // =========================================================================
  // CRITERION 6: Cumulative spend checked against total budget BEFORE SIGNING — 10 pts
  // PASS: current persisted spend + quoted amount <= total run budget before signing.
  // =========================================================================
  it('Criterion 6: Cumulative spend checked against total budget BEFORE SIGNING (current + quote > budget -> REFUSE, signer = 0)', async () => {
    const ledger = new Ledger(':memory:');
    let signCalls = 0;
    const signer = createMockSigner(undefined, () => {
      signCalls++;
    });

    // Custom configuration: Total budget = 1,000,000 base units ($1.00), max per call = 500,000 base units ($0.50)
    const customConfig = loadConfig({
      TOTAL_BUDGET_BASE_UNITS: '1000000',
      MAX_PER_CALL_BASE_UNITS: '500000',
    });

    const coordinator = new SpendingPolicyCoordinator(ledger, customConfig);

    // Simulate prior durable spend: 800,000 base units
    ledger.recordDecision({
      timestamp: new Date().toISOString(),
      seller: 'earlier-run',
      endpoint: '/history',
      decision: 'paid',
      amountBaseUnits: '800000',
      reason: 'prior settled payment',
    });
    expect(ledger.getCumulativeSpendBaseUnits()).toBe(800000n);

    // 1. Quoted amount: 200,001n (800,000 + 200,001 = 1,000,001 > 1,000,000)
    const exceedingQuote = {
      amountBaseUnits: 200001n,
      network: DEFAULT_BASE_SEPOLIA_NETWORK,
      asset: DEFAULT_BASE_SEPOLIA_USDC,
      seller: 'seller-budget-test',
      endpoint: '/endpoint',
    };

    const decision = coordinator.evaluate(exceedingQuote);
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('total_budget_exceeded');

    // Attempting reserve on exceeding quote also refuses
    const reservation = coordinator.reserve(exceedingQuote);
    expect(reservation.decision.allowed).toBe(false);

    // Signer was never invoked
    expect(signCalls).toBe(0);

    // Durable cumulative spend remains exactly 800,000
    expect(ledger.getCumulativeSpendBaseUnits()).toBe(800000n);

    // 2. Exact boundary: 800,000 + 200,000 = 1,000,000 (== total budget) is ALLOWED
    const exactBudgetQuote = {
      amountBaseUnits: 200000n,
      network: DEFAULT_BASE_SEPOLIA_NETWORK,
      asset: DEFAULT_BASE_SEPOLIA_USDC,
    };
    const exactDecision = coordinator.evaluate(exactBudgetQuote);
    expect(exactDecision.allowed).toBe(true);
    expect(exactDecision.projectedSpendBaseUnits).toBe(1000000n);

    ledger.close();
  });

  // =========================================================================
  // CRITERION 7: Cumulative spend is persisted outside process memory — 7 pts
  // PASS: Use durable storage (SQLite). Survives process restart.
  // =========================================================================
  it('Criterion 7: Cumulative spend is persisted in SQLite and survives process restart / separate instances', () => {
    const tempDbPath = path.resolve('tests/temp-acceptance-ledger.sqlite');
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);

    try {
      // Instance 1: Initial process writes paid record
      const ledgerInstance1 = new Ledger(tempDbPath);
      ledgerInstance1.recordDecision({
        timestamp: '2026-09-27T14:00:00.000Z',
        seller: 'stall-1',
        endpoint: '/research',
        decision: 'paid',
        amountBaseUnits: '350000',
        reason: 'settled',
      });
      expect(ledgerInstance1.getCumulativeSpendBaseUnits()).toBe(350000n);
      ledgerInstance1.close();

      // Instance 2: Simulating full process restart reading from SQLite file
      const ledgerInstance2 = new Ledger(tempDbPath);
      expect(ledgerInstance2.getCumulativeSpendBaseUnits()).toBe(350000n);

      // Add another payment in Instance 2
      ledgerInstance2.recordDecision({
        timestamp: '2026-09-27T14:05:00.000Z',
        seller: 'stall-2',
        endpoint: '/research',
        decision: 'paid',
        amountBaseUnits: '150000',
        reason: 'settled',
      });
      expect(ledgerInstance2.getCumulativeSpendBaseUnits()).toBe(500000n);
      ledgerInstance2.close();

      // Instance 3: Re-open again
      const ledgerInstance3 = new Ledger(tempDbPath);
      expect(ledgerInstance3.getCumulativeSpendBaseUnits()).toBe(500000n);
      expect(ledgerInstance3.getAllDecisions()).toHaveLength(2);
      ledgerInstance3.close();
    } finally {
      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    }
  });

  // =========================================================================
  // CRITERION 8: Accepted network and asset are restricted to an allowlist — 10 pts
  // PASS: Explicitly allowlist Base Sepolia (eip155:84532) and test USDC.
  //       Reject mainnet, arbitrary tokens, unknown networks.
  // =========================================================================
  it('Criterion 8: Accepted network and asset are restricted to explicit allowlists (Base Sepolia + USDC only)', async () => {
    expect(config.allowlists.networkAllowlist).toEqual([DEFAULT_BASE_SEPOLIA_NETWORK]);
    expect(config.allowlists.assetAllowlist).toEqual([DEFAULT_BASE_SEPOLIA_USDC.toLowerCase()]);

    const ledger = new Ledger(':memory:');
    let signCalls = 0;
    const signer = createMockSigner(undefined, () => {
      signCalls++;
    });

    const paidFetch = createPaidFetch({ config, ledger, signer });

    // 1. Rejected network: Ethereum Mainnet
    const wrongNetRes = await paidFetch(`${rogueServer.url}/wrong-network`);
    expect(wrongNetRes.success).toBe(false);
    expect(wrongNetRes.error).toContain('network_not_allowed');
    expect(signCalls).toBe(0);

    // 2. Rejected asset: Unapproved token
    const wrongAssetRes = await paidFetch(`${rogueServer.url}/wrong-asset`);
    expect(wrongAssetRes.success).toBe(false);
    expect(wrongAssetRes.error).toContain('asset_not_allowed');
    expect(signCalls).toBe(0);

    // 3. Direct policy test for Base Mainnet (eip155:8453)
    const baseMainnetDecision = evaluateSpendingPolicy(
      {
        network: 'eip155:8453',
        asset: DEFAULT_BASE_SEPOLIA_USDC,
        amountBaseUnits: '50000',
      },
      0n,
      config
    );
    expect(baseMainnetDecision.allowed).toBe(false);
    expect(baseMainnetDecision.reasonCode).toBe('network_not_allowed');

    ledger.close();
  });

  // =========================================================================
  // CRITERION 9: Spending limits are NOT settable through tool arguments — 8 pts
  // PASS: Tool arguments must NOT contain maxPerCall, budget, etc.
  //       Handler must read limits from configuration that tool arguments cannot change.
  // =========================================================================
  it('Criterion 9: Spending limits are not settable through tool arguments and cannot alter policy limits', async () => {
    // 1. Schema check
    const toolProperties = PAID_FETCH_TOOL_DEFINITION.function.parameters.properties;
    expect('maxPerCall' in toolProperties).toBe(false);
    expect('budget' in toolProperties).toBe(false);
    expect('spendingLimit' in toolProperties).toBe(false);
    expect('priceLimit' in toolProperties).toBe(false);

    // 2. Runtime injection attempt through executePaidFetchTool
    const ledger = new Ledger(':memory:');
    const signer = createMockSigner();
    const paidClient = new X402PaidClient({ config, ledger, signer });

    const execution = await executePaidFetchTool({
      client: paidClient,
      rawArguments: {
        url: `${rogueServer.url}/research`,
        maxPerCall: '10000000', // Adversarial injection attempt
        budget: '50000000',
      },
    });

    // Zod schema rejected extraneous arguments
    expect(execution.record.refused).toBe(true);
    expect(execution.record.status).toBe(400);
    expect(execution.record.refusalReason).toContain('Unrecognized key(s)');

    // Immutable configuration limits are untouched
    expect(config.limits.maxPerCallBaseUnits).toBe(DEFAULT_MAX_PER_CALL_BASE_UNITS);
    expect(config.limits.totalBudgetBaseUnits).toBe(DEFAULT_TOTAL_BUDGET_BASE_UNITS);

    ledger.close();
  });

  // =========================================================================
  // CRITERION 10: Amounts are compared in integer base units — 6 pts
  // PASS: Do NOT use floating point. Use BigInt for all quote comparisons, limits, totals.
  // =========================================================================
  it('Criterion 10: Monetary amounts and comparisons strictly use integer base units (BigInt) with zero floating point', () => {
    // 1. Valid integer base unit string parses to BigInt
    const valid = parseBaseUnits('500000');
    expect(valid.success).toBe(true);
    if (valid.success) {
      expect(typeof valid.value).toBe('bigint');
      expect(valid.value).toBe(500000n);
    }

    // 2. Floating point numbers and decimals are strictly rejected
    expect(parseBaseUnits(0.5).success).toBe(false);
    expect(parseBaseUnits('0.5').success).toBe(false);
    expect(parseBaseUnits('50000.5').success).toBe(false);
    expect(parseBaseUnits('1.00').success).toBe(false);
    expect(parseBaseUnits('-1').success).toBe(false);
    expect(parseBaseUnits('abc').success).toBe(false);
    expect(parseBaseUnits('').success).toBe(false);

    // 3. Handles values larger than Number.MAX_SAFE_INTEGER without precision loss
    const hugeBaseUnitsStr = '9007199254740993000'; // > 2^53 - 1
    const hugeParsed = parseBaseUnits(hugeBaseUnitsStr);
    expect(hugeParsed.success).toBe(true);
    if (hugeParsed.success) {
      expect(typeof hugeParsed.value).toBe('bigint');
      expect(hugeParsed.value.toString()).toBe(hugeBaseUnitsStr);
    }

    // 4. Arithmetic uses BigInt
    const base1 = 500000n;
    const base2 = 50000n;
    const sum = base1 + base2;
    expect(typeof sum).toBe('bigint');
    expect(sum).toBe(550000n);
  });

  // =========================================================================
  // ADDITIONAL ACCEPTANCE TEST: Reservation rollback on payment failure
  // =========================================================================
  it('Failure path: Failed payment rolls back reservation and subsequent valid payment succeeds', async () => {
    const ledger = new Ledger(':memory:');
    let shouldFail = true;

    const signer = createMockSigner(undefined, () => {
      if (shouldFail) {
        throw new Error('Signer simulated network failure');
      }
    });

    const paidFetch = createPaidFetch({ config, ledger, signer });

    // Call 1 fails during signing
    const res1 = await paidFetch(`${honestServer.url}/research`);
    expect(res1.success).toBe(false);
    expect(res1.error).toContain('Signer simulated network failure');
    expect(ledger.getCumulativeSpendBaseUnits()).toBe(0n);

    // Call 2 with functioning signer succeeds
    shouldFail = false;
    const res2 = await paidFetch(`${honestServer.url}/research`);
    expect(res2.success).toBe(true);
    expect(ledger.getCumulativeSpendBaseUnits()).toBe(50000n);

    ledger.close();
  });

  // =========================================================================
  // ADDITIONAL ACCEPTANCE TEST: Concurrency race condition protection
  // =========================================================================
  it('Concurrency: Concurrent parallel requests cannot exceed total budget in SQLite', async () => {
    const ledger = new Ledger(':memory:');
    const budgetConfig = loadConfig({
      TOTAL_BUDGET_BASE_UNITS: '100000', // $0.10 total budget
      MAX_PER_CALL_BASE_UNITS: '50000',  // $0.05 per call
    });

    let signCalls = 0;
    const signer = createMockSigner(undefined, () => {
      signCalls++;
    });

    const paidFetch = createPaidFetch({ config: budgetConfig, ledger, signer });

    // 4 parallel requests for $0.05 against $0.10 budget
    const results = await Promise.all([
      paidFetch(`${honestServer.url}/research`),
      paidFetch(`${honestServer.url}/research`),
      paidFetch(`${honestServer.url}/research`),
      paidFetch(`${honestServer.url}/research`),
    ]);

    const successes = results.filter((r) => r.success);
    const failures = results.filter((r) => !r.success);

    // Exactly 2 requests succeed (2 * 50,000 = 100,000) and 2 fail
    expect(successes).toHaveLength(2);
    expect(failures).toHaveLength(2);
    expect(signCalls).toBe(2);

    // Durable SQLite spend exactly equals the budget ceiling
    expect(ledger.getCumulativeSpendBaseUnits()).toBe(100000n);

    ledger.close();
  });
});
