import { parseArgs } from 'node:util';
import { GEMINI_PRODUCTION_URL, GEMINI_SANDBOX_URL, GeminiClient, GeminiMarketData } from './client.js';
import { captureSnapshot, pickDemoMarket, saveSnapshot, SNAPSHOT_FILE } from './snapshot.js';
import type { GeminiCredentials } from './signing.js';

interface Io {
  env: NodeJS.ProcessEnv;
  log(message: string): void;
}

const USAGE = `Usage: npm run cli gemini <command>

  markets [--search fed] [--category Crypto]   real active events with YES bid / ask
  snapshot [--event TICKER]                    refresh ${SNAPSHOT_FILE} from live data
  status                                       venue, terms, USD balance, positions, open orders
  terms --accept                               accept Gemini's prediction market terms (owner action)
  smoke                                        one guarded 1-contract order at the best ask
  cancel-all                                   cancel every open prediction market order

These commands read market data from ${GEMINI_PRODUCTION_URL} (GEMINI_MARKET_DATA_URL); no key needed.
Live red-team runs and the dashboard read events from the environment they trade on (GEMINI_ENV).
Trading uses GEMINI_ENV (simulated | sandbox | production) with GEMINI_API_KEY / GEMINI_API_SECRET.`;

export const marketDataClient = (env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch) =>
  new GeminiClient({ baseUrl: env.GEMINI_MARKET_DATA_URL || GEMINI_PRODUCTION_URL, ...(fetchImpl ? { fetchImpl } : {}) });

export type GeminiEnv = 'simulated' | 'sandbox' | 'production';

export function geminiEnv(env: NodeJS.ProcessEnv): GeminiEnv {
  const value = (env.GEMINI_ENV || 'simulated').toLowerCase();
  if (value === 'simulated' || value === 'sandbox' || value === 'production') return value;
  throw new Error(`GEMINI_ENV must be simulated, sandbox or production, not "${env.GEMINI_ENV}".`);
}

/** The trading client for a live venue. Production needs an explicit opt-in. */
export function tradingClient(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): GeminiClient {
  const kind = geminiEnv(env);
  if (kind === 'simulated') throw new Error('GEMINI_ENV is simulated: there is no live venue to trade on.');
  if (kind === 'production' && env.GEMINI_ALLOW_PRODUCTION !== '1') {
    throw new Error('Real Gemini orders need GEMINI_ALLOW_PRODUCTION=1 (guarded runs only, tiny caps).');
  }
  if (!env.GEMINI_API_KEY || !env.GEMINI_API_SECRET) throw new Error('Set GEMINI_API_KEY and GEMINI_API_SECRET (Trader role, no withdraw).');
  const credentials: GeminiCredentials = { apiKey: env.GEMINI_API_KEY, apiSecret: env.GEMINI_API_SECRET, ...(env.GEMINI_ACCOUNT ? { account: env.GEMINI_ACCOUNT } : {}) };
  return new GeminiClient({
    baseUrl: kind === 'sandbox' ? GEMINI_SANDBOX_URL : GEMINI_PRODUCTION_URL,
    credentials,
    nonceMode: env.GEMINI_NONCE_MODE === 'increment' ? 'increment' : 'time',
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

/** `npm run cli gemini …` */
export async function geminiCommand(args: string[], io: Io = { env: process.env, log: (m) => console.log(m) }): Promise<void> {
  const [sub, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: { search: { type: 'string' }, category: { type: 'string' }, event: { type: 'string' }, accept: { type: 'boolean', default: false } },
  });
  const data = new GeminiMarketData(marketDataClient(io.env));

  switch (sub) {
    case 'markets': {
      const events = await data.listEvents({ ...(values.search ? { search: values.search } : {}), ...(values.category ? { category: values.category } : {}), limit: 15 });
      if (!events.length) io.log('No active events match.');
      for (const e of events) {
        io.log(`\n${e.ticker}  ${e.title}  [${e.category ?? '?'}]  expires ${e.expiresAt ?? '?'}`);
        for (const c of e.contracts.slice(0, 6)) io.log(`  ${c.label.padEnd(28)} YES bid ${c.bestBid ?? '—'} / ask ${c.bestAsk ?? '—'}  ${c.marketState}  ${c.instrumentSymbol}`);
        if (e.contracts.length > 6) io.log(`  … ${e.contracts.length - 6} more`);
      }
      return;
    }
    case 'snapshot': {
      const snap = await captureSnapshot(data, { ...(values.event ?? io.env.GEMINI_DEMO_EVENT ? { preferred: values.event ?? io.env.GEMINI_DEMO_EVENT } : {}) });
      const demo = pickDemoMarket(snap.events, Date.parse(snap.capturedAt), values.event ?? (io.env.GEMINI_DEMO_EVENT || undefined));
      io.log(`Saved ${saveSnapshot(snap)}: ${snap.events.length} events, ${Object.keys(snap.books).length} order books.`);
      io.log(`Task market: ${demo.task.title} · ${demo.task.label} (${demo.task.symbol}) YES ask ${demo.task.bestAsk}`);
      return;
    }
    case 'status': {
      const kind = geminiEnv(io.env);
      io.log(`Venue: ${kind}`);
      if (kind === 'simulated') {
        io.log('Simulated: orders fill against a snapshot of real Gemini books. Nothing is sent to Gemini.');
        return;
      }
      const client = tradingClient(io.env);
      io.log(`Terms accepted: ${await client.termsStatus()}`);
      const usd = (await client.balances()).find((b) => b.currency === 'USD');
      io.log(`USD available: ${usd?.available ?? '0'}`);
      const positions = await client.positions();
      io.log(`Positions: ${positions.length ? positions.map((p) => `${p.symbol} ${p.outcome} ${p.totalQuantity}`).join(', ') : 'none'}`);
      const active = await client.activeOrders();
      io.log(`Open orders: ${active.length ? active.map((o) => `${o.orderId} ${o.symbol}`).join(', ') : 'none'}`);
      return;
    }
    case 'terms': {
      io.log("Read Gemini's prediction market terms in your Gemini account first; each contract also links its own rules (termsAndConditionsUrl).");
      if (!values.accept) {
        io.log('Re-run with --accept to accept them for this account. The guard never does this for you.');
        return;
      }
      await tradingClient(io.env).acceptTerms();
      io.log('Accepted.');
      return;
    }
    case 'cancel-all': {
      const client = tradingClient(io.env);
      const active = await client.activeOrders();
      for (const o of active) await client.cancelOrder(o.orderId);
      io.log(`Cancelled ${active.length} open order(s).`);
      return;
    }
    case 'smoke': {
      const { smokeOrder } = await import('./smoke.js');
      await smokeOrder(io);
      return;
    }
    default:
      io.log(USAGE);
  }
}
