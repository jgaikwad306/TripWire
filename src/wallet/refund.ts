import { createWalletClient, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet, createArcClient } from '../chain/arc.js';
import { ARC_TESTNET, USDC_ADDRESS } from '../constants.js';
import type { Address, ChainReader, TxHash, Usdc } from '../types.js';

/**
 * Sends red-team funds back to the hot wallet. Unguarded runs move the hot wallet's
 * testnet USDC to the attacker and the merchant; both are ours, so the money can be
 * returned instead of going back to the faucet before every run.
 */

/** Somewhere refundable funds pile up. `keep` stays behind to pay that account's gas. */
export interface RefundSource {
  name: string;
  address: Address;
  keep: Usdc;
  send(to: Address, amount: Usdc): Promise<TxHash>;
}

export interface RefundResult {
  name: string;
  balance: Usdc;
  /** 0 when the balance was at or below `keep`. */
  amount: Usdc;
  txHash?: TxHash;
  error?: string;
}

/**
 * Moves everything above each source's reserve to `hot`. One source failing does not
 * stop the others. With `dryRun` nothing is sent and the amounts show what would move.
 */
export async function refundToHot(opts: {
  chain: ChainReader;
  hot: Address;
  sources: readonly RefundSource[];
  dryRun?: boolean;
}): Promise<RefundResult[]> {
  const results: RefundResult[] = [];
  for (const source of opts.sources) {
    const balance = await opts.chain.getUsdcBalance(source.address);
    const amount = balance > source.keep ? balance - source.keep : 0n;
    const result: RefundResult = { name: source.name, balance, amount };
    if (amount > 0n && !opts.dryRun) {
      try {
        result.txHash = await source.send(opts.hot, amount);
      } catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
      }
    }
    results.push(result);
  }
  return results;
}

const erc20 = parseAbi(['function transfer(address to, uint256 value) returns (bool)']);

/** Real-USDC transfer signed by the attacker's throwaway key (not a guarded wallet). */
export async function sendUsdcFromAttacker(privateKey: Hex, to: Address, amount: Usdc): Promise<TxHash> {
  const rpcUrl = process.env.ARC_RPC_URL || ARC_TESTNET.defaultRpcUrl;
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(rpcUrl) });
  const hash = await wallet.writeContract({ address: USDC_ADDRESS, abi: erc20, functionName: 'transfer', args: [to, amount] });
  const receipt = await createArcClient(rpcUrl).waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Transfer reverted (${hash})`);
  return hash;
}
