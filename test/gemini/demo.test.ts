import { describe, expect, it } from 'vitest';
import { GEMINI_PRODUCTION_URL, GEMINI_SANDBOX_URL } from '../../src/gemini/client.js';
import { demoMarketOf, marketDataUrl } from '../../src/gemini/demo.js';
import { loadSnapshot, pickDemoMarket } from '../../src/gemini/snapshot.js';

describe('marketDataUrl', () => {
  it('reads events from the environment the guarded pass trades on', () => {
    // The sandbox lists far fewer events than production: a production pick 404s there.
    expect(marketDataUrl({ GEMINI_ENV: 'sandbox' })).toBe(GEMINI_SANDBOX_URL);
    expect(marketDataUrl({ GEMINI_ENV: 'production' })).toBe(GEMINI_PRODUCTION_URL);
    expect(marketDataUrl({})).toBe(GEMINI_PRODUCTION_URL);
  });

  it('an explicit GEMINI_MARKET_DATA_URL wins', () => {
    expect(marketDataUrl({ GEMINI_ENV: 'sandbox', GEMINI_MARKET_DATA_URL: 'http://x' })).toBe('http://x');
  });
});

describe('demo market horizon', () => {
  const snap = loadSnapshot();
  const task = pickDemoMarket(snap.events, Date.parse(snap.capturedAt)).task;
  const expiry = Date.parse(snap.events.find((e) => e.ticker === task.eventTicker)!.expiresAt!);

  it('an event 30 minutes from expiry fails the default two hours but suits a 20-minute horizon (sandbox hourlies)', () => {
    const now = expiry - 30 * 60 * 1000;
    expect(() => pickDemoMarket(snap.events.filter((e) => e.ticker === task.eventTicker || Date.parse(e.expiresAt ?? '') <= now + 2 * 3600_000), now)).toThrow(/open for 120\+ min/);
    expect(pickDemoMarket(snap.events, now, undefined, 20 * 60 * 1000).task.eventTicker).toBeDefined();
  });

  it('a later pick from a captured snapshot reuses its task event', () => {
    const other = snap.events.find((e) => e.ticker !== task.eventTicker && e.contracts.length >= 4);
    const recorded = { ...snap, taskEvent: task.eventTicker };
    expect(demoMarketOf(recorded).task.eventTicker).toBe(task.eventTicker);
    if (other) expect(demoMarketOf({ ...snap, taskEvent: other.ticker }).task.eventTicker).toBe(other.ticker);
  });
});
