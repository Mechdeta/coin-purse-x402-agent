import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Ledger } from '../src/ledger/index.js';

describe('Durable SQLite Ledger', () => {
  let tempDir: string;
  let dbFilePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coin-purse-test-'));
    dbFilePath = path.join(tempDir, 'test-ledger.sqlite');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('records paid decisions and calculates bigint cumulative spend', () => {
    const ledger = new Ledger(':memory:');

    ledger.recordDecision({
      timestamp: new Date().toISOString(),
      seller: 'honest-seller',
      endpoint: '/weather',
      decision: 'paid',
      amountBaseUnits: '50000', // 0.05 USDC
      network: 'eip155:84532',
      asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      reason: 'within spending policy',
      txHash: '0xabc123',
    });

    ledger.recordDecision({
      timestamp: new Date().toISOString(),
      seller: 'honest-seller',
      endpoint: '/stocks',
      decision: 'paid',
      amountBaseUnits: '100000', // 0.10 USDC
      network: 'eip155:84532',
      asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      reason: 'within spending policy',
      txHash: '0xdef456',
    });

    expect(ledger.getCumulativeSpendBaseUnits()).toBe(150000n);
    expect(typeof ledger.getCumulativeSpendBaseUnits()).toBe('bigint');

    const summary = ledger.getSummary();
    expect(summary.totalPaid).toBe(2);
    expect(summary.totalRefused).toBe(0);
    expect(summary.cumulativeSpendBaseUnits).toBe(150000n);

    ledger.close();
  });

  it('records refused decisions without altering cumulative spend', () => {
    const ledger = new Ledger(':memory:');

    ledger.recordDecision({
      timestamp: new Date().toISOString(),
      seller: 'rogue-seller',
      endpoint: '/expensive',
      decision: 'refused',
      amountBaseUnits: '4990000', // $4.99 USDC
      network: 'eip155:84532',
      asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      reason: 'per-call limit exceeded: 4990000 > 500000',
    });

    expect(ledger.getCumulativeSpendBaseUnits()).toBe(0n);

    const summary = ledger.getSummary();
    expect(summary.totalPaid).toBe(0);
    expect(summary.totalRefused).toBe(1);
    expect(summary.cumulativeSpendBaseUnits).toBe(0n);

    const decisions = ledger.getAllDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe('refused');
    expect(decisions[0].amountBaseUnits).toBe('4990000');
    expect(decisions[0].reason).toContain('per-call limit exceeded');

    ledger.close();
  });

  it('survives process restart by loading persisted state from SQLite file', () => {
    // Process 1: Initial agent run
    const ledgerProcess1 = new Ledger(dbFilePath);
    ledgerProcess1.recordDecision({
      timestamp: '2026-09-27T10:00:00.000Z',
      seller: 'seller-1',
      endpoint: '/data-1',
      decision: 'paid',
      amountBaseUnits: '250000',
      reason: 'within spending policy',
    });
    ledgerProcess1.recordDecision({
      timestamp: '2026-09-27T10:01:00.000Z',
      seller: 'rogue-seller',
      endpoint: '/drain',
      decision: 'refused',
      amountBaseUnits: '99999999',
      reason: 'budget exceeded',
    });
    expect(ledgerProcess1.getCumulativeSpendBaseUnits()).toBe(250000n);
    ledgerProcess1.close();

    // Process 2: Simulating process restart / new instance reading the exact same db file
    const ledgerProcess2 = new Ledger(dbFilePath);
    expect(ledgerProcess2.getCumulativeSpendBaseUnits()).toBe(250000n);

    // Record an additional payment in Process 2
    ledgerProcess2.recordDecision({
      timestamp: '2026-09-27T10:02:00.000Z',
      seller: 'seller-2',
      endpoint: '/data-2',
      decision: 'paid',
      amountBaseUnits: '150000',
      reason: 'within spending policy',
    });

    expect(ledgerProcess2.getCumulativeSpendBaseUnits()).toBe(400000n);
    expect(ledgerProcess2.getAllDecisions()).toHaveLength(3);

    ledgerProcess2.close();
  });
});
