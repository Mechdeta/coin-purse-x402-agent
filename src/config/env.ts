import dotenv from 'dotenv';
import { z } from 'zod';
import type { AppConfig } from './types.js';

// Load environment variables from .env if present
dotenv.config();

/**
 * Standard default constants
 */
export const DEFAULT_BASE_SEPOLIA_NETWORK = 'eip155:84532';
export const DEFAULT_BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'.toLowerCase();

// 1 USDC = 1,000,000 base units
export const DEFAULT_MAX_PER_CALL_BASE_UNITS = 500_000n; // 0.50 USDC
export const DEFAULT_TOTAL_BUDGET_BASE_UNITS = 5_000_000n; // 5.00 USDC

const envSchema = z.object({
  APPROVED_NETWORK: z.string().default(DEFAULT_BASE_SEPOLIA_NETWORK),
  APPROVED_USDC_ADDRESS: z.string().default(DEFAULT_BASE_SEPOLIA_USDC),
  MAX_PER_CALL_BASE_UNITS: z
    .string()
    .regex(/^\d+$/, 'MAX_PER_CALL_BASE_UNITS must be an integer string')
    .default(DEFAULT_MAX_PER_CALL_BASE_UNITS.toString())
    .transform((val) => BigInt(val)),
  TOTAL_BUDGET_BASE_UNITS: z
    .string()
    .regex(/^\d+$/, 'TOTAL_BUDGET_BASE_UNITS must be an integer string')
    .default(DEFAULT_TOTAL_BUDGET_BASE_UNITS.toString())
    .transform((val) => BigInt(val)),
  LEDGER_DB_PATH: z.string().default('data/ledger.sqlite'),
  BASE_SEPOLIA_RPC_URL: z.string().url().default('https://sepolia.base.org'),
  BUYER_PRIVATE_KEY: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('gpt-4o-mini'),
});

/**
 * Load and validate application configuration from environment variables or custom overrides.
 * Guarantees that spending limits are strictly represented as `bigint`.
 */
export function loadConfig(envOverrides?: Record<string, string | undefined>): AppConfig {
  const rawEnv = {
    ...process.env,
    ...(envOverrides || {}),
  };

  const parsed = envSchema.parse(rawEnv);

  if (parsed.MAX_PER_CALL_BASE_UNITS <= 0n) {
    throw new Error('MAX_PER_CALL_BASE_UNITS must be greater than 0');
  }

  if (parsed.TOTAL_BUDGET_BASE_UNITS <= 0n) {
    throw new Error('TOTAL_BUDGET_BASE_UNITS must be greater than 0');
  }

  if (parsed.MAX_PER_CALL_BASE_UNITS > parsed.TOTAL_BUDGET_BASE_UNITS) {
    throw new Error('MAX_PER_CALL_BASE_UNITS cannot exceed TOTAL_BUDGET_BASE_UNITS');
  }

  // Freeze allowlists and limits to prevent accidental runtime mutation
  const config: AppConfig = Object.freeze({
    limits: Object.freeze({
      maxPerCallBaseUnits: parsed.MAX_PER_CALL_BASE_UNITS,
      totalBudgetBaseUnits: parsed.TOTAL_BUDGET_BASE_UNITS,
    }),
    allowlists: Object.freeze({
      networkAllowlist: Object.freeze([parsed.APPROVED_NETWORK]),
      assetAllowlist: Object.freeze([parsed.APPROVED_USDC_ADDRESS.toLowerCase()]),
    }),
    ledgerDbPath: parsed.LEDGER_DB_PATH,
    rpcUrl: parsed.BASE_SEPOLIA_RPC_URL,
    buyerPrivateKey: parsed.BUYER_PRIVATE_KEY,
    llmApiKey: parsed.LLM_API_KEY,
    llmModel: parsed.LLM_MODEL,
  });

  return config;
}
