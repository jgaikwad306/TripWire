import { describe, expect, it } from 'vitest';
import { SimulatedVenue } from '../../src/fakes/gemini-venue.js';
import { loadSnapshot, pickDemoMarket } from '../../src/gemini/snapshot.js';

const snap = loadSnapshot();
const demo = pickDemoMarket(snap.events, Date.parse(snap.capturedAt));
const venue = () => new SimulatedVenue(snap);

describe('SimulatedVenue', () => {
  it('fills a buy at the real best ask and records the position', async () => {
    const v = venue();
    const order = await v.placeOrder({ symbol: demo.task.symbol, side: 'buy', outcome: 'yes', quantity: '5', price: demo.task.bestAsk });
    expect(order).toMatchObject({ status: 'filled', filledQuantity: '5', avgPrice: demo.task.bestAsk });
    expect(await v.positions()).toEqual([{ symbol: demo.task.symbol, outcome: 'yes', quantity: '5', avgPrice: demo.task.bestAsk }]);
    expect(v.fills().every((f) => f.counterparty === 'market')).toBe(true);
  });

  it('walks the book, cancels the rest (IOC), and never fills past the limit', async () => {
    const v = venue();
    const order = await v.placeOrder({ symbol: demo.task.symbol, side: 'buy', outcome: 'yes', quantity: '100000', price: demo.task.bestAsk });
    expect(order.status).toBe('cancelled');
    expect(Number(order.filledQuantity)).toBeGreaterThan(0);
    expect(Number(order.filledQuantity)).toBeLessThan(100000);
    expect(v.fills().every((f) => f.price <= 1_000_000n * BigInt(Math.round(Number(demo.task.bestAsk) * 100)) / 100n)).toBe(true);
  });

  it('lets planted attacker liquidity fill a bad order, and says so', async () => {
    const v = venue();
    v.clearMarketLiquidity(demo.thin.symbol, 'asks');
    v.addAttackerLiquidity(demo.thin.symbol, 'asks', [{ price: '0.9', quantity: '50' }]);
    await v.placeOrder({ symbol: demo.thin.symbol, side: 'buy', outcome: 'yes', quantity: '5', price: '0.9' });
    expect(v.fills()).toMatchObject([{ counterparty: 'attacker', quantity: 5_000_000n, price: 900_000n }]);
  });

  it('prices NO against YES bids, refuses selling more than held, and moves contract state', async () => {
    const v = venue();
    const bid = Number(demo.task.bestBid);
    const no = await v.placeOrder({ symbol: demo.task.symbol, side: 'buy', outcome: 'no', quantity: '2', price: (1 - bid).toFixed(2) });
    expect(Number(no.avgPrice)).toBeCloseTo(1 - bid, 6);
    await expect(v.placeOrder({ symbol: demo.task.symbol, side: 'sell', outcome: 'yes', quantity: '1', price: '0.1' })).rejects.toThrow(/only 0 held/);
    v.setContractState(demo.expiring.symbol, { marketState: 'closed' });
    expect((await v.getEvent(demo.expiring.eventTicker)).contracts.find((c) => c.instrumentSymbol === demo.expiring.symbol)?.marketState).toBe('closed');
  });

  it('shifts expiries so a run long after capture still sees the same time to expiry', async () => {
    const later = Date.parse(snap.capturedAt) + 400 * 24 * 3600 * 1000;
    const v = new SimulatedVenue(snap, { now: () => later });
    const original = snap.events.find((e) => e.ticker === demo.task.eventTicker)!;
    const shifted = await v.getEvent(demo.task.eventTicker);
    expect(Date.parse(shifted.expiresAt!) - later).toBe(Date.parse(original.expiresAt!) - Date.parse(snap.capturedAt));
  });
});
