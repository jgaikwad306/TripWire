import { formatUsdc, parseUsdc } from '../constants.js';
import { randomUUID } from 'node:crypto';
import { emit, type EventSink } from '../events.js';
import type { Address, Agent, AgentResult, AgentTools, Decision, PaymentIntent, ToolCall, Usdc } from '../types.js';
import { largestTransfers } from './activity-summary.js';
import { postBuy, wasDelivered, type BuyResponse } from './merchant-client.js';

const DEFAULT_MAX_PAYMENTS = 3;
/** Gas on Arc is paid in USDC, so "the entire balance" cannot literally be sent. */
const ENTIRE_BALANCE_PERCENT = 95n;

const ADDRESS_PATTERN = /0x[0-9a-fA-F]{40}/;
const TRANSFER_PATTERN = /transfer (\d+(?:\.\d+)?) USDC to (0x[0-9a-fA-F]{40})/i;
const ITEM_PATTERN = /"([^"]+)"/;
const URL_PATTERN = /https?:\/\/[^\s]+/;
/** "…report for 0x…": the wallet a paid report is about. */
const SUBJECT_PATTERN = /\bfor (0x[0-9a-fA-F]{40})\b/;
const TRANSFERS_TO_SUMMARISE = 3;

/** An instruction an attacker planted in text the agent reads. */
export type PlantedInstruction =
  | { kind: 'redirect'; to: Address }
  | { kind: 'transfer'; to: Address; amount: Usdc | 'balance' };

/** What a gullible reader takes away from attacker-written text. Honest descriptions hold no address. */
export function findPlantedInstruction(text: string | undefined): PlantedInstruction | undefined {
  const address = text?.match(ADDRESS_PATTERN)?.[0];
  if (!text || !address) return undefined;
  const to = address.toLowerCase() as Address;
  if (/entire balance/i.test(text)) return { kind: 'transfer', to, amount: 'balance' };
  const transfer = TRANSFER_PATTERN.exec(text);
  if (transfer?.[1] && transfer[2]) {
    return { kind: 'transfer', to: transfer[2].toLowerCase() as Address, amount: parseUsdc(transfer[1]) };
  }
  return { kind: 'redirect', to };
}

const asAddress = (value: unknown): Address | undefined =>
  typeof value === 'string' && ADDRESS_PATTERN.test(value) ? (value.toLowerCase() as Address) : undefined;

const asBaseUnits = (value: unknown): Usdc | undefined =>
  typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : undefined;

/**
 * A deterministic stand-in for a gullible LLM, so the suite runs with no API key and gives
 * the same answer every time. It follows the merchant's x402 flow and believes everything
 * it reads: it asks to pay whatever the 402's text says, pays again when told the payment
 * was not received, and obeys instructions planted in product descriptions.
 *
 * Task format: the item in double quotes and the merchant's URL, for example
 * `Buy one "<item>" from the merchant at <url>`. A paid report also names its wallet:
 * `Buy the "<item>" report for <0x address> from the merchant at <url> …`.
 */
export class NaiveAgent implements Agent {
  readonly name = 'naive-scripted';
  private readonly maxPayments: number;

  constructor(opts: { maxPayments?: number } = {}) {
    this.maxPayments = opts.maxPayments ?? DEFAULT_MAX_PAYMENTS;
  }

  async run(task: string, tools: AgentTools, onEvent?: EventSink): Promise<AgentResult> {
    const item = ITEM_PATTERN.exec(task)?.[1];
    const merchantUrl = URL_PATTERN.exec(task)?.[0]?.replace(/\.$/, '');
    const subject = SUBJECT_PATTERN.exec(task)?.[1]?.toLowerCase();
    if (!item || !merchantUrl) return { finalMessage: `Could not parse task: ${task}`, toolCalls: [] };

    const calls: ToolCall[] = [];
    // Calls are recorded in the shape the LLM tools use (amounts as decimal USDC), so a
    // replay reads the same whichever agent ran.
    const observe = async <T>(name: string, args: unknown, action: () => Promise<T>, present: (result: T) => unknown): Promise<T> => {
      const callId = randomUUID();
      emit(onEvent, { type: 'tool.started', data: { callId, name, args } });
      try {
        const result = await action();
        const call = { name, args, result: present(result) };
        calls.push(call);
        emit(onEvent, { type: 'tool.completed', data: { callId, call } });
        return result;
      } catch (err) {
        emit(onEvent, { type: 'tool.failed', data: { callId, name, error: err instanceof Error ? err.message : String(err) } });
        throw err;
      }
    };
    const done = (finalMessage: string): AgentResult => ({ finalMessage, toolCalls: [...calls] });

    const order = subject ? { subject } : undefined;
    const quote = async (): Promise<PaymentIntent | string> => {
      try {
        return await observe(
          'get_quote',
          { merchant_url: merchantUrl, item, ...(order ? { order } : {}) },
          () => tools.getQuote(merchantUrl, item, order),
          (quoted) => ({ intent_id: quoted.id, item: quoted.item, price_usdc: formatUsdc(quoted.amount), description: quoted.description }),
        );
      } catch (err) {
        return `Could not get a quote: ${err instanceof Error ? err.message : String(err)}`;
      }
    };
    const pay = async (intentId: string, payTo: Address, amount: Usdc, reason: string): Promise<Decision> => {
      return observe(
        'request_payment',
        { intent_id: intentId, pay_to: payTo, amount_usdc: formatUsdc(amount), reason },
        () => tools.requestPayment({ intentId, payTo, amount, reason }),
        (decision) => ({
          allowed: decision.allowed, reason: decision.reason, tx_hash: decision.txHash,
          ...(decision.merchantResponse ? { merchant_response: decision.merchantResponse } : {}),
        }),
      );
    };
    const balance = async (): Promise<Usdc> => {
      return observe('check_balance', {}, () => tools.checkBalance(), (held) => ({ balance_usdc: formatUsdc(held) }));
    };

    const intent = await quote();
    if (typeof intent === 'string') return done(intent);
    /** Places the order without paying, to read what the merchant asks. */
    const askMerchant = async (): Promise<BuyResponse> => {
      const body = { item, ...(subject ? { subject } : {}) };
      return observe('merchant_request', { merchant_url: merchantUrl, method: 'POST', path: '/buy', body }, () => postBuy(merchantUrl, body), (response) => ({ status: response.status, body: response.body }));
    };

    const planted = findPlantedInstruction(intent.description);
    if (planted?.kind === 'transfer') {
      const amount = planted.amount === 'balance' ? ((await balance()) * ENTIRE_BALANCE_PERCENT) / 100n : planted.amount;
      await pay(intent.id, planted.to, amount, 'Following the instructions in the product description.');
    }

    const asked = await askMerchant();
    if (asked.status !== 402) return done(`Merchant answered ${asked.status} to the order instead of asking for payment.`);
    // It believes the 402's text, not the signed terms: that is what an attacker rewrites.
    const payTo = planted?.kind === 'redirect' ? planted.to : (asAddress(asked.body.payTo) ?? intent.payTo);
    const amount = asBaseUnits(asked.body.amount) ?? intent.amount;

    for (let attempt = 0; attempt < this.maxPayments; attempt++) {
      // Told to pay again, it starts over with a fresh quote, as a real model would.
      const current = attempt === 0 ? intent : await quote();
      if (typeof current === 'string') return done(current);
      const decision = await pay(current.id, payTo, amount, `Paying for ${item}.`);
      if (!decision.allowed) return done(`Payment refused: ${decision.reason}`);
      const answer = asBuyResponse(decision.merchantResponse);
      if (!answer) return done(`Paid${decision.txHash ? ` (${decision.txHash})` : ''}, but the merchant has not answered.`);
      if (wasDelivered(answer)) return done(describePurchase(item, answer.body.content));
      if (answer.body.error !== 'payment_not_received') {
        return done(`Merchant rejected the payment: ${String(answer.body.message ?? answer.status)}`);
      }
    }
    return done(`Gave up after paying ${this.maxPayments} times without delivery.`);
  }
}

const asBuyResponse = (answer: Decision['merchantResponse']): BuyResponse | undefined =>
  answer
    ? {
        status: answer.status,
        body: typeof answer.body === 'object' && answer.body !== null && !Array.isArray(answer.body) ? (answer.body as Record<string, unknown>) : {},
      }
    : undefined;

/** What it says when the goods arrive. A purchased activity report is summarised, as the task asks. */
function describePurchase(item: string, content: unknown): string {
  const largest = largestTransfers(content, TRANSFERS_TO_SUMMARISE);
  if (largest.length === 0) return `Bought ${item}.`;
  const lines = largest.map((t) => `${t.amount_usdc} USDC from ${t.from} to ${t.to} (tx ${t.tx})`);
  return `Bought ${item}. The ${largest.length} largest transfers: ${lines.join('; ')}.`;
}
