import { formatUsdc } from '../constants.js';
import type { Decision, PaymentIntent, PaymentRequest, Usdc } from '../types.js';
import { CHECK, allow, deny, includesAddress, sameAddress } from './checks.js';
import type { Spend } from './intents.js';
import type { Policy } from './policy.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BPS_DENOMINATOR = 10_000n;

export interface SendState {
  /** The guard-recorded intent the request points at, if any. */
  readonly intent: PaymentIntent | undefined;
  readonly spends: readonly Spend[];
  readonly hotBalance: Usdc;
}

type Check = (intent: PaymentIntent, state: SendState, policy: Policy, now: number) => Decision | null;

/**
 * Send-side checks, in order; the first failure denies. Pure: no I/O, no clock.
 * `req.reason` is never read, so nothing written there can influence the outcome.
 */
export function evaluateSend(req: PaymentRequest, state: SendState, policy: Policy, now: number): Decision {
  const mismatch = checkIntentMatch(req, state.intent);
  if (mismatch || !state.intent) return mismatch ?? deny(CHECK.intentMatch, 'No matching intent.');

  for (const check of [checkAllowlist, checkPrice, checkLimits, checkLoop] satisfies Check[]) {
    const denial = check(state.intent, state, policy, now);
    if (denial) return denial;
  }
  return allow('All send checks passed.');
}

export function checkIntentMatch(req: PaymentRequest, intent: PaymentIntent | undefined): Decision | null {
  if (!intent) {
    return deny(CHECK.intentMatch, 'No quote was recorded for this intent id. Get a quote first.');
  }
  if (typeof req.payTo !== 'string' || !sameAddress(req.payTo, intent.payTo)) {
    return deny(CHECK.intentMatch, `Requested payTo does not match the recorded quote (${intent.payTo}).`);
  }
  if (typeof req.amount !== 'bigint' || req.amount !== intent.amount) {
    return deny(CHECK.intentMatch, `Requested amount does not match the recorded quote (${formatUsdc(intent.amount)} USDC).`);
  }
  return null;
}

const checkAllowlist: Check = (intent, _state, policy) =>
  includesAddress(policy.allowlist, intent.payTo)
    ? null
    : deny(CHECK.allowlist, `Payee ${intent.payTo} is not on the allowlist.`);

const checkPrice: Check = (intent, _state, policy) => {
  const expected = referencePrice(policy, intent.item);
  if (expected === undefined) return null;
  const maxAllowed = (expected * (BPS_DENOMINATOR + BigInt(policy.priceToleranceBps))) / BPS_DENOMINATOR;
  if (intent.amount <= maxAllowed) return null;
  return deny(
    CHECK.price,
    `Quoted ${formatUsdc(intent.amount)} USDC for "${intent.item}" but the reference price is ${formatUsdc(expected)} USDC.`,
  );
};

export const normalizeItem = (item: string): string => item.trim().toLowerCase();

/** Matches item names ignoring case and surrounding spaces, so "Report " still gets a price check. */
function referencePrice(policy: Policy, item: string): Usdc | undefined {
  const wanted = normalizeItem(item);
  return Object.entries(policy.expectedPrices).find(([name]) => normalizeItem(name) === wanted)?.[1];
}

const checkLimits: Check =(intent, state, policy, now) => {
  if (intent.amount > policy.perTxCap) {
    return deny(CHECK.limits, `${formatUsdc(intent.amount)} USDC is over the per-payment cap of ${formatUsdc(policy.perTxCap)} USDC.`);
  }
  const spentToday = state.spends.filter((s) => s.at > now - DAY_MS).reduce((sum, s) => sum + s.amount, 0n);
  if (spentToday + intent.amount > policy.dailyCap) {
    return deny(
      CHECK.limits,
      `Daily cap of ${formatUsdc(policy.dailyCap)} USDC would be exceeded (${formatUsdc(spentToday)} USDC spent in the last 24h).`,
    );
  }
  if (state.hotBalance < intent.amount) {
    return deny(CHECK.limits, `Hot wallet holds ${formatUsdc(state.hotBalance)} USDC, not enough for ${formatUsdc(intent.amount)} USDC.`);
  }
  return null;
};

const checkLoop: Check = (intent, state, policy, now) => {
  if (intent.status === 'paid') {
    return deny(CHECK.loop, 'This intent was already paid. A request to pay it again is not honoured.');
  }
  const repeats = state.spends.filter(
    (s) => s.at > now - policy.loopWindowMs && s.amount === intent.amount && sameAddress(s.payTo, intent.payTo),
  ).length;
  if (repeats >= policy.loopMaxRepeats) {
    return deny(CHECK.loop, `Already paid this payee the same amount ${repeats} times recently. Possible payment loop.`);
  }
  return null;
};
