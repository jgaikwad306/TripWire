import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { emit, type EventSink } from '../events.js';
import { GeminiError } from '../gemini/client.js';
import { decimal, plusBps, units, notional } from '../gemini/money.js';
import type { GeminiBook, GeminiEvent } from '../gemini/schemas.js';
import type { MarketData, Venue, VenueOrderState } from '../gemini/venue.js';
import type { Decision, MarketGuard, PredictionOrderRequest, PredictionOrderResult } from '../types.js';
import { auditEntry, safeAppend, type AuditLog } from './audit.js';
import { CHECK, allow, deny, errorMessage } from './checks.js';
import { evaluateMarket, orderCost, type MarketOrderRecord } from './market.js';
import type { MarketPolicy } from './policy.js';

/** What the market guard keeps so caps, budgets and duplicates survive a restart. */
export interface MarketState {
  orders: (MarketOrderRecord & { id: string; orderRef?: string })[];
}

export interface MarketStore {
  load(): MarketState;
  save(state: MarketState): void;
}

export class MemoryMarketStore implements MarketStore {
  private state: MarketState = { orders: [] };
  load(): MarketState {
    return structuredClone(this.state);
  }
  save(state: MarketState): void {
    this.state = structuredClone(state);
  }
}

export const DEFAULT_MARKET_STATE_FILE = '.data/market-guard.json';

const recordSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  outcome: z.enum(['yes', 'no']),
  cost: z.string().transform((v) => BigInt(v)),
  at: z.number(),
  session: z.string().optional(),
  status: z.enum(['pending', 'placed', 'failed']),
  orderRef: z.string().optional(),
});

/** One JSON file, replaced atomically on every save. */
export class JsonFileMarketStore implements MarketStore {
  constructor(readonly path: string = DEFAULT_MARKET_STATE_FILE) {}

  load(): MarketState {
    if (!existsSync(this.path)) return { orders: [] };
    const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { orders?: unknown };
    return { orders: z.array(recordSchema).parse(raw.orders ?? []).map((o) => ({ ...o })) as MarketState['orders'] };
  }

  save(state: MarketState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2));
    renameSync(tmp, this.path);
  }
}

export interface GuardedTraderOptions {
  venue: Venue;
  /** Where the guard reads events and books. Defaults to the venue. */
  marketData?: MarketData;
  policy: MarketPolicy;
  store?: MarketStore;
  audit?: AuditLog;
  now?: () => number;
  onEvent?: EventSink;
  /** Waits between fill polls, for the rare order a venue leaves open. */
  sleep?: (ms: number) => Promise<void>;
}

const requestSchema = z.object({
  eventTicker: z.string().min(1).max(128),
  symbol: z.string().min(1).max(128),
  outcome: z.enum(['yes', 'no']),
  side: z.enum(['buy', 'sell']),
  quantity: z.string().max(32),
  limitPrice: z.string().max(32),
  reason: z.string().max(2000).default(''),
});

/**
 * Decides every prediction market order. It alone holds the venue (and so the Gemini key);
 * policy is frozen at construction; each decision is recorded and audited; the first failing
 * check denies. It reads the event and book itself at decision time: the agent's symbols and
 * prices are only compared with that read.
 */
export class GuardedTrader implements MarketGuard {
  private readonly venue: Venue;
  private readonly data: MarketData;
  private readonly policy: MarketPolicy;
  private readonly store: MarketStore;
  private readonly now: () => number;
  private readonly log: Decision[] = [];
  private task?: { name: string; session: string };
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: GuardedTraderOptions) {
    this.venue = opts.venue;
    this.data = opts.marketData ?? opts.venue;
    this.policy = opts.policy;
    this.store = opts.store ?? new MemoryMarketStore();
    this.now = opts.now ?? Date.now;
  }

  beginMarketTask(name: string): void {
    if (!this.policy.tasks[name]) throw new Error(`Market task "${name}" is not in the policy.`);
    this.task = { name, session: randomUUID() };
  }

  decisions(): Decision[] {
    return [...this.log];
  }

  positions() {
    return this.venue.positions();
  }

  async cancelOrder(orderId: string): Promise<Decision> {
    return this.serial(async () => {
      const mine = this.store.load().orders.some((o) => o.orderRef === String(orderId));
      const decision = mine
        ? await this.venue.cancelOrder(String(orderId)).then(
            () => allow(`Cancelled order ${orderId}.`),
            (err) => deny(CHECK.venue, `Gemini did not cancel ${orderId}: ${errorMessage(err)}`),
          )
        : deny(CHECK.market, `Order ${orderId} was not placed by this guard.`);
      this.log.push(decision);
      return decision;
    });
  }

  /** One order at a time, so two requests cannot both pass a cap that only fits one. */
  placeOrder(input: PredictionOrderRequest): Promise<PredictionOrderResult> {
    return this.serial(() => this.decide(input));
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async decide(input: PredictionOrderRequest): Promise<PredictionOrderResult> {
    const operationId = randomUUID();
    emit(this.opts.onEvent, { type: 'operation.started', data: { operationId, side: 'market', request: input } });
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) {
      return this.finish(operationId, input, { decision: deny(CHECK.market, `The order request is malformed: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}.`) });
    }
    const req = parsed.data;
    const now = this.now();

    let event: GeminiEvent | undefined;
    let eventError: string | undefined;
    try {
      event = await this.data.getEvent(req.eventTicker);
    } catch (err) {
      eventError = errorMessage(err);
    }
    const contract = event?.contracts.find((c) => c.instrumentSymbol === req.symbol);
    let book: GeminiBook | undefined;
    if (contract) book = await this.data.getBook(req.symbol).catch(() => undefined);
    const reference = event && contract
      ? {
          eventTicker: event.ticker,
          marketState: contract.marketState,
          ...((book?.bids[0]?.price ?? contract.bestBid) ? { bestBid: book?.bids[0]?.price ?? contract.bestBid! } : {}),
          ...((book?.asks[0]?.price ?? contract.bestAsk) ? { bestAsk: book?.asks[0]?.price ?? contract.bestAsk! } : {}),
        }
      : undefined;

    const state = this.store.load();
    const decision = evaluateMarket(
      {
        request: req,
        ...(event ? { event } : {}),
        ...(eventError ? { eventError } : {}),
        ...(book ? { book } : {}),
        ...(this.task ? { task: this.task } : {}),
        orders: state.orders,
        openSymbols: state.orders.filter((o) => o.status === 'pending').map((o) => o.symbol),
      },
      this.policy,
      now,
    );
    const base = { ...(reference ? { reference } : {}), venue: this.venue.kind };
    if (!decision.allowed) return this.finish(operationId, req, { decision, ...base });

    try {
      if (!(await this.venue.termsAccepted())) {
        return this.finish(operationId, req, { decision: deny(CHECK.venue, "Gemini's prediction market terms are not accepted on this account. The owner must accept them; the guard never does."), ...base });
      }
    } catch (err) {
      return this.finish(operationId, req, { decision: deny(CHECK.venue, `Could not confirm the terms are accepted: ${errorMessage(err)}`), ...base });
    }

    // Written down before it is sent: if we crash mid-order, it still counts against the caps.
    const record = { id: randomUUID(), symbol: req.symbol, side: req.side, outcome: req.outcome, cost: orderCost(req, this.policy), at: now, ...(this.task ? { session: this.task.session } : {}), status: 'pending' as const };
    this.store.save({ orders: [...state.orders, record] });

    let placed: VenueOrderState;
    try {
      placed = await this.venue.placeOrder({ symbol: req.symbol, side: req.side, outcome: req.outcome, quantity: req.quantity, price: req.limitPrice });
    } catch (err) {
      // A clear refusal means nothing was placed. Anything else may have reached Gemini, so it keeps counting.
      const refused = err instanceof GeminiError && err.status >= 400 && err.status < 500;
      this.update(record.id, { status: refused ? 'failed' : 'placed' });
      return this.finish(operationId, req, { decision: deny(CHECK.venue, `Gemini did not take the order: ${errorMessage(err)}`), ...base });
    }
    const final = await this.settle(placed);
    const filled = units(final.filledQuantity || '0');
    // Only what filled stays committed against budget and caps.
    const committed = req.side === 'buy' && final.avgPrice ? plusBps(notional(units(final.avgPrice), filled), this.policy.feeBufferBps) : 0n;
    this.update(record.id, { status: 'placed', orderRef: final.orderId, cost: committed });
    const fillText = filled > 0n ? `filled ${decimal(filled)} at ${final.avgPrice}` : 'nothing filled at that price';
    return this.finish(operationId, req, {
      decision: { ...allow(`All market checks passed. ${this.venue.kind === 'simulated' ? 'Simulated' : 'Gemini'} order ${final.orderId}: ${req.side} ${req.quantity} ${req.outcome.toUpperCase()} at ≤ ${req.limitPrice}, ${fillText}.`), orderRef: final.orderId },
      order: { orderId: final.orderId, status: final.status, filledQuantity: final.filledQuantity, ...(final.avgPrice ? { avgPrice: final.avgPrice } : {}) },
      ...base,
    });
  }

  /** Orders are immediate-or-cancel; if a venue still reports one open, wait briefly, then cancel the rest. */
  private async settle(state: VenueOrderState): Promise<VenueOrderState> {
    if (state.status !== 'open') return state;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const deadline = this.now() + this.policy.fillTimeoutMs;
    let current = state;
    while (current.status === 'open' && this.now() < deadline) {
      await sleep(500);
      current = await this.venue.orderStatus(state.orderId).catch(() => current);
    }
    if (current.status === 'open') {
      await this.venue.cancelOrder(state.orderId).catch(() => undefined);
      current = await this.venue.orderStatus(state.orderId).catch(() => ({ ...current, status: 'cancelled' }));
    }
    return current;
  }

  private update(id: string, patch: Partial<MarketState['orders'][number]>): void {
    const state = this.store.load();
    this.store.save({ orders: state.orders.map((o) => (o.id === id ? { ...o, ...patch } : o)) });
  }

  private finish(operationId: string, req: PredictionOrderRequest, result: PredictionOrderResult): PredictionOrderResult {
    this.log.push(result.decision);
    safeAppend(this.opts.audit, auditEntry(result.decision, { kind: 'market', resource: req.symbol, ...(req.side === 'buy' && /^\d/.test(req.limitPrice) ? { amountUsdc: `${req.quantity} @ ${req.limitPrice}` } : {}) }, 'on'));
    emit(this.opts.onEvent, {
      type: 'guard.decision',
      data: { operationId, side: 'market', request: req, decision: result.decision, ...(result.order ? { order: result.order } : {}), ...(result.reference ? { reference: result.reference } : {}), ...(result.venue ? { venue: result.venue } : {}) },
    });
    return result;
  }
}

/**
 * The unguarded baseline: every order goes straight to the venue as the agent asked. Its
 * constructor refuses any venue but the simulated one, so an unguarded order can never
 * reach Gemini sandbox or production.
 */
export class AllowAllTrader implements MarketGuard {
  private readonly log: Decision[] = [];

  constructor(private readonly venue: Venue, private readonly opts: { audit?: AuditLog; onEvent?: EventSink } = {}) {
    if (venue.kind !== 'simulated') throw new Error(`Unguarded market orders only ever go to the simulated venue, not ${venue.kind}.`);
  }

  beginMarketTask(): void {}

  decisions(): Decision[] {
    return [...this.log];
  }

  positions() {
    return this.venue.positions();
  }

  async cancelOrder(orderId: string): Promise<Decision> {
    await this.venue.cancelOrder(String(orderId)).catch(() => undefined);
    return { allowed: true, check: 'none', reason: 'No guard: cancelled as asked.' };
  }

  async placeOrder(req: PredictionOrderRequest): Promise<PredictionOrderResult> {
    const operationId = randomUUID();
    emit(this.opts.onEvent, { type: 'operation.started', data: { operationId, side: 'market', request: req } });
    let result: PredictionOrderResult;
    try {
      const placed = await this.venue.placeOrder({ symbol: String(req.symbol), side: req.side, outcome: req.outcome, quantity: String(req.quantity), price: String(req.limitPrice) });
      result = {
        decision: { allowed: true, check: 'none', reason: `No guard: the order was sent as asked (filled ${placed.filledQuantity}${placed.avgPrice ? ` at ${placed.avgPrice}` : ''}).`, orderRef: placed.orderId },
        order: { orderId: placed.orderId, status: placed.status, filledQuantity: placed.filledQuantity, ...(placed.avgPrice ? { avgPrice: placed.avgPrice } : {}) },
        venue: this.venue.kind,
      };
    } catch (err) {
      result = { decision: { allowed: false, check: 'none', reason: `The venue refused the order: ${errorMessage(err)}` }, venue: this.venue.kind };
    }
    this.log.push(result.decision);
    safeAppend(this.opts.audit, auditEntry(result.decision, { kind: 'market', resource: String(req.symbol) }, 'off'));
    emit(this.opts.onEvent, { type: 'guard.decision', data: { operationId, side: 'market', request: req, decision: result.decision, ...(result.order ? { order: result.order } : {}), venue: this.venue.kind } });
    return result;
  }
}
