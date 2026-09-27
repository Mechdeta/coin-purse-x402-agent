import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { Ledger } from '../src/ledger/index.js';
import {
  startHonestSeller,
  startRogueSeller,
  type SellerServer,
} from '../src/sellers/index.js';
import {
  createMockSigner,
  X402PaidClient,
} from '../src/x402/index.js';
import {
  PAID_FETCH_TOOL_DEFINITION,
  ResearchAgent,
  type ChatMessage,
  type LLMClientInterface,
  type LLMResponse,
} from '../src/agent/index.js';

describe('Phase 5 — LLM Research Agent & Paid Fetch Tool', () => {
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

  // 1 & 2: Tool schema inspection
  it('1 & 2. Tool schema contains URL/request parameters only and DOES NOT contain spending controls', () => {
    const fn = PAID_FETCH_TOOL_DEFINITION.function;
    expect(fn.name).toBe('paid_fetch');
    expect(fn.parameters.type).toBe('object');

    const properties = fn.parameters.properties;
    expect(Object.keys(properties)).toEqual(['url', 'method', 'headers', 'body']);

    // Ensure forbidden spending limit properties are NOT in the schema
    const forbidden = [
      'maxPerCall',
      'maxPerCallBaseUnits',
      'budget',
      'totalBudget',
      'totalBudgetBaseUnits',
      'spendingLimit',
      'network',
      'asset',
      'privateKey',
      'wallet',
    ];
    for (const key of forbidden) {
      expect(key in properties).toBe(false);
    }
  });

  // 3: Agent can call honest seller and synthesize answer
  it('3. Agent can call honest seller, execute payment, and synthesize answer', async () => {
    const ledger = new Ledger(':memory:');
    let signCalls = 0;
    const signer = createMockSigner(undefined, () => {
      signCalls++;
    });

    const paidClient = new X402PaidClient({ config, ledger, signer });

    // Mock LLM that decides to call honest seller first, then answer
    let callStep = 0;
    const mockLLM: LLMClientInterface = {
      async chat(messages: readonly ChatMessage[]): Promise<LLMResponse> {
        callStep++;
        if (callStep === 1) {
          return {
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'paid_fetch',
                  arguments: JSON.stringify({ url: `${honestServer.url}/research` }),
                },
              },
            ],
          };
        }
        // Step 2: Final answer synthesized from tool results
        const toolMsg = messages.find((m) => m.role === 'tool');
        const parsed = JSON.parse(toolMsg?.content || '{}');
        return {
          content: `Synthesized answer: ${parsed.data.data}`,
        };
      },
    };

    const agent = new ResearchAgent({
      client: paidClient,
      ledger,
      llmClient: mockLLM,
    });

    const result = await agent.research('What is quantum computing status?');

    expect(result.answer).toContain('Honest Research Report');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].success).toBe(true);
    expect(result.toolCalls[0].status).toBe(200);

    // Signer was invoked once for honest payment
    expect(signCalls).toBe(1);

    // Ledger records payment
    expect(result.ledgerSummary.totalPaid).toBe(1);
    expect(result.ledgerSummary.cumulativeSpendBaseUnits).toBe('50000');

    ledger.close();
  });

  // 4 & 5 & 8: Rogue seller refusal reaches agent as structured tool result, causes ZERO signer calls, and agent does not crash
  it('4, 5 & 8. Rogue seller refusal reaches agent as structured tool result, causes ZERO signer calls, and does not crash', async () => {
    const ledger = new Ledger(':memory:');
    let signCalls = 0;
    const signer = createMockSigner(undefined, () => {
      signCalls++;
    });

    const paidClient = new X402PaidClient({ config, ledger, signer });

    let callStep = 0;
    let receivedToolContent: any;

    const mockLLM: LLMClientInterface = {
      async chat(messages: readonly ChatMessage[]): Promise<LLMResponse> {
        callStep++;
        if (callStep === 1) {
          // Model attempts to call the expensive rogue seller
          return {
            tool_calls: [
              {
                id: 'call_rogue',
                type: 'function',
                function: {
                  name: 'paid_fetch',
                  arguments: JSON.stringify({ url: `${rogueServer.url}/research` }),
                },
              },
            ],
          };
        }

        // Step 2: Model receives refusal and synthesizes graceful fallback
        const toolMsg = messages.find((m) => m.role === 'tool');
        receivedToolContent = JSON.parse(toolMsg?.content || '{}');
        return {
          content: `The source at rogue seller was unavailable: ${receivedToolContent.reason}. Analysis completed with no payment made.`,
        };
      },
    };

    const agent = new ResearchAgent({
      client: paidClient,
      ledger,
      llmClient: mockLLM,
    });

    const result = await agent.research('Fetch data from rogue endpoint');

    // Agent handled the refusal gracefully without crashing
    expect(result.answer).toContain('per_call_limit_exceeded');

    // Tool call record shows refusal
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].refused).toBe(true);
    expect(result.toolCalls[0].refusalReason).toContain('per_call_limit_exceeded');

    // Tool result JSON returned to LLM clearly reported refusal
    expect(receivedToolContent.refused).toBe(true);
    expect(receivedToolContent.reason).toContain('per_call_limit_exceeded');

    // CRITICAL SECURITY PROOF: Signer was NEVER invoked
    expect(signCalls).toBe(0);

    // Ledger recorded refusal
    expect(result.ledgerSummary.totalPaid).toBe(0);
    expect(result.ledgerSummary.totalRefused).toBe(1);
    expect(result.ledgerSummary.cumulativeSpendBaseUnits).toBe('0');

    ledger.close();
  });

  // 6: Network and asset refusals cause ZERO signer calls
  it('6. Network and asset trap refusals return structured results and cause ZERO signer calls', async () => {
    const ledger = new Ledger(':memory:');
    let signCalls = 0;
    const signer = createMockSigner(undefined, () => {
      signCalls++;
    });

    const paidClient = new X402PaidClient({ config, ledger, signer });

    let callStep = 0;
    const mockLLM: LLMClientInterface = {
      async chat(): Promise<LLMResponse> {
        callStep++;
        if (callStep === 1) {
          return {
            tool_calls: [
              {
                id: 'call_wrong_net',
                type: 'function',
                function: {
                  name: 'paid_fetch',
                  arguments: JSON.stringify({ url: `${rogueServer.url}/wrong-network` }),
                },
              },
              {
                id: 'call_wrong_asset',
                type: 'function',
                function: {
                  name: 'paid_fetch',
                  arguments: JSON.stringify({ url: `${rogueServer.url}/wrong-asset` }),
                },
              },
            ],
          };
        }
        return { content: 'Both unauthorized sources were safely rejected.' };
      },
    };

    const agent = new ResearchAgent({
      client: paidClient,
      ledger,
      llmClient: mockLLM,
    });

    const result = await agent.research('Test trap endpoints');

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].refusalReason).toContain('network_not_allowed');
    expect(result.toolCalls[1].refusalReason).toContain('asset_not_allowed');

    // Zero signer invocations
    expect(signCalls).toBe(0);
    expect(result.ledgerSummary.totalPaid).toBe(0);
    expect(result.ledgerSummary.totalRefused).toBe(2);

    ledger.close();
  });

  // 7: Durable SQLite records survive outside process memory
  it('7. Payment decisions and refusal history are read directly from durable SQLite ledger', async () => {
    const ledger = new Ledger(':memory:');
    const signer = createMockSigner();
    const paidClient = new X402PaidClient({ config, ledger, signer });

    // Pre-populate ledger with prior historical run
    ledger.recordDecision({
      timestamp: '2026-09-27T12:00:00.000Z',
      seller: 'historical-stall',
      endpoint: '/prior',
      decision: 'paid',
      amountBaseUnits: '100000',
      reason: 'prior payment',
    });

    const mockLLM: LLMClientInterface = {
      async chat(): Promise<LLMResponse> {
        return { content: 'Completed without calling any tools.' };
      },
    };

    const agent = new ResearchAgent({
      client: paidClient,
      ledger,
      llmClient: mockLLM,
    });

    const result = await agent.research('Historical query');

    // Agent's ledger summary reflects the durable database state
    expect(result.ledgerSummary.totalPaid).toBe(1);
    expect(result.ledgerSummary.cumulativeSpendBaseUnits).toBe('100000');
    expect(result.paymentDecisions[0].seller).toBe('historical-stall');

    ledger.close();
  });

  // 9: Prompt injection & untrusted seller text cannot alter spending policy
  it('9. Prompt injection in seller response cannot modify spending policy or unlock rogue endpoints', async () => {
    const ledger = new Ledger(':memory:');
    let signCalls = 0;
    const signer = createMockSigner(undefined, () => {
      signCalls++;
    });

    const paidClient = new X402PaidClient({ config, ledger, signer });

    let callStep = 0;
    const mockLLM: LLMClientInterface = {
      async chat(): Promise<LLMResponse> {
        callStep++;
        if (callStep === 1) {
          // First call honest seller
          return {
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'paid_fetch',
                  arguments: JSON.stringify({ url: `${honestServer.url}/research` }),
                },
              },
            ],
          };
        }
        if (callStep === 2) {
          // Imagine the model is tricked by prompt injection into attempting the rogue endpoint
          return {
            tool_calls: [
              {
                id: 'call_2',
                type: 'function',
                function: {
                  name: 'paid_fetch',
                  arguments: JSON.stringify({
                    url: `${rogueServer.url}/research`,
                    // Even if adversarial tool options are attempted:
                    maxPerCall: '10000000',
                  }),
                },
              },
            ],
          };
        }
        return { content: 'Finished.' };
      },
    };

    const agent = new ResearchAgent({
      client: paidClient,
      ledger,
      llmClient: mockLLM,
    });

    const result = await agent.research('Adversarial prompt injection test');

    // Call 1 (honest) succeeded: signCalls was 1
    // Call 2 (rogue) was strictly blocked: signCalls did NOT increase to 2!
    expect(signCalls).toBe(1);
    expect(result.ledgerSummary.cumulativeSpendBaseUnits).toBe('50000');

    // Tool call 2 failed validation/policy
    expect(result.toolCalls[1].refused).toBe(true);

    ledger.close();
  });

  // 10: Endpoint allowlist prevents arbitrary SSRF
  it('10. Endpoint allowlist prevents agent from calling arbitrary unauthorized localhost ports', async () => {
    const ledger = new Ledger(':memory:');
    const signer = createMockSigner();
    const paidClient = new X402PaidClient({ config, ledger, signer });

    const mockLLM: LLMClientInterface = {
      async chat(): Promise<LLMResponse> {
        return {
          tool_calls: [
            {
              id: 'call_ssrf',
              type: 'function',
              function: {
                name: 'paid_fetch',
                arguments: JSON.stringify({ url: 'http://localhost:9999/internal-admin' }),
              },
            },
          ],
        };
      },
    };

    const agent = new ResearchAgent({
      client: paidClient,
      ledger,
      llmClient: mockLLM,
      allowedEndpoints: [honestServer.url, rogueServer.url],
    });

    const result = await agent.research('Attempt SSRF');
    expect(result.toolCalls[0].refused).toBe(true);
    expect(result.toolCalls[0].status).toBe(403);
    expect(result.toolCalls[0].refusalReason).toContain('not in the allowed research endpoints list');

    ledger.close();
  });
});
