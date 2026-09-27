import type { PaymentDecisionRecord } from '../ledger/types.js';

export interface ResearchToolCallRecord {
  readonly url: string;
  readonly method: string;
  readonly success: boolean;
  readonly status: number;
  readonly data?: unknown;
  readonly refused?: boolean;
  readonly refusalReason?: string;
}

export interface ResearchResult {
  readonly question: string;
  readonly answer: string;
  readonly toolCalls: readonly ResearchToolCallRecord[];
  readonly ledgerSummary: {
    readonly totalPaid: number;
    readonly totalRefused: number;
    readonly cumulativeSpendBaseUnits: string;
  };
  readonly paymentDecisions: readonly PaymentDecisionRecord[];
}

export interface ResearchAgentOptions {
  readonly maxToolCalls?: number;
  /** Optional allowlist of accessible research URLs to prevent arbitrary SSRF */
  readonly allowedEndpoints?: readonly string[];
}

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content?: string | null;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly {
    readonly id: string;
    readonly type: 'function';
    readonly function: {
      readonly name: string;
      readonly arguments: string;
    };
  }[];
}

export interface LLMResponse {
  readonly content?: string | null;
  readonly tool_calls?: readonly {
    readonly id: string;
    readonly type: 'function';
    readonly function: {
      readonly name: string;
      readonly arguments: string;
    };
  }[];
}

/**
 * Pluggable LLM client interface allowing mock implementations for tests
 * and real providers (OpenAI, OpenRouter, etc.) for live runs.
 */
export interface LLMClientInterface {
  chat(messages: readonly ChatMessage[], tools: readonly unknown[]): Promise<LLMResponse>;
}
