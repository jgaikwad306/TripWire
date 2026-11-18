import { USDC_ADDRESS, formatUsdc } from '../constants.js';
import { CHECK, type CheckName } from '../guard/checks.js';
import { FAKE_PRICES, LIVE_PRICES, apiPolicy, runPolicy } from '../redteam/world.js';
import type { Address } from '../types.js';
import { ARC_NETWORK } from '../x402/protocol.js';

/**
 * The paid-API checks in the order evaluateApi runs them (API_CHECKS in src/guard/api.ts),
 * and the one place each check function is mapped to the CHECK name its denials carry.
 * A test keeps this in step with API_CHECKS.
 */
export const API_RULES = [
  { fn: 'checkResource', key: 'resource', name: 'Resource', line: 'Only APIs the owner approved are paid.' },
  { fn: 'checkTask', key: 'intentMatch', name: 'Task', line: 'The endpoint must belong to the task the owner declared.' },
  { fn: 'checkNetwork', key: 'network', name: 'Network', line: 'The 402 must ask for payment on Arc Testnet.' },
  { fn: 'checkAsset', key: 'token', name: 'Asset', line: 'Only real USDC, paid directly or through Circle Gateway.' },
  { fn: 'checkPayee', key: 'allowlist', name: 'Payee', line: 'The 402’s payTo must be on the allowlist.' },
  { fn: 'checkPrice', key: 'price', name: 'Price', line: 'The 402 must match the reference price for that endpoint.' },
  { fn: 'checkLimits', key: 'limits', name: 'Limits', line: 'Within the per-payment and daily caps, and the balance must cover it.' },
  { fn: 'checkBudget', key: 'budget', name: 'Budget', line: 'A declared task cannot spend past its budget.' },
  { fn: 'checkRate', key: 'rateLimit', name: 'Rate', line: 'Payments to any one endpoint are rate-limited.' },
  { fn: 'checkDuplicate', key: 'duplicate', name: 'Duplicate', line: 'A request is paid once, and an API that kept the money without delivering is not paid again.' },
] as const satisfies readonly { fn: string; key: keyof typeof CHECK; name: string; line: string }[];

export type GuardNetwork = 'fake' | 'arc-testnet';
export interface GuardRule { check: CheckName; name: string; line: string; value: string }
export interface GuardSummary { network: GuardNetwork; rules: GuardRule[] }

/** Only the policy shape matters here; the summary never shows an address. */
const OWNER: { addressOf: () => Address } = { addressOf: () => '0x0000000000000000000000000000000000000000' };
const MS_PER_MINUTE = 60_000;
const BPS_PER_PERCENT = 100;

const endpointName = (path: string): string => path.split('/').pop() ?? path;
const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;
const per = (windowMs: number): string => (windowMs === MS_PER_MINUTE ? 'minute' : `${windowMs / 1000}s`);

/**
 * The rules with the values a run on this network enforces: built from the same runPolicy and
 * apiPolicy the red-team world uses, so they cannot differ from what the guard checks.
 * Summaries only: no address, wallet ID or key is ever included.
 */
export function guardRules(network: GuardNetwork): GuardSummary {
  const policy = runPolicy(OWNER, network === 'fake' ? FAKE_PRICES : LIVE_PRICES);
  const api = apiPolicy('http://data-api.local');
  const values: Partial<Record<CheckName, string>> = {
    [CHECK.resource]: `${api.resources.length} approved: this run’s data API`,
    [CHECK.intentMatch]: Object.entries(api.tasks).map(([name, task]) => `${name}: ${task.resources.map(endpointName).join(', ')}`).join(' · '),
    [CHECK.network]: `Arc Testnet (${ARC_NETWORK})`,
    [CHECK.token]: `USDC ${shortAddress(USDC_ADDRESS)}`,
    [CHECK.allowlist]: policy.allowlist.length === 1 ? 'Merchant wallet only' : `${policy.allowlist.length} approved wallets`,
    [CHECK.price]: `${Object.entries(api.prices).map(([path, price]) => `${endpointName(path)} ${formatUsdc(price)}`).join(' · ')} USDC, up to ${policy.priceToleranceBps / BPS_PER_PERCENT}% over`,
    [CHECK.limits]: `${formatUsdc(policy.perTxCap)} USDC per payment · ${formatUsdc(policy.dailyCap)} USDC per day`,
    [CHECK.budget]: `${Object.entries(api.tasks).map(([name, task]) => `${name} ${formatUsdc(task.budget)}`).join(' · ')} USDC`,
    [CHECK.rateLimit]: `${api.rateLimit.max} per endpoint per ${per(api.rateLimit.windowMs)}`,
    [CHECK.duplicate]: `Once per request within ${api.duplicateWindowMs / MS_PER_MINUTE} min`,
  };
  return { network, rules: API_RULES.map(({ key, name, line }) => ({ check: CHECK[key], name, line, value: values[CHECK[key]] ?? '' })) };
}
