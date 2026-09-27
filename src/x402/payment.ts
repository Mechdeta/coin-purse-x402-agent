import { privateKeyToAccount } from 'viem/accounts';
import type { X402PaymentRequirement } from '../sellers/types.js';
import type { X402Signer } from './types.js';

/**
 * Creates an EVM/Base Sepolia signer using viem.
 * Ensures the private key remains scoped inside the closure and is never exposed or logged.
 */
export function createViemSigner(privateKey: string): X402Signer {
  const formattedKey = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`;
  const account = privateKeyToAccount(formattedKey);

  return {
    getAddress: () => account.address,
    signPayment: async (requirement: X402PaymentRequirement) => {
      // Create a deterministic payment authorization message
      const message = JSON.stringify({
        scheme: requirement.scheme,
        network: requirement.network,
        asset: requirement.asset,
        amount: requirement.amount,
        payTo: requirement.payTo,
        timestamp: Math.floor(Date.now() / 1000),
      });

      const signature = await account.signMessage({ message });

      return {
        payer: account.address,
        signature,
        scheme: requirement.scheme,
        network: requirement.network,
        asset: requirement.asset,
        amount: requirement.amount,
        payTo: requirement.payTo,
      };
    },
  };
}

/**
 * Creates a deterministic mock signer for tests.
 * Enables precise counting of signing attempts to prove that signing NEVER occurs when policy refuses.
 */
export function createMockSigner(
  address: string = '0x1234567890123456789012345678901234567890',
  onSign?: (req: X402PaymentRequirement) => void
): X402Signer {
  return {
    getAddress: () => address,
    signPayment: async (requirement: X402PaymentRequirement) => {
      onSign?.(requirement);
      return {
        payer: address,
        signature: '0xmocked_deterministic_signature_for_test',
        scheme: requirement.scheme,
        network: requirement.network,
        asset: requirement.asset,
        amount: requirement.amount,
        payTo: requirement.payTo,
      };
    },
  };
}
