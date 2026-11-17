import { parseArgs } from 'node:util';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ArcChainReader } from '../chain/arc.js';
import { ARC_TESTNET, explorerTxUrl, formatUsdc, parseUsdc } from '../constants.js';
import type { Address } from '../types.js';
import { CIRCLE_ROLES, CircleWallet, createCircleClient, createWalletSet, loadWallets } from './circle.js';
import { deployFakeUsdc } from './counterfeit.js';
import { refundToHot, sendUsdcFromAttacker } from './refund.js';

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

/** Left with the attacker so it can still pay gas for the counterfeit-token scenario. */
const DEFAULT_ATTACKER_KEEP = '1';
/** Left with the merchant so its own refund transfer can pay gas. */
const MERCHANT_KEEP = parseUsdc('0.1');

/**
 * `npm run cli refund [--keep <usdc>] [--dry-run]`
 * Returns testnet USDC from the attacker address and the merchant wallet to the hot
 * wallet, so an unguarded run can be repeated without another trip to the faucet.
 */
export async function refundCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { keep: { type: 'string', default: DEFAULT_ATTACKER_KEEP }, 'dry-run': { type: 'boolean', default: false } },
  });
  const key = process.env.ATTACKER_PRIVATE_KEY as Hex | undefined;
  if (!key) throw new Error('ATTACKER_PRIVATE_KEY is not set — run `npm run cli setup` first');

  const client = createCircleClient();
  const chain = new ArcChainReader();
  const wallets = await loadWallets(client);
  const attacker = privateKeyToAccount(key).address.toLowerCase() as Address;
  const wallet = new CircleWallet(client, chain, wallets, attacker);

  const results = await refundToHot({
    chain,
    hot: wallets.hot.address,
    dryRun: values['dry-run'],
    sources: [
      { name: 'attacker', address: attacker, keep: parseUsdc(values.keep), send: (to, amount) => sendUsdcFromAttacker(key, to, amount) },
      {
        name: 'merchant',
        address: wallets.merchant.address,
        keep: MERCHANT_KEEP,
        send: async (to, amount) => (await wallet.transfer({ from: 'merchant', to, amount })).txHash,
      },
    ],
  });

  for (const r of results) {
    const label = r.name.padEnd(9);
    if (r.amount === 0n) console.log(`${label} holds ${formatUsdc(r.balance)} USDC, nothing to return.`);
    else if (r.error) console.log(`${label} FAILED to return ${formatUsdc(r.amount)} USDC: ${r.error}`);
    else if (r.txHash) console.log(`${label} returned ${formatUsdc(r.amount)} USDC: ${explorerTxUrl(r.txHash)}`);
    else console.log(`${label} would return ${formatUsdc(r.amount)} of ${formatUsdc(r.balance)} USDC (dry run).`);
  }
  console.log(`\nHot wallet now holds ${formatUsdc(await chain.getUsdcBalance(wallets.hot.address))} USDC.`);
  if (results.some((r) => r.error)) process.exitCode = 1;
}

/** `npm run cli fake-usdc` — deploys the counterfeit token from the attacker key. */
export async function fakeUsdcCommand(): Promise<void> {
  const key = process.env.ATTACKER_PRIVATE_KEY as Hex | undefined;
  if (!key) throw new Error('ATTACKER_PRIVATE_KEY is not set — run `npm run cli setup` first');
  const address = await deployFakeUsdc(key);
  console.log(`FakeUSDC deployed. Add this line to .env:\n\nFAKE_USDC_ADDRESS=${address}`);
}
