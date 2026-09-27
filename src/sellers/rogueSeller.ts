import http from 'node:http';
import {
  DEFAULT_BASE_SEPOLIA_NETWORK,
  DEFAULT_BASE_SEPOLIA_USDC,
} from '../config/index.js';
import type {
  SellerOptions,
  SellerServer,
  X402ChallengeResponse,
  X402PaymentRequirement,
} from './types.js';

export const ROGUE_SELLER_TEST_RECIPIENT = '0x2222222222222222222222222222222222222222';
// Rogue price: 4,990,000 base units = $4.99 USDC (substantially exceeds the 500,000 per-call limit)
export const ROGUE_PRICE_BASE_UNITS = '4990000';
// Budget drain price: 50,000,000 base units = $50.00 USDC
export const ROGUE_DRAIN_PRICE_BASE_UNITS = '50000000';

/**
 * Creates and starts the Rogue Seller HTTP service.
 * Deliberately serves abusive payment challenges to test client-side spending policy enforcement.
 */
export async function startRogueSeller(options: SellerOptions = {}): Promise<SellerServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', seller: 'rogue-seller' }));
      return;
    }

    // Rogue endpoint: Excessive price exceeding per-call ceiling ($4.99 vs $0.50 max)
    if (url.pathname === '/research') {
      const requirement: X402PaymentRequirement = {
        scheme: 'exact',
        network: DEFAULT_BASE_SEPOLIA_NETWORK,
        asset: DEFAULT_BASE_SEPOLIA_USDC,
        amount: ROGUE_PRICE_BASE_UNITS, // $4.99 USDC
        payTo: ROGUE_SELLER_TEST_RECIPIENT,
        maxTimeoutSeconds: 60,
        resource: url.pathname,
        description: 'Rogue Stall: Premium Insights (Deliberately Exorbitant $4.99 USDC)',
      };

      const challenge: X402ChallengeResponse = {
        x402Version: 1,
        error: 'Payment Required',
        accepts: [requirement],
      };

      res.writeHead(402, {
        'Content-Type': 'application/json',
        'X-Payment-Required': 'true',
      });
      res.end(JSON.stringify(challenge));
      return;
    }

    // Rogue endpoint: Total budget drain ($50.00)
    if (url.pathname === '/drain') {
      const requirement: X402PaymentRequirement = {
        scheme: 'exact',
        network: DEFAULT_BASE_SEPOLIA_NETWORK,
        asset: DEFAULT_BASE_SEPOLIA_USDC,
        amount: ROGUE_DRAIN_PRICE_BASE_UNITS,
        payTo: ROGUE_SELLER_TEST_RECIPIENT,
        maxTimeoutSeconds: 60,
        resource: url.pathname,
        description: 'Rogue Stall: Total Budget Drain Attempt ($50.00 USDC)',
      };

      res.writeHead(402, { 'Content-Type': 'application/json', 'X-Payment-Required': 'true' });
      res.end(JSON.stringify({ x402Version: 1, error: 'Payment Required', accepts: [requirement] }));
      return;
    }

    // Rogue endpoint: Unapproved Network (Ethereum Mainnet)
    if (url.pathname === '/wrong-network') {
      const requirement: X402PaymentRequirement = {
        scheme: 'exact',
        network: 'eip155:1', // Ethereum Mainnet (Unapproved)
        asset: DEFAULT_BASE_SEPOLIA_USDC,
        amount: '50000',
        payTo: ROGUE_SELLER_TEST_RECIPIENT,
        maxTimeoutSeconds: 60,
        resource: url.pathname,
        description: 'Rogue Stall: Trap network requirement',
      };

      res.writeHead(402, { 'Content-Type': 'application/json', 'X-Payment-Required': 'true' });
      res.end(JSON.stringify({ x402Version: 1, error: 'Payment Required', accepts: [requirement] }));
      return;
    }

    // Rogue endpoint: Unapproved Token Asset
    if (url.pathname === '/wrong-asset') {
      const requirement: X402PaymentRequirement = {
        scheme: 'exact',
        network: DEFAULT_BASE_SEPOLIA_NETWORK,
        asset: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead', // Unapproved token
        amount: '50000',
        payTo: ROGUE_SELLER_TEST_RECIPIENT,
        maxTimeoutSeconds: 60,
        resource: url.pathname,
        description: 'Rogue Stall: Unapproved asset requirement',
      };

      res.writeHead(402, { 'Content-Type': 'application/json', 'X-Payment-Required': 'true' });
      res.end(JSON.stringify({ x402Version: 1, error: 'Payment Required', accepts: [requirement] }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        port: actualPort,
        host,
        url: `http://${host}:${actualPort}`,
        close: async () => {
          return new Promise<void>((resClose, rejClose) => {
            server.close((err) => (err ? rejClose(err) : resClose()));
          });
        },
      });
    });
  });
}
