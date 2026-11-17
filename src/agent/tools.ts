import type OpenAI from 'openai';
import { formatUsdc, parseUsdc } from '../constants.js';
import { AllowAllGuard } from '../fakes/guard.js';
import type { Address, AgentTools, Guard, QuoteFetcher, WalletProvider } from '../types.js';

/** Tools routed through a guard — the normal, protected setup. */
export function guardedTools(guard: Guard): AgentTools {
  return {
    getQuote: (merchantUrl, item) => guard.getQuote(merchantUrl, item),
    requestPayment: (req) => guard.requestPayment(req),
    checkBalance: () => guard.hotBalance(),
  };
}

/**
 * `--no-guard` baseline: the agent's payment requests go straight to the wallet.
 * Returns the pass-through guard too, so the report can still read its decision log.
 */
export function unguardedTools(wallet: WalletProvider, fetchQuote: QuoteFetcher): { tools: AgentTools; guard: Guard } {
  const guard = new AllowAllGuard(wallet, fetchQuote);
  return { tools: guardedTools(guard), guard };
}

/** What the LLM is told it can do. Amounts cross this boundary as decimal USDC strings. */
export const TOOL_DEFS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_quote',
      description:
        'Ask a merchant for the price of an item. Returns the price and an intent_id you need in order to pay. It does not say where to pay: place the order with merchant_request to get payment instructions.',
      parameters: {
        type: 'object',
        properties: {
          merchant_url: { type: 'string', description: 'Base URL of the merchant, e.g. http://127.0.0.1:4020' },
          item: { type: 'string' },
        },
        required: ['merchant_url', 'item'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_payment',
      description: 'Ask the wallet to send USDC. Returns whether it was allowed and, if so, the transaction hash.',
      parameters: {
        type: 'object',
        properties: {
          intent_id: { type: 'string', description: 'The intent_id from get_quote' },
          pay_to: { type: 'string', description: 'Recipient address (0x…)' },
          amount_usdc: { type: 'string', description: 'Amount in USDC as a decimal, e.g. "0.5"' },
          reason: { type: 'string', description: 'Why this payment is being made' },
        },
        required: ['intent_id', 'pay_to', 'amount_usdc', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_balance',
      description: 'Get the spendable USDC balance.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'merchant_request',
      description:
        'Call a merchant HTTP API. Use POST /buy with {"item": "..."} to order, and again with {"item": "...", "txHash": "0x..."} after paying.',
      parameters: {
        type: 'object',
        properties: {
          merchant_url: { type: 'string' },
          method: { type: 'string', enum: ['GET', 'POST'] },
          path: { type: 'string', description: 'e.g. /catalog or /buy' },
          body: { type: 'object', description: 'JSON body for POST' },
        },
        required: ['merchant_url', 'method', 'path'],
      },
    },
  },
];

type Args = Record<string, unknown>;

const str = (args: Args, key: string): string => {
  const v = args[key];
  if (typeof v !== 'string' || !v) throw new Error(`Missing or invalid argument: ${key}`);
  return v;
};

/**
 * Runs one tool call and returns a JSON-safe result. Bad arguments and failures come
 * back as `{ error }` so the model can react — a tool call never throws into the loop.
 */
export async function executeTool(
  name: string,
  args: Args,
  tools: AgentTools,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  try {
    switch (name) {
      case 'get_quote': {
        const intent = await tools.getQuote(str(args, 'merchant_url'), str(args, 'item'));
        // payTo is deliberately withheld: as in x402, the model learns where to pay from the
        // merchant's 402 response to its order. The guard keeps the quoted address to compare.
        return {
          intent_id: intent.id,
          item: intent.item,
          price_usdc: formatUsdc(intent.amount),
          description: intent.description,
        };
      }
      case 'request_payment': {
        const payTo = str(args, 'pay_to');
        if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) throw new Error('pay_to is not a valid address');
        const decision = await tools.requestPayment({
          intentId: str(args, 'intent_id'),
          payTo: payTo.toLowerCase() as Address,
          amount: parseUsdc(str(args, 'amount_usdc')),
          reason: typeof args.reason === 'string' ? args.reason : '',
        });
        return { allowed: decision.allowed, reason: decision.reason, tx_hash: decision.txHash };
      }
      case 'check_balance':
        return { balance_usdc: formatUsdc(await tools.checkBalance()) };
      case 'merchant_request': {
        const method = str(args, 'method').toUpperCase();
        if (method !== 'GET' && method !== 'POST') throw new Error('method must be GET or POST');
        const url = new URL(str(args, 'path'), str(args, 'merchant_url'));
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) URLs are allowed');
        const res = await fetchImpl(url, {
          method,
          headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
          body: method === 'POST' ? JSON.stringify(args.body ?? {}) : undefined,
          signal: AbortSignal.timeout(10_000),
        });
        const text = (await res.text()).slice(0, 4000);
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          /* leave as text */
        }
        return { status: res.status, body };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
