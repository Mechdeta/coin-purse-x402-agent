import { getOrCreateWallet, checkTestnetWalletStatus } from './testnetRunner.js';

async function main() {
  const wallet = getOrCreateWallet();
  console.log(`Wallet address: ${wallet.address}`);
  console.log('Network: Base Sepolia (chain ID 84532)');
  console.log('Approved USDC Asset: 0x036cbd53842c5426634e7929541ec2318f3dcf7e');

  try {
    const status = await checkTestnetWalletStatus(wallet.address);
    console.log(`ETH Balance (for gas): ${status.ethBalanceFormatted} ETH`);
    console.log(`USDC Balance: ${status.usdcBalanceFormatted} USDC (${status.usdcBalanceBaseUnits.toString()} base units)`);
    console.log(`Has sufficient gas: ${status.hasSufficientGas}`);
    console.log(`Has sufficient USDC (>= 50,000 base units): ${status.hasSufficientUsdc}`);
  } catch (err: any) {
    console.error('Failed to query Base Sepolia RPC:', err.message);
  }
}

main();
