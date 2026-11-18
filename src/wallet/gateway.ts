import { encodeFunctionData, erc20Abi, parseAbi } from 'viem';
import { ARC_TESTNET, USDC_ADDRESS, explorerTxUrl, formatUsdc, parseUsdc } from '../constants.js';
import type { WalletRole } from '../types.js';
import { GATEWAY_WALLET, HttpGatewayReader } from '../x402/gateway.js';

const GATEWAY_WALLET_ABI = parseAbi(['function deposit(address token, uint256 value)']);
/** Most one deposit command moves: testnet funds, but a typo should not empty the wallet. */
const MAX_DEPOSIT = parseUsdc('10');

const USAGE = `Usage:
  npm run setup-wallets                 wallet addresses, USDC balances and Circle Gateway balances
  npm run gateway:deposit -- <usdc>     deposit USDC from the hot wallet into Gateway (max ${formatUsdc(MAX_DEPOSIT)})

Gateway nanopayments are drawn from the hot wallet's Gateway balance, not its wallet balance.
Fund the hot wallet first at ${ARC_TESTNET.faucetUrl} (Arc uses USDC as gas).`;

const ROLES: readonly WalletRole[] = ['hot', 'vault', 'merchant', 'attacker'];
const LABEL: Record<WalletRole, string> = {
  hot: 'hot (agent spends)',
  vault: 'vault (cold storage)',
  merchant: 'seller (paid API payee)',
  attacker: 'attacker (we control it)',
};

/** `npm run cli gateway <status|deposit>` — Circle Gateway setup for the agent's wallet. */
export async function gatewayCommand(args: string[], log: (line: string) => void = console.log, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const [action, amount] = args;
  if (action !== 'status' && action !== 'deposit') {
    log(USAGE);
    return;
  }
  const { createLiveWallet } = await import('./index.js');
  const { wallet, chain } = await createLiveWallet();
  const gateway = new HttpGatewayReader(env.GATEWAY_API_URL || undefined);

  if (action === 'deposit') {
    if (!amount) throw new Error(`Say how much to deposit.\n\n${USAGE}`);
    const value = parseUsdc(amount);
    if (value <= 0n || value > MAX_DEPOSIT) throw new Error(`Deposit between 0 and ${formatUsdc(MAX_DEPOSIT)} USDC.`);
    const held = await chain.getUsdcBalance(wallet.addressOf('hot'));
    if (held <= value) throw new Error(`The hot wallet holds ${formatUsdc(held)} USDC, which must also cover gas. Fund it at ${ARC_TESTNET.faucetUrl}.`);
    // Never a plain transfer to the Gateway Wallet: that USDC would be lost. approve, then deposit().
    log(`Approving the Gateway Wallet ${GATEWAY_WALLET} to take ${formatUsdc(value)} USDC…`);
    const approveTx = await wallet.execute('hot', USDC_ADDRESS, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [GATEWAY_WALLET, value] }));
    log(`  approved: ${explorerTxUrl(approveTx)}`);
    log(`Depositing ${formatUsdc(value)} USDC into Circle Gateway…`);
    const depositTx = await wallet.execute('hot', GATEWAY_WALLET, encodeFunctionData({ abi: GATEWAY_WALLET_ABI, functionName: 'deposit', args: [USDC_ADDRESS, value] }));
    log(`  deposited: ${explorerTxUrl(depositTx)}`);
    log('Gateway credits a deposit once the block is final; the balance below may take a minute to show it.');
  }

  log('\nRole                        Address                                      Wallet USDC   Gateway USDC');
  for (const role of ROLES) {
    const address = wallet.addressOf(role);
    const [held, deposited] = await Promise.all([
      chain.getUsdcBalance(address).then(formatUsdc).catch(() => '?'),
      gateway.balanceDetail(address).then((b) => formatUsdc(b.available) + (b.pending > 0n ? ` (+${formatUsdc(b.pending)} pending)` : '')).catch(() => '?'),
    ]);
    log(`${LABEL[role].padEnd(28)}${address}  ${held.padStart(11)}  ${deposited.padStart(13)}`);
  }
  log('\nPending: nanopayments Gateway has accepted and will settle onchain in its next batch.');
  log(`\nSeller address for the paid API: ${wallet.addressOf('merchant')}`);
  log(`Attacker address (guard-off attacks pay it): ${wallet.addressOf('attacker')}`);
  log(`Gateway Wallet contract on Arc Testnet: ${GATEWAY_WALLET}`);
}
