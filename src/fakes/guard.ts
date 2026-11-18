import { randomUUID } from 'node:crypto';
import type {
  ChainReader,
  Decision,
  Guard,
  IncomingPayment,
  PaidRequest,
  PaidResponse,
  PaymentIntent,
  PaymentRequest,
  QuoteFetcher,
  TxHash,
  Usdc,
  WalletProvider,
} from '../types.js';
import { presentPayment } from '../x402/client.js';
import type { Facilitator } from '../x402/facilitator.js';
import { GATEWAY_VALIDITY_SECONDS, transferCounts, type GatewayReader } from '../x402/gateway.js';
import {
  HEADER,
  MAX_TIMEOUT_SECONDS,
  decode,
  eip3009Of,
  encode,
  isGatewayOption,
  nonceFor,
  pickRequirements,
  signPayment,
} from '../x402/protocol.js';
import { auditEntry, safeAppend, type AuditContext, type AuditLog } from '../guard/audit.js';
import { parsePaidRequest, readBody } from '../guard/index.js';
import { formatUsdc } from '../constants.js';

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
    private readonly opts: {
      facilitator?: Facilitator;
      chain?: ChainReader;
      fetchImpl?: typeof fetch;
      settleWaitMs?: number;
      gateway?: GatewayReader;
      audit?: AuditLog;
    } = {},
  ) {}

  beginTask(): void {
    // No guard: a declared task limits nothing.
  }

  /**
   * An unprotected x402 client, like a plain Gateway client's pay(): follows redirects
   * anywhere, and pays whatever the 402 asks, to whoever it names, on whatever network.
   */
  async fetchPaid(req: PaidRequest): Promise<PaidResponse> {
    const parsed = parsePaidRequest(req);
    const context: AuditContext = { kind: 'api', resource: typeof req?.url === 'string' ? req.url : '(none)' };
    const done = (response: PaidResponse): PaidResponse => {
      this.log.push(response.decision);
      safeAppend(this.opts.audit, auditEntry(response.decision, context, 'off'));
      return response;
    };
    if (typeof parsed === 'string') return done({ decision: { allowed: false, check: 'request', reason: parsed } });
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const send = (headers: Record<string, string> = {}) =>
      fetchImpl(parsed.url, {
        method: parsed.method,
        headers: { ...(parsed.body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(parsed.body !== undefined ? { body: JSON.stringify(parsed.body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    try {
      const first = await send();
      if (first.status !== 402) return { decision: { allowed: true, check: 'none', reason: 'No payment was asked for.' }, status: first.status, body: await readBody(first) };
      const required = decode.required(first.headers.get(HEADER.required) ?? '');
      const requirements = pickRequirements(required) ?? required.accepts[0];
      if (!requirements) return done({ decision: { allowed: false, check: 'none', reason: 'The 402 offered no payment option.' } });
      // Where the money goes is wherever the redirected 402 came from.
      context.resource = first.url || parsed.url.toString();
      Object.assign(context, { payTo: requirements.payTo.toLowerCase(), network: requirements.network, amountUsdc: formatUsdc(BigInt(requirements.amount)) });
      const gateway = isGatewayOption(requirements);
      const nonce = nonceFor(randomUUID());
      const payload = await signPayment({
        sign: (data) => this.wallet.signTypedData('hot', data),
        from: this.wallet.addressOf('hot'),
        requirements,
        nonce,
        validBefore: Math.floor(Date.now() / 1000) + (gateway ? GATEWAY_VALIDITY_SECONDS : MAX_TIMEOUT_SECONDS),
        ...(required.resource ? { resource: required.resource } : {}),
      });
      const target = first.url ? new URL(first.url) : parsed.url;
      const paid = await fetchImpl(target, {
        method: parsed.method,
        headers: { ...(parsed.body !== undefined ? { 'content-type': 'application/json' } : {}), [HEADER.signature]: encode.signature(payload) },
        ...(parsed.body !== undefined ? { body: JSON.stringify(parsed.body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await readBody(paid);
      let settlementRef: string | undefined;
      let txHash: TxHash | undefined;
      if (gateway && this.opts.gateway) {
        const transfer = await this.waitForTransfer(this.opts.gateway, nonce);
        if (transfer && transferCounts(transfer)) settlementRef = transfer.id;
      } else if (!gateway && this.opts.chain) {
        txHash = (await this.waitForUse(this.opts.chain, nonce))?.txHash;
      }
      return done({
        decision: {
          allowed: true,
          check: 'none',
          reason: 'No guard: the payment was signed as the 402 asked.',
          ...(txHash ? { txHash } : {}),
          ...(settlementRef ? { settlementRef } : {}),
        },
        status: paid.status,
        body,
        paid: { amount: BigInt(requirements.amount), payTo: requirements.payTo.toLowerCase() as `0x${string}`, network: requirements.network, resource: context.resource },
      });
    } catch (err) {
      return done({ decision: { allowed: false, check: 'wallet', reason: errorText(err) } });
    }
  }

  private async waitForTransfer(gateway: GatewayReader, nonce: `0x${string}`) {
    const deadline = Date.now() + (this.opts.settleWaitMs ?? 0);
    for (;;) {
      const transfer = await gateway.transferByNonce(this.wallet.addressOf('hot'), nonce).catch(() => undefined);
      if (transfer || Date.now() >= deadline) return transfer;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

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
