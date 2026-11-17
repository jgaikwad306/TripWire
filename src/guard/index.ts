import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { formatUsdc } from '../constants.js';
import { TransferRejectedError } from '../errors.js';
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
import { CHECK, allow, deny, errorMessage, includesAddress, sameAddress } from './checks.js';
import { excessOverCap } from './hold.js';
import { IntentStore, MemoryReplayLedger, type ReplayLedger, type Spend } from './intents.js';
import { addressSchema, type Policy } from './policy.js';
import { evaluateReceipt } from './receive.js';
import { checkIntentMatch, evaluateSend, normalizeItem } from './send.js';
import { MemoryGuardStore, type GuardStore, type PaymentRecord } from './store.js';

export { CHECK, type CheckName } from './checks.js';
export { JsonFileGuardStore, MemoryGuardStore, type GuardStore } from './store.js';
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
  /**
   * Where quotes, payments and used receipts are kept. Defaults to memory. Use
   * JsonFileGuardStore so limits and unfinished payments survive a restart.
   */
  store?: GuardStore;
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
  private readonly store: GuardStore;
  private readonly intents: IntentStore;
  private readonly replayLedger: ReplayLedger;
  /** Receipt hashes kept in the store. Unused when the caller supplies its own replay ledger. */
  private readonly ownReceipts: MemoryReplayLedger | undefined;
  private readonly savedReceipts: readonly string[];
  private readonly now: () => number;
  /** Every payment decided on, in this session or an earlier one. */
  private payments: readonly PaymentRecord[];
  private log: readonly Decision[] = [];
  /** Tail of the one-at-a-time queue. Never rejects. */
  private queue: Promise<unknown> = Promise.resolve();

  private readonly approvals: ApprovalDesk;

  constructor(private readonly deps: GuardDeps) {
    this.store = deps.store ?? new MemoryGuardStore();
    const saved = this.store.load();
    this.intents = new IntentStore(saved.intents);
    this.payments = saved.payments;
    this.savedReceipts = saved.usedReceipts;
    this.ownReceipts = deps.replayLedger ? undefined : new MemoryReplayLedger(saved.usedReceipts);
    this.replayLedger = deps.replayLedger ?? this.ownReceipts ?? new MemoryReplayLedger();
    this.now = deps.now ?? Date.now;
    this.approvals = deps.approvals ?? new ApprovalDesk(this.now);
  }

  /** What counts against the limits: every payment that was sent, or may have been. */
  private get spends(): readonly Spend[] {
    return this.payments
      .filter((payment) => payment.state !== 'failed')
      .map((payment) => ({ payTo: payment.payTo, amount: payment.amount, at: payment.at }));
  }

  /** Writes the current state down. Throws if it cannot, so callers can stop before money moves. */
  private persist(): void {
    this.store.save({
      intents: this.intents.all(),
      payments: this.payments,
      // With the caller's own replay ledger, receipts already in the store are left as they were.
      usedReceipts: this.ownReceipts?.all() ?? this.savedReceipts,
    });
  }

  private putPayment(payment: PaymentRecord): PaymentRecord {
    const others = this.payments.filter((existing) => existing.key !== payment.key);
    this.payments = [...others, payment];
    return payment;
  }

  /**
   * Sends a payment under its idempotency key, or asks again about one sent earlier, and
   * records how it ended. Repeating this for the same payment can never pay twice.
   */
  private async send(payment: PaymentRecord): Promise<PaymentRecord> {
    const { key, intentId, item, payTo, amount, at, delivered } = payment;
    const base = { key, intentId, item, payTo, amount, at, delivered };
    let settled: PaymentRecord;
    try {
      const { txHash } = await this.deps.wallet.transfer({ from: 'hot', to: payTo, amount, idempotencyKey: key });
      settled = this.putPayment({ ...base, state: 'sent', txHash });
    } catch (err) {
      const state = err instanceof TransferRejectedError ? 'failed' : 'unknown';
      settled = this.putPayment({ ...base, state, error: errorMessage(err) });
      if (state === 'failed') this.intents.reopen(intentId);
    }
    try {
      this.persist();
    } catch {
      // The transfer has already been attempted. If this cannot be written down, the file
      // still says "reserved" and the payment is checked again before the next one.
    }
    return settled;
  }

  /**
   * Deals with earlier payments for the same order (same item, payee and amount) before a
   * new one is considered. One whose outcome is unknown is asked about again. If it turns
   * out to have been sent and nobody was given its transaction, this request gets it:
   * that is how a purchase interrupted by a restart finishes without paying twice.
   */
  private async settleEarlierPayments(req: PaymentRequest, intent: PaymentIntent): Promise<Decision | undefined> {
    // Item names are compared the way the price check compares them, so "Report " is the
    // same order as "report" and cannot slip past an unfinished payment.
    const sameOrder = (payment: PaymentRecord): boolean =>
      normalizeItem(payment.item) === normalizeItem(intent.item) &&
      sameAddress(payment.payTo, intent.payTo) &&
      payment.amount === intent.amount;
    const unsettled = (payment: PaymentRecord): boolean => payment.state === 'reserved' || payment.state === 'unknown';

    for (const payment of this.payments.filter((p) => sameOrder(p) && unsettled(p))) {
      // The allowlist is read again: a payee the owner has removed since the attempt is
      // not paid now. Such a payment stays unsettled and blocks the order instead.
      if (includesAddress(this.deps.policy.allowlist, payment.payTo)) await this.send(payment);
    }

    const earlier = this.payments.filter(sameOrder);
    if (earlier.some(unsettled)) {
      return deny(
        CHECK.reconcile,
        'An earlier payment for this order was attempted and its outcome still cannot be confirmed, so no new payment is made. Try again shortly.',
      );
    }
    const recovered = earlier.find((payment) => payment.state === 'sent' && !payment.delivered);
    if (!recovered?.txHash) return undefined;

    const mismatch = checkIntentMatch(req, intent);
    if (mismatch) return mismatch;
    this.intents.markPaid(intent.id);
    this.putPayment({ ...recovered, delivered: true });
    try {
      this.persist();
    } catch {
      // The money is already out and the caller needs this transaction to claim the goods.
      // Failing here would lose the hash and invite a second payment for the same order.
    }
    return allow(
      'An earlier payment attempt for this order was settled and its transaction recovered, so nothing new was sent.',
      recovered.txHash,
    );
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
    const intent = this.intents.record(description === undefined ? quote : { ...quote, description }, this.now());
    this.persist();
    return intent;
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

    if (intent) {
      const settled = await this.settleEarlierPayments(req, intent);
      if (settled) return settled;
    }

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

    // Reserve before sending, and write the reservation down: a transfer can fail *after*
    // the money moved (a timeout while waiting for confirmation, the process dying), so
    // the attempt must be on record, and counted against the limits, before it is made.
    // What is paid is what the guard recorded, never what the request says.
    this.intents.markPaid(intent.id);
    const reserved = this.putPayment({
      key: randomUUID(),
      intentId: intent.id,
      item: intent.item,
      payTo: intent.payTo,
      amount: intent.amount,
      at: this.now(),
      state: 'reserved',
      delivered: false,
    });
    try {
      this.persist();
    } catch (err) {
      this.payments = this.payments.filter((payment) => payment.key !== reserved.key);
      this.intents.reopen(intent.id);
      return deny(CHECK.wallet, `Could not record the payment before sending it, so nothing was sent: ${errorMessage(err)}`);
    }

    const settled = await this.send(reserved);
    if (settled.state === 'sent' && settled.txHash) {
      this.putPayment({ ...settled, delivered: true });
      try {
        this.persist();
      } catch {
        // Paid and about to be reported. Left as undelivered on disk, it would at worst be
        // handed to the next request for the same order instead of paying again.
      }
      return allow(needsApproval ? `${verdict.reason} The owner approved this payment.` : verdict.reason, settled.txHash);
    }
    if (settled.state === 'failed') {
      return deny(
        CHECK.wallet,
        `The wallet refused the transfer, so nothing was sent and nothing counts against the limits. (${settled.error ?? 'no reason given'})`,
      );
    }
    return deny(
      CHECK.wallet,
      `Wallet transfer failed and its outcome is unknown, so it still counts against the limits. ` +
        `It will be checked again before another payment for this order is made. (${settled.error ?? 'no reason given'})`,
    );
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
      this.persist();
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
