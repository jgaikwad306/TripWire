import { z } from 'zod';
import { parseUsdc } from '../constants.js';
import type { Address, Usdc, WalletProvider } from '../types.js';
import type { ApiPolicy } from './api.js';

/**
 * The owner's rules. Loaded from a local file (see loadPolicy in src/config.ts) or built
 * with defaultPolicy. Frozen: nothing the agent, the LLM or a merchant says can change it.
 */
export interface Policy {
  /** Payees the hot wallet may pay. */
  readonly allowlist: readonly Address[];
  /** Addresses we accept incoming payments on (receive side). */
  readonly receiveAddresses: readonly Address[];
  readonly perTxCap: Usdc;
  /** Rolling 24 hours. */
  readonly dailyCap: Usdc;
  /** rebalance() sweeps anything above this into the vault. */
  readonly hotBalanceCap: Usdc;
  /** How far above a reference price a quote may be, in basis points (500 = 5%). */
  readonly priceToleranceBps: number;
  /** Item name -> the owner's reference price. Items without one skip the price check. */
  readonly expectedPrices: Readonly<Record<string, Usdc>>;
  readonly loopWindowMs: number;
  /** How many times the same payee+amount may be paid inside the loop window. */
  readonly loopMaxRepeats: number;
  readonly minConfirmations: number;
  /** Payments above this need the owner's approval first. Absent means no payment does. */
  readonly approvalThreshold?: Usdc | undefined;
  /** How long an approval request stays open, and how long an approval stays usable. */
  readonly approvalTtlMs: number;
  /** Paid API calls (x402 nanopayments). Absent means no API is ever paid. */
  readonly api?: ApiPolicy | undefined;
  /** Prediction market orders on Gemini. Absent means the market guard places none. */
  readonly markets?: MarketPolicy | undefined;
}

/** The owner's rules for prediction market orders. Amounts and prices in 6-decimal base units. */
export interface MarketPolicy {
  readonly venue: 'simulated' | 'sandbox' | 'production';
  readonly maxOrderNotional: Usdc;
  readonly maxContractsPerOrder: number;
  /** Rolling 24 hours, all market orders. */
  readonly dailyNotionalCap: Usdc;
  /** Limit prices outside [minPrice, maxPrice] are refused: near-certain contracts pay too little for the risk. */
  readonly minPrice: Usdc;
  readonly maxPrice: Usdc;
  /** How far a limit may be from the guard's own read of the book, in basis points. */
  readonly slippageBps: number;
  /** Added to every order's cost for fees before the caps are applied. */
  readonly feeBufferBps: number;
  /** Contracts closer to expiry than this are not traded. */
  readonly minTimeToExpiryMs: number;
  /** At most `max` orders on one contract within `windowMs`. */
  readonly rateLimit: { readonly max: number; readonly windowMs: number };
  /** The same contract, side and outcome is ordered at most once within this window. */
  readonly duplicateWindowMs: number;
  readonly fillTimeoutMs: number;
  readonly tasks: Readonly<Record<string, MarketTask>>;
}

export interface MarketTask {
  readonly description: string;
  /** Event tickers this task may trade. */
  readonly events: readonly string[];
  readonly outcomes: readonly ('yes' | 'no')[];
  readonly sides: readonly ('buy' | 'sell')[];
  /** Most this task may commit in total (USD). */
  readonly budget: Usdc;
}

const DEFAULT_PRICE_TOLERANCE_BPS = 500;
const DEFAULT_LOOP_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_LOOP_MAX_REPEATS = 2;
const DEFAULT_MIN_CONFIRMATIONS = 1;
const DEFAULT_APPROVAL_TTL_MS = 2 * 60 * 1000;
const MAX_BPS = 10_000;

export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte address')
  .transform((value) => value as Address);

/** A decimal string such as "1.50", parsed into positive 6-decimal base units. */
const usdcAmountSchema = z.string().transform((value, ctx): Usdc => {
  let units: Usdc;
  try {
    units = parseUsdc(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${value}" is not a USDC amount like "1.50"` });
    return z.NEVER;
  }
  if (units <= 0n) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be greater than zero' });
    return z.NEVER;
  }
  return units;
});

const policyFileSchema = z
  .object({
    allowlist: z.array(addressSchema).min(1),
    receiveAddresses: z.array(addressSchema).default([]),
    perTxCap: usdcAmountSchema,
    dailyCap: usdcAmountSchema,
    hotBalanceCap: usdcAmountSchema,
    priceToleranceBps: z.number().int().min(0).max(MAX_BPS).default(DEFAULT_PRICE_TOLERANCE_BPS),
    expectedPrices: z.record(z.string(), usdcAmountSchema).default({}),
    loopWindowMs: z.number().int().positive().default(DEFAULT_LOOP_WINDOW_MS),
    loopMaxRepeats: z.number().int().positive().default(DEFAULT_LOOP_MAX_REPEATS),
    minConfirmations: z.number().int().positive().default(DEFAULT_MIN_CONFIRMATIONS),
    approvalThreshold: usdcAmountSchema.optional(),
    approvalTtlMs: z.number().int().positive().default(DEFAULT_APPROVAL_TTL_MS),
    api: z
      .object({
        resources: z.array(z.string().url()).min(1),
        prices: z.record(z.string().startsWith('/'), usdcAmountSchema),
        rateLimit: z.object({ max: z.number().int().positive(), windowMs: z.number().int().positive() }).strict(),
        duplicateWindowMs: z.number().int().positive(),
        tasks: z
          .record(
            z.string(),
            z.object({ description: z.string(), resources: z.array(z.string().startsWith('/')).min(1), budget: usdcAmountSchema }).strict(),
          )
          .default({}),
      })
      .strict()
      .optional(),
    markets: z
      .object({
        venue: z.enum(['simulated', 'sandbox', 'production']).default('simulated'),
        maxOrderNotional: usdcAmountSchema,
        maxContractsPerOrder: z.number().int().positive(),
        dailyNotionalCap: usdcAmountSchema,
        minPrice: usdcAmountSchema,
        maxPrice: usdcAmountSchema,
        slippageBps: z.number().int().min(0).max(MAX_BPS),
        feeBufferBps: z.number().int().min(0).max(MAX_BPS).default(0),
        minTimeToExpiryMs: z.number().int().min(0),
        rateLimit: z.object({ max: z.number().int().positive(), windowMs: z.number().int().positive() }).strict(),
        duplicateWindowMs: z.number().int().positive(),
        fillTimeoutMs: z.number().int().positive().default(10_000),
        tasks: z
          .record(
            z.string(),
            z
              .object({
                description: z.string(),
                events: z.array(z.string().min(1)).min(1),
                outcomes: z.array(z.enum(['yes', 'no'])).min(1),
                sides: z.array(z.enum(['buy', 'sell'])).min(1),
                budget: usdcAmountSchema,
              })
              .strict(),
          )
          .default({}),
      })
      .strict()
      .refine((m) => m.minPrice < m.maxPrice && m.maxPrice < 1_000_000n, 'minPrice must be below maxPrice, and maxPrice below 1')
      .optional(),
  })
  .strict();

const freezePolicy = (policy: Policy): Policy =>
  Object.freeze({
    ...policy,
    allowlist: Object.freeze([...policy.allowlist]),
    receiveAddresses: Object.freeze([...policy.receiveAddresses]),
    expectedPrices: Object.freeze({ ...policy.expectedPrices }),
    ...(policy.api
      ? {
          api: Object.freeze({
            ...policy.api,
            resources: Object.freeze([...policy.api.resources]),
            prices: Object.freeze({ ...policy.api.prices }),
            rateLimit: Object.freeze({ ...policy.api.rateLimit }),
            tasks: Object.freeze(Object.fromEntries(Object.entries(policy.api.tasks).map(([k, t]) => [k, Object.freeze({ ...t, resources: Object.freeze([...t.resources]) })]))),
          }),
        }
      : {}),
    ...(policy.markets ? { markets: freezeMarkets(policy.markets) } : {}),
  });

export const freezeMarkets = (m: MarketPolicy): MarketPolicy =>
  Object.freeze({
    ...m,
    rateLimit: Object.freeze({ ...m.rateLimit }),
    tasks: Object.freeze(
      Object.fromEntries(
        Object.entries(m.tasks).map(([k, t]) => [k, Object.freeze({ ...t, events: Object.freeze([...t.events]), outcomes: Object.freeze([...t.outcomes]), sides: Object.freeze([...t.sides]) })]),
      ),
    ),
  });

/** Validates the contents of a policy file. Amounts are decimal strings ("5", "0.50"). */
export function parsePolicy(raw: unknown): Policy {
  const result = policyFileSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid policy: ${issues}`);
  }
  return freezePolicy(result.data);
}

/** Sensible demo limits: only the merchant wallet is payable and accepted for receipts. */
export function defaultPolicy(wallet: Pick<WalletProvider, 'addressOf'>, overrides: Partial<Policy> = {}): Policy {
  const merchant = wallet.addressOf('merchant');
  return freezePolicy({
    allowlist: [merchant],
    receiveAddresses: [merchant],
    perTxCap: parseUsdc('5'),
    dailyCap: parseUsdc('20'),
    hotBalanceCap: parseUsdc('10'),
    priceToleranceBps: DEFAULT_PRICE_TOLERANCE_BPS,
    expectedPrices: {},
    loopWindowMs: DEFAULT_LOOP_WINDOW_MS,
    loopMaxRepeats: DEFAULT_LOOP_MAX_REPEATS,
    minConfirmations: DEFAULT_MIN_CONFIRMATIONS,
    approvalTtlMs: DEFAULT_APPROVAL_TTL_MS,
    ...overrides,
  });
}
