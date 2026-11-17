import { z } from 'zod';
import type {
  ChainReader,
  Decision,
  Guard,
  PaymentIntent,
  PaymentRequest,
  Quote,
  QuoteFetcher,
  ReceiptRequest,
  TxInfo,
  Usdc,
  WalletProvider,
} from '../types.js';
import { CHECK, allow, deny, errorMessage } from './checks.js';
import { excessOverCap } from './hold.js';
import { IntentStore, MemoryReplayLedger, type ReplayLedger, type Spend } from './intents.js';
import { addressSchema, type Policy } from './policy.js';
import { evaluateReceipt } from './receive.js';
import { evaluateSend } from './send.js';

export { CHECK, type CheckName } from './checks.js';
export { JsonFileReplayLedger, MemoryReplayLedger, type ReplayLedger } from './intents.js';
export { defaultPolicy, parsePolicy, type Policy } from './policy.js';

export interface GuardDeps {
  wallet: WalletProvider;
  chain: ChainReader;
  fetchQuote: QuoteFetcher;
  policy: Policy;
  /** Defaults to in-memory. Use JsonFileReplayLedger to survive restarts. */
  replayLedger?: ReplayLedger;
  /** Clock, injectable for tests. */
  now?: () => number;
}

/** What a merchant's quote must look like before the guard records it. */
const quoteSchema = z.object({
  payTo: addressSchema,
  amount: z.bigint().positive(),
  description: z.string().optional(),
});

/**
 * The real guard: the only object that holds the wallet. The agent reaches money
 * exclusively through getQuote / requestPayment, and policy is fixed at construction.
 *
 * Money only ever leaves the hot wallet. The vault is a destination (rebalance), never a source.
 */
class GuardedWallet implements Guard {
  private readonly intents = new IntentStore();
  private readonly replayLedger: ReplayLedger;
  private readonly now: () => number;
  private spends: readonly Spend[] = [];
  private log: readonly Decision[] = [];
  /** Tail of the one-at-a-time queue. Never rejects. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: GuardDeps) {
    this.replayLedger = deps.replayLedger ?? new MemoryReplayLedger();
    this.now = deps.now ?? Date.now;
  }

  async getQuote(merchantUrl: string, item: string): Promise<PaymentIntent> {
    const raw: unknown = await this.deps.fetchQuote(merchantUrl, item);
    const parsed = quoteSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`Invalid quote from ${merchantUrl}: ${issues}`);
    }
    // Record what we asked for, not the merchant's echo of it.
    const quote: Quote = { merchantUrl, item, payTo: parsed.data.payTo, amount: parsed.data.amount };
    const description = parsed.data.description;
    return this.intents.record(description === undefined ? quote : { ...quote, description }, this.now());
  }

  requestPayment(req: PaymentRequest): Promise<Decision> {
    return this.enqueue(async () => this.record(await this.pay(req)));
  }

  verifyReceipt(req: ReceiptRequest): Promise<Decision> {
    return this.enqueue(async () => this.record(await this.checkReceipt(req)));
  }

  rebalance(): Promise<void> {
    return this.enqueue(async () => {
      const { wallet, policy } = this.deps;
      const excess = excessOverCap(await wallet.getBalance('hot'), policy.hotBalanceCap);
      if (excess === 0n) return;
      try {
        await wallet.transfer({ from: 'hot', to: wallet.addressOf('vault'), amount: excess });
      } catch (err) {
        throw new Error(`Rebalance to vault failed: ${errorMessage(err)}`);
      }
    });
  }

  hotBalance(): Promise<Usdc> {
    return this.deps.wallet.getBalance('hot');
  }

  decisions(): Decision[] {
    return [...this.log];
  }

  private async pay(req: PaymentRequest): Promise<Decision> {
    const { wallet, policy } = this.deps;
    if (!isObject(req)) return deny(CHECK.intentMatch, 'Malformed payment request.');
    const intent = typeof req.intentId === 'string' ? this.intents.get(req.intentId) : undefined;

    let hotBalance: Usdc;
    try {
      hotBalance = await wallet.getBalance('hot');
    } catch (err) {
      return deny(CHECK.wallet, `Could not read the hot balance, nothing was sent: ${errorMessage(err)}`);
    }
    const verdict = evaluateSend(req, { intent, spends: this.spends, hotBalance }, policy, this.now());
    if (!verdict.allowed || !intent) return verdict;

    // Reserve before sending: a transfer can fail *after* the money moved (e.g. a timeout
    // while waiting for confirmation), so a failed attempt must not stay payable or uncounted.
    this.intents.markPaid(intent.id);
    this.spends = [...this.spends, { payTo: intent.payTo, amount: intent.amount, at: this.now() }];
    try {
      // Pay what the guard recorded, never what the request says.
      const { txHash } = await wallet.transfer({ from: 'hot', to: intent.payTo, amount: intent.amount });
      return allow(verdict.reason, txHash);
    } catch (err) {
      return deny(
        CHECK.wallet,
        `Wallet transfer failed and its outcome is unknown, so this intent is closed and still counts against limits. ` +
          `Get a new quote to try again. (${errorMessage(err)})`,
      );
    }
  }

  private async checkReceipt(req: ReceiptRequest): Promise<Decision> {
    if (!isObject(req) || typeof req.txHash !== 'string') {
      return deny(CHECK.txExists, 'Malformed receipt request.');
    }
    let tx: TxInfo | null;
    try {
      tx = await this.deps.chain.getTx(req.txHash);
    } catch (err) {
      return deny(CHECK.chain, `Could not read the chain, so the payment is unverified: ${errorMessage(err)}`);
    }
    const verdict = evaluateReceipt(req, tx, this.replayLedger.has(req.txHash), this.deps.policy);
    if (!verdict.allowed) return verdict;
    try {
      this.replayLedger.add(req.txHash);
    } catch (err) {
      // Without a record of this hash it could be replayed, so do not accept it.
      return deny(CHECK.replay, `Could not record this transaction in the replay ledger: ${errorMessage(err)}`);
    }
    return verdict;
  }

  private record(decision: Decision): Decision {
    this.log = [...this.log, decision];
    return decision;
  }

  /** Runs tasks strictly one after another so parallel requests cannot race past a check. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

export function createGuard(deps: GuardDeps): Guard {
  return new GuardedWallet(deps);
}
