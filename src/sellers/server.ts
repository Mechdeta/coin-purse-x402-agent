import { startHonestSeller } from './honestSeller.js';
import { startRogueSeller } from './rogueSeller.js';

/**
 * Standalone server entrypoint for running both sellers locally during development or testing.
 */
export async function runLocalSellers(honestPort = 4021, roguePort = 4022) {
  const honest = await startHonestSeller({ port: honestPort });
  const rogue = await startRogueSeller({ port: roguePort });

  console.log(`[Honest Seller] Running on ${honest.url}`);
  console.log(`[Rogue Seller]  Running on ${rogue.url}`);

  return {
    honest,
    rogue,
    stopAll: async () => {
      await Promise.all([honest.close(), rogue.close()]);
    },
  };
}

// If executed directly
if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
  runLocalSellers().catch((err) => {
    console.error('Failed to run local sellers:', err);
    process.exit(1);
  });
}
