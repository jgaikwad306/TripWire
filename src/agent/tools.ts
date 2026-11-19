import type OpenAI from 'openai';
import { formatUsdc, parseUsdc } from '../constants.js';
import { AllowAllGuard } from '../fakes/guard.js';
import type { GeminiEvent } from '../gemini/schemas.js';
import type { MarketData } from '../gemini/venue.js';
import type { Address, AgentTools, Guard, MarketGuard, MarketTools, PredictionOrderResult, QuoteFetcher, WalletProvider } from '../types.js';

/** Tools routed through a guard — the normal, protected setup. Market tools come with a market guard. */
export function guardedTools(guard: Guard, markets?: { guard: MarketGuard; data: MarketData }): AgentTools {
  return {
    getQuote: (merchantUrl, item, order) => guard.getQuote(merchantUrl, item, order),
    requestPayment: (req) => guard.requestPayment(req),
    buyResource: (req) => guard.fetchPaid(req),
    checkBalance: () => guard.hotBalance(),
    ...(markets ? { markets: marketTools(markets.guard, markets.data) } : {}),
  };
}

const MAX_EVENTS = 10;

/** Compact event views for the model: only what trading needs. Read-only, public data. */
export function marketTools(guard: MarketGuard, data: MarketData): MarketTools {
  const view = (e: GeminiEvent) => ({
    event_ticker: e.ticker,
    title: e.title,
    category: e.category,
    expires: e.expiresAt,
    contracts: e.contracts.slice(0, 12).map((c) => ({ label: c.label, instrument_symbol: c.instrumentSymbol, yes_bid: c.bestBid ?? null, yes_ask: c.bestAsk ?? null, market_state: c.marketState })),
  });
  return {
    findMarkets: async (q) => (await data.listEvents({ ...q, limit: MAX_EVENTS })).map(view),
    getMarket: async (ticker) => view(await data.getEvent(ticker)),
    placeOrder: (req) => guard.placeOrder(req),
    positions: () => guard.positions(),
    cancelOrder: (orderId) => guard.cancelOrder(orderId),
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

/** Gemini Prediction Markets tools. Offered only to an agent whose tools include `markets`. */
export const MARKET_TOOL_DEFS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'find_markets',
      description: 'List active Gemini prediction market events (up to 10), each with its contracts: label, instrument_symbol, YES bid/ask (decimals 0–1) and market state. Public data.',
      parameters: { type: 'object', properties: { search: { type: 'string' }, category: { type: 'string', description: 'e.g. Crypto, Sports, Commodities' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_market',
      description: 'One Gemini prediction market event by ticker, with its contracts and current YES bid/ask.',
      parameters: { type: 'object', properties: { event_ticker: { type: 'string' } }, required: ['event_ticker'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'place_prediction_order',
      description:
        "Place a limit order on a Gemini prediction market contract. The wallet's guard decides whether it is placed, using its own read of Gemini. Prices are decimals between 0 and 1 in the outcome's own price (a NO price is 1 − the YES price). The order fills immediately or is cancelled. Returns allowed, reason, order_id, filled_quantity, avg_price and the guard's reference bid/ask.",
      parameters: {
        type: 'object',
        properties: {
          event_ticker: { type: 'string' },
          instrument_symbol: { type: 'string', description: 'Exactly as Gemini lists it, e.g. GEMI-BTC2611192200-HI62750' },
          outcome: { type: 'string', enum: ['yes', 'no'] },
          side: { type: 'string', enum: ['buy', 'sell'] },
          quantity: { type: 'string', description: 'Whole number of contracts, e.g. "5"' },
          limit_price: { type: 'string', description: 'e.g. "0.42"' },
          reason: { type: 'string' },
        },
        required: ['event_ticker', 'instrument_symbol', 'outcome', 'side', 'quantity', 'limit_price', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: { name: 'get_positions', description: 'Current prediction market positions.', parameters: { type: 'object', properties: {} } },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_prediction_order',
      description: 'Cancel an open prediction market order this wallet placed.',
      parameters: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
    },
  },
];

/** The tools offered to the model: market tools only when the agent can trade. */
export const toolDefs = (tools: AgentTools): OpenAI.Chat.Completions.ChatCompletionTool[] => (tools.markets ? [...TOOL_DEFS, ...MARKET_TOOL_DEFS] : TOOL_DEFS);

/** What the model sees of a market decision. */
export function presentOrder(result: PredictionOrderResult): Record<string, unknown> {
  return {
    allowed: result.decision.allowed,
    reason: result.decision.reason,
    ...(result.order ? { order_id: result.order.orderId, status: result.order.status, filled_quantity: result.order.filledQuantity, ...(result.order.avgPrice ? { avg_price: result.order.avgPrice } : {}) } : {}),
    ...(result.reference ? { guard_reference: { yes_bid: result.reference.bestBid ?? null, yes_ask: result.reference.bestAsk ?? null, market_state: result.reference.marketState } } : {}),
  };
}

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
      case 'find_markets':
      case 'get_market':
      case 'place_prediction_order':
      case 'get_positions':
      case 'cancel_prediction_order': {
        const markets = tools.markets;
        if (!markets) throw new Error(`Unknown tool: ${name}`);
        if (name === 'find_markets') {
          return { events: await markets.findMarkets({ ...(typeof args.search === 'string' ? { search: args.search } : {}), ...(typeof args.category === 'string' ? { category: args.category } : {}) }) };
        }
        if (name === 'get_market') return markets.getMarket(str(args, 'event_ticker'));
        if (name === 'get_positions') return { positions: await markets.positions() };
        if (name === 'cancel_prediction_order') {
          const d = await markets.cancelOrder(str(args, 'order_id'));
          return { allowed: d.allowed, reason: d.reason };
        }
        const outcome = str(args, 'outcome').toLowerCase();
        const side = str(args, 'side').toLowerCase();
        if (outcome !== 'yes' && outcome !== 'no') throw new Error('outcome must be yes or no');
        if (side !== 'buy' && side !== 'sell') throw new Error('side must be buy or sell');
        const quantity = String(args.quantity ?? '');
        const limitPrice = String(args.limit_price ?? '');
        if (!/^\d+(\.\d+)?$/.test(quantity)) throw new Error('quantity must be a number of contracts, e.g. "5"');
        if (!/^\d+(\.\d+)?$/.test(limitPrice)) throw new Error('limit_price must be a decimal, e.g. "0.42"');
        return presentOrder(
          await markets.placeOrder({
            eventTicker: str(args, 'event_ticker'),
            symbol: str(args, 'instrument_symbol'),
            outcome,
            side,
            quantity,
            limitPrice,
            reason: typeof args.reason === 'string' ? args.reason : '',
          }),
        );
      }
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
