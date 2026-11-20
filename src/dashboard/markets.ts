import { formatUsdc } from '../constants.js';
import { GeminiClient, GeminiMarketData } from '../gemini/client.js';
import { MARKET_TASK, marketDataUrl, marketPolicy } from '../gemini/demo.js';
import { loadSnapshot, pickDemoMarket, type DemoMarket, type MarketSnapshot } from '../gemini/snapshot.js';
import type { MarketData } from '../gemini/venue.js';
import { CHECK } from '../guard/checks.js';
import { MARKET_CHECKS } from '../guard/market.js';

/** How often the odds board re-reads Gemini, and how many points of history it keeps. */
const REFRESH_MS = 15_000;
const HISTORY_POINTS = 240;

/** What each market check refuses, for the "How the market guard works" list, in check order. */
const RULE_TEXT: Record<string, string> = {
  [CHECK.market]: 'The event must exist on Gemini, the symbol must be one of its contracts, and the event must be in the declared task.',
  [CHECK.marketState]: 'The contract must be active and open, and not about to expire.',
  [CHECK.side]: 'Only the sides the task allows (buy).',
  [CHECK.outcome]: 'Only the outcomes the task allows (YES).',
  [CHECK.price]: 'The limit must be a price between the policy’s floor and ceiling.',
  [CHECK.slippage]: 'The limit must be close to the guard’s own read of Gemini’s book, never the agent’s quote.',
  [CHECK.limits]: 'Whole contracts, under the per-order contract and dollar caps, and the daily cap.',
  [CHECK.budget]: 'The task cannot commit past its budget.',
  [CHECK.rateLimit]: 'Orders on one contract are rate-limited.',
  [CHECK.duplicate]: 'The same order is placed once, and never while one is still open.',
};

export interface MarketBoard {
  source: 'live' | 'snapshot';
  updatedAt: string;
  task: DemoMarket['task'];
  event: { ticker: string; title: string; expiresAt?: string; contracts: { label: string; symbol: string; bid?: string; ask?: string; last?: string; state: string; task: boolean }[] };
  /** Best ask and last trade of the task contract over time, oldest first. */
  history: { at: string; ask?: string; last?: string }[];
  mandate: { label: string; value: string }[];
  rules: { check: string; line: string }[];
  /** The scenarios the tab's Run button starts. */
  suite: string[];
  focused: string[];
}

/**
 * The live odds board for the Prediction markets tab. It reads Gemini's public market data
 * (no key) on first request and then every 15s while the dashboard runs, and keeps the task
 * contract's odds over time. The browser never calls Gemini. Offline or unreachable: the
 * committed snapshot.
 */
export class MarketBoardSource {
  private readonly data?: MarketData;
  private snapshot?: MarketSnapshot;
  private demo?: DemoMarket;
  private latest?: MarketBoard;
  private fetchedAt = 0;
  private readonly history: MarketBoard['history'] = [];
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly opts: { env: NodeJS.ProcessEnv; live: boolean; data?: MarketData; suite: string[]; focused: string[]; now?: () => number }) {
    if (opts.live) this.data = opts.data ?? new GeminiMarketData(new GeminiClient({ baseUrl: marketDataUrl(opts.env) }));
  }

  async board(): Promise<MarketBoard> {
    const now = (this.opts.now ?? Date.now)();
    if (this.latest && now - this.fetchedAt < REFRESH_MS) return this.latest;
    if (this.data && !this.timer) {
      this.timer = setInterval(() => void this.refresh().catch(() => undefined), REFRESH_MS);
      this.timer.unref?.();
    }
    return this.refresh();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async refresh(): Promise<MarketBoard> {
    const now = (this.opts.now ?? Date.now)();
    this.snapshot ??= loadSnapshot();
    this.demo ??= pickDemoMarket(this.snapshot.events, Date.parse(this.snapshot.capturedAt), this.opts.env.GEMINI_DEMO_EVENT || this.snapshot.taskEvent || undefined);
    let source: MarketBoard['source'] = 'snapshot';
    let event = this.snapshot.events.find((e) => e.ticker === this.demo!.task.eventTicker)!;
    if (this.data) {
      try {
        event = await this.data.getEvent(this.demo.task.eventTicker);
        source = 'live';
      } catch {
        // Gemini unreachable or the event has closed: show the snapshot, and say so.
      }
    }
    const task = event.contracts.find((c) => c.instrumentSymbol === this.demo!.task.symbol);
    this.history.push({ at: new Date(now).toISOString(), ...(task?.bestAsk ? { ask: task.bestAsk } : {}), ...(task?.lastTradePrice ? { last: task.lastTradePrice } : {}) });
    if (this.history.length > HISTORY_POINTS) this.history.shift();
    const policy = marketPolicy(this.demo, 'simulated');
    const t = policy.tasks[MARKET_TASK]!;
    this.latest = {
      source,
      updatedAt: new Date(now).toISOString(),
      task: this.demo.task,
      event: {
        ticker: event.ticker,
        title: event.title,
        ...(event.expiresAt ? { expiresAt: event.expiresAt } : {}),
        contracts: event.contracts.slice(0, 12).map((c) => ({
          label: c.label,
          symbol: c.instrumentSymbol,
          ...(c.bestBid ? { bid: c.bestBid } : {}),
          ...(c.bestAsk ? { ask: c.bestAsk } : {}),
          ...(c.lastTradePrice ? { last: c.lastTradePrice } : {}),
          state: c.marketState,
          task: c.instrumentSymbol === this.demo!.task.symbol,
        })),
      },
      history: [...this.history],
      mandate: [
        { label: 'Event', value: `${this.demo.task.title} (${this.demo.task.eventTicker})` },
        { label: 'Outcome and side', value: `${t.outcomes.join(', ').toUpperCase()} · ${t.sides.join(', ')} only` },
        { label: 'Task budget', value: `${formatUsdc(t.budget)} USD` },
        { label: 'Per order', value: `${policy.maxContractsPerOrder} contracts · ${formatUsdc(policy.maxOrderNotional)} USD` },
        { label: 'Per day', value: `${formatUsdc(policy.dailyNotionalCap)} USD` },
        { label: 'Price band', value: `${formatUsdc(policy.minPrice)}–${formatUsdc(policy.maxPrice)}, within ${policy.slippageBps / 100}% of Gemini’s book` },
        { label: 'Expiry', value: `No contract closing within ${Math.round(policy.minTimeToExpiryMs / 60_000)} min` },
      ],
      // The check order, with each name once (market appears twice: resolve and mandate).
      rules: [...new Set(MARKET_CHECKS.map((c) => c.name))].map((check) => ({ check, line: RULE_TEXT[check] ?? '' })),
      suite: this.opts.suite,
      focused: this.opts.focused,
    };
    this.fetchedAt = now;
    return this.latest;
  }
}
