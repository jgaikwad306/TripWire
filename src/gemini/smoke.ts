import { JsonlAuditLog } from '../guard/audit.js';
import { GuardedTrader, JsonFileMarketStore } from '../guard/market-guard.js';
import { MARKET_TASK, demoMarketOf, guardedVenue, marketPolicy, marketSnapshot } from './demo.js';
import { geminiEnv } from './commands.js';

/**
 * `npm run cli gemini smoke`: one guarded order for 1 YES contract at the best ask on the
 * configured venue, through every market check. Prints the order id as evidence.
 */
export async function smokeOrder(io: { env: NodeJS.ProcessEnv; log(message: string): void }): Promise<void> {
  const kind = geminiEnv(io.env);
  const snap = await marketSnapshot(io.env, true);
  const demo = demoMarketOf(snap, io.env);
  const venue = guardedVenue(io.env, snap);
  // A live venue may list other events: trade what it shows for the task contract.
  const event = await venue.getEvent(demo.task.eventTicker);
  const contract = event.contracts.find((c) => c.instrumentSymbol === demo.task.symbol);
  if (!contract?.bestAsk) throw new Error(`${demo.task.symbol} has no ask on the ${kind} venue right now.`);
  const guard = new GuardedTrader({
    venue,
    policy: marketPolicy(demo, kind),
    store: new JsonFileMarketStore(),
    audit: new JsonlAuditLog('results/markets/audit.jsonl'),
  });
  guard.beginMarketTask(MARKET_TASK);
  io.log(`Venue: ${kind}. Buying 1 YES of ${demo.task.title} · ${demo.task.label} (${demo.task.symbol}) at ≤ ${contract.bestAsk}.`);
  const result = await guard.placeOrder({
    eventTicker: demo.task.eventTicker,
    symbol: demo.task.symbol,
    outcome: 'yes',
    side: 'buy',
    quantity: '1',
    limitPrice: contract.bestAsk,
    reason: 'TripWire smoke test: one guarded contract',
  });
  io.log(`${result.decision.allowed ? 'ALLOWED' : 'DENIED'} [${result.decision.check}] ${result.decision.reason}`);
  if (result.order) io.log(`Order id: ${result.order.orderId} (${result.order.status}, filled ${result.order.filledQuantity}${result.order.avgPrice ? ` at ${result.order.avgPrice}` : ''})`);
}
