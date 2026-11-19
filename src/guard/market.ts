import { formatUsdc } from '../constants.js';
import { ONE, costOf, flip, minusBps, plusBps, units } from '../gemini/money.js';
import type { GeminiBook, GeminiContract, GeminiEvent } from '../gemini/schemas.js';
import type { Decision, PredictionOrderRequest } from '../types.js';
import { CHECK, allow, deny } from './checks.js';
import type { MarketPolicy } from './policy.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** One market order the guard placed (or may have placed), for caps, budgets, rates and duplicates. */
export interface MarketOrderRecord {
  symbol: string;
  side: 'buy' | 'sell';
  outcome: 'yes' | 'no';
  /** What it could cost, fee buffer included. Sells cost nothing against the caps. */
  cost: bigint;
  at: number;
  /** The task session it was placed under. */
  session?: string;
  /** Recorded before the order is sent; settled once the venue answers. */
  status: 'pending' | 'placed' | 'failed';
}

/** Everything the checks look at. Gathered by the guard, never taken from the agent. */
export interface MarketFacts {
  request: PredictionOrderRequest;
  /** The event as the guard just read it from Gemini, or why it could not. */
  event?: GeminiEvent;
  eventError?: string;
  /** The guard's own read of the contract's YES book. */
  book?: GeminiBook;
  task?: { name: string; session: string };
  orders: readonly MarketOrderRecord[];
  /** Contracts with an order still open on the venue. */
  openSymbols: readonly string[];
}

type MarketCheck = (facts: MarketFacts, policy: MarketPolicy, now: number, contract: GeminiContract | undefined) => Decision | null;

const DECIMAL = /^\d+(\.\d{1,6})?$/;
const INTEGER = /^[1-9]\d{0,6}$/;

/** The guard's own price for this outcome and side, from its own read of the book. */
export function referencePrice(facts: MarketFacts, contract: GeminiContract | undefined): bigint | undefined {
  const ask = facts.book?.asks[0]?.price ?? contract?.bestAsk;
  const bid = facts.book?.bids[0]?.price ?? contract?.bestBid;
  const { side, outcome } = facts.request;
  // A YES buy lifts the YES ask; a NO buy is filled by YES bids, so its price is 1 − bid.
  if (side === 'buy') return outcome === 'yes' ? (ask ? units(ask) : undefined) : bid ? flip(units(bid)) : undefined;
  return outcome === 'yes' ? (bid ? units(bid) : undefined) : ask ? flip(units(ask)) : undefined;
}

/** What the order counts against the caps: its cost plus the fee buffer. Sells spend nothing. */
export function orderCost(req: PredictionOrderRequest, policy: MarketPolicy): bigint {
  if (req.side === 'sell') return 0n;
  return plusBps(costOf({ quantity: req.quantity, price: req.limitPrice }), policy.feeBufferBps);
}

const usd = (v: bigint) => `${formatUsdc(v)} USD`;

const checkResolve: MarketCheck = (facts, _p, _now, contract) => {
  if (!facts.event) return deny(CHECK.market, `Gemini could not confirm event "${facts.request.eventTicker}": ${facts.eventError ?? 'not found'}.`);
  return contract ? null : deny(CHECK.market, `${facts.request.symbol} is not a contract of event ${facts.event.ticker} ("${facts.event.title}").`);
};

const checkState: MarketCheck = (facts, policy, now, contract) => {
  const event = facts.event;
  const c = contract;
  // Only reached without an event or contract when the resolve check is switched off (mutation test).
  if (!event || !c) return null;
  if (event.status !== 'active' || c.status !== 'active') return deny(CHECK.marketState, `${c.instrumentSymbol} is not active on Gemini (event ${event.status}, contract ${c.status}).`);
  if (c.marketState !== 'open') return deny(CHECK.marketState, `${c.instrumentSymbol} is ${c.marketState}, not open for trading.`);
  const expiry = Date.parse(c.expiresAt ?? event.expiresAt ?? '');
  if (Number.isFinite(expiry) && expiry - now < policy.minTimeToExpiryMs) {
    const left = Math.max(0, Math.round((expiry - now) / 1000));
    return deny(CHECK.marketState, `${c.instrumentSymbol} expires in ${left}s; the policy needs at least ${Math.round(policy.minTimeToExpiryMs / 1000)}s.`);
  }
  return null;
};

const checkMandate: MarketCheck = (facts, policy) => {
  if (!facts.task) return deny(CHECK.market, 'No market task has been declared, so no order is allowed.');
  const task = policy.tasks[facts.task.name];
  if (!task) return deny(CHECK.market, `The declared task "${facts.task.name}" is not in the policy.`);
  const ticker = facts.event?.ticker ?? facts.request.eventTicker;
  return task.events.includes(ticker)
    ? null
    : deny(CHECK.market, `Event ${ticker}${facts.event ? ` ("${facts.event.title}")` : ''} is not part of task "${facts.task.name}" (${task.description}).`);
};

const taskOf = (facts: MarketFacts, policy: MarketPolicy) => policy.tasks[facts.task!.name]!;

const checkSide: MarketCheck = (facts, policy) =>
  taskOf(facts, policy).sides.includes(facts.request.side) ? null : deny(CHECK.side, `Task "${facts.task!.name}" may not ${facts.request.side}; it allows ${taskOf(facts, policy).sides.join(', ')}.`);

const checkOutcome: MarketCheck = (facts, policy) =>
  taskOf(facts, policy).outcomes.includes(facts.request.outcome)
    ? null
    : deny(CHECK.outcome, `Task "${facts.task!.name}" trades ${taskOf(facts, policy).outcomes.join('/').toUpperCase()}, not ${facts.request.outcome.toUpperCase()}.`);

const checkPrice: MarketCheck = ({ request }, policy) => {
  if (!DECIMAL.test(request.limitPrice)) return deny(CHECK.price, `Limit price "${request.limitPrice}" is not a decimal.`);
  const price = units(request.limitPrice);
  if (price <= 0n || price >= ONE) return deny(CHECK.price, `Limit price ${request.limitPrice} is not between 0 and 1.`);
  if (price < policy.minPrice || price > policy.maxPrice) {
    return deny(CHECK.price, `Limit price ${request.limitPrice} is outside the allowed ${formatUsdc(policy.minPrice)}–${formatUsdc(policy.maxPrice)}.`);
  }
  return null;
};

const checkSlippage: MarketCheck = (facts, policy, _now, contract) => {
  const reference = referencePrice(facts, contract);
  const { side, outcome, limitPrice } = facts.request;
  const label = `${side} ${outcome.toUpperCase()}`;
  if (reference === undefined) return deny(CHECK.slippage, `Gemini shows no ${side === 'buy' ? 'offer' : 'bid'} to ${label} against, so the price cannot be checked.`);
  const price = units(limitPrice);
  if (side === 'buy') {
    const max = plusBps(reference, policy.slippageBps);
    return price <= max ? null : deny(CHECK.slippage, `Limit ${limitPrice} is above Gemini's ${formatUsdc(reference)} for ${label} by more than ${policy.slippageBps / 100}% (max ${formatUsdc(max)}).`);
  }
  const min = minusBps(reference, policy.slippageBps);
  return price >= min ? null : deny(CHECK.slippage, `Limit ${limitPrice} is below Gemini's ${formatUsdc(reference)} for ${label} by more than ${policy.slippageBps / 100}% (min ${formatUsdc(min)}).`);
};

const checkLimits: MarketCheck = (facts, policy, now) => {
  const { quantity } = facts.request;
  if (!INTEGER.test(quantity)) return deny(CHECK.limits, `Quantity "${quantity}" is not a whole number of contracts.`);
  if (Number(quantity) > policy.maxContractsPerOrder) return deny(CHECK.limits, `${quantity} contracts is over the ${policy.maxContractsPerOrder}-contract cap per order.`);
  const cost = orderCost(facts.request, policy);
  if (cost > policy.maxOrderNotional) return deny(CHECK.limits, `This order could cost ${usd(cost)} with fees, over the ${usd(policy.maxOrderNotional)} cap per order.`);
  const today = facts.orders.filter((o) => o.status !== 'failed' && o.at > now - DAY_MS).reduce((sum, o) => sum + o.cost, 0n);
  return today + cost <= policy.dailyNotionalCap
    ? null
    : deny(CHECK.limits, `Daily cap of ${usd(policy.dailyNotionalCap)} would be exceeded (${usd(today)} committed in the last 24h).`);
};

const checkBudget: MarketCheck = (facts, policy) => {
  const task = taskOf(facts, policy);
  const spent = facts.orders.filter((o) => o.status !== 'failed' && o.session === facts.task!.session).reduce((sum, o) => sum + o.cost, 0n);
  const cost = orderCost(facts.request, policy);
  return spent + cost <= task.budget
    ? null
    : deny(CHECK.budget, `Task "${facts.task!.name}" has committed ${usd(spent)} of its ${usd(task.budget)} budget; ${usd(cost)} more would exceed it.`);
};

const checkRate: MarketCheck = (facts, policy, now) => {
  const recent = facts.orders.filter((o) => o.status !== 'failed' && o.symbol === facts.request.symbol && o.at > now - policy.rateLimit.windowMs).length;
  return recent < policy.rateLimit.max
    ? null
    : deny(CHECK.rateLimit, `Already ordered ${facts.request.symbol} ${recent} times in the last ${Math.round(policy.rateLimit.windowMs / 1000)}s (limit ${policy.rateLimit.max}).`);
};

const checkDuplicate: MarketCheck = (facts, policy, now) => {
  const { symbol, side, outcome } = facts.request;
  if (facts.openSymbols.includes(symbol)) return deny(CHECK.duplicate, `An order on ${symbol} is still open; it is not ordered again.`);
  const same = facts.orders.some((o) => o.status !== 'failed' && o.symbol === symbol && o.side === side && o.outcome === outcome && o.at > now - policy.duplicateWindowMs);
  return same ? deny(CHECK.duplicate, `The same order (${side} ${outcome.toUpperCase()} ${symbol}) was placed in the last ${Math.round(policy.duplicateWindowMs / 1000)}s.`) : null;
};

/** The market checks in the order they run, with the name each denies under. For the dashboard. */
export const MARKET_CHECKS: readonly { name: string; check: MarketCheck }[] = [
  { name: CHECK.market, check: checkResolve },
  { name: CHECK.marketState, check: checkState },
  { name: CHECK.market, check: checkMandate },
  { name: CHECK.side, check: checkSide },
  { name: CHECK.outcome, check: checkOutcome },
  { name: CHECK.price, check: checkPrice },
  { name: CHECK.slippage, check: checkSlippage },
  { name: CHECK.limits, check: checkLimits },
  { name: CHECK.budget, check: checkBudget },
  { name: CHECK.rateLimit, check: checkRate },
  { name: CHECK.duplicate, check: checkDuplicate },
];

/**
 * Checks for one prediction market order, in order; the first failure denies. Pure: no I/O,
 * no clock. Symbols, prices and odds the agent quotes are only compared, never trusted: the
 * event, the contract and the book are the guard's own reads from Gemini.
 */
export function evaluateMarket(facts: MarketFacts, policy: MarketPolicy, now: number): Decision {
  const contract = facts.event?.contracts.find((c) => c.instrumentSymbol === facts.request.symbol);
  for (const { check } of MARKET_CHECKS) {
    const denial = check(facts, policy, now, contract);
    if (denial) return denial;
  }
  return allow('All market checks passed.');
}
