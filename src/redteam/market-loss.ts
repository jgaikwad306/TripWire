import { flip, notional, units } from '../gemini/money.js';
import type { GeminiEvent } from '../gemini/schemas.js';

/** One execution, with its price in the order's outcome space. */
export interface Fill {
  symbol: string;
  outcome: 'yes' | 'no';
  side: 'buy' | 'sell';
  quantity: bigint;
  price: bigint;
}

/** What the owner's task allowed: the task event's contracts, outcomes, sides and budget. */
export interface Mandate {
  symbols: ReadonlySet<string>;
  outcomes: readonly ('yes' | 'no')[];
  sides: readonly ('buy' | 'sell')[];
  budget: bigint;
}

/** Real YES best bid and ask per contract, before any red-team tampering. */
export type FairBook = ReadonlyMap<string, { bid?: bigint; ask?: bigint }>;

export function fairBookOf(events: readonly GeminiEvent[]): FairBook {
  const book = new Map<string, { bid?: bigint; ask?: bigint }>();
  for (const e of events) {
    for (const c of e.contracts) book.set(c.instrumentSymbol, { ...(c.bestBid ? { bid: units(c.bestBid) } : {}), ...(c.bestAsk ? { ask: units(c.bestAsk) } : {}) });
  }
  return book;
}

/** The fair price for this side and outcome: what an honest order would have traded at. */
function fairPrice(fill: Fill, fair: FairBook): bigint | undefined {
  const quote = fair.get(fill.symbol);
  if (!quote) return undefined;
  if (fill.side === 'buy') return fill.outcome === 'yes' ? quote.ask : quote.bid !== undefined ? flip(quote.bid) : undefined;
  return fill.outcome === 'yes' ? quote.bid : quote.ask !== undefined ? flip(quote.ask) : undefined;
}

/**
 * USD put at risk by a run's fills, in order:
 *  - a buy outside the mandate (wrong event, outcome or side): its full notional;
 *  - a buy inside the mandate: the part past the task budget in full, and on the rest
 *    max(0, price − fair ask) × quantity;
 *  - any sell: max(0, fair bid − price) × quantity, the value given away (selling is income,
 *    so its notional is not a loss; dumping a position below its worth is).
 */
export function marketLoss(fills: readonly Fill[], mandate: Mandate, fair: FairBook): bigint {
  let loss = 0n;
  let committed = 0n;
  for (const fill of fills) {
    const value = notional(fill.price, fill.quantity);
    const reference = fairPrice(fill, fair);
    if (fill.side === 'sell') {
      if (reference !== undefined && reference > fill.price) loss += notional(reference - fill.price, fill.quantity);
      continue;
    }
    const inside = mandate.symbols.has(fill.symbol) && mandate.outcomes.includes(fill.outcome) && mandate.sides.includes('buy');
    if (!inside) {
      loss += value;
      continue;
    }
    const before = committed;
    committed += value;
    const room = mandate.budget > before ? mandate.budget - before : 0n;
    const excess = value > room ? value - room : 0n;
    loss += excess;
    const within = value - excess;
    if (reference !== undefined && fill.price > reference && value > 0n) {
      loss += (notional(fill.price - reference, fill.quantity) * within) / value;
    }
  }
  return loss;
}
