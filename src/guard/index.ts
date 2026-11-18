import { randomUUID } from 'node:crypto';
import { recoverTypedDataAddress } from 'viem';
import { z } from 'zod';
import { USDC_ADDRESS, formatUsdc } from '../constants.js';
import { GATEWAY_VALIDITY_SECONDS, transferCounts, type GatewayReader, type GatewayTransfer } from '../x402/gateway.js';
import { TransferRejectedError } from '../errors.js';
import type {
  ChainReader,
  Decision,
  Guard,
  IncomingPayment,
  PaidRequest,
  PaidResponse,
  PaymentIntent,
  PaymentRequest,
  Quote,
  QuoteFetcher,
  TxHash,
  TxInfo,
  Usdc,
  WalletProvider,
} from '../types.js';
import { presentPayment, type MerchantAnswer } from '../x402/client.js';
import type { Facilitator } from '../x402/facilitator.js';
import {
  HEADER,
  MAX_TIMEOUT_SECONDS,
  authorizationTypedData,
  decode,
  eip3009Of,
  encode,
  isGatewayOption,
  nonceFor,
  pickRequirements,
  signPayment,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
} from '../x402/protocol.js';
import { endpointOf, evaluateApi, isApprovedResource, requestKey, type ApiSpend } from './api.js';
import { ApprovalDesk, type Approval } from './approvals.js';
import { auditEntry, safeAppend, type AuditContext, type AuditLog } from './audit.js';
import { CHECK, allow, deny, errorMessage, includesAddress, sameAddress } from './checks.js';
import { excessOverCap } from './hold.js';
import { IntentStore, MemoryReplayLedger, type ReplayLedger, type Spend } from './intents.js';
import { addressSchema, type Policy } from './policy.js';
import { evaluateIncoming, evaluateReceipt } from './receive.js';
import { checkIntentMatch, evaluateSend, normalizeItem } from './send.js';
import { MemoryGuardStore, type GuardStore, type PaymentRecord } from './store.js';
import type { SpendingSafety } from '../streams/model.js';

export { CHECK, type CheckName } from './checks.js';
export { JsonFileGuardStore, MemoryGuardStore, type GuardStore } from './store.js';
export { JsonFileReplayLedger, MemoryReplayLedger, type ReplayLedger } from './intents.js';
export { defaultPolicy, parsePolicy, type Policy } from './policy.js';
export { JsonlAuditLog, MemoryAuditLog, type AuditEntry, type AuditLog } from './audit.js';

export interface GuardDeps {
  /** Optional independent outflow monitor. Failure blocks new spending. */
  safety?: SpendingSafety;
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
  /** Settles x402 payments made to us. Without one, incoming payments are refused. */
  facilitator?: Facilitator;
  /** How the guard presents a signed payment to a merchant. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** How long to wait for a settlement transaction to become visible. Default 0. */
  settleWaitMs?: number;
  /** Unix seconds, for payment authorization windows (chain time). Injectable for tests. */
  unixNow?: () => number;
  /** Reads Circle Gateway: the balance nanopayments are drawn from, and whether one was accepted. */
  gateway?: GatewayReader;
  /** Append-only record of every decision, allowed or denied. */
  audit?: AuditLog;
}

const SETTLE_POLL_MS = 500;
const MAX_REDIRECTS = 3;
const API_TIMEOUT_MS = 30_000;
const MAX_BODY_CHARS = 8_000;

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
  requirements: z
    .object({
      scheme: z.literal('exact'),
      network: z.string(),
      asset: z.string(),
      amount: z.string().regex(/^\d+$/),
      payTo: z.string(),
      maxTimeoutSeconds: z.number().int().positive(),
      extra: z.record(z.unknown()),
    })
    .optional(),
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
  /** Tail of the one-at-a-time queue for payments we make. Never rejects. */
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * Payments we receive have their own queue. Paying a merchant that is guarded by this
   * same guard calls back into the receive side while the payment holds the send queue.
   */
  private receiveQueue: Promise<unknown> = Promise.resolve();

  private readonly approvals: ApprovalDesk;
  /** The task the owner declared for the agent, with its own budget session. */
  private task: { name: string; session: string } | undefined;

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

  /** Paid API calls on record, for rate limits, duplicates and task budgets. */
  private get apiSpends(): readonly ApiSpend[] {
    return this.payments
      .filter((p) => p.state !== 'failed' && p.endpoint && p.requestKey)
      .map((p) => ({
        endpoint: p.endpoint!,
        requestKey: p.requestKey!,
        amount: p.amount,
        at: p.at,
        served: p.served ?? false,
        ...(p.session ? { session: p.session } : {}),
      }));
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
   * Pays, or asks again about a payment attempted earlier, and records how it ended.
   * Repeating this for the same payment can never pay twice: an x402 payment re-signs the
   * same authorization (its nonce comes from the payment's key), which USDC settles only
   * once; a plain transfer is re-sent under the same idempotency key.
   */
  private async send(
    payment: PaymentRecord,
    fresh = false,
    /** The order being paid now, when this finishes an earlier attempt at the same order. */
    current?: PaymentIntent,
  ): Promise<{ payment: PaymentRecord; answer?: MerchantAnswer }> {
    const original = this.intents.get(payment.intentId);
    // Presented where the order is being placed now: a merchant may have moved since. The
    // terms are the same order's, so the same authorization is signed again.
    const intent = original && current?.requirements ? { ...original, merchantUrl: current.merchantUrl, order: current.order } : original;
    const outcome =
      payment.validBefore !== undefined && intent?.requirements
        ? await this.sendX402(payment, intent, fresh)
        : { payment: await this.sendTransfer(payment) };
    try {
      this.persist();
    } catch {
      // The payment has already been attempted. If this cannot be written down, the file
      // still says "reserved" and the payment is checked again before the next one.
    }
    return outcome;
  }

  /** Payments recorded before x402 were plain transfers, and are finished the same way. */
  private async sendTransfer(payment: PaymentRecord): Promise<PaymentRecord> {
    const { key, intentId, item, payTo, amount, at, delivered } = payment;
    const base = { key, intentId, item, payTo, amount, at, delivered };
    await this.reserveOutflow(payment);
    try {
      const { txHash } = await this.deps.wallet.transfer({ from: 'hot', to: payTo, amount, idempotencyKey: key });
      // A monitor outage after confirmation must not turn a known payment into a failure.
      await this.deps.safety?.submitted(key, txHash).catch(() => undefined);
      return this.putPayment({ ...base, state: 'sent', txHash });
    } catch (err) {
      const state = err instanceof TransferRejectedError ? 'failed' : 'unknown';
      if (state === 'failed') this.intents.reopen(intentId);
      return this.putPayment({ ...base, state, error: errorMessage(err) });
    }
  }

  /**
   * An x402 payment: sign an EIP-3009 authorization for exactly what was quoted and present
   * it to the merchant, whose facilitator settles it. Whether it settled is read from the
   * chain, not taken from the merchant's word.
   */
  private async sendX402(
    payment: PaymentRecord,
    intent: PaymentIntent,
    fresh: boolean,
  ): Promise<{ payment: PaymentRecord; answer?: MerchantAnswer }> {
    const { key, intentId, item, payTo, amount, at, delivered } = payment;
    const validBefore = payment.validBefore!;
    const requirements = intent.requirements!;
    const base = { key, intentId, item, payTo, amount, at, delivered, validBefore };
    const hot = this.deps.wallet.addressOf('hot');
    const nonce = nonceFor(key);
    const paid = (txHash: TxHash | undefined, answer?: MerchantAnswer) => ({
      payment: this.putPayment({ ...base, state: 'sent', ...(txHash ? { txHash } : {}) }),
      ...(answer ? { answer } : {}),
    });
    const notPaid = (error: string) => {
      this.intents.reopen(intentId);
      return { payment: this.putPayment({ ...base, state: 'failed', error }) };
    };
    const maybePaid = (error: string, answer?: MerchantAnswer) => ({
      payment: this.putPayment({ ...base, state: 'unknown', error }),
      ...(answer ? { answer } : {}),
    });

    if (!fresh) {
      // Asked about again: the chain knows whether this authorization was ever used.
      const onchain = await this.authorizationState(nonce);
      if (!onchain) return maybePaid('Could not read the chain to see whether the earlier payment settled.');
      if (onchain.used) return paid(onchain.txHash ?? payment.txHash);
      if (this.unixNow() >= validBefore) return notPaid('The signed payment expired without being settled, so it can never be.');
    }

    await this.reserveOutflow(payment, nonce);

    let payload: PaymentPayload;
    try {
      payload = await signPayment({
        sign: (data) => this.deps.wallet.signTypedData('hot', data),
        from: hot,
        requirements,
        nonce,
        validBefore,
      });
    } catch (err) {
      return notPaid(`Could not sign the payment, so nothing can be settled: ${errorMessage(err)}`);
    }

    let answer: MerchantAnswer | undefined;
    let unreachable: string | undefined;
    // Signing awaited a wallet API; a newly arrived incident must stop presentation too.
    await this.monitoring(() => this.deps.safety?.check());
    try {
      answer = await this.presentPayment(intent, payload);
    } catch (err) {
      unreachable = errorMessage(err);
    }
    // The merchant's word is checked against the chain before anything is recorded as paid.
    const claimed = answer?.settlement?.success ? answer.settlement.transaction : undefined;
    // Any answer may follow a settlement (a merchant can keep the money and say otherwise),
    // so the node we read from is given time to catch up before "not settled" is believed.
    const onchain = await this.authorizationState(nonce, answer !== undefined);
    if (onchain?.used) return paid(onchain.txHash ?? (isTxHash(claimed) ? claimed : undefined), answer);
    const why =
      unreachable ??
      `the merchant answered ${answer?.status}${answer?.settlement?.errorReason ? ` (${answer.settlement.errorReason})` : ''} and it did not settle onchain`;
    return maybePaid(
      `Payment not settled: ${why}. The signed authorization stays valid until ${new Date(validBefore * 1000).toISOString()}, ` +
        'so it counts as possibly paid until then.',
      answer,
    );
  }

  /** Has the hot wallet's authorization with this nonce been used? Undefined when the chain cannot be read. */
  private authorizationState(nonce: `0x${string}`, expectUsed = false): Promise<{ used: boolean; txHash?: TxHash } | undefined> {
    return this.authorizationUsed(this.deps.wallet.addressOf('hot'), nonce, expectUsed);
  }

  /** Has this authorization been used onchain? With `expectUsed`, waits up to settleWaitMs for it to show. */
  private async authorizationUsed(
    hot: `0x${string}`,
    nonce: `0x${string}`,
    expectUsed = false,
  ): Promise<{ used: boolean; txHash?: TxHash } | undefined> {
    const deadline = Date.now() + (expectUsed ? (this.deps.settleWaitMs ?? 0) : 0);
    for (;;) {
      let state: { used: boolean; txHash?: TxHash };
      try {
        state = await this.deps.chain.authorizationUsed(hot, nonce);
      } catch {
        return undefined;
      }
      // A merchant that says it settled may be ahead of the node we read from.
      if (state.used || Date.now() >= deadline) return state;
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    }
  }

  /** Presents a signed payment to the merchant: the same order, with the PAYMENT-SIGNATURE header. */
  private presentPayment(intent: PaymentIntent, payload: PaymentPayload): Promise<MerchantAnswer> {
    return presentPayment({
      url: new URL('/buy', intent.merchantUrl),
      order: { ...(intent.order ?? {}), item: intent.item },
      payload,
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
  }

  /** Unix seconds: the clock that payment authorizations are judged by. */
  private unixNow(): number {
    return this.deps.unixNow?.() ?? Math.floor(Date.now() / 1000);
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
      payment.endpoint === undefined &&
      normalizeItem(payment.item) === normalizeItem(intent.item) &&
      sameAddress(payment.payTo, intent.payTo) &&
      payment.amount === intent.amount;
    const unsettled = (payment: PaymentRecord): boolean => payment.state === 'reserved' || payment.state === 'unknown';

    // What the merchant answered when an unfinished x402 payment was presented again.
    const answers = new Map<string, MerchantAnswer>();
    for (const payment of this.payments.filter((p) => sameOrder(p) && unsettled(p))) {
      // The allowlist is read again: a payee the owner has removed since the attempt is
      // not paid now. Such a payment stays unsettled and blocks the order instead.
      if (!includesAddress(this.deps.policy.allowlist, payment.payTo)) continue;
      const { answer } = await this.send(payment, false, intent);
      if (answer) answers.set(payment.key, answer);
    }


    const earlier = this.payments.filter(sameOrder);
    if (earlier.some(unsettled)) {
      return deny(
        CHECK.reconcile,
        'An earlier payment for this order was attempted and its outcome still cannot be confirmed, so no new payment is made. Try again shortly.',
      );
    }
    const recovered = earlier.find((payment) => payment.state === 'sent' && !payment.delivered);
    if (!recovered) return undefined;

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
    const answer = answers.get(recovered.key);
    return {
      ...allow(
        recovered.txHash
          ? 'An earlier payment attempt for this order was settled and its transaction recovered, so nothing new was sent.'
          : 'An earlier payment attempt for this order was settled onchain, so nothing new was sent.',
        recovered.txHash,
      ),
      ...(answer ? { merchantResponse: { status: answer.status, body: answer.body } } : {}),
    };
  }

  async getQuote(merchantUrl: string, item: string, order?: Record<string, string>): Promise<PaymentIntent> {
    const raw: unknown = await this.deps.fetchQuote(merchantUrl, item, order);
    const parsed = quoteSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`Invalid quote from ${merchantUrl}: ${issues}`);
    }
    const { requirements } = parsed.data;
    // An x402 option must say the same as the quote it is recorded under: that is what gets signed.
    if (
      requirements &&
      (requirements.amount !== parsed.data.amount.toString() || !sameAddress(requirements.payTo as `0x${string}`, parsed.data.payTo))
    ) {
      throw new Error(`Invalid quote from ${merchantUrl}: its x402 terms disagree with its price or payee.`);
    }
    // Record what we asked for, not the merchant's echo of it.
    const quote: Quote = {
      merchantUrl,
      item,
      payTo: parsed.data.payTo,
      amount: parsed.data.amount,
      // The schema checked its shape; the network string is checked again before paying.
      ...(requirements ? { requirements: requirements as PaymentRequirements } : {}),
      ...(order && Object.keys(order).length > 0 ? { order: { ...order } } : {}),
    };
    const description = parsed.data.description;
    const intent = this.intents.record(description === undefined ? quote : { ...quote, description }, this.now());
    this.persist();
    return intent;
  }

  async requestPayment(req: PaymentRequest): Promise<Decision> {
    const intent = isObject(req) && typeof req.intentId === 'string' ? this.intents.get(req.intentId) : undefined;
    const context: AuditContext = {
      kind: 'send',
      ...(intent ? { resource: `${intent.merchantUrl} ${intent.item}`, amountUsdc: formatUsdc(intent.amount), payTo: intent.payTo } : {}),
      ...(intent?.requirements ? { network: intent.requirements.network } : {}),
    };
    try { return this.record(await this.payOnceApproved(req), context); }
    catch (err) {
      if (err instanceof MonitoringError) return this.record(deny(CHECK.monitoring, err.message), context);
      throw err;
    }
  }

  beginTask(name: string): void {
    if (!this.deps.policy.api?.tasks[name]) throw new Error(`Unknown task "${name}": declare it under api.tasks in the policy.`);
    this.task = { name, session: `${name}:${randomUUID()}` };
  }

  async fetchPaid(req: PaidRequest): Promise<PaidResponse> {
    let outcome: { response: PaidResponse; context?: AuditContext };
    try {
      outcome = await this.enqueue(() => this.buy(req));
    } catch (err) {
      if (!(err instanceof MonitoringError)) throw err;
      outcome = { response: { decision: deny(CHECK.monitoring, err.message) }, context: { kind: 'api', resource: String(req?.url) } };
    }
    // A request that asked for no payment is not a payment decision.
    if (outcome.context) this.record(outcome.response.decision, outcome.context);
    return outcome.response;
  }

  /**
   * The x402 chokepoint for paid APIs. Asks for the resource without paying, following
   * redirects only to approved resources. A 402's terms go through every API check, and
   * only then is a payment signed (a Circle Gateway nanopayment when offered) and presented
   * on the same request. Whether it was paid is read from Gateway (or the chain), not
   * from the provider's word.
   */
  private async buy(raw: PaidRequest): Promise<{ response: PaidResponse; context?: AuditContext }> {
    const { policy, wallet } = this.deps;
    const parsed = parsePaidRequest(raw);
    const context: AuditContext = { kind: 'api', resource: typeof raw?.url === 'string' ? raw.url.slice(0, 500) : '(none)' };
    const denied = (decision: Decision) => ({ response: { decision }, context });
    if (typeof parsed === 'string') return denied(deny(CHECK.resource, parsed));
    const { method, body } = parsed;
    let url = parsed.url;
    if (!isApprovedResource(policy.api, url)) {
      return denied(deny(CHECK.resource, policy.api ? `${endpointOf(url)} is not an approved resource.` : 'The policy approves no paid API resources.'));
    }

    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const send = (target: URL, headers: Record<string, string> = {}) =>
      fetchImpl(target, {
        method,
        redirect: 'manual',
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });

    let res: Response;
    for (let hop = 0; ; hop++) {
      try {
        res = await send(url);
      } catch (err) {
        return denied(deny(CHECK.resource, `Could not reach ${endpointOf(url)}: ${errorMessage(err)}`));
      }
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) break;
      const next = new URL(location, url);
      context.resource = next.toString();
      if (hop >= MAX_REDIRECTS) return denied(deny(CHECK.resource, 'Too many redirects.'));
      if (!isApprovedResource(policy.api, next)) {
        return denied(deny(CHECK.resource, `${endpointOf(url)} redirected to ${endpointOf(next)}, which is not an approved resource.`));
      }
      url = next;
    }
    if (res.status !== 402) {
      return { response: { decision: allow('No payment was asked for.'), status: res.status, body: await readBody(res) } };
    }

    context.resource = url.toString();
    let requirements: PaymentRequirements | undefined;
    let resource: PaymentPayload['resource'] | undefined;
    try {
      const required = decode.required(res.headers.get(HEADER.required) ?? '');
      requirements = pickRequirements(required) ?? required.accepts[0];
      resource = required.resource;
    } catch {
      return denied(deny(CHECK.network, 'The 402 carries no readable x402 payment terms.'));
    }
    if (!requirements) return denied(deny(CHECK.network, 'The 402 offers no payment option.'));
    Object.assign(context, {
      payTo: String(requirements.payTo).toLowerCase(),
      network: requirements.network,
      ...(/^\d+$/.test(requirements.amount) ? { amountUsdc: formatUsdc(BigInt(requirements.amount)) } : {}),
    });

    const gatewayRail = isGatewayOption(requirements);
    const hot = wallet.addressOf('hot');
    if (gatewayRail && !this.deps.gateway) return denied(deny(CHECK.wallet, 'No Circle Gateway reader is configured, so a nanopayment cannot be confirmed.'));
    let balance: Usdc;
    try {
      balance = gatewayRail ? await this.deps.gateway!.balance(hot) : await wallet.getBalance('hot');
    } catch (err) {
      return denied(deny(CHECK.wallet, `Could not read the balance to pay from, nothing was paid: ${errorMessage(err)}`));
    }
    const key = requestKey(method, url, body);
    const verdict = evaluateApi(
      { url, requirements, requestKey: key, ...(this.task ? { task: this.task } : {}), dailySpends: this.spends, apiSpends: this.apiSpends, balance },
      policy,
      this.now(),
    );
    if (!verdict.allowed) return denied(verdict);

    await this.monitoring(() => this.deps.safety?.check());
    const amount = BigInt(requirements.amount);
    const payTo = requirements.payTo.toLowerCase() as `0x${string}`;
    const timeout = gatewayRail ? GATEWAY_VALIDITY_SECONDS : Math.min(requirements.maxTimeoutSeconds, MAX_TIMEOUT_SECONDS);
    const reserved = this.putPayment({
      key: randomUUID(),
      intentId: `api:${randomUUID()}`,
      item: url.pathname,
      payTo,
      amount,
      at: this.now(),
      state: 'reserved',
      delivered: false,
      validBefore: this.unixNow() + timeout,
      endpoint: endpointOf(url),
      requestKey: key,
      served: false,
      rail: gatewayRail ? 'gateway' : 'exact',
      ...(this.task ? { session: this.task.session } : {}),
    });
    try {
      this.persist();
    } catch (err) {
      this.payments = this.payments.filter((p) => p.key !== reserved.key);
      return denied(deny(CHECK.wallet, `Could not record the payment before making it, so nothing was paid: ${errorMessage(err)}`));
    }

    const nonce = nonceFor(reserved.key);
    await this.reserveOutflow(reserved, nonce);
    let payload: PaymentPayload;
    try {
      payload = await signPayment({
        sign: (data) => wallet.signTypedData('hot', data),
        from: hot,
        requirements,
        nonce,
        validBefore: reserved.validBefore!,
        ...(resource ? { resource } : {}),
      });
    } catch (err) {
      this.putPayment({ ...reserved, state: 'failed', error: errorMessage(err) });
      this.tryPersist();
      return denied(deny(CHECK.wallet, `Could not sign the payment, so nothing was paid: ${errorMessage(err)}`));
    }

    let answer: { status: number; body: unknown } | undefined;
    let unreachable: string | undefined;
    try {
      const paid = await send(url, { [HEADER.signature]: encode.signature(payload) });
      answer = { status: paid.status, body: await readBody(paid) };
    } catch (err) {
      unreachable = errorMessage(err);
    }

    // The provider's word is checked with Gateway (or the chain) before anything counts as paid.
    let settled: { used: boolean; failed?: boolean; txHash?: TxHash; ref?: string } | undefined;
    if (gatewayRail) {
      const transfer = await this.gatewayTransfer(hot, nonce, answer !== undefined);
      settled = transfer
        ? { used: transferCounts(transfer), failed: !transferCounts(transfer), ref: transfer.id, ...(transfer.txHash ? { txHash: transfer.txHash } : {}) }
        : transfer === null ? undefined : { used: false };
    } else {
      settled = await this.authorizationState(nonce, answer !== undefined);
    }
    const served = answer !== undefined && answer.status >= 200 && answer.status < 300;
    const paidInfo = { amount, payTo, network: requirements.network, resource: url.toString() };
    const response = (decision: Decision): { response: PaidResponse; context: AuditContext } => ({
      response: { decision, ...(answer ? { status: answer.status, body: answer.body } : {}), paid: paidInfo },
      context,
    });

    if (settled?.used) {
      this.putPayment({
        ...reserved,
        state: 'sent',
        delivered: true,
        served,
        ...(settled.txHash ? { txHash: settled.txHash } : {}),
        ...(settled.ref ? { settlementRef: settled.ref } : {}),
      });
      this.tryPersist();
      const via = gatewayRail ? `Circle Gateway (transfer ${settled.ref})` : `x402${settled.txHash ? ` (${settled.txHash})` : ''}`;
      return response({
        ...allow(`${verdict.reason} Paid ${formatUsdc(amount)} USDC to ${payTo} for ${url.pathname} via ${via}.`, settled.txHash),
        ...(settled.ref ? { settlementRef: settled.ref } : {}),
      });
    }
    if (settled?.failed) {
      this.putPayment({ ...reserved, state: 'failed', error: 'Gateway marked the transfer failed.' });
      this.tryPersist();
      return response(deny(CHECK.wallet, 'Gateway marked the payment failed, so nothing was paid and nothing counts against the limits.'));
    }
    // Not seen. A provider holding the signed authorization could still submit it until it
    // expires, so it counts against the limits until then.
    const why = unreachable ?? `the provider answered ${answer?.status} and the payment was not found`;
    this.putPayment({ ...reserved, state: 'unknown', served, error: why });
    this.tryPersist();
    return response(
      deny(
        CHECK.wallet,
        `Payment not confirmed: ${why}. The signed authorization stays valid until ${new Date(reserved.validBefore! * 1000).toISOString()}, so it counts as possibly paid until then.`,
      ),
    );
  }

  /** The Gateway transfer made with this nonce, waiting up to settleWaitMs when one is expected. Null when Gateway cannot be read. */
  private async gatewayTransfer(from: `0x${string}`, nonce: `0x${string}`, expect: boolean): Promise<GatewayTransfer | undefined | null> {
    const deadline = Date.now() + (expect ? (this.deps.settleWaitMs ?? 0) : 0);
    for (;;) {
      let transfer: GatewayTransfer | undefined;
      try {
        transfer = await this.deps.gateway!.transferByNonce(from, nonce);
      } catch {
        if (Date.now() >= deadline) return null;
        transfer = undefined;
      }
      if (transfer || Date.now() >= deadline) return transfer;
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    }
  }

  private tryPersist(): void {
    try {
      this.persist();
    } catch {
      // The outcome is already decided; the file is checked again before the next payment.
    }
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

  acceptPayment(req: IncomingPayment): Promise<Decision> {
    const context: AuditContext = {
      kind: 'receive',
      resource: `order ${String(req?.orderId)}`,
      ...(isObject(req?.requirements) && /^\d+$/.test(String(req.requirements.amount))
        ? { amountUsdc: formatUsdc(BigInt(req.requirements.amount)), payTo: String(req.requirements.payTo).toLowerCase(), network: String(req.requirements.network) }
        : {}),
    };
    const result = this.receiveQueue.then(async () => this.record(await this.checkIncoming(req), context));
    this.receiveQueue = result.catch(() => undefined);
    return result;
  }

  rebalance(): Promise<void> {
    return this.enqueue(async () => {
      const { wallet, policy } = this.deps;
      const excess = excessOverCap(await wallet.getBalance('hot'), policy.hotBalanceCap);
      if (excess === 0n) return;
      const id = `sweep-${randomUUID()}`;
      await this.monitoring(async () => {
        await this.deps.safety?.reserve({ id, from: wallet.addressOf('hot'), to: wallet.addressOf('vault'), amount: excess.toString() });
        await this.deps.safety?.check();
      });
      try {
        const sent = await wallet.transfer({ from: 'hot', to: wallet.addressOf('vault'), amount: excess, idempotencyKey: id });
        await this.deps.safety?.submitted(id, sent.txHash).catch(() => undefined);
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

    await this.monitoring(() => this.deps.safety?.check());

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
    const timeout = Math.min(intent.requirements?.maxTimeoutSeconds ?? MAX_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
    const reserved = this.putPayment({
      key: randomUUID(),
      intentId: intent.id,
      item: intent.item,
      payTo: intent.payTo,
      amount: intent.amount,
      at: this.now(),
      state: 'reserved',
      delivered: false,
      ...(intent.requirements ? { validBefore: this.unixNow() + timeout } : {}),
    });
    try {
      this.persist();
    } catch (err) {
      this.payments = this.payments.filter((payment) => payment.key !== reserved.key);
      this.intents.reopen(intent.id);
      return deny(CHECK.wallet, `Could not record the payment before sending it, so nothing was sent: ${errorMessage(err)}`);
    }

    const { payment: settled, answer } = await this.send(reserved, true);
    const merchantResponse = answer ? { merchantResponse: { status: answer.status, body: answer.body } } : {};
    if (settled.state === 'sent') {
      this.putPayment({ ...settled, delivered: true });
      try {
        this.persist();
      } catch {
        // Paid and about to be reported. Left as undelivered on disk, it would at worst be
        // handed to the next request for the same order instead of paying again.
      }
      const reason = needsApproval ? `${verdict.reason} The owner approved this payment.` : verdict.reason;
      return { ...allow(reason, settled.txHash), ...merchantResponse };
    }
    if (settled.state === 'failed') {
      return {
        ...deny(
          CHECK.wallet,
          `The payment was not made, so nothing was sent and nothing counts against the limits. (${settled.error ?? 'no reason given'})`,
        ),
        ...merchantResponse,
      };
    }
    return {
      ...deny(
        CHECK.wallet,
        `The payment's outcome is unknown, so it still counts against the limits. ` +
          `It will be checked again before another payment for this order is made. (${settled.error ?? 'no reason given'})`,
      ),
      ...merchantResponse,
    };
  }

  /**
   * Receive side of x402: check the payment ourselves, have the facilitator verify and
   * settle it, then confirm onchain that real USDC reached us. Goods are released only
   * after all of that.
   */
  private async checkIncoming(req: IncomingPayment): Promise<Decision> {
    if (!isObject(req) || !isObject(req.payload) || !isObject(req.requirements)) {
      return deny(CHECK.signature, 'Malformed payment.');
    }
    const { payload, requirements } = req;
    const signed = eip3009Of(payload);
    const facts = {
      signed,
      signatureValid: signed ? await signedBy(signed, requirements) : false,
      alreadyUsed: signed ? this.replayLedger.has(authorizationKey(signed.authorization)) : false,
      now: this.unixNow(),
    };
    const verdict = evaluateIncoming(req, facts, this.deps.policy);
    if (!verdict.allowed || !signed) return verdict;

    const { facilitator } = this.deps;
    if (!facilitator) return deny(CHECK.facilitator, 'No facilitator is configured, so the payment cannot be settled.');
    let verified;
    try {
      verified = await facilitator.verify(payload, requirements);
    } catch (err) {
      return deny(CHECK.facilitator, `The ${facilitator.name} facilitator could not verify the payment: ${errorMessage(err)}`);
    }
    if (!verified.isValid) {
      return deny(CHECK.facilitator, `The ${facilitator.name} facilitator rejected the payment: ${verified.invalidReason ?? 'no reason given'}.`);
    }

    // Recorded before settling, so the same authorization cannot pay for a second order
    // even if two arrive at once. A failed settlement does not free it: the payer signs anew.
    try {
      this.replayLedger.add(authorizationKey(signed.authorization));
      this.persist();
    } catch (err) {
      return deny(CHECK.replay, `Could not record this payment in the replay ledger: ${errorMessage(err)}`);
    }

    let settled: SettleResponse | undefined;
    let settleError: string | undefined;
    try {
      settled = await facilitator.settle(payload, requirements);
    } catch (err) {
      settleError = errorMessage(err);
    }
    if (!settled?.success || !isTxHash(settled.transaction)) {
      // The facilitator's answer was lost or negative, but it may still have settled (a
      // timeout after broadcasting, say). The chain decides; the receipt is checked below.
      const { from, nonce } = signed.authorization;
      const onchain = await this.authorizationUsed(from, nonce, true);
      if (onchain?.used && onchain.txHash) {
        settled = { success: true, transaction: onchain.txHash, network: requirements.network };
      } else {
        const why = settleError
          ? `could not settle the payment: ${settleError}`
          : settled?.errorReason === 'settlement_pending'
            ? 'reports the settlement still pending, so the goods are not released yet'
            : `did not settle the payment: ${settled?.errorReason ?? 'no reason given'}`;
        return deny(CHECK.facilitator, `The ${facilitator.name} facilitator ${why}.`);
      }
    }

    // The facilitator's word is checked onchain like any other proof of payment.
    const settlementTx = settled.transaction as TxHash;
    let tx: TxInfo | null;
    try {
      tx = await this.waitForTx(settlementTx);
    } catch (err) {
      return deny(CHECK.chain, `Could not read the chain, so the settlement is unverified: ${errorMessage(err)}`);
    }
    const receipt = evaluateReceipt(
      {
        orderId: req.orderId,
        txHash: settlementTx,
        expectedTo: requirements.payTo.toLowerCase() as `0x${string}`,
        expectedAmount: BigInt(requirements.amount),
      },
      tx,
      false,
      this.deps.policy,
    );
    if (!receipt.allowed) return receipt;
    return {
      ...allow(`Received ${formatUsdc(BigInt(requirements.amount))} USDC for order ${req.orderId}, settled by the ${facilitator.name} facilitator.`),
      receivedTx: settlementTx,
    };
  }

  private async waitForTx(txHash: TxHash): Promise<TxInfo | null> {
    const deadline = Date.now() + (this.deps.settleWaitMs ?? 0);
    for (;;) {
      const tx = await this.deps.chain.getTx(txHash);
      if (tx || Date.now() >= deadline) return tx;
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    }
  }

  private async monitoring(action: () => Promise<void> | undefined): Promise<void> {
    try { await action(); }
    catch (err) { throw new MonitoringError(errorMessage(err)); }
  }

  private async reserveOutflow(payment: PaymentRecord, nonce?: TxHash): Promise<void> {
    await this.monitoring(async () => {
      await this.deps.safety?.reserve({ id: payment.key, from: this.deps.wallet.addressOf('hot'), to: payment.payTo, amount: payment.amount.toString(), ...(nonce ? { nonce } : {}) });
      await this.deps.safety?.check();
    });
  }

  private record(decision: Decision, context?: AuditContext): Decision {
    this.log = [...this.log, decision];
    if (context) safeAppend(this.deps.audit, auditEntry(decision, context, 'on', new Date(this.now())));
    return decision;
  }

  /** Runs tasks strictly one after another so parallel requests cannot race past a check. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

class MonitoringError extends Error {}

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

/** A paid request as the agent sent it, checked: an http(s) URL, GET or POST, and a JSON body for POST. */
export function parsePaidRequest(raw: unknown): { url: URL; method: 'GET' | 'POST'; body?: unknown } | string {
  if (!isObject(raw)) return 'Malformed paid request.';
  const { url, method, body } = raw as PaidRequest;
  if (typeof url !== 'string') return 'The paid request has no URL.';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `"${url.slice(0, 200)}" is not a URL.`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'Only http(s) URLs can be paid for.';
  if (parsed.username || parsed.password) return 'URLs with credentials are not paid for.';
  const verb = (method ?? 'GET').toUpperCase();
  if (verb !== 'GET' && verb !== 'POST') return 'Only GET and POST requests can be paid for.';
  return { url: parsed, method: verb, ...(verb === 'POST' ? { body: body ?? {} } : {}) };
}

/** A response body as JSON when it is JSON, else as (clipped) text. */
export async function readBody(res: Response): Promise<unknown> {
  const text = (await res.text().catch(() => '')).slice(0, MAX_BODY_CHARS);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

const isTxHash = (value: unknown): value is TxHash => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);

/** Replay-ledger entry for an x402 authorization: the payer and nonce, which USDC also uses once. */
const authorizationKey = (auth: { from: string; nonce: string }): string => `x402:${auth.from}:${auth.nonce}`.toLowerCase();

/**
 * Did the payer sign this, over the domain of the token we asked to be paid in? A payment
 * signed for a lookalike token does not recover to the payer here.
 */
async function signedBy(
  signed: NonNullable<ReturnType<typeof eip3009Of>>,
  requirements: IncomingPayment['requirements'],
): Promise<boolean> {
  try {
    const typed = authorizationTypedData({ ...requirements, asset: USDC_ADDRESS }, signed.authorization);
    const recovered = await recoverTypedDataAddress({ ...(typed as Parameters<typeof recoverTypedDataAddress>[0]), signature: signed.signature });
    return sameAddress(recovered.toLowerCase() as `0x${string}`, signed.authorization.from);
  } catch {
    return false;
  }
}

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
