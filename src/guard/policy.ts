import { z } from 'zod';
import { parseUsdc } from '../constants.js';
import type { Address, Usdc, WalletProvider } from '../types.js';

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
  })
  .strict();

const freezePolicy = (policy: Policy): Policy =>
  Object.freeze({
    ...policy,
    allowlist: Object.freeze([...policy.allowlist]),
    receiveAddresses: Object.freeze([...policy.receiveAddresses]),
    expectedPrices: Object.freeze({ ...policy.expectedPrices }),
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
