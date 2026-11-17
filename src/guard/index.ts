import { z } from 'zod';
import { formatUsdc } from '../constants.js';
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
import { ApprovalDesk, type Approval } from './approvals.js';
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
  /**
   * Where approval requests go when the policy sets a threshold. Pass the desk the owner's
   * console is serving; without one, nobody can approve and such payments are never made.
   */
  approvals?: ApprovalDesk;
  /** How long a payment request waits for the owner before answering "not yet". Default 0. */
  approvalWaitMs?: number;
}

/** A payment the checks allow, held until the owner approves it. */
interface AwaitingApproval {
  awaiting: Approval;
}

const isAwaiting = (outcome: Decision | AwaitingApproval): outcome is AwaitingApproval => 'awaiting' in outcome;

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

  private readonly approvals: ApprovalDesk;

  constructor(private readonly deps: GuardDeps) {
    this.replayLedger = deps.replayLedger ?? new MemoryReplayLedger();
    this.now = deps.now ?? Date.now;
    this.approvals = deps.approvals ?? new ApprovalDesk(this.now);
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

  async requestPayment(req: PaymentRequest): Promise<Decision> {
    return this.record(await this.payOnceApproved(req));
  }

  /**
   * Pays, asking the owner first when the policy requires it. The wait for the owner
   * happens outside the queue so other requests are not held up, and every check runs
   * again afterwards: an approval never overrides the allowlist or the limits.
   */
  private async payOnceApproved(req: PaymentRequest): Promise<Decision> {
    const first = await this.enqueue(() => this.pay(req));
    if (!isAwaiting(first)) return first;

    const decided = await this.approvals.waitForDecision(first.awaiting.id, this.deps.approvalWaitMs ?? 0);
    if (decided?.status !== 'approved') return deny(CHECK.approval, approvalDenial(decided ?? first.awaiting));

    const second = await this.enqueue(() => this.pay(req));
    return isAwaiting(second) ? deny(CHECK.approval, approvalDenial(second.awaiting)) : second;
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

  private async pay(req: PaymentRequest): Promise<Decision | AwaitingApproval> {
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

    // Asked only after every other check has passed, so the owner is never shown a
    // payment the rules would refuse anyway.
    const needsApproval = policy.approvalThreshold !== undefined && intent.amount > policy.approvalThreshold;
    if (needsApproval) {
      if (!this.approvals.hasRoomFor(intent.id)) {
        return deny(CHECK.approval, 'Too many payments are already waiting for the owner. Wait for those to be decided, then get a new quote.');
      }
      const approval = this.approvals.request(intent, policy.approvalTtlMs);
      if (approval.status === 'pending') return { awaiting: approval };
      if (approval.status !== 'approved' || !this.approvals.consume(approval.id)) {
        return deny(CHECK.approval, approvalDenial(approval));
      }
    }

    // Reserve before sending: a transfer can fail *after* the money moved (e.g. a timeout
    // while waiting for confirmation), so a failed attempt must not stay payable or uncounted.
    this.intents.markPaid(intent.id);
    this.spends = [...this.spends, { payTo: intent.payTo, amount: intent.amount, at: this.now() }];
    try {
      // Pay what the guard recorded, never what the request says.
      const { txHash } = await wallet.transfer({ from: 'hot', to: intent.payTo, amount: intent.amount });
      return allow(needsApproval ? `${verdict.reason} The owner approved this payment.` : verdict.reason, txHash);
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

/** Why a payment that needs the owner's approval was not made. */
function approvalDenial(approval: Approval): string {
  const what = `${formatUsdc(approval.amount)} USDC to ${approval.payTo} for "${approval.item}"`;
  switch (approval.status) {
    case 'pending':
      return `Paying ${what} needs the owner's approval. It has been requested and the owner has not decided yet. Ask again with the same intent.`;
    case 'denied':
      return `The owner denied paying ${what}.`;
    case 'expired':
      return `The approval for paying ${what} expired. Get a new quote to ask again.`;
    default:
      return `The approval for paying ${what} has already been used.`;
  }
}

export function createGuard(deps: GuardDeps): Guard {
  return new GuardedWallet(deps);
}
