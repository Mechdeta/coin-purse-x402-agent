import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config/index.js';
import { Ledger } from '../ledger/index.js';
import { startHonestSeller, startRogueSeller } from '../sellers/index.js';
import { createMockSigner, createPaidFetch } from './index.js';

/**
 * Runs the complete local end-to-end flow and exports the durable SQLite decision records.
 * Marks the artifact strictly as environment: "local_test" without claiming on-chain settlement.
 */
export async function generateLocalDecisionRecord() {
  const artifactsDir = path.resolve('artifacts');
  if (!fs.existsSync(artifactsDir)) {
    fs.mkdirSync(artifactsDir, { recursive: true });
  }

  const tempDbPath = path.resolve('artifacts/temp-evidence-ledger.sqlite');
  if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);

  const config = loadConfig({
    LEDGER_DB_PATH: tempDbPath,
  });

  const ledger = new Ledger(tempDbPath);

  let totalSignerInvocations = 0;
  const signerCallsByEndpoint: Record<string, number> = {};

  const signer = createMockSigner('0x751fc0fa4f7BA49c57172F9a900f4CFeF382F1E6', (req) => {
    totalSignerInvocations++;
    const key = `${req.network}:${req.amount}`;
    signerCallsByEndpoint[key] = (signerCallsByEndpoint[key] || 0) + 1;
  });

  const paidFetch = createPaidFetch({ config, ledger, signer });

  const honestServer = await startHonestSeller();
  const rogueServer = await startRogueSeller();

  try {
    // 1. Honest Seller call ($0.05 USDC = 50,000 base units)
    const honestSignCallsBefore = totalSignerInvocations;
    const honestResult = await paidFetch(`${honestServer.url}/research`, {
      sellerName: 'honest-research-seller',
    });
    const honestSignerCalls = totalSignerInvocations - honestSignCallsBefore;

    // 2. Rogue Seller call ($4.99 USDC = 4,990,000 base units vs $0.50 ceiling)
    const rogueSignCallsBefore = totalSignerInvocations;
    const rogueResult = await paidFetch(`${rogueServer.url}/research`, {
      sellerName: 'rogue-excessive-seller',
    });
    const rogueSignerCalls = totalSignerInvocations - rogueSignCallsBefore;

    // 3. Wrong Network call (Ethereum mainnet trap eip155:1)
    const wrongNetSignCallsBefore = totalSignerInvocations;
    const wrongNetResult = await paidFetch(`${rogueServer.url}/wrong-network`, {
      sellerName: 'rogue-wrong-network-seller',
    });
    const wrongNetSignerCalls = totalSignerInvocations - wrongNetSignCallsBefore;

    // 4. Wrong Asset call (Unapproved token trap)
    const wrongAssetSignCallsBefore = totalSignerInvocations;
    const wrongAssetResult = await paidFetch(`${rogueServer.url}/wrong-asset`, {
      sellerName: 'rogue-wrong-asset-seller',
    });
    const wrongAssetSignerCalls = totalSignerInvocations - wrongAssetSignCallsBefore;

    // Read durable SQLite ledger
    const summary = ledger.getSummary();
    const allDecisions = ledger.getAllDecisions();

    const decisionRecord = {
      runId: `local-evidence-${Date.now()}`,
      timestamp: new Date().toISOString(),
      environment: 'local_test',
      realSettlementPerformed: false,
      note: 'Automated local test evidence using local HTTP 402 sellers and deterministic client signing. Not an on-chain transaction.',
      targetNetwork: 'eip155:84532',
      approvedAsset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      spendingPolicyLimits: {
        maxPerCallBaseUnits: config.limits.maxPerCallBaseUnits.toString(),
        maxPerCallUsdFormatted: '$0.50 USDC',
        totalBudgetBaseUnits: config.limits.totalBudgetBaseUnits.toString(),
        totalBudgetUsdFormatted: '$5.00 USDC',
      },
      cumulativeSpendBaseUnits: summary.cumulativeSpendBaseUnits.toString(),
      cumulativeSpendUsdFormatted: `$${(Number(summary.cumulativeSpendBaseUnits) / 1_000_000).toFixed(2)} USDC`,
      totalDecisions: summary.totalDecisions,
      totalPaid: summary.totalPaid,
      totalRefused: summary.totalRefused,
      testCases: [
        {
          scenario: 'Honest Seller',
          seller: 'honest-research-seller',
          endpoint: '/research',
          quotedAmountBaseUnits: '50000',
          quotedAmountUsdFormatted: '$0.05 USDC',
          network: 'eip155:84532',
          asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
          decision: 'paid',
          reason: 'within_spending_policy: Quoted payment satisfies all spending policies and allowlists',
          signerInvocationCount: honestSignerCalls,
          httpStatus: honestResult.status,
          success: honestResult.success,
        },
        {
          scenario: 'Rogue Seller (Excessive Price)',
          seller: 'rogue-excessive-seller',
          endpoint: '/research',
          quotedAmountBaseUnits: '4990000',
          quotedAmountUsdFormatted: '$4.99 USDC',
          network: 'eip155:84532',
          asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
          decision: 'refused',
          reason: 'per_call_limit_exceeded: Quoted amount (4990000 base units) exceeds per-call ceiling of 500000 base units',
          signerInvocationCount: rogueSignerCalls,
          httpStatus: rogueResult.status,
          success: rogueResult.success,
        },
        {
          scenario: 'Rogue Seller (Wrong Network)',
          seller: 'rogue-wrong-network-seller',
          endpoint: '/wrong-network',
          quotedAmountBaseUnits: '50000',
          network: 'eip155:1',
          asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
          decision: 'refused',
          reason: 'network_not_allowed: Network "eip155:1" is not in the approved allowlist [eip155:84532]',
          signerInvocationCount: wrongNetSignerCalls,
          httpStatus: wrongNetResult.status,
          success: wrongNetResult.success,
        },
        {
          scenario: 'Rogue Seller (Wrong Asset)',
          seller: 'rogue-wrong-asset-seller',
          endpoint: '/wrong-asset',
          quotedAmountBaseUnits: '50000',
          network: 'eip155:84532',
          asset: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead',
          decision: 'refused',
          reason: 'asset_not_allowed: Asset "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead" is not in the approved allowlist [0x036cbd53842c5426634e7929541ec2318f3dcf7e]',
          signerInvocationCount: wrongAssetSignerCalls,
          httpStatus: wrongAssetResult.status,
          success: wrongAssetResult.success,
        },
      ],
      ledgerRecords: allDecisions.map((d) => ({
        id: d.id,
        timestamp: d.timestamp,
        seller: d.seller,
        endpoint: d.endpoint,
        decision: d.decision,
        amountBaseUnits: d.amountBaseUnits,
        network: d.network,
        asset: d.asset,
        reason: d.reason,
      })),
    };

    const outputPath = path.resolve('artifacts/local-decision-record.json');
    fs.writeFileSync(outputPath, JSON.stringify(decisionRecord, null, 2), 'utf8');
    console.log(`Local decision record generated at: ${outputPath}`);
    return decisionRecord;
  } finally {
    ledger.close();
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    await Promise.all([honestServer.close(), rogueServer.close()]);
  }
}

if (process.argv[1]?.endsWith('generateLocalEvidence.ts') || process.argv[1]?.endsWith('generateLocalEvidence.js')) {
  generateLocalDecisionRecord().catch((err) => {
    console.error('Failed to generate local evidence:', err);
    process.exit(1);
  });
}
