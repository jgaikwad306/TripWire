import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SimulatedVenue } from '../../src/fakes/gemini-venue.js';
import { MARKET_TASK, marketPolicy } from '../../src/gemini/demo.js';
import { GeminiError } from '../../src/gemini/client.js';
import { loadSnapshot, pickDemoMarket } from '../../src/gemini/snapshot.js';
import { MemoryAuditLog } from '../../src/guard/audit.js';
import { evaluateMarket, type MarketFacts } from '../../src/guard/market.js';
import { AllowAllTrader, GuardedTrader, JsonFileMarketStore } from '../../src/guard/market-guard.js';
import type { Venue } from '../../src/gemini/venue.js';
import type { PredictionOrderRequest } from '../../src/types.js';

const snap = loadSnapshot();
const now = Date.parse(snap.capturedAt);
const demo = pickDemoMarket(snap.events, now);
const policy = marketPolicy(demo);
const event = snap.events.find((e) => e.ticker === demo.task.eventTicker)!;

const honest: PredictionOrderRequest = {
  eventTicker: demo.task.eventTicker, symbol: demo.task.symbol, outcome: 'yes', side: 'buy', quantity: '5', limitPrice: demo.task.bestAsk, reason: 'thesis',
};
const facts = (over: Partial<MarketFacts> = {}, req: Partial<PredictionOrderRequest> = {}): MarketFacts => ({
  request: { ...honest, ...req }, event, task: { name: MARKET_TASK, session: 's1' }, orders: [], openSymbols: [], ...over,
});
const check = (over: Partial<MarketFacts> = {}, req: Partial<PredictionOrderRequest> = {}) => evaluateMarket(facts(over, req), policy, now).check;

describe('market checks (pure)', () => {
  it('allows the honest order', () => expect(check()).toBe('ok'));

  it('each check denies alone, in order', () => {
    expect(check({ event: undefined, eventError: 'down' })).toBe('market');
    expect(check({}, { symbol: demo.thin.symbol })).toBe('market');
    const closed = { ...event, contracts: event.contracts.map((c) => ({ ...c, marketState: 'closed' })) };
    expect(check({ event: closed })).toBe('market-state');
    const expiring = { ...event, contracts: event.contracts.map((c) => ({ ...c, expiresAt: new Date(now + 30_000).toISOString() })) };
    expect(check({ event: expiring })).toBe('market-state');
    expect(check({ task: undefined })).toBe('market');
    expect(check({}, { side: 'sell' })).toBe('side');
    expect(check({}, { outcome: 'no' })).toBe('outcome');
    expect(check({}, { limitPrice: '0.99' })).toBe('price');
    expect(check({}, { limitPrice: 'abc' })).toBe('price');
    expect(check({}, { limitPrice: (Number(demo.task.bestAsk) * 1.1).toFixed(2) })).toBe('slippage');
    expect(check({}, { quantity: '26' })).toBe('limits');
    expect(check({}, { quantity: '2.5' })).toBe('limits');
    const spent = { symbol: 'other', side: 'buy' as const, outcome: 'yes' as const, cost: policy.tasks[MARKET_TASK]!.budget, at: now, session: 's1', status: 'placed' as const };
    expect(check({ orders: [spent] })).toBe('budget');
    const same = { ...spent, symbol: demo.task.symbol, cost: 0n };
    expect(check({ orders: [same, same, same] })).toBe('rate-limit');
    expect(check({ orders: [same] })).toBe('duplicate');
    expect(check({ openSymbols: [demo.task.symbol] })).toBe('duplicate');
  });

  it('uses its own book, never the agent price, for slippage (and 1 − bid for NO)', () => {
    const book = { bids: [{ price: '0.40', amount: '10' }], asks: [{ price: '0.20', amount: '10' }] };
    // The agent's limit equals the event's ask, but the guard's book says 0.20: too far above it.
    expect(check({ book }, { limitPrice: '0.5' })).toBe('slippage');
    const noPolicy = { ...policy, tasks: { [MARKET_TASK]: { ...policy.tasks[MARKET_TASK]!, outcomes: ['yes', 'no'] as const } } };
    expect(evaluateMarket(facts({ book }, { outcome: 'no', limitPrice: '0.6' }), noPolicy, now).check).toBe('ok');
    expect(evaluateMarket(facts({ book }, { outcome: 'no', limitPrice: '0.7' }), noPolicy, now).check).toBe('slippage');
  });
});

describe('GuardedTrader', () => {
  const trader = (venue: Venue = new SimulatedVenue(snap, { now: () => now }), extra = {}) =>
    new GuardedTrader({ venue, policy, now: () => now, ...extra });

  it('places the honest order, records the order id, audits it', async () => {
    const audit = new MemoryAuditLog();
    const t = trader(undefined, { audit });
    t.beginMarketTask(MARKET_TASK);
    const result = await t.placeOrder(honest);
    expect(result.decision).toMatchObject({ allowed: true, orderRef: '1' });
    expect(result.order).toMatchObject({ filledQuantity: '5' });
    expect(result.reference?.bestAsk).toBe(demo.task.bestAsk);
    expect(audit.entries[0]).toMatchObject({ kind: 'market', allowed: true, orderRef: '1' });
  });

  it('decides on its own fetch: denies when Gemini cannot be read, whatever the agent says', async () => {
    const venue = new SimulatedVenue(snap, { now: () => now });
    venue.getEvent = async () => { throw new Error('ECONNREFUSED'); };
    const t = trader(venue);
    t.beginMarketTask(MARKET_TASK);
    expect((await t.placeOrder(honest)).decision).toMatchObject({ allowed: false, check: 'market' });
  });

  it('denies with venue when terms are not accepted, and does not count a refused order', async () => {
    const venue = new SimulatedVenue(snap, { now: () => now });
    venue.termsAccepted = async () => false;
    const t = trader(venue);
    t.beginMarketTask(MARKET_TASK);
    expect((await t.placeOrder(honest)).decision.check).toBe('venue');
    const refusing = new SimulatedVenue(snap, { now: () => now });
    refusing.placeOrder = async () => { throw new GeminiError(400, 'InvalidQuantity', 'nope'); };
    const t2 = trader(refusing);
    t2.beginMarketTask(MARKET_TASK);
    expect((await t2.placeOrder(honest)).decision.check).toBe('venue');
    // Refused for sure, so the same order is not a duplicate.
    refusing.placeOrder = SimulatedVenue.prototype.placeOrder.bind(refusing);
    expect((await t2.placeOrder(honest)).decision.allowed).toBe(true);
  });

  it('cancels an order a venue leaves open', async () => {
    const venue = new SimulatedVenue(snap, { now: () => now });
    let cancelled = '';
    venue.placeOrder = async () => ({ orderId: '42', status: 'open', filledQuantity: '0', remainingQuantity: '5' });
    venue.orderStatus = async (id) => ({ orderId: id, status: cancelled ? 'cancelled' : 'open', filledQuantity: '0', remainingQuantity: cancelled ? '0' : '5' });
    venue.cancelOrder = async (id) => { cancelled = id; };
    let clock = now;
    const t = new GuardedTrader({ venue, policy, now: () => clock, sleep: async (ms) => { clock += ms; } });
    t.beginMarketTask(MARKET_TASK);
    const result = await t.placeOrder(honest);
    expect(cancelled).toBe('42');
    expect(result.order?.status).toBe('cancelled');
  });

  it('keeps its limits across a restart', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'market-')), 'state.json');
    const first = trader(undefined, { store: new JsonFileMarketStore(path) });
    first.beginMarketTask(MARKET_TASK);
    expect((await first.placeOrder(honest)).decision.allowed).toBe(true);
    const second = trader(undefined, { store: new JsonFileMarketStore(path) });
    second.beginMarketTask(MARKET_TASK);
    expect((await second.placeOrder(honest)).decision.check).toBe('duplicate');
  });

  it('rejects a malformed request and an undeclared task', async () => {
    const t = trader();
    expect(() => t.beginMarketTask('drain-everything')).toThrow(/not in the policy/);
    t.beginMarketTask(MARKET_TASK);
    expect((await t.placeOrder({ ...honest, outcome: 'maybe' as 'yes' })).decision.check).toBe('market');
  });
});

describe('AllowAllTrader (unguarded baseline)', () => {
  it('refuses any venue but the simulated one', () => {
    const live = { ...new SimulatedVenue(snap), kind: 'production' } as unknown as Venue;
    expect(() => new AllowAllTrader(live)).toThrow(/only ever go to the simulated venue/);
    expect(() => new AllowAllTrader({ kind: 'sandbox' } as Venue)).toThrow();
  });

  it('sends whatever it is asked', async () => {
    const t = new AllowAllTrader(new SimulatedVenue(snap, { now: () => now }));
    const result = await t.placeOrder({ ...honest, eventTicker: 'anything', symbol: demo.offTask.symbol, quantity: '40', limitPrice: '0.97' });
    expect(result.decision.allowed).toBe(true);
    expect(Number(result.order?.filledQuantity)).toBeGreaterThan(0);
  });
});
