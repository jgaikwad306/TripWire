import type { GeminiBook, GeminiEvent } from './schemas.js';

/** Read-only market data. Always real Gemini data, or a captured snapshot of it offline. */
export interface MarketData {
  listEvents(q?: { search?: string; category?: string; limit?: number }): Promise<GeminiEvent[]>;
  /** A fresh read: the guard decides on this, never on what the agent quotes. */
  getEvent(ticker: string): Promise<GeminiEvent>;
  /** YES-space depth for a contract, best first. */
  getBook(instrumentSymbol: string): Promise<GeminiBook>;
}

export type VenueKind = 'simulated' | 'sandbox' | 'production';

/** A limit order in the outcome's own price space: a NO order's price is the NO price. */
export interface VenueOrder {
  symbol: string;
  side: 'buy' | 'sell';
  outcome: 'yes' | 'no';
  /** Contracts, decimal string. */
  quantity: string;
  /** 0–1, decimal string. */
  price: string;
}

export interface VenueOrderState {
  orderId: string;
  /** 'open' | 'filled' | 'cancelled' on Gemini. */
  status: string;
  filledQuantity: string;
  remainingQuantity: string;
  avgPrice?: string;
}

export interface VenuePosition {
  symbol: string;
  outcome: 'yes' | 'no';
  quantity: string;
  avgPrice?: string;
}

/** Where orders go. Only the market guard (or the unguarded baseline, simulated only) holds one. */
export interface Venue extends MarketData {
  readonly kind: VenueKind;
  termsAccepted(): Promise<boolean>;
  /** Immediate-or-cancel: whatever does not fill at once is cancelled, so nothing rests. */
  placeOrder(order: VenueOrder): Promise<VenueOrderState>;
  orderStatus(orderId: string): Promise<VenueOrderState>;
  cancelOrder(orderId: string): Promise<void>;
  positions(): Promise<VenuePosition[]>;
}
