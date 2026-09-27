import dotenv from 'dotenv';
import { loadConfig } from '../config/index.js';
import { Ledger } from '../ledger/index.js';
import { runLocalSellers } from '../sellers/index.js';
import { createMockSigner, createViemSigner, X402PaidClient } from '../x402/index.js';
import { ResearchAgent } from './researchAgent.js';

dotenv.config();

/**
 * CLI Runner for the Research Agent.
 * Run via: npm run agent -- "Your question here"
 */
async function main() {
  const question = process.argv.slice(2).join(' ') || 'What is the latest quantum computing research?';

  console.log('='.repeat(60));
  console.log('THE COIN PURSE — LLM RESEARCH AGENT');
  console.log('='.repeat(60));
  console.log(`Question: "${question}"`);

  const config = loadConfig();
  const ledger = new Ledger(config.ledgerDbPath);

  // Spin up local honest and rogue sellers for demonstration
  const sellers = await runLocalSellers(4021, 4022);

  // Initialize signer: use Viem if key is configured, otherwise fallback to mock test signer
  const signer = config.buyerPrivateKey
    ? createViemSigner(config.buyerPrivateKey)
    : createMockSigner('0x1111222233334444555566667777888899990000');

  const paidClient = new X402PaidClient({
    config,
    ledger,
    signer,
  });

  const agent = new ResearchAgent({
    client: paidClient,
    ledger,
    config,
    allowedEndpoints: ['http://localhost:4021', 'http://localhost:4022'],
  });

  try {
    const result = await agent.research(question);

    console.log('\n--- RESEARCH ANSWER ---');
    console.log(result.answer);

    console.log('\n--- TOOL CALLS EXECUTED ---');
    for (const call of result.toolCalls) {
      console.log(`- [${call.method}] ${call.url} => Status: ${call.status}, Refused: ${call.refused || false}`);
      if (call.refusalReason) {
        console.log(`  Reason: ${call.refusalReason}`);
      }
    }

    console.log('\n--- DURABLE SQLITE LEDGER AUDIT ---');
    console.log(`Total Paid: ${result.ledgerSummary.totalPaid}`);
    console.log(`Total Refused: ${result.ledgerSummary.totalRefused}`);
    console.log(`Cumulative Spend: ${result.ledgerSummary.cumulativeSpendBaseUnits} base units`);
  } finally {
    ledger.close();
    await sellers.stopAll();
  }
}

if (process.argv[1]?.endsWith('runAgent.ts') || process.argv[1]?.endsWith('runAgent.js')) {
  main().catch((err) => {
    console.error('Agent execution error:', err);
    process.exit(1);
  });
}
