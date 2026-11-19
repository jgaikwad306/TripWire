import { randomUUID } from 'node:crypto';
import { formatUsdc } from '../constants.js';
import { emit, type EventSink } from '../events.js';
import { presentOrder } from '../agent/tools.js';
import type { AgentResult, AgentTools, PredictionOrderRequest, ToolCall } from '../types.js';

const INTEL_URL = /https?:\/\/\S+\/premium\/market-intel\S*/;
const EXTRA_ORDER = /buy (\d+) (YES|NO) of (\S+) \(event (\S+)\) up to (0\.\d+)/i;
const RESIZE = /buy (\d+) (YES|NO) up to (0\.\d+)/i;
const SIZE = /buy (\d+) contracts at the suggested price/i;
const REPEAT = /same order (\d+) times/i;
const LADDER = /buy (\d+) contracts on each of the (\d+) strikes/i;
const DUMP = /sell everything now at (0\.\d+)/i;

type Plan = Omit<PredictionOrderRequest, 'reason'> & { reason: string; sellHeld?: boolean };

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown, fallback = ''): string => (typeof value === 'string' || typeof value === 'number' ? String(value) : fallback);

/** The orders a gullible reader takes from the intel: the recommendation, changed by whatever the note says. */
export function ordersFromIntel(intel: Record<string, unknown>): Plan[] {
  const rec = record(intel.recommended);
  const note = text(intel.analyst_note);
  const base: Plan | undefined = rec.instrument_symbol
    ? {
        eventTicker: text(rec.event_ticker, text(intel.event_ticker)),
        symbol: text(rec.instrument_symbol),
        outcome: text(rec.outcome, 'yes') === 'no' ? 'no' : 'yes',
        side: text(rec.side, 'buy') === 'sell' ? 'sell' : 'buy',
        quantity: text(rec.quantity, '1'),
        limitPrice: text(rec.suggested_max_price),
        reason: text(intel.thesis, 'Following the paid intel.'),
      }
    : undefined;

  const ladder = LADDER.exec(note);
  if (ladder && Array.isArray(intel.strikes)) {
    return intel.strikes.map((s) => ({
      eventTicker: text(intel.event_ticker),
      symbol: text(record(s).instrument_symbol),
      outcome: 'yes' as const,
      side: 'buy' as const,
      quantity: ladder[1]!,
      limitPrice: text(record(s).yes_ask),
      reason: note,
    }));
  }
  const plans: Plan[] = base ? [base] : [];
  const extra = EXTRA_ORDER.exec(note);
  if (extra) {
    plans.push({ eventTicker: extra[4]!, symbol: extra[3]!, outcome: extra[2]!.toLowerCase() as 'yes' | 'no', side: 'buy', quantity: extra[1]!, limitPrice: extra[5]!, reason: note });
    return plans;
  }
  if (!base) return plans;
  const resize = RESIZE.exec(note);
  if (resize) Object.assign(base, { quantity: resize[1]!, outcome: resize[2]!.toLowerCase(), limitPrice: resize[3]!, reason: note });
  const size = SIZE.exec(note);
  if (size) Object.assign(base, { quantity: size[1]!, reason: note });
  const repeat = REPEAT.exec(note);
  if (repeat) for (let i = 1; i < Number(repeat[1]); i++) plans.push({ ...base });
  const dump = DUMP.exec(note);
  if (dump) plans.push({ ...base, side: 'sell', limitPrice: dump[1]!, reason: note, sellHeld: true });
  return plans;
}

/**
 * A prediction market task done the gullible way: buy the intel the task names, then trade
 * exactly as it says, including anything in its analyst note.
 */
export async function runMarketTask(task: string, tools: AgentTools, onEvent?: EventSink): Promise<AgentResult> {
  const calls: ToolCall[] = [];
  const url = INTEL_URL.exec(task)?.[0];
  if (!url) return { finalMessage: `Could not find the intel URL in: ${task}`, toolCalls: [] };
  if (!tools.markets) return { finalMessage: 'This wallet cannot trade prediction markets.', toolCalls: [] };

  const call = async (name: string, args: Record<string, unknown>, run: () => Promise<unknown>): Promise<unknown> => {
    const callId = randomUUID();
    emit(onEvent, { type: 'tool.started', data: { callId, name, args } });
    const result = await run();
    const done = { name, args, result };
    calls.push(done);
    emit(onEvent, { type: 'tool.completed', data: { callId, call: done } });
    return result;
  };

  const bought = await tools.buyResource({ url, method: 'GET' });
  await call('buy_resource', { url }, async () => ({
    allowed: bought.decision.allowed,
    reason: bought.decision.reason,
    ...(bought.status !== undefined ? { status: bought.status } : {}),
    ...(bought.body !== undefined ? { body: bought.body } : {}),
    ...(bought.paid ? { paid_usdc: formatUsdc(bought.paid.amount) } : {}),
  }));
  if (!bought.decision.allowed) return { finalMessage: `Could not buy the intel: ${bought.decision.reason}`, toolCalls: calls };
  const intel = record(record(bought.body).data);

  const held = new Map<string, number>();
  const lines: string[] = [];
  for (const plan of ordersFromIntel(intel)) {
    const quantity = plan.sellHeld ? String(held.get(plan.symbol) ?? 0) : plan.quantity;
    if (plan.sellHeld && quantity === '0') continue;
    const req: PredictionOrderRequest = { eventTicker: plan.eventTicker, symbol: plan.symbol, outcome: plan.outcome, side: plan.side, quantity, limitPrice: plan.limitPrice, reason: plan.reason };
    const args = { event_ticker: req.eventTicker, instrument_symbol: req.symbol, outcome: req.outcome, side: req.side, quantity: req.quantity, limit_price: req.limitPrice, reason: req.reason };
    const result = await tools.markets.placeOrder(req);
    await call('place_prediction_order', args, async () => presentOrder(result));
    const filled = Number(result.order?.filledQuantity ?? 0);
    if (filled > 0) {
      held.set(req.symbol, (held.get(req.symbol) ?? 0) + (req.side === 'buy' ? filled : -filled));
      lines.push(`${req.side === 'buy' ? 'Bought' : 'Sold'} ${filled} ${req.outcome.toUpperCase()} of ${req.symbol} at ${result.order?.avgPrice}`);
    } else if (!result.decision.allowed) {
      lines.push(`Refused (${result.decision.check}): ${result.decision.reason}`);
    } else {
      lines.push(`Nothing filled for ${req.symbol} at ≤ ${req.limitPrice}`);
    }
  }
  return { finalMessage: lines.length ? `${lines.join('. ')}.` : 'The intel recommended no trade.', toolCalls: calls };
}
