import { filterEvents } from '../gemini/client.js';
import { ONE, decimal, flip, notional, units } from '../gemini/money.js';
import type { GeminiBook, GeminiEvent } from '../gemini/schemas.js';
import type { MarketSnapshot } from '../gemini/snapshot.js';
import type { Venue, VenueOrder, VenueOrderState, VenuePosition } from '../gemini/venue.js';

/** Who a resting order belongs to: real depth from the snapshot, or liquidity the red team planted. */
export type LiquidityOwner = 'market' | 'attacker';

interface Level {
  price: bigint;
  quantity: bigint;
  owner: LiquidityOwner;
}

/** One execution. Prices are in the order's outcome space. */
export interface SimFill {
  orderId: string;
  symbol: string;
  outcome: 'yes' | 'no';
  side: 'buy' | 'sell';
  quantity: bigint;
  price: bigint;
  counterparty: LiquidityOwner;
}

/** Depth added below the snapshot's own levels, so large orders have something to walk into. */
const SYNTHETIC_STEPS = [0n, 20_000n, 50_000n];
const SYNTHETIC_QUANTITY = 100n * ONE;
const MIN_PRICE = 10_000n;
const MAX_PRICE = 990_000n;

/**
 * An in-memory exchange seeded from a real Gemini snapshot. It makes the unguarded pass
 * measurable: a bad order really fills, against real depth or against the attacker's planted
 * orders, and every fill records its counterparty. Deterministic: no randomness.
 *
 * Expiries are shifted so each contract stays as far from expiry as it was at capture: an
 * offline run long after the snapshot still sees open markets (and near-expiry ones).
 */
export class SimulatedVenue implements Venue {
  readonly kind = 'simulated' as const;
  private readonly events = new Map<string, GeminiEvent>();
  private readonly books = new Map<string, { bids: Level[]; asks: Level[] }>();
  private readonly positionsHeld = new Map<string, { quantity: bigint; cost: bigint }>();
  private readonly orders = new Map<string, VenueOrderState>();
  private readonly fillLog: SimFill[] = [];
  private nextId = 1;
  usdBalance: bigint;

  constructor(snapshot: MarketSnapshot, opts: { now?: () => number; usd?: bigint } = {}) {
    const now = opts.now ?? Date.now;
    const shift = now() - Date.parse(snapshot.capturedAt);
    const move = (iso?: string) => (iso ? new Date(Date.parse(iso) + shift).toISOString() : undefined);
    for (const event of snapshot.events) {
      const shifted: GeminiEvent = {
        ...event,
        ...(event.expiresAt ? { expiresAt: move(event.expiresAt)! } : {}),
        contracts: event.contracts.map((c) => ({ ...c, ...(c.expiresAt ? { expiresAt: move(c.expiresAt)! } : {}) })),
      };
      this.events.set(event.ticker, shifted);
      for (const c of shifted.contracts) this.books.set(c.instrumentSymbol, seedBook(snapshot.books[c.instrumentSymbol], c.bestBid, c.bestAsk));
    }
    this.usdBalance = opts.usd ?? 1_000n * ONE;
  }

  // ── red-team controls ──

  /** Planted orders. Asks are sold to a buyer; bids buy from a seller. YES-space prices. */
  addAttackerLiquidity(symbol: string, side: 'asks' | 'bids', levels: { price: string; quantity: string }[]): void {
    const book = this.bookOf(symbol);
    for (const l of levels) book[side].push({ price: units(l.price), quantity: units(l.quantity), owner: 'attacker' });
    sortBook(book);
  }

  /** Removes the market's own depth on one side, e.g. a thin market or a halted one. */
  clearMarketLiquidity(symbol: string, side: 'asks' | 'bids'): void {
    const book = this.bookOf(symbol);
    book[side] = book[side].filter((l) => l.owner !== 'market');
  }

  setContractState(symbol: string, state: { marketState?: string; expiresAt?: string }): void {
    for (const event of this.events.values()) {
      const c = event.contracts.find((x) => x.instrumentSymbol === symbol);
      if (c) Object.assign(c, state);
    }
  }

  fills(): SimFill[] {
    return [...this.fillLog];
  }

  // ── market data ──

  async listEvents(q: { search?: string; category?: string; limit?: number } = {}): Promise<GeminiEvent[]> {
    return filterEvents([...this.events.values()].map((e) => this.view(e)), q);
  }

  async getEvent(ticker: string): Promise<GeminiEvent> {
    const event = this.events.get(ticker);
    if (!event) throw new Error(`Gemini has no event "${ticker}".`);
    return this.view(event);
  }

  async getBook(symbol: string): Promise<GeminiBook> {
    const book = this.books.get(symbol);
    if (!book) throw new Error(`Gemini has no contract "${symbol}".`);
    const side = (levels: Level[]) => levels.map((l) => ({ price: decimal(l.price), amount: decimal(l.quantity) }));
    return { bids: side(book.bids), asks: side(book.asks) };
  }

  // ── trading ──

  async termsAccepted(): Promise<boolean> {
    return true;
  }

  /** Immediate-or-cancel limit order: walks the book up to the limit, the rest is cancelled. */
  async placeOrder(order: VenueOrder): Promise<VenueOrderState> {
    const book = this.bookOf(order.symbol);
    const limit = units(order.price);
    let remaining = units(order.quantity);
    if (limit <= 0n || limit >= ONE || remaining <= 0n) throw new Error('Price must be between 0 and 1 and quantity positive.');
    const key = `${order.symbol}|${order.outcome}`;
    const held = this.positionsHeld.get(key) ?? { quantity: 0n, cost: 0n };
    if (order.side === 'sell' && held.quantity < remaining) {
      throw new Error(`Cannot sell ${decimal(remaining)} ${order.outcome.toUpperCase()}: only ${decimal(held.quantity)} held.`);
    }
    // Buying YES lifts asks; selling YES hits bids. NO trades against the opposite YES side.
    const takesAsks = (order.outcome === 'yes') === (order.side === 'buy');
    const levels = takesAsks ? book.asks : book.bids;
    const orderId = String(this.nextId++);
    let filled = 0n;
    let value = 0n;
    for (const level of levels) {
      if (remaining === 0n) break;
      const price = order.outcome === 'yes' ? level.price : flip(level.price);
      const acceptable = order.side === 'buy' ? price <= limit : price >= limit;
      if (!acceptable) break;
      const qty = level.quantity < remaining ? level.quantity : remaining;
      if (order.side === 'buy' && notional(price, qty) > this.usdBalance) break;
      level.quantity -= qty;
      remaining -= qty;
      filled += qty;
      value += notional(price, qty);
      this.usdBalance += order.side === 'buy' ? -notional(price, qty) : notional(price, qty);
      this.fillLog.push({ orderId, symbol: order.symbol, outcome: order.outcome, side: order.side, quantity: qty, price, counterparty: level.owner });
    }
    if (takesAsks) book.asks = book.asks.filter((l) => l.quantity > 0n);
    else book.bids = book.bids.filter((l) => l.quantity > 0n);
    if (filled > 0n) {
      if (order.side === 'buy') this.positionsHeld.set(key, { quantity: held.quantity + filled, cost: held.cost + value });
      else this.positionsHeld.set(key, { quantity: held.quantity - filled, cost: held.quantity === 0n ? 0n : held.cost - (held.cost * filled) / held.quantity });
    }
    const state: VenueOrderState = {
      orderId,
      status: filled > 0n ? (remaining === 0n ? 'filled' : 'cancelled') : 'cancelled',
      filledQuantity: decimal(filled),
      remainingQuantity: '0',
      ...(filled > 0n ? { avgPrice: decimal((value * ONE) / filled) } : {}),
    };
    this.orders.set(orderId, state);
    return state;
  }

  async orderStatus(orderId: string): Promise<VenueOrderState> {
    const state = this.orders.get(orderId);
    if (!state) throw new Error(`No order ${orderId}.`);
    return state;
  }

  async cancelOrder(orderId: string): Promise<void> {
    const state = this.orders.get(orderId);
    if (state && state.status === 'open') this.orders.set(orderId, { ...state, status: 'cancelled', remainingQuantity: '0' });
  }

  async positions(): Promise<VenuePosition[]> {
    return [...this.positionsHeld.entries()]
      .filter(([, p]) => p.quantity > 0n)
      .map(([key, p]) => {
        const [symbol, outcome] = key.split('|') as [string, 'yes' | 'no'];
        return { symbol, outcome, quantity: decimal(p.quantity), avgPrice: decimal((p.cost * ONE) / p.quantity) };
      });
  }

  // ── internals ──

  private bookOf(symbol: string) {
    const book = this.books.get(symbol);
    if (!book) throw new Error(`Gemini has no contract "${symbol}".`);
    return book;
  }

  /** The event with each contract's best bid and ask read from the current book. */
  private view(event: GeminiEvent): GeminiEvent {
    return structuredClone({
      ...event,
      contracts: event.contracts.map((c) => {
        const { bestBid: _b, bestAsk: _a, ...rest } = c;
        const book = this.books.get(c.instrumentSymbol);
        const bid = book?.bids[0];
        const ask = book?.asks[0];
        return { ...rest, ...(bid ? { bestBid: decimal(bid.price) } : {}), ...(ask ? { bestAsk: decimal(ask.price) } : {}) };
      }),
    });
  }
}

/** Real depth when the snapshot has it, else levels built around the best bid and ask. */
function seedBook(captured: GeminiBook | undefined, bestBid?: string, bestAsk?: string): { bids: Level[]; asks: Level[] } {
  const book = { bids: [] as Level[], asks: [] as Level[] };
  if (captured) {
    book.bids = captured.bids.map((l) => ({ price: units(l.price), quantity: units(l.amount), owner: 'market' as const }));
    book.asks = captured.asks.map((l) => ({ price: units(l.price), quantity: units(l.amount), owner: 'market' as const }));
  }
  const worstAsk = book.asks.at(-1)?.price ?? (bestAsk ? units(bestAsk) : undefined);
  const worstBid = book.bids.at(-1)?.price ?? (bestBid ? units(bestBid) : undefined);
  for (const step of SYNTHETIC_STEPS) {
    if (worstAsk !== undefined && worstAsk + step <= MAX_PRICE) book.asks.push({ price: worstAsk + step, quantity: SYNTHETIC_QUANTITY, owner: 'market' });
    if (worstBid !== undefined && worstBid - step >= MIN_PRICE) book.bids.push({ price: worstBid - step, quantity: SYNTHETIC_QUANTITY, owner: 'market' });
  }
  sortBook(book);
  return book;
}

function sortBook(book: { bids: Level[]; asks: Level[] }): void {
  // Price priority; at equal price the market's resting orders were there first.
  const rank = (l: Level) => (l.owner === 'market' ? 0 : 1);
  book.asks.sort((a, b) => (a.price === b.price ? rank(a) - rank(b) : a.price < b.price ? -1 : 1));
  book.bids.sort((a, b) => (a.price === b.price ? rank(a) - rank(b) : a.price > b.price ? -1 : 1));
}
