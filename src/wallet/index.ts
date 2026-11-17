import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ArcChainReader } from '../chain/arc.js';
import type { Address, ChainReader, WalletProvider } from '../types.js';
import { CircleWallet, createCircleClient, loadWallets } from './circle.js';

export * from './circle.js';
export { compileFakeUsdc, deployFakeUsdc, sendCounterfeit } from './counterfeit.js';

export function attackerAddress(env: NodeJS.ProcessEnv = process.env): Address {
  const key = env.ATTACKER_PRIVATE_KEY;
  if (!key) throw new Error('ATTACKER_PRIVATE_KEY is not set — run `npm run cli setup` first');
  return privateKeyToAccount(key as Hex).address.toLowerCase() as Address;
}

/** The real wallet and chain reader, built from .env. This is what other lanes call. */
export async function createLiveWallet(): Promise<{ wallet: WalletProvider; chain: ChainReader }> {
  const client = createCircleClient();
  const chain = new ArcChainReader();
  const wallet = new CircleWallet(client, chain, await loadWallets(client), attackerAddress());
  return { wallet, chain };
}
