import { z } from 'zod';
import type { X402PaidClient } from '../x402/client.js';
import type { ResearchToolCallRecord } from './types.js';

export const PAID_FETCH_TOOL_NAME = 'paid_fetch';

/**
 * Strict OpenAI Tool Definition for paid_fetch.
 * Strictly exposes ONLY request parameters.
 * Explicitly DOES NOT expose: maxPerCall, budget, spendingLimit, network, asset, privateKey, wallet.
 */
export const PAID_FETCH_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: PAID_FETCH_TOOL_NAME,
    description:
      'Fetch research data from an external HTTP endpoint. If the endpoint requires payment (HTTP 402), payment will be processed automatically under the client spending policy.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The HTTP URL of the research endpoint to fetch',
        },
        method: {
          type: 'string',
          enum: ['GET', 'POST'],
          description: 'Optional HTTP method (defaults to GET)',
        },
        headers: {
          type: 'object',
          description: 'Optional HTTP request headers',
          additionalProperties: { type: 'string' },
        },
        body: {
          type: 'string',
          description: 'Optional request body string for POST requests',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
} as const;

/**
 * Strict Zod validator for tool call arguments.
 * `.strict()` guarantees any extraneous keys (such as budget, maxPerCall, etc.) are immediately rejected.
 */
export const PaidFetchInputSchema = z
  .object({
    url: z.string().url(),
    method: z.enum(['GET', 'POST']).optional().default('GET'),
    headers: z.record(z.string()).optional(),
    body: z.string().optional(),
  })
  .strict();

export interface ExecutePaidFetchOptions {
  readonly client: X402PaidClient;
  readonly rawArguments: string | Record<string, unknown>;
  readonly allowedEndpoints?: readonly string[];
}

export interface ExecutePaidFetchOutput {
  readonly toolResultJson: string;
  readonly record: ResearchToolCallRecord;
}

/**
 * Executes the paid_fetch tool call on behalf of the LLM agent.
 */
export async function executePaidFetchTool({
  client,
  rawArguments,
  allowedEndpoints,
}: ExecutePaidFetchOptions): Promise<ExecutePaidFetchOutput> {
  let parsedArgs: z.infer<typeof PaidFetchInputSchema>;

  try {
    const rawObj =
      typeof rawArguments === 'string' ? JSON.parse(rawArguments) : rawArguments;
    parsedArgs = PaidFetchInputSchema.parse(rawObj);
  } catch (err: any) {
    const errorMsg = `Invalid tool arguments: ${err.message}`;
    return {
      toolResultJson: JSON.stringify({ success: false, error: errorMsg }),
      record: {
        url: 'invalid',
        method: 'UNKNOWN',
        success: false,
        status: 400,
        refused: true,
        refusalReason: errorMsg,
      },
    };
  }

  // Verify URL against allowed endpoints if restriction is set
  if (allowedEndpoints && allowedEndpoints.length > 0) {
    const isAllowed = allowedEndpoints.some((allowed) =>
      parsedArgs.url.toLowerCase().startsWith(allowed.toLowerCase())
    );
    if (!isAllowed) {
      const errorMsg = `Endpoint "${parsedArgs.url}" is not in the allowed research endpoints list [${allowedEndpoints.join(', ')}]`;
      return {
        toolResultJson: JSON.stringify({ success: false, error: errorMsg }),
        record: {
          url: parsedArgs.url,
          method: parsedArgs.method,
          success: false,
          status: 403,
          refused: true,
          refusalReason: errorMsg,
        },
      };
    }
  }

  // Call the x402 paid client (policy runs BEFORE signing)
  const result = await client.fetch(parsedArgs.url, {
    method: parsedArgs.method,
    headers: parsedArgs.headers,
    body: parsedArgs.body,
  });

  if (result.success) {
    return {
      toolResultJson: JSON.stringify({
        success: true,
        status: result.status,
        data: result.data,
      }),
      record: {
        url: parsedArgs.url,
        method: parsedArgs.method,
        success: true,
        status: result.status,
        data: result.data,
      },
    };
  } else {
    // Payment was refused by client policy or rejected
    const isRefused = result.decision ? !result.decision.allowed : true;
    const refusalReason = result.error || 'Payment refused';

    return {
      toolResultJson: JSON.stringify({
        success: false,
        status: result.status,
        refused: isRefused,
        reason: refusalReason,
        message:
          'Payment was refused by local client spending policy or failed. Signer was NOT invoked for excessive or unauthorized quotes.',
      }),
      record: {
        url: parsedArgs.url,
        method: parsedArgs.method,
        success: false,
        status: result.status,
        refused: isRefused,
        refusalReason,
      },
    };
  }
}
