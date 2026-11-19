import type { EventSink } from '../events.js';
import { SimulatedVenue } from '../fakes/gemini-venue.js';
import { MARKET_TASK, demoMarketOf, marketPolicy } from '../gemini/demo.js';
import { units } from '../gemini/money.js';
import type { DemoMarket, MarketSnapshot } from '../gemini/snapshot.js';
import type { Venue } from '../gemini/venue.js';
import type { AuditLog } from '../guard/audit.js';
import { AllowAllTrader, GuardedTrader } from '../guard/market-guard.js';
import type { MarketPolicy } from '../guard/policy.js';
import type { MarketGuard } from '../types.js';
import { buildIntel, type IntelMode } from './market-intel.js';
import { fairBookOf, type FairBook, type Fill, type Mandate } from './market-loss.js';

/** What a world needs to set up prediction markets: real data, and the live venue if any. */
export interface MarketSetup {
  snapshot: MarketSnapshot;
  env?: NodeJS.ProcessEnv;
  /** Guarded passes on sandbox or production trade here. Absent: the simulated venue. */
  liveVenue?: () => Venue;
}

/** The prediction market side of one scenario's world. */
export interface MarketWorld {
  demo: DemoMarket;
  snapshot: MarketSnapshot;
  /** Where the agent's orders go: simulated, or (guarded only) a live Gemini venue. */
  venue: Venue;
  /** Fresh per scenario. Attacks plant liquidity and change contract states here. */
  sim: SimulatedVenue;
  guard: MarketGuard;
  policy: MarketPolicy;
  setIntelMode(mode: IntelMode): void;
  intel(query: URLSearchParams): Promise<Record<string, unknown>>;
  /** Every fill the guard (or the baseline) reported, in order. */
  fills(): Fill[];
  mandate: Mandate;
  /** Real bids and asks before any tampering: what losses are measured against. */
  fair: FairBook;
}

/** Records fills from each order result, so loss is measured the same way on any venue. */
function recordFills(inner: MarketGuard, fills: Fill[]): MarketGuard {
  return {
    beginMarketTask: (name) => inner.beginMarketTask(name),
    cancelOrder: (id) => inner.cancelOrder(id),
    positions: () => inner.positions(),
    decisions: () => inner.decisions(),
    placeOrder: async (req) => {
      const result = await inner.placeOrder(req);
      const filled = result.order?.filledQuantity;
      if (filled && result.order?.avgPrice && units(filled) > 0n) {
        fills.push({ symbol: String(req.symbol), outcome: req.outcome, side: req.side, quantity: units(filled), price: units(result.order.avgPrice) });
      }
      return result;
    },
  };
}

export function buildMarketWorld(setup: MarketSetup, opts: { guarded: boolean; audit?: AuditLog; onEvent?: EventSink }): MarketWorld {
  const demo = demoMarketOf(setup.snapshot, setup.env);
  const sim = new SimulatedVenue(setup.snapshot);
  // Unguarded orders only ever reach the simulated venue; AllowAllTrader enforces it too.
  const venue = opts.guarded && setup.liveVenue ? setup.liveVenue() : sim;
  const policy = marketPolicy(demo, venue.kind);
  const fills: Fill[] = [];
  const inner: MarketGuard = opts.guarded
    ? new GuardedTrader({ venue, policy, ...(opts.audit ? { audit: opts.audit } : {}), ...(opts.onEvent ? { onEvent: opts.onEvent } : {}) })
    : new AllowAllTrader(sim, { ...(opts.audit ? { audit: opts.audit } : {}), ...(opts.onEvent ? { onEvent: opts.onEvent } : {}) });
  const guard = recordFills(inner, fills);
  let mode: IntelMode = 'honest';
  const budget = policy.tasks[MARKET_TASK]!.budget;
  const taskEvent = setup.snapshot.events.find((e) => e.ticker === demo.task.eventTicker);
  return {
    demo,
    snapshot: setup.snapshot,
    venue,
    sim,
    guard,
    policy,
    setIntelMode: (next) => {
      mode = next;
    },
    intel: () => buildIntel(mode, demo, venue, budget),
    fills: () => [...fills],
    mandate: {
      symbols: new Set(taskEvent?.contracts.map((c) => c.instrumentSymbol) ?? [demo.task.symbol]),
      outcomes: policy.tasks[MARKET_TASK]!.outcomes,
      sides: policy.tasks[MARKET_TASK]!.sides,
      budget,
    },
    fair: fairBookOf(setup.snapshot.events),
  };
}
