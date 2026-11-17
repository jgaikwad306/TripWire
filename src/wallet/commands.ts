import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ArcChainReader } from '../chain/arc.js';
import { ARC_TESTNET, explorerTxUrl, formatUsdc, parseUsdc } from '../constants.js';
import type { Address } from '../types.js';
import { CIRCLE_ROLES, CircleWallet, createCircleClient, createWalletSet, loadWallets } from './circle.js';
import { deployFakeUsdc } from './counterfeit.js';

/**
 * `npm run cli setup`
 *   First run: creates the Circle wallets and an attacker key, prints lines for .env.
 *   Later runs: prints addresses and balances.
 *   `setup --test-transfer`: sends 0.01 USDC hot → merchant to prove the pipeline works.
 */
export async function setupCommand(args: string[]): Promise<void> {
  const client = createCircleClient();
  const chain = new ArcChainReader();

  if (!process.env.WALLET_ID_HOT) {
    const { walletSetId, wallets } = await createWalletSet(client);
    const attackerKey = (process.env.ATTACKER_PRIVATE_KEY as Hex | undefined) ?? generatePrivateKey();
    console.log('Wallets created on Arc Testnet. Add these lines to .env:\n');
    console.log(`CIRCLE_WALLET_SET_ID=${walletSetId}`);
    for (const role of CIRCLE_ROLES) console.log(`WALLET_ID_${role.toUpperCase()}=${wallets[role].id}`);
    if (!process.env.ATTACKER_PRIVATE_KEY) {
      console.log(`ATTACKER_PRIVATE_KEY=${attackerKey}   # throwaway testnet key, never fund on mainnet`);
    }
    console.log(`\nThen fund these from ${ARC_TESTNET.faucetUrl} (network: Arc Testnet):`);
    console.log(`  hot       ${wallets.hot.address}`);
    console.log(`  vault     ${wallets.vault.address}`);
    console.log(`  attacker  ${privateKeyToAccount(attackerKey).address}   (gas for the counterfeit-token scenario)`);
    console.log(`\nmerchant is ${wallets.merchant.address} — no funding needed.`);
    return;
  }

  const wallets = await loadWallets(client);
  const attacker = process.env.ATTACKER_PRIVATE_KEY
    ? (privateKeyToAccount(process.env.ATTACKER_PRIVATE_KEY as Hex).address.toLowerCase() as Address)
    : undefined;
  const rows: [string, Address][] = CIRCLE_ROLES.map((role) => [role, wallets[role].address]);
  if (attacker) rows.push(['attacker', attacker]);
  for (const [role, address] of rows) {
    console.log(`${role.padEnd(9)} ${address}  ${formatUsdc(await chain.getUsdcBalance(address))} USDC`);
  }

  if (args.includes('--test-transfer')) {
    if (!attacker) throw new Error('ATTACKER_PRIVATE_KEY is not set');
    const wallet = new CircleWallet(client, chain, wallets, attacker);
    console.log('\nSending 0.01 USDC hot → merchant…');
    const { txHash } = await wallet.transfer({ from: 'hot', to: wallets.merchant.address, amount: parseUsdc('0.01') });
    const tx = await chain.getTx(txHash);
    console.log(`${tx?.status ?? 'not found'}: ${explorerTxUrl(txHash)}`);
  }
}

/** `npm run cli fake-usdc` — deploys the counterfeit token from the attacker key. */
export async function fakeUsdcCommand(): Promise<void> {
  const key = process.env.ATTACKER_PRIVATE_KEY as Hex | undefined;
  if (!key) throw new Error('ATTACKER_PRIVATE_KEY is not set — run `npm run cli setup` first');
  const address = await deployFakeUsdc(key);
  console.log(`FakeUSDC deployed. Add this line to .env:\n\nFAKE_USDC_ADDRESS=${address}`);
}
