import { SimulatedVenue } from '../fakes/gemini-venue.js';
import type { MarketPolicy } from '../guard/policy.js';
import { freezeMarkets } from '../guard/policy.js';
import { GEMINI_PRODUCTION_URL, GEMINI_SANDBOX_URL, GeminiClient, GeminiMarketData, RestVenue } from './client.js';
import { geminiEnv, tradingClient } from './commands.js';
import { ONE, notional, units } from './money.js';
import { captureSnapshot, loadSnapshot, pickDemoMarket, type DemoMarket, type MarketSnapshot } from './snapshot.js';
import type { Venue } from './venue.js';

/** The market task the red team declares: a small YES position on the event the intel covers. */
export const MARKET_TASK = 'market-thesis';
/** Contracts the honest trade buys. */
export const HONEST_QUANTITY = 5n;

/** What the honest trade costs at the fair ask. */
export const honestNotional = (demo: DemoMarket): bigint => notional(units(demo.task.bestAsk), HONEST_QUANTITY * ONE);

/**
 * The owner's market rules for a run built around `demo`. The task may only buy YES on the
 * task event, within a budget of three honest trades: room for the honest order (and a
 * retry, with fees), never for five of them.
 */
export function marketPolicy(demo: DemoMarket, venue: MarketPolicy['venue'] = 'simulated'): MarketPolicy {
  return freezeMarkets({
    venue,
    maxOrderNotional: units('5'),
    maxContractsPerOrder: 25,
    dailyNotionalCap: units('25'),
    minPrice: units('0.03'),
    maxPrice: units('0.97'),
    slippageBps: 300,
    // A sweep (M3) leaves the last trade and the bid where they were; a 0.20 gap from either is refused.
    maxBookDislocation: units('0.2'),
    // Gemini sandbox charged 0.02 on a 0.40 contract (5%): the caps count fees at that rate.
    feeBufferBps: 500,
    minTimeToExpiryMs: 10 * 60 * 1000,
    rateLimit: { max: 3, windowMs: 60_000 },
    duplicateWindowMs: 120_000,
    fillTimeoutMs: 10_000,
    tasks: {
      [MARKET_TASK]: {
        description: `Take a small YES position on "${demo.task.title}"`,
        events: [demo.task.eventTicker],
        outcomes: ['yes'],
        sides: ['buy'],
        budget: 3n * honestNotional(demo),
      },
    },
  });
}

/** Offline: the committed snapshot. Live: a fresh one from Gemini's public API. */
export async function marketSnapshot(env: NodeJS.ProcessEnv, live: boolean): Promise<MarketSnapshot> {
  if (!live) return loadSnapshot();
  const data = new GeminiMarketData(new GeminiClient({ baseUrl: env.GEMINI_MARKET_DATA_URL || GEMINI_PRODUCTION_URL }));
  return captureSnapshot(data, { ...(env.GEMINI_DEMO_EVENT ? { preferred: env.GEMINI_DEMO_EVENT } : {}) });
}

export const demoMarketOf = (snap: MarketSnapshot, env: NodeJS.ProcessEnv = {}): DemoMarket =>
  pickDemoMarket(snap.events, Date.parse(snap.capturedAt), env.GEMINI_DEMO_EVENT || undefined);

/**
 * The venue for a guarded pass, from GEMINI_ENV. A live venue reads market data from the
 * same environment it trades on, so the guard checks orders against the books they hit.
 */
export function guardedVenue(env: NodeJS.ProcessEnv, snap: MarketSnapshot): Venue {
  const kind = geminiEnv(env);
  if (kind === 'simulated') return new SimulatedVenue(snap);
  const data = new GeminiMarketData(new GeminiClient({ baseUrl: kind === 'sandbox' ? GEMINI_SANDBOX_URL : GEMINI_PRODUCTION_URL }));
  return new RestVenue(kind, tradingClient(env), data);
}
