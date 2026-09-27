import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, formatEther, formatUnits, http, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import {
  DEFAULT_BASE_SEPOLIA_NETWORK,
  DEFAULT_BASE_SEPOLIA_USDC,
  loadConfig,
} from '../config/index.js';

dotenv.config();

const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

export interface WalletStatus {
  readonly address: `0x${string}`;
  readonly ethBalanceWei: bigint;
  readonly ethBalanceFormatted: string;
  readonly usdcBalanceBaseUnits: bigint;
  readonly usdcBalanceFormatted: string;
  readonly hasSufficientGas: boolean;
  readonly hasSufficientUsdc: boolean;
  readonly requiredUsdcBaseUnits: bigint;
}

/**
 * Initializes or reads the wallet configuration from .env without ever exposing private keys.
 */
export function getOrCreateWallet(): { privateKey: `0x${string}`; address: `0x${string}` } {
  let privateKey = (process.env.X402_PRIVATE_KEY || process.env.BUYER_PRIVATE_KEY) as
    | `0x${string}`
    | undefined;

  const envPath = path.resolve('.env');

  if (!privateKey || privateKey.startsWith('0x0000000000000000000000000000000000000000000000000000000000000001')) {
    // Generate a fresh local testnet private key
    privateKey = generatePrivateKey();
    const envContent = [
      '# Local Testnet Environment (git-ignored)',
      `X402_PRIVATE_KEY=${privateKey}`,
      `BASE_SEPOLIA_RPC_URL=https://sepolia.base.org`,
      `APPROVED_NETWORK=eip155:84532`,
      `APPROVED_USDC_ADDRESS=${DEFAULT_BASE_SEPOLIA_USDC}`,
      `MAX_PER_CALL_BASE_UNITS=500000`,
      `TOTAL_BUDGET_BASE_UNITS=5000000`,
      `LEDGER_DB_PATH=data/ledger.sqlite`,
    ].join('\n') + '\n';

    fs.writeFileSync(envPath, envContent, { encoding: 'utf8' });
  }

  const account = privateKeyToAccount(privateKey);
  return { privateKey, address: account.address };
}

/**
 * Checks on-chain wallet balances for Base Sepolia testnet.
 */
export async function checkTestnetWalletStatus(
  address: `0x${string}`,
  rpcUrl: string = 'https://sepolia.base.org',
  requiredUsdcBaseUnits: bigint = 50_000n
): Promise<WalletStatus> {
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });

  const ethBalanceWei = await publicClient.getBalance({ address });

  let usdcBalanceBaseUnits = 0n;
  try {
    usdcBalanceBaseUnits = await publicClient.readContract({
      address: DEFAULT_BASE_SEPOLIA_USDC as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [address],
    });
  } catch (err: any) {
    console.warn('Notice: Could not read USDC balance directly:', err.message);
  }

  const ethBalanceFormatted = formatEther(ethBalanceWei);
  const usdcBalanceFormatted = formatUnits(usdcBalanceBaseUnits, 6);

  return {
    address,
    ethBalanceWei,
    ethBalanceFormatted,
    usdcBalanceBaseUnits,
    usdcBalanceFormatted,
    hasSufficientGas: ethBalanceWei > 0n,
    hasSufficientUsdc: usdcBalanceBaseUnits >= requiredUsdcBaseUnits,
    requiredUsdcBaseUnits,
  };
}
