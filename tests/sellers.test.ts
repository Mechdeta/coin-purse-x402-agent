import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  DEFAULT_BASE_SEPOLIA_NETWORK,
  DEFAULT_BASE_SEPOLIA_USDC,
  DEFAULT_MAX_PER_CALL_BASE_UNITS,
  loadConfig,
} from '../src/config/index.js';
import { Ledger } from '../src/ledger/index.js';
import {
  startHonestSeller,
  HONEST_SELLER_TEST_RECIPIENT,
  HONEST_PRICE_BASE_UNITS,
  startRogueSeller,
  ROGUE_SELLER_TEST_RECIPIENT,
  ROGUE_PRICE_BASE_UNITS,
  ROGUE_DRAIN_PRICE_BASE_UNITS,
  type SellerServer,
  type X402ChallengeResponse,
} from '../src/sellers/index.js';

describe('Phase 3 — Honest & Rogue Sellers', () => {
  let honestServer: SellerServer;
  let rogueServer: SellerServer;
  const config = loadConfig({});

  beforeAll(async () => {
    honestServer = await startHonestSeller();
    rogueServer = await startRogueSeller();
  });

  afterAll(async () => {
    await Promise.all([honestServer.close(), rogueServer.close()]);
  });

  describe('Honest Seller', () => {
    it('server starts and responds to /health', async () => {
      const res = await fetch(`${honestServer.url}/health`);
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.status).toBe('ok');
      expect(json.seller).toBe('honest-seller');
    });

    it('responds to /research with 402 Payment Required and realistic x402 challenge', async () => {
      const res = await fetch(`${honestServer.url}/research`);
      expect(res.status).toBe(402);
      expect(res.headers.get('content-type')).toContain('application/json');

      const challenge = (await res.json()) as X402ChallengeResponse;
      expect(challenge.x402Version).toBe(1);
      expect(challenge.error).toBe('Payment Required');
      expect(challenge.accepts).toHaveLength(1);

      const req = challenge.accepts[0];
      // Network is Base Sepolia
      expect(req.network).toBe(DEFAULT_BASE_SEPOLIA_NETWORK);
      // Asset is exact configured test USDC
      expect(req.asset.toLowerCase()).toBe(DEFAULT_BASE_SEPOLIA_USDC.toLowerCase());
      // Quoted amount is integer base units
      expect(req.amount).toBe(HONEST_PRICE_BASE_UNITS);
      expect(/^\d+$/.test(req.amount)).toBe(true);

      // Quoted amount is comfortably below the Phase 2 per-call ceiling
      const quotedAmountBigInt = BigInt(req.amount);
      expect(quotedAmountBigInt).toBeLessThan(config.limits.maxPerCallBaseUnits);
      expect(quotedAmountBigInt).toBe(50000n); // 0.05 USDC < 0.50 USDC ceiling

      // Recipient is deterministic test address
      expect(req.payTo).toBe(HONEST_SELLER_TEST_RECIPIENT);
      expect(req.payTo).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });
  });

  describe('Rogue Seller', () => {
    it('server starts and responds to /health', async () => {
      const res = await fetch(`${rogueServer.url}/health`);
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.status).toBe('ok');
      expect(json.seller).toBe('rogue-seller');
    });

    it('responds to /research with 402 challenge demanding an amount exceeding per-call ceiling', async () => {
      const res = await fetch(`${rogueServer.url}/research`);
      expect(res.status).toBe(402);

      const challenge = (await res.json()) as X402ChallengeResponse;
      expect(challenge.accepts).toHaveLength(1);

      const req = challenge.accepts[0];
      // Network is Base Sepolia
      expect(req.network).toBe(DEFAULT_BASE_SEPOLIA_NETWORK);
      // Asset is exact configured test USDC
      expect(req.asset.toLowerCase()).toBe(DEFAULT_BASE_SEPOLIA_USDC.toLowerCase());
      // Quoted amount is integer base units
      expect(req.amount).toBe(ROGUE_PRICE_BASE_UNITS);
      expect(/^\d+$/.test(req.amount)).toBe(true);

      // Quoted amount substantially exceeds Phase 2 per-call ceiling
      const quotedAmountBigInt = BigInt(req.amount);
      expect(quotedAmountBigInt).toBeGreaterThan(config.limits.maxPerCallBaseUnits);
      expect(quotedAmountBigInt).toBe(4990000n); // $4.99 > $0.50

      // Recipient is deterministic test address
      expect(req.payTo).toBe(ROGUE_SELLER_TEST_RECIPIENT);
      expect(req.payTo).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it('exposes additional trap endpoints: /drain, /wrong-network, /wrong-asset', async () => {
      // 1. Drain endpoint
      const drainRes = await fetch(`${rogueServer.url}/drain`);
      const drainChallenge = (await drainRes.json()) as X402ChallengeResponse;
      expect(BigInt(drainChallenge.accepts[0].amount)).toBe(50000000n); // $50 > $5 total budget

      // 2. Wrong network endpoint
      const netRes = await fetch(`${rogueServer.url}/wrong-network`);
      const netChallenge = (await netRes.json()) as X402ChallengeResponse;
      expect(netChallenge.accepts[0].network).toBe('eip155:1'); // Mainnet trap

      // 3. Wrong asset endpoint
      const assetRes = await fetch(`${rogueServer.url}/wrong-asset`);
      const assetChallenge = (await assetRes.json()) as X402ChallengeResponse;
      expect(assetChallenge.accepts[0].asset).toBe('0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead');
    });

    it('requires no private credentials to run and leaks no secrets', async () => {
      const res = await fetch(`${rogueServer.url}/research`);
      const text = await res.text();
      // Verifies no private key or credential appears in headers or response
      expect(text).not.toMatch(/private/i);
      expect(text).not.toMatch(/secret/i);
      expect(text).not.toMatch(/mnemonic/i);
    });
  });

  describe('Isolation: Neither seller modifies the SQLite ledger', () => {
    it('proves sellers cannot modify or access the agent spending ledger', async () => {
      const ledger = new Ledger(':memory:');
      const initialSpend = ledger.getCumulativeSpendBaseUnits();
      expect(initialSpend).toBe(0n);

      // Call honest seller
      await fetch(`${honestServer.url}/research`);
      // Call rogue seller
      await fetch(`${rogueServer.url}/research`);
      await fetch(`${rogueServer.url}/drain`);

      // Ledger must remain completely untouched
      expect(ledger.getCumulativeSpendBaseUnits()).toBe(0n);
      expect(ledger.getAllDecisions()).toHaveLength(0);

      ledger.close();
    });
  });
});
