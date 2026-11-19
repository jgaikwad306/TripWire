import { z } from 'zod';
import { normaliseBook, normaliseEvent, eventListSchema, orderSchema, positionSchema, type GeminiBook, type GeminiEvent, type GeminiOrder } from './schemas.js';
import { NonceSource, signRequest, type GeminiCredentials, type NonceMode } from './signing.js';
import type { MarketData, Venue, VenueKind, VenueOrder, VenueOrderState, VenuePosition } from './venue.js';

export const GEMINI_PRODUCTION_URL = 'https://api.gemini.com';
export const GEMINI_SANDBOX_URL = 'https://api.sandbox.gemini.com';

const TIMEOUT_MS = 15_000;

/** A Gemini API failure. Never carries the key, secret or signed payload. */
export class GeminiError extends Error {
  constructor(readonly status: number, readonly reason: string, message: string) {
    super(message);
    this.name = 'GeminiError';
  }
}

export interface GeminiClientOptions {
  baseUrl?: string;
  credentials?: GeminiCredentials;
  nonceMode?: NonceMode;
  fetchImpl?: typeof fetch;
}

/** Thin REST client. Public calls need no key; private calls are signed POSTs with empty bodies. */
export class GeminiClient {
  readonly baseUrl: string;
  private readonly creds?: GeminiCredentials;
  private readonly nonces: NonceSource;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GeminiClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? GEMINI_PRODUCTION_URL).replace(/\/$/, '');
    if (opts.credentials) this.creds = opts.credentials;
    this.nonces = new NonceSource(opts.nonceMode ?? 'time');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  // ── public market data ──

  async listEvents(q: { status?: string; category?: string; limit?: number; offset?: number } = {}): Promise<GeminiEvent[]> {
    const params = new URLSearchParams({ status: q.status ?? 'active', limit: String(q.limit ?? 50), offset: String(q.offset ?? 0) });
    if (q.category) params.set('category', q.category);
    const json = await this.get(`/v1/prediction-markets/events?${params}`);
    return eventListSchema.parse(json).data.map(normaliseEvent);
  }

  async getEvent(ticker: string): Promise<GeminiEvent> {
    return normaliseEvent(await this.get(`/v1/prediction-markets/events/${encodeURIComponent(ticker)}`));
  }

  async getBook(instrumentSymbol: string, depth = 10): Promise<GeminiBook> {
    return normaliseBook(await this.get(`/v1/book/${encodeURIComponent(instrumentSymbol)}?limit_bids=${depth}&limit_asks=${depth}`));
  }

  // ── private (signed) ──

  /** Immediate-or-cancel limit order: fills what it can at once, cancels the rest. */
  async placeOrder(order: VenueOrder): Promise<GeminiOrder> {
    const json = await this.post('/v1/prediction-markets/order', {
      symbol: order.symbol,
      orderType: 'limit',
      side: order.side,
      quantity: order.quantity,
      price: order.price,
      outcome: order.outcome,
      timeInForce: 'immediate-or-cancel',
    });
    return orderSchema.parse(json);
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.post('/v1/prediction-markets/order/cancel', { orderId: Number(orderId) });
  }

  async activeOrders(symbol?: string): Promise<GeminiOrder[]> {
    const json = await this.post('/v1/prediction-markets/orders/active', symbol ? { symbol } : {});
    return z.object({ orders: z.array(orderSchema) }).passthrough().parse(json).orders;
  }

  async orderHistory(q: { symbol?: string; from?: number; limit?: number } = {}): Promise<GeminiOrder[]> {
    const json = await this.post('/v1/prediction-markets/orders/history', q);
    return z.object({ orders: z.array(orderSchema) }).passthrough().parse(json).orders;
  }

  async positions(): Promise<z.infer<typeof positionSchema>[]> {
    const json = await this.post('/v1/prediction-markets/positions', {});
    return z.object({ positions: z.array(positionSchema) }).passthrough().parse(json).positions;
  }

  /** (verify) Path from the plan; the docs name the field `hasAcceptedLatest`. */
  async termsStatus(): Promise<boolean> {
    const json = await this.post('/v1/prediction-markets/terms/status', {});
    return z.object({ hasAcceptedLatest: z.boolean() }).passthrough().parse(json).hasAcceptedLatest;
  }

  /** Owner action only. The guard never calls this. (verify) */
  async acceptTerms(): Promise<void> {
    await this.post('/v1/prediction-markets/terms/accept', {});
  }

  /** Available balances (Gemini's standard endpoint); USD is what prediction markets trade in. */
  async balances(): Promise<{ currency: string; available: string }[]> {
    const json = await this.post('/v1/balances', {});
    return z.array(z.object({ currency: z.string(), available: z.string() }).passthrough()).parse(json);
  }

  private async get(path: string): Promise<unknown> {
    return this.send(path, { method: 'GET' });
  }

  private async post(path: string, fields: Record<string, unknown>): Promise<unknown> {
    if (!this.creds) throw new GeminiError(0, 'MissingCredentials', `${path} needs GEMINI_API_KEY and GEMINI_API_SECRET.`);
    const headers = signRequest(path, fields, this.creds, this.nonces.next());
    return this.send(path, { method: 'POST', headers });
  }

  private async send(path: string, init: RequestInit): Promise<unknown> {
    const route = path.split('?')[0]!;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
    } catch (err) {
      throw new GeminiError(0, 'Network', `Gemini ${route} could not be reached: ${err instanceof Error ? err.message : String(err)}`);
    }
    // orderId and instrumentId are int64: quote them before parsing, or JSON.parse rounds them past 2^53.
    const text = (await res.text()).replace(/"(orderId|instrumentId)"\s*:\s*(\d+)/g, '"$1":"$2"');
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new GeminiError(res.status, 'BadResponse', `Gemini ${route} answered ${res.status} with non-JSON.`);
    }
    if (!res.ok) {
      const body = (json && typeof json === 'object' ? json : {}) as { reason?: unknown; message?: unknown };
      const reason = typeof body.reason === 'string' ? body.reason : `HTTP${res.status}`;
      const message = typeof body.message === 'string' ? body.message : text.slice(0, 200);
      throw new GeminiError(res.status, reason, `Gemini ${route} refused (${res.status} ${reason}): ${message}`);
    }
    return json;
  }
}

/** Public market data from a client, with event search applied locally. */
export class GeminiMarketData implements MarketData {
  constructor(private readonly client: GeminiClient) {}

  async listEvents(q: { search?: string; category?: string; limit?: number } = {}): Promise<GeminiEvent[]> {
    const events = await this.client.listEvents({ limit: 100, ...(q.category ? { category: q.category } : {}) });
    return filterEvents(events, q);
  }

  getEvent(ticker: string): Promise<GeminiEvent> {
    return this.client.getEvent(ticker);
  }

  getBook(symbol: string): Promise<GeminiBook> {
    return this.client.getBook(symbol);
  }
}

export function filterEvents(events: GeminiEvent[], q: { search?: string; category?: string; limit?: number }): GeminiEvent[] {
  const words = (q.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return events
    .filter((e) => !q.category || e.category?.toLowerCase() === q.category.toLowerCase())
    .filter((e) => words.every((w) => `${e.title} ${e.ticker} ${e.category ?? ''}`.toLowerCase().includes(w)))
    .slice(0, q.limit ?? 10);
}

/** A real Gemini venue (sandbox or production). Market data may come from elsewhere (production). */
export class RestVenue implements Venue {
  constructor(readonly kind: Exclude<VenueKind, 'simulated'>, private readonly trading: GeminiClient, private readonly data: MarketData) {}

  listEvents(q?: { search?: string; category?: string; limit?: number }) { return this.data.listEvents(q); }
  getEvent(ticker: string) { return this.data.getEvent(ticker); }
  getBook(symbol: string) { return this.data.getBook(symbol); }
  termsAccepted() { return this.trading.termsStatus(); }

  async placeOrder(order: VenueOrder): Promise<VenueOrderState> {
    return toState(await this.trading.placeOrder(order));
  }

  async orderStatus(orderId: string): Promise<VenueOrderState> {
    const active = await this.trading.activeOrders();
    const found = active.find((o) => o.orderId === orderId) ?? (await this.trading.orderHistory({ limit: 100 })).find((o) => o.orderId === orderId);
    if (!found) throw new GeminiError(404, 'OrderNotFound', `Order ${orderId} is in neither active orders nor recent history.`);
    return toState(found);
  }

  cancelOrder(orderId: string) { return this.trading.cancelOrder(orderId); }

  async positions(): Promise<VenuePosition[]> {
    return (await this.trading.positions()).map((p) => ({
      symbol: p.symbol,
      outcome: p.outcome.toLowerCase() === 'no' ? 'no' : 'yes',
      quantity: p.totalQuantity,
      ...(p.avgPrice ? { avgPrice: p.avgPrice } : {}),
    }));
  }
}

function toState(o: GeminiOrder): VenueOrderState {
  return {
    orderId: o.orderId,
    status: o.status,
    filledQuantity: o.filledQuantity ?? '0',
    remainingQuantity: o.remainingQuantity ?? '0',
    ...(o.avgExecutionPrice ? { avgPrice: o.avgExecutionPrice } : {}),
  };
}
