import type { Address, Decision, TxHash } from '../types.js';

/** Every value `Decision.check` can take when it comes from the real guard. */
export const CHECK = {
  ok: 'ok',
  // send side
  intentMatch: 'intent-match',
  allowlist: 'allowlist',
  price: 'price',
  limits: 'limits',
  loop: 'loop',
  wallet: 'wallet',
  approval: 'approval',
  reconcile: 'reconcile',
  // receive side
  recipient: 'recipient',
  chain: 'chain',
  txExists: 'tx-exists',
  txStatus: 'tx-status',
  token: 'token',
  amount: 'amount',
  replay: 'replay',
} as const;

export type CheckName = (typeof CHECK)[keyof typeof CHECK];

export const allow = (reason: string, txHash?: TxHash): Decision => ({
  allowed: true,
  check: CHECK.ok,
  reason,
  ...(txHash ? { txHash } : {}),
});

export const deny = (check: CheckName, reason: string): Decision => ({ allowed: false, check, reason });

export const sameAddress = (a: Address, b: Address): boolean => a.toLowerCase() === b.toLowerCase();

export const includesAddress = (list: readonly Address[], address: Address): boolean =>
  list.some((entry) => sameAddress(entry, address));

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
