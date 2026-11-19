import { formatUsdc, parseUsdc } from '../constants.js';

/**
 * Prediction-market math in 6-decimal base units, the same scale as USDC amounts, so one
 * bigint type covers both rails. Gemini settles in USD; reports label market amounts
 * "USD at risk" and never add them to USDC totals.
 */
export const ONE = 1_000_000n;

/** "0.77" -> 770000n. Throws on anything that is not a plain decimal. */
export const units = (decimal: string): bigint => parseUsdc(decimal);
export const decimal = (value: bigint): string => formatUsdc(value);

/** price × quantity, both in base units. */
export const notional = (price: bigint, quantity: bigint): bigint => (price * quantity) / ONE;

/**
 * What an order costs, in the outcome's own price space (a NO order's price is the NO
 * price, which is 1 − the YES price it trades against). The one place cost is computed.
 */
export function costOf(order: { quantity: string; price: string }): bigint {
  return notional(units(order.price), units(order.quantity));
}

/** NO price for a YES price, and back. */
export const flip = (price: bigint): bigint => ONE - price;

/** Adds basis points: used for the guard's fee buffer and slippage band. */
export const plusBps = (value: bigint, bps: number): bigint => (value * (10_000n + BigInt(bps))) / 10_000n;
export const minusBps = (value: bigint, bps: number): bigint => (value * (10_000n - BigInt(bps))) / 10_000n;
