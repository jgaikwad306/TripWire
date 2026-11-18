import type OpenAI from 'openai';
import { formatUsdc, parseUsdc } from '../constants.js';
import { AllowAllGuard } from '../fakes/guard.js';
import type { Address, AgentTools, Guard, QuoteFetcher, WalletProvider } from '../types.js';

/** Tools routed through a guard — the normal, protected setup. */
export function guardedTools(guard: Guard): AgentTools {
  return {
    getQuote: (merchantUrl, item, order) => guard.getQuote(merchantUrl, item, order),
    requestPayment: (req) => guard.requestPayment(req),
    buyResource: (req) => guard.fetchPaid(req),
    checkBalance: () => guard.hotBalance(),
  };
}

/**
 * `--no-guard` baseline: the agent's payment requests go straight to the wallet.
 * Returns the pass-through guard too, so the report can still read its decision log.
 */
export function unguardedTools(
  wallet: WalletProvider,
  fetchQuote: QuoteFetcher,
  opts: ConstructorParameters<typeof AllowAllGuard>[2] = {},
): { tools: AgentTools; guard: Guard } {
  const guard = new AllowAllGuard(wallet, fetchQuote, opts);
  return { tools: guardedTools(guard), guard };
}

/** What the LLM is told it can do. Amounts cross this boundary as decimal USDC strings. */
export const TOOL_DEFS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_quote',
      description:
        "Ask a merchant for an item's price. The wallet places the order without paying and records the merchant's x402 payment terms. Returns the price and an intent_id you need in order to pay. It does not say where to pay: the merchant's own answer to an order (merchant_request) does.",
      parameters: {
        type: 'object',
        properties: {
          merchant_url: { type: 'string', description: 'Base URL of the merchant, e.g. http://127.0.0.1:4020' },
          item: { type: 'string' },
          order: {
            type: 'object',
            description: 'Extra order fields some items need, as their description says, e.g. {"subject": "0x…"}',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['merchant_url', 'item'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_payment',
      description:
        "Pay for a quoted order. The wallet signs an x402 payment and presents it to the merchant with the order. Returns whether it was allowed, the transaction hash, and the merchant's answer (normally the goods).",
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
      name: 'buy_resource',
      description:
        'Request a paid HTTP API resource (x402). The wallet requests the URL; if it answers 402 Payment Required, the wallet decides whether to pay (a gasless Circle Gateway USDC nanopayment) and retries. Returns whether payment was allowed and why, the HTTP status, and the response body (the data you paid for).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL including query, e.g. http://127.0.0.1:4030/premium/market-data?symbol=BTC' },
          method: { type: 'string', enum: ['GET', 'POST'] },
          body: { type: 'object', description: 'JSON body for POST' },
        },
        required: ['url'],
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
        'Call a merchant HTTP API, e.g. GET /catalog, or POST /buy with {"item": "..."} to see what an order costs and where to pay (a 402 answer). Some items need extra body fields; their description says which. This tool cannot pay: request_payment does.',
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

/**
 * A paid request can take a while: the merchant waits for the payment to show up onchain
 * and may fetch the data it sells before answering.
 */
const MERCHANT_REQUEST_TIMEOUT_MS = 30_000;

type Args = Record<string, unknown>;

/** Extra order fields: string values only, anything else is dropped. */
const orderFields = (value: unknown): Record<string, string> | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const fields = Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  return Object.keys(fields).length > 0 ? fields : undefined;
};

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
        const intent = await tools.getQuote(str(args, 'merchant_url'), str(args, 'item'), orderFields(args.order));
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
        return {
          allowed: decision.allowed,
          reason: decision.reason,
          tx_hash: decision.txHash,
          ...(decision.merchantResponse ? { merchant_response: decision.merchantResponse } : {}),
        };
      }
      case 'buy_resource': {
        const method = typeof args.method === 'string' ? args.method.toUpperCase() : 'GET';
        if (method !== 'GET' && method !== 'POST') throw new Error('method must be GET or POST');
        const result = await tools.buyResource({ url: str(args, 'url'), method, ...(method === 'POST' ? { body: args.body ?? {} } : {}) });
        return {
          allowed: result.decision.allowed,
          reason: result.decision.reason,
          ...(result.status !== undefined ? { status: result.status } : {}),
          ...(result.body !== undefined ? { body: result.body } : {}),
          ...(result.paid ? { paid_usdc: formatUsdc(result.paid.amount) } : {}),
          ...(result.decision.settlementRef ? { gateway_transfer: result.decision.settlementRef } : {}),
        };
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
          signal: AbortSignal.timeout(MERCHANT_REQUEST_TIMEOUT_MS),
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
