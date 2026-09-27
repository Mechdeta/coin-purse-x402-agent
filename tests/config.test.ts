import { describe, it, expect } from 'vitest';
import {
  loadConfig,
  DEFAULT_BASE_SEPOLIA_NETWORK,
  DEFAULT_BASE_SEPOLIA_USDC,
  DEFAULT_MAX_PER_CALL_BASE_UNITS,
  DEFAULT_TOTAL_BUDGET_BASE_UNITS,
} from '../src/config/index.js';

describe('Configuration & Security Allowlists', () => {
  it('loads default Base Sepolia configuration with bigint limits', () => {
    const config = loadConfig({});
    expect(config.allowlists.networkAllowlist).toContain(DEFAULT_BASE_SEPOLIA_NETWORK);
    expect(config.allowlists.assetAllowlist).toContain(DEFAULT_BASE_SEPOLIA_USDC);
    expect(config.limits.maxPerCallBaseUnits).toBe(DEFAULT_MAX_PER_CALL_BASE_UNITS);
    expect(config.limits.totalBudgetBaseUnits).toBe(DEFAULT_TOTAL_BUDGET_BASE_UNITS);
    expect(typeof config.limits.maxPerCallBaseUnits).toBe('bigint');
    expect(typeof config.limits.totalBudgetBaseUnits).toBe('bigint');
  });

  it('correctly parses custom base unit limits as bigint', () => {
    const config = loadConfig({
      MAX_PER_CALL_BASE_UNITS: '100000',
      TOTAL_BUDGET_BASE_UNITS: '1000000',
    });
    expect(config.limits.maxPerCallBaseUnits).toBe(100000n);
    expect(config.limits.totalBudgetBaseUnits).toBe(1000000n);
  });

  it('rejects floating point or non-integer limit inputs in configuration', () => {
    expect(() => {
      loadConfig({ MAX_PER_CALL_BASE_UNITS: '0.50' });
    }).toThrow();

    expect(() => {
      loadConfig({ TOTAL_BUDGET_BASE_UNITS: '5.00' });
    }).toThrow();
  });

  it('rejects maxPerCall exceeding totalBudget', () => {
    expect(() => {
      loadConfig({
        MAX_PER_CALL_BASE_UNITS: '6000000',
        TOTAL_BUDGET_BASE_UNITS: '5000000',
      });
    }).toThrow(/MAX_PER_CALL_BASE_UNITS cannot exceed TOTAL_BUDGET_BASE_UNITS/);
  });

  it('normalizes asset addresses to lowercase', () => {
    const config = loadConfig({
      APPROVED_USDC_ADDRESS: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    });
    expect(config.allowlists.assetAllowlist[0]).toBe('0x036cbd53842c5426634e7929541ec2318f3dcf7e');
  });

  it('ensures configuration objects are frozen and immutable', () => {
    const config = loadConfig({});
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.limits)).toBe(true);
    expect(Object.isFrozen(config.allowlists)).toBe(true);
  });
});
