import type { ActivityReader, UsdcTransfer } from '../chain/activity.js';
import { USDC_ADDRESS } from '../constants.js';
import { TransferRejectedError } from '../errors.js';
import type { Address, ChainReader, TokenTransfer, TxHash, TxInfo, Usdc, WalletProvider, WalletRole } from '../types.js';

export const FAKE_ADDRESSES: Record<WalletRole, Address> = {
  vault: '0x00000000000000000000000000000000000000a1',
  hot: '0x00000000000000000000000000000000000000a2',
  merchant: '0x00000000000000000000000000000000000000a3',
  attacker: '0x00000000000000000000000000000000000000a4',
};

/** Address of the counterfeit token used in the "fake USDC" scenario. */
export const FAKE_TOKEN_ADDRESS: Address = '0x00000000000000000000000000000000000fa4e0';

/**
 * In-memory stand-in for Arc + Circle wallets. Implements both WalletProvider and
 * ChainReader over one ledger, so a transfer made through the wallet is visible to
 * the chain reader — just like the real thing. No network, no keys.
 *
 * Lane A replaces this with CircleWallet + ArcChainReader; everyone else tests against it.
 */
export class FakeLedger implements WalletProvider, ChainReader, ActivityReader {
  private balances = new Map<Address, Usdc>();
  private txs = new Map<TxHash, TxInfo>();
  private nonce = 0;
  private byKey = new Map<string, TxHash>();

  constructor(initial: Partial<Record<WalletRole, Usdc>> = {}) {
    for (const [role, amount] of Object.entries(initial) as [WalletRole, Usdc][]) {
      this.balances.set(FAKE_ADDRESSES[role], amount);
    }
  }

  addressOf(role: WalletRole): Address {
    return FAKE_ADDRESSES[role];
  }

  async getBalance(role: WalletRole): Promise<Usdc> {
    return this.getUsdcBalance(FAKE_ADDRESSES[role]);
  }

  async transfer(args: { from: WalletRole; to: Address; amount: Usdc; idempotencyKey?: string }): Promise<{ txHash: TxHash }> {
    // As with Circle: a request repeated under the same key returns the first transaction.
    const earlier = args.idempotencyKey ? this.byKey.get(args.idempotencyKey) : undefined;
    if (earlier) return { txHash: earlier };
    const txHash = this.transferFrom(FAKE_ADDRESSES[args.from], args.to, args.amount);
    if (args.idempotencyKey) this.byKey.set(args.idempotencyKey, txHash);
    return { txHash };
  }

  async getTx(txHash: TxHash): Promise<TxInfo | null> {
    return this.txs.get(txHash) ?? null;
  }

  async getUsdcBalance(address: Address): Promise<Usdc> {
    return this.balances.get(norm(address)) ?? 0n;
  }

  /** USDC transfers the address sent or received, newest first. A transaction's position stands in for its block. */
  async getUsdcActivity(address: Address, limit: number): Promise<UsdcTransfer[]> {
    const wanted = norm(address);
    const found = [...this.txs.values()].flatMap((tx, index) =>
      tx.transfers
        .filter((t) => norm(t.token) === norm(USDC_ADDRESS) && (norm(t.from) === wanted || norm(t.to) === wanted))
        .map((t): UsdcTransfer => ({ txHash: tx.txHash, from: norm(t.from), to: norm(t.to), amount: t.value, blockNumber: index + 1 })),
    );
    return found.reverse().slice(0, limit);
  }

  // ── test helpers (not part of either interface) ──

  /** Real-USDC transfer from any address, e.g. a customer paying the merchant. */
  transferFrom(from: Address, to: Address, amount: Usdc): TxHash {
    if (amount <= 0n) throw new TransferRejectedError('Amount must be positive');
    const fromBal = this.balances.get(norm(from)) ?? 0n;
    if (fromBal < amount) throw new TransferRejectedError(`Insufficient balance: has ${fromBal}, needs ${amount}`);
    this.balances.set(norm(from), fromBal - amount);
    this.balances.set(norm(to), (this.balances.get(norm(to)) ?? 0n) + amount);
    return this.record([{ token: USDC_ADDRESS, from, to, value: amount }]);
  }

  /** Give an address USDC out of thin air (the faucet). */
  fund(address: Address, amount: Usdc): void {
    this.balances.set(norm(address), (this.balances.get(norm(address)) ?? 0n) + amount);
  }

  /** A confirmed tx that moves a counterfeit token — USDC balances do not change. */
  counterfeitTransfer(from: Address, to: Address, amount: bigint, token: Address = FAKE_TOKEN_ADDRESS): TxHash {
    return this.record([{ token, from, to, value: amount }]);
  }

  /** A well-formed hash that does not exist onchain. */
  nonexistentTxHash(): TxHash {
    return `0x${'dead'.repeat(16)}`;
  }

  private record(transfers: TokenTransfer[]): TxHash {
    const txHash = `0x${(++this.nonce).toString(16).padStart(64, '0')}` as TxHash;
    this.txs.set(txHash, { txHash, status: 'success', confirmations: 1, transfers });
    return txHash;
  }
}

const norm = (a: Address): Address => a.toLowerCase() as Address;
