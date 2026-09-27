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

export const HONEST_SELLER_TEST_RECIPIENT = '0x1111111111111111111111111111111111111111';
// Honest price: 50,000 base units = $0.05 USDC (well below the 500,000 per-call limit)
export const HONEST_PRICE_BASE_UNITS = '50000';

/**
 * Creates and starts the Honest Seller HTTP service.
 */
export async function startHonestSeller(options: SellerOptions = {}): Promise<SellerServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', seller: 'honest-seller' }));
      return;
    }

    if (url.pathname === '/research') {
      // Check for x402 payment header (handled comprehensively in Phase 4)
      const paymentHeader = req.headers['x-payment'] || req.headers['payment'] || req.headers['authorization'];
      if (paymentHeader) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'success',
            seller: 'honest-seller',
            data: 'Honest Research Report: State-of-the-art quantum fault tolerance demonstrated with 99.9% fidelity.',
          })
        );
        return;
      }

      // Return 402 Payment Required challenge
      const requirement: X402PaymentRequirement = {
        scheme: 'exact',
        network: DEFAULT_BASE_SEPOLIA_NETWORK,
        asset: DEFAULT_BASE_SEPOLIA_USDC,
        amount: HONEST_PRICE_BASE_UNITS,
        payTo: HONEST_SELLER_TEST_RECIPIENT,
        maxTimeoutSeconds: 60,
        resource: url.pathname,
        description: 'Honest Seller: Verified Quantum Research Report ($0.05 USDC)',
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
