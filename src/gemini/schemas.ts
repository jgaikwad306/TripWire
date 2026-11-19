import { z } from 'zod';

/**
 * Shapes of Gemini Prediction Markets responses, checked against real responses captured in
 * fixtures/gemini/ (see src/gemini/README.md). Passthrough, so fields Gemini adds later do
 * not break us. Prices and quantities stay decimal strings here; math converts them once.
 */

const decimal = z.string().regex(/^\d+(\.\d+)?$/);
const optionalDecimal = z.preprocess((v) => (v === null || v === '' ? undefined : v), decimal.optional());

const rawContractSchema = z
  .object({
    ticker: z.string(),
    label: z.string(),
    status: z.string(),
    instrumentSymbol: z.string(),
    marketState: z.string().optional(),
    expiryDate: z.string().optional(),
    prices: z
      .object({
        bestBid: optionalDecimal,
        bestAsk: optionalDecimal,
        lastTradePrice: optionalDecimal,
      })
      .passthrough()
      .optional(),
    priceIncrement: optionalDecimal,
    quantityMinimum: optionalDecimal,
  })
  .passthrough();

const rawEventSchema = z
  .object({
    ticker: z.string(),
    title: z.string(),
    status: z.string(),
    type: z.string().optional(),
    category: z.string().optional(),
    expiryDate: z.string().nullish(),
    volume: z.union([z.string(), z.number()]).nullish(),
    contracts: z.array(rawContractSchema).default([]),
  })
  .passthrough();

export const eventListSchema = z.object({
  data: z.array(rawEventSchema),
  pagination: z.object({ limit: z.number(), offset: z.number(), total: z.number() }).passthrough().optional(),
});

export const bookSchema = z.object({
  bids: z.array(z.object({ price: decimal, amount: decimal }).passthrough()),
  asks: z.array(z.object({ price: decimal, amount: decimal }).passthrough()),
});

/** A contract (one outcome line) of an event. Prices are YES prices, decimals in (0, 1). */
export interface GeminiContract {
  ticker: string;
  label: string;
  status: string;
  /** 'open', 'post_only', … Only 'open' takes orders that can fill. */
  marketState: string;
  /** Use exactly as given; never built from a title. */
  instrumentSymbol: string;
  expiresAt?: string;
  bestBid?: string;
  bestAsk?: string;
  lastTradePrice?: string;
}

export interface GeminiEvent {
  ticker: string;
  title: string;
  status: string;
  type?: string;
  category?: string;
  expiresAt?: string;
  contracts: GeminiContract[];
}

/** YES-space depth for one contract, best first. */
export interface GeminiBook {
  bids: { price: string; amount: string }[];
  asks: { price: string; amount: string }[];
}

export function normaliseEvent(raw: unknown): GeminiEvent {
  const e = rawEventSchema.parse(raw);
  return {
    ticker: e.ticker,
    title: e.title,
    status: e.status,
    ...(e.type ? { type: e.type } : {}),
    ...(e.category ? { category: e.category } : {}),
    ...(e.expiryDate ? { expiresAt: e.expiryDate } : {}),
    contracts: e.contracts.map((c) => ({
      ticker: c.ticker,
      label: c.label,
      status: c.status,
      marketState: c.marketState ?? 'unknown',
      instrumentSymbol: c.instrumentSymbol,
      ...(c.expiryDate ? { expiresAt: c.expiryDate } : {}),
      ...(c.prices?.bestBid ? { bestBid: c.prices.bestBid } : {}),
      ...(c.prices?.bestAsk ? { bestAsk: c.prices.bestAsk } : {}),
      ...(c.prices?.lastTradePrice ? { lastTradePrice: c.prices.lastTradePrice } : {}),
    })),
  };
}

export function normaliseBook(raw: unknown): GeminiBook {
  const b = bookSchema.parse(raw);
  return {
    bids: b.bids.map(({ price, amount }) => ({ price, amount })),
    asks: b.asks.map(({ price, amount }) => ({ price, amount })),
  };
}

/** Place-order / order-status fields we read. orderId is int64: kept as a string. */
export const orderSchema = z
  .object({
    orderId: z.union([z.string(), z.number(), z.bigint()]).transform((v) => String(v)),
    status: z.string(),
    symbol: z.string().optional(),
    side: z.string().optional(),
    outcome: z.string().optional(),
    quantity: optionalDecimal,
    filledQuantity: optionalDecimal,
    remainingQuantity: optionalDecimal,
    price: optionalDecimal,
    avgExecutionPrice: optionalDecimal,
  })
  .passthrough();
export type GeminiOrder = z.infer<typeof orderSchema>;

export const positionSchema = z
  .object({
    symbol: z.string(),
    outcome: z.string(),
    totalQuantity: decimal,
    avgPrice: optionalDecimal,
  })
  .passthrough();
