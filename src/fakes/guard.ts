import { randomUUID } from 'node:crypto';
import type {
  ChainReader,
  Decision,
  Guard,
  IncomingPayment,
  PaymentIntent,
  PaymentRequest,
  QuoteFetcher,
  TxHash,
  Usdc,
  WalletProvider,
} from '../types.js';
import { presentPayment } from '../x402/client.js';
import type { Facilitator } from '../x402/facilitator.js';
import { MAX_TIMEOUT_SECONDS, eip3009Of, nonceFor, signPayment } from '../x402/protocol.js';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * A guard that approves everything. Two uses:
 *  - stand-in so other lanes can build without the real guard;
 *  - the `--no-guard` baseline, showing what an unprotected agent loses.
 *
 * Paying: when the agent asks to pay exactly what was quoted, it pays over x402 like any
 * client. When the agent names some other payee or amount, it simply sends that, as an
 * agent holding the wallet itself would. Receiving: every payment is accepted and goods
 * are released; it is settled when a facilitator is available, but never checked.
 */
export class AllowAllGuard implements Guard {
  private intents = new Map<string, PaymentIntent>();
  private log: Decision[] = [];
  private seq = 0;

  constructor(
    private readonly wallet: WalletProvider,
    private readonly fetchQuote: QuoteFetcher,
    private readonly opts: { facilitator?: Facilitator; chain?: ChainReader; fetchImpl?: typeof fetch; settleWaitMs?: number } = {},
  ) {}

  async getQuote(merchantUrl: string, item: string, order?: Record<string, string>): Promise<PaymentIntent> {
    const quote = await this.fetchQuote(merchantUrl, item, order);
    const intent: PaymentIntent = {
      ...quote,
      ...(order ? { order } : {}),
      id: `intent-${++this.seq}`,
      createdAt: Date.now(),
      status: 'open',
    };
    this.intents.set(intent.id, intent);
    return intent;
  }

  async requestPayment(req: PaymentRequest): Promise<Decision> {
    const intent = this.intents.get(req.intentId);
    const asQuoted =
      intent?.requirements !== undefined && req.amount === intent.amount && req.payTo.toLowerCase() === intent.payTo.toLowerCase();
    let decision: Decision;
    try {
      decision = asQuoted ? await this.payOverX402(intent) : await this.transfer(req);
      if (intent) intent.status = 'paid';
    } catch (err) {
      decision = { allowed: false, check: 'wallet', reason: errorText(err) };
    }
    this.log.push(decision);
    return decision;
  }

  private async transfer(req: PaymentRequest): Promise<Decision> {
    const { txHash } = await this.wallet.transfer({ from: 'hot', to: req.payTo, amount: req.amount });
    return { allowed: true, check: 'none', reason: 'No guard: the payment was sent as asked.', txHash };
  }

  private async payOverX402(intent: PaymentIntent): Promise<Decision> {
    const nonce = nonceFor(randomUUID());
    const payload = await signPayment({
      sign: (data) => this.wallet.signTypedData('hot', data),
      from: this.wallet.addressOf('hot'),
      requirements: intent.requirements!,
      nonce,
      validBefore: Math.floor(Date.now() / 1000) + MAX_TIMEOUT_SECONDS,
    });
    const answer = await presentPayment({
      url: new URL('/buy', intent.merchantUrl),
      order: { ...(intent.order ?? {}), item: intent.item },
      payload,
      ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
    });
    // Whatever the merchant says, the chain says whether the money moved.
    const onchain = this.opts.chain ? await this.waitForUse(this.opts.chain, nonce) : undefined;
    const claimed = answer.settlement?.success ? (answer.settlement.transaction as TxHash) : undefined;
    const txHash = onchain?.txHash ?? (onchain?.used === false ? undefined : claimed);
    return {
      allowed: true,
      check: 'none',
      reason: 'No guard: every payment is approved.',
      ...(txHash ? { txHash } : {}),
      merchantResponse: { status: answer.status, body: answer.body },
    };
  }

  /** The authorization's state, waiting up to settleWaitMs for a slow node to show it used. */
  private async waitForUse(chain: ChainReader, nonce: `0x${string}`): Promise<{ used: boolean; txHash?: TxHash } | undefined> {
    const deadline = Date.now() + (this.opts.settleWaitMs ?? 0);
    for (;;) {
      const state = await chain.authorizationUsed(this.wallet.addressOf('hot'), nonce).catch(() => undefined);
      if (state?.used || Date.now() >= deadline) return state;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  async acceptPayment(req: IncomingPayment): Promise<Decision> {
    let txHash: TxHash | undefined;
    if (this.opts.facilitator && eip3009Of(req.payload)) {
      // Settled when possible, but the goods go out either way.
      const settled = await this.opts.facilitator.settle(req.payload, req.payload.accepted ?? req.requirements).catch(() => undefined);
      if (settled?.success && /^0x[0-9a-fA-F]{64}$/.test(settled.transaction)) txHash = settled.transaction as TxHash;
    }
    const decision: Decision = {
      allowed: true,
      check: 'none',
      reason: 'No guard: every payment is accepted.',
      ...(txHash ? { receivedTx: txHash } : {}),
    };
    this.log.push(decision);
    return decision;
  }

  async rebalance(): Promise<void> {}

  hotBalance(): Promise<Usdc> {
    return this.wallet.getBalance('hot');
  }

  decisions(): Decision[] {
    return [...this.log];
  }
}
