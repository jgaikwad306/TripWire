import type {
  Decision,
  Guard,
  PaymentIntent,
  PaymentRequest,
  QuoteFetcher,
  ReceiptRequest,
  Usdc,
  WalletProvider,
} from '../types.js';

/**
 * A guard that approves everything. Two uses:
 *  - stand-in so lanes C and D can build before the real guard (lane B) lands;
 *  - the `--no-guard` baseline, showing what an unprotected agent loses.
 */
export class AllowAllGuard implements Guard {
  private intents = new Map<string, PaymentIntent>();
  private log: Decision[] = [];
  private seq = 0;

  constructor(
    private readonly wallet: WalletProvider,
    private readonly fetchQuote: QuoteFetcher,
  ) {}

  async getQuote(merchantUrl: string, item: string): Promise<PaymentIntent> {
    const quote = await this.fetchQuote(merchantUrl, item);
    const intent: PaymentIntent = { ...quote, id: `intent-${++this.seq}`, createdAt: Date.now(), status: 'open' };
    this.intents.set(intent.id, intent);
    return intent;
  }

  async requestPayment(req: PaymentRequest): Promise<Decision> {
    let decision: Decision;
    try {
      const { txHash } = await this.wallet.transfer({ from: 'hot', to: req.payTo, amount: req.amount });
      const intent = this.intents.get(req.intentId);
      if (intent) intent.status = 'paid';
      decision = { allowed: true, check: 'none', reason: 'No guard: every payment is approved.', txHash };
    } catch (err) {
      decision = { allowed: false, check: 'wallet', reason: err instanceof Error ? err.message : String(err) };
    }
    this.log.push(decision);
    return decision;
  }

  async verifyReceipt(_req: ReceiptRequest): Promise<Decision> {
    const decision: Decision = { allowed: true, check: 'none', reason: 'No guard: every receipt is accepted.' };
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
