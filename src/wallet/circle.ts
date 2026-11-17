import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { ARC_TESTNET, USDC_ADDRESS, formatUsdc } from '../constants.js';
import type { Address, ChainReader, TxHash, Usdc, WalletProvider, WalletRole } from '../types.js';

/** Roles backed by a Circle wallet. The attacker is a plain address we only watch. */
export type CircleRole = Exclude<WalletRole, 'attacker'>;
export const CIRCLE_ROLES: readonly CircleRole[] = ['vault', 'hot', 'merchant'];

/** The slice of the Circle SDK client this file uses — narrow so tests can fake it. */
export interface CircleClientLike {
  createWalletSet(input: { name: string }): Promise<{ data?: { walletSet?: { id: string } } }>;
  createWallets(input: {
    walletSetId: string;
    blockchains: ['ARC-TESTNET'];
    count: number;
    accountType: 'EOA';
  }): Promise<{ data?: { wallets?: { id: string; address: string }[] } }>;
  getWallet(input: { id: string }): Promise<{ data?: { wallet?: { id: string; address: string } } }>;
  createTransaction(input: {
    walletId: string;
    tokenAddress: string;
    blockchain: 'ARC-TESTNET';
    amount: string[];
    destinationAddress: string;
    fee: { type: 'level'; config: { feeLevel: 'MEDIUM' } };
  }): Promise<{ data?: { id: string } }>;
  getTransaction(input: {
    id: string;
  }): Promise<{ data?: { transaction?: { state: string; txHash?: string; errorReason?: string } } }>;
}

export function createCircleClient(
  apiKey = process.env.CIRCLE_API_KEY,
  entitySecret = process.env.CIRCLE_ENTITY_SECRET,
): CircleClientLike {
  if (!apiKey || !entitySecret) {
    throw new Error('CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET must be set in .env');
  }
  return initiateDeveloperControlledWalletsClient({ apiKey, entitySecret }) as unknown as CircleClientLike;
}

export interface CircleWalletRef {
  id: string;
  address: Address;
}

const DONE = new Set(['CONFIRMED', 'COMPLETE']);
const DEAD = new Set(['FAILED', 'DENIED', 'CANCELLED']);

/**
 * WalletProvider over Circle Developer-Controlled Wallets on Arc Testnet.
 * Keys live in Circle's MPC infrastructure; this process only holds the API key
 * and entity secret. Balances are read straight from the chain so they are always
 * in 6-decimal USDC units regardless of how Circle labels the native token.
 */
export class CircleWallet implements WalletProvider {
  constructor(
    private readonly client: CircleClientLike,
    private readonly chain: ChainReader,
    private readonly wallets: Record<CircleRole, CircleWalletRef>,
    private readonly attacker: Address,
    private readonly opts: { pollMs?: number; timeoutMs?: number } = {},
  ) {}

  addressOf(role: WalletRole): Address {
    return role === 'attacker' ? this.attacker : this.wallets[role].address;
  }

  getBalance(role: WalletRole): Promise<Usdc> {
    return this.chain.getUsdcBalance(this.addressOf(role));
  }

  async transfer(args: { from: WalletRole; to: Address; amount: Usdc }): Promise<{ txHash: TxHash }> {
    if (args.from === 'attacker') throw new Error('The attacker address is watch-only');
    if (args.amount <= 0n) throw new Error('Amount must be positive');

    const created = await this.client.createTransaction({
      walletId: this.wallets[args.from].id,
      tokenAddress: USDC_ADDRESS,
      blockchain: ARC_TESTNET.circleBlockchain,
      amount: [formatUsdc(args.amount)],
      destinationAddress: args.to,
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });
    const id = created.data?.id;
    if (!id) throw new Error('Circle did not return a transaction id');
    return { txHash: await this.waitForTx(id) };
  }

  private async waitForTx(id: string): Promise<TxHash> {
    const pollMs = this.opts.pollMs ?? 1000;
    const deadline = Date.now() + (this.opts.timeoutMs ?? 60_000);
    for (;;) {
      const tx = (await this.client.getTransaction({ id })).data?.transaction;
      if (tx && DEAD.has(tx.state)) {
        throw new Error(`Circle transaction ${id} ${tx.state}${tx.errorReason ? `: ${tx.errorReason}` : ''}`);
      }
      if (tx && DONE.has(tx.state) && tx.txHash) return tx.txHash as TxHash;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Circle transaction ${id} (last state: ${tx?.state ?? 'unknown'})`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}

/** Creates a wallet set with one EOA wallet per role on Arc Testnet. */
export async function createWalletSet(
  client: CircleClientLike,
  name = 'agent-wallet-guard',
): Promise<{ walletSetId: string; wallets: Record<CircleRole, CircleWalletRef> }> {
  const walletSetId = (await client.createWalletSet({ name })).data?.walletSet?.id;
  if (!walletSetId) throw new Error('Circle did not return a wallet set id');
  const created = (
    await client.createWallets({
      walletSetId,
      blockchains: [ARC_TESTNET.circleBlockchain],
      count: CIRCLE_ROLES.length,
      accountType: 'EOA',
    })
  ).data?.wallets;
  if (!created || created.length !== CIRCLE_ROLES.length) {
    throw new Error(`Expected ${CIRCLE_ROLES.length} wallets from Circle, got ${created?.length ?? 0}`);
  }
  const wallets = Object.fromEntries(
    CIRCLE_ROLES.map((role, i) => [role, { id: created[i]!.id, address: created[i]!.address as Address }]),
  ) as Record<CircleRole, CircleWalletRef>;
  return { walletSetId, wallets };
}

/** Looks up the addresses of wallets whose ids are already in the environment. */
export async function loadWallets(
  client: CircleClientLike,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<CircleRole, CircleWalletRef>> {
  const entries = await Promise.all(
    CIRCLE_ROLES.map(async (role) => {
      const id = env[`WALLET_ID_${role.toUpperCase()}`];
      if (!id) throw new Error(`WALLET_ID_${role.toUpperCase()} is not set — run \`npm run cli setup\` first`);
      const address = (await client.getWallet({ id })).data?.wallet?.address;
      if (!address) throw new Error(`Circle has no wallet with id ${id} (${role})`);
      return [role, { id, address: address as Address }] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<CircleRole, CircleWalletRef>;
}
