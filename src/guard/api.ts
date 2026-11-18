import { createHash } from 'node:crypto';
import { USDC_ADDRESS, formatUsdc } from '../constants.js';
import type { Address, Decision, Usdc } from '../types.js';
import { GATEWAY_WALLET } from '../x402/gateway.js';
import { ARC_NETWORK, isGatewayOption, type PaymentRequirements } from '../x402/protocol.js';
import { CHECK, allow, deny, includesAddress } from './checks.js';
import type { Policy } from './policy.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BPS = 10_000n;

/** The owner's rules for paid API calls (x402 nanopayments). Part of the policy file. */
export interface ApiPolicy {
  /** Approved resources: origins ("https://api.example.com") or URL prefixes. Nothing else is paid. */
  readonly resources: readonly string[];
  /** Reference price per endpoint path, e.g. "/premium/market-data" -> 0.001 USDC. */
  readonly prices: Readonly<Record<string, Usdc>>;
  /** At most `max` payments to one endpoint within `windowMs`. */
  readonly rateLimit: { readonly max: number; readonly windowMs: number };
  /** The same request (method, URL, body) is paid at most once within this window. */
  readonly duplicateWindowMs: number;
  /** Declared tasks: which endpoints each may buy, and its spending budget. */
  readonly tasks: Readonly<Record<string, ApiTask>>;
}

export interface ApiTask {
  readonly description: string;
  /** Endpoint paths this task may pay for. */
  readonly resources: readonly string[];
  /** Most this task may spend in total. */
  readonly budget: Usdc;
}

/** One paid API call on record, for rate limits, duplicates and budgets. */
export interface ApiSpend {
  /** origin + path, e.g. "http://127.0.0.1:4030/premium/market-data". */
  readonly endpoint: string;
  /** Identifies the exact request: method, full URL and body. */
  readonly requestKey: string;
  readonly amount: Usdc;
  readonly at: number;
  /** The task session it was paid under, if any. */
  readonly session?: string;
  /** Did the provider deliver after being paid? False is a provider that kept the money. */
  readonly served: boolean;
}

export interface ApiFacts {
  /** The URL that asked for payment (after any redirects the guard allowed). */
  readonly url: URL;
  readonly requirements: PaymentRequirements;
  readonly requestKey: string;
  /** Declared task and its session, when the owner started one. */
  readonly task?: { readonly name: string; readonly session: string };
  /** Every payment counting against the daily cap (API and otherwise). */
  readonly dailySpends: readonly { amount: Usdc; at: number }[];
  readonly apiSpends: readonly ApiSpend[];
  /** What the payment would be drawn from: the Gateway balance, or the hot wallet. */
  readonly balance: Usdc;
}

/** The exact request a payment is for. Same method, URL and body: same key. */
export function requestKey(method: string, url: URL, body: unknown): string {
  const bodyHash = body === undefined ? '' : createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return `${method.toUpperCase()} ${url.origin}${url.pathname}${url.search} ${bodyHash}`;
}

export const endpointOf = (url: URL): string => `${url.origin}${url.pathname}`;

/** Is this URL one the owner approved? Prefix match on origin and path, never on a substring of the host. */
export function isApprovedResource(policy: ApiPolicy | undefined, url: URL): boolean {
  if (!policy) return false;
  const target = endpointOf(url);
  return policy.resources.some((entry) => {
    let approved: URL;
    try {
      approved = new URL(entry);
    } catch {
      return false;
    }
    if (approved.origin !== url.origin) return false;
    const prefix = endpointOf(approved).replace(/\/$/, '');
    return target === prefix || target.startsWith(`${prefix}/`) || approved.pathname === '/';
  });
}

type ApiCheck = (facts: ApiFacts, policy: Policy, api: ApiPolicy, now: number) => Decision | null;

const checkResource: ApiCheck = ({ url }, _policy, api) =>
  isApprovedResource(api, url) ? null : deny(CHECK.resource, `${endpointOf(url)} is not an approved resource.`);

const checkTask: ApiCheck = ({ url, task }, _policy, api) => {
  if (!task) return null;
  const declared = api.tasks[task.name];
  if (!declared) return deny(CHECK.intentMatch, `The declared task "${task.name}" is not in the policy.`);
  return declared.resources.includes(url.pathname)
    ? null
    : deny(CHECK.intentMatch, `${url.pathname} is not part of the declared task "${task.name}" (${declared.description}).`);
};

const checkNetwork: ApiCheck = ({ requirements }) =>
  requirements.network === ARC_NETWORK ? null : deny(CHECK.network, `Payment asked on ${requirements.network}; only Arc Testnet (${ARC_NETWORK}) is allowed.`);

const checkAsset: ApiCheck = ({ requirements }) => {
  if (requirements.scheme !== 'exact') return deny(CHECK.token, `Unsupported payment scheme "${requirements.scheme}".`);
  if (requirements.asset.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
    return deny(CHECK.token, `Payment asked in ${requirements.asset}, not USDC (${USDC_ADDRESS}).`);
  }
  if (isGatewayOption(requirements)) {
    const contract = String(requirements.extra?.verifyingContract ?? '').toLowerCase();
    if (contract !== GATEWAY_WALLET || requirements.extra?.version !== '1') {
      return deny(CHECK.token, `Gateway payment names verifying contract ${contract || '(none)'}, not Circle's Gateway Wallet.`);
    }
  }
  return null;
};

const checkPayee: ApiCheck = ({ requirements }, policy) => {
  const payTo = requirements.payTo.toLowerCase() as Address;
  return includesAddress(policy.allowlist, payTo) ? null : deny(CHECK.allowlist, `Payee ${payTo} is not on the allowlist.`);
};

const amountOf = (requirements: PaymentRequirements): Usdc => (/^\d+$/.test(requirements.amount) ? BigInt(requirements.amount) : -1n);

const checkPrice: ApiCheck = ({ url, requirements }, policy, api) => {
  const amount = amountOf(requirements);
  if (amount <= 0n) return deny(CHECK.price, `Payment amount "${requirements.amount}" is not a positive amount.`);
  const reference = api.prices[url.pathname];
  if (reference === undefined) return deny(CHECK.price, `No reference price is set for ${url.pathname}, so it is not paid.`);
  const max = (reference * (BPS + BigInt(policy.priceToleranceBps))) / BPS;
  return amount <= max
    ? null
    : deny(CHECK.price, `Asked ${formatUsdc(amount)} USDC for ${url.pathname}; the reference price is ${formatUsdc(reference)} USDC.`);
};

const checkLimits: ApiCheck = ({ requirements, dailySpends, balance }, policy, _api, now) => {
  const amount = amountOf(requirements);
  if (amount > policy.perTxCap) {
    return deny(CHECK.limits, `${formatUsdc(amount)} USDC is over the per-payment cap of ${formatUsdc(policy.perTxCap)} USDC.`);
  }
  const today = dailySpends.filter((s) => s.at > now - DAY_MS).reduce((sum, s) => sum + s.amount, 0n);
  if (today + amount > policy.dailyCap) {
    return deny(CHECK.limits, `Daily cap of ${formatUsdc(policy.dailyCap)} USDC would be exceeded (${formatUsdc(today)} USDC spent in the last 24h).`);
  }
  if (balance < amount) return deny(CHECK.limits, `Only ${formatUsdc(balance)} USDC is available to pay ${formatUsdc(amount)} USDC.`);
  return null;
};

const checkBudget: ApiCheck = ({ requirements, task, apiSpends }, _policy, api) => {
  if (!task) return null;
  const declared = api.tasks[task.name];
  if (!declared) return null;
  const spent = apiSpends.filter((s) => s.session === task.session).reduce((sum, s) => sum + s.amount, 0n);
  const amount = amountOf(requirements);
  return spent + amount <= declared.budget
    ? null
    : deny(CHECK.budget, `Task "${task.name}" has spent ${formatUsdc(spent)} of its ${formatUsdc(declared.budget)} USDC budget; ${formatUsdc(amount)} more would exceed it.`);
};

const checkRate: ApiCheck = ({ url, apiSpends }, _policy, api, now) => {
  const endpoint = endpointOf(url);
  const recent = apiSpends.filter((s) => s.endpoint === endpoint && s.at > now - api.rateLimit.windowMs).length;
  return recent < api.rateLimit.max
    ? null
    : deny(CHECK.rateLimit, `Already paid ${endpoint} ${recent} times in the last ${Math.round(api.rateLimit.windowMs / 1000)}s (limit ${api.rateLimit.max}).`);
};

const checkDuplicate: ApiCheck = ({ url, requestKey: key, apiSpends }, _policy, api, now) => {
  const recent = apiSpends.filter((s) => s.at > now - api.duplicateWindowMs);
  if (recent.some((s) => s.requestKey === key)) {
    return deny(CHECK.duplicate, `This exact request was already paid for in the last ${Math.round(api.duplicateWindowMs / 1000)}s.`);
  }
  const endpoint = endpointOf(url);
  if (recent.some((s) => s.endpoint === endpoint && !s.served)) {
    return deny(CHECK.duplicate, `${endpoint} was paid recently and did not deliver, so it is not paid again.`);
  }
  return null;
};

/**
 * Checks for paying a 402 from an HTTP API, in order; the first failure denies. Pure: no
 * I/O, no clock. What the agent says about the request is never read, only the request
 * itself and the provider's payment terms.
 */
export function evaluateApi(facts: ApiFacts, policy: Policy, now: number): Decision {
  const api = policy.api;
  if (!api) return deny(CHECK.resource, 'The policy approves no paid API resources.');
  const checks: ApiCheck[] = [checkResource, checkTask, checkNetwork, checkAsset, checkPayee, checkPrice, checkLimits, checkBudget, checkRate, checkDuplicate];
  for (const check of checks) {
    const denial = check(facts, policy, api, now);
    if (denial) return denial;
  }
  return allow('All API payment checks passed.');
}
